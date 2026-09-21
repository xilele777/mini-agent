import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { ConfigError, loadConfig } from './config.js'
import { createModelStream } from './llm.js'
import { createRuntime } from './runtime.js'
import { runTurn, type TurnEvent } from './turn.js'
import { runSubAgent } from './subagent.js'
import { createSession, openSession } from './session.js'
import { runSessionTurn } from './session-runner.js'
import { createToolRegistry } from './tools/registry.js'
import type { Tool } from './tools/types.js'
import type { HistoryMessage } from './context.js'
import { testConfig } from './test-runtime.js'

const quiet = {
  write: () => {},
  log: () => {},
}

const budget = {
  contextWindow: 2500,
  outputReserve: 128,
  safetyMargin: 72,
}

const task = (): HistoryMessage[] => [{
  role: 'user',
  content: '执行任务',
  startsTurn: true,
}]

const work: Tool = {
  name: 'work',
  description: 'work',
  schema: z.object({}),
  execute: () => 'x'.repeat(6000),
}

const done: Tool = {
  name: 'done',
  description: 'done',
  schema: z.object({}),
  execute: () => '完成',
  endsTurn: 'completed',
}

async function* reply(
  name?: string
): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 'test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      finish_reason: name ? 'tool_calls' : 'stop',
      delta: name ? {
        tool_calls: [{
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      } : {
        content: '完成调查',
      },
    }],
  }
}

test('上下文配置支持覆盖并拒绝无效关系与参数名', () => {
  const env = {
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'https://example.test/v1',
    OPENAI_MODEL: 'test-model',
    MINI_AGENT_CONTEXT_WINDOW: '2500',
    MINI_AGENT_OUTPUT_RESERVE: '128',
    MINI_AGENT_CONTEXT_MARGIN: '72',
  }

  const config = loadConfig(env, 'linux')

  assert.deepEqual(config.contextBudget, budget)
  assert.equal(config.outputTokenParam, 'max_completion_tokens')

  for (const override of [
    { MINI_AGENT_CONTEXT_WINDOW: '200' },
    { MINI_AGENT_CONTEXT_MARGIN: '-1' },
    { MINI_AGENT_OUTPUT_RESERVE: '0' },
    { MINI_AGENT_OUTPUT_TOKEN_PARAM: 'unknown' },
  ]) {
    assert.throws(
      () => loadConfig({ ...env, ...override }, 'linux'),
      ConfigError
    )
  }
})

test('主轮首次超限零请求，并保存 budget_exhausted', async () => {
  let requests = 0
  const events: TurnEvent[] = []
  const messages: HistoryMessage[] = [{
    role: 'user',
    content: 'x'.repeat(5000),
    startsTurn: true,
  }]

  const result = await runTurn(messages, {
    ...quiet,
    contextBudget: budget,
    maxIterations: 3,
    registry: createToolRegistry([]),
    createStream: async () => {
      requests++
      return reply()
    },
    checkpoint: async (event) => {
      events.push(event)
    },
  })

  assert.equal(requests, 0)
  assert.equal(result.status, 'budget_exhausted')
  assert.deepEqual(events.at(-1), { type: 'turn_end', result })
  assert.equal(messages.length, 1)
})

test('工具结果使下一次请求超限，保留已返回动作和完整原文', async () => {
  let requests = 0
  const messages = task()
  const events: TurnEvent[] = []

  const result = await runTurn(messages, {
    ...quiet,
    contextBudget: budget,
    maxIterations: 3,
    registry: createToolRegistry([work]),
    createStream: async (request) => {
      requests++
      assert.equal(request.maxOutputTokens, 128)
      return reply('work')
    },
    checkpoint: async (event) => {
      events.push(event)
    },
  })

  assert.equal(requests, 1)
  assert.equal(result.status, 'budget_exhausted')
  assert.equal(messages.at(-1)?.content, 'x'.repeat(6000))
  assert.deepEqual(
    events.filter((e) => e.type === 'action').map((e) => e.state),
    ['started', 'returned']
  )
})

test('预算裁掉旧轮，重开会话仍保留完整原始历史', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-context-'))

  try {
    const session = await createSession(root)
    const id = session.snapshot.id

    const options = {
      ...quiet,
      maxIterations: 2,
      registry: createToolRegistry([done]),
      contextBudget: testConfig.contextBudget,
      createStream: async () => reply('done'),
    }

    try {
      await runSessionTurn(session, 'x'.repeat(5000), options)

      const result = await runSessionTurn(session, '新任务', {
        ...options,
        contextBudget: budget,
        createStream: async (request) => {
          const sent = JSON.stringify(request.messages)
          assert.ok(!sent.includes('x'.repeat(5000)))
          assert.ok(sent.includes('新任务'))
          return reply('done')
        },
      })

      assert.equal(result.status, 'completed')
    } finally {
      await session.close()
    }

    const reopened = await openSession(root, id)

    try {
      assert.ok(
        reopened.snapshot.messages.some(
          (m) => m.content === 'x'.repeat(5000)
        )
      )
      assert.equal(reopened.snapshot.turns.length, 2)
    } finally {
      await reopened.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('子 Agent 首次超限零请求，返回明确的未完成结果', async () => {
  let requests = 0

  const result = await runSubAgent('x'.repeat(5000), {
    contextBudget: budget,
    maxIterations: 2,
    registry: createToolRegistry([]),
    createStream: async () => {
      requests++
      return reply()
    },
  })

  assert.equal(requests, 0)
  assert.match(result, /子 Agent 上下文预算耗尽/)
})

test('子 Agent 最终总结仍检查预算，超限不额外请求', async () => {
  let requests = 0

  const result = await runSubAgent('调查', {
    contextBudget: budget,
    maxIterations: 2,
    registry: createToolRegistry([work]),
    createStream: async (request) => {
      requests++
      assert.equal(request.maxOutputTokens, 128)
      assert.ok(
        request.messages.every((m) => !('startsTurn' in m))
      )
      return reply('work')
    },
  })

  assert.equal(requests, 1)
  assert.match(result, /子 Agent 上下文预算耗尽/)
})

test('runtime 把同一配置交给主轮与委派，最终总结携带输出上限', async () => {
  const contextBudget = { ...budget, outputReserve: 77 }

  const runtime = createRuntime({
    ...testConfig,
    contextBudget,
    subagentMaxIterations: 1,
  }, async (request) => {
    assert.equal(request.maxOutputTokens, 77)
    assert.deepEqual(request.tools, [])
    return reply()
  })

  assert.deepEqual(runtime.turnOptions.contextBudget, contextBudget)

  const prepared = runtime.turnOptions.registry.prepareCall(
    'delegate_task',
    '{"task":"调查"}'
  )

  assert.ok(prepared.ok)
  assert.equal(
    await prepared.tool.execute(prepared.args),
    '完成调查'
  )
})

test('真实 SDK 请求只发送选定的输出上限字段', async () => {
  for (
    const outputTokenParam of
    ['max_completion_tokens', 'max_tokens'] as const
  ) {
    const createStream = createModelStream(
      { ...testConfig, outputTokenParam },
      async (_input, init) => {
        const body = JSON.parse(String(init?.body))

        assert.equal(body[outputTokenParam], 77)

        const other = outputTokenParam === 'max_tokens'
          ? 'max_completion_tokens'
          : 'max_tokens'

        assert.equal(body[other], undefined)

        return new Response('data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
    )

    const stream = await createStream({
      messages: [],
      tools: [],
      maxOutputTokens: 77,
    })

    for await (const _ of stream) {
      // 完整消费，触发请求与清理。
    }
  }
})

test('服务端上下文超限归为预算耗尽，主轮不重试', async () => {
  let requests = 0

  const createStream = createModelStream(testConfig, async () => {
    requests++

    return new Response(JSON.stringify({
      error: {
        message: 'private provider detail',
        type: 'invalid_request_error',
        code: 'context_length_exceeded',
      },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  })

  const result = await runTurn(task(), {
    ...quiet,
    contextBudget: budget,
    maxIterations: 3,
    registry: createToolRegistry([]),
    createStream,
  })

  assert.equal(requests, 1)
  assert.equal(result.status, 'budget_exhausted')
  assert.ok(!result.reason.includes('private provider detail'))
})
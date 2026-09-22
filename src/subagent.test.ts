import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { runSubAgent } from './subagent.js'
import type { SubAgentRequest } from './subagent.js'
import { testRuntime } from './test-runtime.js'

function chunk(choices: ChatCompletionChunk['choices']): ChatCompletionChunk {
  return {
    id: 'subagent-test',
    choices,
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
    usage: null,
  }
}

async function* chunks(...items: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
  yield* items
}

function textStream(text: string): AsyncIterable<ChatCompletionChunk> {
  return chunks(
    chunk([
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: text,
        },
        finish_reason: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {},
        finish_reason: 'stop',
      },
    ])
  )
}

function toolStream(name: string, args: string, id = 'call-0'): AsyncIterable<ChatCompletionChunk> {
  return chunks(
    chunk([
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name,
                arguments: args,
              },
            },
          ],
        },
        finish_reason: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
      },
    ])
  )
}

function lastToolText(messages: ChatCompletionMessageParam[]): string {
  const message = [...messages].reverse().find((item) => item.role === 'tool')

  if (!message || message.role !== 'tool' || typeof message.content !== 'string') {
    assert.fail('没有找到字符串形式的工具结果')
  }

  return message.content
}

test('初始请求只有独立 system 和 task，并只暴露只读工具', async () => {
  let captured: SubAgentRequest | undefined

  const result = await runSubAgent('检查项目入口', {
    ...testRuntime.subagentOptions,
    createStream: async (request) => {
      captured = request
      return textStream('入口是 src/agent.ts')
    },
  })

  assert.equal(result, '入口是 src/agent.ts')
  assert.ok(captured)

  assert.deepEqual(
    captured.messages.map((message) => message.role),
    ['system', 'user']
  )

  assert.equal(captured.messages[1]?.content, '检查项目入口')

  const toolNames = captured.tools.map((tool) => tool.function.name).sort()

  assert.deepEqual(toolNames, ['calculate', 'current_time', 'read_file', 'search_files'])
})

test('只读工具结果回填后继续请求并返回最终文本', async () => {
  let requestCount = 0

  const result = await runSubAgent('计算 6 * 7', {
    ...testRuntime.subagentOptions,
    createStream: async (request) => {
      requestCount++

      if (requestCount === 1) {
        return toolStream('calculate', '{"expression":"6 * 7"}')
      }

      assert.equal(lastToolText(request.messages), '42')

      return textStream('计算结果是 42')
    },
  })

  assert.equal(requestCount, 2)
  assert.equal(result, '计算结果是 42')
})

test('未加入只读集合的现存工具不能通过准备阶段', async () => {
  let requestCount = 0

  const result = await runSubAgent('尝试写文件', {
    ...testRuntime.subagentOptions,
    createStream: async (request) => {
      requestCount++

      if (requestCount === 1) {
        return toolStream('write_file', '{"path":"x.txt","content":"x"}')
      }

      assert.match(lastToolText(request.messages), /不存在名为 "write_file" 的工具/)

      return textStream('我没有写文件能力')
    },
  })

  assert.equal(result, '我没有写文件能力')
})

test('连续重复调用会被守卫拦截并允许模型收敛', async () => {
  let requestCount = 0

  const result = await runSubAgent('反复计算', {
    ...testRuntime.subagentOptions,
    maxIterations: 4,

    createStream: async (request) => {
      requestCount++

      if (requestCount === 4) {
        assert.match(lastToolText(request.messages), /循环守卫/)

        return textStream('停止重复，结果是 2')
      }

      return toolStream('calculate', '{"expression":"1 + 1"}', `call-${requestCount}`)
    },
  })

  assert.equal(requestCount, 4)
  assert.equal(result, '停止重复，结果是 2')
})

test('最后一次请求撤下工具并要求直接总结', async () => {
  let requestCount = 0

  const result = await runSubAgent('在有限预算内调查', {
    ...testRuntime.subagentOptions,
    maxIterations: 2,

    createStream: async (request) => {
      requestCount++

      if (requestCount === 1) {
        assert.equal(request.tools.length, 4)

        return toolStream('current_time', '{}')
      }

      assert.deepEqual(request.tools, [])

      const lastMessage = request.messages.at(-1)

      assert.equal(lastMessage?.role, 'user')

      assert.match(String(lastMessage?.content), /工具调用预算已经用完/)

      return textStream('根据已有结果返回当前结论')
    },
  })

  assert.equal(requestCount, 2)
  assert.equal(result, '根据已有结果返回当前结论')
})

test('流协议错误继续向委派调用方传播', async () => {
  async function* unfinished(): AsyncGenerator<ChatCompletionChunk> {
    yield chunk([
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: '未结束',
        },
        finish_reason: null,
      },
    ])
  }

  await assert.rejects(
    runSubAgent('测试不完整响应', {
      ...testRuntime.subagentOptions,
      createStream: async () => unfinished(),
    }),
    /缺少结束原因/
  )
})

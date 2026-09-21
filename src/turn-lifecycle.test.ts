import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { HistoryMessage } from './context.js'
import type { Tool } from './tools/types.js'
import { createToolRegistry } from './tools/registry.js'
import {
  CheckpointError,
  runTurn,
  type RunTurnOptions,
  type TurnEvent,
} from './turn.js'

function tool(
  name: string,
  execute: Tool['execute'] = () => 'ok'
): Tool {
  return {
    name,
    description: name,
    schema: z.object({}),
    execute,
  }
}

const done = {
  ...tool('done'),
  endsTurn: 'completed' as const,
}
const pause = {
  ...tool('pause'),
  endsTurn: 'paused' as const,
}

async function* response(
  ...names: string[]
): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 'test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      delta: names.length ? {
        role: 'assistant',
        tool_calls: names.map((name, index) => ({
          index,
          id: `c${index}`,
          type: 'function' as const,
          function: { name, arguments: '{}' },
        })),
      } : {
        role: 'assistant',
        content: '继续处理',
      },
      finish_reason: names.length ? 'tool_calls' : 'stop',
    }],
  }
}

function setup(tools: Tool[], batches: string[][]) {
  const messages: HistoryMessage[] = [{
    role: 'user',
    content: '测试任务',
    startsTurn: true,
  }]
  const events: TurnEvent[] = []
  let requests = 0

  const options: RunTurnOptions = {
    registry: createToolRegistry([...tools, done, pause]),
    maxIterations: 6,
    createStream: async () => {
      const batch = batches[requests++]
      if (!batch) throw new Error('模拟模型请求失败')
      return response(...batch)
    },
    write: () => {},
    log: () => {},
    checkpoint: async (event) => {
      events.push(event)
    },
  }

  return {
    messages,
    options,
    events,
    requests: () => requests,
  }
}

test('完成与暂停返回不同结果，同批后续工具不执行', async () => {
  for (const [name, status] of [
    ['done', 'completed'],
    ['pause', 'paused'],
  ] as const) {
    let executed = 0
    const s = setup([
      tool('late', () => {
        executed++
        return 'late'
      }),
    ], [[name, 'late']])

    const result = await runTurn(s.messages, s.options)

    assert.equal(result.status, status)
    assert.equal(executed, 0)
    assert.deepEqual(
      s.events.filter((e) => e.type === 'action').map((e) => e.state),
      ['started', 'returned', 'not_executed']
    )
    assert.equal(s.events.at(-1)?.type, 'turn_end')
  }
})

test('首次保存或执行前保存失败，工具都不能开始', async () => {
  for (const phase of ['initial', 'started']) {
    let executed = 0
    const s = setup([
      tool('write', () => {
        executed++
        return 'ok'
      }),
    ], [['write']])

    s.options.checkpoint = async (event) => {
      if (
        phase === 'initial' ||
        (event.type === 'action' && event.state === 'started')
      ) {
        throw new Error('模拟保存失败')
      }
    }

    await assert.rejects(
      runTurn(s.messages, s.options),
      CheckpointError
    )
    assert.equal(executed, 0)
    assert.equal(s.requests(), phase === 'initial' ? 0 : 1)
  }
})

test('工具返回后的保存失败，不执行后续工具、不追加收尾检查点', async () => {
  let executed = 0
  const s = setup([
    tool('write', () => {
      executed++
      return 'ok'
    }),
  ], [['write', 'write']])

  const states: string[] = []

  s.options.checkpoint = async (event) => {
    if (event.type === 'action') {
      states.push(event.state)
      if (event.state === 'returned') {
        throw new Error('模拟结果保存失败')
      }
    }
    if (event.type === 'turn_end') {
      assert.fail('保存失败后不能假装正常收尾')
    }
  }

  await assert.rejects(
    runTurn(s.messages, s.options),
    CheckpointError
  )
  assert.equal(executed, 1)
  assert.deepEqual(states, ['started', 'returned'])
  assert.equal(s.requests(), 1)
})

test('文件已改变后工具抛错，记录不确定且保留副作用', async () => {
  const directory = await mkdtemp(
    join(tmpdir(), 'mini-agent-action-')
  )
  const file = join(directory, 'marker.txt')

  try {
    let late = 0
    const s = setup([
      tool('partial', async () => {
        await writeFile(file, '已经写入')
        throw new Error('写入之后失败')
      }),
      tool('late', () => {
        late++
        return 'late'
      }),
    ], [['partial', 'late']])

    assert.equal(
      (await runTurn(s.messages, s.options)).status,
      'failed'
    )
    assert.equal(await readFile(file, 'utf8'), '已经写入')
    assert.equal(late, 0)
    assert.deepEqual(
      s.events.filter((e) => e.type === 'action').map((e) => e.state),
      ['started', 'uncertain', 'not_executed']
    )
    assert.equal(
      s.messages.filter((m) => m.role === 'tool').length,
      2
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('批准拒绝、参数无效和未知工具均标记未执行', async () => {
  let executed = 0
  const s = setup([
    {
      ...tool('protected', () => {
        executed++
        return 'bad'
      }),
      needsApproval: true,
    },
    {
      ...tool('invalid', () => {
        executed++
        return 'bad'
      }),
      schema: z.object({ required: z.string() }),
    },
  ], [['protected', 'invalid', 'missing', 'pause']])

  s.options.approve = async () => false

  assert.equal(
    (await runTurn(s.messages, s.options)).status,
    'paused'
  )
  assert.equal(executed, 0)
  assert.deepEqual(
    s.events.filter((e) => e.type === 'action').map((e) => e.state),
    [
      'not_executed',
      'not_executed',
      'not_executed',
      'started',
      'returned',
    ]
  )
})

test('批准中取消为未执行，执行中取消为不确定', async () => {
  const abort = () => {
    throw Object.assign(new Error('cancel'), {
      name: 'AbortError',
    })
  }

  for (const phase of ['approval', 'execution']) {
    const s = setup([{
      ...tool('work', abort),
      needsApproval: phase === 'approval',
    }], [['work']])

    s.options.approve = async () => abort()

    assert.equal(
      (await runTurn(s.messages, s.options)).status,
      'cancelled'
    )

    const states = s.events
      .filter((e) => e.type === 'action')
      .map((e) => e.state)

    assert.deepEqual(
      states,
      phase === 'approval'
        ? ['not_executed']
        : ['started', 'uncertain']
    )
  }
})

test('后续模型请求失败保留此前已返回结果，不重跑工具', async () => {
  let count = 0
  const s = setup([
    tool('work', () => {
      count++
      return '已完成的观察'
    }),
  ], [['work']])

  assert.equal(
    (await runTurn(s.messages, s.options)).status,
    'failed'
  )
  assert.equal(count, 1)
  assert.ok(s.messages.some(
    (m) => m.role === 'tool' && m.content === '已完成的观察'
  ))
  assert.equal(s.requests(), 2)
})

test('原始历史保留完整工具文本，模型请求使用截断视图', async () => {
  const content = 'x'.repeat(9000)
  const s = setup(
    [tool('large', () => content)],
    [['large'], ['done']]
  )

  const createStream = s.options.createStream
  s.options.createStream = async (request) => {
    const observation = request.messages.find(
      (m) => m.role === 'tool'
    )

    if (observation) {
      assert.ok(
        String(observation.content).length < content.length
      )
      assert.match(String(observation.content), /截断/)
    }

    return createStream(request)
  }

  assert.equal(
    (await runTurn(s.messages, s.options)).status,
    'completed'
  )
  assert.ok(s.messages.some(
    (m) => m.role === 'tool' && m.content === content
  ))
})

test('检查点收到副本，重复调用 ID 通过消息位置区分', async () => {
  const s = setup(
    [tool('work')],
    [['work'], ['work'], ['done']]
  )
  const positions: number[] = []

  s.options.checkpoint = async (event, history) => {
    history.length = 0

    if (event.type === 'action' && event.state === 'started') {
      positions.push(event.messageIndex)
      event.call.function.name = '被回调修改'
    }
  }

  assert.equal(
    (await runTurn(s.messages, s.options)).status,
    'completed'
  )
  assert.deepEqual(positions, [1, 3, 5])
  assert.equal(s.messages.length, 7)
})

test('请求耗尽与循环守卫返回不同结果', async () => {
  const text = setup([], [[], []])
  text.options.maxIterations = 2

  assert.equal(
    (await runTurn(text.messages, text.options)).status,
    'budget_exhausted'
  )

  const loop = setup(
    [tool('work')],
    [['work'], ['work'], ['work'], ['work']]
  )

  assert.equal(
    (await runTurn(loop.messages, loop.options)).status,
    'failed'
  )
  assert.equal(loop.requests(), 4)
})
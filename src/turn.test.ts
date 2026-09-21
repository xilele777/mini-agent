import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ChatCompletionChunk,
} from 'openai/resources/chat/completions'
import type {
  HistoryMessage,
} from './context.js'
import {
  runTurn,
  type CreateTurnStream,
  type TurnRequest,
} from './turn.js'

function chunk(
  choices: ChatCompletionChunk['choices']
): ChatCompletionChunk {
  return {
    id: 'test',
    choices,
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
    usage: null,
  }
}

async function* chunks(
  ...items: ChatCompletionChunk[]
): AsyncGenerator<ChatCompletionChunk> {
  yield* items
}

function textStream(
  text: string
): AsyncIterable<ChatCompletionChunk> {
  return chunks(
    chunk([
      {
        index: 0,
        delta: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      },
    ])
  )
}

function toolStream(
  ...calls: Array<{
    id: string
    name: string
    args: string
  }>
): AsyncIterable<ChatCompletionChunk> {
  return chunks(
    chunk([
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: calls.map(
            (call, index) => ({
              index,
              id: call.id,
              type: 'function' as const,
              function: {
                name: call.name,
                arguments: call.args,
              },
            })
          ),
        },
        finish_reason: 'tool_calls',
      },
    ])
  )
}

function history(): HistoryMessage[] {
  return [
    {
      role: 'system',
      content: 'test system',
    },
    {
      role: 'user',
      content: 'test task',
      startsTurn: true,
    },
  ]
}

/**
 * 每调用一次 createStream，就依次取出一份模拟响应。
 * 同时保存请求，让测试检查下一轮模型实际收到了什么。
 */
function queuedStream(
  streams: AsyncIterable<ChatCompletionChunk>[],
  requests: TurnRequest[]
): CreateTurnStream {
  let index = 0

  return async (request) => {
    requests.push(request)

    const stream = streams[index]
    index++

    assert.ok(
      stream,
      `缺少第 ${index} 个模拟响应`
    )

    return stream
  }
}

function toolMessages(
  messages: HistoryMessage[]
) {
  return messages.filter(
    (message) => message.role === 'tool'
  )
}

test(
  'finish_task 后同批剩余调用补未执行结果',
  async () => {
    const messages = history()
    const requests: TurnRequest[] = []

    await runTurn(messages, {

      createStream: queuedStream(
        [
          toolStream(
            {
              id: 'done',
              name: 'finish_task',
              args: '{}',
            },
            {
              id: 'late-calc',
              name: 'calculate',
              args:
                '{"expression":"40 + 2"}',
            }
          ),
        ],
        requests
      ),
      write: () => undefined,
      log: () => undefined,
    })

    assert.equal(requests.length, 1)

    assert.deepEqual(
      toolMessages(messages).map(
        (message) => ({
          id:
            message.role === 'tool'
              ? message.tool_call_id
              : '',
          content: message.content,
        })
      ),
      [
        {
          id: 'done',
          content: '本次请求已处理完毕。',
        },
        {
          id: 'late-calc',
          content:
            '本轮已结束，此工具调用未执行。等待用户新指令。',
        },
      ]
    )
  }
)

test(
  '累计两次循环守卫后补齐当前和剩余调用结果',
  async () => {
    const messages = history()
    const requests: TurnRequest[] = []
    const logs: string[] = []

    const repeated = {
      name: 'calculate',
      args: '{"expression":"1 + 1"}',
    }

    await runTurn(messages, {

      createStream: queuedStream(
        [
          toolStream({
            id: 'repeat-1',
            ...repeated,
          }),
          toolStream({
            id: 'repeat-2',
            ...repeated,
          }),
          toolStream({
            id: 'repeat-3',
            ...repeated,
          }),
          toolStream(
            {
              id: 'repeat-4',
              ...repeated,
            },
            {
              id: 'after-loop',
              name: 'calculate',
              args:
                '{"expression":"9 + 9"}',
            }
          ),
        ],
        requests
      ),
      write: () => undefined,
      log: (message) => {
        logs.push(message)
      },
    })

    const results = toolMessages(messages)

    assert.equal(requests.length, 4)

    /*
     * 前两次真正执行。
     * 第三、第四次由循环守卫回填。
     * 同批的 after-loop 也得到未执行结果。
     */
    assert.deepEqual(
      results.map((message) =>
        message.role === 'tool'
          ? message.tool_call_id
          : ''
      ),
      [
        'repeat-1',
        'repeat-2',
        'repeat-3',
        'repeat-4',
        'after-loop',
      ]
    )

    assert.equal(
      results[0]?.content,
      '2'
    )

    assert.equal(
      results[1]?.content,
      '2'
    )

    assert.match(
      String(results[2]?.content),
      /循环守卫/
    )

    assert.match(
      String(results[3]?.content),
      /循环守卫/
    )

    assert.match(
      String(results[4]?.content),
      /未执行/
    )

    assert.ok(
      logs.some((line) =>
        line.includes('本轮放弃')
      )
    )
  }
)

test(
  '持续纯文本达到请求上限且内部提示不新增真实用户轮',
  async () => {
    const messages = history()
    const requests: TurnRequest[] = []
    const logs: string[] = []

    await runTurn(messages, {

      createStream: queuedStream(
        [
          textStream('还在处理'),
          textStream('仍在处理'),
        ],
        requests
      ),
      maxIterations: 2,
      write: () => undefined,
      log: (message) => {
        logs.push(message)
      },
    })

    assert.equal(requests.length, 2)

    /*
     * 初始测试历史中只有一个 startsTurn。
     * runTurn 加入的继续提示不能成为新的真实用户轮。
     */
    assert.equal(
      messages.filter(
        (message) =>
          message.startsTurn === true
      ).length,
      1
    )

    assert.equal(
      messages.filter(
        (message) =>
          message.role === 'user' &&
          message.startsTurn !== true
      ).length,
      2
    )

    assert.ok(
      logs.some((line) =>
        line.includes('连续 2 轮')
      )
    )
  }
)

test(
  '同一响应的多个普通工具结果按 id 回填后进入下一次请求',
  async () => {
    const messages = history()
    const requests: TurnRequest[] = []

    await runTurn(messages, {

      createStream: queuedStream(
        [
          toolStream(
            {
              id: 'calc-1',
              name: 'calculate',
              args:
                '{"expression":"1 + 1"}',
            },
            {
              id: 'calc-2',
              name: 'calculate',
              args:
                '{"expression":"2 * 3"}',
            }
          ),
          toolStream({
            id: 'done',
            name: 'finish_task',
            args: '{}',
          }),
        ],
        requests
      ),
      write: () => undefined,
      log: () => undefined,
    })

    assert.equal(requests.length, 2)

    /*
     * 第二次请求必须已经包含第一次响应中
     * 两个工具调用各自对应的结果。
     */
    const secondRequestResults =
      requests[1]?.messages.filter(
        (message) =>
          message.role === 'tool'
      )

    assert.deepEqual(
      secondRequestResults,
      [
        {
          role: 'tool',
          tool_call_id: 'calc-1',
          content: '2',
        },
        {
          role: 'tool',
          tool_call_id: 'calc-2',
          content: '6',
        },
      ]
    )
  }
)
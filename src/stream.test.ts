import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { CompletionUsage } from 'openai/resources/completions'
import { collectResponse } from './stream.js'

function chunk(
  choices: ChatCompletionChunk['choices'],
  usage: CompletionUsage | null = null
): ChatCompletionChunk {
  return {
    id: 'test',
    choices,
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
    usage,
  }
}

async function* chunks(
  ...items: ChatCompletionChunk[]
): AsyncGenerator<ChatCompletionChunk> {
  yield* items
}

const stop = chunk([
  { index: 0, delta: {}, finish_reason: 'stop' },
])

test('文本分片即时显示并组装为一条消息', async () => {
  const shown: string[] = []

  const result = await collectResponse(
    chunks(
      chunk([{
        index: 0,
        delta: { role: 'assistant', content: '你' },
        finish_reason: null,
      }]),
      chunk([{
        index: 0,
        delta: { content: '好' },
        finish_reason: null,
      }]),
      stop
    ),
    (text) => shown.push(text)
  )

  assert.deepEqual(shown, ['你', '好'])
  assert.equal(result.message.content, '你好')
  assert.equal(result.message.refusal, null)
})

test('拒绝文本同时显示并保存在 refusal', async () => {
  const shown: string[] = []

  const result = await collectResponse(
    chunks(
      chunk([{
        index: 0,
        delta: { refusal: '不能' },
        finish_reason: null,
      }]),
      stop
    ),
    (text) => shown.push(text)
  )

  assert.deepEqual(shown, ['不能'])
  assert.equal(result.message.refusal, '不能')
})

test('choices 为空的尾部 usage 得到保留', async () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 2,
    total_tokens: 12,
  }

  const result = await collectResponse(
    chunks(stop, chunk([], usage)),
    () => undefined
  )

  assert.deepEqual(result.usage, usage)
})

test('同名调用交错且编号 1 先到时仍按 index 排序', async () => {
  const result = await collectResponse(
    chunks(
      chunk([{
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [{
            index: 1,
            id: 'call-1',
            type: 'function',
            function: { name: 'cal' },
          }],
        },
      }]),
      chunk([{
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-0',
            type: 'function',
            function: { name: 'cal' },
          }],
        },
      }]),
      chunk([{
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [
            {
              index: 1,
              function: {
                name: 'culate',
                arguments: '{"expression":"10 * 3"}',
              },
            },
            {
              index: 0,
              function: {
                name: 'culate',
                arguments: '{"expression":"1 + 2"}',
              },
            },
          ],
        },
      }]),
      chunk([{
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
      }])
    ),
    () => undefined
  )

  assert.deepEqual(
    result.message.tool_calls?.map((call) => call.id),
    ['call-0', 'call-1']
  )

  assert.deepEqual(
    result.message.tool_calls?.map(
      (call) => call.type === 'function' && call.function.name
    ),
    ['calculate', 'calculate']
  )

  assert.deepEqual(
    result.message.tool_calls?.map(
      (call) => call.type === 'function' && call.function.arguments
    ),
    [
      '{"expression":"1 + 2"}',
      '{"expression":"10 * 3"}',
    ]
  )
})

test('不同 collectResponse 请求不会共享调用状态', async () => {
  const make = (id: string) => chunks(
    chunk([{
      index: 0,
      finish_reason: null,
      delta: {
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: {
            name: 'current_time',
            arguments: '{}',
          },
        }],
      },
    }]),
    chunk([{
      index: 0,
      delta: {},
      finish_reason: 'tool_calls',
    }])
  )

  const first = await collectResponse(make('first'), () => undefined)
  const second = await collectResponse(make('second'), () => undefined)

  assert.equal(first.message.tool_calls?.[0]?.id, 'first')
  assert.equal(second.message.tool_calls?.[0]?.id, 'second')
})

test('流中异常继续向调用方传播', async () => {
  async function* broken(): AsyncGenerator<ChatCompletionChunk> {
    yield chunk([{
      index: 0,
      delta: { content: '已显示' },
      finish_reason: null,
    }])

    throw new Error('network failed')
  }

  await assert.rejects(
    collectResponse(broken(), () => undefined),
    /network failed/
  )
})

test('缺少结束原因时拒绝返回消息', async () => {
  await assert.rejects(
    collectResponse(
      chunks(chunk([{
        index: 0,
        delta: { content: '未结束' },
        finish_reason: null,
      }])),
      () => undefined
    ),
    /缺少结束原因/
  )
})

test('length 结束的文本响应不会被当作完整消息', async () => {
  await assert.rejects(
    collectResponse(
      chunks(chunk([{
        index: 0,
        delta: { content: '截断' },
        finish_reason: 'length',
      }])),
      () => undefined
    ),
    /未正常结束/
  )
})

test('工具调用编号必须从零连续', async () => {
  await assert.rejects(
    collectResponse(
      chunks(
        chunk([{
          index: 0,
          finish_reason: null,
          delta: {
            tool_calls: [{
              index: 1,
              id: 'call-1',
              type: 'function',
              function: {
                name: 'current_time',
                arguments: '{}',
              },
            }],
          },
        }]),
        chunk([{
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        }])
      ),
      () => undefined
    ),
    /必须从 0 连续递增/
  )
})

test('不同调用不能使用重复 id', async () => {
  await assert.rejects(
    collectResponse(
      chunks(
        chunk([{
          index: 0,
          finish_reason: null,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'same',
                type: 'function',
                function: {
                  name: 'current_time',
                  arguments: '{}',
                },
              },
              {
                index: 1,
                id: 'same',
                type: 'function',
                function: {
                  name: 'current_time',
                  arguments: '{}',
                },
              },
            ],
          },
        }]),
        chunk([{
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        }])
      ),
      () => undefined
    ),
    /id 重复/
  )
})

test('缺少调用 type 时拒绝组装', async () => {
  await assert.rejects(
    collectResponse(
      chunks(
        chunk([{
          index: 0,
          finish_reason: null,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call-0',
              function: {
                name: 'current_time',
                arguments: '{}',
              },
            }],
          },
        }]),
        chunk([{
          index: 0,
          delta: {},
          finish_reason: 'tool_calls',
        }])
      ),
      () => undefined
    ),
    /缺少 id、type 或 name/
  )
})

test('custom 调用类型会被拒绝', async () => {
  await assert.rejects(
    collectResponse(
      chunks(chunk([{
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'custom-0',
            type: 'custom',
            custom: {
              name: 'shell',
              input: 'pwd',
            },
          }],
        },
      }])),
      () => undefined
    ),
    /不支持的工具调用类型/
  )
})

test('完整但非法的参数原文保留给 prepareCall', async () => {
  const result = await collectResponse(
    chunks(
      chunk([{
        index: 0,
        finish_reason: null,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call-0',
            type: 'function',
            function: {
              name: 'calculate',
              arguments: '{bad json',
            },
          }],
        },
      }]),
      chunk([{
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
      }])
    ),
    () => undefined
  )

  const call = result.message.tool_calls?.[0]

  assert.equal(
    call?.type === 'function' && call.function.arguments,
    '{bad json'
  )
})
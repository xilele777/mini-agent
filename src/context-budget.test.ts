import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions'
import { toModelMessages, type HistoryMessage } from './context.js'
import { buildContext, estimateInputTokens } from './context-budget.js'

function budget(inputLimit: number) {
  return {
    contextWindow: inputLimit + 200,
    outputReserve: 128,
    safetyMargin: 72,
  }
}

const system: HistoryMessage = { role: 'system', content: '系统规则' }
const current: HistoryMessage = {
  role: 'user',
  content: '当前任务',
  startsTurn: true,
}

test('边界刚好容纳，预留生效且 startsTurn 不外发', () => {
  const history = [system, current]
  const size = estimateInputTokens(toModelMessages(history), [])
  const plan = buildContext(history, [], budget(size))

  if (!plan.ok) throw new Error(plan.reason)

  assert.equal(plan.droppedTurns, 0)
  assert.equal(plan.inputLimit, size)
  assert.ok(plan.messages.every((m) => !('startsTurn' in m)))
  assert.equal(buildContext(history, [], budget(size - 1)).ok, false)
})

test('旧轮整体移除，当前工具配对和内部提示保留', () => {
  const active: HistoryMessage[] = [
    current,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'calculate',
            arguments: '{"expression":"1+1"}',
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: '2' },
    { role: 'user', content: '请继续' },
  ]

  const history: HistoryMessage[] = [
    system,
    { role: 'user', content: '很早的任务', startsTurn: true },
    { role: 'assistant', content: 'a'.repeat(200) },
    { role: 'user', content: '上轮任务', startsTurn: true },
    { role: 'assistant', content: 'b'.repeat(200) },
    ...active,
  ]

  const expected = toModelMessages([system, ...active])
  const plan = buildContext(history, [], budget(estimateInputTokens(expected, [])))

  if (!plan.ok) throw new Error(plan.reason)

  assert.equal(plan.droppedTurns, 2)
  assert.deepEqual(plan.messages, expected)
})

test('单轮过长返回失败，不丢掉当前目标', () => {
  const history: HistoryMessage[] = [
    system,
    { role: 'user', content: 'x'.repeat(2000), startsTurn: true },
  ]

  const original = structuredClone(history)
  const plan = buildContext(history, [], budget(300))

  assert.equal(plan.ok, false)
  assert.equal(plan.droppedTurns, 0)
  assert.deepEqual(history, original)
})

test('工具 schema 计入预算', () => {
  const history = [system, current]
  const tools: ChatCompletionFunctionTool[] = [
    {
      type: 'function',
      function: {
        name: 'large_tool',
        description: 'x'.repeat(1000),
        parameters: { type: 'object', properties: {} },
      },
    },
  ]

  const limit = estimateInputTokens(toModelMessages(history), [])

  assert.equal(buildContext(history, [], budget(limit)).ok, true)
  assert.equal(buildContext(history, tools, budget(limit)).ok, false)
})

test('只截断模型视图中的工具输出，原始历史保持完整', () => {
  const history: HistoryMessage[] = [
    system,
    current,
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'read-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'read-1',
      content: 'x'.repeat(6000),
    },
  ]

  const original = structuredClone(history)
  const plan = buildContext(history, [], budget(20_000))

  if (!plan.ok) throw new Error(plan.reason)

  assert.match(String(plan.messages.at(-1)?.content), /已截断/)

  const assistant = plan.messages[2]
  if (assistant?.role === 'assistant') {
    assistant.tool_calls?.splice(0)
  }

  assert.deepEqual(history, original)
})

test('没有真实轮标记时保留全部消息，超限就失败', () => {
  const history: HistoryMessage[] = [
    system,
    { role: 'user', content: 'x'.repeat(1000) },
    { role: 'user', content: '内部提示' },
  ]

  assert.equal(buildContext(history, [], budget(100)).ok, false)

  const plan = buildContext(history, [], budget(10_000))
  if (!plan.ok) throw new Error(plan.reason)

  assert.deepEqual(plan.messages, history)
})

test('非法配置和错误轮标记明确报错', () => {
  for (const value of [NaN, Infinity, 0, -1, 0.5]) {
    assert.throws(() =>
      buildContext([], [], {
        contextWindow: value,
        outputReserve: 10,
        safetyMargin: 1,
      })
    )
  }

  assert.throws(() =>
    buildContext([], [], {
      contextWindow: 100,
      outputReserve: 90,
      safetyMargin: 10,
    })
  )

  assert.throws(() =>
    buildContext([{ role: 'assistant', content: '错误', startsTurn: true }], [], budget(1000))
  )

  assert.throws(() => buildContext([current, system], [], budget(1000)))
})

test('多模态消息不能按文本估算放行', () => {
  assert.throws(
    () =>
      estimateInputTokens(
        [
          {
            role: 'user',
            content: [{ type: 'text', text: '内容块' }],
          },
        ],
        []
      ),
    /只支持文本/
  )
})

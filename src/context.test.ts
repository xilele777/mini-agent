import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectRepeatedCall, truncateToolResult, trimHistory, toModelMessages } from './context.js'
import type { HistoryMessage } from './context.js'

test('检测:少于阈值 → 无恙', () => {
  assert.equal(detectRepeatedCall([{ name: 'read_file', argsKey: '{"path":"a.ts"}' }], 3), null)
})

test('检测:3 条完全相同 → 触发', () => {
  assert.ok(
    detectRepeatedCall(
      [
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
      ],
      3
    )
  )
})

test('检测:第 3 条参数不同 → 无恙', () => {
  assert.equal(
    detectRepeatedCall(
      [
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"b.ts"}' },
      ],
      3
    ),
    null
  )
})

test('检测:中间穿插别的工具 → 无恙', () => {
  assert.equal(
    detectRepeatedCall(
      [
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'run_bash', argsKey: '{"x":1}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
      ],
      3
    ),
    null
  )
})

test('检测:只看最后连续段(最早不同不影响)', () => {
  assert.ok(
    detectRepeatedCall(
      [
        { name: 'time', argsKey: '{}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
        { name: 'read_file', argsKey: '{"path":"a.ts"}' },
      ],
      3
    )
  )
})

test('截断:短文本不动', () => {
  assert.equal(truncateToolResult('短'), '短')
})

test('截断:长文本保留头尾加省略标注', () => {
  const long = 'x'.repeat(5000)
  const r = truncateToolResult(long)
  assert.ok(r.startsWith('[工具结果过长已截断:'))
  assert.ok(r.includes('省略中间'))
  assert.ok(r.includes('x'.repeat(3000))) // 头 3000
  assert.ok(r.endsWith('x'.repeat(1000))) // 尾 1000
})

test('历史裁剪：内部提示不增加真实用户轮数', () => {
  const messages: HistoryMessage[] = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '只记录待办，不执行', startsTurn: true },
  ]

  for (let i = 0; i < 6; i++) {
    messages.push({ role: 'assistant', content: '阶段性回复' })
    messages.push({ role: 'user', content: '内部继续提示' })
  }

  messages.push({ role: 'assistant', content: '本轮结束' })

  assert.deepEqual(trimHistory(messages), messages)
})

test('历史裁剪：保留最近六个完整用户轮', () => {
  const system: HistoryMessage = { role: 'system', content: '规则' }
  const turns: HistoryMessage[][] = []

  for (let i = 1; i <= 7; i++) {
    turns.push([
      { role: 'user', content: '问题 ' + i, startsTurn: true },
      { role: 'assistant', content: '阶段性回复' },
      { role: 'user', content: '内部继续提示' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'finish-' + i,
            type: 'function',
            function: { name: 'finish_task', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'finish-' + i,
        content: '本次请求已处理完毕。',
      },
    ])
  }

  const messages = [system, ...turns.flat()]
  const original = structuredClone(messages)

  assert.deepEqual(trimHistory(messages), [system, ...turns.slice(1).flat()])
  assert.deepEqual(messages, original)
})

test('API 消息：移除本地标记，不修改原始历史', () => {
  const messages: HistoryMessage[] = [
    { role: 'system', content: '规则' },
    { role: 'user', content: '只记录', startsTurn: true },
    { role: 'user', content: '内部继续提示' },
  ]

  assert.deepEqual(toModelMessages(messages), [
    { role: 'system', content: '规则' },
    { role: 'user', content: '只记录' },
    { role: 'user', content: '内部继续提示' },
  ])

  assert.equal(messages[1]?.startsTurn, true)
})

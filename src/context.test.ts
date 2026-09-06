import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectRepeatedCall, truncateToolResult } from './context.js'
import type { ToolCallLog } from './context.js'

test('检测:少于阈值 → 无恙', () => {
  assert.equal(
    detectRepeatedCall(
      [{ name: 'read_file', argsKey: '{"path":"a.ts"}' }],
      3
    ),
    null
  )
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

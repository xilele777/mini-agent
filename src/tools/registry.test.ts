import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import type { Tool } from './types.js'
import { createToolRegistry } from './registry.js'

const echoParams = z.object({
  text: z.string().min(1),
})

const echoTool: Tool<z.infer<typeof echoParams>> = {
  name: 'echo',
  description: '原样返回文本',
  schema: echoParams,
  execute: ({ text }) => text,
}

const hiddenTool: Tool = {
  name: 'hidden',
  description: '不应加入当前注册表',
  schema: z.object({}),
  execute: () => 'hidden',
}

test('注册表只暴露显式加入的工具', () => {
  const registry = createToolRegistry([echoTool])

  const names = registry
    .getToolSchemas()
    .map((schema) => schema.function.name)

  assert.deepEqual(names, ['echo'])
})

test('已注册工具使用自己的 schema 准备参数', () => {
  const registry = createToolRegistry([echoTool])

  const prepared = registry.prepareCall(
    'echo',
    '{"text":"hello"}'
  )

  if (!prepared.ok) {
    assert.fail(prepared.error)
  }

  assert.equal(prepared.tool, echoTool)
  assert.deepEqual(prepared.args, { text: 'hello' })
})

test('未加入能力集合的工具不能通过准备阶段', () => {
  const registry = createToolRegistry([echoTool])

  const prepared = registry.prepareCall(
    hiddenTool.name,
    '{}'
  )

  if (prepared.ok) {
    assert.fail('hidden 不应准备成功')
  }

  assert.match(prepared.error, /不存在名为 "hidden" 的工具/)
  assert.match(prepared.error, /可用工具只有:echo/)
})

test('建立注册表时拒绝重复工具名', () => {
  const duplicate: Tool = {
    ...echoTool,
    name: 'echo',
  }

  assert.throws(
    () => createToolRegistry([echoTool, duplicate]),
    /重复名称/
  )
})
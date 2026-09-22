import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelegateTaskTool } from './delegate.js'
import { testRuntime } from '../test-runtime.js'

const { getToolSchemas, prepareCall } = testRuntime.turnOptions.registry

test('主注册表暴露 delegate_task', () => {
  const names = getToolSchemas().map((tool) => tool.function.name)

  assert.ok(names.includes('delegate_task'))
})

test('delegate_task 的参数由主注册表校验', () => {
  const prepared = prepareCall('delegate_task', '{"task":"  检查入口文件  "}')

  if (!prepared.ok) {
    assert.fail(prepared.error)
  }

  assert.equal(prepared.tool.name, 'delegate_task')
  assert.deepEqual(prepared.args, {
    task: '检查入口文件',
  })
})

test('delegate_task 将子任务交给注入的 runner', async () => {
  const received: string[] = []

  const tool = createDelegateTaskTool(async (task) => {
    received.push(task)
    return '子 Agent 调查结果'
  })

  const result = await tool.execute({
    task: '读取项目入口',
  })

  assert.deepEqual(received, ['读取项目入口'])
  assert.equal(result, '子 Agent 调查结果')
})

test('delegate_task 不需要人工批准或结束主轮', () => {
  const tool = createDelegateTaskTool(async () => 'result')

  assert.equal(tool.needsApproval, undefined)
  assert.equal(tool.endsTurn, undefined)
})

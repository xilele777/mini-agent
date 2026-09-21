import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { createReadFileTool } from './fs.js'

const readFileTool = createReadFileTool(5 * 1024 * 1024)

// 这三类输入在路径检查阶段被拒绝，无需创建或读取目标文件。

test('read_file: 项目外路径被拒', async () => {
  const r = await readFileTool.execute({
    path: join(tmpdir(), 'miniagent-outside', 'x.txt'),
    offset: 1,
    limit: 10,
  })
  assert.match(r, /之外/)
})

test('read_file: .env 被拒', async () => {
  const r = await readFileTool.execute({ path: '.env', offset: 1, limit: 10 })
  assert.match(r, /\.env|拒绝/)
})

test('read_file: ../ 逃出项目根被拒', async () => {
  const r = await readFileTool.execute({ path: '../outside/x.txt', offset: 1, limit: 10 })
  assert.match(r, /之外|拒绝/)
})

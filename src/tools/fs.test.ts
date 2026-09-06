import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { readFileTool } from './fs.js'

// read_file 的 execute 以 process.cwd() 为项目根,三类拒绝路径都可在
// 不触碰真实文件的前提下验证(守卫在 readFile 之前返回)。

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

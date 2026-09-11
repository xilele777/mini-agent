import assert from 'node:assert/strict'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOCKED, ROOT, isBlocked, guardPathRead, guardDirRead } from './guard.js'

// 项目外路径用系统临时目录构造；链接用例还会创建并清理实际夹具。

function tmpBase(): string {
  const dir = join(tmpdir(), 'miniagent-guard-test')
  return dir
}

test('BLOCKED: 命中 .env / .git / node_modules / 私钥', () => {
  assert.ok(isBlocked(join(ROOT, '.env')))
  assert.ok(isBlocked(join(ROOT, 'src', '.env.local')))
  assert.ok(isBlocked(join(ROOT, '.git', 'config')))
  assert.ok(isBlocked(join(ROOT, 'node_modules', 'x')))
  assert.ok(isBlocked(join(ROOT, 'keys', 'id_rsa')))
  assert.ok(isBlocked(join(ROOT, 'cert', 'server.key')))
  assert.ok(isBlocked(join(ROOT, 'cert', 'a.pem')))
})

test('BLOCKED: 普通源码文件不误伤', () => {
  assert.ok(!isBlocked(join(ROOT, 'src', 'agent.ts')))
  assert.ok(!isBlocked(join(ROOT, 'package.json')))
  // 普通文件名包含 env 字样时也应放行。
  assert.ok(!isBlocked(join(ROOT, 'src', 'envs.ts')))
})

test('read 守卫: 项目内文件放行', async () => {
  const r = await guardPathRead(join(ROOT, 'src', 'agent.ts'))
  assert.equal(r.ok, true)
  // 兼容 Windows 上 realpath 返回值与输入盘符的大小写差异。
  if (r.ok) assert.equal(r.real.toLowerCase(), r.abs.toLowerCase())
})

test('read 守卫: 项目外路径拒绝(不依赖真实 IO)', async () => {
  const outside = join(tmpBase(), 'somewhere', 'a.txt')
  const r = await guardPathRead(outside)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /之外/)
})

test('read 守卫: 项目内敏感路径拒绝', async () => {
  const r = await guardPathRead(join(ROOT, '.env'))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /\.env/)
})

test('read 守卫: 经符号链接指到项目外 → 拒绝', async () => {
  // 夹具本身位于 ROOT 外，此用例验证拒绝结果，未单独覆盖项目内链接逃逸的分支。
  const dir = join(tmpBase(), 'symlink-escaping')
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, 'outside'), { recursive: true })
  await mkdir(join(dir, 'proj'), { recursive: true })
  await writeFile(join(dir, 'outside', 'secret.txt'), 's')
  try {
    await symlink(join(dir, 'outside'), join(dir, 'proj', 'leak'), 'junction')
    const r = await guardPathRead(join(dir, 'proj', 'leak', 'secret.txt'))
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.message, /符号链接|之外/)
  } catch (e) {
    // 环境不允许创建链接时结束本用例，其他错误继续抛出。
    if ((e as NodeJS.ErrnoException).code !== 'EPERM' && (e as NodeJS.ErrnoException).code !== 'EACCES') throw e
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('目录守卫: 项目内目录放行', async () => {
  const r = await guardDirRead(join(ROOT, 'src'))
  assert.equal(r.ok, true)
})

test('目录守卫: 项目外目录拒绝', async () => {
  const r = await guardDirRead(join(tmpBase(), 'x'))
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.message, /之外/)
})

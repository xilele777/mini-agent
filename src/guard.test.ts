import assert from 'node:assert/strict'
import { mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOCKED, ROOT, isBlocked, guardPathRead, guardDirRead } from './guard.js'

// 真实临时目录会被路径检查当作"项目外"直接拒绝,
// 所以下面守卫通过与否都不依赖真实文件是否写入 —— 纯路径语义测试。

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
  // 结尾是 .env 的目录名别误伤:…envfile
  assert.ok(!isBlocked(join(ROOT, 'src', 'envs.ts')))
})

test('read 守卫: 项目内文件放行', async () => {
  const r = await guardPathRead(join(ROOT, 'src', 'agent.ts'))
  assert.equal(r.ok, true)
  // realpath 会把盘符规范化为大写(F:),而 cwd 保留键入的大小写 —— 这里比大小写无关的等价
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
    // 无权限创建 junction(个别环境)时,跳过 —— 只测能建链接的环境
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

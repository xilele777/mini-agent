// Note: 固定任务、全新副本与独立验收 — 见 .agents/notes/implemented/testing/2026-09-21-repeatable-fixture-and-ci.md
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const template = join(root, 'fixtures', 'shipping-boundary')
const runs = join(root, '.mini-agent-eval')
const allowed = 'src/shipping.ts'

async function inventory(dir, prefix = '') {
  const files = new Map()
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = prefix + entry.name
    const target = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error('评测副本不能包含符号链接。')
    if (entry.isDirectory()) {
      for (const [key, value] of await inventory(target, `${name}/`)) files.set(key, value)
    } else if (entry.isFile()) {
      files.set(name, createHash('sha256').update(await readFile(target)).digest('hex'))
    } else {
      throw new Error('评测副本包含不支持的文件类型。')
    }
  }
  return files
}

async function insideRuns(path) {
  const base = await realpath(runs)
  const target = await realpath(resolve(path))
  const rel = relative(base, target)
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('目标必须是 .mini-agent-eval 中的独立任务副本。')
  }
  return target
}

async function createCopy() {
  await mkdir(runs, { recursive: true })
  // 全新目录，不覆盖或清理用户之前的任务。
  const target = await mkdtemp(join(runs, 'shipping-'))
  for (const name of await readdir(template)) {
    await cp(join(template, name), join(target, name), {
      recursive: true, force: false, errorOnExist: true,
    })
  }
  return target
}

async function evaluate(path) {
  const target = await insideRuns(path)
  const expected = await inventory(template)
  const actual = await inventory(target)
  const unexpected = [...new Set([...expected.keys(), ...actual.keys()])]
    .filter((name) => name === allowed
      ? !actual.has(name)
      : expected.get(name) !== actual.get(name))
  if (unexpected.length) {
    return { passed: false, unexpected, status: null, output: '非目标文件被修改、添加或删除，未运行测试。' }
  }

  const result = spawnSync(process.execPath, [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    '--test', '--test-reporter=tap', 'src/shipping.test.ts',
  ], {
    cwd: target, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 1024 * 1024, windowsHide: true,
  })
  const output = result.stdout + result.stderr
  return {
    passed: !result.error && result.status === 0 && /# tests 3\b/.test(output) && /# pass 3\b/.test(output),
    unexpected, status: result.status,
    output: result.error ? `测试进程未正常完成：${result.error.code}` : output,
  }
}

async function selftest() {
  const target = await createCopy()
  try {
    const baseline = await evaluate(target)
    assert.equal(baseline.passed, false)
    assert.equal(baseline.status, 1)
    assert.match(baseline.output, /# pass 2\b/)
    assert.match(baseline.output, /# fail 1\b/)
    console.log('[OK] 原始任务稳定复现边界缺陷：2 通过、1 失败。')

    const file = join(target, allowed)
    const source = await readFile(file, 'utf8')
    assert.ok(source.includes('subtotal > 100'))
    await writeFile(file, source.replace('subtotal > 100', 'subtotal >= 100'))
    assert.equal((await evaluate(target)).passed, true)
    console.log('[OK] 已知修复通过 3 项业务测试；原始模板保留缺陷。')

    await writeFile(join(target, 'README.md'), 'unexpected change')
    const tampered = await evaluate(target)
    assert.equal(tampered.passed, false)
    assert.equal(tampered.status, null)
    assert.deepEqual(tampered.unexpected, ['README.md'])
    console.log('[OK] 非目标文件变化使验收失败。')
  } finally {
    // 仅删除本次自检创建的目录；先核对其真实绝对路径处于指定工作区。
    const checked = await insideRuns(target)
    await rm(checked, { recursive: true, force: true })
  }
}

const [command, target, ...rest] = process.argv.slice(2)
try {
  if (command === 'new' && !target) {
    const path = await createCopy()
    console.log(`任务目录：${relative(root, path)}`)
    console.log(`任务：修复该目录中的运费边界，只修改 src/shipping.ts。`)
    console.log(`验收：npm run fixture:check -- "${path}"`)
  } else if (command === 'check' && target && rest.length === 0) {
    const result = await evaluate(target)
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.passed ? 0 : 1
  } else if (command === 'selftest' && !target) {
    await selftest()
  } else {
    throw new Error('用法：eval-fixture.mjs new | check <任务目录> | selftest')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '夹具检查失败。')
  process.exitCode = 1
}

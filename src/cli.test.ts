import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseArgs, UsageError, version } from './cli.js'

const entry = fileURLToPath(new URL('./agent.ts', import.meta.url))
const loader = import.meta.resolve('tsx')
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('OPENAI_') || key.startsWith('MINI_AGENT_') || key.startsWith('DOTENV_'))
    delete env[key]
}
env.DOTENV_CONFIG_PATH = join(tmpdir(), 'mini-agent-no-env-file')

async function project(t: TestContext) {
  const base = await realpath(tmpdir())
  const dir = await mkdtemp(join(base, 'mini-agent-cli-'))
  t.after(async () => {
    const resolved = await realpath(dir)
    const rel = relative(base, resolved)
    assert.ok(
      rel.startsWith('mini-agent-cli-') &&
        !isAbsolute(rel) &&
        !rel.includes('/') &&
        !rel.includes('\\')
    )
    await rm(resolved, { recursive: true, force: true })
  })
  return dir
}

async function cli(cwd: string, args: string[], configured = false, input?: string) {
  return await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, entry, ...args], {
      cwd,
      windowsHide: true,
      env: configured
        ? {
            ...env,
            OPENAI_API_KEY: 'cli-test-secret',
            OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
            OPENAI_MODEL: 'offline-test',
            MINI_AGENT_SHELL: process.execPath,
          }
        : env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let sent = false
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('CLI timed out'))
    }, 15_000)
    const collect = (chunk: Buffer) => {
      output += chunk.toString()
      if (input !== undefined && !sent && output.includes('你>')) {
        sent = true
        child.stdin.end(input)
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    if (input === undefined) child.stdin.end()
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

test('CLI 严格拒绝组合、缺参、额外参数和无效 UUID', () => {
  for (const args of [
    ['--resume'],
    ['--resume', '../bad'],
    ['--online'],
    ['--help', '--sessions'],
    ['--doctor', '--online', 'x'],
  ]) {
    assert.throws(() => parseArgs(args), UsageError)
  }
  assert.deepEqual(parseArgs(['--doctor', '--online']), { kind: 'doctor', online: true })
})

test('帮助与版本无需配置，且不会创建会话', async (t) => {
  const cwd = await project(t)
  for (const flag of ['--help', '-h', '--version', '-v']) {
    const result = await cli(cwd, [flag])
    assert.equal(result.code, 0, result.output)
    assert.ok(result.output.includes(version))
    if (flag.includes('help') || flag === '-h') assert.match(result.output, /--doctor.*--online/)
  }
  assert.deepEqual(await readdir(cwd), [])
})

test('参数错误退出 2，不回显任意参数、不创建会话', async (t) => {
  const cwd = await project(t)
  const result = await cli(cwd, ['secret-argument'])
  assert.equal(result.code, 2)
  assert.match(result.output, /--help/)
  assert.ok(!result.output.includes('secret-argument'))
  assert.deepEqual(await readdir(cwd), [])
})

test('空会话列表无需模型配置，也不创建目录', async (t) => {
  const cwd = await project(t)
  const result = await cli(cwd, ['--sessions'])
  assert.equal(result.code, 0)
  assert.match(result.output, /没有会话/)
  assert.deepEqual(await readdir(cwd), [])
})

test('配置错误退出 1，且不创建会话', async (t) => {
  const cwd = await project(t)
  const result = await cli(cwd, [])
  assert.equal(result.code, 1)
  assert.match(result.output, /OPENAI_MODEL/)
  assert.deepEqual(await readdir(cwd), [])
})

test('关闭 REPL 输入流释放会话锁，随后可以恢复', async (t) => {
  const cwd = await project(t)
  const first = await cli(cwd, [], true, '')
  assert.equal(first.code, 0, first.output)
  const [id] = await readdir(join(cwd, '.mini-agent', 'sessions'))
  assert.ok(id)
  const resumed = await cli(cwd, ['--resume', id], true, 'exit\n')
  assert.equal(resumed.code, 0, resumed.output)
  assert.match(resumed.output, /恢复不会自动执行旧调用/)
  const snapshot = JSON.parse(
    await readFile(join(cwd, '.mini-agent', 'sessions', id, 'snapshot.json'), 'utf8')
  )
  assert.equal(snapshot.turns.length, 0)
})

test('exit 与 quit 正常退出 0，打开不存在的会话退出 1', async (t) => {
  const cwd = await project(t)
  for (const word of ['exit', 'quit']) {
    assert.equal((await cli(cwd, [], true, `${word}\n`)).code, 0)
  }
  const result = await cli(cwd, ['--resume', '123e4567-e89b-42d3-a456-426614174000'], true)
  assert.equal(result.code, 1)
  assert.ok(!result.output.includes('cli-test-secret'))
})

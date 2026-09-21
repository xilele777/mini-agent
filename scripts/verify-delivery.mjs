// Note: 干净安装与生产包验收 — 见 .agents/notes/implemented/testing/2026-09-21-repeatable-fixture-and-ci.md
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npm = process.env.npm_execpath
assert.ok(npm, '通过 npm run test:delivery 运行')
const base = await realpath(tmpdir())
const work = await mkdtemp(join(base, 'mini-agent-delivery-'))
const source = join(work, 'clean source')
const consumer = join(work, 'installed app')
const project = join(work, 'user project')
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('OPENAI_') || key.startsWith('MINI_AGENT_') || key.startsWith('DOTENV_') || key === 'NODE_PATH') delete env[key]
}
env.DOTENV_CONFIG_PATH = join(work, 'no.env')
env.npm_config_audit = 'false'
env.npm_config_fund = 'false'

function run(file, args, cwd, overrides = {}, expected = 0) {
  const result = spawnSync(file, args, {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  })
  assert.ifError(result.error)
  assert.equal(result.status, expected, result.stdout + result.stderr)
  return result.stdout
}
const npmRun = (args, cwd) => run(process.execPath, [npm, ...args], cwd)

try {
  await mkdir(source)
  for (const name of ['src', 'scripts/build.mjs', 'bin', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'README.md', 'LICENSE', 'CHANGELOG.md', '.env.example']) {
    const target = join(source, name)
    if (name.includes('/')) await mkdir(join(source, 'scripts'), { recursive: true })
    await cp(join(root, name), target, { recursive: true, errorOnExist: true, force: false })
  }
  npmRun(['ci', '--include=dev'], source)
  console.log('[OK] 空目录 npm ci（按 lockfile 安装，不复制 node_modules 或 .env）。')
  npmRun(['run', 'build'], source)
  const [packed] = JSON.parse(npmRun(['pack', '--json', '--ignore-scripts'], source))
  assert.ok(packed)
  const files = packed.files.map((entry) => entry.path)
  for (const name of files) {
    assert.ok(/^(dist\/(?:tools\/)?[\w-]+\.js|bin\/mini-agent\.mjs|package\.json|README\.md|LICENSE|CHANGELOG\.md|\.env\.example)$/.test(name), `意外打包文件：${name}`)
    assert.ok(!name.includes('.test.') && !name.endsWith('/test-runtime.js'))
  }
  for (const name of ['dist/agent.js', 'bin/mini-agent.mjs', '.env.example']) assert.ok(files.includes(name))
  console.log(`[OK] 编译与打包，${files.length} 个白名单文件，不包含密钥、会话、测试或学习资料。`)

  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'delivery-consumer', private: true }))
  npmRun(['install', '--omit=dev', '--ignore-scripts', join(source, packed.filename)], consumer)
  assert.ok(!JSON.parse(npmRun(['ls', '--json', '--all'], consumer)).dependencies?.tsx)
  await mkdir(project)
  const entry = join(consumer, 'node_modules/mini-agent/bin/mini-agent.mjs')
  const invoke = (args, overrides = {}, expected = 0) => run(process.execPath, [entry, ...args], project, overrides, expected)
  assert.match(invoke(['--help']), /--resume/)
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(invoke(['--version']).trim(), metadata.version)
  assert.match(invoke(['--sessions']), /没有会话/)
  invoke(['--unknown'], {}, 2)
  invoke([], {}, 1)

  // 直接运行 npm 生成的本地可执行 shim；路径含空格。
  if (process.platform === 'win32') {
    const shim = join(consumer, 'node_modules/.bin/mini-agent.ps1').replaceAll("'", "''")
    assert.match(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& '${shim}' --help; exit $LASTEXITCODE`], project), /--resume/)
  } else {
    assert.match(run(join(consumer, 'node_modules/.bin/mini-agent'), ['--help'], project), /--resume/)
  }
  const shell = process.platform === 'win32'
    ? process.env.MINI_AGENT_SHELL || 'C:/Program Files/Git/bin/bash.exe'
    : '/bin/sh'
  const configured = {
    OPENAI_API_KEY: 'delivery-test-only', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    OPENAI_MODEL: 'offline', MINI_AGENT_SHELL: shell,
  }
  assert.match(invoke(['--doctor'], configured), /SKIP/)
  invoke([], configured) // stdin 为 EOF：新建会话后正常释放锁，不调用模型。
  const list = invoke(['--sessions'])
  const id = list.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0]
  assert.ok(id)
  assert.match(invoke(['--resume', id], configured), /恢复不会自动执行旧调用/)
  console.log('[OK] 仅生产依赖安装：真实 npm shim、帮助、版本、退出码、离线 doctor、新建与恢复会话通过。')
} finally {
  const resolved = await realpath(work)
  const rel = relative(base, resolved)
  assert.ok(rel.startsWith('mini-agent-delivery-') && !isAbsolute(rel) && !rel.includes('/') && !rel.includes('\\'))
  await rm(resolved, { recursive: true, force: true })
}

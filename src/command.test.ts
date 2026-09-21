import 'dotenv/config'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { runCommand } from './command.js'
import { runTurn, type TurnEvent } from './turn.js'
import { createBashTool } from './tools/bash.js'
import { createToolRegistry } from './tools/registry.js'
import { finishTaskTool } from './tools/control.js'
import { editFileTool } from './tools/edit.js'
import { createReadFileTool } from './tools/fs.js'
import { testConfig } from './test-runtime.js'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

const shell = process.env.MINI_AGENT_SHELL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh')
const available = { skip: existsSync(shell) ? false : '未安装支持的 shell；设置 MINI_AGENT_SHELL 后重跑' }
const quote = (value: string) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\"'\"'") + "'"
const command = (code: string) => `${quote(process.execPath)} -e ${quote(code)}`
const options = { shell, cwd: process.cwd(), timeoutMs: 5000 }

test('固定运费任务：读取 → diff → 批准 → 增量修复 → 实际 shell 独立验收', available, async t => {
  const base = join(process.cwd(), '.mini-agent-eval')
  await mkdir(base, { recursive: true })
  const dir = await mkdtemp(join(base, 'stage13-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await cp(join(process.cwd(), 'fixtures', 'shipping-boundary'), dir, { recursive: true })
  // node:test 的内部标记不能传给独立业务测试进程，否则 Node 会跳过嵌套测试。
  const check = `env -u NODE_TEST_CONTEXT ${quote(process.execPath)} scripts/eval-fixture.mjs check ${quote(dir)}`
  assert.match(await runCommand({ ...options, command: check }), /退出码: 1/)
  const path = join(dir, 'src', 'shipping.ts')
  const read = await createReadFileTool(1024).execute({ path, offset: 1, limit: 500 })
  const hash = read.match(/SHA-256: ([a-f0-9]{64})/)?.[1]
  assert.ok(hash)
  const action = await editFileTool.prepare!({ path, expected_sha256: hash, old_text: 'subtotal > 100', new_text: 'subtotal >= 100' })
  assert.match(action.preview, /-.*subtotal > 100/)
  assert.match(action.preview, /\+.*subtotal >= 100/)
  assert.match(await action.execute(), /已编辑/)
  const result = await runCommand({ ...options, command: check })
  assert.match(result, /退出码: 0/)
  assert.match(result, /"passed": true/)
  assert.match(result, /"unexpected": \[\]/)
})

test('实际 shell 保留 stdout、stderr 与非零退出码', available, async () => {
  const result = await runCommand({ ...options, command: command('console.log("out");console.error("err");process.exit(7)') })
  assert.match(result, /退出码: 7/)
  assert.match(result, /stdout:\nout/)
  assert.match(result, /stderr:\nerr/)
})

test('输出超限中断并保留有界输出，不能报告正常完成', available, async () => {
  await assert.rejects(runCommand({ ...options, command: command('setInterval(()=>process.stdout.write("x".repeat(65536)),1)') }), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'CommandInterruptedError')
    assert.match(error.message, /缓冲上限/)
    assert.match(error.message, /stdout:/)
    assert.ok(error.message.length < 5000)
    return true
  })
})

test('命令启动失败有明确分类；预先取消不启动 shell', async () => {
  await assert.rejects(runCommand({ ...options, shell: `${process.execPath}.missing`, command: 'ignored' }), /启动失败/)
  await assert.rejects(runCommand({ ...options, command: 'ignored', signal: AbortSignal.abort() }), { name: 'AbortError' })
})

async function treeFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'mini-agent-command-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const script = join(dir, 'tree.cjs')
  const beat = join(dir, 'heartbeat')
  const ready = join(dir, 'ready.json')
  await writeFile(script, `
const fs = require('node:fs');
if (process.argv[2] === 'worker') {
  setInterval(() => fs.appendFileSync(process.argv[3], 'x'), 40);
} else {
  const child = require('node:child_process').spawn(process.execPath, [__filename, 'worker', process.argv[2]], { stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(process.argv[3], JSON.stringify({ parent: process.pid, child: child.pid }));
  console.log('TREE_STARTED');
  setInterval(() => {}, 1000);
}
`)
  return { dir, beat, ready, command: `${quote(process.execPath)} ${quote(script)} ${quote(beat)} ${quote(ready)}` }
}

async function waitFor(path: string) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return
    await delay(30)
  }
  throw new Error(`夹具没有启动: ${path}`)
}

for (const mode of ['timeout', 'cancel'] as const) {
  test(`实际 shell ${mode} 清理父进程及孙进程，心跳停止`, available, async t => {
    const f = await treeFixture(t)
    const controller = new AbortController()
    const running = runCommand({ ...options, command: f.command, timeoutMs: mode === 'timeout' ? 2500 : 10000, signal: controller.signal })
    // 立即挂接拒绝处理，避免等待夹具时产生未处理 rejection。
    const caught = running.then(() => { throw new Error('不应正常完成') }, error => error as Error)
    await waitFor(f.beat)
    if (mode === 'cancel') controller.abort()
    const error = await caught
    assert.equal(error.name, mode === 'cancel' ? 'AbortError' : 'CommandInterruptedError')
    assert.match(error.message, mode === 'cancel' ? /取消/ : /超时/)
    assert.match(error.message, /TREE_STARTED/)
    const pids = JSON.parse(await readFile(f.ready, 'utf8')) as { parent: number; child: number }
    const before = await readFile(f.beat, 'utf8')
    await delay(200)
    assert.equal(await readFile(f.beat, 'utf8'), before)
    for (const pid of [pids.parent, pids.child]) {
      // Linux 可能有等待 init 回收的 zombie；Windows 必须实际退出。
      try {
        process.kill(pid, 0)
        if (process.platform !== 'linux') assert.fail(`后代进程仍在运行: ${pid}`)
        assert.match(await readFile(`/proc/${pid}/stat`, 'utf8'), /\) Z /)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  })
}

test('主轮运行命令时取消，记录 uncertain 并阻止同批后续工具', available, async () => {
  const controller = new AbortController()
  const events: TurnEvent[] = []
  const batch = (async function* (): AsyncGenerator<ChatCompletionChunk> {
    yield { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'test', choices: [{
      index: 0, delta: { tool_calls: [
        { index: 0, id: 'shell', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: command('setInterval(()=>{},1000)') }) } },
        { index: 1, id: 'done', type: 'function', function: { name: 'finish_task', arguments: '{}' } },
      ] }, finish_reason: 'tool_calls',
    }] }
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await runTurn([{ role: 'user', content: 'run', startsTurn: true }], {
      registry: createToolRegistry([createBashTool({ shell, commandTimeoutMs: 5000 }), finishTaskTool]),
      contextBudget: testConfig.contextBudget, maxIterations: 1, signal: controller.signal,
      createStream: async () => batch, approve: async () => true, write: () => {}, log: () => {},
      checkpoint: async event => {
        events.push(event)
        if (event.type === 'action' && event.state === 'started') timer = setTimeout(() => controller.abort(), 300)
      },
    })
    assert.equal(result.status, 'cancelled')
    assert.ok(events.some(e => e.type === 'action' && e.call.id === 'shell' && e.state === 'uncertain' && e.observation?.includes('清理')))
    assert.ok(events.some(e => e.type === 'action' && e.call.id === 'done' && e.state === 'not_executed'))
  } finally { if (timer) clearTimeout(timer) }
})

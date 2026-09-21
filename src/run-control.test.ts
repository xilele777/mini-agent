import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import OpenAI from 'openai'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { RunControl, RunBudgetError, DEFAULT_RUN_LIMITS } from './run-control.js'
import { collectResponse } from './stream.js'
import { runTurn, type RunTurnOptions, type CreateTurnStream, type TurnEvent } from './turn.js'
import { createModelStream } from './llm.js'
import { createRuntime } from './runtime.js'
import { createToolRegistry } from './tools/registry.js'
import { createReadFileTool } from './tools/fs.js'
import { grepTool } from './tools/grep.js'
import type { Tool } from './tools/types.js'
import { createTrace, type RuntimeEvent } from './telemetry.js'
import { testConfig } from './test-runtime.js'
import { loadConfig, ConfigError } from './config.js'
import { createSession, openSession } from './session.js'
import { runSessionTurn } from './session-runner.js'

function chunk(names: string[] = [], text = 'ok', total?: number): ChatCompletionChunk {
  return { id: 'test', object: 'chat.completion.chunk', created: 0, model: 'test',
    ...(total === undefined ? {} : { usage: { prompt_tokens: total - 1, completion_tokens: 1, total_tokens: total } }),
    choices: [{ index: 0, finish_reason: names.length ? 'tool_calls' : 'stop', delta: names.length ? {
      tool_calls: names.map((name, index) => ({ index, id: `call-${index}`, type: 'function',
        function: { name, arguments: name === 'delegate_task' ? '{"task":"inspect"}' : '{}' } })),
    } : { content: text } }] }
}
async function* stream(...chunks: ChatCompletionChunk[]) { yield* chunks }
const request = { messages: [], tools: [], maxOutputTokens: 128 }
const busy = () => new OpenAI.APIError(503, { message: 'SECRET remote body' }, 'SECRET', new Headers())
const done: Tool = { name: 'done', description: 'done', schema: z.object({}), execute: () => 'done', endsTurn: 'completed' }
function options(createStream: CreateTurnStream, tools: Tool[] = [done]): RunTurnOptions {
  return { createStream, registry: createToolRegistry(tools), maxIterations: 6,
    contextBudget: testConfig.contextBudget, runLimits: { ...DEFAULT_RUN_LIMITS, retryBaseMs: 1 }, log: () => {}, write: () => {} }
}
const history = () => [{ role: 'user' as const, content: 'test', startsTurn: true as const }]

test('每次传输尝试独立扣总次数，503 有限重试并结算实际与未知 usage', async () => {
  const events: RuntimeEvent[] = []
  const control = new RunControl({ ...DEFAULT_RUN_LIMITS, retryBaseMs: 1 }, undefined, e => events.push(e))
  let calls = 0
  try {
    await collectResponse(await control.stream(async () => {
      if (++calls < 3) throw busy()
      return stream(chunk([], 'ok', 20))
    }, request), () => {})
    assert.equal(calls, 3)
    assert.equal(control.stats.requests, 3)
    assert.equal(control.stats.estimatedRequests, 2)
    assert.equal(control.stats.actualTokens, 20)
    assert.ok(control.stats.chargedTokens > 20)
    assert.equal(events.filter(e => e.type === 'retry').length, 2)
  } finally { control.dispose() }
})

test('主请求、摘要、委派共用一个账本，重试先耗尽总额度', async () => {
  const control = new RunControl({ ...DEFAULT_RUN_LIMITS, maxRequests: 3, retryBaseMs: 1 })
  let calls = 0
  try {
    for (const scope of ['main', 'summary'] as const) {
      await collectResponse(await control.stream(async () => { calls++; return stream(chunk()) }, { ...request, scope }), () => {})
    }
    await assert.rejects(async () => collectResponse(await control.stream(async () => {
      calls++; throw busy()
    }, { ...request, scope: 'subagent', taskId: randomUUID() }), () => {}), RunBudgetError)
    assert.equal(calls, 3)
  } finally { control.dispose() }
})

test('token 预留不足时零请求；usage 缺失不记零，实际超额阻止执行工具', async () => {
  let calls = 0
  let executed = 0
  const o = options(async () => { calls++; return stream(chunk(['done'], '', 300_000)) }, [
    { ...done, execute: () => { executed++; return 'done' } },
  ])
  o.runLimits = { ...DEFAULT_RUN_LIMITS, maxTokens: 1 }
  assert.equal((await runTurn(history(), o)).status, 'budget_exhausted')
  assert.equal(calls, 0)
  o.runLimits = DEFAULT_RUN_LIMITS
  assert.equal((await runTurn(history(), o)).status, 'budget_exhausted')
  assert.equal(calls, 1)
  assert.equal(executed, 0)
})

test('任意 chunk 后断流、正常 EOF 的协议错误、认证失败均不重试', async () => {
  for (const mode of ['partial', 'protocol', 'auth']) {
    let calls = 0
    const o = options(async () => {
      calls++
      if (mode === 'auth') throw new OpenAI.APIError(401, {}, 'SECRET', new Headers())
      return (async function* () {
        if (mode === 'partial') { yield chunk([], 'visible'); throw busy() }
        // 正常 EOF 没有 finish_reason 是 collectResponse 的协议错误。
      })()
    })
    assert.equal((await runTurn(history(), o)).status, 'failed')
    assert.equal(calls, 1)
  }
})

test('后续请求重试不重放此前已确认的工具动作', async () => {
  let calls = 0
  let executed = 0
  const o = options(async () => {
    calls++
    if (calls === 1) return stream(chunk(['side']))
    if (calls === 2) throw busy()
    return stream(chunk(['done']))
  }, [{ name: 'side', description: 'side', schema: z.object({}), execute: () => { executed++; return 'ok' } }, done])
  assert.equal((await runTurn(history(), o)).status, 'completed')
  assert.equal(executed, 1)
  assert.equal(calls, 3)
})

test('取消退避立即停止，不发送下一次请求', async () => {
  const parent = new AbortController()
  let calls = 0
  const control = new RunControl({ ...DEFAULT_RUN_LIMITS, retryBaseMs: 1000 }, parent.signal, e => {
    if (e.type === 'retry') parent.abort()
  })
  try {
    await assert.rejects(async () => collectResponse(await control.stream(async () => {
      calls++; throw busy()
    }, request), () => {}), { name: 'AbortError' })
    assert.equal(calls, 1)
  } finally { control.dispose() }
})

test('批准等待纳入总时限；迟到的允许也不能启动动作', async () => {
  for (const cooperative of [true, false]) {
    let executed = 0
    const events: TurnEvent[] = []
    const o = options(async () => stream(chunk(['write', 'done'])), [
      { ...done, name: 'write', needsApproval: true, execute: () => { executed++; return 'ok' } }, done,
    ])
    o.runLimits = { ...DEFAULT_RUN_LIMITS, timeoutMs: 35 }
    o.approve = async (_tool, _args, context) => {
      await delay(80, undefined, cooperative ? { signal: context?.signal } : {})
      return true
    }
    o.checkpoint = async e => { events.push(e) }
    assert.equal((await runTurn(history(), o)).status, 'budget_exhausted')
    assert.equal(executed, 0)
    assert.deepEqual(events.filter(e => e.type === 'action').map(e => e.state), ['not_executed', 'not_executed'])
  }
})

test('批准取消归 cancelled；started 检查点期间取消可正常保存 uncertain', async () => {
  for (const phase of ['approval', 'started']) {
    const parent = new AbortController()
    let executed = 0
    const events: TurnEvent[] = []
    const o = options(async () => stream(chunk(['write', 'done'])), [
      { ...done, name: 'write', needsApproval: true, execute: () => { executed++; return 'ok' } }, done,
    ])
    o.signal = parent.signal
    o.approve = async () => { if (phase === 'approval') parent.abort(); return true }
    o.checkpoint = async e => {
      events.push(e)
      if (phase === 'started' && e.type === 'action' && e.state === 'started') parent.abort()
    }
    assert.equal((await runTurn(history(), o)).status, 'cancelled')
    assert.equal(executed, 0)
    assert.ok(events.some(e => e.type === 'action' && e.state === (phase === 'started' ? 'uncertain' : 'not_executed')))
  }
})

test('runtime 委派与主轮共用次数和 taskId，子预算不足停止整个主轮', async () => {
  let calls = 0
  const events: RuntimeEvent[] = []
  const runtime = createRuntime({ ...testConfig, runLimits: { ...DEFAULT_RUN_LIMITS, maxRequests: 2 } }, async () => {
    calls++
    return stream(calls === 1 ? chunk(['delegate_task']) : chunk([], 'sub done'))
  })
  const result = await runTurn(history(), { ...runtime.turnOptions, log: () => {}, write: () => {}, onEvent: e => events.push(e) })
  assert.equal(result.status, 'budget_exhausted')
  assert.equal(calls, 2)
  const starts = events.filter(e => e.type === 'request_start')
  assert.deepEqual(starts.map(e => e.scope), ['main', 'subagent'])
  assert.ok(starts[1]?.taskId)
})

test('真实 SDK 的 503 重试只有一层，部分 SSE 后失败不重试', async () => {
  for (const partial of [false, true]) {
    let calls = 0
    const model = createModelStream(testConfig, async () => {
      calls++
      if (partial) return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk([], 'visible'))}\n\n`))
        setTimeout(() => controller.error(new Error('broken')), 10)
      } }), { headers: { 'content-type': 'text/event-stream' } })
      if (calls < 3) return new Response('{"error":{"message":"SECRET"}}', { status: 503, headers: { 'content-type': 'application/json' } })
      return new Response(`data: ${JSON.stringify(chunk(['done']))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    const result = await runTurn(history(), options(model))
    assert.equal(result.status, partial ? 'failed' : 'completed')
    assert.equal(calls, partial ? 1 : 3)
  }
})

test('主／子／摘要等待中的 SDK 请求均收到同一个取消信号', async () => {
  for (const scope of ['main', 'subagent', 'summary'] as const) {
    const parent = new AbortController()
    const control = new RunControl(DEFAULT_RUN_LIMITS, parent.signal)
    let aborted = false
    const model = createModelStream(testConfig, async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')) }, { once: true })
      setTimeout(() => parent.abort(), 10)
    }))
    try {
      await assert.rejects(async () => collectResponse(await control.stream(model, { ...request, scope }), () => {}), { name: 'AbortError' })
      assert.equal(aborted, true)
      assert.equal(control.stats.requests, 1)
    } finally { control.dispose() }
  }
})

test('总时限中止模型等待并归预算耗尽，单次请求超时仍为有限重试失败', async () => {
  for (const overall of [true, false]) {
    let calls = 0
    const model = createModelStream({ ...testConfig, requestTimeoutMs: overall ? 1000 : 20 }, async (_input, init) => {
      calls++
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
    })
    const o = options(model)
    o.runLimits = { ...DEFAULT_RUN_LIMITS, timeoutMs: overall ? 35 : 2000, retryBaseMs: 1 }
    assert.equal((await runTurn(history(), o)).status, overall ? 'budget_exhausted' : 'failed')
    assert.equal(calls, overall ? 1 : 3)
  }
})

test('预取消的文件读取和递归搜索不吞掉取消', async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(async () => createReadFileTool(1024).execute({ path: 'README.md', offset: 1, limit: 1 }, { signal }), { name: 'AbortError' })
  await assert.rejects(async () => grepTool.execute({ path: '.', pattern: 'test', maxResults: 1 }, { signal }), { name: 'AbortError' })
})

test('JSONL 白名单剔除任意正文，写失败仅警告一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-trace-'))
  try {
    const file = join(root, 'trace.jsonl')
    const trace = createTrace(file, randomUUID(), randomUUID(), () => assert.fail('unexpected warning'))
    trace.emit({ type: 'turn_start', secret: 'SECRET' } as RuntimeEvent)
    trace.emit({ type: 'retry', scope: 'main', taskId: null, attempt: 1, delayMs: 1, error: 'SECRET' } as RuntimeEvent)
    trace.close()
    const raw = await readFile(file, 'utf8')
    assert.ok(!raw.includes('SECRET'))
    assert.deepEqual(raw.trim().split('\n').map(line => JSON.parse(line).sequence), [1, 2])
    let warnings = 0
    const broken = createTrace(join(root, 'missing', 'trace.jsonl'), randomUUID(), randomUUID(), () => { warnings++ })
    broken.emit({ type: 'turn_start' }); broken.emit({ type: 'turn_start' }); broken.close()
    assert.equal(warnings, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('持久化轨迹按 sessionId/turnId 关联，每个新轮重置预算且恢复不重放', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-run-'))
  const session = await createSession(root)
  try {
    const o = options(async () => stream(chunk(['done'])))
    o.runLimits = { ...DEFAULT_RUN_LIMITS, maxRequests: 1 }
    for (let i = 0; i < 2; i++) assert.equal((await runSessionTurn(session, 'SECRET request', o)).status, 'completed')
    const rows = (await readFile(join(root, '.mini-agent', 'sessions', session.snapshot.id, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(!JSON.stringify(rows).includes('SECRET'))
    assert.deepEqual(rows.filter(e => e.type === 'turn_end').map(e => e.requests), [1, 1])
    assert.deepEqual([...new Set(rows.map(e => e.turnId))], session.snapshot.turns.map(t => t.id))
    await session.close()
    const reopened = await openSession(root, session.snapshot.id)
    try { assert.equal(reopened.snapshot.turns.at(-1)?.status, 'completed') } finally { await reopened.close() }
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})

test('实际会话摘要及其重试占用同一总预算，耗尽不回退继续请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-summary-run-'))
  const session = await createSession(root)
  try {
    await session.update(s => {
      s.messages.push({ role: 'system', content: 'system' })
      for (let i = 0; i < 3; i++) {
        s.turns.push({ id: randomUUID(), start: s.messages.length, status: 'completed', reason: '', actions: [] })
        s.messages.push({ role: 'user', content: 'x'.repeat(900), startsTurn: true }, { role: 'assistant', content: 'ok' })
      }
    })
    const events: RuntimeEvent[] = []
    let calls = 0
    const o = options(async () => { calls++; throw busy() }, [{ ...done, description: 'd'.repeat(2300) }])
    o.contextBudget = { contextWindow: 6000, outputReserve: 512, safetyMargin: 128 }
    o.runLimits = { ...DEFAULT_RUN_LIMITS, maxRequests: 2, retryBaseMs: 1 }
    o.onEvent = e => events.push(e)
    assert.equal((await runSessionTurn(session, 'continue', o)).status, 'budget_exhausted')
    assert.equal(calls, 2)
    assert.deepEqual(events.filter(e => e.type === 'request_start').map(e => e.scope), ['summary', 'summary'])
    assert.equal(session.snapshot.summary, null)
  } finally { await session.close(); await rm(root, { recursive: true, force: true }) }
})

test('真实 readline 的输入、批准、ask_user 等待可取消且释放进程', async () => {
  for (const mode of ['input', 'approval', 'ask_user']) {
    const code = `
      import { ask, closeUI } from './src/ui.ts';
      import { requestApproval } from './src/approval.ts';
      import { askUserTool, finishTaskTool } from './src/tools/control.ts';
      const c = new AbortController();
      setTimeout(() => c.abort(), 50);
      try {
        if ('${mode}' === 'input') await ask('WAIT>', c.signal);
        if ('${mode}' === 'approval') await requestApproval(finishTaskTool, {}, { signal: c.signal });
        if ('${mode}' === 'ask_user') await askUserTool.execute({ question: 'WAIT' }, { signal: c.signal });
        process.exitCode = 2;
      } catch(e) { console.log('RESULT:' + e.name); } finally { closeUI(); }
    `
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      let out = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error('readline cancellation timed out')) }, 5000)
      child.stdout.on('data', data => { out += data })
      child.stderr.on('data', data => { out += data })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(out)) })
    })
    assert.match(output, /RESULT:AbortError/)
  }
})

test('共享预算配置拒绝非法值，允许显式禁用重试', () => {
  const env = { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'https://example.test', OPENAI_MODEL: 'test' }
  for (const field of ['MINI_AGENT_MAX_REQUESTS', 'MINI_AGENT_MAX_TOTAL_TOKENS', 'MINI_AGENT_TURN_TIMEOUT_MS', 'MINI_AGENT_RETRY_BASE_MS']) {
    assert.throws(() => loadConfig({ ...env, [field]: '0' }, 'linux'), ConfigError)
  }
  assert.throws(() => loadConfig({ ...env, MINI_AGENT_MAX_RETRIES: '6' }, 'linux'), ConfigError)
  assert.equal(loadConfig({ ...env, MINI_AGENT_MAX_RETRIES: '0' }, 'linux').runLimits.maxRetries, 0)
})

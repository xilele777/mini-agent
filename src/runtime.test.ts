import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRuntime } from './runtime.js'
import { createModelStream } from './llm.js'
import { checkModel, checkShell } from './doctor.js'
import { testConfig } from './test-runtime.js'

function response(tool = true) {
  const chunk = {
    id: 'probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: tool
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-0',
                  type: 'function',
                  function: {
                    name: 'doctor_echo',
                    arguments: '{"value":"ok"}',
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: 'ok',
            },
        finish_reason: tool ? 'tool_calls' : 'stop',
      },
    ],
  }

  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

test('模型入口使用配置的 URL、模型，空工具集合不发送 tools', async () => {
  const createStream = createModelStream(testConfig, async (input, init) => {
    assert.equal(String(input), 'https://example.test/v1/chat/completions')

    const body = JSON.parse(String(init?.body))

    assert.equal(body.model, testConfig.model)
    assert.equal(body.stream, true)
    assert.equal(body.tools, undefined)

    return response(false)
  })

  const stream = await createStream({ messages: [], tools: [] })

  for await (const _ of stream) {
    // 完整消费，触发清理。
  }
})

test('在线探针验证流式工具调用，不执行本地工具', async () => {
  let requests = 0

  const result = await checkModel(testConfig, async () => {
    requests++
    return response()
  })

  assert.equal(result.ok, true)
  assert.equal(requests, 1)
})

test('认证错误不回显服务端返回的密钥', async () => {
  const result = await checkModel(
    testConfig,
    async () =>
      new Response(
        JSON.stringify({
          error: { message: testConfig.apiKey },
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }
      )
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /认证/)
  assert.ok(!JSON.stringify(result).includes(testConfig.apiKey))
})

test('503 不触发 SDK 隐式重试', async () => {
  let requests = 0

  const result = await checkModel(testConfig, async () => {
    requests++
    return new Response('unavailable', { status: 503 })
  })

  assert.equal(result.ok, false)
  assert.equal(requests, 1)
})

test('HTML 页面和普通文本不能冒充工具探针成功', async () => {
  for (const fetcher of [
    async () =>
      new Response('<html>home</html>', {
        headers: { 'content-type': 'text/html' },
      }),
    async () => response(false),
  ]) {
    assert.equal((await checkModel(testConfig, fetcher)).ok, false)
  }
})

test('收到响应头后流停滞仍会超时', async () => {
  const result = await checkModel(
    { ...testConfig, requestTimeoutMs: 30 },
    async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            const abort = () => controller.error(new DOMException('aborted', 'AbortError'))

            if (init?.signal?.aborted) {
              abort()
            } else {
              init?.signal?.addEventListener('abort', abort, { once: true })
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
  )

  assert.equal(result.ok, false)
  assert.match(result.message, /超时/)
})

test('配置的次数、读取上限和 shell 进入实际依赖', async () => {
  const config = {
    ...testConfig,
    maxIterations: 3,
    subagentMaxIterations: 2,
    maxReadBytes: 1,
  }

  const runtime = createRuntime(config)

  assert.equal(runtime.turnOptions.maxIterations, 3)
  assert.equal(runtime.subagentOptions.maxIterations, 2)

  for (const registry of [runtime.turnOptions.registry, runtime.subagentOptions.registry]) {
    const call = registry.prepareCall('read_file', '{"path":"src/config.ts"}')

    assert.ok(call.ok)

    assert.match(await call.tool.execute(call.args), /超过单次读取上限/)
  }

  const call = runtime.turnOptions.registry.prepareCall('run_bash', '{"command":"pwd"}')

  assert.ok(call.ok)
  assert.ok(call.tool.preview?.(call.args).includes(config.shell))
})

test('委派使用组装好的子 Agent 预算和模型入口', async () => {
  let requests = 0

  const runtime = createRuntime({ ...testConfig, subagentMaxIterations: 1 }, async (request) => {
    requests++
    assert.deepEqual(request.tools, [])

    return (async function* () {
      yield {
        id: 'sub',
        object: 'chat.completion.chunk' as const,
        created: 0,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: { content: '调查结果' },
            finish_reason: 'stop' as const,
          },
        ],
      }
    })()
  })

  const call = runtime.turnOptions.registry.prepareCall('delegate_task', '{"task":"调查入口"}')

  assert.ok(call.ok)
  assert.equal(await call.tool.execute(call.args), '调查结果')
  assert.equal(requests, 1)
})

test('不可用 shell 给出固定诊断，离线 CLI 不探测模型', async () => {
  const missing = `${process.execPath}.missing-shell`
  const result = await checkShell({
    ...testConfig,
    shell: missing,
  })

  assert.equal(result.ok, false)
  assert.ok(!result.message.includes(missing))

  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./doctor-cli.ts', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: `${missing}.env`,
        OPENAI_API_KEY: testConfig.apiKey,
        OPENAI_BASE_URL: testConfig.baseURL,
        OPENAI_MODEL: testConfig.model,
        MINI_AGENT_SHELL: missing,
      },
    }
  )

  assert.equal(child.status, 1)
  assert.match(child.stdout, /SKIP/)
  assert.ok(!(child.stdout + child.stderr).includes(testConfig.apiKey))
})

test('启动缺少模型名时报告字段，不进入 REPL 或泄露密钥', () => {
  const child = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('./agent.ts', import.meta.url))],
    {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: `${process.execPath}.missing-env`,
        OPENAI_API_KEY: testConfig.apiKey,
        OPENAI_BASE_URL: testConfig.baseURL,
        OPENAI_MODEL: '',
        MINI_AGENT_SHELL: process.execPath,
      },
    }
  )

  assert.equal(child.status, 1)
  assert.match(child.stderr, /OPENAI_MODEL/)
  assert.ok(!child.stdout.includes('已启动'))
  assert.ok(!(child.stdout + child.stderr).includes(testConfig.apiKey))
})

test('外部取消中止实际模型适配器的流，不误报为请求超时', async () => {
  const controller = new AbortController()
  const createStream = createModelStream(testConfig, async (_input, init) => {
    const body = new ReadableStream({
      start(stream) {
        const abort = () => stream.error(new DOMException('cancelled', 'AbortError'))
        init?.signal?.addEventListener('abort', abort, { once: true })
        if (init?.signal?.aborted) abort()
        setTimeout(() => controller.abort(), 20)
      },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  await assert.rejects(
    async () => {
      const stream = await createStream({ messages: [], tools: [], signal: controller.signal })
      for await (const _ of stream) {
        /* 消费至取消 */
      }
    },
    { name: 'AbortError' }
  )
})

test('统一 doctor 的在线探针接受取消，不转成普通诊断失败', async () => {
  const controller = new AbortController()
  const result = checkModel(
    testConfig,
    async (_input, init) => {
      return new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener(
              'abort',
              () => stream.error(new DOMException('cancelled', 'AbortError')),
              { once: true }
            )
            setTimeout(() => controller.abort(), 20)
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
    controller.signal
  )
  await assert.rejects(result, { name: 'AbortError' })
})

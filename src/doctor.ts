import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import OpenAI from 'openai'
import { loadConfig, type AppConfig } from './config.js'
import { createModelStream, ModelTimeoutError } from './llm.js'
import { collectResponse } from './stream.js'

const execFileAsync = promisify(execFile)

export interface CheckResult {
  ok: boolean
  message: string
}

/** 两个 CLI 入口共用诊断行为；仅显式调用时读取环境。 */
export async function runDoctor(online: boolean, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const config = loadConfig(process.env, process.platform)
  console.log('[OK] 配置格式通过；密钥和原始配置值不显示。')
  const report = (result: CheckResult) => {
    console.log(`[${result.ok ? 'OK' : 'FAIL'}] ${result.message}`)
    if (!result.ok) process.exitCode = 1
  }
  const shell = await checkShell(config, signal)
  signal?.throwIfAborted()
  report(shell)
  if (online) {
    console.log('[检查] 将发起一次模型流式请求，可能产生费用。')
    report(await checkModel(config, fetch, signal))
  } else {
    console.log('[SKIP] 尚未检查模型连接；使用 --online 运行在线探针。')
  }
}

/** 不输出错误对象或服务端响应正文。 */
export function describeAPIError(error: unknown): string {
  if (
    error instanceof ModelTimeoutError ||
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIUserAbortError
  ) {
    return '模型请求超时；检查网络、服务状态和请求超时配置。'
  }

  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) {
      return '认证或权限失败；检查 API key 和模型访问权限。'
    }

    if (error.status === 404) {
      return '接口或模型不存在；检查 base URL 的 API 前缀与模型名。'
    }

    if (error.status === 429) {
      return '服务限流或额度不足；检查服务端账户状态。'
    }

    if (error.status && error.status >= 500) {
      return '模型服务暂时异常；本次诊断没有自动重试。'
    }

    return '模型请求失败；检查网络、地址与服务支持的请求参数。'
  }

  return '流式协议或工具调用不兼容；检查 base URL 是否指向 API，及服务是否支持流式工具调用。'
}

export async function checkShell(
  config: AppConfig,
  signal?: AbortSignal
): Promise<CheckResult> {
  try {
    // Windows 使用 Git Bash，Linux 使用 sh/bash。
    const { stdout } = await execFileAsync(
      config.shell,
      ['-c', 'printf mini-agent-doctor-ok'],
      {
        timeout: Math.min(config.commandTimeoutMs, 5000),
        maxBuffer: 4096,
        windowsHide: true,
        ...(signal ? { signal } : {}),
      }
    )

    if (stdout !== 'mini-agent-doctor-ok') {
      throw new Error('unexpected output')
    }

    return {
      ok: true,
      message: 'shell 可以执行非交互命令。',
    }
  } catch {
    return {
      ok: false,
      message: 'shell 不可用；检查 MINI_AGENT_SHELL 是否指向可执行的 Git Bash 或 sh/bash。',
    }
  }
}

export async function checkModel(
  config: AppConfig,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<CheckResult> {
  try {
    const createStream = createModelStream(config, fetcher)

    const stream = await createStream({
      ...(signal ? { signal } : {}),
      messages: [{
        role: 'user',
        content: 'Call doctor_echo with value="ok".',
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'doctor_echo',
          description: 'Return a diagnostic marker. No action is executed.',
          parameters: {
            type: 'object',
            properties: {
              value: { type: 'string', enum: ['ok'] },
            },
            required: ['value'],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: {
        type: 'function',
        function: { name: 'doctor_echo' },
      },
    })

    const { message } = await collectResponse(
      stream,
      () => undefined
    )

    const call = message.tool_calls?.[0]

    if (
      message.tool_calls?.length !== 1 ||
      call?.type !== 'function' ||
      call.function.name !== 'doctor_echo'
    ) {
      throw new Error('invalid probe')
    }

    const args: unknown = JSON.parse(call.function.arguments)

    if (
      typeof args !== 'object' ||
      args === null ||
      !('value' in args) ||
      args.value !== 'ok' ||
      Object.keys(args).length !== 1
    ) {
      throw new Error('invalid arguments')
    }

    return {
      ok: true,
      message: '模型流式响应、工具调用和参数组装通过；没有执行工具。',
    }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      ok: false,
      message: describeAPIError(error),
    }
  }
}

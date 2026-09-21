import { posix, win32 } from 'node:path'
import { z } from 'zod'

// Note: 纯配置边界与启动诊断 — 见 .agents/notes/implemented/architecture/2026-09-21-validated-runtime-config.md

type Env = Readonly<Record<string, string | undefined>>

const nonempty = z.string().trim().min(1)
const positiveInt = z.coerce.number().int().positive()
const timeout = positiveInt.max(2_147_483_647)

const baseURL = nonempty.refine((value) => {
  try {
    const url = new URL(value)

    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username && !url.password && !url.search && !url.hash &&
      !/[\s?#]/.test(value)
    )
  } catch {
    return false
  }
}).transform((value) => new URL(value).href.replace(/\/+$/, ''))

export class ConfigError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`配置无效，请检查：${fields.join('、')}`)
    this.name = 'ConfigError'
  }
}

/** 只解析传入的数据；不读取环境、文件或网络。 */
export function loadConfig(env: Env, platform: NodeJS.Platform) {
  const paths = platform === 'win32' ? win32 : posix

  const shell = nonempty.refine((value) =>
    paths.isAbsolute(value) &&
    (platform !== 'win32' || paths.parse(value).root.length > 1) &&
    !/[\r\n\0]/.test(value)
  )

  const schema = z.object({
    OPENAI_API_KEY: nonempty.refine((value) => !/\s/.test(value)),
    OPENAI_BASE_URL: baseURL,
    OPENAI_MODEL: nonempty,

    MINI_AGENT_SHELL: platform === 'win32'
      ? shell
      : shell.default('/bin/sh'),

    MINI_AGENT_REQUEST_TIMEOUT_MS: timeout.default(120_000),
    MINI_AGENT_COMMAND_TIMEOUT_MS: timeout.default(30_000),
    MINI_AGENT_MAX_ITERATIONS: positiveInt.default(10),
    MINI_AGENT_SUBAGENT_MAX_ITERATIONS: positiveInt.default(6),

    MINI_AGENT_CONTEXT_WINDOW: positiveInt.default(32_768),
    MINI_AGENT_OUTPUT_RESERVE: positiveInt.default(4096),
    MINI_AGENT_CONTEXT_MARGIN: z.coerce.number()
      .int().nonnegative().default(1024),
    MINI_AGENT_OUTPUT_TOKEN_PARAM: z.enum([
      'max_completion_tokens',
      'max_tokens',
    ]).default('max_completion_tokens'),

    MINI_AGENT_MAX_READ_MB: z.coerce.number().positive()
      .max(Number.MAX_SAFE_INTEGER / 1024 / 1024).default(5),
  })

  const result = schema.safeParse(env)

  if (!result.success) {
    const fields = [...new Set(
      result.error.issues.map((issue) => String(issue.path[0]))
    )]

    // 不直接抛出 ZodError，也不把原始配置值写进错误消息。
    throw new ConfigError(fields)
  }

  const c = result.data

  if (
    c.MINI_AGENT_OUTPUT_RESERVE >= c.MINI_AGENT_CONTEXT_WINDOW ||
    c.MINI_AGENT_CONTEXT_MARGIN >=
      c.MINI_AGENT_CONTEXT_WINDOW - c.MINI_AGENT_OUTPUT_RESERVE
  ) {
    throw new ConfigError([
      'MINI_AGENT_CONTEXT_WINDOW',
      'MINI_AGENT_OUTPUT_RESERVE',
      'MINI_AGENT_CONTEXT_MARGIN',
    ])
  }

  return Object.freeze({
    apiKey: c.OPENAI_API_KEY,
    baseURL: c.OPENAI_BASE_URL,
    model: c.OPENAI_MODEL,
    shell: c.MINI_AGENT_SHELL,
    requestTimeoutMs: c.MINI_AGENT_REQUEST_TIMEOUT_MS,
    commandTimeoutMs: c.MINI_AGENT_COMMAND_TIMEOUT_MS,
    maxIterations: c.MINI_AGENT_MAX_ITERATIONS,
    subagentMaxIterations: c.MINI_AGENT_SUBAGENT_MAX_ITERATIONS,
    maxReadBytes: c.MINI_AGENT_MAX_READ_MB * 1024 * 1024,
    contextBudget: Object.freeze({
      contextWindow: c.MINI_AGENT_CONTEXT_WINDOW,
      outputReserve: c.MINI_AGENT_OUTPUT_RESERVE,
      safetyMargin: c.MINI_AGENT_CONTEXT_MARGIN,
    }),
    outputTokenParam: c.MINI_AGENT_OUTPUT_TOKEN_PARAM,
  })
}

export type AppConfig = ReturnType<typeof loadConfig>
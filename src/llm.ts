import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { AppConfig } from './config.js'
import { ContextBudgetError } from './context-budget.js'

export interface ModelRequest {
  signal?: AbortSignal
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionFunctionTool[]
  tool_choice?: ChatCompletionToolChoiceOption
  maxOutputTokens?: number
}

export class ModelTimeoutError extends Error {
  constructor() {
    super('模型请求超时')
    this.name = 'ModelTimeoutError'
  }
}

export function createModelStream(config: AppConfig, fetcher: typeof fetch = fetch) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    fetch: fetcher,
  })

  async function* stream(request: ModelRequest): AsyncGenerator<ChatCompletionChunk> {
    const outputLimit = request.maxOutputTokens ?? config.contextBudget.outputReserve

    if (
      !Number.isSafeInteger(outputLimit) ||
      outputLimit <= 0 ||
      outputLimit > config.contextBudget.outputReserve
    ) {
      throw new Error('生成上限必须是正整数，且不能超过配置的输出预留')
    }

    // 覆盖整个流的生命周期，不只等待响应头。
    const controller = new AbortController()
    request.signal?.throwIfAborted()
    const abort = () => controller.abort()
    request.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)

    try {
      const response = await client.chat.completions.create(
        {
          model: config.model,
          ...(config.outputTokenParam === 'max_tokens'
            ? { max_tokens: outputLimit }
            : { max_completion_tokens: outputLimit }),
          messages: request.messages,
          ...(request.tools.length > 0 ? { tools: request.tools } : {}),
          ...(request.tool_choice ? { tool_choice: request.tool_choice } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          signal: controller.signal,
        }
      )

      yield* response

      if (controller.signal.aborted) {
        throw new ModelTimeoutError()
      }
    } catch (error) {
      request.signal?.throwIfAborted()
      if (controller.signal.aborted) {
        throw new ModelTimeoutError()
      }

      if (
        error instanceof OpenAI.APIError &&
        (error.code === 'context_length_exceeded' || error.code === 'context_window_exceeded')
      ) {
        throw new ContextBudgetError('服务端拒绝了上下文长度；请降低窗口配置或缩小任务后再试。')
      }

      throw error
    } finally {
      request.signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
      controller.abort()
    }
  }

  return async (request: ModelRequest): Promise<AsyncIterable<ChatCompletionChunk>> =>
    stream(request)
}

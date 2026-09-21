import OpenAI from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
  ChatCompletionToolChoiceOption,
} from 'openai/resources/chat/completions'
import type { AppConfig } from './config.js'

export interface ModelRequest {
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionFunctionTool[]
  tool_choice?: ChatCompletionToolChoiceOption
}

export class ModelTimeoutError extends Error {
  constructor() {
    super('模型请求超时')
    this.name = 'ModelTimeoutError'
  }
}

export function createModelStream(
  config: AppConfig,
  fetcher: typeof fetch = fetch
) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    fetch: fetcher,
  })

  async function* stream(
    request: ModelRequest
  ): AsyncGenerator<ChatCompletionChunk> {
    // 覆盖整个流的生命周期，不只等待响应头。
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      config.requestTimeoutMs
    )

    try {
      const response = await client.chat.completions.create({
        model: config.model,
        messages: request.messages,
        ...(request.tools.length > 0
          ? { tools: request.tools }
          : {}),
        ...(request.tool_choice
          ? { tool_choice: request.tool_choice }
          : {}),
        stream: true,
        stream_options: { include_usage: true },
      }, {
        signal: controller.signal,
      })

      yield* response

      if (controller.signal.aborted) {
        throw new ModelTimeoutError()
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ModelTimeoutError()
      }
      throw error
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }

  return async (
    request: ModelRequest
  ): Promise<AsyncIterable<ChatCompletionChunk>> => stream(request)
}
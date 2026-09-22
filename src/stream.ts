import type {
  ChatCompletionChunk,
  ChatCompletionMessage,
  ChatCompletionMessageFunctionToolCall,
} from 'openai/resources/chat/completions'
import type { CompletionUsage } from 'openai/resources/completions'

// Note: 流式响应先完整组装再进入工具执行 — 见 .agents/notes/implemented/feature/2026-09-13-streamed-model-response.md

interface PendingFunctionCall {
  id: string
  type: 'function' | null
  name: string
  arguments: string
}

export interface CollectedResponse {
  message: ChatCompletionMessage
  usage?: CompletionUsage
}

/**
 * 消费一次完整模型流。
 *
 * 文本到达时立即交给 onText 显示；
 * 工具调用只负责组装，不执行、不校验业务参数、不写入历史。
 */
export async function collectResponse(
  stream: AsyncIterable<ChatCompletionChunk>,
  onText: (text: string) => void
): Promise<CollectedResponse> {
  let content = ''
  let refusal = ''
  let finishReason: ChatCompletionChunk.Choice['finish_reason'] = null
  let usage: CompletionUsage | undefined

  // Map 必须属于本次函数调用，防止不同模型请求互相污染。
  const callsByIndex = new Map<number, PendingFunctionCall>()

  for await (const chunk of stream) {
    // usage-only 尾部片段的 choices 可能为空。
    if (chunk.usage) {
      usage = chunk.usage
    }

    for (const choice of chunk.choices) {
      if (choice.index !== 0) {
        throw new Error(`暂不支持 choice index ${choice.index}`)
      }

      if (choice.delta.role !== undefined && choice.delta.role !== 'assistant') {
        throw new Error(`流中出现了非 assistant 角色: ${choice.delta.role}`)
      }

      if (choice.delta.function_call !== undefined) {
        throw new Error('暂不支持旧版 function_call 协议')
      }

      if (choice.finish_reason !== null) {
        if (finishReason !== null) {
          throw new Error('模型重复返回结束原因')
        }

        finishReason = choice.finish_reason
      }

      const text = choice.delta.content ?? ''
      if (text) {
        content += text
        onText(text)
      }

      const refusalText = choice.delta.refusal ?? ''
      if (refusalText) {
        refusal += refusalText
        onText(refusalText)
      }

      for (const part of choice.delta.tool_calls ?? []) {
        if (!Number.isInteger(part.index) || part.index < 0) {
          throw new Error(`工具调用编号无效: ${part.index}`)
        }

        if (part.type && part.type !== 'function') {
          throw new Error(`不支持的工具调用类型: ${part.type}`)
        }

        if (part.custom !== undefined) {
          throw new Error('暂不支持 custom 工具调用')
        }

        const current = callsByIndex.get(part.index) ?? {
          id: '',
          type: null,
          name: '',
          arguments: '',
        }

        current.id += part.id ?? ''

        if (part.type === 'function') {
          current.type = 'function'
        }

        current.name += part.function?.name ?? ''
        current.arguments += part.function?.arguments ?? ''

        callsByIndex.set(part.index, current)
      }
    }
  }

  if (finishReason === null) {
    throw new Error('流式响应缺少结束原因')
  }

  const entries = [...callsByIndex.entries()].sort(([left], [right]) => left - right)

  const toolCalls: ChatCompletionMessageFunctionToolCall[] = []
  const seenIds = new Set<string>()

  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position]
    if (!entry) {
      throw new Error('工具调用组装失败')
    }

    const [index, call] = entry

    if (index !== position) {
      throw new Error(`工具调用编号必须从 0 连续递增，收到 ${index}`)
    }

    if (!call.id || !call.name || call.type !== 'function') {
      throw new Error(`工具调用 ${index} 缺少 id、type 或 name`)
    }

    if (seenIds.has(call.id)) {
      throw new Error(`工具调用 id 重复: ${call.id}`)
    }

    seenIds.add(call.id)

    toolCalls.push({
      id: call.id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    })
  }

  if (toolCalls.length > 0 && finishReason !== 'tool_calls') {
    throw new Error(`工具调用未正常结束: ${finishReason}`)
  }

  if (toolCalls.length === 0 && finishReason !== 'stop') {
    throw new Error(`文本响应未正常结束: ${finishReason}`)
  }

  const message: ChatCompletionMessage = {
    role: 'assistant',
    content: content || null,
    refusal: refusal || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }

  return {
    message,
    ...(usage ? { usage } : {}),
  }
}

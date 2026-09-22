import { Buffer } from 'node:buffer'
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { toModelMessages, truncateToolResult, type HistoryMessage } from './context.js'

// Note: 请求视图的预算与整轮裁剪 — 见 .agents/notes/implemented/architecture/2026-09-05-bounded-conversation-context.md

export interface ContextBudget {
  contextWindow: number
  outputReserve: number
  safetyMargin: number
}

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContextBudgetError'
  }
}

export type ContextPlan = {
  estimatedInputTokens: number
  inputLimit: number
  droppedTurns: number
} & ({ ok: true; messages: ChatCompletionMessageParam[] } | { ok: false; reason: string })

/** 文本 CLI 的保守估算；不是服务端 tokenizer 的精确结果。 */
export function estimateInputTokens(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionFunctionTool[]
): number {
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      throw new Error('当前预算估算只支持文本消息')
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify({ messages, tools }), 'utf8')

  // 用 UTF-8 字节数粗估，并给消息包装和工具包装留出余量。
  return bytes + messages.length * 16 + tools.length * 16 + 64
}

/**
 * 输入为配对完整的本地历史，system/developer 只允许出现在首轮之前。
 * 最后一个 startsTurn 及其后续消息视为当前轮，永远不删除。
 */
export function buildContext(
  history: HistoryMessage[],
  tools: ChatCompletionFunctionTool[],
  budget: ContextBudget
): ContextPlan {
  const { contextWindow, outputReserve, safetyMargin } = budget

  if (
    !Number.isSafeInteger(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isSafeInteger(outputReserve) ||
    outputReserve <= 0 ||
    !Number.isSafeInteger(safetyMargin) ||
    safetyMargin < 0 ||
    outputReserve >= contextWindow ||
    safetyMargin >= contextWindow - outputReserve
  ) {
    throw new Error('上下文预算无效：窗口必须大于输出预留与安全余量之和')
  }

  const inputLimit = contextWindow - outputReserve - safetyMargin
  const starts: number[] = []

  for (let i = 0; i < history.length; i++) {
    const message = history[i]
    if (!message) continue

    if (message.startsTurn) {
      if (message.role !== 'user') {
        throw new Error('startsTurn 只能标记真实用户输入')
      }
      starts.push(i)
    }

    if (starts.length > 0 && (message.role === 'system' || message.role === 'developer')) {
      throw new Error('system/developer 必须位于首个用户轮之前')
    }
  }

  const projected = structuredClone(toModelMessages(history)).map((message) =>
    message.role === 'tool' && typeof message.content === 'string'
      ? { ...message, content: truncateToolResult(message.content) }
      : message
  )

  // 无 startsTurn 时无法安全识别旧轮，因此整份历史都受保护。
  const prefixEnd = starts[0] ?? projected.length
  const prefix = projected.slice(0, prefixEnd)
  const maxDrop = Math.max(0, starts.length - 1)

  for (let droppedTurns = 0; droppedTurns <= maxDrop; droppedTurns++) {
    const keepFrom = starts[droppedTurns] ?? projected.length
    const messages = [...prefix, ...projected.slice(keepFrom)]
    const estimatedInputTokens = estimateInputTokens(messages, tools)
    const stats = { estimatedInputTokens, inputLimit, droppedTurns }

    if (estimatedInputTokens <= inputLimit) {
      return { ok: true, messages, ...stats }
    }

    if (droppedTurns === maxDrop) {
      return {
        ok: false,
        ...stats,
        reason:
          `上下文估算 ${estimatedInputTokens} 超过输入预算 ${inputLimit}；` +
          '已无法继续删除完整旧轮，请缩小输入、任务范围或工具集合。',
      }
    }
  }

  throw new Error('不可达的上下文规划分支')
}

import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { collectResponse } from './stream.js'
import {
  detectRepeatedCall,
  truncateToolResult,
} from './context.js'
import type {
  HistoryMessage,
  ToolCallLog,
} from './context.js'
import {
  buildContext,
  ContextBudgetError,
  type ContextBudget,
} from './context-budget.js'
import {
  executeCall,
  type ToolRegistry,
} from './tools/registry.js'

// Note: 同步只读子 Agent 的上下文与能力边界 — 见 .agents/notes/implemented/feature/2026-09-19-isolated-readonly-subagent.md

const REPEAT_THRESHOLD = 3

const SUBAGENT_SYSTEM_PROMPT = [
  '你是主 Agent 委派的只读子 Agent。',
  '只处理收到的独立子任务，不假设自己知道主对话历史。',
  '使用可用工具调查项目内容、计算或查询时间。',
  '你没有写文件、执行 shell、维护 todo、询问用户或委派其他 Agent 的能力。',
  '需要副作用操作或更多用户信息时，只在结果中说明建议和缺口，不要声称已经执行。',
  '调查完成后直接输出给主 Agent 的简洁结果；纯文本回复会结束本次委派。',
].join('\n')

const FINAL_NUDGE = [
  '子 Agent 的工具调用预算已经用完。',
  '请根据目前已有的工具结果直接返回结论。',
  '如果证据不足，明确说明已经确认的内容和仍缺少的信息。',
  '不要再请求任何工具。',
].join('\n')


export interface SubAgentRequest {
  signal?: AbortSignal
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionFunctionTool[]
  maxOutputTokens: number
}

export type CreateSubAgentStream = (
  request: SubAgentRequest
) => Promise<AsyncIterable<ChatCompletionChunk>>

export interface RunSubAgentOptions {
  signal?: AbortSignal
  createStream: CreateSubAgentStream
  registry: ToolRegistry
  maxIterations: number
  onProgress?: (message: string) => void
  contextBudget: ContextBudget
}

function getFinalText(
  message: ChatCompletionMessage
): string | null {
  const content = message.content?.trim() ?? ''
  const refusal = message.refusal?.trim() ?? ''

  if (content && refusal) {
    return `${content}\n\n[拒绝说明] ${refusal}`
  }

  if (content) return content
  if (refusal) return `[子 Agent 拒绝] ${refusal}`

  return null
}

export async function runSubAgent(
  task: string,
  options: RunSubAgentOptions
): Promise<string> {
  const normalizedTask = task.trim()

  if (!normalizedTask) {
    throw new Error('子 Agent 任务不能为空')
  }

  const maxIterations =
    options.maxIterations

  if (
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0
  ) {
    throw new Error('子 Agent 请求上限必须是正整数')
  }

  const createStream: CreateSubAgentStream = request => {
    options.signal?.throwIfAborted()
    return options.createStream({ ...request, ...(options.signal ? { signal: options.signal } : {}) })
  }

  const report =
    options.onProgress ?? (() => undefined)

  const messages: HistoryMessage[] = [
    {
      role: 'system',
      content: SUBAGENT_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: normalizedTask,
      startsTurn: true,
    },
  ]

  const recentCalls: ToolCallLog[] = []

  for (
    let iteration = 0;
    iteration < maxIterations;
    iteration++
  ) {
    const requestNumber = iteration + 1
    const isFinalRequest =
      requestNumber === maxIterations

    /*
     * 最后一次请求不再开放工具。
     * 它专门用于把之前的工具结果整理成最终文本。
     */
    if (isFinalRequest) {
      messages.push({
        role: 'user',
        content: FINAL_NUDGE,
      })
    }

    report(
      `请求 ${requestNumber}/${maxIterations}` +
      (isFinalRequest ? '（最终总结）' : '')
    )

    const tools = isFinalRequest
      ? []
      : options.registry.getToolSchemas()

    const plan = buildContext(
      messages,
      tools,
      options.contextBudget
    )

    report(
      `ctx estimated=${plan.estimatedInputTokens}/${plan.inputLimit}`
    )

    if (!plan.ok) {
      return `[子 Agent 上下文预算耗尽] ${plan.reason}`
    }

    let response: Awaited<ReturnType<typeof collectResponse>>

    try {
      const stream = await createStream({
        messages: plan.messages,
        tools,
        maxOutputTokens: options.contextBudget.outputReserve,
      })

      response = await collectResponse(
        stream,
        () => undefined
      )
    } catch (error) {
      if (error instanceof ContextBudgetError) {
        return `[子 Agent 上下文预算耗尽] ${error.message}`
      }
      throw error
    }

    const { message, usage } = response

    if (usage) {
      report(
        `ctx prompt=${usage.prompt_tokens}` +
        ` completion=${usage.completion_tokens}` +
        ` total=${usage.total_tokens}`
      )
    }

    messages.push(message)

    const toolCalls = message.tool_calls ?? []

    if (toolCalls.length === 0) {
      const result = getFinalText(message)

      if (!result) {
        throw new Error('子 Agent 返回了空文本结果')
      }

      return result
    }

    /*
     * 最终请求没有向模型提供工具。
     * 如果兼容服务仍返回工具调用，视为协议异常，不执行。
     */
    if (isFinalRequest) {
      throw new Error(
        '子 Agent 在最终总结请求中仍返回了工具调用'
      )
    }

    for (const call of toolCalls) {
      options.signal?.throwIfAborted()
      let observation: string
      let toolName: string

      if (call.type !== 'function') {
        toolName = call.type
        observation =
          `错误:子 Agent 不支持工具调用类型 "${call.type}"。`
      } else {
        toolName = call.function.name

        recentCalls.push({
          name: call.function.name,
          argsKey: call.function.arguments,
        })

        const guard = detectRepeatedCall(
          recentCalls,
          REPEAT_THRESHOLD
        )

        if (guard) {
          observation =
            `${guard}\n` +
            '你是子 Agent，请把当前进展和缺口返回主 Agent。'
        } else {
          const prepared =
            options.registry.prepareCall(
              call.function.name,
              call.function.arguments
            )

          if (!prepared.ok) {
            observation = prepared.error
          } else if (prepared.tool.needsApproval) {
            observation =
              `错误:子 Agent 不能执行需要人工批准的工具 ` +
              `"${prepared.tool.name}"。`
          } else {
            observation = await executeCall(
              prepared.tool,
              prepared.args
            )
          }
        }
      }

      const firstLine =
        truncateToolResult(observation).split('\n')[0] ?? ''
      const more =
        observation.includes('\n') ? ' …' : ''

      report(
        `→ ${toolName} ⇒ ${firstLine}${more}`
      )

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: observation,
      })
    }
  }

  // 最后一次请求正常情况下必定返回文本或提前抛出协议错误。
  throw new Error(
    `子 Agent 连续 ${maxIterations} 次请求仍未返回最终文本`
  )
}

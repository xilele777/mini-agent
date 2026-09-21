import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { requestApproval } from './approval.js'
import {
  detectRepeatedCall,
  truncateToolResult,
} from './context.js'
import type {
  HistoryMessage,
  ToolCallLog,
} from './context.js'
import { collectResponse } from './stream.js'
import type { ToolRegistry } from './tools/registry.js'
import { ToolPreparationError } from './tools/types.js'
import {
  buildContext,
  ContextBudgetError,
  type ContextBudget,
  type ContextPlan,
} from './context-budget.js'

// Note: 主轮与 REPL 分离，以模拟流测试生命周期控制 — 见 .agents/notes/implemented/architecture/2026-09-20-testable-turn-runner.md


/** 连续相同调用达到此次数时触发循环守卫。 */
const REPEAT_THRESHOLD = 3

/** 本轮累计触发循环守卫的次数上限。 */
const MAX_LOOP_HITS = 2

export const SYSTEM_PROMPT = [
  '你是一个运行在用户本机命令行里的助手,可以读写文件、执行 shell 命令。',
  `当前操作系统:${process.platform}`,
  `当前工作目录:${process.cwd()}`,
  '涉及文件写入和命令执行的操作会先交给用户确认,用户有可能拒绝。',
  '本轮以用户当前请求为目标；任务清单保存计划，不代表所有条目都应在本轮执行。',
  '此前暂停或被拒绝的任务，只有用户明确要求恢复时才继续。',
].join('\n')

const CONTINUE_NUDGE = [
  '请根据用户当前的要求决定下一步。',
  '有可以继续执行的步骤时，调用相应工具。',
  '本次工作已完成时，调用 finish_task。',
  '缺少必要信息时，调用 ask_user。',
  '必要操作被拒绝，或用户取消、要求暂停时，调用 pause_task。',
  '不要反复索要同一项许可，也不要擅自恢复此前被拒绝的旧任务。',
].join('\n')

const REJECTED =
  '用户拒绝了这次操作。不要重试，也不要换一种方式绕过。' +
  '如果因此无法继续当前任务，调用 pause_task 说明原因，等待用户新指令。'

export interface TurnRequest {
  signal?: AbortSignal
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionFunctionTool[]
  maxOutputTokens: number
}

/**
 * 创建一次流式模型响应。
 *
 * 生产环境使用真实 API，测试环境注入模拟流。
 */
export type CreateTurnStream = (
  request: TurnRequest
) => Promise<AsyncIterable<ChatCompletionChunk>>

export type PrepareContext = (
  history: HistoryMessage[],
  tools: ChatCompletionFunctionTool[],
  requests: { createStream: CreateTurnStream; remaining: number }
) => Promise<ContextPlan>

export type TurnStatus =
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'failed'
  | 'budget_exhausted'

export interface TurnResult {
  status: TurnStatus
  reason: string
}

type FunctionCall =
  import('openai/resources/chat/completions').ChatCompletionMessageFunctionToolCall

export type TurnEvent =
  | { type: 'messages' }
  | {
      type: 'action'
      messageIndex: number
      call: FunctionCall
      state: 'started' | 'returned' | 'not_executed' | 'uncertain'
      observation?: string
    }
  | { type: 'turn_end'; result: TurnResult }

export interface RunTurnOptions {
  signal?: AbortSignal
  createStream: CreateTurnStream
  registry: ToolRegistry
  maxIterations: number
  write?: (text: string) => void
  log?: (message: string) => void
  approve?: typeof requestApproval
  checkpoint?: (
    event: TurnEvent,
    messages: HistoryMessage[]
  ) => Promise<void>
  contextBudget: ContextBudget
  prepareContext?: PrepareContext
}

/** 保存失败必须终止，不能当成普通工具错误让模型继续。 */
export class CheckpointError extends Error {
  constructor(cause: unknown) {
    super('保存检查点失败，已停止；请核查最后可靠保存的状态', {
      cause,
    })
    this.name = 'CheckpointError'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'AbortError' ||
    ('code' in error && error.code === 'ABORT_ERR')
  )
}

type PendingCall = {
  messageIndex: number
  call: FunctionCall
}

export async function runTurn(
  messages: HistoryMessage[],
  options: RunTurnOptions
): Promise<TurnResult> {
  if (
    !Number.isInteger(options.maxIterations) ||
    options.maxIterations <= 0
  ) {
    throw new Error('主 Agent 请求上限必须是正整数')
  }

  const write = options.write ?? ((text: string) => {
    process.stdout.write(text)
  })
  const log = options.log ?? ((text: string) => {
    console.log(text)
  })
  const approve = options.approve ?? requestApproval

  const recentCalls: ToolCallLog[] = []
  let loopHits = 0
  let pending: PendingCall[] = []
  let active: PendingCall | undefined
  let requestCount = 0

  const createStream: CreateTurnStream = async (request) => {
    options.signal?.throwIfAborted()
    if (requestCount >= options.maxIterations) {
      throw new ContextBudgetError('主轮与摘要的模型请求次数预算已耗尽')
    }
    // 在真正开始请求前扣次数；传输失败也消耗本次额度。
    requestCount++
    return options.createStream({ ...request, ...(options.signal ? { signal: options.signal } : {}) })
  }

  async function emit(event: TurnEvent): Promise<void> {
    if (!options.checkpoint) return

    try {
      await options.checkpoint(
        structuredClone(event),
        structuredClone(messages)
      )
    } catch (error) {
      throw new CheckpointError(error)
    }
  }

  async function finish(
    status: TurnStatus,
    reason: string
  ): Promise<TurnResult> {
    const result = { status, reason }
    await emit({ type: 'turn_end', result })
    return result
  }

  async function record(
    item: PendingCall,
    state: 'returned' | 'not_executed' | 'uncertain',
    observation: string
  ): Promise<void> {
    messages.push({
      role: 'tool',
      tool_call_id: item.call.id,
      content: observation,
    })

    await emit({
      type: 'action',
      ...item,
      state,
      observation,
    })

    pending.shift()
    active = undefined
  }

  async function skipRemaining(reason: string): Promise<void> {
    while (pending[0]) {
      await record(pending[0], 'not_executed', reason)
    }
  }

  try {
    await emit({ type: 'messages' })

    while (requestCount < options.maxIterations) {
      options.signal?.throwIfAborted()
      const tools = options.registry.getToolSchemas()
      const plan = options.prepareContext
        ? await options.prepareContext(messages, tools, {
            createStream,
            remaining: options.maxIterations - requestCount,
          })
        : buildContext(messages, tools, options.contextBudget)

      log(
        `  [ctx] estimated=${plan.estimatedInputTokens}/${plan.inputLimit}` +
        ` droppedTurns=${plan.droppedTurns}`
      )

      if (!plan.ok) {
        return await finish('budget_exhausted', plan.reason)
      }

      const stream = await createStream({
        messages: plan.messages,
        tools,
        maxOutputTokens: options.contextBudget.outputReserve,
      })

      let wroteText = false

      const response = await (async () => {
        try {
          return await collectResponse(stream, (text) => {
            if (!wroteText) {
              write('\nAgent: ')
              wroteText = true
            }
            write(text)
          })
        } finally {
          if (wroteText) write('\n')
        }
      })()

      const { message, usage } = response

      if (usage) {
        log(
          `  [ctx] 本轮 prompt=${usage.prompt_tokens}` +
          ` completion=${usage.completion_tokens}` +
          ` total=${usage.total_tokens}`
        )
      }

      const messageIndex = messages.length
      messages.push(message)

      pending = (message.tool_calls ?? []).map((call) => {
        if (call.type !== 'function') {
          throw new Error('不支持的工具调用类型')
        }
        return { messageIndex, call }
      })

      await emit({ type: 'messages' })

      if (pending.length === 0) {
        if (!wroteText) log('\nAgent: (空回复)')

        messages.push({
          role: 'user',
          content: CONTINUE_NUDGE,
        })
        await emit({ type: 'messages' })
        continue
      }

      while (pending[0]) {
        options.signal?.throwIfAborted()
        const item = pending[0]
        const { call } = item

        recentCalls.push({
          name: call.function.name,
          argsKey: call.function.arguments,
        })

        const guard = detectRepeatedCall(
          recentCalls,
          REPEAT_THRESHOLD
        )

        if (guard) {
          loopHits++
          log(
            `  ⚠ ${call.function.name} 触发循环守卫` +
            `(${loopHits}/${MAX_LOOP_HITS})`
          )

          await record(item, 'not_executed', guard)

          if (loopHits >= MAX_LOOP_HITS) {
            await skipRemaining(
              '[本轮因循环守卫中止，未执行]。等待用户新指令。'
            )

            const reason =
              `循环守卫已触发 ${MAX_LOOP_HITS} 次仍不收敛，本轮放弃。`

            log(`\n[中止] ${reason}`)
            return await finish('failed', reason)
          }

          continue
        }

        const prepared = options.registry.prepareCall(
          call.function.name,
          call.function.arguments
        )

        if (!prepared.ok) {
          await record(item, 'not_executed', prepared.error)
          continue
        }

        const { tool, args } = prepared
        let action
        try {
          action = await tool.prepare?.(args)
        } catch (error) {
          if (!(error instanceof ToolPreparationError)) throw error
          await record(item, 'not_executed', error.message)
          continue
        }

        if (
          tool.needsApproval &&
          !await approve(tool, args, { ...(options.signal ? { signal: options.signal } : {}), ...(action ? { action } : {}) })
        ) {
          await record(item, 'not_executed', REJECTED)
          continue
        }

        options.signal?.throwIfAborted()

        // 保存成功后才能调用工具。
        // 所有工具统一记录，包含只读工具与 todo。
        await emit({
          type: 'action',
          ...item,
          state: 'started',
        })

        options.signal?.throwIfAborted()
        active = item
        const context = options.signal ? { signal: options.signal } : {}
        const observation = await (action ? action.execute(context) : tool.execute(args, context))

        await record(item, 'returned', observation)
        options.signal?.throwIfAborted()

        log(
          `  → ${tool.name} ⇒ ` +
          (truncateToolResult(observation).split('\n')[0] ?? '')
        )

        if (tool.endsTurn) {
          await skipRemaining(
            '本轮已结束，此工具调用未执行。等待用户新指令。'
          )
          return await finish(tool.endsTurn, observation)
        }
      }
    }

    const reason =
      `连续 ${options.maxIterations} 轮仍未得出结论，本轮放弃。`

    log(`\n[中止] ${reason}`)
    return await finish('budget_exhausted', reason)
  } catch (error) {
    // 保存失败后立即上抛，不再执行动作或追加收尾记录。
    if (error instanceof CheckpointError) throw error

    const cancelled = isAbortError(error)
    const reason = cancelled
      ? '本轮已取消。'
      : error instanceof ContextBudgetError
        ? error.message
        : `本轮失败：${String(error)}`

    if (active) {
      const detail = error instanceof Error ? error.message : String(error)
      log(detail)
      await record(
        active,
        'uncertain',
        '工具调用已经开始，但未取得正常返回；' +
        '结果不确定，请先核查外部状态，不要直接重试。\n' + detail
      )
    }

    await skipRemaining(
      '本轮已中止，此工具调用未执行。等待用户新指令。'
    )

    return await finish(
      cancelled
        ? 'cancelled'
        : error instanceof ContextBudgetError
          ? 'budget_exhausted'
          : 'failed',
      reason
    )
  }
}

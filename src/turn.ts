import type {
  ChatCompletionChunk,
  ChatCompletionFunctionTool,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import { requestApproval } from './approval.js'
import {
  detectRepeatedCall,
  toModelMessages,
  truncateToolResult,
} from './context.js'
import type {
  HistoryMessage,
  ToolCallLog,
} from './context.js'
import { collectResponse } from './stream.js'
import {
  executeCall,
  type ToolRegistry,
} from './tools/registry.js'

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

/**
 * runTurn 发起一次模型请求时需要的数据。
 *
 * 测试可以检查每次请求实际收到的历史和工具集合。
 */
export interface TurnRequest {
  messages: ChatCompletionMessageParam[]
  tools: ChatCompletionFunctionTool[]
}

/**
 * 创建一次流式模型响应。
 *
 * 生产环境使用真实 API，测试环境注入模拟流。
 */
export type CreateTurnStream = (
  request: TurnRequest
) => Promise<AsyncIterable<ChatCompletionChunk>>

export interface RunTurnOptions {
  createStream: CreateTurnStream
  registry: ToolRegistry
  maxIterations: number
  write?: (text: string) => void
  log?: (message: string) => void
}


/**
 * 校验 → 按需批准 → 执行。
 *
 * 参数错误和批准拒绝不会直接结束本轮。
 */
async function handleCall(
  name: string,
  rawArgs: string,
  log: (message: string) => void,
  registry: ToolRegistry
): Promise<{
  observation: string
  endsTurn: boolean
}> {
  const prepared = registry.prepareCall(name, rawArgs)

  if (!prepared.ok) {
    log(`  ✗ ${name} 参数有误`)

    return {
      observation: prepared.error,
      endsTurn: false,
    }
  }

  const { tool, args } = prepared

  if (tool.needsApproval) {
    const approved = await requestApproval(tool, args)

    if (!approved) {
      log(`  ✗ ${tool.name} 被拒绝`)

      return {
        observation: REJECTED,
        endsTurn: false,
      }
    }
  }

  const observation = await executeCall(tool, args)
  const bounded = truncateToolResult(observation)

  const firstLine = bounded.split('\n')[0] ?? ''
  const more = bounded.includes('\n') ? ' …' : ''

  log(`  → ${tool.name} ⇒ ${firstLine}${more}`)

  return {
    observation: bounded,
    endsTurn: tool.endsTurn === true,
  }
}

/**
 * 处理一次真实用户输入。
 *
 * 该函数直接修改传入的 messages：
 * - 写入模型回复；
 * - 写入工具结果；
 * - 写入内部继续提示。
 *
 * 完成、暂停、循环守卫或请求预算均可结束本轮。
 * 异常继续交给 agent.ts 回滚本轮历史。
 */
export async function runTurn(
  messages: HistoryMessage[],
  options: RunTurnOptions
): Promise<void> {
  const maxIterations =
    options.maxIterations

  if (
    !Number.isInteger(maxIterations) ||
    maxIterations <= 0
  ) {
    throw new Error('主 Agent 请求上限必须是正整数')
  }

  const createStream =
    options.createStream

  const write =
    options.write ??
    ((text: string) => {
      process.stdout.write(text)
    })

  const log =
    options.log ??
    ((message: string) => {
      console.log(message)
    })

  const recentCalls: ToolCallLog[] = []
  let loopHits = 0

  for (
    let iteration = 0;
    iteration < maxIterations;
    iteration++
  ) {
    const stream = await createStream({
      messages: toModelMessages(messages),
      tools: options.registry.getToolSchemas(),
    })

    let wroteText = false

    const { message, usage } = await (async () => {
      try {
        return await collectResponse(
          stream,
          (text) => {
            if (!wroteText) {
              write('\nAgent: ')
              wroteText = true
            }

            write(text)
          }
        )
      } finally {
        // 流中途失败时，也让错误信息从新的一行开始。
        if (wroteText) {
          write('\n')
        }
      }
    })()

    if (usage) {
      log(
        `  [ctx] 本轮 prompt=${usage.prompt_tokens}` +
          ` completion=${usage.completion_tokens}` +
          ` total=${usage.total_tokens}`
      )
    }

    messages.push(message)

    const toolCalls = message.tool_calls

    if (!toolCalls || toolCalls.length === 0) {
      if (!wroteText) {
        log('\nAgent: (空回复)')
      }

      messages.push({
        role: 'user',
        content: CONTINUE_NUDGE,
      })

      continue
    }

    for (
      let callIndex = 0;
      callIndex < toolCalls.length;
      callIndex++
    ) {
      const call = toolCalls[callIndex]

      // 只是满足 noUncheckedIndexedAccess。
      if (!call) continue

      const isFunction = call.type === 'function'

      if (isFunction) {
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

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: guard,
          })

          if (loopHits >= MAX_LOOP_HITS) {
            /*
             * 当前调用已经回填循环守卫结果。
             * 同一响应中剩余的调用也必须补齐结果。
             */
            for (
              const rest of toolCalls.slice(
                callIndex + 1
              )
            ) {
              const restName =
                rest.type === 'function'
                  ? rest.function.name
                  : rest.type

              messages.push({
                role: 'tool',
                tool_call_id: rest.id,
                content:
                  `[本轮因循环守卫中止,未执行]。` +
                  `如果这是你想做的 "${restName}" 动作,` +
                  '请在用户给出新指令后重新发起。',
              })
            }

            log(
              `\n[中止] 循环守卫已触发 ` +
                `${MAX_LOOP_HITS} 次仍不收敛,本轮放弃。`
            )

            return
          }

          continue
        }
      }

      /*
       * collectResponse 当前只组装 function 调用，
       * 这里仍保留不支持类型的防御性回填。
       */
      const { observation, endsTurn } = isFunction
        ? await handleCall(
            call.function.name,
            call.function.arguments,
            log,
            options.registry
          )
        : {
            observation:
              `错误:不支持的工具调用类型 ` +
              `"${call.type}"。`,
            endsTurn: false,
          }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: observation,
      })

      if (endsTurn) {
        /*
         * 当前结束工具已经执行并回填。
         * 同批剩余调用不能执行，但仍必须保持 ID 配对。
         */
        for (
          const rest of toolCalls.slice(
            callIndex + 1
          )
        ) {
          messages.push({
            role: 'tool',
            tool_call_id: rest.id,
            content:
              '本轮已结束，此工具调用未执行。等待用户新指令。',
          })
        }

        return
      }
    }
  }

  log(
    `\n[中止] 连续 ${maxIterations} 轮` +
      '仍未得出结论,本轮放弃。'
  )
}

import { client, MODEL } from './llm.js'
import { getToolSchemas, prepareCall, executeCall, initTools } from './tools/index.js'
import { requestApproval } from './approval.js'
import { ask, closeUI } from './ui.js'
import {
  detectRepeatedCall,
  trimHistory,
  truncateToolResult,
  toModelMessages,
} from './context.js'
import type { HistoryMessage, ToolCallLog } from './context.js'

/** 一次真实用户输入最多发起的模型请求数，包含内部继续提示后的请求。 */
const MAX_ITERATIONS = 10

/** 连续同名、原始参数字符串相同的函数调用达到此次数时，拦截当前调用。 */
const REPEAT_THRESHOLD = 3
/** 本轮累计触发循环守卫的次数上限。 */
const MAX_LOOP_HITS = 2

const SYSTEM_PROMPT = [
  '你是一个运行在用户本机命令行里的助手,可以读写文件、执行 shell 命令。',
  `当前操作系统:${process.platform}`,
  `当前工作目录:${process.cwd()}`,
  '涉及文件写入和命令执行的操作会先交给用户确认,用户有可能拒绝。',
  '本轮以用户当前请求为目标；任务清单保存计划，不代表所有条目都应在本轮执行。',
  '此前暂停或被拒绝的任务，只有用户明确要求恢复时才继续。',
].join('\n')

/**
 * 纯文本回复后，提示模型选择继续执行、询问、完成或暂停。
 * 此处不查询待办状态，下一步由模型结合当前请求和工具结果判断。
 */
const CONTINUE_NUDGE = [
  '请根据用户当前的要求决定下一步。',
  '有可以继续执行的步骤时，调用相应工具。',
  '本次工作已完成时，调用 finish_task。',
  '缺少必要信息时，调用 ask_user。',
  '必要操作被拒绝，或用户取消、要求暂停时，调用 pause_task。',
  '不要反复索要同一项许可，也不要擅自恢复此前被拒绝的旧任务。',
].join('\n')

/**
 * 批准被拒绝时回填的说明，引导模型停止重试并在无法继续时暂停。
 * 当前工具不会执行；是否结束本轮，由后续的控制工具调用决定。
 */
const REJECTED =
  '用户拒绝了这次操作。不要重试，也不要换一种方式绕过。' +
  '如果因此无法继续当前任务，调用 pause_task 说明原因，等待用户新指令。'

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code === 'ABORT_ERR'
  }

  return false
}

/** 校验 → 按需批准 → 执行；返回工具结果及结束信号，参数错误或拒绝均不触发结束。 */
async function handleCall(
  name: string,
  rawArgs: string
): Promise<{ observation: string; endsTurn: boolean }> {
  const prepared = prepareCall(name, rawArgs)
  if (!prepared.ok) {
    console.log(`  ✗ ${name} 参数有误`)
    return { observation: prepared.error, endsTurn: false }
  }

  const { tool, args } = prepared

  if (tool.needsApproval) {
    const approved = await requestApproval(tool, args)
    if (!approved) {
      console.log(`  ✗ ${tool.name} 被拒绝`)
      return { observation: REJECTED, endsTurn: false }
    }
  }

  const observation = await executeCall(tool, args)

  const bounded = truncateToolResult(observation)
  const firstLine = bounded.split('\n')[0] ?? ''
  const more = bounded.includes('\n') ? ' …' : ''
  console.log(`  → ${tool.name} ⇒ ${firstLine}${more}`)

  return { observation: bounded, endsTurn: tool.endsTurn === true }
}

/**
 * 处理一次真实用户输入，循环请求模型、执行工具并回填结果。
 * 完成或暂停工具、循环守卫、请求次数上限均可结束本轮；异常交给 main 处理。
 */
async function runTurn(messages: HistoryMessage[]): Promise<void> {
  // 跨模型响应记录本轮的函数调用请求，包含随后被校验、批准或守卫拦截的请求。
  const recentCalls: ToolCallLog[] = []
  let loopHits = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: toModelMessages(messages),
      tools: getToolSchemas(),
    })

    const usage = response.usage
    if (usage) {
      console.log(
        `  [ctx] 本轮 prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
          ` total=${usage.total_tokens}`
      )
    }

    const message = response.choices[0]?.message
    if (!message) throw new Error('模型没有返回 message')

    messages.push(message)

    const toolCalls = message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      console.log(`\nAgent: ${message.content ?? '(空回复)'}`)
      // 引导模型使用显式出口；内部提示属于当前轮，因此不添加 startsTurn 标记。
      messages.push({ role: 'user', content: CONTINUE_NUDGE })
      continue
    }

    if (message.content) console.log(`\nAgent: ${message.content}`)

    for (const call of toolCalls) {
      const isFunction = call.type === 'function'

      if (isFunction) {
        recentCalls.push({
          name: call.function.name,
          argsKey: call.function.arguments,
        })

        // 重复请求只回填守卫说明，不进入参数校验、批准和执行流程。
        const guard = detectRepeatedCall(recentCalls, REPEAT_THRESHOLD)
        if (guard) {
          loopHits++
          console.log(`  ⚠ ${call.function.name} 触发循环守卫(${loopHits}/${MAX_LOOP_HITS})`)
          messages.push({ role: 'tool', tool_call_id: call.id, content: guard })
          if (loopHits >= MAX_LOOP_HITS) {
            // 正常 return 不触发异常回滚。剩余调用必须补齐结果，
            // 避免下一次请求复用尚未配对完整的工具调用历史。
            for (const rest of toolCalls.slice(toolCalls.indexOf(call) + 1)) {
              const restName = rest.type === 'function' ? rest.function.name : rest.type
              messages.push({
                role: 'tool',
                tool_call_id: rest.id,
                content:
                  `[本轮因循环守卫中止,未执行]。` +
                  `如果这是你想做的 "${restName}" 动作,请在用户给出新指令后重新发起。`,
              })
            }
            console.log(`\n[中止] 循环守卫已触发 ${MAX_LOOP_HITS} 次仍不收敛,本轮放弃。`)
            return
          }
          continue
        }
      }

      // 每个 tool_call 都要有匹配 ID 的结果；不支持的调用类型也要回填说明。
      const { observation, endsTurn } = isFunction
        ? await handleCall(call.function.name, call.function.arguments)
        : { observation: `错误:不支持的工具调用类型 "${call.type}"。`, endsTurn: false }

      messages.push({ role: 'tool', tool_call_id: call.id, content: observation })

      if (endsTurn) {
        // 当前结果已回填；同批剩余调用标为未执行，再将控制权交回 REPL。
        const remaining = toolCalls.slice(toolCalls.indexOf(call) + 1)
        for (const rest of remaining) {
          messages.push({
            role: 'tool',
            tool_call_id: rest.id,
            content: '本轮已结束，此工具调用未执行。等待用户新指令。',
          })
        }
        return
      }
    }
  }

  console.log(`\n[中止] 连续 ${MAX_ITERATIONS} 轮仍未得出结论,本轮放弃。`)
}

async function main(): Promise<void> {
  try {
    // 通过注册表恢复工具状态，完成后才接收第一条用户请求。
    await initTools()

    // 对话历史跨 REPL 输入保留；待办等工具状态由各自模块单独维护。
    let messages: HistoryMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ]

    console.log('mini-agent 已启动。输入 exit 退出。')
    console.log(`工作目录:${process.cwd()}\n`)

    for (;;) {
      const input = (await ask('你> ')).trim()

      if (input === '') continue
      if (input === 'exit' || input === 'quit') break

      // 上一轮结束后按 startsTurn 整轮裁剪，再加入本轮输入。
      messages = trimHistory(messages)

      // 保存本轮输入之前的截断点，供异常处理丢弃本轮对话消息。
      const checkpoint = messages.length
      messages.push({
        role: 'user',
        content: input,
        startsTurn: true,
      })

      try {
        await runTurn(messages)
      } catch (e) {
        if (isAbortError(e)) {
          throw e
        }
        console.error(`\n[本轮失败] ${String(e)}`)

        // 异常可能留下尚未配对的工具调用，从本轮起点截断可恢复消息结构。
        // 这里只回滚对话历史，已完成的文件写入、命令或待办变更不会撤销。
        messages.length = checkpoint
        console.error('已回滚本轮,历史保持干净,可直接重新提问')
      }

      console.log()
    }

    console.log('再见。')
  } catch (e) {
    if (isAbortError(e)) {
      console.log('\n已取消,退出。')
      return
    }

    throw e
  } finally {
    // REPL 结束时统一释放输入资源，正常退出和异常路径共用此处。
    closeUI()
  }
}

void main()

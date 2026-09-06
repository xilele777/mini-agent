import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { client, MODEL } from './llm.js'
import { getToolSchemas, prepareCall, executeCall } from './tools/index.js'
import { requestApproval } from './approval.js'
import { ask, closeUI } from './ui.js'
import { detectRepeatedCall, trimHistory, truncateToolResult } from './context.js'
import type { ToolCallLog } from './context.js'

/** 单次用户输入内最多问模型几轮。涉及多次文件/命令操作时任务链较长,留够余量 */
const MAX_ITERATIONS = 10

/** 连续这么多次调用同一工具、参数逐字相同,就判定为原地打转 */
const REPEAT_THRESHOLD = 3
/** 打转提示触发这么多次仍不收敛,强制终止本轮 */
const MAX_LOOP_HITS = 2

const SYSTEM_PROMPT = [
  '你是一个运行在用户本机命令行里的助手,可以读写文件、执行 shell 命令。',
  `当前操作系统:${process.platform}`,
  `当前工作目录:${process.cwd()}`,
  '涉及文件写入和命令执行的操作会先交给用户确认,用户有可能拒绝。',
].join('\n')

/**
 * 用户拒绝时回填给模型的话。
 *
 * 措辞直接决定模型的下一步:写"操作失败"它会当技术故障重试,你就得连按几次 n;
 * 写成下面这样它会停下来问。拒绝时不重试、不换工具绕过,是这个 Agent 的行为底线。
 */
const REJECTED =
  '用户拒绝了这次操作。不要重试,也不要换一种方式绕过(比如改用别的工具做同一件事)。' +
  '请直接告诉用户你原本想做什么、为什么,然后询问他希望怎么办。'

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code === 'ABORT_ERR'
  }

  return false
}

/** 一条工具调用的完整生命周期:准备 → 确认 → 执行,三条路径都要产出一个字符串 */
async function handleCall(name: string, rawArgs: string): Promise<string> {
  const prepared = prepareCall(name, rawArgs)
  if (!prepared.ok) {
    console.log(`  ✗ ${name} 参数有误`)
    return prepared.error
  }

  const { tool, args } = prepared

  if (tool.needsApproval) {
    const approved = await requestApproval(tool, args)
    if (!approved) {
      console.log(`  ✗ ${tool.name} 被拒绝`)
      return REJECTED
    }
  }

  const observation = await executeCall(tool, args)

  const bounded = truncateToolResult(observation)
  const firstLine = bounded.split('\n')[0] ?? ''
  const more = bounded.includes('\n') ? ' …' : ''
  console.log(`  → ${tool.name} ⇒ ${firstLine}${more}`)

  return bounded
}

/** 跑完一次用户输入:反复问模型 → 执行工具 → 回填,直到模型不再要工具 */
async function runTurn(messages: ChatCompletionMessageParam[]): Promise<void> {
  // 工具调用记录。真正的循环是"回复 → 工具 → 回复 → 工具"跨多次响应,
  // 声明在 for 外面才记得到全部;检测只看末尾一段(见 detectRepeatedCall)。
  const recentCalls: ToolCallLog[] = []
  let loopHits = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
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
      return
    }

    if (message.content) console.log(`\nAgent: ${message.content}`)

    for (const call of toolCalls) {
      const isFunction = call.type === 'function'

      if (isFunction) {
        recentCalls.push({
          name: call.function.name,
          argsKey: call.function.arguments,
        })

        // 看门狗先判:同名同参的重复调用 = 原地打转,拦下不执行,
        // 回填一段引导文本让模型掉头,而不是继续喂它同样的结果。
        const guard = detectRepeatedCall(recentCalls, REPEAT_THRESHOLD)
        if (guard) {
          loopHits++
          console.log(`  ⚠ ${call.function.name} 触发循环守卫(${loopHits}/${MAX_LOOP_HITS})`)
          messages.push({ role: 'tool', tool_call_id: call.id, content: guard })
          if (loopHits >= MAX_LOOP_HITS) {
            // 这条 assistant 消息可能还带着后续未处理的 tool_call,
            // 中止前必须给它们各补一条 tool 回复 —— 否则本轮历史里残留
            // "assistant 有 tool_call、却没有配对的 tool 消息"的非法段,
            // 而 checkpoint 记在这个坏段之后,回滚也删不掉它,会话会一直 400。
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

      // 每个 tool_call 都必须产出一条配对的 tool 消息,一条都不能少。
      // 所以不能 `if (type !== 'function') continue` —— 那会漏配对,下一轮必 400。
      const observation = isFunction
        ? await handleCall(call.function.name, call.function.arguments)
        : `错误:不支持的工具调用类型 "${call.type}"。`

      messages.push({ role: 'tool', tool_call_id: call.id, content: observation })
    }
  }

  console.log(`\n[中止] 连续 ${MAX_ITERATIONS} 轮仍未得出结论,本轮放弃。`)
}

async function main(): Promise<void> {
  try {
    // messages 在 while 外面创建 —— 它就是 Agent 的全部记忆
    let messages: ChatCompletionMessageParam[] = [{ role: 'system', content: SYSTEM_PROMPT }]

    console.log('mini-agent 已启动。输入 exit 退出。')
    console.log(`工作目录:${process.cwd()}\n`)

    for (;;) {
      const input = (await ask('你> ')).trim()

      if (input === '') continue
      if (input === 'exit' || input === 'quit') break

      // 先裁掉旧轮。必须赶在 push 新输入之前 —— 此刻上一轮必然完整,
      // 永远不会把 tool_call 配对切成两半。
      messages = trimHistory(messages)

      // 记下本轮开始前的长度,失败时用来回滚(截断点在本轮 push 之前,回滚必安全)
      const checkpoint = messages.length
      messages.push({ role: 'user', content: input })

      try {
        await runTurn(messages)
      } catch (e) {
        if (isAbortError(e)) {
          throw e
        }
        console.error(`\n[本轮失败] ${String(e)}`)

        // 失败可能发生在 push 了带 tool_calls 的 assistant 消息之后、
        // push 配对的 tool 消息之前。回滚到本轮起点,历史就保持合法。
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
    // 正常 exit、quit、Ctrl+C 和异常退出都会关 readline
    closeUI()
  }
}

void main()

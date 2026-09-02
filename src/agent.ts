import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { client, MODEL } from './llm.js'
import { getToolSchemas, prepareCall, executeCall } from './tools/index.js'
import { requestApproval } from './approval.js'
import { ask, closeUI } from './ui.js'

/** 单次用户输入内最多问模型几轮。有了文件操作后任务链更长，从 5 提到 10 */
const MAX_ITERATIONS = 10

const SYSTEM_PROMPT = [
  '你是一个运行在用户本机命令行里的助手，可以读写文件、执行 shell 命令。',
  `当前操作系统：${process.platform}`,
  `当前工作目录：${process.cwd()}`,
  '涉及文件写入和命令执行的操作会先交给用户确认，用户有可能拒绝。',
].join('\n')

/**
 * 用户拒绝时回填给模型的话。
 *
 * 措辞直接决定模型的下一步：写"操作失败"它会以为是技术故障然后重试，
 * 你就得连按好几次 n；写成下面这样它会停下来问你。文本即控制。
 */
const REJECTED =
  '用户拒绝了这次操作。不要重试，也不要换一种方式绕过（比如改用别的工具做同一件事）。' +
  '请直接告诉用户你原本想做什么、为什么，然后询问他希望怎么办。'

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true
  }

  if (typeof error === 'object' && error !== null && 'code' in error) {
    return error.code === 'ABORT_ERR'
  }

  return false
}

/** 一次工具调用的完整生命周期：准备 → 确认 → 执行。三条路都必须产出一个字符串 */
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

  const firstLine = observation.split('\n')[0] ?? ''
  const more = observation.includes('\n') ? ' …' : ''
  console.log(`  → ${tool.name} ⇒ ${firstLine}${more}`)

  return observation
}

/** 跑完一次用户输入：反复问模型 → 执行工具 → 回填，直到模型不再要工具 */
async function runTurn(messages: ChatCompletionMessageParam[]): Promise<void> {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getToolSchemas(),
    })

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
      // 每个 tool_call 都必须产出一条配对的 tool 消息，一条都不能少。
      // 所以这里不能像以前那样 `if (type !== 'function') continue` —— 那会漏配对，下一轮必 400。
      const observation =
        call.type === 'function'
          ? await handleCall(call.function.name, call.function.arguments)
          : `错误：不支持的工具调用类型 "${call.type}"。`

      messages.push({ role: 'tool', tool_call_id: call.id, content: observation })
    }
  }

  console.log(`\n[中止] 连续 ${MAX_ITERATIONS} 轮仍未得出结论，本轮放弃。`)
}

async function main(): Promise<void> {
  try {
    // messages 在 while 外面创建 —— 它就是这个 Agent 的全部记忆
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
    ]

    console.log('mini-agent 已启动。输入 exit 退出。')
    console.log(`工作目录：${process.cwd()}\n`)

    for (;;) {
      const input = (await ask('你> ')).trim()

      if (input === '') continue
      if (input === 'exit' || input === 'quit') break

      // 记下本轮开始前的长度，失败时用来回滚
      const checkpoint = messages.length
      messages.push({ role: 'user', content: input })

      try {
        await runTurn(messages)
      } catch (e) {
        if (isAbortError(e)) {
          throw e
        }
        console.error(`\n[本轮失败] ${String(e)}`)

        // 请求可能是在 push 了带 tool_calls 的 assistant 消息之后、
        // push 配对的 tool 消息之前失败。回滚后，历史保持合法。
        messages.length = checkpoint
        console.error('已回滚本轮，历史保持干净，可以直接重新提问。')
      }

      console.log()
    }

    console.log('再见。')
  } catch (e) {
    if (isAbortError(e)) {
      console.log('\n已取消，退出。')
      return
    }

    throw e
  } finally {
    // 正常 exit、quit、Ctrl+C 和异常退出路径都会关闭 readline。
    closeUI()
  }
}

void main()
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { client, MODEL } from './llm.js'
import { SYSTEM_PROMPT } from './protocol.js'
import { calculate } from './tools/calc.js'
import { TOOLS } from './tools/schema.js'

const MAX_ITERATIONS = 5

function runCalculate(rawArgs: string): string {
  // 关卡一：是不是合法 JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return `错误：参数不是合法的 JSON。收到的是：${rawArgs}。请重新调用，参数格式为 {"expression": "数学表达式"}`
  }

  // 关卡二：是不是一个对象
  if (typeof parsed !== 'object' || parsed === null) {
    return `错误：参数必须是一个 JSON 对象。收到的是：${rawArgs}`
  }

  // 关卡三：字段在不在、类型对不对
  const expression = (parsed as Record<string, unknown>).expression
  if (typeof expression !== 'string' || expression.trim() === '') {
    return `错误：缺少必需参数 expression（或它不是非空字符串）。收到的参数是：${rawArgs}。请重新调用，例如 {"expression": "123 * 456"}`
  }

  // 三关都过了，expression 在这里已经被 TS 收窄成 string
  return calculate(expression)
}

async function main(): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '先算 123 * 456，再把结果加上 789，最后除以 3' },
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n--- 第 ${i + 1} 轮 ---`)

    const response = await client.chat.completions.create({ model: MODEL, messages, tools: TOOLS })

    const message = response.choices[0]?.message

    if(!message) throw new Error('模型没有返回 message')

    messages.push(message)

    if (message.content) console.log('[模型]', message.content)

    const toolCalls = message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      console.log('\n[最终答案]', message.content ?? '')
      return
    }

    for (const call of toolCalls) {
      if (call.type !== 'function') continue

      const name = call.function.name
      const rawArgs = call.function.arguments

      const observation =
        name === 'calculate'
          ? runCalculate(rawArgs)
          : `错误：不存在名为 "${name}" 的工具，可用工具只有：calculate`

      console.log(`[工具] ${name}(${rawArgs}) => ${observation}`)

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: observation,
      })
    }
  }
  console.log('\n[失败] 达到最大循环次数，未能得出答案')
}

main()



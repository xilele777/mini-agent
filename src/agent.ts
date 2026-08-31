import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { client, MODEL } from './llm.js'
import { getToolSchemas, runTool } from './tools/index.js'

const MAX_ITERATIONS = 5
const SYSTEM_PROMPT = '你是一个可以使用工具的助手。'

async function main(): Promise<void> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '1 + 1等于几？' },
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n--- 第 ${i + 1} 轮 ---`)

    const response = await client.chat.completions.create({ model: MODEL, messages, tools: getToolSchemas() })

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

      const observation = await runTool(name, rawArgs)

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



import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { client, MODEL } from './llm.js'
import { SYSTEM_PROMPT, parse } from './protocol.js'
import { calculate } from './tools/calc.js'

const MAX_ITERATIONS = 5

async function main() {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '先算 123 * 456，再把结果加上 789，最后除以 3' },
  ]

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n--- 第 ${i + 1} 轮 ---`)

    // ① 问模型
    const response = await client.chat.completions.create({ model: MODEL, messages })
    const content = response.choices[0]?.message.content ?? ''
    console.log('[模型]', content)

    // ② 模型说的话必须进历史，否则它下一轮不记得自己说过什么
    messages.push({ role: 'assistant', content })

    // ③ 解析
    const result = parse(content)

    if (result.type === 'final') {
      console.log('\n[最终答案]', result.content)
      return
    }

    if (result.type === 'error') {
      // 把格式错误告诉模型，让它自己改正
      console.log('[解析失败]', result.message)
      messages.push({ role: 'user', content: result.message })
      continue
    }

    // ④ result.type === 'action'，执行工具
    let observation: string
    if (result.tool === 'calculate') {
      observation = calculate(result.input)
    } else {
      observation = `错误：不存在名为 "${result.tool}" 的工具，可用工具只有：calculate`
    }

    console.log('[工具]', observation)

    // ⑤ 把结果喂回去，这就是 ReAct 里的 Observation
    messages.push({ role: 'user', content: `Observation: ${observation}` })
  }

  console.log('\n[失败] 达到最大循环次数，未能得出答案')
}

main()
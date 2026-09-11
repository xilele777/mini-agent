/** 阶段 0 的独立 API 演示，可用 npx tsx src/index.ts 运行；REPL 入口为 agent.ts。 */
import 'dotenv/config'
import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY

if(!apiKey){
  throw new Error('缺少环境变量')
}

const baseURL = process.env.OPENAI_BASE_URL

if(!baseURL){
  throw new Error('缺少环境变量')
}

const client = new OpenAI({ apiKey, baseURL })

const response = await client.chat.completions.create({
  model: "gpt-5.6-sol",
  messages: [
    {role: 'user', content: '你好，介绍一下自己'},
  ],
})

// 阅读完整响应时关注 choices[0].message、choices[0].finish_reason 和 usage。
console.log(JSON.stringify(response, null, 2))

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

console.log(JSON.stringify(response, null, 2))

/*
PS F:\project\mini-agent> npm run dev

> mini-agent@1.0.0 dev
> tsx src/index.ts

{
  "id": "resp_06e6449d30289b11016a93fd0e2fe887d28cee148fb63670f7",
  "object": "chat.completion",
  "created": 1788083473,
  "model": "gpt-5.6-sol",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "你好，我是 Codex，一名专注于软件工程的 AI 助手。我可以直接在当前工作区中阅读和修改代码、运行命令与测试、排查故障、实现功能、优化前端体验，以及进行代码审查。\n\n我通常会先理解现有项目结构和约定，再完成实现与验证，并清楚说明改了什么、测试结果如何，以及是否还有风险或限制。你可以直接告诉我目标，例如“修复这个报错”“实现一个登录页面”“审查最近的改动”或“解释这段代码”。"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 4391,
    "completion_tokens": 126,
    "total_tokens": 4517,
    "prompt_tokens_details": {
      "cached_tokens": 3840
    }
  }
}
*/
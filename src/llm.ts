import 'dotenv/config'
import OpenAI from 'openai'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  throw new Error('缺少环境变量 OPENAI_API_KEY')
}

const baseURL = process.env.OPENAI_BASE_URL
if (!baseURL) {
  throw new Error('缺少环境变量 OPENAI_BASE_URL')
}

export const client = new OpenAI({ apiKey, baseURL })

// 当前 Agent 入口使用的模型配置，中转地址由 OPENAI_BASE_URL 提供。
export const MODEL = 'gpt-6-astra'

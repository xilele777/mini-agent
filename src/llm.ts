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

// 当前走的是中转站。要换模型时改这里即可,不用动其它文件
export const MODEL = 'gpt-5.6-sol'

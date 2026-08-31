import { z } from 'zod'
import type { Tool } from './types.js'

const timeParams = z.object({})

export const timeTool: Tool<z.infer<typeof timeParams>> = {
  name: 'current_time',
  description:
    '获取当前的本地日期和时间。用户问"现在几点""今天几号"之类的问题时必须调用本工具，你自己不知道当前时间，禁止猜测。',
  schema: timeParams,
  execute: () => new Date().toLocaleString('zh-CN'),
}
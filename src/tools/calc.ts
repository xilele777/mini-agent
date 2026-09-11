import { z } from 'zod'
import type { Tool } from './types.js'

/** 注册表先按此字符集校验算式，再调用 execute；此规则不解析完整的数学语法。 */
const SAFE = /^[0-9+\-*/(). ]+$/

const calcParams = z.object({
  expression: z
    .string()
    .min(1, '表达式不能为空')
    .max(100, '表达式不能超过 100 个字符')
    .regex(SAFE, '只允许数字和 + - * / ( ) . 以及空格')
    .describe('要计算的数学表达式，例如 "123 * 456"'),
})

export const calcTool: Tool<z.infer<typeof calcParams>> = {
  name: 'calculate',
  description:
    '计算一个数学表达式并返回结果。只支持数字和 + - * / ( ) . 以及空格，不支持函数、变量、幂运算。任何数学运算都必须调用本工具，不要心算。',
  schema: calcParams,
  execute: ({ expression }) => {
    try {
      const result = eval(expression)
      if (!Number.isFinite(result)) {
        return '错误：计算结果不是有效数字，请检查是否除以了 0'
      }
      return String(result)
    } catch (e) {
      return `错误：表达式无法计算（${String(e)}）`
    }
  },
}

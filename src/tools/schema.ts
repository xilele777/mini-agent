import type { ChatCompletionTool } from 'openai/resources/chat/completions'

export const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'calculate',
      description:
        '计算一个数学表达式并返回结果。只支持数字和 + - * / ( ) . 以及空格，不支持函数、变量、幂运算。任何数学运算都必须调用本工具，不要心算。',
      parameters: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: '要计算的数学表达式，例如 "123 * 456"',
          },
        },
        required: ['expression'],
        additionalProperties: false,
      },
    },
  },
]
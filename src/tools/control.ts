import { z } from 'zod'
import { ask } from '../ui.js'
import type { Tool } from './types.js'

// 控制工具复用注册表与结果回填流程；主循环仅通过 endsTurn 识别结束信号。

const finishParams = z.object({})

/** 模型声明本次请求完成；工具本身不检查或清空待办。 */
export const finishTaskTool: Tool<z.infer<typeof finishParams>> = {
  name: 'finish_task',
  description:
    '用户本次请求已完成时调用。完成与否以当前请求为准，不要求历史待办全部清空。' +
    '如需输出总结，在调用本工具的同一条消息中输出；调用后本轮结束。',
  schema: finishParams,
  endsTurn: 'completed',
  execute: () => '本次请求已处理完毕。',
}

const askUserParams = z.object({
  question: z
    .string()
    .min(1, '问题不能为空')
    .describe('要问用户的问题,用户会原样看到并输入回答'),
})

/** 在当前轮内等待输入，回答作为工具结果回填，随后继续请求模型。 */
export const askUserTool: Tool<z.infer<typeof askUserParams>> = {
  name: 'ask_user',
  description:
    '执行中遇到只有用户才能拍板的决定时,停下来问用户。传入的问题会原样展示给用户,用户的回答会返回给你。',
  schema: askUserParams,
  execute: async ({ question }) => {
    console.log(`\n[询问用户] ${question}`)
    const answer = (await ask('你的回答> ')).trim()
    return `用户回答:${answer}`
  },
}

const pauseParams = z.object({
  reason: z.string().trim().min(1).describe('暂停原因，以及需要用户提供什么新指令'),
})

/** 结束当前轮并保留待办；暂停原因保存在对话中，未写入独立的任务状态。 */
export const pauseTaskTool: Tool<z.infer<typeof pauseParams>> = {
  name: 'pause_task',
  description:
    '当前工作尚未完成，但必要操作被用户拒绝、用户取消或要求暂停时调用。' +
    '结束本轮并等待用户新指令，不把未完成的待办标记为完成。',
  schema: pauseParams,
  endsTurn: 'paused',
  execute: ({ reason }) => `本轮已暂停：${reason}`,
}

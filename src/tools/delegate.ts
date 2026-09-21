import { z } from 'zod'
import type { Tool, ExecutionContext } from './types.js'

// Note: 同步只读子 Agent 的委派协议 — 见 .agents/notes/implemented/feature/2026-09-19-isolated-readonly-subagent.md

const delegateParams = z.object({
  task: z
    .string()
    .trim()
    .min(1, '子任务不能为空')
    .max(4000, '子任务不能超过 4000 个字符')
    .describe(
      '要交给只读子 Agent 独立调查的明确子任务'
    ),
})

export type DelegateRunner = (
  task: string, context?: ExecutionContext
) => Promise<string>


export function createDelegateTaskTool(
  run: DelegateRunner
): Tool<z.infer<typeof delegateParams>> {
  return {
    name: 'delegate_task',
    description:
      '把一个可以独立调查的子任务交给只读子 Agent。' +
      '子 Agent 拥有独立上下文，只能读取项目、搜索文件、计算和查询时间。' +
      '它不能写文件、执行 shell、修改 todo、询问用户或再次委派。' +
      '需要副作用操作时，不要委派执行，只让子 Agent调查并返回建议。' +
      '子 Agent 返回结果后，由你继续决定是否执行主任务。',
    schema: delegateParams,
    execute: async ({ task }, context) => run(task, context),
  }
}

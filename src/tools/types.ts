import type { ZodType } from 'zod'
import type { RunControl } from '../run-control.js'

export interface ExecutionContext {
  signal?: AbortSignal
  control?: RunControl
}

export interface PreparedAction {
  preview: string
  /** 绑定目标、基准版本和候选内容，而不是只绑定模型参数。 */
  approvalKey: string
  execute: (context?: ExecutionContext) => string | Promise<string>
}

export class ToolPreparationError extends Error {}

export interface Tool<A = any> {
  name: string
  /** 给模型的用途说明，影响它何时选择此工具。 */
  description: string
  /** 同时用于生成工具参数说明和执行前的运行时校验。 */
  schema: ZodType<A>
  /** 调用方先完成参数校验和必要的批准，再执行工具。 */
  execute: (args: A, context?: ExecutionContext) => string | Promise<string>
  prepare?: (args: A) => Promise<PreparedAction>
  /** 文件变更必须逐次审阅，不复用进程内批准。 */
  cacheApproval?: boolean

  /** 回填结果后结束本轮，并说明完成还是暂停。 */
  endsTurn?: 'completed' | 'paused'

  /** 执行前是否需要检查人工批准，包括本次进程缓存的相同动作批准。 */
  needsApproval?: boolean

  /**
   * 给用户的动作预览，与给模型的 description 分工不同。
   * 需要批准的工具应提供预览；缺省时批准流程展示参数 JSON。
   */
  preview?: (args: A) => string
}

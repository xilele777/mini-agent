import type { ZodType } from 'zod'

export interface Tool<A = any> {
  name: string
  description: string
  schema: ZodType<A>
  execute: (args: A) => string | Promise<string>

  /** 有副作用,执行前必须人工批准 */
  needsApproval?: boolean

  /**
   * 给人看的动作描述 —— 与给模型看的 description 是一对。
   * needsApproval 为 true 时应当提供;没提供就退化成打印原始参数。
   */
  preview?: (args: A) => string
}

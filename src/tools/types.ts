import type { ZodType } from 'zod'

export interface Tool<A = any> {
  name: string
  description: string
  schema: ZodType<A>
  execute: (args: A) => string | Promise<string>

  /** 有副作用,执行前必须人工批准 */
  needsApproval?: boolean

  /**
   * 给人看的自我描述 —— 和 description(给模型看的)是一对。
   * needsApproval 为 true 时应当提供;不提供则退化成打印原始 JSON。
   */
  preview?: (args: A) => string
}
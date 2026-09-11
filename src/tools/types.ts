import type { ZodType } from 'zod'

export interface Tool<A = any> {
  name: string
  /** 给模型的用途说明，影响它何时选择此工具。 */
  description: string
  /** 同时用于生成工具参数说明和执行前的运行时校验。 */
  schema: ZodType<A>
  /** 调用方先完成参数校验和必要的批准，再执行工具。 */
  execute: (args: A) => string | Promise<string>

  /** 主循环回填结果后结束本轮；完成与暂停出口均可使用，不表示清空待办。 */
  endsTurn?: boolean

  /** 执行前是否需要检查人工批准，包括本次进程缓存的相同动作批准。 */
  needsApproval?: boolean

  /**
   * 给用户的动作预览，与给模型的 description 分工不同。
   * 需要批准的工具应提供预览；缺省时批准流程展示参数 JSON。
   */
  preview?: (args: A) => string
}

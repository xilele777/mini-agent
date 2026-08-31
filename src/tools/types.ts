import type { ZodType } from 'zod'

export interface Tool<A = any> {
  name: string
  description: string
  schema: ZodType<A>
  execute: (args: A) => string | Promise<string>
  needsApproval?: boolean
}
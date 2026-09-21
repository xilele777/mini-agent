import { z } from 'zod'
import { historyFingerprint, summarySchema } from './context-summary.js'

// Note: 版本 3 摘要与版本 2 无损读取 — 见 .agents/notes/implemented/architecture/2026-09-21-atomic-session-storage.md

const id = z.uuid()
const text = z.string().min(1)

const callSchema = z.strictObject({
  id: text,
  type: z.literal('function'),
  function: z.strictObject({
    name: text,
    arguments: z.string(),
  }),
})

// 只接受当前 CLI 实际支持的文本与 function calling。
export const messageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('system'),
    content: z.string(),
  }),
  z.strictObject({
    role: z.literal('user'),
    content: z.string(),
    startsTurn: z.literal(true).optional(),
  }),
  z.strictObject({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    refusal: z.string().nullable().optional(),
    tool_calls: z.array(callSchema).min(1).optional(),
  }),
  z.strictObject({
    role: z.literal('tool'),
    tool_call_id: text,
    content: z.string(),
  }),
]).transform((message) => {
  // exactOptionalPropertyTypes：可选字段不存在时，实际省略这个键。
  if (message.role === 'user') {
    const { startsTurn, ...rest } = message
    return {
      ...rest,
      ...(startsTurn === true ? { startsTurn } : {}),
    }
  }

  if (message.role === 'assistant') {
    const { refusal, tool_calls, ...rest } = message
    return {
      ...rest,
      ...(refusal !== undefined ? { refusal } : {}),
      ...(tool_calls !== undefined ? { tool_calls } : {}),
    }
  }

  return message
})

const actionSchema = z.strictObject({
  messageIndex: z.number().int().nonnegative(),
  callId: text,
  state: z.enum(['pending', 'started', 'returned', 'not_executed', 'uncertain']),
  observation: z.string().nullable(),
})

const dataSchema = z.strictObject({
  version: z.literal(3),
  id,
  projectRoot: text,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  messages: z.array(messageSchema),
  summary: summarySchema.nullable(),
  turns: z.array(z.strictObject({
    id,
    start: z.number().int().nonnegative(),
    status: z.enum([
      'running',
      'completed',
      'paused',
      'cancelled',
      'failed',
      'budget_exhausted',
    ]),
    reason: z.string(),
    actions: z.array(actionSchema),
  })),
  todo: z.strictObject({
    tasks: z.array(z.strictObject({
      id: z.number().int().positive(),
      title: text,
    })),
    nextId: z.number().int().positive(),
  }),
})

export type Session = z.infer<typeof dataSchema>

const validatedSessionSchema = dataSchema.superRefine((s, ctx) => {
  const bad = (message: string) =>
    ctx.addIssue({ code: 'custom', message })

  if (s.summary) {
    const first = s.messages.findIndex((m) => m.role === 'user' && m.startsTurn)
    const boundary = s.turns.findIndex((t) => t.start === s.summary!.through)
    if (
      first < 0 || s.summary.through <= first || boundary <= 0 ||
      s.turns.slice(0, boundary).some((t) => t.status === 'running') ||
      historyFingerprint(s.messages, s.summary.through) !== s.summary.sourceHash
    ) {
      bad('摘要范围或原文指纹无效')
    }
  }

  const ids = s.todo.tasks.map((task) => task.id)
  if (new Set(ids).size !== ids.length || ids.some((n) => n >= s.todo.nextId)) {
    bad('todo 编号重复或 nextId 无效')
  }

  if (new Set(s.turns.map((t) => t.id)).size !== s.turns.length) {
    bad('turnId 重复')
  }

  // 普通文本历史可以独立保存；工具调用必须有所属用户轮与动作记录。
  const allActions = new Map<
    string,
    Session['turns'][number]['actions'][number]
  >()

  s.turns.forEach((turn, index) => {
    const next = s.turns[index + 1]?.start ?? s.messages.length
    const start = s.messages[turn.start]

    if (
      start?.role !== 'user' ||
      start.startsTurn !== true ||
      turn.start >= next ||
      (index > 0 && turn.start <= s.turns[index - 1]!.start)
    ) {
      bad('用户轮边界无效')
    }

    if (turn.status === 'running' && index !== s.turns.length - 1) {
      bad('只有最后一轮可以运行中')
    }

    for (const action of turn.actions) {
      const key = `${action.messageIndex}:${action.callId}`

      if (
        allActions.has(key) ||
        action.messageIndex <= turn.start ||
        action.messageIndex >= next
      ) {
        bad('动作归属或标识无效')
      }

      if (
        (action.state === 'pending' || action.state === 'started') &&
        (turn.status !== 'running' || action.observation !== null)
      ) {
        bad('未结束动作状态无效')
      }

      if (
        action.state !== 'pending' &&
        action.state !== 'started' &&
        action.observation === null
      ) {
        bad('已结束动作缺少结果')
      }

      allActions.set(key, action)
    }
  })

  const seen = new Set<string>()
  const pending = new Map<string, {
    key: string
    action: Session['turns'][number]['actions'][number]
  }>()

  s.messages.forEach((message, index) => {
    if (message.role === 'tool') {
      const entry = pending.get(message.tool_call_id)

      if (
        !entry ||
        entry.action.observation !== message.content ||
        entry.action.state === 'pending' ||
        entry.action.state === 'started'
      ) {
        bad('工具结果与动作记录不匹配')
      }

      pending.delete(message.tool_call_id)
      return
    }

    if (pending.size) {
      bad('工具结果尚未配齐就出现后续消息')
    }

    if (message.role !== 'assistant') return

    for (const call of message.tool_calls ?? []) {
      const key = `${index}:${call.id}`
      const action = allActions.get(key)

      if (!action || pending.has(call.id)) {
        bad('工具调用缺少动作记录或 ID 重复')
        continue
      }

      seen.add(key)
      pending.set(call.id, { key, action })
    }
  })

  if (seen.size !== allActions.size) {
    bad('存在无对应调用的动作记录')
  }

  for (const { action } of pending.values()) {
    if (action.state !== 'pending' && action.state !== 'started') {
      bad('已结束动作缺少 tool 消息')
    }
  }
})

// v2 有完整动作证据，可无损补空摘要；只读加载不回写，下一次原子保存写 v3。
// v1 与未知版本继续拒绝，不能把缺失的动作记录猜成已完成。
export const sessionSchema = z.preprocess((value) => {
  if (
    typeof value === 'object' && value !== null &&
    'version' in value && value.version === 2 && !('summary' in value)
  ) {
    return { ...value, version: 3, summary: null }
  }
  return value
}, validatedSessionSchema)

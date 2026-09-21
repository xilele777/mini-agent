import { closeSync, openSync, writeSync } from 'node:fs'
import { z } from 'zod'

// Note: 白名单事件与共享运行账目 — 见 .agents/notes/implemented/architecture/2026-09-22-runtime-resilience.md
const scope = z.enum(['main', 'summary', 'subagent'])
const number = z.number().finite().nonnegative()
const status = z.enum(['completed', 'paused', 'cancelled', 'failed', 'budget_exhausted'])
const toolName = z.enum(['calculate', 'current_time', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_bash', 'add_todo', 'list_todos', 'remove_todo', 'ask_user', 'finish_task', 'pause_task', 'delegate_task', 'other'])
export function safeToolName(name: string): z.infer<typeof toolName> {
  const result = toolName.safeParse(name)
  return result.success ? result.data : 'other'
}
const stats = {
  requests: number, chargedTokens: number, actualTokens: number,
  estimatedRequests: number, elapsedMs: number, toolCalls: number,
}

// 运行时白名单同样会丢弃多余字段；绝不把正文、参数、路径或异常消息交给轨迹。
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn_start') }),
  z.object({ type: z.literal('request_start'), scope, taskId: z.uuid().nullable(), request: number, reservedTokens: number }),
  z.object({ type: z.literal('request_end'), scope, taskId: z.uuid().nullable(), request: number, outcome: z.enum(['returned', 'failed']), tokens: number, accounting: z.enum(['actual', 'estimated']), elapsedMs: number }),
  z.object({ type: z.literal('retry'), scope, taskId: z.uuid().nullable(), attempt: number, delayMs: number }),
  z.object({ type: z.literal('tool'), scope, taskId: z.uuid().nullable(), action: number, tool: toolName, state: z.enum(['started', 'returned', 'not_executed', 'uncertain']) }),
  z.object({ type: z.literal('approval'), action: number, state: z.enum(['waiting', 'allowed', 'denied']) }),
  z.object({ type: z.literal('turn_end'), status, ...stats }),
])
export type RuntimeEvent = z.infer<typeof eventSchema>
export type EventSink = (event: RuntimeEvent) => void

export function renderEvent(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case 'request_start': return `  [run] ${event.scope} 请求 #${event.request}，预留 ${event.reservedTokens} tokens`
    case 'retry': return `  [retry] ${event.scope} 第 ${event.attempt} 次重试，等待 ${event.delayMs}ms`
    case 'tool': return event.state === 'started' ? `  [tool] ${event.scope} ${event.tool} #${event.action} 开始` : undefined
    case 'turn_end': return `  [run] ${event.status} | 请求 ${event.requests} | 工具 ${event.toolCalls} | tokens ${event.chargedTokens}（已报告 ${event.actualTokens}，估算请求 ${event.estimatedRequests}）| ${event.elapsedMs}ms`
    default: return undefined
  }
}

/** 轨迹是诊断副本；写失败只禁用轨迹，不改变会话检查点及工具执行结果。 */
export function createTrace(file: string, sessionId: string, turnId: string, warn: (message: string) => void) {
  let fd: number | undefined
  let disabled = false
  let sequence = 0
  function close() {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已禁用的诊断文件无需影响业务收尾。 */ }
      fd = undefined
    }
  }
  return {
    emit(event: RuntimeEvent) {
      if (disabled) return
      try {
        const safe = eventSchema.parse(event)
        fd ??= openSync(file, 'a', 0o600)
        const row = Buffer.from(JSON.stringify({ version: 1, sessionId, turnId, sequence: ++sequence, at: new Date().toISOString(), ...safe }) + '\n')
        let offset = 0
        while (offset < row.length) {
          const written = writeSync(fd, row, offset, row.length - offset)
          if (!written) throw new Error('轨迹写入没有进展')
          offset += written
        }
      } catch {
        disabled = true
        close()
        warn('  [trace] 轨迹写入失败，本轮已禁用轨迹；会话检查点仍独立保存。')
      }
    },
    close,
  }
}

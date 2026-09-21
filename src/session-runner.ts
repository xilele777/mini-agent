import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createTrace, renderEvent } from './telemetry.js'
import { RunControl } from './run-control.js'
import type { HistoryMessage } from './context.js'
import { messageSchema, type Session } from './session-schema.js'
import type { SessionHandle } from './session.js'
import { createSessionContext } from './compaction.js'
import {
  CheckpointError,
  runTurn,
  SYSTEM_PROMPT,
  type RunTurnOptions,
  type TurnEvent,
} from './turn.js'

// Note: 会话检查点与恢复不重放 — 见 .agents/notes/proposed/architecture/2026-09-20-practical-mini-agent-v1.md

async function save(
  session: SessionHandle,
  change: (draft: Session) => void
) {
  try {
    await session.update(change)
  } catch (error) {
    throw new CheckpointError(error)
  }
}

function applyCheckpoint(
  draft: Session,
  turnId: string,
  event: TurnEvent,
  history: HistoryMessage[]
) {
  const turn = draft.turns.at(-1)

  if (!turn || turn.id !== turnId || turn.status !== 'running') {
    throw new Error('当前用户轮不匹配')
  }

  draft.messages = history.map((message) => messageSchema.parse(message))

  // 一批调用先全部记为 pending；尚未开始的调用也有恢复依据。
  for (let index = turn.start + 1; index < draft.messages.length; index++) {
    const message = draft.messages[index]
    if (message?.role !== 'assistant') continue

    for (const call of message.tool_calls ?? []) {
      if (!turn.actions.some(
        (a) => a.messageIndex === index && a.callId === call.id
      )) {
        turn.actions.push({
          messageIndex: index,
          callId: call.id,
          state: 'pending',
          observation: null,
        })
      }
    }
  }

  if (event.type === 'action') {
    const action = turn.actions.find(
      (a) =>
        a.messageIndex === event.messageIndex &&
        a.callId === event.call.id
    )

    if (!action) throw new Error('缺少动作记录')

    const expected =
      event.state === 'started' || event.state === 'not_executed'
        ? 'pending'
        : 'started'

    if (action.state !== expected) {
      throw new Error('动作状态转换无效')
    }

    action.state = event.state
    action.observation = event.observation ?? null
  }

  if (event.type === 'turn_end') {
    turn.status = event.result.status
    turn.reason = event.result.reason
  }
}

export async function runSessionTurn(
  session: SessionHandle,
  input: string,
  options: Omit<RunTurnOptions, 'checkpoint' | 'prepareContext'>
) {
  if (!input.trim()) throw new Error('用户输入不能为空')

  const turnId = randomUUID()
  const state = session.snapshot
  const log = options.log ?? console.log
  const trace = createTrace(join(state.projectRoot, '.mini-agent', 'sessions', state.id, 'trace.jsonl'), state.id, turnId, log)
  const control = new RunControl(options.runLimits, options.signal, event => {
    trace.emit(event)
    const line = renderEvent(event)
    if (line) log(line)
    options.onEvent?.(event)
  })

  try {
    await save(session, (draft) => {
      if (draft.turns.at(-1)?.status === 'running') {
        throw new Error('请先恢复中断的用户轮')
      }

      if (!draft.messages.length) {
        draft.messages.push({
          role: 'system',
          content: SYSTEM_PROMPT,
        })
      }

      const start = draft.messages.length
      draft.messages.push({
        role: 'user',
        content: input,
        startsTurn: true,
      })

      draft.turns.push({
        id: turnId,
        start,
        status: 'running',
        reason: '',
        actions: [],
      })
    })

    const messages: HistoryMessage[] = session.snapshot.messages

    return await runTurn(messages, {
      ...options,
      control,
      prepareContext: createSessionContext(
        session, options.contextBudget, log
      ),
      checkpoint: (event, history) =>
        save(session, (draft) =>
          applyCheckpoint(draft, turnId, event, history)
        ),
    })
  } finally {
    control.dispose()
    trace.close()
  }
}

/** 只修复记录，绝不请求模型或重放工具。 */
export async function recoverSession(
  session: SessionHandle
): Promise<void> {
  if (session.snapshot.turns.at(-1)?.status !== 'running') return

  await save(session, (draft) => {
    const turn = draft.turns.at(-1)!

    for (const action of turn.actions) {
      if (action.state !== 'pending' && action.state !== 'started') {
        continue
      }

      const uncertain = action.state === 'started'

      action.state = uncertain ? 'uncertain' : 'not_executed'
      action.observation = uncertain
        ? '[恢复记录] 执行结果不确定。先核查外部状态；无法核查时保留不确定性，不要直接重试。'
        : '[恢复记录] 上次进程中断，此调用尚未执行。等待用户新指令。'

      draft.messages.push({
        role: 'tool',
        tool_call_id: action.callId,
        content: action.observation,
      })
    }

    turn.status = 'failed'
    turn.reason = '上次进程在本轮结束前中断；已恢复记录，未重放工具。'
  })
}

export function describeSession(session: SessionHandle): string {
  const state = session.snapshot
  const turn = state.turns.at(-1)

  const lines = [
    `会话：${state.id}`,
    `消息 ${state.messages.length} 条，待办 ${state.todo.tasks.length} 项。`,
  ]

  if (state.summary) {
    lines.push(`历史摘要覆盖到原始消息 ${state.summary.through}；完整历史仍保留。`)
  }

  if (turn) {
    lines.push(`最近用户轮：${turn.id} / ${turn.status}；${turn.reason}`)

    for (const action of turn.actions) {
      const message = state.messages[action.messageIndex]
      const call = message?.role === 'assistant'
        ? message.tool_calls?.find((c) => c.id === action.callId)
        : undefined

      lines.push(
        `  ${call?.function.name ?? action.callId}：${action.state}`
      )
    }
  }

  const unknown = state.turns
    .flatMap((t) => t.actions)
    .filter((a) => a.state === 'uncertain')
    .length

  if (unknown) {
    lines.push(
      `历史中有 ${unknown} 个结果不确定的动作；继续相关任务前先核查。`
    )
  }

  return lines.join('\n')
}

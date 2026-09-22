import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { acquireSessionLock, readSnapshot, writeSnapshot } from './session-storage.js'
import { sessionSchema, type Session } from './session-schema.js'

// Note: 会话存储与项目绑定 — 见 .agents/notes/proposed/architecture/2026-09-20-practical-mini-agent-v1.md

const idSchema = z.uuid()

function sessionsDirectory(projectRoot: string): string {
  return join(projectRoot, '.mini-agent', 'sessions')
}

function checkIdentity(session: Session, id: string, projectRoot: string): void {
  if (session.id !== id) {
    throw new Error('会话 ID 与目录不一致')
  }
  if (session.projectRoot !== projectRoot) {
    throw new Error('会话绑定的项目不匹配')
  }
}

export interface SessionHandle {
  readonly snapshot: Session
  update(change: (draft: Session) => void | Promise<void>): Promise<void>
  close(): Promise<void>
}

function createHandle(initial: Session, file: string, release: () => Promise<void>): SessionHandle {
  let state = initial
  let busy = false
  let closed = false

  return {
    get snapshot() {
      return structuredClone(state)
    },

    async update(change) {
      if (closed) throw new Error('会话已经关闭')
      if (busy) throw new Error('会话正在保存，请顺序 await')

      busy = true
      try {
        const draft = structuredClone(state)
        await change(draft)

        checkIdentity(draft, state.id, state.projectRoot)
        if (draft.createdAt !== state.createdAt) {
          throw new Error('不能修改创建时间')
        }

        draft.updatedAt = new Date().toISOString()
        const next = sessionSchema.parse(draft)

        await writeSnapshot(file, sessionSchema, next)
        state = next
      } finally {
        busy = false
      }
    },

    async close() {
      if (closed) return
      if (busy) throw new Error('保存结束后才能关闭会话')

      closed = true
      await release()
    },
  }
}

export async function createSession(project: string): Promise<SessionHandle> {
  const projectRoot = await realpath(project)
  const id = randomUUID()
  const parent = sessionsDirectory(projectRoot)
  const directory = join(parent, id)

  await mkdir(parent, { recursive: true })
  // 不合并已有会话目录，即使碰巧遇到 ID 冲突也停止。
  await mkdir(directory)

  const release = await acquireSessionLock(directory)

  try {
    const now = new Date().toISOString()
    const state: Session = {
      version: 3,
      id,
      projectRoot,
      createdAt: now,
      updatedAt: now,
      messages: [],
      summary: null,
      turns: [],
      todo: { tasks: [], nextId: 1 },
    }

    const file = join(directory, 'snapshot.json')
    await writeSnapshot(file, sessionSchema, state)

    return createHandle(state, file, release)
  } catch (error) {
    await release()
    throw error
  }
}

export async function openSession(project: string, inputId: string): Promise<SessionHandle> {
  const id = idSchema.parse(inputId)
  const projectRoot = await realpath(project)
  const directory = join(sessionsDirectory(projectRoot), id)

  // 不存在的会话不能因为获取锁而被悄悄创建。
  await realpath(directory)

  const release = await acquireSessionLock(directory)

  try {
    const file = join(directory, 'snapshot.json')
    const state = await readSnapshot(file, sessionSchema)

    if (!state) throw new Error('会话快照不存在')
    checkIdentity(state, id, projectRoot)

    return createHandle(state, file, release)
  } catch (error) {
    await release()
    throw error
  }
}

export type SessionEntry =
  | {
      id: string
      ok: true
      updatedAt: string
      messageCount: number
      todoCount: number
    }
  | {
      id: string
      ok: false
      error: string
    }

export async function listSessions(project: string): Promise<SessionEntry[]> {
  const projectRoot = await realpath(project)
  const parent = sessionsDirectory(projectRoot)

  const entries = await readdir(parent, {
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  })

  const rows: SessionEntry[] = []

  for (const entry of entries) {
    if (!entry.isDirectory() || !idSchema.safeParse(entry.name).success) {
      continue
    }

    try {
      const state = await readSnapshot(join(parent, entry.name, 'snapshot.json'), sessionSchema)

      if (!state) throw new Error('会话快照不存在')
      checkIdentity(state, entry.name, projectRoot)

      rows.push({
        id: state.id,
        ok: true,
        updatedAt: state.updatedAt,
        messageCount: state.messages.length,
        todoCount: state.todo.tasks.length,
      })
    } catch (error) {
      rows.push({
        id: entry.name,
        ok: false,
        error: error instanceof Error ? error.message : '读取失败',
      })
    }
  }

  return rows.sort((a, b) => a.id.localeCompare(b.id))
}

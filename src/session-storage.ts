import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ZodType } from 'zod'

// Note: 会话快照与恢复边界 — 见 .agents/notes/proposed/architecture/2026-09-20-practical-mini-agent-v1.md

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

/** 只有文件不存在才返回 null；读取错误和损坏不能伪装成空会话。 */
export async function readSnapshot<T>(file: string, schema: ZodType<T>): Promise<T | null> {
  let raw: string

  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null
    throw error
  }

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('会话快照不是合法 JSON；已保留原文件')
  }

  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error('会话快照格式不兼容或内容损坏；已保留原文件')
  }
  return parsed.data
}

/**
 * 调用方必须持有会话锁，并顺序 await 保存。
 * schema 必须描述 JSON 数据；replaceFile 是故障测试的窄注入点。
 */
export async function writeSnapshot<T>(
  file: string,
  schema: ZodType<T>,
  value: T,
  replaceFile: typeof rename = rename
): Promise<void> {
  const data = schema.parse(value)
  const text = JSON.stringify(data, null, 2)
  if (text === undefined) throw new Error('快照无法序列化')

  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)

  try {
    try {
      await handle.writeFile(text + '\n', 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    // 临时文件必须与目标同目录；不先删除旧快照。
    await replaceFile(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

/**
 * 文件存在即表示占用；必须在读取快照前获取，并持有到会话关闭。
 * 崩溃遗留锁不自动抢占：先确认原进程退出，再人工清理。
 */
export async function acquireSessionLock(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'session.lock')
  const handle = await open(file, 'wx', 0o600).catch((error: unknown) => {
    if (hasCode(error, 'EEXIST')) {
      throw new Error('会话已被占用或存在遗留锁，请先核查原进程')
    }
    throw error
  })

  try {
    try {
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })
      )
    } finally {
      await handle.close()
    }
  } catch (error) {
    await unlink(file)
    throw error
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    await unlink(file)
  }
}

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { guardPathWrite } from '../guard.js'
import { ToolPreparationError, type PreparedAction, type Tool } from './types.js'

// Note: 批准绑定基准和候选，提交前复查 — 见 .agents/notes/implemented/feature/2026-09-21-safe-incremental-editing.md
const MAX_EDIT_BYTES = 1024 * 1024
export const fingerprint = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')
const hashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .describe('read_file 返回的整文件 SHA-256')
const editParams = z.object({
  path: z.string().min(1),
  expected_sha256: hashSchema,
  old_text: z.string().min(1).describe('必须在原文件中精确且唯一出现，保留换行和空白'),
  new_text: z.string().describe('替换后的文本；空字符串表示删除这段内容'),
})
const createParams = z.object({ path: z.string().min(1), content: z.string() })

function checkText(data: Buffer): string {
  if (data.length > MAX_EDIT_BYTES) throw new Error('文件或候选内容超过 1 MiB 编辑上限')
  const text = data.toString('utf8')
  if (text.includes('\0') || !Buffer.from(text).equals(data))
    throw new Error('只支持无 NUL 的 UTF-8 文本')
  return text
}

async function baseFile(abs: string) {
  const info = await lstat(abs)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new Error('只允许普通、非链接文件')
  if (info.size > MAX_EDIT_BYTES) throw new Error('文件超过 1 MiB 编辑上限')
  const data = await readFile(abs)
  return {
    text: checkText(data),
    hash: fingerprint(data),
    identity: `${info.dev}:${info.ino}:${info.mode}`,
    mode: info.mode,
  }
}

/** 单次精确替换的完整变化区间；不裁掉任何增删行，最多保留三行前后文。 */
export function editDiff(path: string, before: string, after: string): string {
  const a = before.split('\n'),
    b = after.split('\n')
  let start = 0,
    endA = a.length,
    endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  const from = Math.max(0, start - 3)
  const tail = Math.min(3, a.length - endA)
  const show = (prefix: string, lines: string[]) =>
    lines.map((line) => prefix + line.replace(/\r/g, '␍'))
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${from + 1},${endA - from + tail} +${from + 1},${endB - from + tail} @@`,
    ...show(' ', a.slice(from, start)),
    ...show('-', a.slice(start, endA)),
    ...show('+', b.slice(start, endB)),
    ...show(' ', a.slice(endA, endA + tail)),
    `末尾换行: ${before.endsWith('\n') ? '有' : '无'} → ${after.endsWith('\n') ? '有' : '无'}（␍ 表示 CR）`,
  ].join('\n')
}

async function assertAbsent(abs: string) {
  try {
    await lstat(abs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error('目标已存在；write_file 只允许新建，请读取后使用 edit_file')
}

async function prepareChange(
  path: string,
  content?: string,
  edit?: z.infer<typeof editParams>
): Promise<PreparedAction> {
  try {
    const abs = await guardPathWrite(path)
    const base = edit ? await baseFile(abs) : undefined
    let candidate = content ?? ''
    if (base && edit) {
      if (base.hash !== edit.expected_sha256)
        throw new Error('文件指纹冲突，请重新 read_file 后生成修改')
      const index = base.text.indexOf(edit.old_text)
      if (index < 0) throw new Error('旧文本零匹配，拒绝修改')
      if (base.text.indexOf(edit.old_text, index + 1) !== -1)
        throw new Error('旧文本多次匹配，请增加上下文到唯一匹配')
      candidate =
        base.text.slice(0, index) + edit.new_text + base.text.slice(index + edit.old_text.length)
      if (candidate === base.text) throw new Error('新旧内容相同，无需修改')
    } else {
      await assertAbsent(abs)
    }
    if (checkText(Buffer.from(candidate)) !== candidate)
      throw new Error('候选包含无法无损编码为 UTF-8 的字符')
    const newHash = fingerprint(candidate)
    const approvalKey = JSON.stringify([abs, base?.hash ?? 'absent', newHash])
    const preview = [
      base ? `增量编辑: ${abs}` : `新建文件: ${abs}`,
      `基准 SHA-256: ${base?.hash ?? '不存在'}`,
      `候选 SHA-256: ${newHash}`,
      editDiff(abs, base?.text ?? '', candidate),
    ].join('\n')
    return Object.freeze({
      approvalKey,
      preview,
      execute: async (context = {}) => {
        context.signal?.throwIfAborted()
        const recheck = async () => {
          await guardPathWrite(abs)
          if (base) {
            const current = await baseFile(abs)
            if (current.hash !== base.hash || current.identity !== base.identity) {
              throw new Error('批准后文件发生冲突，拒绝写入；请重新读取、生成 diff 并批准')
            }
          } else await assertAbsent(abs)
        }
        let temp: string | undefined
        try {
          await recheck()
          await mkdir(dirname(abs), { recursive: true })
          await recheck()
          temp = join(dirname(abs), `.mini-agent-edit-${randomUUID()}.tmp`)
          const handle = await open(temp, 'wx', base?.mode ?? 0o666)
          try {
            await handle.writeFile(candidate, 'utf8')
            if (base) await handle.chmod(base.mode)
            await handle.sync()
          } finally {
            await handle.close()
          }
          await recheck()
          context.signal?.throwIfAborted()
          if (base) await rename(temp, abs)
          else await link(temp, abs) // 排他发布完整文件，不覆盖批准后出现的同名文件。
          return `已${base ? '编辑' : '新建'} ${abs}\nSHA-256: ${newHash}`
        } catch (error) {
          context.signal?.throwIfAborted()
          return `错误:文件未提交 (${error instanceof Error ? error.message : String(error)})`
        } finally {
          if (temp)
            await unlink(temp).catch((error) => {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            })
        }
      },
    } satisfies PreparedAction)
  } catch (error) {
    throw new ToolPreparationError(
      `错误:拒绝文件变更 (${error instanceof Error ? error.message : String(error)})`
    )
  }
}

function unprepared(): never {
  throw new Error('文件变更必须先准备候选内容、预览并批准')
}

export const editFileTool: Tool<z.infer<typeof editParams>> = {
  name: 'edit_file',
  schema: editParams,
  needsApproval: true,
  cacheApproval: false,
  description:
    '对项目内已有 UTF-8 文件做一次精确替换（最大 1 MiB）。先 read_file 获取整文件 SHA-256 和旧文本；旧文本必须唯一匹配。展示完整变化 diff 并批准后提交；冲突时重新读取，禁止退回完整覆盖或 shell 绕过。',
  prepare: (args) => prepareChange(args.path, undefined, args),
  execute: unprepared,
}

export const writeFileTool: Tool<z.infer<typeof createParams>> = {
  name: 'write_file',
  schema: createParams,
  needsApproval: true,
  cacheApproval: false,
  description:
    '仅在项目内创建不存在的 UTF-8 文件（最大 1 MiB），自动创建父目录，展示完整内容并批准。已有文件必须 read_file 后用 edit_file；不允许覆盖、敏感路径或链接路径。',
  prepare: (args) => prepareChange(args.path, args.content),
  execute: unprepared,
}

import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { ROOT, guardPathRead } from '../guard.js'
import type { Tool } from './types.js'

const PREVIEW_LINES = 20

/**
 * 单文件最大整读字节数。比这大就拒绝,避免把整个大文件读进内存。
 *
 * 简化策略:真要流式读大文件得换 fd + 流接口。
 * 现在只需挡住几百 MB 日志 / 构建产物这类"整读必然出事"的用法,
 * 并让模型明确知道是"太大读不了",而不是看到一串被截断的乱码。
 */
export const MAX_READ_BYTES = 5 * 1024 * 1024

function readLimit(): number {
  const v = Number(process.env.MINI_AGENT_MAX_READ_MB)
  if (!Number.isFinite(v) || v <= 0) return MAX_READ_BYTES
  return v * 1024 * 1024
}

// ─────────────────────────── read_file ───────────────────────────

const readParams = z.object({
  path: z.string().min(1, '路径不能为空').describe('相对项目根目录的文件路径，例如 "src/agent.ts"'),
  offset: z.number().int().min(1).default(1)
    .describe('从第几行开始读（从 1 数起）。默认 1。文件很长需要分段时，用 offset 跳到指定行。'),
  limit: z.number().int().min(1).max(2000).default(500)
    .describe('最多读多少行。默认 500。一页没读完时，用 offset 翻页继续。'),
})

export const readFileTool: Tool<z.infer<typeof readParams>> = {
  name: 'read_file',
  description:
    '读取项目目录内一个文本文件的一段内容（按行分页）。默认读前 500 行。' +
    '文件很长时一次读不完，必须靠 offset 和 limit 分段翻页，直到看到"[已到文件末尾]"。' +
    '只能读项目目录以内的文件，读不到 .env、.git、node_modules、私钥文件和超过上限的大文件。' +
    '要修改文件时，必须先用本工具读出原内容，不要凭记忆重写。',
  schema: readParams,

  execute: async ({ path, offset, limit }) => {
    const abs = resolve(ROOT, path)

    const guarded = await guardPathRead(abs)
    if (!guarded.ok) return guarded.message

    try {
      const st = await stat(abs)
      if (st.size > readLimit()) {
        return `错误:拒绝读取 "${path}" —— 文件 ${st.size} 字节,超过单次读取上限 ${Math.floor(readLimit() / 1024 / 1024)}MB。` +
          `可以用 run_bash 的 ls / head / tail 处理这类大文件,或用 grep 搜索它的关键内容。`
      }

      const all = await readFile(abs, 'utf8')
      // 按行切开。结尾的换行符会多产出一个空串,先剥掉,否则行号会虚高 1
      const lines = all.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

      const total = lines.length

      // offset 超出文件末尾:这一页是空的,明确告诉模型"没有了",别让它空等
      if (offset > total) {
        return `[文件 ${path} 共 ${total} 行，第 ${offset} 行已超出范围，没有更多内容]`
      }

      const end = Math.min(offset + limit - 1, total)
      const content = lines.slice(offset - 1, end).join('\n')
      const done = end >= total
      const note =
        `[文件 ${path} 第 ${offset}~${end} 行 / 共 ${total} 行` +
        (done ? '，已到文件末尾]' : '，后面还有内容，需要就加大 offset 继续读]')

      return note + '\n' + content
    } catch (e) {
      return `错误:无法读取 "${path}"(${String(e)})。可以先用 run_bash 执行 ls 确认路径。`
    }
  },
}


// ─────────────────────────── write_file ───────────────────────────

const writeParams = z.object({
  path: z.string().min(1, '路径不能为空').describe('要写入的文件路径,例如 "hello.txt"'),
  content: z
    .string()
    .describe('要写入的完整文件内容。这是完整覆盖而不是追加,所以必须给出文件的全部内容。'),
})

export const writeFileTool: Tool<z.infer<typeof writeParams>> = {
  name: 'write_file',
  description:
    '把内容写入一个文件。这是完整覆盖:文件已存在时原有内容会全部丢失。要在已有文件基础上修改,必须先 read_file 读出来,把修改后的完整内容整个写回。父目录不存在会自动创建。',
  schema: writeParams,
  needsApproval: true,

  preview: ({ path, content }) => {
    const abs = resolve(ROOT, path)
    const exists = existsSync(abs)
    const lines = content.split('\n')
    const omitted = lines.length - PREVIEW_LINES

    return [
      exists ? `⚠️  覆盖已存在的文件:${abs}` : `新建文件:${abs}`,
      exists ? '   (原有内容将全部丢失,且无法撤销)' : '',
      `共 ${lines.length} 行 / ${content.length} 字符`,
      '',
      lines.slice(0, PREVIEW_LINES).join('\n'),
      omitted > 0 ? `…(省略后 ${omitted} 行)` : '',
    ]
      .filter(Boolean)
      .join('\n')
  },

  execute: async ({ path, content }) => {
    const abs = resolve(ROOT, path)
    try {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
      return `已写入 ${abs}(${content.length} 字符)`
    } catch (e) {
      return `错误:写入 "${path}" 失败(${String(e)})`
    }
  },
}

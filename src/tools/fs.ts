import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { ROOT, guardPathRead } from '../guard.js'
import { fingerprint } from './edit.js'
import type { Tool } from './types.js'
export { writeFileTool } from './edit.js'

const readParams = z.object({
  path: z.string().min(1).describe('相对项目根目录的文件路径'),
  offset: z.number().int().min(1).default(1).describe('起始行号，从 1 开始'),
  limit: z.number().int().min(1).max(2000).default(500).describe('最多读取行数'),
})

export function createReadFileTool(maxReadBytes: number): Tool<z.infer<typeof readParams>> {
  return {
    name: 'read_file', schema: readParams,
    description: '按行读取项目内文本文件，返回整文件 SHA-256，供 edit_file 校验基准版本。未到末尾时用 offset 翻页。拒绝项目外、敏感文件和超限文件。修改前必须先读取。内容保留原始换行。',
    execute: async ({ path, offset, limit }) => {
      const abs = resolve(ROOT, path)
      const guarded = await guardPathRead(abs)
      if (!guarded.ok) return guarded.message
      try {
        const info = await stat(abs)
        if (!info.isFile()) return '错误:目标不是普通文件'
        if (info.size > maxReadBytes) return `错误:文件超过单次读取上限 ${maxReadBytes} 字节`
        const data = await readFile(abs)
        if (data.length > maxReadBytes) return '错误:文件超过单次读取上限'
        const all = data.toString('utf8')
        if (all.includes('\0') || !Buffer.from(all).equals(data)) return '错误:只支持无 NUL 的 UTF-8 文本'
        const hash = `SHA-256: ${fingerprint(data)}`
        const lines = all.split('\n')
        if (lines.at(-1) === '') lines.pop()
        if (offset > lines.length) return `${hash}\n[文件 ${path} 共 ${lines.length} 行，第 ${offset} 行已超出范围，已到文件末尾]`
        const end = Math.min(offset + limit - 1, lines.length)
        return `${hash}\n[文件 ${path} 第 ${offset}~${end} 行 / 共 ${lines.length} 行，${end >= lines.length ? '已到文件末尾' : '后面还有内容，需要就加大 offset 继续读'}]\n` + lines.slice(offset - 1, end).join('\n')
      } catch (error) {
        return `错误:无法读取 "${path}" (${String(error)})`
      }
    },
  }
}

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types.js'

const ROOT = process.cwd()
const PREVIEW_LINES = 20

/**
 * 判断解析后的绝对路径是否仍在项目目录内。
 *
 * 为什么不用字符串前缀比较(abs.startsWith(ROOT)):
 * ROOT = /home/me/app 时,/home/me/app-backup 也以它开头,会被误判成"在里面"。
 * relative() 的返回值天然表达了包含关系:在里面就是 "src/a.ts",
 * 在外面必然以 ".." 开头(或在 Windows 跨盘符时返回绝对路径)。
 */
function insideRoot(abs: string): boolean {
  const rel = relative(ROOT, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 读到就会进 context,进了 context 就可能被后续某条命令带出去 */
const BLOCKED = [
  { re: /(^|[/\\])\.env($|\.)/i, why: '.env 里通常放着 API key' },
  { re: /(^|[/\\])\.git([/\\]|$)/i, why: '.git 内部对象不该进上下文' },
  { re: /(^|[/\\])node_modules([/\\]|$)/i, why: 'node_modules 会瞬间撑爆上下文' },
  { re: /(^|[/\\])id_rsa|\.(pem|key)$/i, why: '这看起来是私钥' },
]

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
    '只能读项目目录以内的文件，读不到 .env、.git、node_modules 和私钥文件。' +
    '要修改文件时，必须先用本工具读出原内容，不要凭记忆重写。',
  schema: readParams,

  execute: async ({ path, offset, limit }) => {
    const abs = resolve(ROOT, path)

    if (!insideRoot(abs)) {
      return `错误：拒绝读取 "${path}"。它解析后指向 ${abs}，在项目目录(${ROOT})之外。只能读项目目录以内的文件。`
    }

    const hit = BLOCKED.find((b) => b.re.test(abs))
    if (hit) {
      return `错误：拒绝读取 "${path}" —— ${hit.why}。请换一个文件，不要尝试绕过这条限制。`
    }

    try {
      const all = await readFile(abs, 'utf8')
      // 按行切开。结尾的换行符会多产出一个空串，先剥掉，否则行号会虚高 1
      const lines = all.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

      const total = lines.length

      // offset 超出文件末尾：这一页是空的，明确告诉模型"没有了"，别让它空等
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
      return `错误：无法读取 "${path}"(${String(e)})。可以先用 run_bash 执行 ls 确认路径。`
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
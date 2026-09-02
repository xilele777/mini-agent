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
  path: z
    .string()
    .min(1, '路径不能为空')
    .describe('相对项目根目录的文件路径,例如 "src/agent.ts"'),
})

export const readFileTool: Tool<z.infer<typeof readParams>> = {
  name: 'read_file',
  description:
    '读取项目目录内一个文本文件的完整内容。只能读项目目录以内的文件,读不到 .env、.git、node_modules 和私钥文件。要修改文件时,必须先用本工具读出原内容,不要凭记忆重写。',
  schema: readParams,

  // ↓ 注意这里没有 needsApproval。只读工具不打断用户,
  //   代价是它必须自己在 execute 里守住边界 —— 少一道人工审查,就得多一道代码检查。
  execute: async ({ path }) => {
    const abs = resolve(ROOT, path)

    if (!insideRoot(abs)) {
      return `错误:拒绝读取 "${path}"。它解析后指向 ${abs},在项目目录(${ROOT})之外。只能读项目目录以内的文件。`
    }

    const hit = BLOCKED.find((b) => b.re.test(abs))
    if (hit) {
      return `错误:拒绝读取 "${path}" —— ${hit.why}。请换一个文件,不要尝试绕过这条限制。`
    }

    try {
      return await readFile(abs, 'utf8')
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
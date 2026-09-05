// ─────────────────────────────────────────────────────────────
// grep_tool_source.md —— 复制此文件全部内容到 src/tools/grep.ts
// （本文件放在 docs/ 纯粹是交付手段:src/ 由学习者亲自粘贴）
// ─────────────────────────────────────────────────────────────

// src/tools/grep.ts
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool } from './types.js'

const ROOT = process.cwd()

/** 这些目录里多半是第三方依赖或构建产物，搜了也是噪音，直接跳过 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.cache'])

/** 超过这个大小的文件不整读：把整个文件读进来，比我们要找的那一行贵得多 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** 命中行输出时，单行最多保留多少字符，超出的省略 */
const MAX_LINE = 160

interface Hit {
  file: string
  line: number
  text: string
}

/**
 * 把简单的 glob("*.ts") 翻译成正则。只支持 * 通配符 —— 够用，而且不假装自己很完整。
 */
function globToRegex(glob: string): RegExp {
  // 只转义 * 之外的元字符,保留 * 当通配符。
  // 陷阱:如果转义字符类里含 *,* 先变成 \*,后面 replace(/\*/g) 就找不到裸 * 可还原,
  // 结果 glob 退化成匹配字面量星号,永远搜不到文件。
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$')
}

/**
 * 递归走目录，把每个文件交给 onFile。
 * 读不到、够不着的条目直接跳过 —— 搜索要的是尽力而为，不是报错中断。
 */
async function walk(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, onFile)
    } else if (entry.isFile()) {
      await onFile(full)
    }
  }
}

const grepParams = z.object({
  pattern: z.string().min(1, '要搜的内容不能为空')
    .describe('正则表达式，例如 "esbuild"，或想搜魔法数字就写 "^0.28"'),
  path: z.string().default('.').describe('从哪个目录开始递归搜，默认项目根目录 "."'),
  glob: z.string().min(1).optional().describe('只搜文件名匹配这个 glob 的文件，例如 "*.ts"。'),
  maxResults: z.number().int().min(1).max(200).default(50)
    .describe('最多返回多少条匹配，默认 50。命中很多时把它调小，或把 pattern 收窄。'),
})

export const grepTool: Tool<z.infer<typeof grepParams>> = {
  name: 'search_files',
  description:
    '在项目目录内按行搜索文本，返回"相对路径:行号:该行内容"列表。' +
    '这是定位代码、符号、关键字的第一选择：先搜出目标行号，再用 read_file 的 offset 精准读那几行，不要整页整页地扫大文件。' +
    'pattern 是正则表达式。自动跳过 .git、node_modules、dist 等目录和大于 2MB 的文件。' +
    '结果有上限，没搜到或结果太多时，换更宽或更窄的关键词再试。',
  schema: grepParams,

  execute: async ({ pattern, path, glob, maxResults }) => {
    // 正则不合法：把错误当作结果返回，而不是抛出。
    // throw 会走 executeCall 的兜底，语义是"工具坏了"；这里只是"模型这次正则说错了"，
    // 应当原样反馈给模型，让它自己改 —— 这就是工具诚实原则。
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return `错误:"${pattern}" 不是合法的正则表达式(${String(e)})。注意 * 在正则里要写成 .*，想搜字面量句号要写成 \\.`
    }

    const root = resolve(ROOT, path)

    // 和 read_file 同一套「必须在项目内」的边界检查，防止把整个磁盘翻出来
    const rel = relative(ROOT, root)
    if (isAbsolute(rel) || rel.startsWith('..')) {
      return `错误:"${path}" 解析到 ${root}，在项目目录(${ROOT})之外。只能搜项目目录以内。`
    }

    const fileFilter = glob ? globToRegex(glob) : null
    const hits: Hit[] = []
    // 两个循环共用同一个"满了就停"的判断
    const done = () => hits.length >= maxResults

    await walk(root, async (file) => {
      if (done()) return

      const relPath = relative(ROOT, file) // 输出相对路径：比绝对路径短一截，省 token
      if (fileFilter && !fileFilter.test(basename(file))) return // glob 比的是文件名,不是绝对路径

      let st
      try {
        st = await stat(file)
      } catch {
        return
      }
      if (st.size > MAX_FILE_BYTES) return

      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        return // 二进制文件按 utf8 读出来是乱码，跳过
      }

      const lines = text.split('\n')
      for (let i = 0; i < lines.length && !done(); i++) {
        const line = lines[i]
        if (line !== undefined && re.test(line)) {
          const show = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line
          hits.push({ file: relPath, line: i + 1, text: show })
        }
      }
    })

    if (hits.length === 0) {
      const scope = glob ? `(文件名匹配 "${glob}")` : ''
      return `[没有在 "${path}" 里${scope}搜到匹配 "${pattern}" 的内容。不要凭记忆猜，可以换更宽的关键词再搜一次]`
    }

    const out = hits.map((h) => `${h.file}:${h.line}:${h.text}`)
    out.push('', '格式为 "相对路径:行号:该行内容"。')
    if (done()) {
      out.push(`[已达上限 ${maxResults} 条，结果更多。把 pattern 收窄，或把 maxResults 调小，再搜一次]`)
    } else {
      out.push(`共 ${hits.length} 条匹配。拿到目标行号后，用 read_file 带 offset 精准读那几行。`)
    }
    return out.join('\n')
  },
}
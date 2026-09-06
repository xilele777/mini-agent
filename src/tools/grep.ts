import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { guardDirRead, isBlocked, ROOT } from '../guard.js'
import type { Tool } from './types.js'

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

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$')
}

/**
 * 递归走目录,把每个文件交给 onFile。
 * 读不到、够不着的条目直接跳过 —— 搜索要的是尽力而为,不是报错中断。
 *
 * symlink / junction 条目一律不跟随:只认 isDirectory() / isFile(),
 * 两者对链接条目都返回 false(Windows 实测)。既不会顺着项目里的链接
 * 把项目外内容拉进搜索结果,也省了逐条目 realpath 的开销。
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
  path: z.string().default('.').describe('从哪个目录开始递归搜索，默认项目根目录 "."。注意这里是文件夹不是文件。'),
  glob: z.string().min(1).optional().describe('只搜文件名匹配这个 glob 的文件，例如 "*.ts"。'),
  maxResults: z.number().int().min(1).max(200).default(50)
    .describe('最多返回多少条匹配，默认 50。命中很多时把它调小，或把 pattern 收窄。'),
})

export const grepTool: Tool<z.infer<typeof grepParams>> = {
  name: 'search_files',
  description:
    '在项目目录内按行搜索文本，返回"相对路径:行号:该行内容"列表。' +
    '这是定位代码、符号、关键字的第一选择：先搜出目标行号，再用 read_file 的 offset 精准读那几行，不要整页整页地扫大文件。' +
    'pattern 是正则表达式，不要加引号。自动跳过 .git、node_modules、dist、.env 等敏感目录/文件，大于 2MB 的文件，以及符号链接。' +
    '结果有上限，没搜到或结果太多时，换更宽或更窄的关键词再试。',
  schema: grepParams,

  execute: async ({ pattern, path, glob, maxResults }) => {
    // 正则不合法:把错误当结果返回,而不是抛出。
    // throw 会走 executeCall 的兜底,语义是"工具坏了";这里只是"模型这次正则说错了",
    // 应原样反馈让模型自己改 —— 工具诚实原则。
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch (e) {
      return `错误:"${pattern}" 不是合法的正则表达式(${String(e)})。注意 * 在正则里要写成 .*，想搜字面量句号要写成 \\.`
    }

    const root = resolve(ROOT, path)
    const guard = await guardDirRead(root)
    if (!guard.ok) return guard.message

    const fileFilter = glob ? globToRegex(glob) : null
    const hits: Hit[] = []
    // 两个循环共用同一个"满了就停"的判断
    const done = () => hits.length >= maxResults

    await walk(root, async (file) => {
      if (done()) return

      // 搜索会把文件内容原样送进模型上下文,所以套和 read_file 同一套封锁名单
      // (.env / .git / node_modules / 私钥)。read_file 拒读的,search_files 不能是旁路。
      if (isBlocked(file)) return

      const relPath = relative(ROOT, file) // 输出相对路径：比绝对路径短一截，省 token
      if (fileFilter && !fileFilter.test(basename(file))) return

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

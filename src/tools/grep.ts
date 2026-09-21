import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { guardDirRead, guardPathRead, isBlocked, ROOT } from '../guard.js'
import type { Tool } from './types.js'

/** 搜索时跳过的版本库、依赖和构建产物目录。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.next', '.cache'])

/** 搜索采用整文件读取，通过大小上限限制单文件的内存开销。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** 命中行输出时，单行最多保留多少字符，超出的省略 */
const MAX_LINE = 160

interface Hit {
  file: string
  line: number
  text: string
}

/** 文件名过滤仅支持 * 通配，其余正则特殊字符按字面量匹配。 */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + escaped.replace(/\*/g, '.*') + '$')
}

/**
 * 递归遍历普通目录与文件，读取目录失败时跳过该目录。
 * Dirent 的链接条目不会进入 isDirectory / isFile 分支，因此不会主动跟随链接。
 */
async function walk(dir: string, onFile: (file: string) => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    signal?.throwIfAborted()
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !isBlocked(full) && (await guardDirRead(full)).ok) await walk(full, onFile, signal)
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

  execute: async ({ pattern, path, glob, maxResults }, context) => {
    const signal = context?.signal
    signal?.throwIfAborted()
    // 将非法正则作为可修正的参数问题返回，便于模型调整表达式。
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
    // 达到上限后停止读取文件及匹配行；walk 仍会遍历剩余目录项。
    const done = () => hits.length >= maxResults

    await walk(root, async (file) => {
      if (done()) return

      // 与单文件读取共用敏感路径规则，避免通过搜索返回被拦截文件的内容。
      if (isBlocked(file) || !(await guardPathRead(file)).ok) return

      const relPath = relative(ROOT, file) // 返回相对路径，便于后续定位与分段读取。
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
        text = await readFile(file, { encoding: 'utf8', signal })
      } catch {
        signal?.throwIfAborted()
        return // 读取失败时跳过该文件；此处没有额外的二进制格式检测。
      }

      const lines = text.split('\n')
      for (let i = 0; i < lines.length && !done(); i++) {
        const line = lines[i]
        if (line !== undefined && re.test(line)) {
          const show = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line
          hits.push({ file: relPath, line: i + 1, text: show })
        }
      }
    }, signal)
    signal?.throwIfAborted()

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

import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Tool } from './types.js'

const execAsync = promisify(exec)

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 4000

/**
 * Windows 上 exec 默认走 cmd.exe,但模型生成 bash 命令的质量远高于 cmd,
 * 而这台机器装了 Git Bash。如果你的 PATH 里没有 bash,把这里改成
 * undefined(并给 SHELL 标上 `string | undefined` 类型)以使用系统默认。
 */
const SHELL =
  process.platform === 'win32'
    ? 'D:\\Git\\bin\\bash.exe'
    : '/bin/sh'

/**
 * 这张表不用来阻止,只用来提醒 —— 增强人的判断力,不替代人的判断。
 *
 * 为什么不阻止:shell 的能力不在命令名里,在组合子里。
 *   echo hi > f.txt       白名单上的 echo,写了文件
 *   cat a && rm b         白名单上的 cat,删了文件
 *   node -e "…rmSync…"    白名单上的 node,递归删目录
 * 要真做白名单就得解析 shell 语法,那是在写一个 shell。
 *
 * 宁可多提醒:正则会把 "=>" 当成重定向报出来,这种误报无害;漏报才有害。
 */
const DANGER = [
  { re: /\brm\b/, why: '删除文件' },
  { re: /\b(del|rmdir|rd)\b/i, why: '删除文件或目录' },
  { re: /(?:^|\s)-delete(?:\s|$)/i, why: '删除匹配到的文件' },
  { re: /\b(mv|move)\b/, why: '移动或重命名,可能覆盖已有文件' },
  { re: />/, why: '输出重定向,会写入或覆盖文件' },
  { re: /\bsudo\b/, why: '提权执行' },
  { re: /\b(curl|wget)\b/, why: '访问网络,可能外泄数据或下载可执行内容' },
  { re: /\|\s*(ba)?sh\b/, why: '把下载来的内容直接交给 shell 执行' },
  { re: /\bgit\s+(push|reset\s+--hard|clean)\b/, why: 'git 破坏性操作,可能不可撤销' },
  { re: /\bnpm\s+publish\b/, why: '发布到 npm,不可撤销' },
  { re: /\bchmod\b/, why: '修改文件权限' },
]

const bashParams = z.object({
  command: z.string().min(1, '命令不能为空').describe('要执行的 shell 命令,例如 "ls -la src"'),
})

function clip(text: string, label: string): string {
  if (!text) return ''
  const body =
    text.length > MAX_OUTPUT
      ? `${text.slice(0, MAX_OUTPUT)}\n…(${label} 共 ${text.length} 字符,已截断)`
      : text
  return `${label}:\n${body}`
}

export const bashTool: Tool<z.infer<typeof bashParams>> = {
  name: 'run_bash',
  description:
    `在用户本机执行一条 shell 命令,返回 stdout / stderr / 退出码。` +
    `当前系统 ${process.platform},工作目录 ${process.cwd()},shell 是 ${SHELL}。` +
    `命令最多执行 ${TIMEOUT_MS / 1000} 秒。` +
    `禁止执行需要交互输入的命令(vim、top、不带 -y 的安装命令等),它们只会卡到超时。` +
    `读文件优先用 read_file,写文件优先用 write_file,不要用 cat / echo 重定向代替。`,
  schema: bashParams,
  needsApproval: true,

  preview: ({ command }) => {
    const hits = DANGER.filter((d) => d.re.test(command))

    // 命令绝不截断:被截掉的后半句可能正好是 "&& rm -rf build"
    const lines = [`$ ${command}`]

    if (hits.length > 0) {
      lines.push('', '⚠️  检测到危险模式:')
      for (const h of hits) lines.push(`   · ${h.why}`)
      lines.push('   (这只是提醒。没被提醒 ≠ 安全,请自己读一遍命令)')
    }
    return lines.join('\n')
  },

  execute: async ({ command }) => {
    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        shell: SHELL,
      })
      const parts = [clip(stdout, 'stdout'), clip(stderr, 'stderr')].filter(Boolean)
      return parts.length > 0 ? parts.join('\n\n') : '命令执行成功,没有任何输出。'
    } catch (e) {
      // exec 在退出码非零时会 reject。但"非零退出"是有用的信息不是故障
      // (grep 没匹配到就返回 1),必须原样交给模型自己判断,不能当异常吞掉。
      const err = e as {
        code?: number
        killed?: boolean
        stdout?: string
        stderr?: string
      }

      if (err.killed) {
        return `错误:命令超过 ${TIMEOUT_MS / 1000} 秒仍未结束,已被强制终止。它可能在等待交互输入。`
      }

      return [
        `命令以非零状态退出(exit code ${err.code ?? '未知'})`,
        clip(err.stdout ?? '', 'stdout'),
        clip(err.stderr ?? '', 'stderr'),
      ]
        .filter(Boolean)
        .join('\n\n')
    }
  },
}
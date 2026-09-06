import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Tool } from './types.js'

const execAsync = promisify(exec)

const TIMEOUT_MS = 30_000
const MAX_OUTPUT = 4000
// exec 的 stdout/stderr 缓冲上限:只作"进程不被超大输出憋死"的保护,
// 常见输出远小于它;一旦命中就会被当作"被中断"如实报告(见 execute 的 catch)。
const MAX_BUFFER = 1024 * 1024

/**
 * Windows 上 exec 默认走 cmd.exe,但模型写 bash 的质量远高于 cmd,
 * 而这台机器装了 Git Bash。如果你的 PATH 里没有 bash,把这里改成
 * undefined(并把类型标成 `string | undefined`)以退回系统默认 shell。
 */
const SHELL = process.platform === 'win32' ? 'D:\\Git\\bin\\bash.exe' : '/bin/sh'

/**
 * 这张表不阻止,只提醒 —— 增强人的判断,不替代人的判断。
 *
 * 为什么不阻止:shell 的能力不在命令名里,在组合里。
 *   echo hi > f.txt        白名单上的 echo,写了文件
 *   cat a && rm b          白名单上的 cat,删了文件
 *   node -e "…rmSync…"     白名单上的 node,递归删目录
 * 真做白名单就得解析 shell 语法,那是在写一个 shell。
 *
 * 宁可多提醒:正则把 "=>" 当重定向报出来,这种误报无害;漏报才有害。
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

/**
 * exec 在 stdout/stderr 超过 maxBuffer(1 MiB)时不会 reject 成"普通非零退出",
 * 而是抛一个 code 为字符串的 ERR_CHILD_PROCESS_STDIO_MAXBUFFER 错误,
 * 并把这个流截到 1 MiB 后**终止子进程**。此时:
 *   · 把 err.code 当退出码打印,会输出 "exit code ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
 *   · 真实命令可能已被中断,副作用没跑完,不能假装它正常结束。
 * 所以单独识别它,明确告知模型"输出太大,执行被中断",并把已捕获的部分尽量带上。
 */
function isMaxBufferError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

/** 报告一次被中断的执行:退出码 + 已捕获的头/尾输出。 */
function reportInterrupted(err: { code?: string; killed?: boolean; stdout?: string; stderr?: string }): string {
  const label = err.killed ? '已超时' : '异常中断'
  return [
    `错误:命令输出超过缓冲上限(1 MiB)或执行异常,已被强制终止(${label})。`,
    '它可能仍在执行,也可能已产生部分副作用 —— 不要把它当成正常完成。',
    '如果想看大输出的头尾,可用 tail/head 或加管道截取后重试。',
    clip(err.stdout ?? '', '已捕获的 stdout'),
    clip(err.stderr ?? '', '已捕获的 stderr'),
  ]
    .filter(Boolean)
    .join('\n\n')
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
        maxBuffer: MAX_BUFFER,
        shell: SHELL,
      })
      const parts = [clip(stdout, 'stdout'), clip(stderr, 'stderr')].filter(Boolean)
      return parts.length > 0 ? parts.join('\n\n') : '命令执行成功,没有任何输出。'
    } catch (e) {
      // exec 在退出码非零时 reject。但"非零退出"是有用的信息,不是故障
      // (grep 没匹配到就返回 1),必须原样交给模型自己判断,不能当异常吞掉。
      // 例外:输出超缓冲(maxBuffer)不是普通非零退出,单独识别并如实报告"被中断"。
      if (isMaxBufferError(e)) {
        return reportInterrupted(
          e as { code?: string; killed?: boolean; stdout?: string; stderr?: string }
        )
      }

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
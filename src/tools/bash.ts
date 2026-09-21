import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Tool } from './types.js'
import type { AppConfig } from '../config.js'

const execAsync = promisify(exec)

const MAX_OUTPUT = 4000
// stdout / stderr 各自的缓冲上限；超限按中断处理，区别于普通非零退出。
const MAX_BUFFER = 1024 * 1024


/**
 * 批准预览中的风险提示规则，不负责解析或阻止 shell 命令。
 * 重定向、管道和解释器调用会组合出额外行为；正则可能误报或漏报，仍需检查完整命令。
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

/** 给输出附加标签，超长时保留开头并注明原始字符数。 */
function clip(text: string, label: string): string {
  if (!text) return ''
  const body =
    text.length > MAX_OUTPUT
      ? `${text.slice(0, MAX_OUTPUT)}\n…(${label} 共 ${text.length} 字符,已截断)`
      : text
  return `${label}:\n${body}`
}

/**
 * 缓冲超限使用字符串错误码，不能当作普通数字退出码解释。
 * exec 会尝试终止子进程，已捕获输出和可能发生的部分副作用仍需向模型说明。
 */
function isMaxBufferError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
}

/** 生成缓冲超限说明，并附带已捕获 stdout / stderr 的开头。 */
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

export function createBashTool(
  config: Pick<AppConfig, 'shell' | 'commandTimeoutMs'>
): Tool<z.infer<typeof bashParams>> {
  const SHELL = config.shell
  const TIMEOUT_MS = config.commandTimeoutMs

  return {
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

    // 批准预览展示完整命令，避免省略会影响用户判断的后续操作。
    const lines = [
  `工作目录: ${process.cwd()}`,
  `shell: ${SHELL}`,
  `$ ${command}`,
]

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
        windowsHide: true,
      })
      const parts = [clip(stdout, 'stdout'), clip(stderr, 'stderr')].filter(Boolean)
      return parts.length > 0 ? parts.join('\n\n') : '命令执行成功,没有任何输出。'
    } catch (e) {
      // 非零退出时仍保留退出信息及输出，供模型判断具体原因。
      // 缓冲超限需要先单独识别，避免把字符串错误码当作普通退出码。
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
}

import { runCommand } from '../command.js'
import { ROOT } from '../guard.js'
import { z } from 'zod'
import type { Tool } from './types.js'
import type { AppConfig } from '../config.js'

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

export function createBashTool(
  config: Pick<AppConfig, 'shell' | 'commandTimeoutMs'>
): Tool<z.infer<typeof bashParams>> {
  const SHELL = config.shell
  const TIMEOUT_MS = config.commandTimeoutMs

  return {
    name: 'run_bash',
    description:
      `在用户本机执行一条 shell 命令,返回 stdout / stderr / 退出码。` +
      `当前系统 ${process.platform},工作目录 ${ROOT},shell 是 ${SHELL}。` +
      `命令最多执行 ${TIMEOUT_MS / 1000} 秒。` +
      `禁止执行需要交互输入的命令(vim、top、不带 -y 的安装命令等),它们只会卡到超时。` +
      `读文件优先用 read_file,修改已有文件用 edit_file，新建文件用 write_file,不要用 cat / echo 重定向代替。`,
    schema: bashParams,
    needsApproval: true,

    preview: ({ command }) => {
      const hits = DANGER.filter((d) => d.re.test(command))

      // 批准预览展示完整命令，避免省略会影响用户判断的后续操作。
      const lines = [`工作目录: ${ROOT}`, `shell: ${SHELL}`, `$ ${command}`]

      if (hits.length > 0) {
        lines.push('', '⚠️  检测到危险模式:')
        for (const h of hits) lines.push(`   · ${h.why}`)
        lines.push('   (这只是提醒。没被提醒 ≠ 安全,请自己读一遍命令)')
      }
      return lines.join('\n')
    },

    execute: ({ command }, context) =>
      runCommand({
        command,
        shell: SHELL,
        cwd: ROOT,
        timeoutMs: TIMEOUT_MS,
        ...(context?.signal ? { signal: context.signal } : {}),
      }),
  }
}

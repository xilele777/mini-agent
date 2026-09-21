import { readFileSync } from 'node:fs'
import { z } from 'zod'

// Note: CLI 契约与编译交付 — 见 .agents/notes/implemented/process/2026-09-22-cli-delivery.md
export const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

export const help = `mini-agent ${version}

用法：mini-agent [选项]
      npm run dev -- [选项]

无参数                 在当前目录新建交互会话
--help, -h             显示帮助，无需模型配置
--version, -v          显示版本
--sessions             列出当前目录的会话，无需模型配置
--resume UUID          恢复会话，等待新输入，不重放旧动作
--doctor [--online]    检查配置与 shell；--online 额外请求模型（可能计费）

在需要操作的项目目录运行；从该目录读取 .env 并保存 .mini-agent/。
必填：OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL。
Windows 还需 MINI_AGENT_SHELL（Git Bash 绝对路径）；Linux/macOS 默认 /bin/sh。
交互输入 exit / quit 或关闭输入流退出，Ctrl+C 取消并退出。
退出码：0 正常退出；1 启动/诊断/存储错误；2 参数错误；130 用户取消。
任务状态见每轮输出与会话记录，REPL 正常退出不代表所有任务成功。`

export class UsageError extends Error {}

export type Command =
  | { kind: 'new' | 'help' | 'version' | 'sessions' }
  | { kind: 'resume'; id: string }
  | { kind: 'doctor'; online: boolean }

export function parseArgs(args: readonly string[]): Command {
  if (!args.length) return { kind: 'new' }
  if (args.length === 1) {
    switch (args[0]) {
      case '--help': case '-h': return { kind: 'help' }
      case '--version': case '-v': return { kind: 'version' }
      case '--sessions': return { kind: 'sessions' }
      case '--doctor': return { kind: 'doctor', online: false }
    }
  }
  if (args.length === 2 && args[0] === '--resume' && z.uuid().safeParse(args[1]).success) {
    return { kind: 'resume', id: args[1]! }
  }
  if (args.length === 2 && args[0] === '--doctor' && args[1] === '--online') {
    return { kind: 'doctor', online: true }
  }
  throw new UsageError('参数无效；使用 --help 查看用法，--resume 需要有效 UUID。')
}

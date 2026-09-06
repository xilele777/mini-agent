import type { Tool } from './tools/types.js'
import { ask } from './ui.js'

/**
 * 本次进程内"相同动作不再询问"的缓存。
 *
 * key 不是工具名,而是 工具名 + 完整参数:
 * 对 run_bash 的 pwd 按 a,不会让 rm -rf src 也免确认。
 * 只存内存,重启即失效,不落盘。
 */
const alwaysAllowed = new Set<string>()

const LINE = '─'.repeat(64)

function actionKey(tool: Tool, args: unknown): string {
  return `${tool.name}\u0000${JSON.stringify(args)}`
}

export async function requestApproval(tool: Tool, args: unknown): Promise<boolean> {
  const key = actionKey(tool, args)

  if (alwaysAllowed.has(key)) {
    console.log(`  (${tool.name} 的相同动作本次会话已被允许,跳过确认)`)
    return true
  }

  // 工具没写 preview 时兜底:默认得可用,不能因为没有 preview 就崩
  const detail = tool.preview ? tool.preview(args) : JSON.stringify(args, null, 2)

  console.log(`\n${LINE}`)
  console.log(`⚠️  Agent 请求执行:${tool.name}`)
  console.log(LINE)
  console.log(detail)
  console.log(LINE)

  for (;;) {
    const answer = (
      await ask('批准?  [y] 允许   [n] 拒绝   [a] 相同动作不再询问 > ')
    )
      .trim()
      .toLowerCase()

    if (answer === 'y' || answer === 'yes') {
      return true
    }

    if (answer === 'n' || answer === 'no') {
      return false
    }

    if (answer === 'a') {
      alwaysAllowed.add(key)
      console.log('  已记住:本次会话内相同动作不再询问(重启即失效)')
      return true
    }

    console.log('  请输入 y / n / a')
  }
}

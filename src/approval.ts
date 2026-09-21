import type { Tool, PreparedAction, ExecutionContext } from './tools/types.js'
import { ask } from './ui.js'

/**
 * 缓存当前进程中按 a 批准的具体动作，重启后失效。
 * 键由工具名和校验后完整参数的 JSON 组成，参数不同的动作仍需批准。
 */
const alwaysAllowed = new Set<string>()

export function clearApprovals(): void {
  alwaysAllowed.clear()
}

const LINE = '─'.repeat(64)

/** 使用 JSON.stringify 的原始键顺序，尚未做参数规范化。 */
function actionKey(tool: Tool, args: unknown): string {
  return `${tool.name}\u0000${JSON.stringify(args)}`
}

export async function requestApproval(
  tool: Tool, args: unknown,
  context: ExecutionContext & { action?: PreparedAction } = {},
): Promise<boolean> {
  context.signal?.throwIfAborted()
  const key = context.action?.approvalKey ?? actionKey(tool, args)
  const cacheable = tool.cacheApproval !== false

  if (cacheable && alwaysAllowed.has(key)) {
    console.log(`  (${tool.name} 的相同动作本次会话已被允许,跳过确认)`)
    return true
  }

  // 缺少专用预览时展示完整参数，用户仍能检查具体动作。
  const detail = context.action?.preview ?? (tool.preview ? tool.preview(args) : JSON.stringify(args, null, 2))

  console.log(`\n${LINE}`)
  console.log(`⚠️  Agent 请求执行:${tool.name}`)
  console.log(LINE)
  // 防止文件或命令中的终端控制码隐藏真正的批准内容。
  console.log(detail.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`))
  console.log(LINE)

  for (;;) {
    const answer = (
      await ask(cacheable
        ? '批准?  [y] 允许   [n] 拒绝   [a] 相同动作不再询问 > '
        : '批准本次文件变更?  [y] 允许   [n] 拒绝 > ', context.signal)
    )
      .trim()
      .toLowerCase()

    if (answer === 'y' || answer === 'yes') {
      return true
    }

    if (answer === 'n' || answer === 'no') {
      return false
    }

    if (answer === 'a' && cacheable) {
      alwaysAllowed.add(key)
      console.log('  已记住:本次会话内相同动作不再询问(重启即失效)')
      return true
    }

    console.log(cacheable ? '  请输入 y / n / a' : '  请输入 y / n')
  }
}

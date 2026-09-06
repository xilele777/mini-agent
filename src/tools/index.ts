import { z } from 'zod'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'
import { readFileTool, writeFileTool } from './fs.js'
import { bashTool } from './bash.js'
import { grepTool } from './grep.js'
import { addTodoTool, listTodoTool, removeTodoTool } from './todo.js'

// ↓↓↓ 新增工具时，全项目唯一需要改的一行 ↓↓↓
const ALL_TOOLS: Tool[] = [calcTool, timeTool, readFileTool, writeFileTool, bashTool, grepTool, addTodoTool, listTodoTool, removeTodoTool]

const REGISTRY = new Map(ALL_TOOLS.map((t) => [t.name, t]))

/** 遍历注册表，生成 create() 需要的 tools 参数 */
export function getToolSchemas(): ChatCompletionTool[] {
  return ALL_TOOLS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
    },
  }))
}

/** 关卡一~三的结果。可辨识联合，和 zod 的 safeParse 同构 */
export type PreparedCall =
  | { ok: true; tool: Tool; args: unknown }
  | { ok: false; error: string }

/**
 * 关卡一~三:查表 / JSON.parse / schema 校验。
 * 纯同步、零 throw、零副作用 —— 正因如此,才能放心在人工确认"之前"调用。
 */
export function prepareCall(name: string, rawArgs: string): PreparedCall {
  // 关卡一:这个工具存在吗
  const tool = REGISTRY.get(name)
  if (!tool) {
    const available = [...REGISTRY.keys()].join('、')
    return { ok: false, error: `错误:不存在名为 "${name}" 的工具。可用工具只有:${available}` }
  }

  // 关卡二:参数是合法 JSON 吗
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return { ok: false, error: `错误:工具 "${name}" 的参数不是合法的 JSON。收到的是:${rawArgs}` }
  }

  // 关卡三:参数符合这个工具自己的 schema 吗
  const result = tool.schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join(';')
    return { ok: false, error: `错误:工具 "${name}" 的参数不合法 —— ${detail}。收到的参数是:${rawArgs}` }
  }

  return { ok: true, tool, args: result.data }
}

/** 关卡四:真正执行。到这里参数已通过校验、也已拿到人的批准 */
export async function executeCall(tool: Tool, args: unknown): Promise<string> {
  try {
    return await tool.execute(args)
  } catch (e) {
    return `错误:工具 "${tool.name}" 执行时抛出异常:${String(e)}`
  }
}

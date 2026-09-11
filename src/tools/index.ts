import { z } from 'zod'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'
import { readFileTool, writeFileTool } from './fs.js'
import { bashTool } from './bash.js'
import { grepTool } from './grep.js'
import { addTodoTool, listTodoTool, removeTodoTool, loadTodoFromDisk } from './todo.js'
import { finishTaskTool, askUserTool, pauseTaskTool } from './control.js'

// 新工具在本模块导入并加入注册表；agent.ts 通过通用接口调用，不导入具体工具。
const ALL_TOOLS: Tool[] = [
  calcTool,
  timeTool,
  readFileTool,
  writeFileTool,
  bashTool,
  grepTool,
  addTodoTool,
  listTodoTool,
  removeTodoTool,
  finishTaskTool,
  askUserTool,
  pauseTaskTool,
]

const REGISTRY = new Map(ALL_TOOLS.map((t) => [t.name, t]))

/** 从工具定义生成模型请求所需的工具名称、描述与参数 schema。 */
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

/** 准备成功时返回工具及校验后的参数，失败时返回可回填的错误说明。 */
export type PreparedCall =
  | { ok: true; tool: Tool; args: unknown }
  | { ok: false; error: string }

/**
 * 在批准前同步完成查表、JSON 解析与 schema 校验，不执行工具。
 * 常见输入错误作为结果返回；成功时使用校验后的参数，包括 schema 填入的默认值。
 */
export function prepareCall(name: string, rawArgs: string): PreparedCall {
  // 先定位工具，才能使用它自己的参数 schema。
  const tool = REGISTRY.get(name)
  if (!tool) {
    const available = [...REGISTRY.keys()].join('、')
    return { ok: false, error: `错误:不存在名为 "${name}" 的工具。可用工具只有:${available}` }
  }

  // 模型给出的参数是字符串，先解析 JSON，再检查业务约束。
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return { ok: false, error: `错误:工具 "${name}" 的参数不是合法的 JSON。收到的是:${rawArgs}` }
  }

  // 使用 safeParse 将校验失败作为普通输入分支处理。
  const result = tool.schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join(';')
    return { ok: false, error: `错误:工具 "${name}" 的参数不合法 —— ${detail}。收到的参数是:${rawArgs}` }
  }

  return { ok: true, tool, args: result.data }
}

/** 调用方完成准备及必要批准后执行工具，将执行异常转成可回填的说明。 */
export async function executeCall(tool: Tool, args: unknown): Promise<string> {
  try {
    return await tool.execute(args)
  } catch (e) {
    return `错误:工具 "${tool.name}" 执行时抛出异常:${String(e)}`
  }
}

/**
 * 由 main 在接收输入前调用一次，恢复有持久化状态的工具。
 * 当前恢复 todo；新增工具的启动逻辑也集中在注册表，保持主循环与具体工具解耦。
 */
export async function initTools(): Promise<void> {
  await loadTodoFromDisk()
}

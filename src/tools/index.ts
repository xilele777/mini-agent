import { z } from 'zod'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'

// ↓↓↓ 新增工具时，全项目唯一需要改的一行 ↓↓↓
const ALL_TOOLS: Tool[] = [calcTool, timeTool]

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

export async function runTool(name: string, rawArgs: string): Promise<string> {
  // 关卡一：这个工具存在吗
  const tool = REGISTRY.get(name)
  if (!tool) {
    const available = [...REGISTRY.keys()].join('、')
    return `错误：不存在名为 "${name}" 的工具。可用工具只有：${available}`
  }

  // 关卡二：参数是合法 JSON 吗
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArgs)
  } catch {
    return `错误：工具 "${name}" 的参数不是合法的 JSON。收到的是：${rawArgs}`
  }

  // 关卡三：参数符合这个工具自己的 schema 吗
  const result = tool.schema.safeParse(parsed)
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('；')
    return `错误：工具 "${name}" 的参数不合法 —— ${detail}。收到的参数是：${rawArgs}`
  }

  // 关卡四：执行本身可能抛异常
  try {
    return await tool.execute(result.data)
  } catch (e) {
    return `错误：工具 "${name}" 执行时抛出异常：${String(e)}`
  }
}
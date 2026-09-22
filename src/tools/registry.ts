import { z } from 'zod'
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions'
import type { Tool, ExecutionContext } from './types.js'

// Note: 工具集合同时约束 schema 与调用准备 — 见 .agents/notes/implemented/architecture/2026-08-31-tool-registry-boundary.md

export type PreparedCall = { ok: true; tool: Tool; args: unknown } | { ok: false; error: string }

export interface ToolRegistry {
  getToolSchemas(): ChatCompletionFunctionTool[]
  prepareCall(name: string, rawArgs: string): PreparedCall
}

/**
 * 从一组明确给出的工具创建能力集合。
 * schema 暴露和调用准备共用同一张表，未注册工具不能进入执行流程。
 */
export function createToolRegistry(tools: readonly Tool[]): ToolRegistry {
  const registry = new Map<string, Tool>()

  for (const tool of tools) {
    if (registry.has(tool.name)) {
      throw new Error(`工具注册表包含重复名称："${tool.name}"`)
    }

    registry.set(tool.name, tool)
  }

  function getToolSchemas(): ChatCompletionFunctionTool[] {
    return [...registry.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.schema) as Record<string, unknown>,
      },
    }))
  }

  function prepareCall(name: string, rawArgs: string): PreparedCall {
    const tool = registry.get(name)

    if (!tool) {
      const available = [...registry.keys()].join('、')

      return {
        ok: false,
        error: `错误:不存在名为 "${name}" 的工具。` + `可用工具只有:${available || '无'}`,
      }
    }

    let parsed: unknown

    try {
      parsed = JSON.parse(rawArgs)
    } catch {
      return {
        ok: false,
        error: `错误:工具 "${name}" 的参数不是合法的 JSON。` + `收到的是:${rawArgs}`,
      }
    }

    const result = tool.schema.safeParse(parsed)

    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => {
          const path = issue.path.join('.') || '(根)'
          return `${path}: ${issue.message}`
        })
        .join(';')

      return {
        ok: false,
        error: `错误:工具 "${name}" 的参数不合法 —— ${detail}。` + `收到的参数是:${rawArgs}`,
      }
    }

    return {
      ok: true,
      tool,
      args: result.data,
    }
  }

  return {
    getToolSchemas,
    prepareCall,
  }
}

/** 调用方完成准备及必要批准后执行工具。 */
export async function executeCall(
  tool: Tool,
  args: unknown,
  context?: ExecutionContext
): Promise<string> {
  try {
    context?.signal?.throwIfAborted()
    const result = await tool.execute(args, context)
    context?.signal?.throwIfAborted()
    return result
  } catch (error) {
    context?.signal?.throwIfAborted()
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'RunBudgetError'))
      throw error
    return `错误:工具 "${tool.name}" 执行时抛出异常:${String(error)}`
  }
}

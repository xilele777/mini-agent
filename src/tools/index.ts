import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'
import { readFileTool, writeFileTool } from './fs.js'
import { bashTool } from './bash.js'
import { grepTool } from './grep.js'
import { addTodoTool, listTodoTool, removeTodoTool, loadTodoFromDisk } from './todo.js'
import { finishTaskTool, askUserTool, pauseTaskTool } from './control.js'

import { createToolRegistry } from './registry.js'
import { delegateTaskTool } from './delegate.js'
export { executeCall } from './registry.js'
export type { PreparedCall } from './registry.js'

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
  delegateTaskTool,
]

const MAIN_REGISTRY = createToolRegistry(ALL_TOOLS)
export const { getToolSchemas, prepareCall } = MAIN_REGISTRY

export async function initTools(): Promise<void> {
  await loadTodoFromDisk()
}

import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'
import { writeFileTool } from './fs.js'
import { grepTool } from './grep.js'
import {
  addTodoTool,
  listTodoTool,
  removeTodoTool,
  loadTodoFromDisk,
} from './todo.js'
import {
  finishTaskTool,
  askUserTool,
  pauseTaskTool,
} from './control.js'
import { createToolRegistry } from './registry.js'

export function createMainRegistry(tools: {
  readFile: Tool
  bash: Tool
  delegate: Tool
}) {
  return createToolRegistry([
    calcTool,
    timeTool,
    tools.readFile,
    writeFileTool,
    tools.bash,
    grepTool,
    addTodoTool,
    listTodoTool,
    removeTodoTool,
    finishTaskTool,
    askUserTool,
    pauseTaskTool,
    tools.delegate,
  ])
}

export async function initTools(): Promise<void> {
  await loadTodoFromDisk()
}
import type { Tool } from './types.js'
import { calcTool } from './calc.js'
import { timeTool } from './time.js'
import { writeFileTool } from './fs.js'
import { grepTool } from './grep.js'
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
  todo?: Tool[]
}) {
  return createToolRegistry([
    calcTool,
    timeTool,
    tools.readFile,
    writeFileTool,
    tools.bash,
    grepTool,
    ...(tools.todo ?? []),
    finishTaskTool,
    askUserTool,
    pauseTaskTool,
    tools.delegate,
  ])
}
import type { AppConfig } from './config.js'
import { createModelStream } from './llm.js'
import {
  runSubAgent,
  type RunSubAgentOptions,
} from './subagent.js'
import type {
  CreateTurnStream,
  RunTurnOptions,
} from './turn.js'
import { createMainRegistry } from './tools/index.js'
import { createToolRegistry } from './tools/registry.js'
import { createReadFileTool } from './tools/fs.js'
import { createBashTool } from './tools/bash.js'
import { createDelegateTaskTool } from './tools/delegate.js'
import { grepTool } from './tools/grep.js'
import { calcTool } from './tools/calc.js'
import { timeTool } from './tools/time.js'
import type { Tool } from './tools/types.js'

export function createRuntime(
  config: AppConfig,
  createStream: CreateTurnStream = createModelStream(config),
  todoTools: Tool[] = []
) {
  const readFile = createReadFileTool(config.maxReadBytes)

  const subagentOptions: RunSubAgentOptions = {
    createStream,
    contextBudget: config.contextBudget,
    maxIterations: config.subagentMaxIterations,
    registry: createToolRegistry([
      readFile,
      grepTool,
      calcTool,
      timeTool,
    ]),
  }

  const registry = createMainRegistry({
    readFile,
    bash: createBashTool(config),
    delegate: createDelegateTaskTool((task, context) =>
      runSubAgent(task, {
        ...subagentOptions,
        ...(context?.signal ? { signal: context.signal } : {}),
        ...(context?.control ? { control: context.control } : {}),
        onProgress: (message) => {
          console.log(`  [sub] ${message}`)
        },
      })
    ),
    todo: todoTools,
  })

  const turnOptions: RunTurnOptions = {
    runLimits: config.runLimits,
    createStream,
    contextBudget: config.contextBudget,
    registry,
    maxIterations: config.maxIterations,
  }

  return { turnOptions, subagentOptions }
}

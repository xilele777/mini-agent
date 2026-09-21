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

/** 组装依赖，不启动 REPL、不恢复 todo、不请求模型。 */
export function createRuntime(
  config: AppConfig,
  createStream: CreateTurnStream = createModelStream(config)
) {
  const readFile = createReadFileTool(config.maxReadBytes)

  const subagentOptions: RunSubAgentOptions = {
    createStream,
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
    delegate: createDelegateTaskTool((task) =>
      runSubAgent(task, {
        ...subagentOptions,
        onProgress: (message) => {
          console.log(`  [sub] ${message}`)
        },
      })
    ),
  })

  const turnOptions: RunTurnOptions = {
    createStream,
    registry,
    maxIterations: config.maxIterations,
  }

  return { turnOptions, subagentOptions }
}
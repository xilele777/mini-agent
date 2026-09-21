import { initTools } from './tools/index.js'
import { ask, closeUI } from './ui.js'
import { trimHistory } from './context.js'
import type { HistoryMessage } from './context.js'
import {
  runTurn,
  SYSTEM_PROMPT,
} from './turn.js'
import 'dotenv/config'
import { ConfigError, loadConfig } from './config.js'
import { createRuntime } from './runtime.js'

function isAbortError(error: unknown): boolean {
  if (
    error instanceof Error &&
    error.name === 'AbortError'
  ) {
    return true
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error
  ) {
    return error.code === 'ABORT_ERR'
  }

  return false
}

async function main(): Promise<void> {
  try {
    // 通过注册表恢复工具状态，完成后才接收第一条用户请求。
    const config = loadConfig(process.env, process.platform)
    const runtime = createRuntime(config)

    await initTools()

    /*
     * 对话历史跨 REPL 输入保留。
     * todo 等工具状态由相应工具模块管理。
     */
    let messages: HistoryMessage[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
    ]

    console.log(
      'mini-agent 已启动。输入 exit 退出。'
    )
    console.log(`工作目录:${process.cwd()}\n`)

    for (;;) {
      const input = (
        await ask('你> ')
      ).trim()

      if (input === '') continue

      if (
        input === 'exit' ||
        input === 'quit'
      ) {
        break
      }

      /*
       * 上一轮结束后按 startsTurn 整轮裁剪，
       * 然后再加入本轮的真实用户输入。
       */
      messages = trimHistory(messages)

      /*
       * 保存加入本轮输入前的位置。
       * runTurn 抛出异常时，从这里回滚消息历史。
       */
      const checkpoint = messages.length

      messages.push({
        role: 'user',
        content: input,
        startsTurn: true,
      })

      try {
        await runTurn(messages, runtime.turnOptions)
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }

        console.error(
          `\n[本轮失败] ${String(error)}`
        )

        /*
         * 这里只回滚对话历史。
         * 已经发生的文件、shell 或 todo 副作用不会撤销。
         */
        messages.length = checkpoint

        console.error(
          '已回滚本轮,历史保持干净,可直接重新提问'
        )
      }

      console.log()
    }

    console.log('再见。')
  } catch (error) {
    if (isAbortError(error)) {
      console.log('\n已取消,退出。')
      return
    }

    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }

    throw error
  } finally {
    closeUI()
  }
}

void main().catch(() => {
  console.error('启动失败，请运行 npm run doctor 检查配置。')
  process.exitCode = 1
})
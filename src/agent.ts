import 'dotenv/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ask, closeUI } from './ui.js'
import { ConfigError, loadConfig } from './config.js'
import { createRuntime } from './runtime.js'
import {
  createSession,
  openSession,
  listSessions,
  type SessionHandle,
} from './session.js'
import {
  describeSession,
  recoverSession,
  runSessionTurn,
} from './session-runner.js'
import { createTodoTools } from './tools/todo.js'
import { clearApprovals } from './approval.js'

async function main() {
  let session: SessionHandle | undefined

  try {
    const args = process.argv.slice(2)

    if (args.length === 1 && args[0] === '--sessions') {
      for (const row of await listSessions(process.cwd())) {
        console.log(row.ok
          ? `${row.id}  消息 ${row.messageCount} / 待办 ${row.todoCount}`
          : `${row.id}  无法打开：${row.error}`)
      }
      return
    }

    const resume = args.length === 2 && args[0] === '--resume'
      ? args[1]
      : undefined

    if (args.length && !resume) {
      throw new Error('用法：npm run dev -- [--sessions | --resume UUID]')
    }

    // 先校验配置；配置错误不创建会话文件。
    const config = loadConfig(process.env, process.platform)

    session = resume
      ? await openSession(process.cwd(), resume)
      : await createSession(process.cwd())

    clearApprovals()
    await recoverSession(session)

    const runtime = createRuntime(
      config,
      undefined,
      createTodoTools(session)
    )

    if (existsSync(join(process.cwd(), '.mini-agent-todo.json'))) {
      console.log('发现旧项目 todo 文件；已保留，不自动导入新会话。')
    }

    console.log('mini-agent 已启动。输入 exit 退出。')
    console.log(describeSession(session))
    console.log('等待你的新指令；恢复不会自动执行旧调用。')

    for (;;) {
      const input = (await ask('你> ')).trim()

      if (!input) continue
      if (input === 'exit' || input === 'quit') break

      const result = await runSessionTurn(
        session,
        input,
        runtime.turnOptions
      )

      console.log(`[本轮 ${result.status}] ${result.reason}`)

      if (result.status === 'cancelled') break
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.name === 'AbortError' ||
        ('code' in error && error.code === 'ABORT_ERR')
      )
    ) {
      console.log('已取消。')
      return
    }

    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }

    throw error
  } finally {
    try {
      await session?.close()
    } finally {
      closeUI()
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
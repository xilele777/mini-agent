import 'dotenv/config'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ask, closeUI, InputClosedError, setInterruptHandler } from './ui.js'
import { help, parseArgs, UsageError, version } from './cli.js'
import { runDoctor } from './doctor.js'
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
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  setInterruptHandler(cancel)

  try {
    const command = parseArgs(process.argv.slice(2))
    if (command.kind === 'help') { console.log(help); return }
    if (command.kind === 'version') { console.log(version); return }
    if (command.kind === 'doctor') { await runDoctor(command.online, controller.signal); return }

    if (command.kind === 'sessions') {
      const rows = await listSessions(process.cwd())
      if (!rows.length) console.log('当前项目没有会话。')
      for (const row of rows) {
        console.log(row.ok
          ? `${row.id}  消息 ${row.messageCount} / 待办 ${row.todoCount}`
          : `${row.id}  无法打开：${row.error}`)
      }
      return
    }

    // 先校验配置；配置错误不创建会话文件。
    const config = loadConfig(process.env, process.platform)

    session = command.kind === 'resume'
      ? await openSession(process.cwd(), command.id)
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
      const input = (await ask('你> ', controller.signal)).trim()

      if (!input) continue
      if (input === 'exit' || input === 'quit') break

      const result = await runSessionTurn(
        session,
        input,
        { ...runtime.turnOptions, signal: controller.signal }
      )

      console.log(`[本轮 ${result.status}] ${result.reason}`)

      if (result.status === 'cancelled') {
        process.exitCode = 130
        break
      }
    }
  } catch (error) {
    if (error instanceof InputClosedError) return
    if (error instanceof UsageError) {
      console.error(error.message)
      process.exitCode = 2
      return
    }
    if (
      error instanceof Error &&
      (
        error.name === 'AbortError' ||
        ('code' in error && error.code === 'ABORT_ERR')
      )
    ) {
      console.log('已取消。')
      process.exitCode = 130
      return
    }

    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }

    throw error
  } finally {
    process.off('SIGINT', cancel)
    setInterruptHandler(undefined)
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

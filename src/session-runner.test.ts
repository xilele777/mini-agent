import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { createSession, openSession, type SessionHandle } from './session.js'
import { recoverSession, runSessionTurn } from './session-runner.js'
import { createTodoTools } from './tools/todo.js'
import { createToolRegistry } from './tools/registry.js'
import type { Tool } from './tools/types.js'
import { CheckpointError, type RunTurnOptions } from './turn.js'
import { testConfig } from './test-runtime.js'

async function* response(names: string[]): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 't',
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        delta: {
          role: 'assistant',
          tool_calls: names.map((name, index) => ({
            index,
            id: `call-${index}`,
            type: 'function',
            function: {
              name,
              arguments: name === 'add_todo' ? '{"title":"独立任务"}' : '{}',
            },
          })),
        },
      },
    ],
  }
}

const done: Tool = {
  name: 'finish_task',
  description: 'finish',
  schema: z.object({}),
  execute: () => '完成',
  endsTurn: 'completed',
}

function options(tools: Tool[], batches: string[][]): RunTurnOptions {
  let index = 0

  return {
    registry: createToolRegistry([...tools, done]),
    maxIterations: 3,
    contextBudget: testConfig.contextBudget,
    createStream: async () => {
      const batch = batches[index++]
      if (!batch) throw new Error('缺少模拟响应')
      return response(batch)
    },
    write: () => {},
    log: () => {},
  }
}

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mini-session-wire-'))

  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--crash') {
  const root = process.argv[3]!
  const session = await openSession(root, process.argv[4]!)

  await runSessionTurn(
    session,
    '中断测试',
    options(
      [
        {
          name: 'crash',
          description: 'crash',
          schema: z.object({}),
          execute: async () => {
            await writeFile(join(root, 'marker.txt'), '执行一次')
            process.exit(17) // 模拟执行后、结果保存前进程直接退出。
          },
        },
      ],
      [['crash', 'finish_task']]
    )
  )
} else {
  test('CLI 可以离线列出会话，恢复后等待输入而不请求模型', async () => {
    await fixture(async (root) => {
      const session = await createSession(root)
      const id = session.snapshot.id
      await session.close()

      const entry = fileURLToPath(new URL('./agent.ts', import.meta.url))
      const env = {
        ...process.env,
        DOTENV_CONFIG_PATH: join(root, 'missing.env'),
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
        OPENAI_MODEL: 'test-model',
        MINI_AGENT_SHELL: process.execPath,
      }

      const listed = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), entry, '--sessions'],
        {
          cwd: root,
          env: { ...env, OPENAI_MODEL: '' },
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        }
      )

      assert.equal(listed.status, 0, listed.stderr)
      assert.ok(listed.stdout.includes(id))

      const resumed = spawnSync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), entry, '--resume', id],
        {
          cwd: root,
          env,
          input: 'exit\n',
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        }
      )

      assert.equal(resumed.status, 0, resumed.stderr)
      assert.match(resumed.stdout, /等待你的新指令/)

      const reopened = await openSession(root, id)
      assert.equal(reopened.snapshot.turns.length, 0)
      await reopened.close()
    })
  })

  test('主轮与会话 todo 一起保存，重开不丢消息和结果', async () => {
    await fixture(async (root) => {
      const session = await createSession(root)
      const id = session.snapshot.id

      try {
        const result = await runSessionTurn(
          session,
          '记录任务',
          options(createTodoTools(session), [['add_todo'], ['finish_task']])
        )

        assert.equal(result.status, 'completed')
        assert.equal(session.snapshot.todo.tasks.length, 1)
      } finally {
        await session.close()
      }

      const reopened = await openSession(root, id)

      try {
        assert.equal(reopened.snapshot.version, 3)
        assert.equal(reopened.snapshot.turns[0]?.status, 'completed')
        assert.deepEqual(
          reopened.snapshot.turns[0]?.actions.map((a) => a.state),
          ['returned', 'returned']
        )
        assert.equal(reopened.snapshot.todo.tasks[0]?.title, '独立任务')

        const raw = JSON.stringify(reopened.snapshot)
        await recoverSession(reopened)
        assert.equal(JSON.stringify(reopened.snapshot), raw)
      } finally {
        await reopened.close()
      }
    })
  })

  test('执行前保存失败不执行，恢复为未执行', async () => {
    await fixture(async (root) => {
      const real = await createSession(root)
      let count = 0

      const proxy: SessionHandle = {
        get snapshot() {
          return real.snapshot
        },
        close: () => real.close(),
        update: (change) =>
          real.update(async (draft) => {
            await change(draft)
            if (draft.turns.at(-1)?.actions.some((a) => a.state === 'started')) {
              throw new Error('故障')
            }
          }),
      }

      try {
        await assert.rejects(
          runSessionTurn(
            proxy,
            '执行',
            options(
              [
                {
                  name: 'work',
                  description: '',
                  schema: z.object({}),
                  execute: () => {
                    count++
                    return 'ok'
                  },
                },
              ],
              [['work']]
            )
          ),
          CheckpointError
        )

        assert.equal(count, 0)
        await recoverSession(real)
        assert.equal(real.snapshot.turns.at(-1)?.actions[0]?.state, 'not_executed')
      } finally {
        await real.close()
      }
    })
  })

  test('结果保存失败保留 started，恢复为不确定且不重放', async () => {
    await fixture(async (root) => {
      const real = await createSession(root)
      let count = 0

      const proxy: SessionHandle = {
        get snapshot() {
          return real.snapshot
        },
        close: () => real.close(),
        update: (change) =>
          real.update(async (draft) => {
            await change(draft)
            if (draft.turns.at(-1)?.actions.some((a) => a.state === 'returned')) {
              throw new Error('故障')
            }
          }),
      }

      try {
        await assert.rejects(
          runSessionTurn(
            proxy,
            '执行',
            options(
              [
                {
                  name: 'work',
                  description: '',
                  schema: z.object({}),
                  execute: () => {
                    count++
                    return '已改变'
                  },
                },
              ],
              [['work', 'finish_task']]
            )
          ),
          CheckpointError
        )

        assert.equal(count, 1)

        await recoverSession(real)

        assert.deepEqual(
          real.snapshot.turns.at(-1)?.actions.map((a) => a.state),
          ['uncertain', 'not_executed']
        )

        const raw = JSON.stringify(real.snapshot)
        await recoverSession(real)

        assert.equal(JSON.stringify(real.snapshot), raw)
        assert.equal(count, 1)
      } finally {
        await real.close()
      }
    })
  })

  test('坏的工具配对与动作记录不能写入快照', async () => {
    await fixture(async (root) => {
      const session = await createSession(root)

      try {
        await assert.rejects(
          session.update((s) => {
            s.messages.push({
              role: 'tool',
              tool_call_id: 'orphan',
              content: '伪造结果',
            })
          })
        )

        await assert.rejects(
          session.update((s) => {
            s.messages.push({
              role: 'user',
              content: 'task',
              startsTurn: true,
            })
            s.turns.push({
              id: randomUUID(),
              start: 0,
              status: 'completed',
              reason: '',
              actions: [
                {
                  messageIndex: 1,
                  callId: 'missing',
                  state: 'started',
                  observation: null,
                },
              ],
            })
          })
        )

        assert.equal(session.snapshot.messages.length, 0)
      } finally {
        await session.close()
      }
    })
  })

  test('预算充足时保留超过六个旧轮，磁盘保留全部原始历史', async () => {
    await fixture(async (root) => {
      const session = await createSession(root)
      const counts: number[] = []

      try {
        for (let i = 0; i < 9; i++) {
          const o = options([], [['finish_task']])
          const create = o.createStream

          o.createStream = async (request) => {
            counts.push(request.messages.filter((m) => m.role === 'user').length)
            return create(request)
          }

          await runSessionTurn(session, `第 ${i} 轮`, o)
        }

        assert.equal(session.snapshot.turns.length, 9)
        assert.equal(session.snapshot.messages.filter((m) => m.role === 'user').length, 9)
        assert.equal(counts.at(-1), 9)
      } finally {
        await session.close()
      }
    })
  })

  test('真实子进程退出遗留锁，核查退出后恢复不重放', async () => {
    await fixture(async (root) => {
      const initial = await createSession(root)
      const id = initial.snapshot.id
      await initial.close()

      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), '--crash', root, id],
        {
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        }
      )

      assert.equal(child.status, 17, child.stderr)
      assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), '执行一次')

      await assert.rejects(openSession(root, id), /占用/)

      // spawnSync 已确认这个受控子进程退出，才清理它的遗留锁。
      await rm(join(root, '.mini-agent', 'sessions', id, 'session.lock'))

      const reopened = await openSession(root, id)

      try {
        await recoverSession(reopened)

        assert.deepEqual(
          reopened.snapshot.turns.at(-1)?.actions.map((a) => a.state),
          ['uncertain', 'not_executed']
        )
        assert.equal(await readFile(join(root, 'marker.txt'), 'utf8'), '执行一次')

        const result = await runSessionTurn(reopened, '只结束新轮', options([], [['finish_task']]))

        assert.equal(result.status, 'completed')
      } finally {
        await reopened.close()
      }
    })
  })
}

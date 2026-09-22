import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { createSession, openSession, listSessions, type SessionHandle } from './session.js'
import { runSessionTurn, describeSession } from './session-runner.js'
import { historyFingerprint, summaryView } from './context-summary.js'
import { estimateInputTokens } from './context-budget.js'
import { createToolRegistry } from './tools/registry.js'
import type { Tool } from './tools/types.js'
import type { CreateTurnStream, RunTurnOptions, TurnRequest } from './turn.js'

const budget = { contextWindow: 6000, outputReserve: 512, safetyMargin: 128 }
const marker = '摘要：用户只允许读取；旧写入被拒绝，未执行。'
const done: Tool = {
  name: 'done',
  description: 'd'.repeat(2300),
  schema: z.object({}),
  endsTurn: 'completed',
  execute: () => '完成',
}

async function* textStream(
  content = marker,
  finish: 'stop' | 'length' = 'stop',
  refusal: string | null = null
): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 's',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{ index: 0, delta: { content, refusal }, finish_reason: finish }],
  }
}

async function* doneStream(): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 'd',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'done-call',
              type: 'function',
              function: { name: 'done', arguments: '{}' },
            },
          ],
        },
      },
    ],
  }
}

function options(createStream: CreateTurnStream, maxIterations = 3): RunTurnOptions {
  return {
    createStream,
    maxIterations,
    contextBudget: budget,
    registry: createToolRegistry([done]),
    write: () => {},
    log: () => {},
  }
}

async function fixture(run: (session: SessionHandle, root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mini-compaction-'))
  const session = await createSession(root)
  try {
    await session.update((s) => {
      s.messages.push({ role: 'system', content: '遵守当前用户约束。' })
      for (let i = 0; i < 3; i++) {
        s.turns.push({
          id: randomUUID(),
          start: s.messages.length,
          status: 'completed',
          reason: '已记录',
          actions: [],
        })
        s.messages.push(
          { role: 'user', startsTurn: true, content: `OLD-${i}:` + 'x'.repeat(900) },
          { role: 'assistant', content: '已记录' }
        )
      }
    })
    await run(
      session,
      root,
      join(root, '.mini-agent', 'sessions', session.snapshot.id, 'snapshot.json')
    )
  } finally {
    await session.close()
    await rm(root, { recursive: true, force: true })
  }
}

function assertFits(request: TurnRequest) {
  assert.ok(
    estimateInputTokens(request.messages, request.tools) +
      request.maxOutputTokens +
      budget.safetyMargin <=
      budget.contextWindow
  )
}

test('摘要先持久化再发送，恢复不重复拼入已覆盖原文，也不自动请求模型', async () => {
  await fixture(async (session, root) => {
    const original = session.snapshot.messages
    let summaries = 0
    let main = 0
    const result = await runSessionTurn(
      session,
      '继续，只读',
      options(async (request) => {
        assertFits(request)
        if (!request.tools.length) {
          summaries++
          assert.equal(session.snapshot.summary, null)
          assert.ok(JSON.stringify(request.messages).includes('OLD-0:'))
          return textStream()
        }
        main++
        assert.equal(session.snapshot.summary?.content, marker)
        assert.ok(!JSON.stringify(request.messages).includes('OLD-0:'))
        assert.ok(
          request.messages.some((m) => m.role === 'user' && String(m.content).includes(marker))
        )
        assert.ok(
          !request.messages.some((m) => m.role === 'system' && String(m.content).includes(marker))
        )
        return doneStream()
      }, 2)
    )
    assert.equal(result.status, 'completed')
    assert.equal(summaries, 1)
    assert.equal(main, 1)
    assert.deepEqual(session.snapshot.messages.slice(0, original.length), original)
    const summary = session.snapshot.summary!
    assert.equal(summary.sourceHash, historyFingerprint(session.snapshot.messages, summary.through))
    await session.close()
    const reopened = await openSession(root, session.snapshot.id)
    try {
      assert.deepEqual(reopened.snapshot.summary, summary)
      assert.match(describeSession(reopened), /历史摘要覆盖/)
      assert.equal(summaries, 1)
      const next = await runSessionTurn(
        reopened,
        '接着做',
        options(async (request) => {
          assert.ok(request.tools.length > 0, '恢复后无需重做同一摘要')
          assert.ok(!JSON.stringify(request.messages).includes('OLD-0:'))
          return doneStream()
        })
      )
      assert.equal(next.status, 'completed')
    } finally {
      await reopened.close()
    }
  })
})

test('增量摘要合并之前摘要且覆盖范围只向前推进', async () => {
  await fixture(async (session) => {
    await runSessionTurn(
      session,
      '继续',
      options(async (r) => (r.tools.length ? doneStream() : textStream()))
    )
    const before = session.snapshot.summary!
    let summaries = 0
    await runSessionTurn(
      session,
      '新目标' + 'y'.repeat(2000),
      options(async (r) => {
        assertFits(r)
        if (r.tools.length) return doneStream()
        summaries++
        const data = JSON.parse(String(r.messages[1]?.content))
        assert.equal(data.previousSummary, before.content)
        assert.equal(data.range.from, before.through)
        assert.ok(!JSON.stringify(data.messages).includes('OLD-0:'))
        return textStream('合并摘要：旧约束保持，只读，尚未写入。')
      })
    )
    assert.equal(summaries, 1)
    assert.ok(session.snapshot.summary!.through > before.through)
  })
})

for (const [name, response] of [
  [
    '网络失败',
    async () => {
      throw new Error('transport')
    },
  ],
  ['空正文', async () => textStream('')],
  ['拒绝', async () => textStream('', 'stop', '不总结')],
  ['截断', async () => textStream('部分摘要', 'length')],
  ['工具调用', async () => doneStream()],
  ['超长摘要', async () => textStream('中'.repeat(3000))],
  ['未压缩', async () => textStream('s'.repeat(5500))],
] satisfies [string, () => Promise<AsyncIterable<ChatCompletionChunk>>][]) {
  test(`摘要${name}回退原视图，同轮只尝试一次`, async () => {
    await fixture(async (session) => {
      let summaries = 0
      let main = 0
      const result = await runSessionTurn(
        session,
        '继续',
        options(async (r) => {
          assertFits(r)
          if (!r.tools.length) {
            summaries++
            return response()
          }
          main++
          assert.equal(session.snapshot.summary, null)
          assert.ok(!JSON.stringify(r.messages).includes('[历史摘要'))
          return main === 1 ? textStream('继续处理') : doneStream()
        }, 3)
      )
      assert.equal(summaries, 1)
      assert.equal(main, 2)
      assert.equal(result.status, 'completed')
      assert.equal(session.snapshot.summary, null)
    })
  })
}

test('摘要保存失败不发布候选，后续正常动作仍可保存', async () => {
  await fixture(async (session, _root, file) => {
    let failedSaves = 0
    const proxy: SessionHandle = {
      get snapshot() {
        return session.snapshot
      },
      close: () => session.close(),
      update: (change) =>
        session.update(async (draft) => {
          await change(draft)
          if (draft.summary !== null) {
            failedSaves++
            throw new Error('保存故障')
          }
        }),
    }
    const result = await runSessionTurn(
      proxy,
      '继续',
      options(async (r) => {
        if (!r.tools.length) return textStream()
        assert.equal(session.snapshot.summary, null)
        assert.equal(JSON.parse(await readFile(file, 'utf8')).summary, null)
        assert.ok(!JSON.stringify(r.messages).includes(marker))
        return doneStream()
      })
    )
    assert.equal(result.status, 'completed')
    assert.equal(failedSaves, 1)
    assert.equal(session.snapshot.summary, null)
  })
})

test('摘要占用主轮请求额度，并给正常回答保留一次请求', async () => {
  await fixture(async (session) => {
    let calls = 0
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        calls++
        return r.tools.length ? textStream('还在处理') : textStream()
      }, 2)
    )
    assert.equal(calls, 2)
    assert.equal(result.status, 'budget_exhausted')
    assert.ok(session.snapshot.summary)
  })
})

test('只剩一次请求时不生成摘要', async () => {
  await fixture(async (session) => {
    let calls = 0
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        calls++
        assert.ok(r.tools.length > 0)
        return doneStream()
      }, 1)
    )
    assert.equal(calls, 1)
    assert.equal(result.status, 'completed')
    assert.equal(session.snapshot.summary, null)
  })
})

test('当前轮本身超限时零请求，摘要不能删除当前目标来腾空间', async () => {
  await fixture(async (session) => {
    const result = await runSessionTurn(
      session,
      'x'.repeat(8000),
      options(async () => {
        assert.fail('不得请求主模型或摘要')
      })
    )
    assert.equal(result.status, 'budget_exhausted')
    assert.equal(session.snapshot.summary, null)
  })
})

test('旧轮大到无法放入摘要请求时不发送摘要，仍可裁剪继续', async () => {
  await fixture(async (session) => {
    await session.update((s) => {
      s.messages[1]!.content = 'x'.repeat(10000)
    })
    let calls = 0
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        calls++
        assert.ok(r.tools.length > 0)
        return doneStream()
      })
    )
    assert.equal(result.status, 'completed')
    assert.equal(calls, 1)
    assert.equal(session.snapshot.summary, null)
  })
})

test('摘要取消向外传播，不能退回普通请求继续执行', async () => {
  await fixture(async (session) => {
    let calls = 0
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        calls++
        assert.equal(r.tools.length, 0)
        throw new DOMException('cancelled', 'AbortError')
      })
    )
    assert.equal(calls, 1)
    assert.equal(result.status, 'cancelled')
    assert.equal(session.snapshot.summary, null)
  })
})

test('旧摘要无法放入新窗口时保留磁盘摘要，仅本次回退原始历史视图', async () => {
  await fixture(async (session) => {
    await session.update((s) => {
      s.summary = {
        through: 3,
        sourceHash: historyFingerprint(s.messages, 3),
        content: 's'.repeat(5800),
      }
    })
    const previous = session.snapshot.summary
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        assertFits(r)
        assert.ok(!JSON.stringify(r.messages).includes('[历史摘要'))
        return doneStream()
      }, 1)
    )
    assert.equal(result.status, 'completed')
    assert.deepEqual(session.snapshot.summary, previous)
  })
})

test('拒绝错误覆盖边界、指纹不匹配与修改已摘要原文', async () => {
  await fixture(async (session) => {
    const before = session.snapshot
    for (const through of [0, 2, 99]) {
      await assert.rejects(
        session.update((s) => {
          s.summary = {
            through,
            content: marker,
            sourceHash: historyFingerprint(s.messages, through),
          }
        })
      )
    }
    await assert.rejects(
      session.update((s) => {
        s.summary = { through: 3, content: marker, sourceHash: '0'.repeat(64) }
      })
    )
    assert.deepEqual(session.snapshot, before)
    await session.update((s) => {
      s.summary = { through: 3, content: marker, sourceHash: historyFingerprint(s.messages, 3) }
    })
    await assert.rejects(
      session.update((s) => {
        s.messages[1]!.content = '被修改'
      })
    )
    assert.throws(() =>
      summaryView(session.snapshot.messages, {
        ...session.snapshot.summary!,
        through: 2,
      })
    )
  })
})

test('v2 只读迁移不改文件，下次保存写 v3；未知版本仍拒绝', async () => {
  await fixture(async (session, root, file) => {
    const id = session.snapshot.id
    const { summary: _summary, ...old } = session.snapshot
    const legacy = JSON.stringify({ ...old, version: 2 })
    await session.close()
    await writeFile(file, legacy)
    assert.equal((await listSessions(root))[0]?.ok, true)
    const reopened = await openSession(root, id)
    try {
      assert.equal(reopened.snapshot.version, 3)
      assert.equal(reopened.snapshot.summary, null)
      assert.equal(await readFile(file, 'utf8'), legacy)
      await reopened.update((s) => {
        s.todo.tasks.push({ id: s.todo.nextId++, title: '新待办' })
      })
      assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 3)
    } finally {
      await reopened.close()
    }
    for (const version of [1, 99]) {
      const invalid = JSON.stringify({ ...old, version })
      await writeFile(file, invalid)
      await assert.rejects(openSession(root, id), /不兼容/)
      assert.equal(await readFile(file, 'utf8'), invalid)
    }
  })
})

test('不确定动作提醒在预算检查之前加入，不能在检查后使请求溢出', async () => {
  await fixture(async (session) => {
    await session.update((s) => {
      const turn = s.turns.at(-1)!
      const messageIndex = s.messages.length
      s.messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'unknown',
              type: 'function',
              function: { name: 'write_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'unknown', content: '结果不确定' }
      )
      turn.actions.push({
        messageIndex,
        callId: 'unknown',
        state: 'uncertain',
        observation: '结果不确定',
      })
    })
    let sent = 0
    const o = options(async (r) => {
      sent++
      assert.ok(r.messages.some((m) => m.role === 'system' && String(m.content).includes('不确定')))
      return doneStream()
    }, 1)
    await runSessionTurn(session, '继续', o)
    assert.equal(sent, 1)

    // 精确只容纳原 system 与新输入，不能再偷偷添加提醒。
    const inputLimit = estimateInputTokens(
      [
        { role: 'system', content: '遵守当前用户约束。' },
        { role: 'user', content: '继续' },
      ],
      o.registry.getToolSchemas()
    )
    const result = await runSessionTurn(session, '继续', {
      ...o,
      contextBudget: { contextWindow: inputLimit + 640, outputReserve: 512, safetyMargin: 128 },
      createStream: async () => {
        assert.fail('提醒使固定前缀超限，不应发送')
      },
    })
    assert.equal(result.status, 'budget_exhausted')
  })
})

test('摘要输入携带动作状态，生成期间原文改变时不能发布过期摘要', async () => {
  await fixture(async (session) => {
    await session.update((s) => {
      // 重新构造含拒绝动作的完整旧轮。
      s.messages.splice(
        2,
        0,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'denied', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'denied', content: '用户拒绝，未执行' }
      )
      s.turns[0]!.actions.push({
        messageIndex: 2,
        callId: 'denied',
        state: 'not_executed',
        observation: '用户拒绝，未执行',
      })
      for (const t of s.turns.slice(1)) t.start += 2
    })
    const result = await runSessionTurn(
      session,
      '继续',
      options(async (r) => {
        if (r.tools.length) {
          assert.equal(session.snapshot.summary, null)
          return doneStream()
        }
        const source = JSON.parse(String(r.messages[1]?.content))
        assert.equal(source.turns[0].actions[0].state, 'not_executed')
        await session.update((s) => {
          s.messages[1]!.content = '更新后的原文'
        })
        return textStream()
      })
    )
    assert.equal(result.status, 'completed')
    assert.equal(session.snapshot.summary, null)
  })
})

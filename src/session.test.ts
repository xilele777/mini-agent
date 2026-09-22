import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSession, listSessions, openSession } from './session.js'

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mini-agent-session-model-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const fileOf = (root: string, id: string) =>
  join(root, '.mini-agent', 'sessions', id, 'snapshot.json')

test('项目路径规范化，新会话不继承其他会话或旧 todo', async () => {
  await fixture(async (root) => {
    await writeFile(
      join(root, '.mini-agent-todo.json'),
      '{"tasks":[{"id":1,"title":"旧任务"}],"nextId":2}'
    )

    const a = await createSession(join(root, '.'))
    const b = await createSession(root)

    try {
      await a.update((draft) => {
        draft.todo.tasks.push({ id: 1, title: '会话 A' })
        draft.todo.nextId = 2
      })

      assert.equal(a.snapshot.projectRoot, await realpath(root))
      assert.notEqual(a.snapshot.id, b.snapshot.id)
      assert.deepEqual(b.snapshot.todo, { tasks: [], nextId: 1 })
      assert.equal((await listSessions(root)).length, 2)
      assert.match(await readFile(join(root, '.mini-agent-todo.json'), 'utf8'), /旧任务/)
    } finally {
      await a.close()
      await b.close()
    }
  })
})

test('关闭并重开后恢复消息、轮边界与 todo', async () => {
  await fixture(async (root) => {
    const a = await createSession(root)
    const id = a.snapshot.id

    try {
      await a.update((draft) => {
        draft.messages.push({
          role: 'user',
          content: '读 README',
          startsTurn: true,
        })
        draft.todo.tasks.push({ id: 1, title: '读 README' })
        draft.todo.nextId = 2
      })
    } finally {
      await a.close()
    }

    const b = await openSession(root, id)
    try {
      assert.deepEqual(b.snapshot.messages, [
        {
          role: 'user',
          content: '读 README',
          startsTurn: true,
        },
      ])
      assert.deepEqual(b.snapshot.todo, {
        tasks: [{ id: 1, title: '读 README' }],
        nextId: 2,
      })
    } finally {
      await b.close()
    }
  })
})

test('snapshot 返回副本，不能绕过保存修改状态', async () => {
  await fixture(async (root) => {
    const session = await createSession(root)

    try {
      const copy = session.snapshot
      copy.todo.nextId = 99
      copy.messages.push({
        role: 'user',
        content: '外部修改',
      })

      assert.equal(session.snapshot.todo.nextId, 1)
      assert.equal(session.snapshot.messages.length, 0)
    } finally {
      await session.close()
    }
  })
})

test('无效 todo 和身份修改不改变内存或磁盘', async () => {
  await fixture(async (root) => {
    const session = await createSession(root)

    try {
      const before = session.snapshot
      const raw = await readFile(fileOf(root, before.id), 'utf8')

      await assert.rejects(
        session.update((draft) => {
          draft.todo.tasks.push({ id: 1, title: '编号冲突' })
        }),
        /nextId/
      )

      await assert.rejects(
        session.update((draft) => {
          draft.id = randomUUID()
        }),
        /ID/
      )

      await assert.rejects(
        session.update((draft) => {
          draft.projectRoot = '其他项目'
        }),
        /项目/
      )

      assert.deepEqual(session.snapshot, before)
      assert.equal(await readFile(fileOf(root, before.id), 'utf8'), raw)
    } finally {
      await session.close()
    }
  })
})

test('复制到其他项目的会话拒绝打开且释放锁', async () => {
  await fixture(async (root) => {
    const a = await createSession(root)
    const id = a.snapshot.id
    await a.close()

    const other = join(root, 'other')
    const target = fileOf(other, id)
    await mkdir(join(other, '.mini-agent', 'sessions', id), { recursive: true })
    await copyFile(fileOf(root, id), target)
    const raw = await readFile(target, 'utf8')

    await assert.rejects(openSession(other, id), /项目不匹配/)
    await assert.rejects(openSession(other, id), /项目不匹配/)
    assert.equal(await readFile(target, 'utf8'), raw)
  })
})

test('损坏或未知版本单独列为错误，不拖垮列表、不覆盖文件', async () => {
  await fixture(async (root) => {
    const good = await createSession(root)
    const bad = await createSession(root)
    const id = bad.snapshot.id
    const original = bad.snapshot
    await bad.close()

    try {
      for (const raw of ['{broken', JSON.stringify({ ...original, version: 99 })]) {
        await writeFile(fileOf(root, id), raw)
        const rows = await listSessions(root)

        assert.equal(rows.find((row) => row.id === good.snapshot.id)?.ok, true)
        assert.equal(rows.find((row) => row.id === id)?.ok, false)

        await assert.rejects(openSession(root, id), /JSON|不兼容/)
        await assert.rejects(openSession(root, id), /JSON|不兼容/)
        assert.equal(await readFile(fileOf(root, id), 'utf8'), raw)
      }
    } finally {
      await good.close()
    }
  })
})

test('非法 ID 和不存在的会话不创建新会话', async () => {
  await fixture(async (root) => {
    await assert.rejects(openSession(root, '../escape'))
    await assert.rejects(openSession(root, randomUUID()))
    assert.deepEqual(await listSessions(root), [])
  })
})

test('保存期间拒绝并发更新与关闭，异步修改完成后才保存', async () => {
  await fixture(async (root) => {
    const session = await createSession(root)

    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })

    const saving = session.update(async (draft) => {
      await gate
      draft.messages.push({
        role: 'user',
        content: '保存后可见',
      })
    })

    try {
      assert.equal(session.snapshot.messages.length, 0)
      await assert.rejects(
        session.update(() => {}),
        /顺序 await/
      )
      await assert.rejects(session.close(), /保存结束/)
    } finally {
      finish()
      await saving
    }

    try {
      assert.equal(session.snapshot.messages.length, 1)
    } finally {
      await session.close()
    }
  })
})

test('已打开会话拒绝再次打开，关闭后不能更新', async () => {
  await fixture(async (root) => {
    const session = await createSession(root)

    try {
      await assert.rejects(openSession(root, session.snapshot.id), /占用/)
    } finally {
      await session.close()
    }

    await assert.rejects(
      session.update(() => {}),
      /已经关闭/
    )

    const reopened = await openSession(root, session.snapshot.id)
    await reopened.close()
  })
})

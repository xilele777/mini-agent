import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { z } from 'zod'
import { acquireSessionLock, readSnapshot, writeSnapshot } from './session-storage.js'

const schema = z.strictObject({
  version: z.literal(1),
  title: z.string(),
})
const before = { version: 1 as const, title: '旧快照' }
const after = { version: 1 as const, title: '新快照' }

async function fixture(run: (directory: string, file: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'mini-agent-session-'))
  const release = await acquireSessionLock(directory)
  try {
    await run(directory, join(directory, 'snapshot.json'))
  } finally {
    await release()
    await rm(directory, { recursive: true, force: true })
  }
}

test('缺少快照返回 null', async () => {
  await fixture(async (_, file) => {
    assert.equal(await readSnapshot(file, schema), null)
  })
})

test('保存、替换并读回快照', async () => {
  await fixture(async (_, file) => {
    await writeSnapshot(file, schema, before)
    assert.deepEqual(await readSnapshot(file, schema), before)
    await writeSnapshot(file, schema, after)
    assert.deepEqual(await readSnapshot(file, schema), after)
  })
})

test('损坏 JSON 报错并保留原文件', async () => {
  await fixture(async (_, file) => {
    await writeFile(file, '{broken')
    await assert.rejects(readSnapshot(file, schema), /合法 JSON/)
    assert.equal(await readFile(file, 'utf8'), '{broken')
  })
})

test('未知版本拒绝加载且不改文件', async () => {
  await fixture(async (_, file) => {
    const raw = JSON.stringify({ version: 2, title: '未来格式' })
    await writeFile(file, raw)
    await assert.rejects(readSnapshot(file, schema), /不兼容/)
    assert.equal(await readFile(file, 'utf8'), raw)
  })
})

test('无效新状态不能覆盖旧快照', async () => {
  await fixture(async (_, file) => {
    await writeSnapshot(file, schema, before)
    const raw = await readFile(file, 'utf8')
    // 模拟来自外部数据的运行时类型错误。
    await assert.rejects(
      writeSnapshot(file, schema, {
        version: 2 as unknown as 1,
        title: '错误版本',
      })
    )
    assert.equal(await readFile(file, 'utf8'), raw)
  })
})

test('替换前失败保留旧快照并清理临时文件', async () => {
  await fixture(async (directory, file) => {
    await writeSnapshot(file, schema, before)
    const raw = await readFile(file, 'utf8')
    await assert.rejects(
      writeSnapshot(file, schema, after, async (source) => {
        assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), after)
        assert.equal(await readFile(file, 'utf8'), raw)
        throw new Error('模拟替换失败')
      }),
      /模拟替换失败/
    )
    assert.equal(await readFile(file, 'utf8'), raw)
    assert.deepEqual((await readdir(directory)).sort(), ['session.lock', 'snapshot.json'])
  })
})

test('读取目录的错误不能被当成无快照', async () => {
  await fixture(async (directory) => {
    await assert.rejects(readSnapshot(directory, schema))
  })
})

test('同一会话拒绝第二个写入者，释放后可重开', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mini-agent-lock-'))
  try {
    const release = await acquireSessionLock(directory)
    await assert.rejects(acquireSessionLock(directory), /占用/)
    await release()

    const releaseAgain = await acquireSessionLock(directory)
    await release() // 旧释放函数不能删除新持有者的锁。
    await assert.rejects(acquireSessionLock(directory), /占用/)
    await releaseAgain()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

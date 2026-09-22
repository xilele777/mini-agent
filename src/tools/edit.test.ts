import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ROOT, guardDirRead, guardPathRead } from '../guard.js'
import { createReadFileTool } from './fs.js'
import { editFileTool, writeFileTool, fingerprint } from './edit.js'
import { runTurn, type TurnEvent } from '../turn.js'
import { createToolRegistry } from './registry.js'
import { finishTaskTool } from './control.js'
import { testConfig } from '../test-runtime.js'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

async function fixture(t: test.TestContext, text = 'before\r\nkeep\r\n') {
  const dir = await mkdtemp(join(ROOT, 'stage13-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'file.txt')
  await writeFile(path, text)
  return {
    dir,
    path,
    text,
    args: { path, expected_sha256: fingerprint(text), old_text: 'before', new_text: 'after' },
  }
}

test('读取分页与空文件均提供整文件指纹', async (t) => {
  const f = await fixture(t)
  const read = createReadFileTool(1024)
  const result = await read.execute({ path: f.path, offset: 2, limit: 1 })
  assert.match(result, new RegExp(fingerprint(f.text)))
  await writeFile(f.path, '')
  assert.match(
    await read.execute({ path: f.path, offset: 1, limit: 1 }),
    new RegExp(fingerprint(''))
  )
})

test('精确替换展示完整 diff，保持 CRLF 和无关内容，提交后清理临时文件', async (t) => {
  const f = await fixture(t)
  const action = await editFileTool.prepare!(f.args)
  assert.match(action.preview, /-before␍/)
  assert.match(action.preview, /\+after␍/)
  assert.ok(action.approvalKey.includes(f.args.expected_sha256))
  assert.match(await action.execute(), /已编辑/)
  assert.equal(await readFile(f.path, 'utf8'), 'after\r\nkeep\r\n')
  assert.deepEqual(await readdir(f.dir), ['file.txt'])
})

test('零匹配、多匹配（包括重叠）、过期指纹和无变化均在批准前拒绝', async (t) => {
  const f = await fixture(t, 'aaaa')
  for (const args of [
    { ...f.args, old_text: 'missing' },
    { ...f.args, old_text: 'aa' },
    { ...f.args, expected_sha256: '0'.repeat(64) },
    { ...f.args, old_text: 'aaaa', new_text: 'aaaa' },
  ])
    await assert.rejects(editFileTool.prepare!(args))
  assert.equal(await readFile(f.path, 'utf8'), 'aaaa')
})

test('批准后外部修改拒写，旧候选不能重新应用', async (t) => {
  const f = await fixture(t)
  const action = await editFileTool.prepare!(f.args)
  await writeFile(f.path, 'external')
  assert.match(await action.execute(), /冲突/)
  assert.equal(await readFile(f.path, 'utf8'), 'external')
  await assert.rejects(editFileTool.prepare!(f.args), /指纹冲突/)
})

test('准备后模型参数对象被改变，不改变已预览候选', async (t) => {
  const f = await fixture(t)
  const action = await editFileTool.prepare!(f.args)
  f.args.new_text = 'tampered'
  await action.execute()
  assert.equal(await readFile(f.path, 'utf8'), 'after\r\nkeep\r\n')
})

test('新建文件排他发布并创建父目录，旧 write_file 无法覆盖已有文件', async (t) => {
  const f = await fixture(t)
  await assert.rejects(writeFileTool.prepare!({ path: f.path, content: 'overwrite' }), /已存在/)
  const path = join(f.dir, 'new', 'empty.txt')
  const action = await writeFileTool.prepare!({ path, content: '' })
  assert.match(await action.execute(), /已新建/)
  assert.equal(await readFile(path, 'utf8'), '')
  assert.equal(await readFile(f.path, 'utf8'), f.text)
  assert.throws(() => writeFileTool.execute({ path, content: 'x' }), /准备/)
})

test('批准后出现同名文件，不覆盖；取消不提交', async (t) => {
  const f = await fixture(t)
  const path = join(f.dir, 'new.txt')
  const action = await writeFileTool.prepare!({ path, content: 'candidate' })
  await writeFile(path, 'external')
  assert.match(await action.execute(), /已存在/)
  assert.equal(await readFile(path, 'utf8'), 'external')
  const edit = await editFileTool.prepare!(f.args)
  await assert.rejects(async () => edit.execute({ signal: AbortSignal.abort() }), {
    name: 'AbortError',
  })
  assert.equal(await readFile(f.path, 'utf8'), f.text)
})

test('文件工具统一拒绝项目外、敏感路径和无法解析路径，搜索允许项目根', async () => {
  for (const path of [
    '../outside.txt',
    '.env',
    '.git/new.txt',
    '.mini-agent/snapshot.json',
    'node_modules/new.txt',
  ]) {
    await assert.rejects(writeFileTool.prepare!({ path, content: 'x' }), /拒绝/)
  }
  assert.equal((await guardDirRead(ROOT)).ok, true)
  assert.equal((await guardPathRead(join(ROOT, 'missing-stage13-file'))).ok, false)
})

test('实际项目内 junction 别名不能绕过敏感目录或写入链接规则', async (t) => {
  const f = await fixture(t)
  const secret = join(f.dir, '.mini-agent')
  await mkdir(secret)
  await writeFile(join(secret, 'secret.txt'), 'secret')
  const alias = join(f.dir, 'alias')
  await symlink(secret, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await guardDirRead(alias)).ok, false)
  assert.equal((await guardPathRead(join(alias, 'secret.txt'))).ok, false)
  await assert.rejects(
    writeFileTool.prepare!({ path: join(alias, 'new.txt'), content: 'x' }),
    /链接/
  )
})

test('拒绝二进制与超限文件；失败不留下临时文件', async (t) => {
  const f = await fixture(t, '\0binary')
  await assert.rejects(editFileTool.prepare!(f.args), /UTF-8/)
  await assert.rejects(
    writeFileTool.prepare!({ path: join(f.dir, 'large'), content: 'x'.repeat(1024 * 1024 + 1) }),
    /上限/
  )
  assert.deepEqual(await readdir(f.dir), ['file.txt'])
})

test(
  'Windows 盘符大小写不同仍能完成路径检查',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t)
    const path = f.path[0]!.toLowerCase() + f.path.slice(1)
    const action = await editFileTool.prepare!({ ...f.args, path })
    assert.match(await action.execute(), /已编辑/)
  }
)

function response(args: unknown): AsyncIterable<ChatCompletionChunk> {
  return (async function* () {
    yield {
      id: 'edit',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'edit',
                type: 'function',
                function: { name: 'edit_file', arguments: JSON.stringify(args) },
              },
              {
                index: 1,
                id: 'done',
                type: 'function',
                function: { name: 'finish_task', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }
  })()
}

test('主轮用同一候选预览和提交；拒绝及批准等待取消均无写入', async (t) => {
  for (const mode of ['allow', 'deny', 'cancel', 'conflict', 'invalid'] as const) {
    const f = await fixture(t)
    const controller = new AbortController()
    const events: TurnEvent[] = []
    let approvals = 0
    const result = await runTurn([{ role: 'user', content: 'edit', startsTurn: true }], {
      registry: createToolRegistry([editFileTool, finishTaskTool]),
      contextBudget: testConfig.contextBudget,
      maxIterations: 1,
      signal: controller.signal,
      write: () => {},
      log: () => {},
      createStream: async () =>
        response(mode === 'invalid' ? { ...f.args, old_text: 'missing' } : f.args),
      approve: async (_tool, _args, context) => {
        approvals++
        assert.match(context!.action!.preview, /\+after/)
        if (mode === 'cancel') controller.abort()
        if (mode === 'conflict') await writeFile(f.path, 'external')
        return mode !== 'deny'
      },
      checkpoint: async (event) => {
        events.push(event)
      },
    })
    assert.equal(
      await readFile(f.path, 'utf8'),
      mode === 'allow' ? 'after\r\nkeep\r\n' : mode === 'conflict' ? 'external' : f.text
    )
    assert.equal(approvals, mode === 'invalid' ? 0 : 1)
    assert.equal(result.status, mode === 'cancel' ? 'cancelled' : 'completed')
    if (mode === 'deny' || mode === 'cancel' || mode === 'invalid') {
      assert.ok(
        events.some(
          (e) => e.type === 'action' && e.call.id === 'edit' && e.state === 'not_executed'
        )
      )
      assert.ok(
        !events.some((e) => e.type === 'action' && e.call.id === 'edit' && e.state === 'started')
      )
    }
  }
})

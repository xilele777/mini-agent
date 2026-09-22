import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDataset,
  compareNotes,
  datasetSignature,
  splitSections,
  readNoteDirectory,
  createLiveSync,
  resolveNotesDirectory,
  groupNotes,
} from './model.mjs'

const id = (name) => 'implemented/architecture/2026-09-12-' + name + '.md'
const body = (title, decision = '第一段决定。\n\n第二段决定。') =>
  '# Agent Note: ' +
  title +
  '\n\nStatus: implemented\n\n## Problem\n\n需要保留依据。\n\n## Decision\n\n' +
  decision +
  '\n\n## Alternatives considered\n\n- 方案 A：长处与限制。\n- 方案 B：另一种取舍。\n\n## Consequences\n\n收益。\n\n代价。\n\n## Verification\n\n可核实的证据。'
const file = (name, decision) => ({ path: id(name), content: body(name, decision) })
const dataset = (...names) => buildDataset(names.map((name) => file(name)))
const tick = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => Promise.withResolvers()

test('项目目录按配置排序、显示短标题，每篇笔记只出现一次', () => {
  const notes = dataset('a', 'b', 'c')
  const presentation = {
    groups: [
      {
        id: 'first',
        title: '第一模块',
        notes: [{ id: id('c'), label: '简短标题' }, { id: id('a') }],
      },
      { id: 'second', title: '第二模块', notes: [{ id: id('a') }, { id: id('b') }] },
    ],
  }
  const expected = [
    ['first', [id('c'), id('a')]],
    ['second', [id('b')]],
  ]
  for (const input of [notes, [...notes].reverse()]) {
    const groups = groupNotes(input, presentation)
    assert.deepEqual(
      groups.map((group) => [group.id, group.entries.map((entry) => entry.note.id)]),
      expected
    )
    assert.equal(groups[0].entries[0].label, '简短标题')
    assert.equal(groups[0].entries[1].label, 'a')
    assert.equal(
      groups[0].entries[0].note,
      notes.find((note) => note.id === id('c'))
    )
  }
})

test('旧路径缺失、新增与改名的笔记仍可在分类分组中找到', () => {
  const notes = dataset('kept', 'renamed', 'new')
  const presentation = {
    groups: [
      { id: 'module', title: '模块', notes: [{ id: id('removed') }, { id: id('kept') }] },
      { id: 'empty', title: '已空的模块', notes: [{ id: id('old-name') }] },
    ],
  }
  const groups = groupNotes(notes, presentation)
  assert.deepEqual(
    groups.map((group) => group.id),
    ['module', 'class-architecture']
  )
  assert.deepEqual(
    groups.flatMap((group) => group.entries.map((entry) => entry.note.id)).sort(),
    notes.map((note) => note.id).sort()
  )
  assert.deepEqual(groupNotes([...notes].reverse(), presentation), groups)
})

test('没有项目配置时按标准类别展示全部笔记', () => {
  const notes = buildDataset([
    file('a'),
    { path: 'implemented/feature/2026-09-11-feature.md', content: body('feature') },
  ])
  for (const presentation of [undefined, {}, { groups: [] }]) {
    const groups = groupNotes(notes, presentation)
    assert.deepEqual(
      groups.map((group) => group.id),
      ['class-architecture', 'class-feature']
    )
    assert.equal(groups.flatMap((group) => group.entries).length, notes.length)
  }
})

test('相同日期和引用数的笔记，在所有排序方式下不受输入顺序影响', () => {
  const files = [
    file('c'),
    file('a'),
    file('b'),
    { path: 'implemented/feature/2026-09-11-old.md', content: body('old') },
  ]
  const variants = [files, [...files].reverse(), [files[2], files[0], files[3], files[1]]]
  for (const mode of ['new', 'old', 'references']) {
    const orders = variants.map((input) =>
      buildDataset(input)
        .sort((a, b) => compareNotes(a, b, mode, new Map()))
        .map((note) => note.id)
    )
    assert.deepEqual(orders[0], orders[1])
    assert.deepEqual(orders[0], orders[2])
  }
  assert.deepEqual(
    buildDataset(files)
      .slice(0, 3)
      .map((note) => note.id),
    [id('a'), id('b'), id('c')]
  )
})

test('完整保留多段正文、全部备选、验证依据和没有末尾换行的最后一节', () => {
  for (const raw of [body('完整'), body('完整').replace(/\n/g, '\r\n')]) {
    const [note] = buildDataset([{ path: id('full'), content: raw }])
    assert.equal(note.decision, '第一段决定。\n\n第二段决定。')
    assert.equal(note.alternatives.split('\n').length, 2)
    assert.equal(note.consequences, '收益。\n\n代价。')
    assert.equal(note.sections.at(-1).body, '可核实的证据。')
  }
})

test('代码块里的二级标题不会切断正文', () => {
  const sections = splitSections(
    '## Decision\n\n```md\n## 这是示例\n内容\n```\n\n之后的说明。\n\n## Verification\n\n证据。'
  )
  assert.equal(sections.length, 2)
  assert.ok(sections[0].body.includes('## 这是示例'))
  assert.ok(sections[0].body.endsWith('之后的说明。'))
})

test('中英文同名文件始终优先选择中文版本', () => {
  const english = file('translated')
  const chinese = { path: english.path.replace(/\.md$/, '.zh.md'), content: body('中文正文') }
  for (const input of [
    [english, chinese],
    [chinese, english],
  ]) {
    const notes = buildDataset(input)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].title, '中文正文')
    assert.equal(notes[0].sourcePath, chinese.path)
  }
})

test('关联按相对路径解析，支持锚点、去重且不按同名文件猜测', () => {
  const source = file(
    'source',
    '[目标](2026-09-12-target.md#decision) [重复](2026-09-12-target.md) [错误位置](../testing/2026-09-12-target.md) [源码](../../../../src/context.ts) [外部](https://example.com/2026-09-12-target.md)'
  )
  const notes = buildDataset([source, file('target')])
  assert.deepEqual(notes.find((note) => note.title === 'source').outLinks, [id('target')])
})

test('内容指纹不受遍历顺序影响，并检测相同长度的文字修改', () => {
  const notes = dataset('a', 'b')
  assert.equal(datasetSignature(notes), datasetSignature([...notes].reverse()))
  const changed = buildDataset([file('a', '第三段决定。\n\n第四段决定。'), file('b')])
  assert.equal(notes[0].rawBody.length, changed[0].rawBody.length)
  assert.notEqual(datasetSignature(notes), datasetSignature(changed))
})

test('未完成保存的无效笔记拒绝进入新数据集', () => {
  assert.throws(
    () => buildDataset([{ path: id('broken'), content: '# Agent Note: 未写完\n' }]),
    /无法解析/
  )
  assert.throws(
    () =>
      buildDataset([
        {
          path: id('wrong'),
          content: body('wrong').replace('Status: implemented', 'Status: proposed'),
        },
      ]),
    /状态与目录不一致/
  )
})

function directory(name, entries) {
  return {
    name,
    kind: 'directory',
    async *values() {
      yield* [...entries].reverse()
    },
  }
}
test('目录扫描只读取合法笔记分层，单个读取失败不返回残缺快照', async () => {
  let privateReads = 0
  const privateEntry = {
    name: '.env',
    kind: 'file',
    getFile() {
      privateReads++
      throw new Error('不应读取')
    },
  }
  const validEntry = {
    name: '2026-09-12-valid.md',
    kind: 'file',
    async getFile() {
      return { text: async () => body('valid') }
    },
  }
  const root = directory('notes', [
    privateEntry,
    directory('implemented', [directory('architecture', [validEntry])]),
  ])
  assert.equal((await readNoteDirectory(root)).length, 1)
  assert.equal(privateReads, 0)
  const broken = {
    name: '2026-09-12-broken.md',
    kind: 'file',
    async getFile() {
      throw new Error('暂时不可读')
    },
  }
  await assert.rejects(
    readNoteDirectory(
      directory('notes', [
        directory('implemented', [directory('architecture', [validEntry, broken])]),
      ])
    ),
    /暂时不可读/
  )
})

test('错误的目录选择不会被当成空笔记目录', async () => {
  const root = {
    ...directory('unrelated', []),
    async getDirectoryHandle() {
      throw Object.assign(new Error('missing'), { name: 'NotFoundError' })
    },
  }
  await assert.rejects(resolveNotesDirectory(root), /请选择项目根目录/)
})

test('未改变内容的重复检查只提交一次，读取顺序变化也不重绘', async () => {
  let reverse = false
  const commits = [],
    reports = []
  const sync = createLiveSync({
    read: async () => {
      reverse = !reverse
      const notes = dataset('a', 'b')
      return reverse ? notes.reverse() : notes
    },
    commit: (notes) => commits.push(notes),
    report: (result) => reports.push(result),
  })
  sync.setSource({})
  await sync.request()
  await sync.request()
  await sync.request()
  assert.equal(commits.length, 1)
  assert.deepEqual(
    reports.map((result) => result.changed),
    [true, false, false]
  )
})

test('编辑、新增、删除和改名都触发一次更新', async () => {
  let current = dataset('a')
  const commits = []
  const sync = createLiveSync({
    read: async () => current,
    commit: (notes) => commits.push(notes.map((note) => note.id)),
  })
  sync.setSource({})
  await sync.request()
  current = buildDataset([file('a', '同长度新文字')])
  await sync.request()
  current = dataset('a', 'b')
  await sync.request()
  current = dataset('b')
  await sync.request()
  current = dataset('renamed')
  await sync.request()
  assert.equal(commits.length, 5)
  assert.deepEqual(commits.at(-1), [id('renamed')])
})

test('focus 与轮询并发时串行读取，积压请求合并成一次后续检查', async () => {
  const reads = []
  let inFlight = 0,
    maxInFlight = 0
  const commits = []
  const sync = createLiveSync({
    read: async () => {
      const pending = deferred()
      reads.push(pending)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const value = await pending.promise
      inFlight--
      return value
    },
    commit: (notes) => commits.push(notes),
  })
  sync.setSource({})
  const done = sync.request()
  await tick()
  for (let index = 0; index < 12; index++) assert.equal(sync.request(), done)
  reads[0].resolve(dataset('a'))
  await tick()
  assert.equal(reads.length, 2)
  reads[1].resolve(dataset('a'))
  await done
  assert.equal(maxInFlight, 1)
  assert.equal(commits.length, 1)
})

test('切换目录后丢弃旧目录的迟到结果', async () => {
  const oldRead = deferred(),
    newRead = deferred()
  const commits = [],
    reports = []
  const sync = createLiveSync({
    read: (source) => (source === 'old' ? oldRead.promise : newRead.promise),
    commit: (notes) => commits.push(notes[0].title),
    report: (result) => reports.push(result),
  })
  sync.setSource('old')
  const done = sync.request()
  await tick()
  sync.setSource('new')
  sync.request()
  oldRead.resolve(dataset('old'))
  await tick()
  assert.equal(commits.length, 0)
  newRead.resolve(dataset('new'))
  await done
  assert.deepEqual(commits, ['new'])
  assert.equal(reports.length, 1)
})

test('完成回调之后的微任务检查不会在清理活动请求时丢失', async () => {
  let reads = 0,
    scheduled = false
  const sync = createLiveSync({
    read: async () => {
      reads++
      return dataset('a')
    },
    commit() {},
    report() {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => sync.request())
      }
    },
  })
  sync.setSource({})
  await sync.request()
  assert.equal(reads, 2)
})

test('读取失败保留最后成功快照，下次检查能够恢复', async () => {
  let fail = false
  const commits = [],
    reports = []
  const sync = createLiveSync({
    read: async () => {
      if (fail) throw new Error('失去权限')
      return dataset('a')
    },
    commit: (notes) => commits.push(notes),
    report: (result) => reports.push(result),
  })
  sync.setSource({})
  await sync.request()
  fail = true
  await sync.request()
  assert.equal(commits.length, 1)
  assert.equal(reports.at(-1).ok, false)
  fail = false
  await sync.request()
  assert.equal(commits.length, 1)
  assert.equal(reports.at(-1).ok, true)
  assert.equal(reports.at(-1).changed, false)
})

test('断开目录后不再发布进行中的读取', async () => {
  const pending = deferred()
  const commits = []
  const sync = createLiveSync({
    read: () => pending.promise,
    commit: (notes) => commits.push(notes),
  })
  sync.setSource({})
  const done = sync.request()
  await tick()
  sync.setSource(null)
  pending.resolve(dataset('a'))
  await done
  assert.equal(commits.length, 0)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { createLiveSync } from './model.mjs'
import {
  validatePresentation,
  readProjectDirectory,
  readPresentationDirectory,
  projectSignature,
  documentSection,
} from './project.mjs'

const noteName = '2026-09-13-example.md'
const note =
  '# Agent Note: 示例\n\nStatus: implemented\n\n## Problem\n问题。\n\n## Decision\n决定。\n\n## Alternatives considered\n- 备选与代价。\n\n## Consequences\n影响。'
const source = 'learning/progress.md'
const progress = '# 进度\n\n## 当前阶段\n阶段甲。\n\n## 下一步\n候选乙。\n\n## 待验证\n- 未验证。'
function file(name, content) {
  return {
    name,
    kind: 'file',
    content,
    reads: 0,
    denied: false,
    async getFile() {
      this.reads++
      if (this.denied)
        throw Object.assign(new Error('Permission lost'), { name: 'NotAllowedError' })
      return { text: async () => this.content }
    },
  }
}
function directory(name, entries = []) {
  return {
    name,
    kind: 'directory',
    entries: new Map(entries.map((entry) => [entry.name, entry])),
    reversed: false,
    async getDirectoryHandle(key) {
      const entry = this.entries.get(key)
      if (!entry) throw Object.assign(new Error(key), { name: 'NotFoundError' })
      if (entry.kind !== 'directory')
        throw Object.assign(new Error(key), { name: 'TypeMismatchError' })
      return entry
    },
    async getFileHandle(key) {
      const entry = this.entries.get(key)
      if (!entry) throw Object.assign(new Error(key), { name: 'NotFoundError' })
      if (entry.kind !== 'file') throw Object.assign(new Error(key), { name: 'TypeMismatchError' })
      return entry
    },
    async *values() {
      const entries = [...this.entries.values()]
      yield* this.reversed ? entries.reverse() : entries
    },
  }
}
function presentation() {
  return {
    name: '示例项目',
    map: {
      title: '执行流程',
      flow: ['start', 'action'],
      defaultNode: 'start',
      loop: { from: 'action', to: 'start', label: '再判断' },
      nodes: ['start', 'action'].map((id) => ({
        id,
        title: id,
        caption: '简短说明',
        behavior: ['实际做法'],
        boundary: '限制',
        notes: ['implemented/architecture/' + noteName],
        sources: [{ label: '实现', path: '../lib/runner.js' }],
      })),
    },
    brief: { source, current: '当前阶段', next: '下一步', attention: '待验证' },
    learning: {
      enabled: true,
      title: '学习',
      source,
      sections: [{ title: '实践', heading: '当前阶段' }],
    },
  }
}
function fixture() {
  const config = file('board.json', JSON.stringify(presentation()))
  const document = file('progress.md', progress)
  const secret = file('.env', 'must not read')
  const unrelated = file('unrelated.md', 'must not read')
  const notes = directory('notes', [
    directory('implemented', [directory('architecture', [file(noteName, note)])]),
  ])
  const learning = directory('learning', [document, unrelated])
  const agents = directory('.agents', [config, notes, learning, secret])
  const root = directory('example-project', [agents])
  return { root, agents, config, document, notes, learning, secret, unrelated }
}

test('地图引用必须完整，主流程、回路和分支不能指向缺失节点', () => {
  const valid = presentation()
  assert.equal(validatePresentation(valid), valid)
  const missing = structuredClone(valid)
  missing.map.flow[1] = 'missing'
  assert.throws(() => validatePresentation(missing), /缺失或重复/)
  const wrongLoop = structuredClone(valid)
  wrongLoop.map.loop.to = 'missing'
  assert.throws(() => validatePresentation(wrongLoop), /回路/)
  const repeated = structuredClone(valid)
  repeated.map.supports = [{ id: 'start', target: 'action', label: '关系' }]
  assert.throws(() => validatePresentation(repeated), /重复/)
  const unsafeSource = structuredClone(valid)
  unsafeSource.brief.source = '../outside.md'
  assert.throws(() => validatePresentation(unsafeSource), /配置目录内/)
})

test('真实项目地图的所有决策依据、源码入口和进度章节存在', async (t) => {
  const configUrl = new URL('../../.agents/board.json', import.meta.url)
  let raw
  try {
    raw = await readFile(configUrl, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('未配置项目地图。')
      return
    }
    throw error
  }
  const config = validatePresentation(JSON.parse(raw))
  if (!config.map) {
    t.skip('未配置项目地图。')
    return
  }
  for (const node of config.map.nodes) {
    for (const id of node.notes) await access(new URL('notes/' + id, configUrl))
    for (const source of node.sources || []) await access(new URL(source.path, configUrl))
  }
  for (const block of [config.brief, config.learning?.enabled !== false && config.learning].filter(
    Boolean
  )) {
    const content = await readFile(new URL(block.source, configUrl), 'utf8')
    const headings = block.sections?.map((section) => section.heading) || [
      block.current,
      block.next,
      block.attention,
    ]
    for (const heading of headings)
      assert.notEqual(
        documentSection({ [block.source]: content }, block.source, heading),
        null,
        heading
      )
  }
})

test('项目根目录和 .agents 都能读取地图、笔记与显式引用的资料', async () => {
  const data = fixture()
  const fromRoot = await readProjectDirectory(data.root)
  const fromAgents = await readProjectDirectory(data.agents)
  assert.equal(fromRoot.notes.length, 1)
  assert.equal(fromRoot.documents[source], progress)
  assert.equal(fromRoot.scope, 'project')
  assert.equal(projectSignature(fromRoot), projectSignature(fromAgents))
  assert.equal(data.document.reads, 2) // One read per scan, shared by brief and learning.
  assert.equal(data.secret.reads, 0)
  assert.equal(data.unrelated.reads, 0)
})

test('只连接 notes 时不继承其他项目的地图或学习资料', async () => {
  const data = fixture()
  await readProjectDirectory(data.root)
  const result = await readProjectDirectory(data.notes)
  assert.equal(result.notes.length, 1)
  assert.equal(result.scope, 'notes')
  assert.deepEqual(result.presentation, {})
  assert.deepEqual(result.documents, {})
})

test('学习区域关闭后不读取其独立来源；资料缺失被显式标记', async () => {
  const data = fixture()
  const config = presentation()
  config.learning = { ...config.learning, enabled: false, source: 'learning/unrelated.md' }
  data.config.content = JSON.stringify(config)
  await readPresentationDirectory(data.agents)
  assert.equal(data.unrelated.reads, 0)
  data.learning.entries.delete('progress.md')
  const result = await readProjectDirectory(data.root)
  assert.equal(result.documents[source], null)
  assert.equal(documentSection(result.documents, source, '当前阶段'), null)
  assert.equal(documentSection({ [source]: progress }, source, '缺失章节'), null)
})

test('只有进度或地图变化也会同步；无变化和遍历顺序变化不提交', async () => {
  const data = fixture()
  const commits = [],
    reports = []
  const sync = createLiveSync({
    read: readProjectDirectory,
    signatureOf: projectSignature,
    countOf: (project) => project.notes.length,
    commit: (project) => commits.push(project),
    report: (report) => reports.push(report),
  })
  sync.setSource(data.root)
  await sync.request()
  data.notes.reversed = true
  data.agents.reversed = true
  await sync.request()
  assert.equal(commits.length, 1)
  data.document.content = progress.replace('阶段甲', '阶段丙')
  assert.equal(data.document.content.length, progress.length)
  await sync.request()
  assert.equal(commits.length, 2)
  const config = presentation()
  config.map.nodes[0].caption = '更新说明'
  data.config.content = JSON.stringify(config)
  await sync.request()
  assert.equal(commits.length, 3)
  data.document.denied = true
  await sync.request()
  assert.equal(commits.length, 3)
  assert.equal(reports.at(-1).ok, false)
  data.document.denied = false
  await sync.request()
  assert.equal(reports.at(-1).changed, false)
  data.config.content = '{'
  await sync.request()
  assert.equal(commits.length, 3)
  assert.equal(reports.at(-1).ok, false)
  data.agents.entries.delete('board.json')
  await sync.request()
  assert.equal(commits.length, 4)
  assert.equal(commits.at(-1).notes.length, 1)
  assert.deepEqual(commits.at(-1).presentation, {})
  assert.deepEqual(commits.at(-1).documents, {})
})

test('资料指纹不受文件键顺序影响，同时保留空节与缺失节的差别', () => {
  const project = {
    notes: [],
    presentation: {},
    documents: { 'a.md': 'A', 'b.md': 'B' },
    scope: 'project',
    label: '项目',
  }
  assert.equal(
    projectSignature(project),
    projectSignature({ ...project, documents: { 'b.md': 'B', 'a.md': 'A' } })
  )
  assert.equal(documentSection({ 'a.md': '## 空节\n\n## 下一节\n正文' }, 'a.md', '空节'), '')
  assert.equal(documentSection({ 'a.md': '## 空节\n' }, 'a.md', '未定义'), null)
})

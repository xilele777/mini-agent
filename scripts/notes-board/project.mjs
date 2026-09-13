import { datasetSignature, readNoteDirectory, resolveNotesDirectory, splitSections } from './model.mjs';

// Note: 展示配置、进度来源与稳定同步见 .agents/notes/implemented/process/2026-09-12-readable-board-and-stable-sync.md
const missingEntry = error => ['NotFoundError', 'TypeMismatchError', 'ENOENT', 'ENOTDIR'].includes(error?.name) || ['ENOENT', 'ENOTDIR'].includes(error?.code);
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value);
const string = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const documentPath = value => string(value) && !value.includes('\\') && !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..') && value.endsWith('.md');
const relativeReference = value => string(value) && !/^(?:[/\\]|[a-z][a-z\d+.-]*:)/i.test(value) && !/[\r\n\0]/.test(value);

export function validatePresentation(value) {
  const fail = message => { throw new Error('board.json：' + message); };
  if (!object(value)) fail('需要一个配置对象。');
  if (value.name !== undefined && typeof value.name !== 'string') fail('name 需要是文字。');
  if (value.groups !== undefined && !Array.isArray(value.groups)) fail('groups 需要是数组。');
  const groupIds = new Set();
  for (const group of value.groups || []) {
    if (!object(group) || !slug(group.id) || group.id.startsWith('class-') || groupIds.has(group.id)) fail('模块 ID 需要唯一，且不能使用 class- 前缀。');
    if (!string(group.title) || !Array.isArray(group.notes)) fail('模块需要标题和笔记清单。');
    for (const note of group.notes) if (!object(note) || !string(note.id) || (note.label !== undefined && typeof note.label !== 'string')) fail('笔记入口需要路径和可选的短标题。');
    groupIds.add(group.id);
  }
  if (value.map !== undefined) {
    const map = value.map;
    if (!object(map) || !string(map.title) || !Array.isArray(map.nodes) || !Array.isArray(map.flow) || map.flow.length < 2 || map.flow.length > 6) fail('项目地图需要标题、节点和 2–6 步主流程。');
    const ids = new Set();
    for (const node of map.nodes) {
      if (!object(node) || !slug(node.id) || ids.has(node.id)) fail('地图节点 ID 需要唯一。');
      for (const key of ['title', 'caption', 'boundary']) if (!string(node[key])) fail('地图节点需要 ' + key + '。');
      if (!Array.isArray(node.behavior) || !node.behavior.length || node.behavior.some(item => !string(item))) fail('节点需要当前做法。');
      if (!Array.isArray(node.notes) || node.notes.some(item => !string(item))) fail('节点的依据需要笔记路径。');
      if (node.sources !== undefined && (!Array.isArray(node.sources) || node.sources.some(item => !object(item) || !string(item.label) || !relativeReference(item.path)))) fail('源码入口需要 label 和相对路径。');
      ids.add(node.id);
    }
    const placed = new Set();
    const place = id => { if (!ids.has(id) || placed.has(id)) fail('地图位置引用了缺失或重复的节点：' + id); placed.add(id); };
    map.flow.forEach(place);
    if (map.supports !== undefined && !Array.isArray(map.supports)) fail('supports 需要是数组。');
    for (const item of map.supports || []) {
      if (!object(item) || !map.flow.includes(item.target) || !string(item.label)) fail('辅助模块需要指向主流程并说明关系。');
      place(item.id);
    }
    if (map.branches !== undefined) {
      if (!object(map.branches) || !map.flow.includes(map.branches.from) || !string(map.branches.title) || !Array.isArray(map.branches.items)) fail('分支需要起点、标题和节点清单。');
      for (const item of map.branches.items) {
        if (!object(item) || !map.flow.includes(item.returnsTo) || !string(item.label)) fail('分支需要返回位置和说明。');
        place(item.id);
      }
    }
    if (placed.size !== ids.size) fail('每个节点都需要在地图中有位置。');
    if (map.loop !== undefined && (!object(map.loop) || !map.flow.includes(map.loop.from) || !map.flow.includes(map.loop.to) || map.flow.indexOf(map.loop.from) <= map.flow.indexOf(map.loop.to) || !string(map.loop.label))) fail('回路需要从后续步骤返回前面的步骤。');
    if (map.defaultNode !== undefined && !ids.has(map.defaultNode)) fail('默认节点不存在。');
  }
  for (const key of ['brief', 'learning']) {
    const block = value[key];
    if (block === undefined) continue;
    if (!object(block) || !documentPath(block.source)) fail(key + ' 的来源需要是配置目录内的 Markdown 相对路径。');
    if (key === 'brief') {
      for (const field of ['current', 'next', 'attention']) if (!string(block[field])) fail('brief 需要 ' + field + ' 章节名称。');
    } else {
      if (block.enabled !== undefined && typeof block.enabled !== 'boolean') fail('learning.enabled 需要是布尔值。');
      if (!string(block.title) || !Array.isArray(block.sections) || block.sections.some(section => !object(section) || !string(section.title) || !string(section.heading))) fail('学习区域需要标题和来源章节。');
    }
  }
  return value;
}

async function readRelativeFile(root, path) {
  const parts = path.split('/');
  let directory = root;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
  return (await (await directory.getFileHandle(parts.at(-1))).getFile()).text();
}

export async function readPresentationDirectory(root) {
  let presentation = {};
  try { presentation = validatePresentation(JSON.parse(await readRelativeFile(root, 'board.json'))); }
  catch (error) { if (!missingEntry(error)) throw error; }
  const paths = [...new Set([presentation.brief?.source, presentation.learning?.enabled !== false && presentation.learning?.source].filter(Boolean))].sort();
  const entries = await Promise.all(paths.map(async path => {
    try { return [path, await readRelativeFile(root, path)]; }
    catch (error) { if (missingEntry(error)) return [path, null]; throw error; }
  }));
  return { presentation, documents: Object.fromEntries(entries) };
}

export async function readProjectDirectory(root) {
  let workspace = null;
  try { workspace = await root.getDirectoryHandle('.agents'); }
  catch (error) { if (!missingEntry(error)) throw error; }
  if (!workspace) {
    try { await root.getDirectoryHandle('notes'); workspace = root; }
    catch (error) { if (!missingEntry(error)) throw error; }
  }
  if (workspace) {
    const notesRoot = await workspace.getDirectoryHandle('notes');
    const [notes, assets] = await Promise.all([readNoteDirectory(notesRoot), readPresentationDirectory(workspace)]);
    return { notes, ...assets, scope: 'project', label: assets.presentation.name || (workspace === root ? '项目' : root.name) };
  }
  // A notes-only handle cannot read a sibling board.json or learning folder.
  // Do not carry the previously selected project's map into another directory.
  return { notes: await readNoteDirectory(await resolveNotesDirectory(root)), presentation: {}, documents: {}, scope: 'notes', label: '决策笔记' };
}

export function projectSignature(project) {
  return JSON.stringify([datasetSignature(project.notes), project.presentation, Object.entries(project.documents).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0), project.scope, project.label]);
}

export function documentSection(documents, source, heading) {
  const content = documents[source];
  if (typeof content !== 'string') return null;
  return splitSections(content).find(section => section.heading === heading)?.body ?? null;
}

export function firstParagraph(text) {
  if (!text) return '';
  return text.split(/\n\s*\n/).find(block => block.trim() && !/^(?:\s*[-*+|]|#{1,6}\s)/.test(block))?.trim() || '';
}

export function sectionItems(text) {
  return (text || '').split('\n').filter(line => /^\s*[-*+]\s+/.test(line)).map(line => line.replace(/^\s*[-*+]\s+/, ''));
}

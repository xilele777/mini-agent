// Note: 完整章节与稳定同步的依据见 .agents/notes/implemented/process/2026-09-12-readable-board-and-stable-sync.md
export const LIFECYCLES = ['implemented', 'proposed', 'rejected', 'archived'];
export const CLASSES = ['architecture', 'feature', 'bug-fix', 'simplification', 'process', 'testing'];
export const STATUS_LABELS = { implemented: '已落地', proposed: '待评审', rejected: '已否决', archived: '已归档' };
export const CLASS_LABELS = { architecture: '架构设计', feature: '功能特性', 'bug-fix': '缺陷修复', simplification: '简化设计', process: '开发流程', testing: '测试验证' };
export const SECTION_LABELS = { Problem: '问题背景', Decision: '决定', Proposal: '提案', 'Alternatives considered': '方案取舍', Consequences: '影响与代价', Verification: '验证与依据', 'Acceptance criteria': '验收标准', Risks: '风险' };

export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareNotes(a, b, mode = 'new', incoming = new Map()) {
  if (mode === 'references') {
    const difference = (incoming.get(b.id) || 0) - (incoming.get(a.id) || 0);
    if (difference) return difference;
  }
  const date = mode === 'old' ? compareText(a.date, b.date) : compareText(b.date, a.date);
  return date || compareText(a.id, b.id);
}

export function splitSections(raw) {
  const sections = [];
  let section = null;
  let fence = null;
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
    }
    const heading = !fence && /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      section = { heading: heading[1], lines: [] };
      sections.push(section);
    } else if (section) section.lines.push(line);
  }
  return sections.map(({ heading, lines }, index) => ({ heading, body: lines.join('\n').trim(), anchor: 'section-' + index }));
}

export function resolveNoteLink(id, href) {
  const clean = href.split(/[?#]/)[0].replace(/\\/g, '/').replace(/\.zh\.md$/, '.md');
  if (!clean || /^[a-z][a-z\d+.-]*:/i.test(clean) || clean.startsWith('/')) return null;
  const segments = id.split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!segments.length) return null;
      segments.pop();
    } else segments.push(part);
  }
  return segments.join('/');
}

export function buildDataset(files) {
  const selected = new Map();
  for (const file of [...files].sort((a, b) => compareText(a.path, b.path))) {
    const path = file.path.replace(/\\/g, '/');
    const parts = path.split('/');
    if (parts.length !== 3 || !LIFECYCLES.includes(parts[0]) || !CLASSES.includes(parts[1]) || !/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(parts[2])) continue;
    const id = path.replace(/\.zh\.md$/, '.md');
    if (!selected.has(id) || path.endsWith('.zh.md')) selected.set(id, { ...file, path });
  }
  const notes = [];
  for (const [id, file] of selected) {
    const rawBody = file.content;
    const title = /^\uFEFF?# Agent Note[^:：]*[:：]\s*(.+)$/m.exec(rawBody)?.[1].trim();
    const status = /^Status:\s*(.+)$/m.exec(rawBody)?.[1].trim();
    if (!title || !status) throw new Error('笔记暂时无法解析：' + file.path);
    const [lifecycle, cls, filename] = id.split('/');
    if (lifecycle !== 'archived' && !new RegExp('^' + lifecycle + '(?:$|\\s)').test(status)) throw new Error('笔记状态与目录不一致：' + file.path);
    const sections = splitSections(rawBody);
    const section = (...headings) => sections.find(item => headings.includes(item.heading))?.body || '';
    notes.push({
      id, sourcePath: file.path, slug: filename.replace(/\.md$/, ''), lifecycle, cls,
      date: filename.slice(0, 10), title, status, rawBody, sections,
      problem: section('Problem', '问题'),
      decision: section('Decision', 'Proposal', '决策', '提案'),
      alternatives: section('Alternatives considered', '曾考虑的替代方案', '曾考虑的备选'),
      consequences: section('Consequences', '后果'),
      outLinks: [],
    });
  }
  const ids = new Set(notes.map(note => note.id));
  for (const note of notes) {
    const links = new Set();
    for (const match of note.rawBody.matchAll(/\[[^\]\n]*\]\(([^)]+)\)/g)) {
      const target = resolveNoteLink(note.id, match[1].trim());
      if (target && target !== note.id && ids.has(target)) links.add(target);
    }
    note.outLinks = [...links].sort(compareText);
  }
  return notes.sort(compareNotes);
}

export function datasetSignature(notes) {
  // Compare the actual text, not mtime/size; equal-length edits must still refresh.
  return JSON.stringify([...notes].sort((a, b) => compareText(a.id, b.id)).map(note => [note.id, note.sourcePath, note.rawBody]));
}

export function alternativeItems(note) {
  return note.alternatives.split(/\n(?=###?\s|\s*[-*+]\s)/).map(text => text.replace(/^\s*(?:#{2,3}\s+|[-*+]\s+)/, '').trim()).filter(Boolean);
}

export function countReferences(notes) {
  const result = new Map(notes.map(note => [note.id, 0]));
  for (const note of notes) for (const id of note.outLinks) if (result.has(id)) result.set(id, result.get(id) + 1);
  return result;
}

export function groupNotes(notes, presentation = {}) {
  const byId = new Map(notes.map(note => [note.id, note]));
  const used = new Set();
  const groups = [];
  if (Array.isArray(presentation.groups)) {
    for (const group of presentation.groups) {
      const entries = [];
      for (const entry of group.notes || []) {
        if (!byId.has(entry.id) || used.has(entry.id)) continue;
        used.add(entry.id);
        entries.push({ note: byId.get(entry.id), label: entry.label || byId.get(entry.id).title });
      }
      if (entries.length) groups.push({ id: group.id, title: group.title, entries });
    }
  }
  // New or renamed notes stay visible even when the optional project grouping is stale.
  for (const cls of CLASSES) {
    const entries = notes.filter(note => !used.has(note.id) && note.cls === cls).sort(compareNotes).map(note => ({ note, label: note.title }));
    if (entries.length) groups.push({ id: 'class-' + cls, title: CLASS_LABELS[cls], entries });
  }
  return groups;
}

export async function resolveNotesDirectory(root) {
  try {
    const agents = await root.getDirectoryHandle('.agents');
    return await agents.getDirectoryHandle('notes');
  } catch (error) { if (error.name !== 'NotFoundError' && error.name !== 'TypeMismatchError') throw error; }
  if (root.name === '.agents') return root.getDirectoryHandle('notes');
  if (root.name === 'notes') return root;
  for await (const entry of root.values()) if (entry.kind === 'directory' && LIFECYCLES.includes(entry.name)) return root;
  throw new Error('请选择项目根目录或 .agents/notes 文件夹。');
}

export async function readNoteDirectory(root) {
  const files = [];
  async function walk(directory, parts = []) {
    const entries = [];
    for await (const entry of directory.values()) entries.push(entry);
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      if (entry.kind === 'directory' && (parts.length === 0 ? LIFECYCLES.includes(entry.name) : parts.length === 1 && CLASSES.includes(entry.name))) {
        await walk(entry, [...parts, entry.name]);
      } else if (parts.length === 2 && entry.kind === 'file' && entry.name.endsWith('.md')) {
        // A failed read rejects the entire scan; never publish a partial directory.
        const file = await entry.getFile();
        files.push({ path: [...parts, entry.name].join('/'), content: await file.text() });
      }
    }
  }
  await walk(root);
  return buildDataset(files);
}

export function createLiveSync({ read = readNoteDirectory, signatureOf = datasetSignature, countOf = value => value.length, commit, report = () => {} }) {
  let source = null;
  let generation = 0;
  let signature = null;
  let queued = false;
  let active = null;
  async function drain() {
    while (queued && source) {
      queued = false;
      const reading = source;
      const version = generation;
      try {
        const notes = await read(reading);
        if (version !== generation) continue;
        const next = signatureOf(notes);
        const changed = signature !== next;
        if (changed) {
          commit(notes);
          signature = next;
        }
        report({ ok: true, changed, count: countOf(notes), checkedAt: Date.now() });
      } catch (error) {
        if (version === generation) report({ ok: false, error });
      }
    }
  }
  function request() {
    if (!source) return Promise.resolve();
    queued = true;
    if (!active) active = Promise.resolve().then(drain).finally(() => {
      active = null;
      // A microtask can enqueue a check after drain exits but before this cleanup.
      if (queued && source) return request();
    });
    return active;
  }
  return {
    setSource(handle) {
      source = handle;
      generation++;
      signature = null;
      // A source change during a read invalidates that result and schedules the new source.
      queued = !!handle && !!active;
    },
    request,
  };
}

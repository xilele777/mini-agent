const $ = id => document.getElementById(id);
const config = window.__BOARD_CONFIG__;
let presentation = config.presentation || {};
const preferenceKey = 'notes-workspace:' + location.pathname + ':' + config.projectName;
const viewLabels = { overview: '项目地图', library: '决策资料', timeline: '演进记录', alternatives: '方案取舍' };
const mobileLayout = window.matchMedia('(max-width: 700px)');
const state = { notes: [], byId: new Map(), incoming: new Map(), groups: [], noteGroups: new Map(), labels: new Map(), showExcerpts: false, group: '', view: 'overview', selectedId: null, sourceId: null, nodeId: '', nodeExpanded: false, evidenceId: '', showLearning: false, documents: window.__PROJECT_DOCUMENTS__ || {}, scope: config.mode === 'snapshot' ? 'snapshot' : 'preview', label: config.projectName, query: '', cls: '', status: '', sort: 'new', month: '', connected: false, scrolls: new Map() };
try {
  const saved = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
  if (viewLabels[saved.view]) state.view = saved.view;
  if (CLASSES.includes(saved.cls)) state.cls = saved.cls;
  if (LIFECYCLES.includes(saved.status)) state.status = saved.status;
  if (['new', 'old', 'references'].includes(saved.sort)) state.sort = saved.sort;
  if (typeof saved.query === 'string') state.query = saved.query;
  if (typeof saved.group === 'string') state.group = saved.group;
  if (typeof saved.showExcerpts === 'boolean') state.showExcerpts = saved.showExcerpts;
  if (typeof saved.nodeId === 'string') state.nodeId = saved.nodeId;
  if (typeof saved.showLearning === 'boolean') state.showLearning = saved.showLearning;
  if (typeof saved.nodeExpanded === 'boolean') state.nodeExpanded = saved.nodeExpanded;
  if (typeof saved.evidenceId === 'string') state.evidenceId = saved.evidenceId;
  if (/^\d{4}-\d{2}$/.test(saved.month || '')) state.month = saved.month;
} catch { /* Reading preferences is optional, including on file:// pages. */ }

const htmlCache = new Map();
let readerOrigin = null;
let readerTrail = [];
let lastRouteHash = null;
let checkpointTimer;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const categoryTag = note => '<span class="class-tag"><span class="category-dot" style="--category:var(--' + note.cls + ')"></span>' + CLASS_LABELS[note.cls] + '</span>';
const statusBadge = note => '<span class="status-badge ' + note.lifecycle + '">' + STATUS_LABELS[note.lifecycle] + '</span>';
const plain = text => text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*#]/g, '').replace(/\s+/g, ' ').trim();
const noteButton = (note, className, content) => '<button class="' + className + '" data-note-id="' + escapeHtml(note.id) + '">' + content + '</button>';
const labelFor = note => state.labels.get(note.id) || note.title;
const selectedGroup = () => state.groups.find(group => group.id === state.group);
const groupTag = note => '<span class="group-tag">' + escapeHtml(state.noteGroups.get(note.id)?.title || CLASS_LABELS[note.cls]) + '</span>';
function decisionExcerpt(note) {
  const paragraph = plain((note.decision || note.problem).split(/\n\s*\n/)[0]).replace(/^(?:\d+\.|[-+])\s+/, '');
  // Excerpt the note's own first sentence; do not maintain a second project summary.
  return /^[\s\S]*?[。！？](?:[”」])?/.exec(paragraph)?.[0] || paragraph;
}
function setHtml(id, html) {
  if (htmlCache.get(id) !== html) { $(id).innerHTML = html; htmlCache.set(id, html); }
}
function rememberPreferences() {
  try { localStorage.setItem(preferenceKey, JSON.stringify(boardContext())); } catch { /* Optional. */ }
}

function notice(message = '') {
  for (const id of ['notice', 'reader-notice']) {
    if ($(id).textContent !== message) $(id).textContent = message;
    $(id).hidden = !message;
  }
}

let toastTimer;
function toast(message) {
  ($('reader-dialog').open ? $('reader-dialog') : document.body).append($('toast'));
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600);
}

function renderLink(label, href, note) {
  const text = inlineMarkdown(label, note, false);
  const target = resolveNoteLink(note.id, href);
  if (target && state.byId.has(target)) return '<a href="#note=' + encodeURIComponent(target) + '" data-note-id="' + escapeHtml(target) + '">' + text + '</a>';
  try {
    if (/^(?:javascript|data|vbscript):/i.test(href.trim())) return text;
    const base = new URL((config.noteBase || '.agents/notes') + '/' + note.sourcePath, location.href);
    const url = new URL(href, base);
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) return text;
    const documentTarget = Object.keys(state.documents).find(path => new URL(workspaceHref(path), location.href).href === url.href);
    if (documentTarget) return '<a href="#source=' + encodeURIComponent(documentTarget) + '" data-source-id="' + escapeHtml(documentTarget) + '">' + text + '</a>';
    const noteTarget = state.notes.find(item => new URL((config.noteBase || '.agents/notes') + '/' + item.sourcePath, location.href).href === url.href);
    if (noteTarget) return '<a href="#note=' + encodeURIComponent(noteTarget.id) + '" data-note-id="' + escapeHtml(noteTarget.id) + '">' + text + '</a>';
    return '<a href="' + escapeHtml(url.href) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
  } catch { return text; }
}

function inlineMarkdown(text, note, links = true) {
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let html = '', start = 0;
  for (const match of text.matchAll(pattern)) {
    html += escapeHtml(text.slice(start, match.index));
    if (match[1] !== undefined) html += '<code>' + escapeHtml(match[1]) + '</code>';
    else if (match[2] !== undefined) html += '<strong>' + escapeHtml(match[2]) + '</strong>';
    else html += links ? renderLink(match[3], match[4].trim(), note) : escapeHtml(match[3]);
    start = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(start));
}

function markdown(text, note) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  const special = line => /^(?:\s*$|\s*(?:`{3,}|~{3,})|#{3,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s?)/.test(line);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const code = []; index++;
      const end = new RegExp('^\\s*' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      while (index < lines.length && !end.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      output.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>'); continue;
    }
    const heading = /^(#{3,6})\s+(.+)$/.exec(line);
    if (heading) { output.push('<h3>' + inlineMarkdown(heading[2], note) + '</h3>'); index++; continue; }
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const rule = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      const items = [];
      while (index < lines.length) {
        const item = rule.exec(lines[index]);
        if (!item) break;
        const content = [item[1]]; index++;
        while (index < lines.length && lines[index].trim() && !special(lines[index])) content.push(lines[index++].trim());
        items.push('<li>' + inlineMarkdown(content.join(' '), note) + '</li>');
      }
      output.push('<' + (ordered ? 'ol' : 'ul') + '>' + items.join('') + '</' + (ordered ? 'ol' : 'ul') + '>'); continue;
    }
    if (/^>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^>/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ''));
      output.push('<blockquote>' + inlineMarkdown(quote.join(' '), note) + '</blockquote>'); continue;
    }
    if (line.trim().startsWith('|') && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[index + 1] || '')) {
      const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const head = cells(line); index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) rows.push(cells(lines[index++]));
      output.push('<div class="table-wrap"><table><thead><tr>' + head.map(cell => '<th>' + inlineMarkdown(cell, note) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(row => '<tr>' + row.map(cell => '<td>' + inlineMarkdown(cell, note) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>'); continue;
    }
    const paragraph = [line]; index++;
    while (index < lines.length && !special(lines[index])) paragraph.push(lines[index++]);
    output.push('<p>' + inlineMarkdown(paragraph.join('\n'), note).replace(/\n/g, '<br>') + '</p>');
  }
  return output.join('');
}

function renderNavigation() {
  document.querySelectorAll('.workspace-tabs [data-view]').forEach(element => {
    const active = element.dataset.view === state.view;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page'); else element.removeAttribute('aria-current');
  });
}

function relatedModules(group) {
  const links = new Map();
  for (const note of state.notes) for (const target of note.outLinks) {
    const from = state.noteGroups.get(note.id)?.id;
    const to = state.noteGroups.get(target)?.id;
    const other = from === group.id && to !== from ? to : to === group.id && from !== to ? from : null;
    if (other) links.set(other, (links.get(other) || 0) + 1);
  }
  return state.groups.filter(item => links.has(item.id)).map(item => ({ group: item, count: links.get(item.id) }));
}

function renderOverview() {
  const mapped = !!presentation.map;
  $('project-overview').hidden = !mapped;
  $('overview-summary').hidden = mapped;
  $('module-grid').hidden = mapped;
  if (mapped) { renderProjectOverview(); return; }
  const statuses = LIFECYCLES.map(key => ({ key, count: state.notes.filter(note => note.lifecycle === key).length })).filter(item => item.count);
  setHtml('overview-summary', '<p><strong>' + state.groups.length + '</strong> 个' + (presentation.groups?.length ? '模块' : '类别') + '<span>·</span><strong>' + state.notes.length + '</strong> 项决定</p><div class="overview-controls"><div class="overview-statuses">' + statuses.map(item => '<button class="status-filter-button" data-status="' + item.key + '" aria-label="查看' + item.count + '篇' + STATUS_LABELS[item.key] + '决策">' + statusBadge({ lifecycle: item.key }) + '<span>' + item.count + '</span></button>').join('') + '</div><button id="toggle-excerpts" class="excerpt-toggle" aria-pressed="' + state.showExcerpts + '">' + icon('book') + '<span>' + (state.showExcerpts ? '收起决定摘要' : '显示决定摘要') + '</span></button></div>');
  $('module-grid').classList.toggle('show-excerpts', state.showExcerpts);
  setHtml('module-grid', state.groups.map((group, index) => {
    const related = relatedModules(group);
    return '<section class="module-card" aria-labelledby="module-title-' + escapeHtml(group.id) + '"><header class="module-card-heading"><span class="module-number">' + String(index + 1).padStart(2, '0') + '</span><div><h2 id="module-title-' + escapeHtml(group.id) + '"><button data-group-id="' + escapeHtml(group.id) + '">' + escapeHtml(group.title) + icon('arrow') + '</button></h2></div></header><div class="module-decisions">' + group.entries.map(({ note, label }) => noteButton(note, 'module-decision', '<div class="module-decision-title"><h3>' + escapeHtml(label) + '</h3>' + statusBadge(note) + '</div><p>' + escapeHtml(decisionExcerpt(note)) + '</p>')).join('') + '</div>' + (related.length ? '<footer class="module-links"><span>' + icon('link') + '笔记关联</span><div>' + related.map(({ group: other, count }) => '<button data-group-id="' + escapeHtml(other.id) + '" title="' + count + ' 条跨模块笔记引用">' + escapeHtml(other.title) + '</button>').join('') + '</div></footer>' : '') + '</section>';
  }).join(''));
}

function workspaceHref(path) { return (config.workspaceBase || '.agents') + '/' + path; }
function documentContext(path) { return { id: '../' + path, sourcePath: '../' + path }; }
function sourceButton(path, label = '学习进度') { return '<button class="text-button source-button" data-source-id="' + escapeHtml(path) + '">' + icon('file') + escapeHtml(label) + icon('arrow') + '</button>'; }
function missingSection() { return '<p class="source-missing">来源文件或章节暂不可用，请核对项目资料。</p>'; }

function renderProjectOverview() {
  const map = presentation.map;
  if (!map.nodes.some(node => node.id === state.nodeId)) state.nodeId = map.defaultNode || map.flow[0];
  const nodes = new Map(map.nodes.map(node => [node.id, node]));
  const button = (id, kind, extra = '') => {
    const node = nodes.get(id);
    const index = map.flow.indexOf(id);
    return '<button class="map-node ' + kind + '" data-map-node="' + id + '" aria-expanded="false" aria-controls="map-detail"><span class="map-node-mark">' + (index >= 0 ? String(index + 1).padStart(2, '0') : icon(kind === 'support-node' ? 'layers' : 'branch')) + '</span><strong>' + escapeHtml(node.title) + '</strong><span class="map-node-caption">' + escapeHtml(node.caption) + '</span>' + extra + '<span class="node-chevron">' + icon('chevron') + '</span></button>';
  };
  $('map-title').textContent = map.title;
  const supports = (map.supports || []).map(item => '<div class="flow-support" style="--column:' + (map.flow.indexOf(item.target) + 1) + '">' + button(item.id, 'support-node') + '<span class="support-relation">' + escapeHtml(item.label) + '<span aria-hidden="true"> ↕</span><span class="sr-only">：' + escapeHtml(nodes.get(item.target).title) + '</span></span></div>').join('');
  const loop = map.loop ? '<div class="flow-loop-row" style="--flow-count:' + map.flow.length + '"><div class="flow-loop" style="--loop-start:' + (map.flow.indexOf(map.loop.to) + 1) + ';--loop-end:' + (map.flow.indexOf(map.loop.from) + 2) + ';--loop-span:' + (map.flow.indexOf(map.loop.from) - map.flow.indexOf(map.loop.to) + 1) + '"><span>' + escapeHtml(map.loop.label) + '<span aria-hidden="true"> ↺</span></span></div></div>' : '';
  const branches = map.branches ? '<section class="flow-branches"><div class="branch-caption">' + icon('branch') + '<span>' + escapeHtml(nodes.get(map.branches.from).title) + ' → ' + escapeHtml(map.branches.title) + '</span></div><div class="branch-nodes" style="--branch-count:' + map.branches.items.length + '">' + map.branches.items.map(item => button(item.id, 'branch-node', '<span class="branch-return">' + icon(item.returnsTo === map.flow[0] ? 'back' : 'refresh') + escapeHtml(item.label) + '</span>')).join('') + '</div><div id="branch-detail-slot" class="map-detail-slot" hidden></div></section>' : '';
  const diagram = '<div class="flow-diagram" style="--flow-count:' + map.flow.length + '"><div class="flow-supports">' + supports + '</div><div id="support-detail-slot" class="map-detail-slot" hidden></div><div class="flow-main" id="flow-main">' + map.flow.map((id, index) => '<div class="flow-step' + (index < map.flow.length - 1 ? ' has-next' : '') + '">' + button(id, 'main-node') + '</div>').join('') + (map.loop ? '<div class="mobile-flow-loop" id="mobile-flow-loop" aria-hidden="true"><span>' + escapeHtml(map.loop.label) + '</span></div>' : '') + '</div>' + loop + '<div id="flow-detail-slot" class="map-detail-slot" hidden></div></div>' + branches;
  // Keep the expanded panel alive when only the diagram configuration changes.
  if (htmlCache.get('project-map') !== diagram) {
    $('map-surface').append($('map-detail'));
    setHtml('project-map', diagram);
  }
  const related = new Set();
  if (state.nodeExpanded) {
    for (const item of map.supports || []) if (item.id === state.nodeId) related.add(item.target);
    for (const item of map.branches?.items || []) if (item.id === state.nodeId) { related.add(map.branches.from); related.add(item.returnsTo); }
  }
  document.querySelectorAll('#project-map [data-map-node]').forEach(element => {
    const expanded = state.nodeExpanded && element.dataset.mapNode === state.nodeId;
    element.classList.toggle('selected', expanded);
    element.classList.toggle('map-related', related.has(element.dataset.mapNode));
    element.setAttribute('aria-expanded', String(expanded));
  });
  renderMapDetail(nodes.get(state.nodeId));
  placeMapDetail();
  requestAnimationFrame(updateMapLayout);
  renderProjectBrief();
  renderLearning();
}

function renderMapDetail(selected) {
  const notes = selected.notes.map(id => state.byId.get(id)).filter(Boolean);
  if (!notes.some(note => note.id === state.evidenceId)) state.evidenceId = notes[0]?.id || '';
  const note = state.byId.get(state.evidenceId);
  let evidence = '<p class="source-missing">' + (!state.connected && !state.notes.length ? '连接目录后可读取取舍与验证记录。' : '相关决策暂不可用。') + '</p>';
  if (note) {
    const verification = note.sections.find(section => section.heading === 'Verification');
    const excerpt = verification && (firstParagraph(verification.body) || verification.body);
    evidence = '<div class="node-evidence-toolbar"><label><span class="sr-only">决策依据</span><select id="map-note-select">' + notes.map(item => '<option value="' + escapeHtml(item.id) + '"' + (item.id === note.id ? ' selected' : '') + '>' + escapeHtml(labelFor(item)) + '</option>').join('') + '</select></label>' + noteButton(note, 'text-button', '阅读全文' + icon('arrow')) + '</div>'
      + '<div class="node-evidence-columns"><section><h4>取舍</h4><p>' + escapeHtml(decisionExcerpt(note)) + '</p><details id="node-alternatives" class="node-alternatives"><summary>备选方案' + icon('chevron') + '</summary><ul>' + alternativeItems(note).map(item => '<li>' + inlineMarkdown(item, note) + '</li>').join('') + '</ul></details></section>'
      + '<section><h4>验证记录</h4><div class="markdown">' + (excerpt ? markdown(excerpt, note) : '<p>暂无验证记录。</p>') + '</div></section></div>';
  }
  setHtml('map-detail', '<div class="node-detail-heading"><h3 id="map-detail-title" tabindex="-1">' + escapeHtml(selected.title) + '</h3><button class="icon-button" data-map-close aria-label="收起' + escapeHtml(selected.title) + '" title="收起（Esc）">' + icon('close') + '</button></div>'
    + '<div class="node-detail-grid"><section class="node-implementation"><h4>实现</h4><ul>' + selected.behavior.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul><div class="detail-boundary"><h4>限制</h4><p>' + escapeHtml(selected.boundary) + '</p></div>'
    + (selected.sources?.length ? '<div class="detail-sources">' + selected.sources.map(source => '<a href="' + escapeHtml(workspaceHref(source.path)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.label) + icon('external') + '</a>').join('') + '</div>' : '')
    + '</section><section class="node-evidence">' + evidence + '</section></div>');
}

function placeMapDetail() {
  if (!presentation.map || !$('flow-main')) return;
  const detail = $('map-detail');
  const button = $('project-map').querySelector('[data-map-node="' + state.nodeId + '"]');
  if (!button) return;
  for (const slot of document.querySelectorAll('.map-detail-slot')) slot.hidden = true;
  let slot;
  if (button.classList.contains('support-node')) slot = $('support-detail-slot');
  else if (mobileLayout.matches) slot = button.parentElement;
  else slot = $(button.classList.contains('main-node') ? 'flow-detail-slot' : 'branch-detail-slot');
  if (mobileLayout.matches && button.classList.contains('branch-node')) {
    if (button.nextElementSibling !== detail) button.after(detail);
  } else if (detail.parentElement !== slot) slot.append(detail);
  if (slot.classList.contains('map-detail-slot')) slot.hidden = !state.nodeExpanded;
  detail.hidden = !state.nodeExpanded;
  if (state.nodeExpanded) {
    const source = button.getBoundingClientRect(), target = detail.getBoundingClientRect();
    detail.style.setProperty('--detail-anchor', Math.max(18, Math.min(target.width - 18, source.left + source.width / 2 - target.left)) + 'px');
  }
}

function renderProjectBrief() {
  const brief = presentation.brief;
  $('project-brief').hidden = !brief;
  $('project-focus').hidden = !brief;
  if (!brief) return;
  const current = documentSection(state.documents, brief.source, brief.current);
  const next = documentSection(state.documents, brief.source, brief.next);
  const attention = documentSection(state.documents, brief.source, brief.attention);
  const doc = documentContext(brief.source);
  setHtml('project-brief', '<div class="brief-item"><div class="current-marker">' + icon('check') + '<span>当前实现</span></div><div class="current-description">' + (current === null ? missingSection() : '<p>' + inlineMarkdown(firstParagraph(current), doc) + '</p>') + '</div></div><div class="brief-item brief-next"><div class="current-marker">' + icon('arrow') + '<span>下一步候选</span></div><div class="current-description">' + (next === null ? missingSection() : '<p>' + inlineMarkdown(firstParagraph(next), doc) + '</p>') + '</div></div>' + sourceButton(brief.source));
  const nextDetail = next && firstParagraph(next.split(/\n\s*\n/).slice(1).join('\n\n'));
  setHtml('project-focus', '<section class="focus-card next-focus"><h2>下一步</h2>' + (next === null ? missingSection() : '<p>' + inlineMarkdown(nextDetail || firstParagraph(next), doc) + '</p>') + '</section><section class="focus-card attention-focus"><h2>待验证</h2>' + (attention === null ? missingSection() : '<ul>' + sectionItems(attention).map(item => '<li>' + inlineMarkdown(item, doc) + '</li>').join('') + '</ul>') + '</section>');
}

function updateMapLayout() {
  if ($('overview-view').hidden) return;
  placeMapDetail();
  const loop = presentation.map?.loop;
  const element = $('mobile-flow-loop');
  if (!loop || !element || !mobileLayout.matches) return;
  const main = $('flow-main');
  const from = main.querySelector('[data-map-node="' + loop.from + '"]').getBoundingClientRect();
  const to = main.querySelector('[data-map-node="' + loop.to + '"]').getBoundingClientRect();
  const top = main.getBoundingClientRect().top;
  element.style.top = to.top + to.height / 2 - top + 'px';
  element.style.height = from.top + from.height / 2 - to.top - to.height / 2 + 'px';
}
window.addEventListener('resize', updateMapLayout);
new ResizeObserver(updateMapLayout).observe($('project-map'));

function renderLearning() {
  const learning = presentation.learning;
  const enabled = !!learning && learning.enabled !== false;
  $('learning-panel').hidden = !enabled;
  if (!enabled) { setHtml('learning-content', ''); return; }
  $('learning-title').textContent = learning.title;
  $('learning-toggle').setAttribute('aria-expanded', String(state.showLearning));
  $('learning-content').hidden = !state.showLearning;
  setHtml('learning-content', '<div class="learning-columns">' + learning.sections.map(section => {
    const body = documentSection(state.documents, learning.source, section.heading);
    return '<section><h3>' + escapeHtml(section.title) + '</h3><div class="markdown">' + (body === null ? missingSection() : markdown(body, documentContext(learning.source))) + '</div></section>';
  }).join('') + '</div><div class="learning-source">' + sourceButton(learning.source, '进度原文') + '</div>');
}

function openMapNode(id) {
  if (!presentation.map?.nodes.some(node => node.id === id)) return;
  if (state.nodeExpanded && state.nodeId === id) { collapseMapNode(); return; }
  checkpoint();
  const button = $('project-map').querySelector('[data-map-node="' + id + '"]');
  const top = button.getBoundingClientRect().top;
  state.nodeId = id; state.nodeExpanded = true; state.evidenceId = '';
  state.view = 'overview'; state.selectedId = null; state.sourceId = null;
  clearFilters(); setHash('#map=' + encodeURIComponent(id)); render();
  $('main-scroll').scrollTop += button.getBoundingClientRect().top - top;
  button.focus({ preventScroll: true });
  const panelTop = $('map-detail').getBoundingClientRect().top;
  const bottom = $('main-scroll').getBoundingClientRect().bottom;
  if (panelTop > bottom - 100) $('main-scroll').scrollTop += panelTop - bottom + 140;
}

function collapseMapNode() {
  checkpoint();
  const button = $('project-map').querySelector('[data-map-node="' + state.nodeId + '"]');
  const top = button?.getBoundingClientRect().top;
  state.nodeExpanded = false;
  setHash('#overview'); render();
  if (button && top !== undefined) {
    $('main-scroll').scrollTop += button.getBoundingClientRect().top - top;
    button.focus({ preventScroll: true });
    button.scrollIntoView({ block: 'nearest' });
  }
}

function filteredNotes() {
  const query = state.query.trim().toLowerCase();
  return state.notes.filter(note => (!state.group || state.noteGroups.get(note.id)?.id === state.group) && (!state.cls || note.cls === state.cls) && (!state.status || note.lifecycle === state.status) && (!query || (labelFor(note) + '\n' + note.title + '\n' + note.id + '\n' + note.rawBody).toLowerCase().includes(query))).sort((a, b) => compareNotes(a, b, state.sort, state.incoming));
}

function emptyResults() {
  return '<div class="empty-state">' + icon('search') + '<h2>无匹配记录</h2><button class="button" data-reset>清除筛选</button></div>';
}

function renderCollection() {
  let notes = filteredNotes();
  setHtml('group-filter', '<option value="">全部模块</option>' + state.groups.map(group => '<option value="' + escapeHtml(group.id) + '">' + escapeHtml(group.title) + '</option>').join(''));
  $('group-filter').value = state.group;
  $('status-filter').value = state.status;
  $('class-filter').value = state.cls;
  $('sort-select').value = state.sort;
  $('reset-filters').hidden = !state.group && !state.cls && !state.status && !state.query && !state.month;
  $('month-filters').hidden = state.view !== 'timeline';
  const months = [...new Set(notes.map(note => note.date.slice(0, 7)))].sort((a, b) => compareText(b, a));
  if (state.view === 'timeline') {
    setHtml('month-filters', [{ key: '', label: '全部月份' }, ...months.map(key => ({ key, label: key }))].map(month => '<button data-month="' + month.key + '" class="' + (state.month === month.key ? 'active' : '') + '" aria-pressed="' + (state.month === month.key) + '">' + month.label + '</button>').join(''));
    if (state.month) notes = notes.filter(note => note.date.startsWith(state.month));
  }
  $('results-summary').textContent = state.view === 'alternatives' ? notes.reduce((sum, note) => sum + alternativeItems(note).length, 0) + ' 个方案' : notes.length + ' 项';
  if (!notes.length) { setHtml('collection-content', emptyResults()); return; }
  if (state.view === 'library') {
    setHtml('collection-content', '<div class="decision-list">' + notes.map(note => noteButton(note, 'decision-row', '<div><h2>' + escapeHtml(labelFor(note)) + '</h2><p>' + escapeHtml(decisionExcerpt(note)) + '</p><div class="row-meta">' + groupTag(note) + '<span>·</span>' + categoryTag(note) + statusBadge(note) + (state.incoming.get(note.id) ? '<span>·</span><span>' + state.incoming.get(note.id) + ' 篇引用</span>' : '') + '</div></div><div class="decision-side"><time>' + note.date + '</time>' + icon('arrow') + '</div>')).join('') + '</div>');
  } else if (state.view === 'timeline') {
    const groups = new Map();
    for (const note of notes) {
      const month = note.date.slice(0, 7);
      if (!groups.has(month)) groups.set(month, []);
      groups.get(month).push(note);
    }
    const ordered = [...groups].sort(([a], [b]) => state.sort === 'old' ? compareText(a, b) : compareText(b, a));
    setHtml('collection-content', ordered.map(([month, items]) => '<section class="timeline-group"><h2 class="timeline-label">' + month + '<small>' + items.length + ' 篇记录</small></h2><div class="timeline-items">' + items.map(note => noteButton(note, 'timeline-card', '<div class="row-meta"><time>' + note.date + '</time><span>·</span>' + groupTag(note) + statusBadge(note) + '</div><h3>' + escapeHtml(labelFor(note)) + '</h3><p>' + escapeHtml(decisionExcerpt(note)) + '</p>')).join('') + '</div></section>').join(''));
  } else {
    setHtml('collection-content', '<div class="alternatives-grid">' + notes.map(note => '<article class="alternative-group" data-alternative-id="' + escapeHtml(note.id) + '"><div class="row-meta">' + groupTag(note) + '<time>' + note.date + '</time></div>' + noteButton(note, 'alternative-heading', escapeHtml(labelFor(note)) + icon('arrow')) + alternativeItems(note).map((text, index) => {
      const colon = text.search(/[：:]/);
      const title = colon > 0 && colon < 50 ? text.slice(0, colon) : '备选 ' + (index + 1);
      const reason = colon > 0 && colon < 50 ? text.slice(colon + 1) : text;
      return '<div class="alternative-option"><h3><span class="option-number">' + String(index + 1).padStart(2, '0') + '</span><span>' + inlineMarkdown(title, note) + '</span></h3><p>' + inlineMarkdown(reason, note) + '</p></div>';
    }).join('') + (note.lifecycle === 'rejected' ? '<p class="markdown">' + escapeHtml(note.status) + '</p>' : '') + '</article>').join('') + '</div>');
  }
}

function renderReader() {
  if (state.sourceId) { renderDocumentReader(); return; }
  const note = state.byId.get(state.selectedId);
  if (!note) {
    setHtml('reader-content', '<div class="empty-state">' + icon('file') + '<h1 id="reader-title" tabindex="-1">这篇笔记已移走或删除</h1><p>可以返回列表查看当前记录；目录暂未连接时，请先连接笔记目录。</p></div>');
    setHtml('reader-related', ''); return;
  }
  const source = (config.noteBase || '.agents/notes') + '/' + note.sourcePath;
  const headingIndex = note.rawBody.search(/^##\s/m);
  const preamble = (headingIndex < 0 ? '' : note.rawBody.slice(0, headingIndex)).split('\n').filter(line => line.trim() && !/^#|^Status:/.test(line)).join(' ');
  setHtml('reader-content', '<header class="reader-header"><div class="row-meta">' + statusBadge(note) + '<span>·</span><time>' + note.date + '</time></div><h1 tabindex="-1" id="reader-title">' + escapeHtml(note.title) + '</h1><a class="reader-source" href="' + escapeHtml(source) + '" title="' + escapeHtml(source) + '" target="_blank" rel="noopener noreferrer">' + icon('file') + '<span>查看 Markdown 原文</span>' + icon('external') + '</a>' + (preamble ? '<p class="reader-preamble">' + escapeHtml(preamble) + '</p>' : '') + '</header><nav class="reader-quick-nav" aria-label="章节快捷导航">' + note.sections.map(section => '<a href="#' + section.anchor + '" data-section="' + section.anchor + '">' + escapeHtml(SECTION_LABELS[section.heading] || section.heading) + '</a>').join('') + '</nav>' + note.sections.map(section => '<section id="' + section.anchor + '" class="reader-section"><h2>' + escapeHtml(SECTION_LABELS[section.heading] || section.heading) + '</h2><div class="markdown">' + markdown(section.body, note) + '</div></section>').join('') + '<div class="reader-tools"><button class="button" id="copy-note-path">' + icon('link') + '复制笔记路径</button></div>');
  const related = (heading, notes) => '<section class="related-group"><h2>' + heading + '<span>' + notes.length + '</span></h2>' + (notes.length ? notes.map(item => noteButton(item, 'related-link', '<span>' + escapeHtml(labelFor(item)) + '</span><small>' + escapeHtml(state.noteGroups.get(item.id)?.title || CLASS_LABELS[item.cls]) + '</small>')).join('') : '<p class="related-empty">暂无关联</p>') + '</section>';
  const outgoing = note.outLinks.map(id => state.byId.get(id)).filter(Boolean).sort(compareNotes);
  const incoming = state.notes.filter(item => item.outLinks.includes(note.id));
  setHtml('reader-related', related('引用的笔记', outgoing) + related('被这些笔记引用', incoming));
}

function renderDocumentReader() {
  const path = state.sourceId;
  const body = state.documents[path];
  if (typeof body !== 'string') {
    setHtml('reader-content', '<div class="empty-state">' + icon('file') + '<h1 id="reader-title" tabindex="-1">这份项目资料暂不可用</h1><p>请核对来源路径，或连接包含展示配置与进度记录的项目目录。</p></div>');
    setHtml('reader-related', ''); return;
  }
  const context = documentContext(path);
  const title = /^#\s+(.+)$/m.exec(body)?.[1] || path;
  const sections = splitSections(body);
  const headingIndex = body.search(/^##\s/m);
  const preamble = (headingIndex < 0 ? body : body.slice(0, headingIndex)).replace(/^#\s+.*\r?\n/m, '').trim();
  setHtml('reader-content', '<header class="reader-header"><h1 id="reader-title" tabindex="-1">' + escapeHtml(title) + '</h1><a class="reader-source" href="' + escapeHtml(workspaceHref(path)) + '" target="_blank" rel="noopener noreferrer">' + icon('file') + '<span>' + escapeHtml(path) + '</span>' + icon('external') + '</a>' + (preamble ? '<div class="reader-preamble markdown">' + markdown(preamble, context) + '</div>' : '') + '</header>' + sections.map(section => '<section id="' + section.anchor + '" class="reader-section"><h2>' + escapeHtml(section.heading) + '</h2><div class="markdown">' + markdown(section.body, context) + '</div></section>').join(''));
  setHtml('reader-related', '');
}

// Note: 全宽画布、原位展开与居中阅读层，见 .agents/notes/implemented/process/2026-09-12-readable-board-and-stable-sync.md
function render() {
  const reading = !!(state.selectedId || state.sourceId);
  const mapped = !!presentation.map && state.view === 'overview';
  const empty = !state.notes.length && !mapped;
  $('onboarding').hidden = !empty;
  $('overview-view').hidden = empty || state.view !== 'overview';
  $('collection-view').hidden = empty || state.view === 'overview';
  const group = selectedGroup();
  $('topbar-project-name').textContent = presentation.name || state.label;
  $('page-title').textContent = state.view === 'library' && group ? group.title : viewLabels[state.view];
  if (empty) {
    $('onboarding-title').textContent = state.connected ? '暂无决策' : config.mode === 'snapshot' ? '快照中暂无决策' : '尚未连接目录';
    $('onboarding-description').textContent = state.connected ? '在笔记目录中添加 Markdown 笔记。' : '选择项目根目录或 .agents。';
  }
  renderNavigation();
  if (!empty && state.view === 'overview') renderOverview();
  else if (!empty) renderCollection();
  const dialog = $('reader-dialog');
  if (reading) {
    renderReader();
    $('reader-back').hidden = !readerTrail.length;
    if (!dialog.open) {
      readerOrigin ||= { context: boardContext(), position: capturePosition(), hash: collectionHash() };
      dialog.showModal();
      $('reader-title')?.focus({ preventScroll: true });
    }
  } else if (dialog.open) dialog.close();
  rememberPreferences();
}

const scrollTargets = '.map-node, #map-detail, #project-brief, #project-focus, #learning-panel, .decision-row, .timeline-card, [data-alternative-id], .module-decision, .reader-section';
function captureScroll(element) {
  const top = element.getBoundingClientRect().top;
  const anchor = [...element.querySelectorAll(scrollTargets)].find(item => item.getClientRects().length && item.getBoundingClientRect().bottom > top + 10);
  return { scroll: element.scrollTop, id: anchor?.id, note: anchor?.dataset.noteId, alternative: anchor?.dataset.alternativeId, node: anchor?.dataset.mapNode, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
}
function restoreScroll(element, position) {
  if (!position) return;
  element.scrollTop = position.scroll;
  const anchor = [...element.querySelectorAll(scrollTargets)].find(item => item.getClientRects().length && ((position.id && item.id === position.id) || (position.note && item.dataset.noteId === position.note) || (position.alternative && item.dataset.alternativeId === position.alternative) || (position.node && item.dataset.mapNode === position.node)));
  if (anchor) element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top - position.offset;
}
function capturePosition() {
  const focus = document.activeElement;
  return {
    main: captureScroll($('main-scroll')), reader: captureScroll($('reader-scroll')),
    evidenceId: state.evidenceId, alternativesOpen: $('node-alternatives')?.open,
    focusElement: focus, focusId: focus?.id, focusNote: focus?.dataset.noteId,
    focusGroup: focus?.dataset.groupId, focusMap: focus?.dataset.mapNode,
    focusSource: focus?.dataset.sourceId, inReader: !!focus?.closest?.('#reader-dialog'),
  };
}
function restorePosition(position, { focus = false } = {}) {
  if (!position) return;
  if (state.evidenceId === position.evidenceId && $('node-alternatives') && position.alternativesOpen !== undefined) $('node-alternatives').open = position.alternativesOpen;
  restoreScroll($('main-scroll'), position.main);
  if ($('reader-dialog').open) restoreScroll($('reader-scroll'), position.reader);
  if (focus || (position.focusElement && !position.focusElement.isConnected)) {
    const scope = position.inReader && $('reader-dialog').open ? $('reader-dialog') : $('main-scroll');
    const replacement = (position.focusElement?.isConnected && position.focusElement.getClientRects().length && position.focusElement)
      || (position.focusId && $(position.focusId)?.getClientRects().length && $(position.focusId))
      || [...scope.querySelectorAll('[data-note-id], [data-group-id], [data-map-node], [data-source-id]')].find(element => element.getClientRects().length && ((position.focusNote && element.dataset.noteId === position.focusNote) || (position.focusGroup && element.dataset.groupId === position.focusGroup) || (position.focusMap && element.dataset.mapNode === position.focusMap) || (position.focusSource && element.dataset.sourceId === position.focusSource)));
    (replacement || ($('reader-dialog').open ? $('reader-title') : $('page-title')))?.focus({ preventScroll: true });
  }
}

function storedPosition(position) {
  if (!position) return null;
  const { focusElement, ...stored } = position;
  return stored;
}
function restoreHistoryPosition() {
  restorePosition(history.state?.position || {
    main: { scroll: history.state?.mainScroll || 0 },
    reader: { scroll: history.state?.readerScroll || 0 },
  });
}

function applyDataset(notes) {
  const position = capturePosition();
  state.notes = [...notes].sort(compareNotes);
  state.byId = new Map(state.notes.map(note => [note.id, note]));
  state.incoming = countReferences(state.notes);
  state.groups = groupNotes(state.notes, presentation);
  state.noteGroups = new Map(state.groups.flatMap(group => group.entries.map(({ note }) => [note.id, group])));
  state.labels = new Map(state.groups.flatMap(group => group.entries.map(({ note, label }) => [note.id, label])));
  if (state.group && !selectedGroup()) state.group = '';
  render();
  restorePosition(position);
}

const contextKeys = ['view', 'query', 'cls', 'status', 'sort', 'month', 'group', 'showExcerpts', 'nodeId', 'nodeExpanded', 'evidenceId', 'showLearning'];
function boardContext() { return Object.fromEntries(contextKeys.map(key => [key, state[key]])); }
function restoreBoardContext(context) {
  if (!context || !viewLabels[context.view]) return;
  for (const key of contextKeys) if (typeof context[key] === typeof state[key]) state[key] = context[key];
  if (state.groups.length && state.group && !selectedGroup()) state.group = '';
  $('search-input').value = state.query;
}
function routeKey() { return JSON.stringify([state.view, state.group, state.query, state.cls, state.status, state.month, state.sort]); }
function collectionHash() {
  return state.view === 'library' && state.group ? '#module=' + encodeURIComponent(state.group)
    : state.view === 'overview' && presentation.map && state.nodeExpanded ? '#map=' + encodeURIComponent(state.nodeId)
    : '#' + state.view;
}
function checkpoint() {
  clearTimeout(checkpointTimer);
  history.replaceState({
    ...history.state, board: boardContext(), position: storedPosition(capturePosition()),
    readerOrigin: readerOrigin && { ...readerOrigin, position: storedPosition(readerOrigin.position) },
    readerTrail,
  }, '', location.href);
}
function scheduleCheckpoint() {
  clearTimeout(checkpointTimer);
  checkpointTimer = setTimeout(checkpoint, 180);
}
function setHash(hash, replace = false, metadata = null) {
  clearTimeout(checkpointTimer);
  const data = metadata || { board: boardContext() };
  history[replace || location.hash === hash ? 'replaceState' : 'pushState'](data, '', hash);
  lastRouteHash = location.hash;
}
function goToView(view, { reset = false, group = null } = {}) {
  if (!viewLabels[view]) return;
  checkpoint();
  state.scrolls.set(routeKey(), $('main-scroll').scrollTop);
  if (reset) { clearFilters(); if (view === 'overview') state.nodeExpanded = false; }
  if (group !== null) state.group = group;
  state.view = view; state.selectedId = null; state.sourceId = null;
  readerOrigin = null; readerTrail = [];
  setHash(collectionHash()); render();
  $('main-scroll').scrollTop = state.scrolls.get(routeKey()) || 0;
  $('page-title').focus({ preventScroll: true });
}
function openReader(id, source = false) {
  const alreadyOpen = $('reader-dialog').open;
  if (alreadyOpen) {
    readerTrail.push({ selectedId: state.selectedId, sourceId: state.sourceId, position: captureScroll($('reader-scroll')) });
  } else {
    checkpoint();
    readerOrigin = { context: boardContext(), position: capturePosition(), hash: collectionHash() };
    readerTrail = [];
  }
  state.selectedId = source ? null : id; state.sourceId = source ? id : null;
  setHash((source ? '#source=' : '#note=') + encodeURIComponent(id), alreadyOpen, { board: readerOrigin.context, readerLayer: alreadyOpen ? history.state?.readerLayer === true : true, originHash: readerOrigin.hash });
  render();
  $('reader-scroll').scrollTop = 0;
  $('reader-title')?.focus({ preventScroll: true });
  checkpoint();
}
function openNote(id) { openReader(id); }
function openDocument(path) { openReader(path, true); }
function readerBack() {
  const previous = readerTrail.pop();
  if (!previous) return;
  state.selectedId = previous.selectedId; state.sourceId = previous.sourceId;
  setHash((state.sourceId ? '#source=' : '#note=') + encodeURIComponent(state.sourceId || state.selectedId), true, history.state);
  render();
  restoreScroll($('reader-scroll'), previous.position);
  $('reader-title')?.focus({ preventScroll: true });
  checkpoint();
}
function closeReader() {
  if (!$('reader-dialog').open) return;
  checkpoint();
  if (history.state?.readerLayer) { history.back(); return; }
  const origin = readerOrigin;
  state.selectedId = null; state.sourceId = null;
  if (origin) restoreBoardContext(origin.context);
  setHash(collectionHash(), true); render();
  restorePosition(origin?.position, { focus: true });
  readerOrigin = null; readerTrail = [];
}
function readRoute() {
  let hash = location.hash.slice(1);
  state.selectedId = null; state.sourceId = null;
  if (hash.startsWith('note=')) {
    try { state.selectedId = decodeURIComponent(hash.slice(5)); } catch { /* Invalid fragment. */ }
  } else if (hash.startsWith('source=')) {
    try { state.sourceId = decodeURIComponent(hash.slice(7)); } catch { /* Invalid fragment. */ }
  } else if (hash.startsWith('map=')) {
    try { state.nodeId = decodeURIComponent(hash.slice(4)); } catch { state.nodeId = ''; }
    state.view = 'overview'; state.nodeExpanded = true; clearFilters();
  } else if (hash.startsWith('module=')) {
    let group;
    try { group = decodeURIComponent(hash.slice(7)); } catch { group = ''; }
    if (state.group !== group) clearFilters();
    state.group = group; state.view = 'library';
  } else {
    hash = { baseline: 'overview', directory: 'library' }[hash] || hash;
    if (viewLabels[hash]) { state.view = hash; state.group = ''; if (hash === 'overview') state.nodeExpanded = false; }
  }
  restoreBoardContext(history.state?.board);
  if (state.selectedId || state.sourceId) {
    readerOrigin = history.state?.readerOrigin || null;
    readerTrail = history.state?.readerTrail || [];
  }
  lastRouteHash = location.hash;
}
function handleRoute() {
  if (lastRouteHash === location.hash) return;
  clearTimeout(checkpointTimer);
  const wasReading = $('reader-dialog').open;
  const origin = readerOrigin;
  readRoute(); render();
  if (!$('reader-dialog').open) {
    if (wasReading && origin && location.hash === origin.hash) restorePosition(origin.position, { focus: true });
    else if (history.state?.position) restoreHistoryPosition();
    else $('main-scroll').scrollTop = state.scrolls.get(routeKey()) || 0;
    readerOrigin = null; readerTrail = [];
  } else {
    restoreHistoryPosition();
    $('reader-title')?.focus({ preventScroll: true });
  }
}
function clearFilters() {
  state.query = ''; state.cls = ''; state.status = ''; state.month = ''; state.group = '';
  $('search-input').value = '';
}
function resetFilters() {
  checkpoint(); clearFilters(); setHash(collectionHash()); render(); $('main-scroll').scrollTop = 0;
}

async function savedDirectory(handle) {
  let database;
  try {
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('AgentNotesBoardDB', 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('handles')) request.result.createObjectStore('handles'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction('handles', handle ? 'readwrite' : 'readonly');
      const store = transaction.objectStore('handles');
      const request = handle ? store.put(handle, preferenceKey) : store.get(preferenceKey);
      transaction.oncomplete = () => resolve(handle || request.result || null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } catch { return null; }
  finally { database?.close(); }
}

let directory = null;
let latestSync = null;
let connectAttempt = 0;
const liveSync = createLiveSync({
  read: readProjectDirectory,
  signatureOf: projectSignature,
  countOf: value => value.notes.length,
  commit(project) {
    state.connected = true;
    presentation = project.presentation;
    state.documents = project.documents;
    state.scope = project.scope;
    state.label = project.label;
    applyDataset(project.notes);
  },
  report(result) {
    latestSync = result;
    const position = capturePosition();
    if (result.ok) {
      $('sync-dot').className = 'status-dot live';
      $('source-status').textContent = '自动同步';
      $('source-status').title = directory.name + ' · 上次检查：' + new Date(result.checkedAt).toLocaleTimeString('zh-CN');
      $('connect-button').querySelector('span').textContent = '切换目录';
      $('connect-button').title = '切换项目目录';
      $('connect-button').setAttribute('aria-label', '切换项目目录');
      notice(state.scope === 'notes' ? '当前只连接了 notes 文件夹。连接项目根目录或 .agents 后，即可一并读取项目地图与进度记录。' : '');
    } else {
      $('sync-dot').className = 'status-dot error';
      $('source-status').textContent = '同步失败';
      $('source-status').title = '保留上次内容，下次检查时重试';
      const permission = ['NotAllowedError', 'SecurityError'].includes(result.error?.name);
      notice(permission ? '目录访问权限已失效，请重新连接项目目录。当前内容已保留。' : '暂时无法读取完整项目资料，将在下次检查时重试。' + (result.error?.message ? ' ' + result.error.message : ''));
    }
    restorePosition(position);
  },
});

async function connectDirectory() {
  if (!('showDirectoryPicker' in window)) {
    notice('连接本地目录需要 Chrome 或 Edge。当前浏览器可以直接打开 board.snapshot.html 阅读离线快照。'); return;
  }
  const attempt = ++connectAttempt;
  try {
    const picked = await window.showDirectoryPicker({ mode: 'read', id: 'agent-notes' });
    if (attempt !== connectAttempt) return;
    directory = picked;
    $('source-status').textContent = '正在读取…';
    $('refresh-button').disabled = false;
    $('refresh-button').hidden = false;
    liveSync.setSource(picked);
    await liveSync.request();
    if (attempt === connectAttempt && latestSync?.ok) await savedDirectory(picked);
  } catch (error) {
    if (attempt === connectAttempt && error.name !== 'AbortError') notice(error.message || '目录连接失败，请重新选择笔记目录。');
  }
}

document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const mapNode = target.closest('[data-map-node]');
  if (mapNode) { openMapNode(mapNode.dataset.mapNode); return; }
if (target.closest('[data-map-close]')) { collapseMapNode(); return; }

  const source = target.closest('[data-source-id]');
  if (source) {
    if (source.tagName === 'A' && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    event.preventDefault(); openDocument(source.dataset.sourceId); return;
  }
  const note = target.closest('[data-note-id]');
  if (note) {
    if (note.tagName === 'A' && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    event.preventDefault(); openNote(note.dataset.noteId); return;
  }
  const view = target.closest('[data-view]');
  if (view) { event.preventDefault(); goToView(view.dataset.view, { reset: true }); return; }
  if (target.closest('#toggle-excerpts')) {
    state.showExcerpts = !state.showExcerpts;
    renderOverview(); rememberPreferences(); $('toggle-excerpts').focus({ preventScroll: true }); return;
  }


  const group = target.closest('[data-group-id]');
  if (group) {
    goToView('library', { reset: true, group: group.dataset.groupId });
    $('main-scroll').scrollTop = 0; return;
  }
  const status = target.closest('[data-status]');
  if (status) { clearFilters(); state.status = status.dataset.status; goToView('library'); $('main-scroll').scrollTop = 0; return; }
  const month = target.closest('[data-month]');
  if (month) { state.month = month.dataset.month; render(); return; }
  const section = target.closest('[data-section]');
  if (section) { event.preventDefault(); $(section.dataset.section)?.scrollIntoView({ block: 'start' }); return; }
  if (target.closest('[data-reset]')) resetFilters();
  if (target.closest('[data-connect]')) void connectDirectory();
  if (target.closest('#copy-note-path')) {
    const current = state.byId.get(state.selectedId);
    if (current) {
      const path = (config.noteBase || '.agents/notes') + '/' + current.sourcePath;
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(path).then(() => toast('已复制笔记路径'), () => toast('复制未成功，可右键“查看 Markdown 原文”复制链接。'));
      else toast('可右键“查看 Markdown 原文”复制链接。');
    }
  }
});
$('reader-back').addEventListener('click', readerBack);
$('reader-close').addEventListener('click', closeReader);
$('reader-dialog').addEventListener('cancel', event => { event.preventDefault(); closeReader(); });
$('reader-dialog').addEventListener('click', event => {
  if (event.target !== $('reader-dialog')) return;
  const rect = $('reader-dialog').getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeReader();
});
document.addEventListener('change', event => {
  if (event.target.id !== 'map-note-select') return;
  const position = capturePosition();
  state.evidenceId = event.target.value;
  renderMapDetail(presentation.map.nodes.find(node => node.id === state.nodeId));
  restorePosition(position); rememberPreferences();
});
$('reset-filters').addEventListener('click', resetFilters);
$('connect-button').addEventListener('click', () => void connectDirectory());
const manualRefresh = async () => {
  await liveSync.request();
  if (latestSync?.ok) toast(latestSync.changed ? '已更新项目资料' : '已是最新内容');
};
$('refresh-button').addEventListener('click', manualRefresh);
$('learning-toggle').addEventListener('click', () => {
  state.showLearning = !state.showLearning; renderLearning(); rememberPreferences();
});
$('search-input').value = state.query;
$('search-input').addEventListener('input', event => {
  const query = event.target.value;
  if (state.selectedId || state.sourceId || state.view === 'overview') { clearFilters(); state.selectedId = null; state.sourceId = null; state.view = 'library'; setHash('#library'); }
  state.query = query; $('search-input').value = query;
  render(); $('main-scroll').scrollTop = 0;
});
for (const [id, key] of [['group-filter', 'group'], ['status-filter', 'status'], ['class-filter', 'cls'], ['sort-select', 'sort']]) {
  $(id).addEventListener('change', event => {
    state[key] = event.target.value;
    if (key !== 'sort') state.month = '';
    if (key === 'group') setHash(collectionHash());
    render(); $('main-scroll').scrollTop = 0;
  });
}
setHtml('class-filter', '<option value="">全部类别</option>' + CLASSES.map(cls => '<option value="' + cls + '">' + CLASS_LABELS[cls] + '</option>').join(''));
window.addEventListener('keydown', event => {
  const editing = event.target instanceof Element && (event.target.matches('input, textarea, select') || event.target.isContentEditable);
  if (!$('reader-dialog').open && ((event.key === '/' && !editing) || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'))) {
    event.preventDefault(); $('search-input').focus(); $('search-input').select();
  }
  if (event.key === 'Escape' && !$('reader-dialog').open && state.nodeExpanded && state.view === 'overview' && !editing) {
    event.preventDefault(); collapseMapNode();
  }
});
window.addEventListener('popstate', handleRoute);
window.addEventListener('hashchange', handleRoute);
// Save before navigation: pagehide alone is too late for reload history in Chromium.
window.addEventListener('beforeunload', checkpoint);
$('main-scroll').addEventListener('scroll', scheduleCheckpoint, { passive: true });
$('reader-scroll').addEventListener('scroll', scheduleCheckpoint, { passive: true });

const checkForUpdates = () => { if (directory && document.visibilityState !== 'hidden') void liveSync.request(); };
window.addEventListener('focus', checkForUpdates);
document.addEventListener('visibilitychange', checkForUpdates);
setInterval(checkForUpdates, 3000);

async function start() {
  const initialHash = location.hash;
  readRoute();
  $('source-status').textContent = config.mode === 'snapshot' ? '离线快照' : '未连接';
  $('source-status').title = '当前显示生成时的内容';
  if (config.mode === 'snapshot') {
    applyDataset(window.__INLINE_DATA__ || []);
  } else {
    render();
    const attempt = connectAttempt;
    const saved = await savedDirectory();
    if (saved && attempt === connectAttempt) {
      try {
        const permission = await saved.queryPermission({ mode: 'read' });
        if (attempt !== connectAttempt) return;
        if (permission === 'granted') {
          directory = saved; $('refresh-button').disabled = false; $('refresh-button').hidden = false;
          liveSync.setSource(saved); await liveSync.request();
        } else $('source-status').textContent = '需重新连接';
      } catch { $('source-status').textContent = '需重新连接'; }
    }
  }
  if (location.hash === initialHash) restoreHistoryPosition();
}
void start();

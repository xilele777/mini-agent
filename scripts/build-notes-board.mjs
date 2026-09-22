import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readNoteDirectory } from './notes-board/model.mjs'
import { readPresentationDirectory } from './notes-board/project.mjs'

// Note: 项目独立维护看板，见 .agents/notes/implemented/process/2026-09-12-readable-board-and-stable-sync.md
const args = process.argv.slice(2)
const mode = args[0]
if (!['--live', '--bundle'].includes(mode) || args.length > 4) {
  throw new Error(
    'Usage: node scripts/build-notes-board.mjs <--live|--bundle> [output.html] [projectName] [notesDir]'
  )
}
const bundle = mode === '--bundle'
const output = resolve(args[1] || (bundle ? 'board.snapshot.html' : 'board.html'))
const projectName = args[2] || 'mini-agent'
const notesDir = resolve(args[3] || '.agents/notes')
const assets = fileURLToPath(new URL('./notes-board/', import.meta.url))
function nodeDirectory(path) {
  return {
    name: basename(path),
    kind: 'directory',
    async getDirectoryHandle(name) {
      const child = resolve(path, name)
      if (!(await stat(child)).isDirectory())
        throw Object.assign(new Error('Not a directory: ' + child), { name: 'TypeMismatchError' })
      return nodeDirectory(child)
    },
    async getFileHandle(name) {
      const child = resolve(path, name)
      if (!(await stat(child)).isFile())
        throw Object.assign(new Error('Not a file: ' + child), { name: 'TypeMismatchError' })
      return { name, kind: 'file', getFile: async () => ({ text: () => readFile(child, 'utf8') }) }
    },
    async *values() {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = resolve(path, entry.name)
        if (entry.isDirectory()) yield nodeDirectory(child)
        else if (entry.isFile())
          yield {
            name: entry.name,
            kind: 'file',
            getFile: async () => ({ text: () => readFile(child, 'utf8') }),
          }
      }
    },
  }
}
const [template, css, model, project, app] = await Promise.all(
  ['template.html', 'board.css', 'model.mjs', 'project.mjs', 'app.js'].map((name) =>
    readFile(resolve(assets, name), 'utf8')
  )
)
const { presentation, documents } = await readPresentationDirectory(
  nodeDirectory(dirname(notesDir))
)
const notes = bundle ? await readNoteDirectory(nodeDirectory(notesDir)) : null
const escapeHtml = (text) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  )
const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
const slots = {
  TITLE: escapeHtml(projectName),
  CSS: css,
  DATA:
    'window.__BOARD_CONFIG__ = ' +
    json({
      projectName,
      mode: bundle ? 'snapshot' : 'live',
      noteBase: relative(dirname(output), notesDir).replace(/\\/g, '/'),
      workspaceBase: relative(dirname(output), dirname(notesDir)).replace(/\\/g, '/'),
      presentation,
    }) +
    ';\nwindow.__INLINE_DATA__ = ' +
    json(notes) +
    ';\nwindow.__PROJECT_DOCUMENTS__ = ' +
    json(documents) +
    ';',
  SCRIPT:
    model.replace(/^export /gm, '') +
    '\n' +
    project.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') +
    '\n' +
    app,
}
const html = template.replace(/<!-- BOARD:(TITLE|CSS|DATA|SCRIPT) -->/g, (_, slot) => slots[slot])
await writeFile(output, html, 'utf8')
console.log(
  'Generated ' + output + (bundle ? ' (' + notes.length + ' notes)' : ' (live directory mode)')
)

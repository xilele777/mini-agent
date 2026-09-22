import { spawnSync } from 'node:child_process'
import { lstat, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Note: 干净编译后打包，避免遗留模块混入 — 见 .agents/notes/implemented/process/2026-09-22-cli-delivery.md
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)))
const dist = join(root, 'dist')
try {
  const info = await lstat(dist)
  if (info.isSymbolicLink() || (await realpath(dist)) !== dist)
    throw new Error('拒绝清理非项目内的 dist 目录。')
  await rm(dist, { recursive: true, force: true })
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
const result = spawnSync(
  process.execPath,
  [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1

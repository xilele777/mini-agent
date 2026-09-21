import { spawn } from 'node:child_process'

// Note: 中断清理与保守结果语义 — 见 .agents/notes/implemented/bug-fix/2026-09-06-shell-interruption-reporting.md
const MAX_BUFFER = 1024 * 1024
const MAX_OUTPUT = 4000
export function clip(text: string, label: string): string {
  if (!text) return ''
  return `${label}:\n${text.slice(0, MAX_OUTPUT)}${text.length > MAX_OUTPUT ? `\n…(共 ${text.length} 字符，已截断)` : ''}`
}

async function killTree(pid: number): Promise<string> {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return '已向 POSIX 进程组发送 SIGKILL；脱离进程组的后代无法确认'
  }
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true, stdio: 'ignore', timeout: 3000,
    })
    killer.once('error', reject)
    killer.once('close', code => resolve(code === 0
      ? 'taskkill /T /F 成功返回；脱离父子关系的后代无法确认'
      : `taskkill 返回 ${code}，无法确认进程树已清理`))
  })
}

export async function runCommand(options: {
  command: string; shell: string; cwd: string; timeoutMs: number; signal?: AbortSignal
}): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(options.shell, ['-c', options.command], {
      cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const buffers: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] }
    const sizes = { stdout: 0, stderr: 0 }
    let reason: string | undefined
    let cleanup: Promise<string> | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let finishing = false
    const timer = setTimeout(() => stop('命令超时'), options.timeoutMs)
    const abort = () => stop('命令已取消')

    function stop(why: string) {
      if (reason || settled) return
      reason = why
      cleanup = child.pid ? killTree(child.pid).catch(error => {
        child.kill('SIGKILL')
        return `进程树清理失败 (${String(error)})，仅尝试终止直接子进程`
      }) : Promise.resolve('进程尚未启动')
      fallback = setTimeout(() => {
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        void finish(null, '未观察到正常关闭')
      }, 5000)
    }

    async function finish(code: number | null, signal: string | null, spawnError?: Error) {
      if (finishing || settled) return
      finishing = true
      clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      options.signal?.removeEventListener('abort', abort)
      const clean = cleanup ? await cleanup : ''
      settled = true
      const output = (['stdout', 'stderr'] as const).map(name => clip(Buffer.concat(buffers[name]).toString('utf8'), name)).filter(Boolean).join('\n\n')
      if (reason || signal || spawnError) {
        const error = new Error([
          reason ?? (spawnError ? `命令启动失败: ${spawnError.message}` : `命令被信号中断: ${signal}`),
          clean ? `清理状态: ${clean}` : '', '可能已有部分副作用；请核查外部状态，不要直接重试。', output,
        ].filter(Boolean).join('\n'))
        error.name = options.signal?.aborted ? 'AbortError' : 'CommandInterruptedError'
        reject(error)
      } else {
        resolve([`命令退出码: ${code}`, output || '没有输出。'].join('\n'))
      }
    }

    for (const name of ['stdout', 'stderr'] as const) {
      child[name].on('data', (data: Buffer) => {
        const remaining = Math.max(0, MAX_BUFFER - sizes[name])
        if (remaining) buffers[name].push(data.subarray(0, remaining))
        sizes[name] += data.length
        if (sizes[name] > MAX_BUFFER) stop(`${name} 超过 1 MiB 缓冲上限`)
      })
    }
    child.once('error', error => { void finish(null, null, error) })
    child.once('close', (code, signal) => { void finish(code, signal) })
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
  })
}

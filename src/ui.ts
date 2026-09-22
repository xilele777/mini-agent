import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'

// Note: 输入资源与 EOF 收尾 — 见 .agents/notes/implemented/architecture/2026-09-02-shared-terminal-input.md

/**
 * REPL、批准框与 ask_user 共用一个 readline 实例，避免多个实例争抢 stdin。
 * 第一次询问时才创建，单纯导入本模块不会打开输入流或阻止进程退出。
 */
let rl: Interface | null = null
let interrupt: (() => void) | undefined

export class InputClosedError extends Error {
  constructor() {
    super('输入流已关闭')
    this.name = 'InputClosedError'
  }
}

export function setInterruptHandler(handler: (() => void) | undefined): void {
  interrupt = handler
}

function getRl(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.on('SIGINT', () => interrupt?.())
  }
  return rl
}

/** 等待一条输入；是否继续或结束 Agent 本轮，由调用方决定。 */
export async function ask(question: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const input = getRl()
  if (process.stdin.readableEnded || process.stdin.destroyed) throw new InputClosedError()
  let onClose: () => void = () => undefined
  const closed = new Promise<never>((_resolve, reject) => {
    onClose = () => reject(new InputClosedError())
    input.once('close', onClose)
  })
  try {
    return await Promise.race([input.question(question, signal ? { signal } : {}), closed])
  } finally {
    input.off('close', onClose)
  }
}

export function closeUI(): void {
  rl?.close()
  rl = null
}

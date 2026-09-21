import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'

/**
 * REPL、批准框与 ask_user 共用一个 readline 实例，避免多个实例争抢 stdin。
 * 第一次询问时才创建，单纯导入本模块不会打开输入流或阻止进程退出。
 */
let rl: Interface | null = null
let interrupt: (() => void) | undefined

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
export function ask(question: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  return getRl().question(question, signal ? { signal } : {})
}

export function closeUI(): void {
  rl?.close()
  rl = null
}

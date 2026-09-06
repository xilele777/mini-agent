import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'

/**
 * 全进程唯一的 readline 实例。
 *
 * 必须唯一:REPL 要读指令,确认机制也要读 y/n,两处共用 stdin。
 * 建第二个实例会互相抢输入 —— 按键丢失,或一次输入被两半截胡,还极难排查。
 * 懒初始化:createInterface 会立刻挂到 stdin,让 Node 以为还有事件源而不退出进程。
 * 放模块顶层的话,谁 import 这个文件都中招 —— 模块不该因被 import 而带来副作用。
 */
let rl: Interface | null = null

function getRl(): Interface {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout })
  }
  return rl
}

export function ask(question: string): Promise<string> {
  return getRl().question(question)
}

export function closeUI(): void {
  rl?.close()
  rl = null
}
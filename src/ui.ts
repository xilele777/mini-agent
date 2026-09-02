import { createInterface } from 'node:readline/promises'
import type { Interface } from 'node:readline/promises'

/**
 * 全进程唯一的 readline 实例。
 *
 * 为什么必须唯一:REPL 要读你的指令,确认机制也要读 y/n,两处都要 stdin。
 * 创建第二个 interface 会让两个实例争抢同一个 stdin —— 表现是按键丢失或者一次输入被两边各收到一半,而且极难排查。
 * 为什么懒初始化:createInterface 会立刻挂到 stdin 上,这会让Node 认为"还有事件源活着"从而不肯退出进程。写在模块顶层的话,任何人 import 了, 这个文件都会中招 —— 这就是你之前记下的"模块被 import 时不应有副作用"。
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
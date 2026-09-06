import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const MAX_RESULT_CHARS = 4000
const KEEP_HEAD = 3000
const KEEP_TAIL = 1000

/** 历史最多保留几"轮"完整对话。练手时改这里,对比 [ctx] 的 prompt 数值体会取舍 */
const KEEP_TURNS = 6

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text

  const head = text.slice(0, KEEP_HEAD)
  const tail = text.slice(-KEEP_TAIL)
  const omitted = text.length - KEEP_HEAD - KEEP_TAIL

  return [
    `[工具结果过长已截断:原文 ${text.length} 字符,省略中间 ${omitted} 字符,只保留开头和结尾。`,
    '如果你要找的内容可能在被省略的中间部分,不要凭猜测回答,请用 read_file 的 offset/limit 分段读取后再答。]',
    head,
    tail,
  ].join('\n')
}

/**
 * 把消息历史裁到最近 KEEP_TURNS 轮。
 *
 * 最小不可分割的单位是"一轮":一条 user + 它引发的所有 assistant/tool 配对。
 * 绝不在轮内部下刀 —— 切开 tool_call 与其结果的任何一条,历史就非法了,
 * 下一轮请求必然 400。
 */
export function trimHistory(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  // system 是这轮对话的身份设定,永远保留
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  // user 消息是每一轮的起点,记下每个起点在 rest 里的下标
  const turnStarts: number[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]?.role === 'user') turnStarts.push(i)
  }

  // 轮数没超阈值,一条都不动(直接返回原数组,连拷贝都省了)
  if (turnStarts.length <= KEEP_TURNS) return messages

  // 丢掉最老的几轮。keepFrom 是"保留范围的起点":
  // 从它开始的整段就是最近 KEEP_TURNS 轮,边界必然完整。
  const keepFrom = turnStarts[turnStarts.length - KEEP_TURNS]
  if (keepFrom === undefined) return messages // noUncheckedIndexedAccess 兜底,实际走不到

  return [...system, ...rest.slice(keepFrom)]
}

/** 记录一次实打实的工具调用,供循环守卫检测 */
export interface ToolCallLog {
  /** 工具名,如 "read_file" */
  name: string
  /** 参数原始 JSON 字符串 —— 逐字相同就是最强信号 */
  argsKey: string
}

/**
 * 循环守卫:最近 threshold 条工具调用是否全部"同名 + 同参"。
 *
 * 返回 null 表示无恙,否则返回要回填给模型的告警文本。
 * 纯函数、无副作用 —— 可以单独写最小自动化测试。
 *
 * 为什么参数用"逐字相同"(原始字符串),不做 JSON.parse 规范化:
 *   · 少一个能抛异常的环节;
 *   · 模型偶尔打乱 key 顺序时,"语义相同"的调用通常还能产出新信息,
 *     放它过去是有意为之,不是缺陷。
 */
export function detectRepeatedCall(
  recentCalls: ToolCallLog[],
  threshold: number
): string | null {
  if (recentCalls.length < threshold) return null

  // 只看"最后连续的 threshold 条"——中间穿插过别的工具,就不算连续重复
  const slice = recentCalls.slice(-threshold)
  const first = slice[0]
  if (!first) return null // noUncheckedIndexedAccess 兜底,实际走不到

  const allSame = slice.every(
    (c) => c.name === first.name && c.argsKey === first.argsKey
  )
  if (!allSame) return null

  return (
    `[循环守卫] 你已连续 ${threshold} 次以完全相同的参数调用 "${first.name}"。` +
    '这一步不产生任何新信息。停止重复:要么换一种工具或换一个思路,要么把当前进展和下一步打算直接告诉用户。'
  )
}

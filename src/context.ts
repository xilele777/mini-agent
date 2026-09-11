import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

/** 本地历史消息；startsTurn 只标记真实用户输入，不随 API 请求发送。 */
export type HistoryMessage = ChatCompletionMessageParam & {
  startsTurn?: true
}

/** 创建移除本地标记的请求消息，保留原数组及其轮边界。 */
export function toModelMessages(
  messages: HistoryMessage[]
): ChatCompletionMessageParam[] {
  return messages.map(({ startsTurn, ...message }) => message)
}

const MAX_RESULT_CHARS = 4000
const KEEP_HEAD = 3000
const KEEP_TAIL = 1000

/** 裁剪时保留的已结束用户轮数；当前新输入在裁剪后追加。 */
const KEEP_TURNS = 6

/** 超限结果保留头尾并注明省略内容；附加说明会使返回长度略超字符阈值。 */
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
 * 按 startsTurn 保留最近 KEEP_TURNS 个真实用户轮，system 消息始终保留。
 * 一轮包含用户请求、模型回复、工具结果及内部提示，裁剪不拆开工具调用与结果。
 * 调用方应在上一轮结束后调用；函数不会修复已有的不完整消息，也不修改原数组。
 */
export function trimHistory(
  messages: HistoryMessage[]
): HistoryMessage[] {
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  const turnStarts: number[] = []

  for (let i = 0; i < rest.length; i++) {
    if (rest[i]?.startsTurn === true) turnStarts.push(i)
  }

  if (turnStarts.length <= KEEP_TURNS) return messages

  const keepFrom = turnStarts[turnStarts.length - KEEP_TURNS]
  if (keepFrom === undefined) return messages

  return [...system, ...rest.slice(keepFrom)]
}

/** 模型发起的函数调用请求；进入记录不代表工具已执行。 */
export interface ToolCallLog {
  /** 请求中的工具名，如 read_file。 */
  name: string
  /** 原始参数字符串，用于逐字比较；此时可能尚未通过 JSON 或 schema 校验。 */
  argsKey: string
}

/**
 * 检测末尾 threshold 次请求是否工具名、参数字符串均相同。
 * 返回 null 表示未触发，否则返回供模型调整行为的说明。
 * 未做 JSON 规范化：只改变键顺序或空白的同义参数也会被视为不同请求。
 */
export function detectRepeatedCall(
  recentCalls: ToolCallLog[],
  threshold: number
): string | null {
  if (recentCalls.length < threshold) return null

  // 只比较末尾连续请求，其他位置的重复不在本次检测范围内。
  const slice = recentCalls.slice(-threshold)
  const first = slice[0]
  if (!first) return null

  const allSame = slice.every(
    (c) => c.name === first.name && c.argsKey === first.argsKey
  )
  if (!allSame) return null

  return (
    `[循环守卫] 你已连续 ${threshold} 次以完全相同的参数调用 "${first.name}"。` +
    '这一步不产生任何新信息。停止重复:要么换一种工具或换一个思路,要么把当前进展和下一步打算直接告诉用户。'
  )
}

# trim_history_source.md —— 阶段5 ② 历史裁剪

这份文档包含两处改动，全部由你亲手粘贴进 `src/`：

1. `src/context.ts` —— 新增 `trimHistory` 函数（下节是**该文件的完整最终版**，直接用这份覆盖）
2. `src/agent.ts` —— 三处小改动（见文末）

## src/context.ts（完整最终版）

```ts
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const MAX_RESULT_CHARS = 4000
const KEEP_HEAD = 3000
const KEEP_TAIL = 1000

/** 历史里最多保留几"轮"完整对话。练手时改这里，对比 [ctx] 的 prompt 数值来体会取舍 */
const KEEP_TURNS = 6

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text

  const head = text.slice(0, KEEP_HEAD)
  const tail = text.slice(-KEEP_TAIL)
  const omitted = text.length - KEEP_HEAD - KEEP_TAIL

  return [
    `[工具结果过长已截断：原文 ${text.length} 字符，省略中间 ${omitted} 字符，只保留开头和结尾。`,
    '如果你要找的内容可能在被省略的中间部分，不要凭猜测回答，请用 read_file 的 offset/limit 分段读取后再答。]',
    head,
    tail,
  ].join('\n')
}

/**
 * 把消息历史裁到最近 KEEP_TURNS 轮。
 *
 * 最小不可分割的单位是"一轮"：一条 user + 它引发的所有 assistant/tool 配对。
 * 绝不在轮内部下刀 —— 切开 tool_call 与其结果中的任何一条，历史就非法了，
 * 下一轮请求必然 400。
 */
export function trimHistory(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  // system 是这轮对话的身份设定，永远保留
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  // user 消息是每一轮的起点，记录每个起点在 rest 里的下标
  const turnStarts: number[] = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]?.role === 'user') turnStarts.push(i)
  }

  // 轮数没超阈值，一条都不动（直接返回原数组，连拷贝都不做）
  if (turnStarts.length <= KEEP_TURNS) return messages

  // 丢掉最老的几轮。keepFrom 是"保留范围的起点"：
  // 从它开始的整段就是最近 KEEP_TURNS 轮，边界必然完整。
  const keepFrom = turnStarts[turnStarts.length - KEEP_TURNS]
  if (keepFrom === undefined) return messages // noUncheckedIndexedAccess 兜底，实际走不到

  return [...system, ...rest.slice(keepFrom)]
}
```

## src/agent.ts 改动

### 改动一：import

```ts
- import { truncateToolResult } from './context.js'
+ import { trimHistory, truncateToolResult } from './context.js'
```

### 改动二：messages 从 const 变 let

`main()` 里：

```ts
-     const messages: ChatCompletionMessageParam[] = [
+     let messages: ChatCompletionMessageParam[] = [
        { role: 'system', content: SYSTEM_PROMPT },
      ]
```

### 改动三：每轮输入前先裁剪

`main()` 的 `for(;;)` 循环里：

```ts
-      // 记下本轮开始前的长度，失败时用来回滚
-      const checkpoint = messages.length
+      // 先裁掉旧轮。必须赶在 push 新输入之前 —— 此刻上一轮必然完整，
+      // 永远不会把 tool_call 配对切成两半。
+      messages = trimHistory(messages)
+
+      // 记下本轮开始前的长度，失败时用来回滚
+      const checkpoint = messages.length
        messages.push({ role: 'user', content: input })
```

## 验证步骤提示

1. `npx tsc --noEmit` 应通过。
2. 正常启动，连续问几个不相关的简单问题（每轮只调一两个工具），观察 `[ctx]` 的 `prompt=`：
   早期每问一轮涨一圈；当轮数超过 KEEP_TURNS 后，`prompt=` 应基本封顶、不再持续上涨。
3. 自习作业见对话正文。
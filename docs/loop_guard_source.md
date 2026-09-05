# loop_guard_source.md —— 阶段5 ③ 循环守卫

在 ② 历史裁剪全部跑通的基础上，给循环加看门狗。

## 这个看门狗拦什么，不拦什么

你 trace 里那个"连续 5~6 次换参数重试同一个失败的 search_files"是**探索**，不是死循环——
模型在尝试新路径，误伤它会打断正常纠错。看门狗只拦一种最纯粹的信号：

> **连续 N 次调用同一个工具、且参数逐字相同。**

相同的问、相同的答，不产生任何新信息，纯粹烧迭代次数和 token。这就是死循环。
判据宁可窄，不可误伤。

`src/context.ts` 加一个纯函数 + agent.ts 接入执行循环。**`src/tools/index.ts` 不用动。**

## 改动一：src/context.ts 追加

在文件末尾（`trimHistory` 之后）追加：

```ts
/** 记录一次实打实的工具调用，供循环守卫检测 */
export interface ToolCallLog {
  /** 工具名，如 "read_file" */
  name: string
  /** 参数原始 JSON 字符串 —— 逐字相同就是最强信号 */
  argsKey: string
}

/**
 * 循环守卫：最近 threshold 条工具调用里，是否全部"同名 + 同参"。
 *
 * 返回 null 表示无恙；否则返回要回填给模型的告警文本。
 * 纯函数、无副作用 —— 所以可以单独写最小自动化测试（阶段5 ⑤）。
 *
 * 为什么参数用"逐字相同"(原始字符串)，不做 JSON.parse 规范化：
 *   · 少一个能抛异常的环节；
 *   · 模型偶尔打乱 key 顺序时的"语义相同"调用，通常还能产出新信息，
 *     不该被拦 —— 让它放过是有意为之，不是缺陷。
 */
export function detectRepeatedCall(
  recentCalls: ToolCallLog[],
  threshold: number
): string | null {
  if (recentCalls.length < threshold) return null

  // 只看"最后连续的 threshold 条"——中间穿插过别的工具，就不算连续重复
  const slice = recentCalls.slice(-threshold)
  const first = slice[0]
  if (!first) return null // noUncheckedIndexedAccess 兜底，实际走不到

  const allSame = slice.every(
    (c) => c.name === first.name && c.argsKey === first.argsKey
  )
  if (!allSame) return null

  return (
    `[循环守卫] 你已连续 ${threshold} 次以完全相同的参数调用 "${first.name}"。` +
    '这一步不产生任何新信息。停止重复：要么换一种工具或换一个思路，要么把当前进展和下一步打算直接告诉用户。'
  )
}
```

## 改动二：src/agent.ts

### 2a. import

`import { trimHistory, truncateToolResult } from './context.js'` 这一行改成：

```ts
import { detectRepeatedCall, trimHistory, truncateToolResult } from './context.js'
import type { ToolCallLog } from './context.js'
```

（`ToolCallLog` 是纯类型，`verbatimModuleSyntax` 要求它走 `import type`，所以拆成两行。）

### 2b. 常量

`const MAX_ITERATIONS = 10` 之后加：

```ts
/** 连续这么多次调用同一工具、参数逐字相同，就看门狗喊停 */
const REPEAT_THRESHOLD = 3
/** 看门狗喊了这么多次模型仍不改，强制终止本轮 */
const MAX_LOOP_HITS = 2
```

### 2c. 替换整个 runTurn 函数

从 `async function runTurn` 到它的结束 `}` 整段替换成：

```ts
/** 跑完一次用户输入：反复问模型 → 执行工具 → 回填，直到模型不再要工具 */
async function runTurn(messages: ChatCompletionMessageParam[]): Promise<void> {
  // 本轮内累计的工具调用记录。声明在 for 外面 —— 真正的循环是
  // "模型回复 → 工具 → 再回复 → 再工具"跨多次回复的，放循环里就永远记不到。
  const recentCalls: ToolCallLog[] = []
  let loopHits = 0

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: getToolSchemas(),
    })

    const usage = response.usage
    if (usage) {
      console.log(
        `  [ctx] 本轮 prompt=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
          ` total=${usage.total_tokens}`
      )
    }

    const message = response.choices[0]?.message
    if (!message) throw new Error('模型没有返回 message')

    messages.push(message)

    const toolCalls = message.tool_calls
    if (!toolCalls || toolCalls.length === 0) {
      console.log(`\nAgent: ${message.content ?? '(空回复)'}`)
      return
    }

    if (message.content) console.log(`\nAgent: ${message.content}`)

    for (const call of toolCalls) {
      const isFunction = call.type === 'function'

      if (isFunction) {
        recentCalls.push({
          name: call.function.name,
          argsKey: call.function.arguments,
        })

        // 看门狗先说话：完全相同参数的重复调用 = 死循环。
        // 命中就不执行、不回填真实结果，而是回填一段提示让模型掉头。
        const guard = detectRepeatedCall(recentCalls, REPEAT_THRESHOLD)
        if (guard) {
          loopHits++
          console.log(`  ⚠ ${call.function.name} 触发循环守卫(${loopHits}/${MAX_LOOP_HITS})`)
          messages.push({ role: 'tool', tool_call_id: call.id, content: guard })
          if (loopHits >= MAX_LOOP_HITS) {
            console.log(`\n[中止] 循环守卫已触发 ${MAX_LOOP_HITS} 次仍不收敛，本轮放弃。`)
            return
          }
          continue
        }
      }

      // 每个 tool_call 都必须产出一条配对的 tool 消息，一条都不能少。
      // 所以这里不能像以前那样 `if (type !== 'function') continue` —— 那会漏配对，下一轮必 400。
      const observation = isFunction
        ? await handleCall(call.function.name, call.function.arguments)
        : `错误：不支持的工具调用类型 "${call.type}"。`

      messages.push({ role: 'tool', tool_call_id: call.id, content: observation })
    }
  }

  console.log(`\n[中止] 连续 ${MAX_ITERATIONS} 轮仍未得出结论，本轮放弃。`)
}
```

## 验证：临时 demo 脚本

新建 `tmp-loop-demo.ts`（项目根目录，跑完删掉；tsconfig 无 include 会扫到它，但它能过 tsc，所以无妨）：

```ts
import { detectRepeatedCall } from './src/context.js'
import type { ToolCallLog } from './src/context.js'

const show = (...l: ToolCallLog[]) => {
  const r = detectRepeatedCall(l, 3)
  console.log(`${r ?? '(无恙)'}\n`)
}

console.log('① 不足 3 条:')
show({ name: 'read_file', argsKey: '{"path":"a.ts"}' })

console.log('② 3 条完全相同:')
show(
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' }
)

console.log('③ 第 3 条参数变了:')
show(
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"b.ts"}' }
)

console.log('④ 中间穿插别的工具:')
show(
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'grep', argsKey: '{"x":1}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' }
)

console.log('⑤ 5 条里最后 3 条相同(最早 1 条不同):')
show(
  { name: 'time', argsKey: '{}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' },
  { name: 'read_file', argsKey: '{"path":"a.ts"}' }
)
```

运行：`npx tsx tmp-loop-demo.ts`

期望：**①②⑤ 触发**（打印告警），**③④ 无恙**。⑤是关键——它验证"只看最后连续的 threshold 条"这个语义。

## 作业

1. **必做**：跑 demo，确认识别与预期一致。
2. **调参实验**：`REPEAT_THRESHOLD` 临时改成 2，跑一段正常对话，感受"同一参数连续两次就被喊停"有多吵——这能帮你理解为什么阈值不能太小。
3. **思考题**（不做也行）：`ToolCallLog` 再加一个 `resultKey: string`（存工具返回的 `observation`），检测条件改为"同名 + 同参 + 同结果"。为什么这个能抓到"换了参数、但结果一样"的更隐蔽循环？
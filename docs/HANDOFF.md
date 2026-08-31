# 交接:mini-agent 学习项目

> 新开对话时,让 Claude 先读这份文件即可继续。每阶段结束后更新。

## 我是谁 / 我要什么

- Agent 零基础,TS 尚不熟练(Python 更弱),边写边学
- **你是教练,不是代笔**:讲原理、指出错误、review 代码,不要直接替我实现
- 但我经常卡住。**卡住时的有效模式是:给完整参考代码 + 逐块讲解 + 留一个改造任务**,
  纯抽象指引对我不管用。周边语法(正则、JSON Schema 结构等)可以直接给,核心逻辑让我自己填
- 用简体中文

## 技术栈

- TypeScript + tsx(`npx tsx src/xxx.ts` 直接跑),`npm run dev` = `tsx src/index.ts`
- `openai` SDK v7 连中转站,`.env` 里 `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- 模型:`gpt-5.6-sol`(中转站会注入自己的 system prompt,prompt_tokens 基线约 4400)
- `package.json` 是 **`"type": "module"`**,所以 import 必须写 `.js` 后缀
- **tsconfig 开了 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`**,
  下标访问会带 undefined,已约定用 `?? ''` 兜底而不是 `!` 断言
- `noUnusedLocals` 目前是关的(死 import 不会报错),可以考虑打开

## 当前文件

```
src/
  index.ts          阶段0的最小 API 调用 demo(已完成,可保留)
  llm.ts            环境变量校验 + 导出 client 和 MODEL 常量
  protocol.ts       SYSTEM_PROMPT(已精简) + parse() 阶段1化石,已无人 import
  tools/calc.ts     calculate(expression: string): string，白名单正则 + eval
  tools/schema.ts   TOOLS: ChatCompletionTool[]，calculate 的 JSON Schema
  agent.ts          主循环(MAX_ITERATIONS=5) + runCalculate() 参数校验
```

## 六阶段路线

0. ✅ 打通 API,看懂 response 结构
1. ✅ 手写 ReAct(纯 prompt + 正则,不用 tools 参数)
2. ✅ **换成原生 Function Calling**
3. ⬜ **抽 Tool 接口 + 注册表(zod + zod-to-json-schema)** ← 当前在这里
4. ⬜ 真实副作用工具(read_file / write_file / run_bash)+ 执行前确认机制
5. ⬜ 上下文管理(结果截断、历史裁剪)+ 循环护栏(死循环检测)

最终目标:一个能读写文件、执行命令的本地 CLI Agent。

## 阶段 2 已验证的成果

- 「先算 123*456,再加 789,最后除以 3」→ 4 轮 tool_calls,答案 18959
- 故意注释掉 `role:'tool'` 的 push → 第 2 轮硬 400:
  `No tool output found for function call call_xxx`,精确到具体 call id
- 伪造幻觉参数 `{"expr":"1+1"}` → 不崩溃,返回中文错误 observation,
  模型下一轮读懂并改用正确的 `expression` 重新调用

## 我已经理解的概念(不用再重讲)

**阶段 0~1 累积:**

- Agent = 一个 for 循环:问模型 → 解析 → 执行工具 → 把结果喂回 messages → 再问
- 工具调用的本质是文本解析,不是模型的神秘能力
- API 无状态,`messages` 数组是唯一的记忆;一问一答都要 push 回去
- 工具的输入输出都必须是字符串(要塞进 messages)
- 工具出错时要 `return` 人话错误信息给模型自我修正,不能 `throw`
- 错误信息的读者是模型,要写清规则而不是只说"失败了"
- fail fast + TS 类型收窄(`if (!x) throw` 之后类型自动收窄)
- 可辨识联合(discriminated union)配 `type` 标签字段
- system prompt 能控制行为粒度,但代价是轮数和 token 翻倍
- 模型会"幻觉 Observation",要在 prompt 里明令禁止
- 模块被 import 时不应有副作用(测试代码别写在模块底部顶层)

**阶段 2 新增:**

- Function Calling 不是新能力,是把阶段 1 的正则解析搬到服务端用受约束解码保证
- **模型返回的 assistant 消息必须整个原样 push**,手工重建对象会丢 `tool_calls` 字段
- 每个 `tool_call` 都必须有 `tool_call_id` 匹配的 `role:'tool'` 消息,一个都不能少;
  服务端做逐条配对校验,缺了就 400
- 同样的错误在阶段 1 只是静默变笨(模型自己脑补结果),在阶段 2 是响亮的协议错误
  —— Function Calling 真正买到的是"把语义错误变成协议错误"
- 终止判断看 `tool_calls` 是否为空,不看 `content`,也不看 `finish_reason`(中转站实现不一)
- `tool_calls` 是数组,模型可以一轮并行调多个工具;阶段 1 在 prompt 里哀求的"每次一个"没了
- `call.function.arguments` 是 JSON **字符串**,要 `JSON.parse`;而 tool 消息的 content 必须是字符串
- 工具边界包含参数解析。把它抽成独立函数 `(rawArgs: string) => string` 后,
  early return 就自然表示"这次执行的结果",不会再误写成 `return` 出主循环
- 给 `void` 函数显式标注返回类型是免费的护栏(`async function main(): Promise<void>`)
- **模型没有独立于 messages 之外的记忆**,历史里写什么就是什么。
  伪造的错误信息它会全盘接受 —— 上下文即现实
- 每轮请求都重发全部历史,N 轮任务的 token 消耗是 O(N²) —— 这是阶段 5 的由来
- tsconfig 的 `noUncheckedIndexedAccess` 下,`Record<string, unknown>` 取属性得先 typeof 收窄

## 阶段 2 遗留的观察(阶段 3 要解决)

字符串 `'calculate'` 目前手写在多个地方:`schema.ts` 的 `name`、`agent.ts` 的分发判断、
两处错误信息里。全部靠人肉对齐,拼错就静默失效。

同时"expression 是个非空字符串"这条约束写了两遍:一遍在 JSON Schema 给模型看,
一遍在 `runCalculate` 的三道关做运行时校验。两边可能改歪。

`runCalculate` 的签名 `(rawArgs: string) => string` 就是 `Tool.execute` 的雏形,
只是还没起名字。

## 阶段 3 计划

目标架构(《学习路线》里的硬约束):**`agent.ts` 不得 import 任何具体工具**,只跟注册表交互。
新增工具的代价 = 新建一个文件 + 注册表加一行。若需改 `agent.ts` 则本阶段不达标。

需要装:`zod`、`zod-to-json-schema`。

要点:用 zod 定义参数 schema,`zod-to-json-schema` 自动生成给模型的 JSON Schema,
`safeParse` 做运行时校验 —— 一份定义两处使用,消灭上面那两个重复。

# 交接:mini-agent 学习项目

> 新开对话时,让 Claude 先读这份文件即可继续。每阶段结束后更新。

## 我是谁 / 我要什么

- Agent 零基础,TS 尚不熟练(Python 更弱),边写边学
- **你是教练,不是代笔**:讲原理、指出错误、review 代码,不要直接替我实现
- 但我经常卡住。**卡住时的有效模式是:给完整参考代码 + 逐块讲解 + 留一个改造任务**,
  纯抽象指引对我不管用。周边语法(正则等)可以直接给,核心逻辑让我自己填
- 用简体中文

## 技术栈

- TypeScript + tsx(`npx tsx src/xxx.ts` 直接跑),`npm run dev` = `tsx src/index.ts`
- `openai` SDK 连中转站,`.env` 里 `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- 模型:`gpt-5.6-sol`(中转站会注入自己的 system prompt,prompt_tokens 基线约 4400)
- `package.json` 是 `"type": "commonjs"`
- **tsconfig 开了 `strict` 和 `noUncheckedIndexedAccess`**,下标访问会带 undefined,
  已约定用 `?? ''` 兜底而不是 `!` 断言

## 当前文件

```
src/
  index.ts        阶段0的最小 API 调用 demo(已完成,可保留)
  llm.ts          环境变量校验 + 导出 client 和 MODEL 常量
  protocol.ts     SYSTEM_PROMPT + parse() + ParseResult 可辨识联合
  tools/calc.ts   calculate(expression: string): string，白名单正则 + eval + 错误返回
  agent.ts        ReAct 主循环(MAX_ITERATIONS=5)
```

## 六阶段路线

0. ✅ 打通 API,看懂 response 结构
1. ✅ **手写 ReAct**(纯 prompt + 正则,不用 tools 参数)
2. ⬜ **换成原生 Function Calling** ← 当前在这里
3. ⬜ 抽 Tool 接口 + 注册表(zod + zod-to-json-schema)
4. ⬜ 真实副作用工具(read_file / write_file / run_bash)+ 执行前确认机制
5. ⬜ 上下文管理(结果截断、历史裁剪)+ 循环护栏(死循环检测)

最终目标:一个能读写文件、执行命令的本地 CLI Agent。

## 阶段 1 已验证的成果

Agent 能自主完成"先算 123*456,再加 789,最后除以 3",分 4 轮调用工具后给出 Final Answer。

## 我已经理解的概念(不用再重讲)

- Agent = 一个 for 循环:问模型 → 解析 → 执行工具 → 把结果喂回 messages → 再问
- 工具调用的本质是文本解析,不是模型的神秘能力
- API 无状态,`messages` 数组是唯一的记忆;一问一答都要 push 回去
- 工具的输入输出都必须是字符串(要塞进 messages)
- 工具出错时要 `return` 人话错误信息给模型自我修正,不能 `throw`
- 错误信息的读者是模型,要写清规则而不是只说"失败了"
- fail fast + TS 类型收窄(`if (!x) throw` 之后类型自动收窄)
- 可辨识联合(discriminated union)配 `type` 标签字段
- system prompt 能控制行为粒度(如强制每步都用工具),但代价是轮数和 token 翻倍
- 模型会"幻觉 Observation"(自己编造工具结果),要在 prompt 里明令禁止
- 模块被 import 时不应有副作用(测试代码别写在模块底部顶层)

## 阶段 2 计划(已讲过,待执行)

要改四处,**前三处都是删**:

1. `SYSTEM_PROMPT` 删掉「输出格式」和大部分「严格规则」章节
2. `parse()` 整个不再需要
3. 调 API 时新增 `tools` 参数(JSON Schema 描述工具)
4. 循环体改成看 `tool_calls` 而非 `parse` 结果 ← 唯一的新东西

**我卡在第 1 个动手任务**:写 `calculate` 的 JSON Schema 常量
(结构提示:`{ type: 'function', function: { name, description, parameters } }`)。

要重点体会的:换成原生协议后,for 循环本身几乎一行都不用改——那才是内核。

另外阶段 1 遗留了一个观察:漏 push assistant 消息在手写协议下侥幸没出错,
但在原生协议下会变成硬性 400,因为 `role: 'tool'` 必须紧跟带 `tool_calls` 的 assistant 消息。

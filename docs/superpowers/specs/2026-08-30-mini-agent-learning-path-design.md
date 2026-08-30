# Mini Agent 学习路线设计

日期:2026-08-30

## 背景与定位

这是一个**学习项目**,不是生产项目。目标是通过亲手实现一个最小 Agent,理解 Agent 的运行机制。

- 学习者:Agent 领域零基础,TypeScript 熟练,Python 不熟
- 模式:边写边学。代码由学习者本人编写,AI 担任教练角色——讲原理、指出卡点、review 代码,**不代写实现**
- 技术栈:TypeScript + `openai` npm 包 + OpenAI 兼容接口(经中转站)
- 终点:一个能读写文件、执行 shell 命令的本地 CLI Agent,即 Claude Code 这类工具的最小内核

## 核心认知

Agent 的本质是一个**循环**:

```
模型思考(Thought) → 决定动作(Action) → 代码执行工具 → 结果回填(Observation) → 再次思考 → ... → 得出最终答案
```

模型本身不具备任何执行能力。它唯一能做的是**输出文本**。所谓"模型调用了工具",实质是模型输出了一段程序可解析的结构,由你的代码去执行。理解这一点,后续内容都是细节。

## 目标架构

```
src/
  llm.ts        # 只负责:把 messages + tools 发给模型,拿回 response
  tools/
    types.ts    # Tool 接口:name / description / schema / execute / needsApproval
    calc.ts     # 每个工具一个文件
    fs.ts
    bash.ts
    index.ts    # 工具注册表:name -> Tool 的 Map
  agent.ts      # 核心 Loop,只依赖 llm.ts 与工具注册表
  context.ts    # 消息历史的追加与裁剪
  cli.ts        # 终端交互入口
```

**唯一的硬性架构约束:`agent.ts` 不得 import 任何具体工具,只能与注册表交互。**

新增工具的代价应当是:新建一个文件 + 注册表加一行。若需要修改 `agent.ts`,说明抽象失败。

这条约束是整个练习工程价值的核心。常见的错误做法是在 Loop 内写 `if (name === 'calc') ... else if ...`,短期能跑,工具增多后必然腐化。

## 六个学习阶段

### 阶段 0 · 打通 API

用 `openai` 包配置 `baseURL` 指向中转站,发送一句问候并打印回复,随后将完整 response 对象 `JSON.stringify` 输出观察。

- **原理**:`chat.completions.create` 是无状态的。模型不保存任何对话记录。所谓"记忆"完全由你每次重新发送整个 `messages` 数组制造出来。
- **卡点**:中转站的 `baseURL` 是否需要 `/v1` 后缀因厂商而异。遇到 404 优先排查此处。

### 阶段 1 · 手写 ReAct 协议

**不使用** `tools` 参数。在 system prompt 中用自然语言约定一种输出格式,例如:

```
Thought: 我需要算一下
Action: calculate
Action Input: 12 * 34
```

用正则解析出 `Action` 与 `Action Input`,手动调用本地函数。

- **原理**:亲眼确认"工具调用"的本质——模型输出可解析文本,你的代码执行它。
- **卡点(即本阶段的收获)**:模型会不遵守格式。它会附加寒暄、一次输出多个 Action、把参数写成自然语言。这些失败正是理解 Function Calling 存在意义的前提。
- **说明**:本阶段的成果会在阶段 2 被替换。这是有意为之。跳过它仍能写出可运行的 Agent,但会长期存在认知盲区。预计耗时约两小时。

### 阶段 2 · 换用原生 Function Calling

将工具以 JSON Schema 描述,通过 `tools` 参数传递,改从 `response.choices[0].message.tool_calls` 读取调用请求。

- **原理**:Function Calling 并非新增能力,而是厂商在服务端替你完成了阶段 1 的工作——通过受约束解码保证输出为合法 JSON。你丢弃的正则,被更可靠的机制取代。
- **卡点**:当模型返回 `tool_calls` 时,该条 assistant 消息**必须原样追加回 messages 数组**,且每个 tool_call 都需要一条 `tool_call_id` 匹配的 `role: "tool"` 消息。缺失或 ID 不匹配会导致下一轮请求返回 400。这是最常见的报错,应借此练习自主诊断。

### 阶段 3 · 抽象 Tool 接口与注册表

落实目标架构。定义 `Tool` 接口,建立注册表,使 `agent.ts` 仅通过遍历注册表生成 tools 参数、通过查表执行工具。

- **原理**:这部分属于软件工程而非 AI,但决定了项目的可扩展性。
- **建议**:用 `zod` 定义参数,配合 `zod-to-json-schema` 自动生成 Schema。使运行时校验与给模型的描述来自同一份定义,避免两处不一致。这是 TypeScript 相对 Python 的实际优势。

### 阶段 4 · 引入副作用工具与确认机制

新增 `read_file`、`write_file`、`run_bash` 三个工具。

- **原理**:工具具备副作用后,Agent 从"会说话"变为"会做事",风险随之产生。需要为工具增加标记(如 `needsApproval: true`),在执行前将具体动作内容展示给用户确认。
- **卡点**:"展示什么内容"是一个没有标准答案的设计问题。展示完整命令过于冗长,展示摘要又可能遗漏风险。可对照观察 Claude Code 的处理方式。
- 完成本阶段后,对 Agent 的理解会有实质性提升。

### 阶段 5 · 上下文管理与循环护栏

此时 messages 数组已开始膨胀。需要补充三项机制:

1. **工具结果截断**:超长的文件内容不可全量注入,截断后注明省略的行数。
2. **历史裁剪**:超过阈值时丢弃早期轮次,但 system 消息始终保留。
3. **循环护栏**:设置 `maxIterations`;检测"连续以相同参数调用同一工具"的死循环模式。

- **原理**:Context 是 Agent 唯一且稀缺的资源。Agent 工程中的多数难题最终都归结为上下文工程。

## 验收标准

上游阶段的缺陷会在下游表现为"模型似乎变笨了",极难定位。因此每个阶段必须达标后再推进。

| 阶段 | 标准 |
|---|---|
| 0 | 能打印完整 response JSON,并说明 `role` / `content` / `finish_reason` 的含义 |
| 1 | 提问"123 乘以 456 等于多少",Agent 完成 Thought→Action→Observation 并给出正确答案;能说明解析在何种情况下会失败 |
| 2 | 同一问题改用 `tool_calls` 跑通;故意省略 `role: "tool"` 消息触发报错,并能解释成因 |
| 3 | 新增工具仅需建一个文件 + 注册表加一行。**若需修改 `agent.ts` 则不达标** |
| 4 | 指令"在当前目录建 hello.txt 写上你好",Agent 请求确认 → 批准 → 文件实际生成 |
| 5 | 读取超长文件后继续对话不触发 token 超限;人为构造死循环能被护栏拦截 |

## 明确不做的事(YAGNI)

以下内容在六个阶段完成前不引入:

- LangChain / LlamaIndex 等框架
- 向量数据库与 RAG
- 子 Agent、多 Agent 协作
- 流式输出(streaming)
- 持久化存储

其中子 Agent 与 todo 管理可作为阶段 5 完成后的迭代方向。

## 后续迭代方向(阶段 5 之后)

- 流式输出,改善交互体验
- todo 管理工具,让 Agent 具备多步任务的自我追踪能力
- 子 Agent 分发:主 Agent 将独立子任务交给拥有独立上下文的子 Agent 执行

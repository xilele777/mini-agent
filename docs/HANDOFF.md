# 交接:mini-agent 学习项目

> 新开对话时,让 Claude 先读这份文件即可继续。每阶段结束后更新。

## 我是谁 / 我要什么

- Agent 零基础,TS 尚不熟练(Python 更弱),边写边学
- **你是教练,不是代笔**:讲原理、指出错误、review 代码,不要直接替我实现
- 但我经常卡住。**卡住时的有效模式是:给完整参考代码 + 逐块讲解 + 留一个改造任务**,
  纯抽象指引对我不管用。周边语法(正则、JSON Schema 结构等)可以直接给,核心逻辑让我自己填
- **代码由我自己粘贴到文件里,不要你直接改我的 src**。文档(docs/)可以你写
- 用简体中文

## 技术栈

- TypeScript + tsx,入口是 **`npx tsx src/agent.ts`**
  (`package.json` 的 `dev` 脚本还指着阶段 0 的 `src/index.ts`,一直没改)
- `openai` SDK v7 连中转站,`.env` 里 `OPENAI_API_KEY` / `OPENAI_BASE_URL`
- 模型:`gpt-5.6-sol`(中转站会注入自己的 system prompt,prompt_tokens 基线约 4400)
- **`zod` v4 已装(4.5.4)。不要装 `zod-to-json-schema`** —— 那是 v3 时代的包,
  v4 已内置 `z.toJSONSchema()`
- `package.json` 是 **`"type": "module"`**,所以 import 必须写 `.js` 后缀
- **tsconfig 开了 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`**,
  下标访问会带 undefined,已约定用 `?? ''` 兜底而不是 `!` 断言。`target: esnext`
- `noUnusedLocals` 目前是关的(死 import 不会报错),可以考虑打开

> 给 AI 教练的提示:这台机器上 **`node` 在非 tty 环境下会直接报 `stdin is not a tty`**,
> 你在 Bash 工具里跑不了 node / tsx / tsc。所有验证都得让人类自己跑了贴结果给你。
> 别浪费调用去试。

## 当前文件

```
src/
  index.ts          阶段0的最小 API 调用 demo(化石,可保留)
  llm.ts            环境变量校验 + 导出 client 和 MODEL 常量
  protocol.ts       SYSTEM_PROMPT(仍在用) + parse()/ParseResult(阶段1化石,已无人 import)
  agent.ts          主循环(MAX_ITERATIONS=5)。只 import llm / protocol / tools/index
  tools/
    types.ts        Tool 接口:name / description / schema / execute / needsApproval?
    calc.ts         calcTool
    time.ts         timeTool(current_time,无参数)
    index.ts        ALL_TOOLS 数组 + REGISTRY(Map) + getToolSchemas() + runTool()
```

阶段 3 删掉了 `tools/schema.ts`(手写 JSON Schema)和 `agent.ts` 里 30 行的 `runCalculate`。

## 六阶段路线

0. ✅ 打通 API,看懂 response 结构
1. ✅ 手写 ReAct(纯 prompt + 正则,不用 tools 参数)
2. ✅ 换成原生 Function Calling
3. ✅ **抽 Tool 接口 + 注册表(zod v4 内置 toJSONSchema)**
4. ⬜ **真实副作用工具(read_file / write_file / run_bash)+ 执行前确认机制** ← 当前在这里
5. ⬜ 上下文管理(结果截断、历史裁剪)+ 循环护栏(死循环检测)

最终目标:一个能读写文件、执行命令的本地 CLI Agent。

## 阶段 3 已验证的成果

**架构验收(spec 的硬标准):** 新增 `current_time` 工具,全部改动 = 新建 `tools/time.ts`
+ `tools/index.ts` 里两行(一行 import、一行加进 `ALL_TOOLS`)。**`agent.ts` 零改动。达标。**

**并行与串行同时出现在一次运行里**(最有价值的一次观察):

问「现在几点?另外算 123 \* 456 + 222」:

```
第1轮  current_time({}) => 2026/8/31 17:17:53      ← 这两个是
       calculate({"expression":"123 * 456"}) => 56088  ← 同一轮并行发出的
第2轮  calculate({"expression":"56088 + 222"}) => 56310  ← 依赖上一轮结果,只能串行
第3轮  最终答案
```

问「现在几点?往后推 20 分钟」→ 全程串行 2 轮,因为 `18 + 20` 里的 `18`
必须先拿到时间才知道。

**行为不变即成功:** 原来那道「123\*456 再加 789 再除以 3」重构后输出一字不差(18959)。

**无参数工具的 rawArgs 实测是 `"{}"`**,不是空字符串,那个坑没在这个中转站上复现,
所以 `runTool` 里**没有**加 `|| '{}'` 兜底(没复现的问题不预防性修)。

**受控实验:删掉 SYSTEM_PROMPT 里"每次只计算一个步骤"前后对比。**
问「算 123 \* 456,另外算 999 - 111」(两件事零依赖,单变量):

```
删除前  轮1 calculate → 轮2 calculate → 轮3 总结     3 次 API 请求
删除后  轮1 calculate + calculate     → 轮2 总结     2 次 API 请求
```

结论:那条阶段 1 的化石规则**一直在生效并抑制并行**,省下的还是最贵的那次请求
(历史最长)。实验设计的关键是选了两个**零依赖**的操作 —— 之前那次
(时间 + 乘法 + 加法)因为存在依赖链,无法分辨是规则生效还是依赖所致。

**受控实验二:删掉 SYSTEM_PROMPT 里"禁止心算"这条(它在 `calcTool.description`
里已经写过一遍)。** 用极端用例「1 + 1 等于几?」——简单到模型最有动机偷懒:

```
删除前(对照组)  轮1 calculate({"expression":"1 + 1"}) => 2  轮2 总结
删除后(实验组)  输出一字不差
```

结论:**工具纪律写在 `description` 里,单独就扛得住**,全局 prompt 里那条是冗余。
于是 `SYSTEM_PROMPT` 清空到只剩一句人设,`protocol.ts` 可以删了。

**但这个结论有边界,别过度推广:** n=1、单工具、而且那句 description 写得非常明确
("任何数学运算都必须调用本工具,不要心算")。它证明的是"这句 description 够用",
不是"description 通道恒强于 system prompt"。阶段 4 放 `run_bash` 的安全约束时
赌错的代价是真实的文件损坏,那里必须重新验证、且要多跑几次。

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

**阶段 2 累积:**

- Function Calling 不是新能力,是把阶段 1 的正则解析搬到服务端用受约束解码保证
- **模型返回的 assistant 消息必须整个原样 push**,手工重建对象会丢 `tool_calls` 字段
- 每个 `tool_call` 都必须有 `tool_call_id` 匹配的 `role:'tool'` 消息,一个都不能少;
  服务端做逐条配对校验,缺了就 400
- 同样的错误在阶段 1 只是静默变笨,在阶段 2 是响亮的协议错误
  —— Function Calling 真正买到的是"把语义错误变成协议错误"
- 终止判断看 `tool_calls` 是否为空,不看 `content`,也不看 `finish_reason`
- `tool_calls` 是数组,模型可以一轮并行调多个工具
- `call.function.arguments` 是 JSON **字符串**,要 `JSON.parse`;tool 消息的 content 必须是字符串
- 工具边界包含参数解析,抽成 `(rawArgs: string) => string` 后 early return 语义就对了
- **模型没有独立于 messages 之外的记忆** —— 上下文即现实
- 每轮请求都重发全部历史,N 轮任务的 token 消耗是 O(N²) —— 这是阶段 5 的由来

**阶段 3 新增:**

- **Tool = 自包含对象**(name / description / schema / execute)。工具名从"散落 4 处的
  魔法字符串"变成"只存在于工具文件里的一个字段",其余全部由注册表推导
- **类型擦除是进容器的必要代价**:不同工具参数类型不同,塞进同一个 `Map` 就必须在
  边界上擦成 `Tool<any>`。`any` 只出现在接口默认值这一处,工具文件内部靠
  `Tool<z.infer<typeof xxxParams>>` 保持精确类型。真实框架也这么干
- **一份 zod 定义两处使用**:`z.toJSONSchema()` 生成给模型看的 Schema、`safeParse()`
  做运行时校验。阶段 2 那种"同一条约束写两遍、可能改歪"的问题从结构上消失
- **约束该放哪里有明确划分**:光看参数就能判定的归 zod(长度、字符白名单),
  必须真的执行才知道的归 execute(除零、括号不匹配)。
  实测:`2^10` 撞 zod 正则,拦在 execute **之前**;`(1+2` 能过 zod,由 eval 报错
- **zod 的 message 参数不是装饰,它就是发给模型的错误信息**。不写就是英文默认值
  (`Invalid string: must match pattern /.../`),模型得自己反推正则
- `safeParse` 返回的是**可辨识联合**,跟阶段 1 自己写的 `ParseResult` 同构;
  `success` 是**布尔属性不是方法**,`if (!result.success)` 那行的作用是**类型收窄**,
  不做判断就摸 `result.error` 会被 TS 拦住(靠 `?: never`)
- 用 `safeParse` 不用 `parse`:**模型传错参数是日常,不是异常**,
  拿 try/catch 处理必然频繁发生的正常分支是把异常当控制流用
- 不要用 `error.message`(它是 issues 数组的 JSON dump,又长又是英文噪音),
  要 map `error.issues` 取 `path` + `message` 自己拼人话
- **空 schema `z.object({})` 是"零参数"的正确表达,不是 hack**。把 `schema` 设成可选
  会让 `runTool` 长出 `if (tool.schema)` 特例,通用逻辑一旦开始长特例就完了
- `runTool` 四关(查表 / JSON.parse / safeParse / execute)**全部 return string,零 throw**。
  阶段 2 学到的"工具出错要 return 不能 throw"从一条纪律升级成了架构保证 ——
  主循环因此不需要任何 try/catch
- **工具的使用纪律写在自己的 `description` 里,不写在全局 SYSTEM_PROMPT**,
  否则加到第十个工具时 prompt 会爆炸
- **并行 tool_calls 的前提是参数无依赖**。参数是随请求发出的死值,不能写成"上一步的
  结果 + 20";依赖链上的调用在信息上就不可能并行。同一个任务里并行段和串行段可以共存
- 并行只是**可能**不是保证,取决于模型决策和中转站实现,跑成两轮不算错
- **轮数由依赖链的深度决定,不由任务数量决定**。三个操作但最长依赖链是 2,
  就是 2 轮工具调用;再加十个独立任务,轮数不变。这在阶段 5 是实打实的钱
- **prompt 债:prompt 里的每条规则都有持续成本,而且过期了不会报错**。
  "每次只计算一个步骤"在阶段 1 是必需的(正则一次只能解析一个 Action),
  阶段 2 换成 tool_calls 后就该删,却一直生效到阶段 3 才被实验发现。
  代码里的死 import 有 `noUnusedLocals` 能报,过期的 prompt 规则不会红字、
  不会崩溃,只会让每个可并行任务静默多花一轮 ——
  **纪律:每次架构升级后,回头审计 prompt 里为旧架构写的约束**

## 阶段 3 遗留的观察(阶段 4/5 要面对)

**1. 工具粒度是个真问题,`calculate` 太细了。**

问「现在 17:12,加 20 分钟」时,模型没有把整件事交给工具,而是自己拆成
「取出分钟数 12 → 调 calculate(12+20)=32 → 自己拼回 17:32」。
**进位判断全程是它心算的**(改成加 55 分钟就会出现 67 → 需要进位到 18:07)。

在 description 里写"禁止心算"管不住这个 —— 它确实每步算术都调了工具,
只是"把现实问题翻译成算术"这一环留给了自己,而那一环最容易错。

阶段 4 会正面撞上同一个权衡:`run_bash` 是万能工具的极端(灵活但危险、且把
所有推理压力留给模型),`read_file` 是专用工具的极端(安全但要写很多个)。

**2. `protocol.ts` 该删了(实验已给出依据,见上文实验二)。**

`SYSTEM_PROMPT` 现在只剩一句"你是一个可以使用工具的助手。";
`parse()` / `ParseResult` / 三个正则是阶段 1 的化石,早就没有任何人 import;
`agent.ts` 还 import 这个文件,纯粹是为了拿那一句人设。

清理动作:把 `SYSTEM_PROMPT` 常量搬进 `agent.ts` 顶部(留成常量而不是内联进
messages 数组 —— 阶段 4 大概率要往人设里加环境信息,比如当前工作目录),
然后整个删掉 `protocol.ts`。

阶段 1 的成果不会因此丢失,它在 git 历史里(commit `eeee5c5`)。
**代码不是记忆的唯一载体,删掉死代码 ≠ 丢掉学过的东西。**

**3. `Tool` 接口里的 `needsApproval?` 和 `execute` 的 `string | Promise<string>`
是阶段 4 的伏笔,已经留好口子了。** 前者用来标记"这个工具有副作用,执行前要问人",
后者让 fs/子进程这类异步工具能直接接进来(`runTool` 已经 `await` 了)。

## 阶段 4 计划

新增 `read_file` / `write_file` / `run_bash` 三个工具 + 执行前确认机制。

- 三个工具本身应该只是"新建三个文件 + `ALL_TOOLS` 加三个名字",`agent.ts` 依然不动。
  如果发现必须改 `agent.ts` 才能做确认机制 —— 那**确认机制本身**属于主循环的职责,
  改是合理的;但工具的注册和分发不许再动
- 难点不是 IO,是**"执行前给用户看什么"**。展示完整命令太长,展示摘要可能漏掉风险。
  可以对照 Claude Code 自己怎么做的
- 安全边界要想清楚:`write_file` 能不能写到项目目录外?`run_bash` 要不要白名单?
  这些约束放 zod 里还是放 execute 里?(用阶段 3 那条划分原则判断)

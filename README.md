# mini-agent

一个跑在本地终端里的命令行 AI Agent,用 TypeScript 和 [OpenAI SDK](https://github.com/openai/openai-node) 编写,连接任意 OpenAI-compatible API。

它可以和你持续对话，并借助模型发起的工具调用读文件、搜代码、安全编辑文件、执行 shell 命令、管理待办和委派只读调查。文件变更和命令执行前需要批准；文件展示完整增删 diff，命令展示完整文本。

## ✨ 功能特性

- 命令行多轮对话
- OpenAI-compatible API(自带/中转站均可)
- 原生 Function Calling + zod 参数校验
- 显式工具注册表、同步只读子 Agent
- 集中配置、离线 doctor 与可选在线流式工具探针
- **有副作用的操作人工确认**:写文件、执行命令前展示预览,批准后才执行
- **用户拒绝后模型不得重试或换工具绕过**
- 上下文工程：每次请求检查预算、按完整旧轮裁剪、持久化历史摘要、循环调用守卫
- 路径安全：读取、搜索、新建和编辑均限制在项目内，并检查敏感路径及真实路径
- 精确增量编辑、SHA-256 冲突检查、单文件原子提交；Ctrl+C 取消与命令进程树清理
- 主轮、摘要、委派及有限重试共享总预算；类型化运行事件与脱敏 JSONL 轨迹

## 📦 内置工具

| 工具 | 用途 | 需确认? |
| --- | --- | --- |
| `calculate` | 计算基础数学表达式 | 否 |
| `current_time` | 获取本地日期和时间 | 否 |
| `read_file` | 按行分页读取项目内文本文件 | 否 |
| `search_files` | 在项目内按行搜索文本 | 否 |
| `write_file` | 只创建不存在的项目内文件 | 是，每次 |
| `edit_file` | 按 SHA-256 和唯一旧文本精确替换 | 是，每次 |
| `run_bash` | 执行 shell 命令 | 是 |
| `add_todo` / `list_todos` / `remove_todo` | 管理项目待办草稿 | 否 |
| `ask_user` | 向用户询问信息 | 交互输入 |
| `finish_task` / `pause_task` | 明确完成或暂停当前请求 | 否 |
| `delegate_task` | 委派独立上下文的只读调查 | 否 |

## 🚀 快速开始

### 环境要求

- Node.js 22+(`openai@7.8.0` 要求)
- npm
- 可访问的 OpenAI-compatible API
- Windows 安装 Git for Windows，并通过 `MINI_AGENT_SHELL` 指定 Git Bash 的绝对路径；Linux 默认 `/bin/sh`

### 安装与配置

```bash
npm ci
```

在项目根目录创建 `.env`:

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://your-api-endpoint.example/v1
OPENAI_MODEL=your-model-name
# Windows 按实际安装位置填写；Linux 可省略。
MINI_AGENT_SHELL=C:/Program Files/Git/bin/bash.exe
```

> 不要提交 `.env`,也不要在日志、Issue 或聊天中公开 API Key。

模型名由 `OPENAI_MODEL` 指定，不自动补充 API 地址的 `/v1`。配置解析见 [src/config.ts](src/config.ts)，运行依赖由 [src/runtime.ts](src/runtime.ts) 组装。

```bash
npm run doctor             # 配置与 shell 检查，不请求模型
npm run doctor -- --online # 额外发起一次流式工具调用探针，可能计费
```

可选环境变量：`MINI_AGENT_REQUEST_TIMEOUT_MS`（默认 120000）、`MINI_AGENT_COMMAND_TIMEOUT_MS`（30000）、`MINI_AGENT_MAX_ITERATIONS`（10）、`MINI_AGENT_SUBAGENT_MAX_ITERATIONS`（6）、`MINI_AGENT_MAX_READ_MB`（5）。明确填写的非法值会报错，不静默回退。局部次数限制主／摘要与子任务逻辑请求，实际传输还必须取得下表的整轮预算。

| 整轮配置 | 默认值 | 含义 |
| --- | --- | --- |
| `MINI_AGENT_MAX_REQUESTS` | 24 | 主请求、摘要、委派、重试的实际传输尝试总数 |
| `MINI_AGENT_MAX_TOTAL_TOKENS` | 200000 | 发送前预留输入估算及输出上限，返回后按有效 usage 结算 |
| `MINI_AGENT_TURN_TIMEOUT_MS` | 600000 | 从提交本轮输入起计时，包含批准、提问、退避及工具等待 |
| `MINI_AGENT_MAX_RETRIES` | 2 | 零 chunk 时的额外重试次数，允许 0–5；SDK 隐式重试关闭 |
| `MINI_AGENT_RETRY_BASE_MS` | 500 | 指数退避初始毫秒数，最长等待 10000ms |

连接错误、请求超时及 HTTP 408/429/500/502/503/504 可有限重试；已经返回任何 chunk、认证失败、协议错误和工具执行不自动重试。缺少 usage 的请求保留预留估算，不记为零；token 总额不是供应商费用的精确硬保证。时间到期为 `budget_exhausted`，Ctrl+C 为 `cancelled`，命令单独超时为 `failed`。

上下文配置：`MINI_AGENT_CONTEXT_WINDOW`（32768）、`MINI_AGENT_OUTPUT_RESERVE`（4096）、`MINI_AGENT_CONTEXT_MARGIN`（1024）。窗口应按实际模型能力设置；本地采用文本保守估算，并非服务端精确计数。输出上限默认使用 `max_completion_tokens`，兼容服务可用 `MINI_AGENT_OUTPUT_TOKEN_PARAM=max_tokens` 显式切换。

### 启动

```bash
npm run dev
```

```text
mini-agent 已启动。输入 exit 退出。
工作目录:F:\project\mini-agent

你> 读一下 package.json,告诉我项目有哪些依赖
```

输入 `exit` / `quit` 退出。Ctrl+C 取消当前等待或运行，命令执行中会先尝试清理进程树、保存本轮状态再退出；已发生的副作用不会撤销。

`npm run dev -- --sessions` 列出本地会话，`npm run dev -- --resume UUID` 恢复指定会话并等待新指令，不重放旧动作。快照保存在 `.mini-agent/sessions/`；当前 v3 格式可读取已有 v2，读取时不改文件，下次保存写入 v3。v1 与未知版本继续拒绝打开并保留原文件。

### 批准操作

写文件、执行 shell 前会弹出确认:

```text
批准?  [y] 允许   [n] 拒绝   [a] 相同动作不再询问 >
```

- `y` 仅批准当前这一次
- `n` 拒绝当前操作(模型会收到"用户拒绝"并停下询问,而不是换个方式再来)
- `a` 对 shell 可在当前进程内记住**完全相同**的动作，重启后失效；文件变更只提供 y/n，每次审阅新 diff

批准前请看清楚文件路径、完整命令和危险提示。按工具"名 + 参数"记忆,所以放过 `pwd` 不会连带放行 `rm -rf src`。

文件修改先 `read_file` 获取整文件 SHA-256，再用 `edit_file(path, expected_sha256, old_text, new_text)`。旧文本必须精确且只出现一次；批准绑定基准与候选，批准后文件发生变化会拒写。`write_file` 不能覆盖已有文件。新建与编辑支持最大 1 MiB 的 UTF-8 文本，保留原始换行；新建通过同目录临时文件和硬链接排他发布，需要支持硬链接的本地文件系统。

## 🧱 工作原理

1. 你在终端输入指令。
2. Agent 把对话历史 + 工具定义发给模型。
3. 模型返回普通文本 → 直接输出;请求调用工具 → 进入下一步。
4. 参数经 zod 校验；文件工具准备候选与 diff，有副作用的工具请求批准；保存检查点后复查并执行。
5. 工具结果以 `tool` 消息回填,Agent 继续问模型。
6. 直到调用完成／暂停工具，或触发循环守卫、请求预算等停止条件。普通文本本身不会结束主轮。

## 验证与固定任务

```bash
npm run typecheck
npm test
npm run verify-notes
npm run test:board
npm run test:fixture
```

GitHub Actions 在 Windows／Ubuntu、Node 22 下定义上述检查，不需要 API key。远程运行是否通过以 Actions 的实际结果为准。

`npm run fixture:new` 创建一个全新的运费边界任务副本并打印目录；Agent 应只修改该副本中的 `src/shipping.ts`。完成后执行命令输出中的 `npm run fixture:check -- <任务目录>`，检查业务测试及非目标文件完整性。重新评测时再新建副本，不覆盖旧结果。

模板故意含一个缺陷；`test:fixture` 验证原始失败、已知修复与无关改动拒绝三条路径，不表示模型已经完成修复。使用说明见 [固定任务](fixtures/shipping-boundary/README.md)。

### 阶段 13 人工验收

1. **正常修复**：运行 `npm run fixture:new`，记下输出的任务目录，再运行 `npm run dev`。输入：“修复 `<任务目录>` 的运费边界，只修改其中 src/shipping.ts。先读取，用 edit_file 精确修改，展示 diff 并等我批准；再通过 run_bash 执行输出中的 fixture:check 命令。”批准应显示 `subtotal > 100` → `subtotal >= 100`；批准测试命令后，独立验收应返回 `passed: true`、`unexpected: []` 和三项测试通过。
2. **拒绝**：另建一个副本，重复修复请求并补充“如果我拒绝就暂停”。在文件批准处输入 `n`；目标文件应保持 `> 100`，不应通过 shell 绕过写入。
3. **外部冲突**：另建副本，请求修复并补充“如遇文件冲突立即暂停，不重新申请写入”。等 diff 出现后，在编辑器给目标文件增加一行注释并保存，再输入 `y`。应提示冲突拒写，保留注释和原来的 `> 100`。
4. **命令取消**：请求“通过 run_bash 执行 `sleep 20`，之后再计算 1+1”。批准后按 Ctrl+C；应显示取消与清理状态，本轮 cancelled，后续计算不执行。重新 `--resume` 该会话应提示不确定动作，并等待新指令而不重放。
5. **超时**（PowerShell）：启动前设置 `$env:MINI_AGENT_COMMAND_TIMEOUT_MS='1000'`，请求并批准 `sleep 5`；应约一秒触发超时、显示清理状态并将本轮标为 failed。退出后 `Remove-Item Env:MINI_AGENT_COMMAND_TIMEOUT_MS` 恢复默认环境。

`npm test` 还覆盖零／多匹配、同名文件冲突、链接路径、输出超限和真实子孙进程心跳停止。真实模型措辞与人工操作以上述可观察文件和状态为准；Windows Git Bash 已在本机运行，Linux 分支须由对应环境或 CI 验证。

原始对话历史完整保存在会话中。模型每次只接收符合预算的派生视图；需要删除旧轮时，每个真实用户轮最多尝试一次摘要，保留目标、约束、确认动作、拒绝和待核查事项。摘要单独保存覆盖范围与原文指纹，恢复后不重复拼入已覆盖消息。

摘要请求同样检查窗口并占用主轮及整轮请求次数，开始前至少留一次正常请求额度；后续重试也扣总额，耗尽时不能额外借出回答额度。完整旧轮无法放入摘要请求、生成／校验／保存失败时，沿用可发送的裁剪视图。当前轮本身仍超限则停止。摘要有损且可能失真，不是新授权；取消或总预算耗尽直接停止。委派保留较小局部次数，同时共享全轮 token、时间和传输账目。

### 阶段 14 人工验收

自动故障注入可先运行 `npm run test:resilience`，不需要 API key，覆盖网络重试、流中断、共享预算、取消和脱敏。下面检查真实模型与本机交互；每次启动记录终端显示的会话 UUID。

1. **正常任务与委派**：`npm run dev`，输入“计算 17×23，然后完成”；应得到 391、completed 和 `[run]` 请求／工具／token／耗时汇总。下一轮输入“通过 delegate_task 只读调查 package.json 的 npm scripts，返回后结束”。应出现 subagent 请求，轮末总次数包含子请求。
2. **批准中取消**：请求“执行 run_bash 的 `echo stage14-check`，之后再计算 1+1”。在批准框按 Ctrl+C；命令和后续计算不得执行，本轮 cancelled。恢复同一会话应等待新输入，动作标为 not_executed。再分别在 `你>` 输入等待、模型响应等待或明确请求 `ask_user` 后按 Ctrl+C，均应退出而不触发后续动作。
3. **总次数耗尽**：PowerShell 设置 `$env:MINI_AGENT_MAX_REQUESTS='1'` 后启动；输入“必须先调用 delegate_task 调查 package.json，再总结”。若模型按要求委派，子请求不得发出，总请求数为 1，本轮 budget_exhausted。退出后执行 `Remove-Item Env:MINI_AGENT_MAX_REQUESTS`。
4. **批准等待计入总时限**：设置 `$env:MINI_AGENT_TURN_TIMEOUT_MS='30000'` 后启动，请求执行 `echo stage14-check`。批准框出现后保持不输入，直到自提交输入起 30 秒到期，应 budget_exhausted，命令不执行；若模型本身响应超过 30 秒，则应先在模型等待阶段停止。退出后执行 `Remove-Item Env:MINI_AGENT_TURN_TIMEOUT_MS`。
5. **token 发送前拦截**：设置 `$env:MINI_AGENT_MAX_TOTAL_TOKENS='1'` 后启动并输入任意任务；应显示 budget_exhausted、请求 0，未访问模型。退出后执行 `Remove-Item Env:MINI_AGENT_MAX_TOTAL_TOKENS`。
6. **检查轨迹**：打开 `.mini-agent/sessions/<UUID>/trace.jsonl`，核对相同 turnId 内的 request_start 数与 turn_end.requests 一致，委派含 taskId，摘要 scope 为 summary；request_end.accounting 缺 usage 时为 estimated。文件不应含用户正文、模型正文、密钥、命令参数、文件正文或异常原文。恢复会话、提交新任务应追加新 turnId，次数从头计算。

每轮轨迹只保存白名单元数据，工具状态按本轮 action 编号关联；扩展工具名记为 other。轨迹写失败只警告一次，会话快照仍独立保存。**snapshot.json 保存完整原始对话，不属于脱敏轨迹**；终端显示的模型正文和批准预览也保留任务内容。轨迹不作为恢复来源，取消不撤销副作用；总截止后的命令树清理和可靠保存可能需要额外时间。

## 🛡️ 安全边界

安全模型分两类,别混为一谈:

| 通道 | 强制边界? | 边界是什么 |
| --- | --- | --- |
| `read_file` / `search_files`(免审批读取) | ✅ 代码强制 | 项目目录内;拒绝 .env/.git/node_modules/私钥;realpath 校验符号链接;超限文件拒绝 |
| `write_file` / `edit_file` | ✅ 代码检查 + 人工批准 | 项目内、敏感路径与链接拒绝、完整 diff、基准冲突拒写 |
| `run_bash` | 人工批准 | 显示完整命令、shell 与工作目录；不提供文件沙箱 |

文件工具检查项目边界，shell 能访问操作系统允许的范围。指纹及路径复查用于发现通常的外部修改，检查与提交之间仍有竞态，**不构成抵御恶意并发进程的完整沙箱**。

具体规则:

- `read_file` 只读项目目录内文件,遇 `.env`、`.git`、`node_modules`、`id_rsa`、`.pem`/`.key` 一律拒绝;单个文件超过 5MB 整读会被拒绝(可用 `MINI_AGENT_MAX_READ_MB` 环境变量调整上限)。
- `search_files` 允许项目根目录，走同一套名单，目录入口别名也检查真实敏感路径；递归时不跟随符号链接／junction。
- 文件写入拒绝链接组件和目标硬链接，提交保留普通权限模式；不承诺保留扩展属性或 ACL，也不提供多文件事务或断电保证。
- `run_bash` 用正则提示危险模式。默认最长运行 30 秒，stdout/stderr 各自超过 1 MiB 会中断；中断保留已捕获输出，并明确可能存在部分副作用。
- Windows Git Bash 使用 `taskkill /T /F`，POSIX sh/bash 使用独立进程组终止。脱离进程树的后台服务不在清理保证内；报告操作和返回状态，不把发送终止信号当作任意后代已退出的证明。

## ✅ 开发

```bash
npm run typecheck   # 类型检查
npm test            # 运行单元测试(node:test)
npm run verify-notes # 校验开发决策笔记
npm run board        # 生成可连接本地项目的看板
npm run board:bundle # 生成含地图、进度与笔记的离线快照
npm run test:board   # 检查地图配置、资料读取与稳定同步
```

本项目采用 AI 教练协作方式，入口见 [AGENTS.md](AGENTS.md)。通用的教练 Skill 与原版决策笔记 Skill 分开维护，项目背景和当前阶段保存在 [.agents/learning/](.agents/learning/)。使用、上游版本和迁移方式见 [开发协作说明](.agents/README.md)。

打开 [board.html](board.html)，通过顶部导航查看项目地图、决策资料、演进记录和方案取舍。首页流程图占据完整内容宽度，点击环节就地展开实现、限制和决策依据，再次点击收起；完整笔记在居中阅读层打开，关闭后回到原来的筛选、节点和阅读位置。当前实现、下一步候选与可选学习区域读取现有进度记录。连接项目根目录或 `.agents` 后，地图配置、进度和笔记一起自动同步。项目内容由可选的 [.agents/board.json](.agents/board.json) 配置；直接浏览完整打包内容可用 [board.snapshot.html](board.snapshot.html)。

## 🗺️ 项目结构

```text
mini-agent/
├─ src/
│  ├─ agent.ts          # 配置加载、REPL、跨轮历史与错误收尾
│  ├─ config.ts         # 纯配置解析
│  ├─ runtime.ts        # 模型与主／子 Agent 工具集合组装
│  ├─ turn.ts           # 主轮执行器
│  ├─ subagent.ts       # 独立只读子 Agent 循环
│  ├─ stream.ts         # 流式消息与工具调用组装
│  ├─ doctor.ts / doctor-cli.ts # 诊断函数与命令入口
│  ├─ approval.ts       # y/n/a 人工确认
│  ├─ command.ts        # 有界输出、超时、取消与进程树清理
│  ├─ context.ts        # 工具结果截断、历史裁剪、循环守卫
│  ├─ guard.ts          # 共享路径守卫(项目边界 + 敏感名单 + realpath)
│  ├─ llm.ts            # 显式配置的模型流工厂与请求超时
│  ├─ ui.ts             # 全进程唯一 readline 封装
│  ├─ tools/
│  │  ├─ index.ts       # 主工具集合工厂与工具状态初始化
│  │  ├─ registry.ts    # schema、准备与执行公共逻辑
│  │  ├─ types.ts       # Tool 接口定义
│  │  ├─ fs.ts / edit.ts / grep.ts / bash.ts / calc.ts / time.ts
│  └─ *.test.ts         # 配置、协议、工具与循环的确定性回归
├─ fixtures/            # 固定缺陷任务模板
├─ scripts/eval-fixture.mjs # 任务副本与独立验收
├─ .github/workflows/ci.yml # 无密钥确定性检查
├─ CHANGELOG.md
├─ LICENSE
└─ package.json
```

## 📜 License

[ISC](LICENSE)

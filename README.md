# mini-agent

一个跑在本地终端里的命令行 AI Agent,用 TypeScript 和 [OpenAI SDK](https://github.com/openai/openai-node) 编写,连接任意 OpenAI-compatible API。

它可以和你持续对话，并借助模型发起的工具调用读文件、搜代码、写文件、执行 shell 命令、管理待办和委派只读调查。写文件和执行命令前需要批准；命令展示完整文本，当前整文件写入预览仅显示前 20 行。

## ✨ 功能特性

- 命令行多轮对话
- OpenAI-compatible API(自带/中转站均可)
- 原生 Function Calling + zod 参数校验
- 显式工具注册表、同步只读子 Agent
- 集中配置、离线 doctor 与可选在线流式工具探针
- **有副作用的操作人工确认**:写文件、执行命令前展示预览,批准后才执行
- **用户拒绝后模型不得重试或换工具绕过**
- 上下文工程：每次请求检查预算、按完整旧轮裁剪、持久化历史摘要、循环调用守卫
- 路径安全:读文件的工具被限制在项目目录内,并有敏感名单

## 📦 内置工具

| 工具 | 用途 | 需确认? |
| --- | --- | --- |
| `calculate` | 计算基础数学表达式 | 否 |
| `current_time` | 获取本地日期和时间 | 否 |
| `read_file` | 按行分页读取项目内文本文件 | 否 |
| `search_files` | 在项目内按行搜索文本 | 否 |
| `write_file` | 新建或完整覆盖文件 | 是 |
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

可选环境变量：`MINI_AGENT_REQUEST_TIMEOUT_MS`（默认 120000）、`MINI_AGENT_COMMAND_TIMEOUT_MS`（30000）、`MINI_AGENT_MAX_ITERATIONS`（10）、`MINI_AGENT_SUBAGENT_MAX_ITERATIONS`（6）、`MINI_AGENT_MAX_READ_MB`（5）。明确填写的非法值会报错，不静默回退。当前次数为主／子循环的局部上限，尚非共享总预算；单请求超时尚非端到端取消。

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

输入 `exit` / `quit` 退出。

`npm run dev -- --sessions` 列出本地会话，`npm run dev -- --resume UUID` 恢复指定会话并等待新指令，不重放旧动作。快照保存在 `.mini-agent/sessions/`；当前 v3 格式可读取已有 v2，读取时不改文件，下次保存写入 v3。v1 与未知版本继续拒绝打开并保留原文件。

### 批准操作

写文件、执行 shell 前会弹出确认:

```text
批准?  [y] 允许   [n] 拒绝   [a] 相同动作不再询问 >
```

- `y` 仅批准当前这一次
- `n` 拒绝当前操作(模型会收到"用户拒绝"并停下询问,而不是换个方式再来)
- `a` 本次会话内不再询问**完全相同**的动作,程序重启后失效

批准前请看清楚文件路径、完整命令和危险提示。按工具"名 + 参数"记忆,所以放过 `pwd` 不会连带放行 `rm -rf src`。

## 🧱 工作原理

1. 你在终端输入指令。
2. Agent 把对话历史 + 工具定义发给模型。
3. 模型返回普通文本 → 直接输出;请求调用工具 → 进入下一步。
4. 参数经 zod 校验,有副作用的工具先请求批准。
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

原始对话历史完整保存在会话中。模型每次只接收符合预算的派生视图；需要删除旧轮时，每个真实用户轮最多尝试一次摘要，保留目标、约束、确认动作、拒绝和待核查事项。摘要单独保存覆盖范围与原文指纹，恢复后不重复拼入已覆盖消息。

摘要请求同样检查窗口并占用主轮请求次数，至少预留一次正常请求；完整旧轮无法放入摘要请求、生成／校验／保存失败时，沿用可发送的裁剪视图。当前轮本身仍超限则停止。摘要有损且可能失真，不是新授权；取消会停止而非回退后继续。主轮与摘要共享次数，委派仍有独立次数，全轮统一 token／时间／请求账目尚未实现。

## 🛡️ 安全边界

安全模型分两类,别混为一谈:

| 通道 | 强制边界? | 边界是什么 |
| --- | --- | --- |
| `read_file` / `search_files`(免审批读取) | ✅ 代码强制 | 项目目录内;拒绝 .env/.git/node_modules/私钥;realpath 校验符号链接;超限文件拒绝 |
| `write_file` / `run_bash`(人工审批) | ❌ 靠人 | 展示预览后由你批准;不做伪白名单 |

读文件的工具会把内容带进模型上下文,所以它们必须自己在代码里守边界。写文件和 shell 能碰到项目外,人工批准是唯一闸门 —— **这些都不是完整沙箱**,批准前请自行判断。

具体规则:

- `read_file` 只读项目目录内文件,遇 `.env`、`.git`、`node_modules`、`id_rsa`、`.pem`/`.key` 一律拒绝;单个文件超过 5MB 整读会被拒绝(可用 `MINI_AGENT_MAX_READ_MB` 环境变量调整上限)。
- `search_files` 走同一套名单,递归时不跟随符号链接/ junction(起始目录若本身是链接,直接拒绝)。
- `run_bash` 不做命令白名单,用正则提示危险模式(删除、重定向、网络、提权等)。单条命令最长运行 30 秒;输出超过 1MiB 会被中断并如实报告。

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
│  ├─ context.ts        # 工具结果截断、历史裁剪、循环守卫
│  ├─ guard.ts          # 共享路径守卫(项目边界 + 敏感名单 + realpath)
│  ├─ llm.ts            # 显式配置的模型流工厂与请求超时
│  ├─ ui.ts             # 全进程唯一 readline 封装
│  ├─ tools/
│  │  ├─ index.ts       # 主工具集合工厂与工具状态初始化
│  │  ├─ registry.ts    # schema、准备与执行公共逻辑
│  │  ├─ types.ts       # Tool 接口定义
│  │  ├─ fs.ts / grep.ts / bash.ts / calc.ts / time.ts
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

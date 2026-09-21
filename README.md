# mini-agent

[![CI](https://github.com/xilele777/mini-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/xilele777/mini-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/xilele777/mini-agent)](https://github.com/xilele777/mini-agent/releases/latest)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

一个用 TypeScript 编写的本地命令行 AI Agent。连接支持流式工具调用的 OpenAI-compatible API，在终端中读取项目、搜索代码、编辑文件、执行命令，并保存可恢复的会话。

文件变更和命令执行前展示操作内容并请求批准。项目采用直接 SDK、显式工具注册表和同步只读子 Agent，便于阅读、扩展和理解运行过程。

## 功能

- **项目工具**：分页读取、文本搜索、带 SHA-256 冲突检查的增量编辑、新建文件和 shell 命令。
- **人工批准**：文件修改展示完整 diff，每次单独批准；命令展示完整文本、工作目录和 shell。
- **会话恢复**：对话、待办与动作状态保存到本地；恢复等待新指令，不自动重放旧操作。
- **只读委派**：子 Agent 使用独立上下文调查问题，结果返回主 Agent。
- **上下文管理**：请求前检查预算，按完整用户轮裁剪旧历史，并保存增量摘要。
- **运行控制**：取消、超时、有限传输重试，以及主请求／摘要／子任务共享的次数和 token 预算。
- **诊断与轨迹**：离线环境检查、可选在线探针，每轮输出请求数、token、耗时并保存脱敏事件。

## 安装

需要 **Node.js 22+**、npm，以及支持流式 Function Calling 的 API。Windows 还需安装 [Git for Windows](https://gitforwindows.org/)；Linux 使用 sh/bash。

### 安装发行包

从 [GitHub Releases](https://github.com/xilele777/mini-agent/releases/latest) 下载 `mini-agent-1.1.0.tgz`，然后执行：

```bash
npm install -g ./mini-agent-1.1.0.tgz
mini-agent --help
```

发行包包含编译后的 JavaScript，使用时无需 TypeScript 或 tsx。Release 同时提供 `SHA256SUMS` 供校验。

### 从源码运行

```bash
git clone https://github.com/xilele777/mini-agent.git
cd mini-agent
npm ci
npm run build
npm start -- --help
```

开发时可用 `npm run dev` 直接运行 TypeScript；修改源码后，重新构建才会更新 `npm start` 使用的产物。

## 配置

进入需要操作的项目目录，在该目录创建 `.env`。源码仓库提供 [.env.example](.env.example)：

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://your-api-endpoint.example/v1
OPENAI_MODEL=your-model-name

# Windows 必填：取消注释并填写实际 Git Bash 绝对路径。
# MINI_AGENT_SHELL=C:/Program Files/Git/bin/bash.exe
```

Linux 默认使用 `/bin/sh`，也可显式指定 bash 的绝对路径。macOS 使用相同 POSIX 配置，当前 CI 覆盖 Windows 和 Ubuntu。不要将 PowerShell 或 cmd.exe 配置为 `MINI_AGENT_SHELL`。

API 地址不会自动补充 `/v1`，请使用服务商提供的完整 API 前缀。将 `.env` 和 `.mini-agent/` 加入目标项目的 Git 忽略规则。

```bash
mini-agent --doctor
mini-agent --doctor --online
mini-agent
```

`--doctor` 检查配置和 shell，不请求模型；`--online` 额外发送一次流式工具探针，可能计费。源码运行时将 `mini-agent` 替换为 `npm start --`。

## 使用

在目标项目目录启动后，直接输入任务，例如：

```text
你> 阅读 package.json，说明项目如何运行和测试。
你> 先调查这个函数的调用位置，再提出修改建议。
你> 修复运费边界错误，只修改 shipping.ts，展示 diff 等我批准。
```

输入 `exit` 或 `quit` 退出。Ctrl+C 取消当前等待或运行，保存状态并尝试清理正在执行的命令进程树。

| 选项 | 用途 |
| --- | --- |
| 无参数 | 新建交互会话 |
| `--help` / `-h` | 显示帮助 |
| `--version` / `-v` | 显示版本 |
| `--doctor [--online]` | 环境诊断与可选在线探针 |
| `--sessions` | 列出当前项目的会话 |
| `--resume UUID` | 恢复指定会话，等待新输入 |

### 批准操作

- `y`：允许当前操作。
- `n`：拒绝当前操作，将拒绝结果交回模型。
- `a`：仅对 shell 提供，在当前进程记住完全相同的命令动作；重启后失效。

文件变更只提供 y/n，每次审阅新的 diff。修改已有文件先读取指纹，再生成唯一文本替换；批准后文件发生变化会拒绝写入。`write_file` 仅创建不存在的文件。

### 会话与数据

所有路径以**启动时的工作目录**为准，配置和会话不存放在程序安装目录：

```text
.mini-agent/sessions/<UUID>/
├─ snapshot.json   # 原始对话、待办、轮结果和动作记录
└─ trace.jsonl     # 请求、工具状态、预算与耗时等事件
```

快照包含完整任务内容，轨迹只保存白名单元数据；分享日志前请确认分享范围。每个会话使用独占锁，避免多个进程同时写入。崩溃后若提示锁已存在，先确认原进程已经退出，再检查对应会话目录中的锁文件；不要删除仍在使用的锁。

恢复不会自动重放工具。结果不确定的动作需要结合实际文件或外部状态判断。当前快照格式为 v3，可读取 v2；未知版本和损坏数据不会被静默覆盖。需要清理时，退出进程后备份或删除对应 UUID 目录。

### 工具

| 工具 | 功能 |
| --- | --- |
| `read_file` / `search_files` | 分页读取文件、搜索项目文本 |
| `write_file` / `edit_file` | 新建文件、精确增量编辑 |
| `run_bash` | 运行经批准的 shell 命令 |
| `calculate` / `current_time` | 基础计算、当前时间 |
| `add_todo` / `list_todos` / `remove_todo` | 管理当前会话的待办 |
| `delegate_task` | 委派独立上下文的只读调查 |
| `ask_user` | 在执行中请求用户补充信息 |
| `finish_task` / `pause_task` | 明确完成或暂停当前任务 |

## 可选配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `MINI_AGENT_REQUEST_TIMEOUT_MS` | 120000 | 单次模型请求超时 |
| `MINI_AGENT_COMMAND_TIMEOUT_MS` | 30000 | 单条命令超时 |
| `MINI_AGENT_MAX_ITERATIONS` | 10 | 主轮／摘要的局部逻辑请求上限 |
| `MINI_AGENT_SUBAGENT_MAX_ITERATIONS` | 6 | 子任务局部请求上限 |
| `MINI_AGENT_MAX_REQUESTS` | 24 | 主轮、摘要、子任务及重试的总传输次数 |
| `MINI_AGENT_MAX_TOTAL_TOKENS` | 200000 | 每轮累计 token 预算 |
| `MINI_AGENT_TURN_TIMEOUT_MS` | 600000 | 整轮时限，包含批准和提问等待 |
| `MINI_AGENT_MAX_RETRIES` | 2 | 可重试传输失败的额外尝试次数，范围 0–5 |
| `MINI_AGENT_RETRY_BASE_MS` | 500 | 指数退避初始间隔，最高 10000ms |
| `MINI_AGENT_CONTEXT_WINDOW` | 32768 | 模型上下文窗口 |
| `MINI_AGENT_OUTPUT_RESERVE` | 4096 | 每次请求预留输出 token |
| `MINI_AGENT_CONTEXT_MARGIN` | 1024 | 上下文安全余量 |
| `MINI_AGENT_OUTPUT_TOKEN_PARAM` | max_completion_tokens | 可切换为兼容服务使用的 max_tokens |
| `MINI_AGENT_MAX_READ_MB` | 5 | 单个文件的读取大小上限 |

显式填写的非法值会报错。窗口应按实际模型能力设置；本地 token 采用保守估算，缺失 usage 时保留估算值，不作为精确账单。摘要有损，原始历史仍保存在快照中。

仅在尚未收到任何 chunk 时，对连接错误、请求超时及 HTTP 408/429/500/502/503/504 做有限重试；工具执行不自动重试，已执行动作不重放。

## 状态与退出码

每轮单独报告 `completed`、`paused`、`failed`、`cancelled` 或 `budget_exhausted`。失败后可以在 REPL 中提交新任务，正常退出不代表此前每轮都成功。

| 退出码 | 含义 |
| --- | --- |
| 0 | 正常退出，或帮助、列表、诊断成功 |
| 1 | 启动、配置、诊断或存储失败 |
| 2 | 参数错误 |
| 130 | 用户取消 |

## 安全边界

文件工具限制在项目目录内，检查敏感路径与真实路径；读取和搜索拒绝 `.env`、`.git`、`node_modules` 及私钥等路径。文件变更拒绝链接路径，使用指纹检查和单文件原子提交；只支持最大 1 MiB 的 UTF-8 修改，新建文件需要支持硬链接的文件系统。

**shell 不是沙箱**，能够访问当前操作系统账户允许的范围，必须审阅完整命令再批准。模型收到拒绝后会被提示遵守拒绝；提示词不构成操作系统级隔离。

取消不会撤销已发生的副作用。命令输出有大小上限，超限或超时会中断并保留已捕获输出。进程树清理不保证终止脱离进程树的后台服务；文件原子提交不提供多文件事务或断电保障。

## 开发与贡献

项目采用 TypeScript、ES modules、Zod 和 node:test。运行流程为用户输入 → 模型流 → 参数校验与批准 → 工具执行与检查点 → 结果回填，直到完成、暂停或达到预算。

构建、测试、固定任务和贡献约定见 [CONTRIBUTING.md](https://github.com/xilele777/mini-agent/blob/main/CONTRIBUTING.md)。版本变化见 [CHANGELOG.md](CHANGELOG.md)；问题反馈请提交 [Issue](https://github.com/xilele777/mini-agent/issues)。

## License

[ISC](LICENSE)

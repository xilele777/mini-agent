# mini-agent

一个跑在本地终端里的命令行 AI Agent,用 TypeScript 和 [OpenAI SDK](https://github.com/openai/openai-node) 编写,连接任意 OpenAI-compatible API。

它可以和你持续对话,并借助模型发起的工具调用读文件、搜代码、写文件、执行 shell 命令、算表达式、取本地时间。凡是有副作用的操作(写文件、跑命令),执行前都会把完整内容摆到你面前,由你批准。

## ✨ 功能特性

- 命令行多轮对话
- OpenAI-compatible API(自带/中转站均可)
- 原生 Function Calling + zod 参数校验
- 内置六种工具(见下)
- **有副作用的操作人工确认**:写文件、执行命令前展示预览,批准后才执行
- **用户拒绝后模型不得重试或换工具绕过**
- 上下文工程:工具结果截断、按轮裁剪历史、循环调用守卫
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

## 🚀 快速开始

### 环境要求

- Node.js 22+(`openai@7.8.0` 要求)
- npm
- 可访问的 OpenAI-compatible API
- Windows 下需保证 `bash.exe` 可用(如安装 Git for Windows 并把 Git Bash 加入 `PATH`)

### 安装与配置

```bash
npm install
```

在项目根目录创建 `.env`:

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://your-api-endpoint.example/v1
```

> 不要提交 `.env`,也不要在日志、Issue 或聊天中公开 API Key。

当前模型名写在 [src/llm.ts](src/llm.ts) 的 `MODEL` 里,按你的 API 服务改:

```ts
export const MODEL = 'gpt-5.6-sol'
```

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
6. 直到模型给出最终回复,或超过单轮迭代上限(默认 10 轮)。

对话历史是 Agent 的全部记忆:长对话按"一轮"裁剪,只保留最近几轮;单次输入中若模型原地重复调用同一工具,会被循环守卫拦下。

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
```

## 🗺️ 项目结构

```text
mini-agent/
├─ src/
│  ├─ agent.ts          # Agent 主循环、工具调用与循环守卫接入
│  ├─ approval.ts       # y/n/a 人工确认
│  ├─ context.ts        # 工具结果截断、历史裁剪、循环守卫
│  ├─ guard.ts          # 共享路径守卫(项目边界 + 敏感名单 + realpath)
│  ├─ llm.ts            # OpenAI 客户端与模型名
│  ├─ ui.ts             # 全进程唯一 readline 封装
│  ├─ tools/
│  │  ├─ index.ts       # 注册表、schema 生成、prepareCall / executeCall
│  │  ├─ types.ts       # Tool 接口定义
│  │  ├─ fs.ts / grep.ts / bash.ts / calc.ts / time.ts
│  └─ *.test.ts         # 纯函数与路径守卫的最小自动化测试
├─ CHANGELOG.md
├─ LICENSE
└─ package.json
```

## 📜 License

[ISC](LICENSE)

# mini-agent

一个使用 TypeScript 和 OpenAI SDK 编写的本地命令行 AI Agent。

它可以在终端中与用户持续对话，并根据模型发起的工具调用读取文件、写入文件、执行 Shell 命令、计算数学表达式以及获取本地时间。涉及文件写入或命令执行时，程序会先展示操作内容并请求用户批准。

## 功能

- 命令行多轮对话
- OpenAI-compatible API 支持
- 工具调用与参数校验
- 读取项目目录内的文本文件
- 新建或完整覆盖文件
- 执行 Shell 命令
- 基础数学表达式计算
- 获取当前本地日期和时间
- 对有副作用的操作进行人工确认
- 用户拒绝后禁止 Agent 自动重试或换一种方式绕过
- 工具调用失败时自动回滚本轮对话历史

## 技术栈

- Node.js
- TypeScript
- OpenAI Node SDK
- Zod
- tsx
- dotenv

## 环境要求

- Node.js 22 或更高版本
- npm
- 可访问的 OpenAI-compatible API
- Windows 环境下需要确保 `bash.exe` 可用，例如安装 Git for Windows 并将 Git Bash 加入 `PATH`

> `openai@7.8.0` 要求 Node.js `>=22.0.0`。

## 安装

```bash
npm install
```

## 配置

在项目根目录创建 `.env` 文件：

```env
OPENAI_API_KEY=your_api_key
OPENAI_BASE_URL=https://your-api-endpoint.example/v1
```

当前模型在 `src/llm.ts` 中配置：

```ts
export const MODEL = 'gpt-5.6-sol'
```

请根据所使用的 API 服务修改为实际可用的模型名称。

> 不要提交 `.env` 文件，也不要在日志、Issue 或聊天内容中公开 API Key。

## 启动

```bash
npm run dev
```

启动后可以直接输入自然语言指令：

```text
mini-agent 已启动。输入 exit 退出。
工作目录：F:\project\mini-agent

你> 读一下 package.json，告诉我项目有哪些依赖
```

输入以下任一命令退出：

```text
exit
quit
```

## 操作确认

文件写入和 Shell 命令执行前会出现确认提示：

```text
批准?  [y] 允许   [n] 拒绝   [a] 本次会话都允许 >
```

选项说明：

- `y`：仅批准当前操作
- `n`：拒绝当前操作
- `a`：本次会话中自动批准完全相同的操作，程序重启后失效

批准前请仔细检查显示的文件路径、完整命令和危险操作提醒。

## 内置工具

| 工具 | 用途 | 是否需要确认 |
| --- | --- | --- |
| `calculate` | 计算基础数学表达式 | 否 |
| `current_time` | 获取本地日期和时间 | 否 |
| `read_file` | 读取项目目录内的文本文件 | 否 |
| `write_file` | 新建或完整覆盖文件 | 是 |
| `run_bash` | 执行 Shell 命令 | 是 |

## 安全限制

### 文件读取

`read_file` 只能读取当前项目目录内的文件，并拒绝读取以下敏感或体积较大的内容：

- `.env` 及其变体
- `.git`
- `node_modules`
- `id_rsa`
- `.pem` 和 `.key` 私钥文件

### 文件写入

`write_file` 使用完整覆盖模式。目标文件已存在时，原内容会被全部替换。执行前会显示目标路径和内容预览，并要求人工确认。

### Shell 命令

`run_bash` 执行前始终要求人工确认，并对删除文件、输出重定向、网络访问、提权、危险 Git 操作等模式给出提醒。

这些提醒不是完整的安全沙箱。模型生成的命令仍可能产生不可逆影响，请在批准前自行检查。

- 单条命令最长运行 30 秒
- 不要执行需要交互输入的程序，例如 `vim`、`top` 或等待确认的安装命令
- 命令输出过长时会被截断
- Windows 默认使用 `bash.exe`

## 项目结构

```text
mini-agent/
├─ src/
│  ├─ agent.ts          # Agent 主循环与工具调用流程
│  ├─ llm.ts            # OpenAI 客户端、API 配置和模型名称
│  ├─ approval.ts       # 人工确认机制
│  ├─ ui.ts             # 命令行输入界面
│  └─ tools/
│     ├─ index.ts       # 工具注册、Schema 生成和调用分发
│     ├─ types.ts       # 工具类型定义
│     ├─ fs.ts          # 文件读取与写入工具
│     ├─ bash.ts        # Shell 命令工具
│     ├─ calc.ts        # 数学计算工具
│     └─ time.ts        # 本地时间工具
├─ package.json
├─ package-lock.json
├─ tsconfig.json
└─ README.md
```

## 工作原理

1. 用户在终端输入指令。
2. Agent 将对话历史和工具定义发送给模型。
3. 如果模型返回普通文本，Agent 将结果输出到终端。
4. 如果模型请求调用工具，Agent 会校验工具名称、JSON 参数和 Zod Schema。
5. 有副作用的工具会先请求用户批准。
6. 工具执行结果作为 `tool` 消息回填给模型。
7. Agent 继续请求模型，直到得到最终回复，或达到单轮最大迭代次数。

每次用户输入最多允许 10 轮模型调用。若本轮出现异常，程序会回滚本轮新增的消息，避免不完整的 `tool_calls` 历史导致后续请求失败。

## 添加新工具

1. 在 `src/tools/` 中创建工具模块。
2. 使用 Zod 定义参数 Schema。
3. 实现 `Tool` 接口中的 `name`、`description`、`schema` 和 `execute`。
4. 如果工具有副作用，设置 `needsApproval: true`，并建议实现 `preview`。
5. 在 `src/tools/index.ts` 的 `ALL_TOOLS` 数组中注册工具。

示例：

```ts
import { z } from 'zod'
import type { Tool } from './types.js'

const params = z.object({
  text: z.string().min(1),
})

export const echoTool: Tool<z.infer<typeof params>> = {
  name: 'echo',
  description: '原样返回一段文本。',
  schema: params,
  execute: ({ text }) => text,
}
```

## 已知限制

- 当前没有自动化测试。
- 当前模型名称直接写在源码中，而不是通过环境变量配置。
- `write_file` 本身没有像 `read_file` 一样限制目标必须位于项目目录内，批准写入前应特别检查路径。
- Shell 工具依赖本机 Bash 配置；如果 Windows 中找不到 `bash.exe`，命令将无法执行。
- 危险命令检测基于正则提示，不能替代沙箱或人工审查。

## License

ISC

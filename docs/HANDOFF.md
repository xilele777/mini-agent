# 交接：mini-agent 学习项目

> 新开对话时，先读这份文件即可继续。每阶段结束后更新。

## 我是谁 / 我要什么

- Agent 零基础，TypeScript 尚不熟练（Python 更弱）。
- **你是教练，不是代笔**：讲原理、指出错误、review 代码，不要直接替我实现。
- 但我经常卡住。**卡住时的有效模式是：给完整参考代码 + 逐块讲解 + 留一个改造任务**；纯抽象指引对我不管用。
- 周边语法（正则、JSON Schema 结构等）可以直接给，核心逻辑让我自己填。
- **代码由我自己粘贴到文件里，不要直接改我的 `src`**。`docs/` 可以由 AI 写入。
- 始终使用简体中文。

## 技术栈与运行约束

- TypeScript + `tsx`，当前入口是 `src/agent.ts`。
- `package.json` 的 `dev` 脚本已经改为：`tsx src/agent.ts`。
- `openai` SDK v7，连接 OpenAI-compatible 中转站。
- `.env` 提供 `OPENAI_API_KEY` / `OPENAI_BASE_URL`。
- 模型：`gpt-5.6-sol`。中转站会注入自己的 system prompt，prompt tokens 基线约约 4400。
- `zod` v4 已安装（4.5.4），不要安装 `zod-to-json-schema`；v4 已内置 `z.toJSONSchema()`。
- `package.json` 是 `"type": "module"`，import 必须使用 `.js` 后缀。
- `tsconfig` 开启 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`。
- 下标访问可能得到 `undefined`，约定优先使用 `?? ''`，不要滥用 `!` 断言。
- 本机 Windows 的 Git Bash 真实路径是：`D:\Git\bin\bash.exe`。
- 当前环境下，AI 在 Bash 工具中不能可靠运行交互式 `node` / `tsx` / `tsc`；验证命令由学习者在 PowerShell 中运行并贴结果。

## 当前文件

```text
src/
  index.ts          阶段 0 的最小 API 调用 demo，可保留但不是当前入口
  llm.ts            环境变量校验，导出 client 和 MODEL
  agent.ts          多轮 REPL、Agent Loop、确认流程和 Ctrl+C 处理
  ui.ts             全进程唯一的 readline 输入封装
  approval.ts       y / n / a 确认机制与本次进程的动作批准缓存
  tools/
    types.ts        Tool 接口：name / description / schema / execute /
                    needsApproval? / preview?
    calc.ts         calculate 工具
    time.ts          current_time 工具
    fs.ts            read_file / write_file 工具
    bash.ts          run_bash 工具
    index.ts         工具注册表、Schema 生成、prepareCall、executeCall
```

阶段 1 的 `protocol.ts` 已经删除；阶段 1 的代码和实验仍可从 git 历史查看，不需要让死代码继续留在当前架构中。

## 六阶段路线

0. ✅ 打通 API，理解 response 结构
1. ✅ 手写 ReAct（纯 prompt + 正则，不用 `tools` 参数）
2. ✅ 换成原生 Function Calling
3. ✅ **抽 Tool 接口与注册表（zod v4 `toJSONSchema`）**
4. ✅ **真实副作用工具 + 执行前确认机制**
5. ⬜ **上下文管理 + 循环护栏** ← 下一阶段

阶段 4 的详细设计和实测记录在：

```text
docs/superpowers/specs/2026-09-02-stage4-side-effect-tools-design.md
```

最终目标：一个能读写文件、执行命令的本地 CLI Agent。

## 阶段 3 已验证的关键成果

### 注册表架构验收

新增 `current_time` 工具时，全部改动只有：

1. 新建 `src/tools/time.ts`；
2. `src/tools/index.ts` 增加 import；
3. `ALL_TOOLS` 增加一项。

`agent.ts` 零改动，满足阶段 3 的硬性架构约束：

> `agent.ts` 不得 import 任何具体工具，只能与注册表交互。

### 并行与串行

当任务包含独立操作和依赖链时，同一次运行可以同时出现：

```text
第 1 轮：current_time + calculate（互相独立，可以并行）
第 2 轮：依赖上一轮结果的 calculate
```

轮数由最长依赖链决定，不由工具调用总数决定。并行只是模型和中转站可能提供的行为，不是 Agent 必须保证的行为。

### zod 与工具边界

- 光看参数就能判断的约束放到 zod；
- 必须真正执行才能知道的错误放到 `execute`；
- `safeParse` 的失败是正常输入分支，不使用异常控制流；
- 工具错误以字符串返回给模型，不让单个工具错误击穿主循环。

### prompt 债

阶段 1 为正则解析写的 prompt 约束，在切换到 Function Calling 后可能变成隐形性能负担。每次架构升级后都要重新审计旧 prompt 规则，避免过期规则继续增加请求轮数和 token 消耗。

## 阶段 4 完成内容

### 三个工具的安全等级

| 工具 | 副作用 | 是否确认 | 主要边界 |
| --- | --- | --- | --- |
| `read_file` | 不改变磁盘，但会把内容放入上下文 | 否 | `execute` 限制项目目录并拦截敏感路径 |
| `write_file` | 新建或完整覆盖文件 | 是 | preview 展示后由用户确认 |
| `run_bash` | 能执行任意 shell 行为 | 是 | 不做伪白名单，人工检查完整命令 |

`read_file` 没有人工确认，所以必须自己在代码中守住边界。`run_bash` 可以绕过文件工具访问系统，因此不能把 `write_file` 的限制误认为整个系统的安全边界。

### `preview` 是 Tool 抽象的一部分

Tool 现在有两个描述通道：

- `description`：告诉模型工具什么时候该用；
- `preview`：告诉人具体会发生什么。

`agent.ts` 只检查 `needsApproval` 并调用通用的 `requestApproval`，不出现：

```ts
if (name === 'write_file') ...
else if (name === 'run_bash') ...
```

新增工具仍然只需要新建工具文件并在 `ALL_TOOLS` 注册。

### `prepareCall` / `executeCall`

旧的 `runTool` 已拆成两段：

- `prepareCall(name, rawArgs)`：查表、解析 JSON、Zod 校验；同步、无副作用；
- `executeCall(tool, args)`：参数校验通过且用户批准后才执行，把异常转成字符串。

这为人工确认插入了清晰的边界：

```text
prepare → preview / approval → execute
```

### 拒绝也必须回填 tool 消息

用户输入 `n` 后，程序不会跳过对应的 tool call，而是回填一条 `role: "tool"` 消息，并带上原始 `tool_call_id`。

否则 assistant 的 `tool_call` 没有匹配的 tool 消息，下一轮 API 请求会因 Function Calling 协议不完整而返回 400。

拒绝文本还明确要求模型：不要重试、不要换工具绕过，应向用户解释并询问下一步。

### `a` 按具体动作记忆

`a` 不再按工具名记忆，而是按：

```text
工具名 + JSON.stringify(完整参数)
```

因此：

```text
run_bash({ command: "pwd" })
```

被允许后，不会自动放行：

```text
run_bash({ command: "rm -rf src" })
```

批准缓存只存在本次进程内，重启后失效，不写入磁盘。

### Windows shell 配置

最初使用 `bash.exe` 时命中了：

```text
C:\Users\郭尚勇\AppData\Local\Microsoft\WindowsApps\bash.exe
```

这实际上是 WSL 启动入口，执行时找不到 `/bin/bash`。经过环境排查后，确认 Git 安装在 `D:\Git`，真实 Bash 路径为：

```text
D:\Git\bin\bash.exe
```

`run_bash` 已改用该路径，并通过 `pwd` 与不存在文件的 `ls` 实测验证。

### Ctrl+C

`readline/promises` 在 Ctrl+C 时会 reject `AbortError`。当前实现：

- 外层 `main` 将它转成“已取消，退出。”；
- 内层本轮错误处理会把 `AbortError` 继续抛出，避免把 Ctrl+C 当作普通 API 失败；
- `finally` 统一调用 `closeUI()`；
- 普通 `exit` / `quit` 仍输出“再见。”。

## 阶段 4 实测验收

### 类型检查

在 PowerShell 中运行：

```powershell
npx tsc --noEmit
```

结果：无输出，命令成功结束。

### 文件写入与拒绝

- 新建 `hello.txt`：出现 `write_file` preview，批准后实际写入“你好”；
- 第二次写入按 `n`：没有执行写入，拒绝消息成功回填，未发生 400；
- `write_file` preview 能区分“新建”和“覆盖”，覆盖时提示原内容将全部丢失。

### 敏感文件

请求读取 `.env` 时，模型遵守工具描述，没有发起读取。工具代码仍然保留 `.env`、`.git`、`node_modules`、私钥等运行时拦截；prompt 遵守不等于安全边界。

### Git Bash

```text
执行 pwd
```

批准后得到：

```text
stdout:
/f/project/mini-agent
```

```text
执行 ls definitely-not-exist.txt
```

返回：

```text
命令以非零状态退出(exit code 2)
```

模型正确解释为文件不存在，Agent 没有崩溃。

### 危险提示

对：

```bash
find src -type f -name '*.ts' -delete
```

确认框显示：

```text
⚠️  检测到危险模式:
   · 删除匹配到的文件
```

输入 `n` 后没有删除任何文件。

### 动作批准缓存

对 `pwd` 选择 `a` 后：

- 第二次完全相同的 `pwd` 跳过确认；
- 参数不同的 `ls` 仍然要求确认。

这证明批准粒度不是工具名，而是具体动作。

### 退出路径

以下三条路径均已验证：

1. 在确认提示处按 Ctrl+C：输出“已取消，退出。”，没有 `[本轮失败]`，也不会回到 REPL；
2. 在普通 `你>` 提示处按 Ctrl+C：输出“已取消，退出。”；
3. 输入 `exit`：输出“再见。”。

没有未捕获的 `AbortError` 堆栈。

## 当前已知限制

1. `run_bash` 依赖本机固定路径 `D:\Git\bin\bash.exe`，换机时需要调整配置；
2. 危险检测是正则提示，不是 shell 解析器，也不是沙箱；没有命中提示不代表安全；
3. `write_file` 没有限制目标必须位于项目目录内，批准前必须检查完整路径；
4. `read_file` 没有解析符号链接后的真实路径；
5. `read_file` 会把完整文件内容放进上下文，超长文件可能造成 token 压力；
6. `messages` 会跨 REPL 输入持续增长，尚未做历史裁剪；
7. 当前只有 `MAX_ITERATIONS`，尚未检测重复工具调用造成的死循环；
8. 当前没有自动化测试，阶段验收使用类型检查和手工实验；
9. 当前 `a` 使用 `JSON.stringify` 生成动作 key，尚未做通用的 canonical JSON 规范化；当前工具参数形状下已足够，但未来可加强。

第 5～7 项是阶段 5 的明确工作范围，不在阶段 4 补做。

## 阶段 5 入口

阶段 4 后 Agent 已经具备真实副作用，`messages` 也开始承载文件内容和工具结果。阶段 5 聚焦上下文工程：

1. 工具结果截断，并注明省略了什么；
2. 历史裁剪，始终保留 system 消息并保持 Function Calling 消息边界合法；
3. 在 `MAX_ITERATIONS` 之外增加连续重复调用检测；
4. 增加可观察的上下文统计，帮助理解 token 成本和 O(N²) 历史重发；
5. 为裁剪和护栏补上最小自动化测试。

阶段 5 的核心问题：

> Agent 能做事之后，如何控制它看到多少历史，如何避免上下文膨胀和无意义循环？

## 相关文档

- 阶段路线设计：`docs/superpowers/specs/2026-08-30-mini-agent-learning-path-design.md`
- 阶段 4 设计与验收：`docs/superpowers/specs/2026-09-02-stage4-side-effect-tools-design.md`
- 当前交接：`docs/HANDOFF.md`

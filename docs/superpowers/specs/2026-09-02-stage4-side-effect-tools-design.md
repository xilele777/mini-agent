# 阶段 4：副作用工具与执行前确认机制

日期：2026-09-02
状态：已实现并完成手工验收

## 1. 目标与范围

阶段 4 的目标不是单纯增加文件 IO，而是让 Agent 从“只能返回计算结果”变成“能够改变本地环境”，并为这些副作用建立人工闸门。

本阶段包含：

- 新增 `read_file`：读取项目目录内的文本文件；
- 新增 `write_file`：创建或完整覆盖文件；
- 新增 `run_bash`：通过 Git Bash 执行 shell 命令；
- 为有副作用的工具增加执行前确认；
- 增加面向人的动作预览 `preview`；
- 将入口改为多轮 REPL；
- 处理用户拒绝、命令失败和 Ctrl+C；
- 保持阶段 3 的 Tool 注册表约束：`agent.ts` 不依赖任何具体工具。

本阶段明确不做：

- shell 沙箱或完整命令解析器；
- 永久化的信任列表；
- 流式输出；
- 上下文裁剪和循环检测；
- 自动化测试框架建设。

上下文管理和循环护栏留到阶段 5。

## 2. 核心设计判断

### 2.1 工具的安全等级不相同

| 工具 | 是否有副作用 | 是否需要确认 | 代码边界 |
| --- | --- | --- | --- |
| `read_file` | 不改变磁盘 | 否 | `execute` 内限制项目目录并拦截敏感路径 |
| `write_file` | 创建或覆盖文件 | 是 | 由用户检查路径、覆盖后果和内容 |
| `run_bash` | 能执行任意 shell 行为 | 是 | 不做伪安全的命令白名单，由人工检查完整命令 |

`needsApproval` 不是所有工具都恒为 `true` 的总开关。`read_file` 不需要打断用户，但因此必须在代码中守住自己的读取边界。

### 2.2 `run_bash` 只做危险高亮，不做命令过滤

shell 的风险不只由首个命令名决定：

```bash
echo hi > file.txt
cat a.txt && rm b.txt
node -e "require('fs').rmSync('x')"
```

如果只允许某些命令名，仍然无法正确处理重定向、管道、命令串联、解释器参数和脚本执行。真正的白名单需要解析 shell 语法，范围会膨胀成另一个 shell 实现。

因此本阶段选择：

1. `run_bash` 每次执行前都必须人工确认；
2. `preview` 显示未截断的完整命令；
3. 对 `rm`、`del`、`rmdir`、`-delete`、重定向、提权、网络访问、危险 Git 操作等模式给出提醒；
4. 明确提醒“没有命中危险模式不等于安全”。

高亮是辅助审查，不是安全沙箱。

### 2.3 路径边界只由 `read_file` 强制执行

`read_file` 没有人工确认，直接把文件内容放进上下文，因此在 `execute` 内：

- 使用 `path.resolve()` 解析路径；
- 使用 `relative()` 判断解析结果是否仍在项目根目录内；
- 拒绝 `.env` 及其变体、`.git`、`node_modules`、`id_rsa`、`.pem` 和 `.key` 等路径。

`write_file` 和 `run_bash` 仍然需要用户确认。`run_bash` 可以绕过文件工具的路径限制，因此不能把 `write_file` 的目录限制误认为整个系统的安全边界。

当前实现没有解析符号链接后的真实路径，这是已知限制，后续如有需要再使用 `realpath` 设计更严格的边界。

### 2.4 工具自己描述动作，主循环不写具体工具分支

阶段 3 已经让工具自己携带 `schema` 和 `execute`。阶段 4 对同一个抽象增加第二个面向人的描述通道：

```ts
preview?: (args: A) => string
```

因此 `agent.ts` 不需要出现：

```ts
if (name === 'write_file') ...
else if (name === 'run_bash') ...
```

主循环只处理通用流程：

```text
prepareCall
→ 如果 needsApproval，则调用 preview 并请求人工决定
→ executeCall
→ 将字符串结果作为 tool 消息回填
```

新增工具仍然只需要新建工具文件并在注册表中增加一项。

### 2.5 “始终允许”按具体动作记忆

确认选项 `a` 不再按工具名记忆，而是按：

```text
工具名 + 完整参数
```

例如批准 `run_bash({ command: "pwd" })` 不会自动批准 `run_bash({ command: "rm -rf src" })`。

批准记录只保存在进程内存中，重启后失效，不写入磁盘。

## 3. 架构与数据流

```text
用户输入
  ↓
agent.ts 的 REPL
  ↓
messages + tools → LLM
  ↓
assistant tool_calls
  ↓
prepareCall
  ├─ 工具名查表
  ├─ JSON.parse
  └─ Zod safeParse
  ↓
needsApproval ? requestApproval(tool, args) : 直接继续
  ├─ tool.preview(args)
  ├─ 用户输入 y / n / a
  └─ n 也产生一个 tool observation
  ↓
executeCall(tool, args)
  ↓
role: "tool" + tool_call_id + 字符串结果
  ↓
再次请求 LLM，直到返回普通 assistant 消息
```

### 3.1 `prepareCall` 与 `executeCall` 的拆分

旧版 `runTool` 将参数准备和实际执行放在一起，确认机制无法插入两者之间。现在拆为：

- `prepareCall(name, rawArgs)`：查表、解析 JSON、校验 schema；纯同步、无副作用；
- `executeCall(tool, args)`：在参数已校验且用户已批准后执行，并把异常转成字符串。

返回结果使用可辨识联合：

```ts
{ ok: true, tool, args }
{ ok: false, error }
```

这样确认之前不会发生 IO，且主循环仍然不需要 `try/catch` 工具内部的每一个正常错误分支。

### 3.2 用户拒绝仍然必须回填 tool 消息

用户拒绝不是跳过消息，而是一次工具调用的结果。否则 assistant 消息中的 `tool_call_id` 没有对应的 `role: "tool"` 消息，下一轮请求会违反 Function Calling 协议并返回 400。

拒绝结果明确告诉模型：

- 用户拒绝了这次操作；
- 不要重试；
- 不要换工具绕过；
- 应向用户说明原计划并询问下一步。

## 4. 各模块职责

### `src/ui.ts`

提供全进程唯一、懒初始化的 `readline/promises` 实例：

- `ask(question)` 统一读取 REPL 输入和确认输入；
- `closeUI()` 统一关闭 stdin 相关资源；
- 避免两个 readline 实例争抢同一个 stdin。

### `src/approval.ts`

负责：

- 展示工具名和 `preview` 内容；
- 处理 `y`、`n`、`a`；
- 在本次进程内缓存完全相同动作的批准结果；
- 不负责执行工具。

### `src/tools/fs.ts`

包含两个工具：

- `read_file`：异步读取 UTF-8 文本，错误以字符串返回；
- `write_file`：自动创建父目录，完整覆盖写入，`preview` 显示新建/覆盖、字符数和前 20 行。

`write_file` 的预览优先展示后果：目标是否已存在、原内容是否会丢失，然后再展示内容片段。

### `src/tools/bash.ts`

使用 `child_process.exec` 和 `promisify`：

- 当前 Windows 环境使用 `D:\\Git\\bin\\bash.exe`；
- 单次命令最长 30 秒；
- 输出缓冲上限 1 MiB；
- 回填给模型的 stdout/stderr 各截断到 4000 字符；
- 命令本身在 preview 中不截断；
- 非零退出码被作为有用的观察结果返回，不会让 Agent 崩溃。

### `src/agent.ts`

负责：

- 跨用户输入保留 `messages`；
- 每次用户输入最多执行 10 轮模型调用；
- 对每个 tool call 运行准备、确认、执行和回填流程；
- 本轮中途异常时回滚本轮新增消息，避免残留不完整的 tool-call 历史；
- 将 Ctrl+C 的 `AbortError` 转为正常退出提示。

## 5. 具体工具的安全行为

### `read_file`

示例边界：

```text
允许：src/agent.ts
拒绝：../other-project/file.txt
拒绝：.env
拒绝：.git/config
拒绝：node_modules/...
拒绝：id_rsa、*.pem、*.key
```

### `write_file`

这是完整覆盖，不是追加：

```text
旧文件存在 → preview 明确提示“原有内容将全部丢失”
旧文件不存在 → preview 显示“新建文件”
```

该工具必须在执行前取得 `y` 或 `a`。

### `run_bash`

确认框始终显示完整命令。例如：

```text
$ find src -type f -name '*.ts' -delete

⚠️  检测到危险模式:
   · 删除匹配到的文件
```

`-delete` 是后续补充的危险规则，避免 `find` 删除操作只显示命令而没有辅助提示。

## 6. 验收与实测结果

### 6.1 类型检查

由学习者在项目目录运行：

```powershell
npx tsc --noEmit
```

结果：无输出，命令正常结束。

### 6.2 写文件并批准

输入：

```text
在当前目录建一个 hello.txt，写上「你好」
```

结果：

- 出现 `write_file` 确认框；
- 显示新建路径和内容；
- 输入 `y` 后实际生成 `hello.txt`；
- Agent 返回成功总结。

### 6.3 写文件并拒绝

输入相同类型的第二个写入请求并输入 `n`：

- 没有创建目标文件；
- 拒绝消息被回填给模型；
- 模型没有因协议错误退出，也没有自动换工具执行。

### 6.4 Git Bash 执行成功

输入：

```text
执行 pwd
```

批准后返回：

```text
stdout:
/f/project/mini-agent
```

这验证了 Windows 当前实际可用的 Git Bash 路径是：

```text
D:\Git\bin\bash.exe
```

此前使用 `WindowsApps\\bash.exe` 时实际落入 WSL 启动入口，因找不到 `/bin/bash` 而失败；改用 Git Bash 真实路径后问题消失。

### 6.5 Git Bash 非零退出

输入：

```text
执行 ls definitely-not-exist.txt
```

结果返回：

```text
命令以非零状态退出(exit code 2)
```

模型正确解释为文件不存在，Agent 没有崩溃。

### 6.6 危险命令拒绝

输入删除 `src` 下 TypeScript 文件的请求：

```bash
find src -type f -name '*.ts' -delete
```

确认框显示：

```text
· 删除匹配到的文件
```

输入 `n` 后没有删除文件。

### 6.7 具体动作批准缓存

输入 `pwd` 并选择 `a` 后：

- 第二次完全相同的 `pwd` 跳过确认；
- 参数不同的 `ls` 仍然出现确认框；
- 证明缓存 key 已从工具名收窄为工具名加完整参数。

### 6.8 Ctrl+C 和正常退出

在 `你>` 提示处按 Ctrl+C：

```text
已取消，退出。
```

没有未捕获的 `AbortError` 堆栈。

输入 `exit`：

```text
再见。
```

两种退出路径都能正常关闭 readline。

## 7. 已知限制

1. `run_bash` 当前依赖本机固定路径 `D:\\Git\\bin\\bash.exe`，换机时需要调整配置；
2. 危险模式检测是正则提示，不是 shell 解析器，也不是沙箱；未命中提示不代表安全；
3. `write_file` 没有限制目标必须位于项目目录内，批准前必须检查完整路径；
4. `read_file` 当前没有解析符号链接后的真实路径；
5. `read_file` 目前会把完整文件内容放进上下文，超长文件可能导致 token 压力；
6. `messages` 会跨轮持续增长，尚未做历史裁剪；
7. 只设置了 `maxIterations`，尚未检测重复工具调用造成的死循环；
8. 当前没有自动化测试，阶段验收使用类型检查和手工实验。

第 5、6、7 项是阶段 5 的明确工作范围，不在本阶段补做。

## 8. 阶段 5 的入口

阶段 4 完成后，Agent 已经具备真实副作用，`messages` 也开始承载更长的文件内容和工具结果。下一阶段聚焦上下文工程：

1. 工具结果截断，并注明省略信息；
2. 历史裁剪，保留 system 消息和合法的消息边界；
3. `maxIterations` 之外增加重复调用检测；
4. 设计可观察的上下文统计，帮助理解 token 成本。

阶段 5 的核心问题是：

> Agent 能做事之后，如何控制它看到多少历史、如何避免上下文膨胀和无意义循环？

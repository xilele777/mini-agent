# v1 评测与交付验收

本文件是内部学习与评测记录，保留确定性回归、安装检查和人工样本的来源；不进入产品 README 或发行包。用户已授权按自动检查完成开源发布，未观察的人工样本不因此标为通过。历史运行不构成当前模型成功率。

发布收尾补充（2026-09-22）：1.1.0 的 `npm run verify` 已实际通过，发行包移除本记录后为 42 个白名单文件；186 项核心测试、26 项看板测试、30 篇笔记及干净安装全部通过。下文 43 文件结果是调整分发范围前的历史记录。远程结果以对应提交的 GitHub Actions 与 Release 为准。

## 一键检查

```bash
npm ci
npm run verify
```

`verify` 顺序执行类型检查、核心测试、笔记校验、看板测试、固定任务自检及干净安装验收，任一失败即停止。测试不请求真实模型。`test:delivery` 会在系统临时目录重新 `npm ci`、编译、打包，并在另一目录只安装生产依赖；需要访问 npm 包源。它检查包文件白名单、真实 npm 可执行入口、帮助／参数错误码、离线 doctor、新建会话、EOF 退出及恢复。只清理本次创建并核验路径的临时目录；本机需可用 Git Bash（或 POSIX sh）。可用 `MINI_AGENT_SHELL` 指定检查使用的 Git Bash 路径。

交付安装检查不会读取本机 `.env`；部分源码 shell 测试会加载它，但不发起模型请求。Windows 若 Git 不在 `C:/Program Files/Git`，先在 PowerShell 设置 `$env:MINI_AGENT_SHELL='D:/Git/bin/bash.exe'`（换成实际位置）再运行检查，结束后可 `Remove-Item Env:MINI_AGENT_SHELL`。这也使 shell 进程树测试实际运行而非因找不到 shell 跳过。

## 证据矩阵

| 范围 | 确定性证据入口 | 已有真实模型／人工证据 | 边界 |
| --- | --- | --- | --- |
| 流与主循环 | `stream.test.ts`、`turn.test.ts`、`turn-lifecycle.test.ts` | 阶段 8 真实多工具、usage、完成和拒绝后暂停 | 不保证任意措辞下模型正确选工具 |
| 配置与诊断 | `config.test.ts`、`runtime.test.ts` | 阶段 10 在线 doctor、计算 391 与只读委派 | 兼容服务需在目标环境重验 |
| 会话与恢复 | `session-storage.test.ts`、`session.test.ts`、`session-runner.test.ts` | 阶段 11 跨进程 todo；阶段 13 取消后恢复 | 故障窗口由受控子进程覆盖，非断电保证 |
| 上下文与摘要 | `context-budget.test.ts`、`context-wiring.test.ts`、`compaction.test.ts` | 阶段 12 gpt-6-astra 四次请求，重开后增量摘要保留 ORBIT-27 与只读约束 | 是受控样本，无任意长文准确率结论 |
| 文件编辑与 shell | `tools/edit.test.ts`、`command.test.ts`、`test:fixture` | 阶段 13 固定任务修复、拒绝、冲突拒写、取消；超时与恢复为用户简短确认 | 模型曾对正确代码提出等价改写；保留为行为问题 |
| 取消、重试、预算、轨迹 | `run-control.test.ts`，可单跑 `test:resilience` | 阶段 14 的真实模型与 Ctrl+C 验收待用户执行 | 自动注入故障不等于真实服务发生故障 |
| CLI 与安装 | `cli.test.ts`、`test:delivery` | 阶段 15 人工验收见下文 | Windows 本地结果与远程 Linux CI 分开记录 |

上述测试文件均位于 `src/`；历史证据详情见 [学习进度](progress.md)。历史中未记录的 token、耗时和干预次数保持未知，不追补猜测数据。

2026-09-22 本轮实际结果（Windows、Node 24.14.0）：类型检查、编译、186 项核心测试（零失败／跳过）、26 项看板测试、30 篇决策笔记及链接检查、固定任务三场景自检均通过。新增七项 CLI 回归与一项在线诊断取消测试。干净源码 npm ci、43 文件白名单打包、仅生产依赖安装、真实 npm shim、离线 doctor、新建及恢复会话均通过。首次交付检查因默认 C 盘 Git Bash 路径不存在失败，指定本机实际 D 盘路径后通过，保留这个环境配置发现。

远程 GitHub Actions、Linux/macOS 实机及本轮真实模型尚未执行；CI 定义覆盖 Windows／Ubuntu、Node 22。上述独立命令已实际运行；`npm run verify` 是这些命令的串行入口，不将本地 Node 24 结果写成 Node 22 实机通过。

## 阶段 15 人工验收（PowerShell）

1. **交付入口与错误码**：在仓库根目录执行：

   ```powershell
   npm run build
   node bin/mini-agent.mjs --help
   node bin/mini-agent.mjs --version
   node bin/mini-agent.mjs --bad-option
   $LASTEXITCODE
   ```

   应显示帮助、与 package.json 一致的版本；最后一条错误命令应退出 **2**。版本应与当前 package.json 一致。

2. **目标机器诊断**：没有 `.env` 时从 `.env.example` 复制并填写；已有 `.env` 保留。Windows 配置实际 Git Bash 绝对路径。执行：

   ```powershell
   node bin/mini-agent.mjs --doctor
   node bin/mini-agent.mjs --doctor --online
   ```

   离线显示 shell OK、模型 SKIP；在线显示流式工具调用通过，退出 **0**。在线探针会请求模型，可能计费。

3. **运行、轨迹与恢复**：执行 `npm start`，输入“计算 17×23，然后完成”；应得到 **391**、`completed` 和请求／token／耗时汇总。记下 UUID，输入 `exit`，再执行：

   ```powershell
   node bin/mini-agent.mjs --sessions
   node bin/mini-agent.mjs --resume <替换为UUID>
   ```

   应恢复原会话并等待新输入，不自动重复计算。在 `你>` 等待时按 Ctrl+C，`$LASTEXITCODE` 应为 **130**；再次恢复应可打开，证明锁已释放。检查 `.mini-agent/sessions/<UUID>/trace.jsonl` 的 `turn_end`，核对请求数、tokens、耗时，且没有对话正文。快照保存完整对话，不是脱敏文件。

4. **固定任务闭环**：执行 `npm run fixture:new`，按输出目录输入 下文的[正常修复任务](#阶段-13-人工验收)。人工批准文件 diff 与验收命令后，独立执行输出的 `npm run fixture:check -- "任务目录"`。必须得到 `passed: true`、`unexpected: []`、三项业务测试通过。不能只凭模型说“完成”。

5. **补齐阶段 14**：依照 [下文六项验收](#阶段-14-人工验收)检查委派总账、批准中取消、请求／token／时间耗尽及轨迹。不必制造真实服务故障来重测有限重试，它已有确定性故障注入。Windows 以本机为主；Linux 支持结论等对应 CI 或实机结果后再填写。

若想验证 tarball 的可安装性，运行 `npm run test:delivery`；它已实际走安装流程，无需改动你的全局 npm。手动安装步骤见 [README](../../README.md#安装)。

## 真实模型评测记录

本次人工验收预先规定：正常计算、只读委派、固定缺陷修复各跑 **1 次**；不同安全场景各跑 1 次，不混算任务成功率。每次修复先创建新副本。首次失败保留记录，后续尝试另起一行，不用重跑成功覆盖失败。本小样本只用于交付验收，不做模型排名或统计可靠性声明。

| 日期／模型／配置差异 | 场景与会话 UUID／turnId | 文件／测试判定 | 错误修改 | 请求数 | 实际 tokens／估算请求数 | 耗时 ms | 人工批准／拒绝／纠正次数 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待人工填写 | 计算 391 | 输出正确且 completed | 不适用 | — | — | — | — | 待验收 |
| 待人工填写 | 只读委派调查 package.json | 返回实际 scripts，不写文件 | — | — | — | — | — | 待验收 |
| 待人工填写 | 固定运费边界修复 | fixture:check 独立判定 | — | — | — | — | — | 待验收 |

从 `turn_end` 读取 `requests`、`actualTokens`、`estimatedRequests`、`elapsedMs`；`chargedTokens` 包含未知 usage 的预留估算，不能标成供应商实际用量。批准／拒绝可查轨迹，额外纠正模型的次数由验收者记录；缺字段记未知。阶段 13 已知的不必要等价修改保留在历史证据中。

## 数据与支持范围

配置从运行目录 `.env` 读取；会话及轨迹保存在同目录 `.mini-agent/sessions/<UUID>/`。退出相关进程后，可备份或手动删除某个 UUID 目录以清理该会话；删除不可恢复，不提供自动清空命令。锁文件残留时先确认原进程已退出，再按 README 的恢复说明处理。

Windows 使用 Git Bash；Linux/macOS 可配置绝对路径的 sh/bash，不支持把 PowerShell/cmd 当作 `run_bash`。文件工具有项目边界，shell 依赖批准而非沙箱。进程树清理、磁盘原子替换和模型摘要均有 README 已说明的限制。


## 阶段 13 人工验收

1. **正常修复**：运行 `npm run fixture:new`，记下输出的任务目录，再运行 `npm run dev`。输入：“修复 `<任务目录>` 的运费边界，只修改其中 src/shipping.ts。先读取，用 edit_file 精确修改，展示 diff 并等我批准；再通过 run_bash 执行输出中的 fixture:check 命令。”批准应显示 `subtotal > 100` → `subtotal >= 100`；批准测试命令后，独立验收应返回 `passed: true`、`unexpected: []` 和三项测试通过。
2. **拒绝**：另建一个副本，重复修复请求并补充“如果我拒绝就暂停”。在文件批准处输入 `n`；目标文件应保持 `> 100`，不应通过 shell 绕过写入。
3. **外部冲突**：另建副本，请求修复并补充“如遇文件冲突立即暂停，不重新申请写入”。等 diff 出现后，在编辑器给目标文件增加一行注释并保存，再输入 `y`。应提示冲突拒写，保留注释和原来的 `> 100`。
4. **命令取消**：请求“通过 run_bash 执行 `sleep 20`，之后再计算 1+1”。批准后按 Ctrl+C；应显示取消与清理状态，本轮 cancelled，后续计算不执行。重新 `--resume` 该会话应提示不确定动作，并等待新指令而不重放。
5. **超时**（PowerShell）：启动前设置 `$env:MINI_AGENT_COMMAND_TIMEOUT_MS='1000'`，请求并批准 `sleep 5`；应约一秒触发超时、显示清理状态并将本轮标为 failed。退出后 `Remove-Item Env:MINI_AGENT_COMMAND_TIMEOUT_MS` 恢复默认环境。

`npm test` 还覆盖零／多匹配、同名文件冲突、链接路径、输出超限和真实子孙进程心跳停止。真实模型措辞与人工操作以上述可观察文件和状态为准；Windows Git Bash 已在本机运行，Linux 分支须由对应环境或 CI 验证。

## 阶段 14 人工验收

自动故障注入可先运行 `npm run test:resilience`，不需要 API key，覆盖网络重试、流中断、共享预算、取消和脱敏。下面检查真实模型与本机交互；每次启动记录终端显示的会话 UUID。

1. **正常任务与委派**：`npm run dev`，输入“计算 17×23，然后完成”；应得到 391、completed 和 `[run]` 请求／工具／token／耗时汇总。下一轮输入“通过 delegate_task 只读调查 package.json 的 npm scripts，返回后结束”。应出现 subagent 请求，轮末总次数包含子请求。
2. **批准中取消**：请求“执行 run_bash 的 `echo stage14-check`，之后再计算 1+1”。在批准框按 Ctrl+C；命令和后续计算不得执行，本轮 cancelled。恢复同一会话应等待新输入，动作标为 not_executed。再分别在 `你>` 输入等待、模型响应等待或明确请求 `ask_user` 后按 Ctrl+C，均应退出而不触发后续动作。
3. **总次数耗尽**：PowerShell 设置 `$env:MINI_AGENT_MAX_REQUESTS='1'` 后启动；输入“必须先调用 delegate_task 调查 package.json，再总结”。若模型按要求委派，子请求不得发出，总请求数为 1，本轮 budget_exhausted。退出后执行 `Remove-Item Env:MINI_AGENT_MAX_REQUESTS`。
4. **批准等待计入总时限**：设置 `$env:MINI_AGENT_TURN_TIMEOUT_MS='30000'` 后启动，请求执行 `echo stage14-check`。批准框出现后保持不输入，直到自提交输入起 30 秒到期，应 budget_exhausted，命令不执行；若模型本身响应超过 30 秒，则应先在模型等待阶段停止。退出后执行 `Remove-Item Env:MINI_AGENT_TURN_TIMEOUT_MS`。
5. **token 发送前拦截**：设置 `$env:MINI_AGENT_MAX_TOTAL_TOKENS='1'` 后启动并输入任意任务；应显示 budget_exhausted、请求 0，未访问模型。退出后执行 `Remove-Item Env:MINI_AGENT_MAX_TOTAL_TOKENS`。
6. **检查轨迹**：打开 `.mini-agent/sessions/<UUID>/trace.jsonl`，核对相同 turnId 内的 request_start 数与 turn_end.requests 一致，委派含 taskId，摘要 scope 为 summary；request_end.accounting 缺 usage 时为 estimated。文件不应含用户正文、模型正文、密钥、命令参数、文件正文或异常原文。恢复会话、提交新任务应追加新 turnId，次数从头计算。

每轮轨迹只保存白名单元数据，工具状态按本轮 action 编号关联；扩展工具名记为 other。轨迹写失败只警告一次，会话快照仍独立保存。**snapshot.json 保存完整原始对话，不属于脱敏轨迹**；终端显示的模型正文和批准预览也保留任务内容。轨迹不作为恢复来源，取消不撤销副作用；总截止后的命令树清理和可靠保存可能需要额外时间。

# Agent Note: 区分命令失败、输出超限和中断后的部分副作用

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

shell 可能在返回非零状态、超时或输出超限之前已经修改文件。若把缓冲超限当作普通退出码或正常完成，模型可能错误判断结果并继续执行依赖步骤。

## Decision

run_bash 使用批准后的完整命令，工作目录固定为项目 ROOT，shell 和超时由启动配置注入（默认 30 秒）。spawn 通过 POSIX shell 的 -c 执行，stdin 关闭，stdout/stderr 各自最多缓冲 1 MiB，展示每个流的前 4000 字符。

普通退出返回数字退出码和两路输出，包括非零状态。超时、取消、缓冲超限及信号中断抛出带已捕获输出和清理状态的错误，主轮记录 uncertain、补齐同批后续调用为 not_executed 并停止。取消错误名为 AbortError，轮结果为 cancelled；其余中断为 failed。开始前已取消不启动子进程。

POSIX 使用独立进程组并发送 SIGKILL；Windows Git Bash 使用 taskkill /PID /T /F，等待清理命令返回后再结算结果，清理失败尝试直接子进程终止。等待子进程关闭另有五秒退路，不无限挂起。清理消息只说明实际操作与返回状态，不宣称已经确认任意脱离进程树的后代退出。

CLI 的 AbortController 经主轮传入批准和工具，SIGINT/readline Ctrl+C 触发同一信号，取消后保存结果并关闭会话。模型适配器、摘要请求包装、只读委派和 ask_user 同时传递该信号；阶段 14 仍负责更完整的取消组合验证和统一账目。

危险正则仅用于批准预览的提醒，不解析或过滤 shell；这是[具体动作批准](../feature/2026-09-02-action-approval-scope.md)的辅助，而非命令白名单。结果之后还会经过[公共上下文截断](../architecture/2026-09-05-bounded-conversation-context.md)。

## Alternatives considered

- 继续使用 exec timeout 并只终止直接 shell：接线简单，但不能覆盖仍在运行的子孙进程；spawn 配合系统进程树／进程组终止更容易验证。
- 无限缓冲输出：最易保留全部信息，但大输出会扩大进程内存与模型上下文。
- 按命令名称做白名单：规则直观，但重定向、管道、解释器和脚本能组合出其他效果，当前范围不实现完整 shell 解析。

## Consequences

模型能区分多类结果并看到部分输出，代价是输出可能不完整、进程终止也不保证撤销副作用或终止所有后代进程。

支持范围是 Windows Git Bash 与 POSIX sh/bash；不支持后台 daemon、脱离父子关系／进程组的进程或任意 shell 方言。Windows 强制终止不能提供应用级优雅收尾；清理不撤销已发生的文件或网络副作用。普通命令退出也不证明它启动的独立后台服务已经退出。

## Verification

日期依据：[ad92001](https://github.com/xilele777/mini-agent/commit/ad92001) 于 2026-09-06 单独处理缓冲错误；基础 shell 工具来自 2026-09-02。当前依据：[bash.ts](../../../../src/tools/bash.ts)。已有记录包含 pwd、文件不存在和拒绝执行；没有缓冲超限、超时或完整进程树清理的自动化运行证据。

上述末句描述阶段 13 之前的范围。2026-09-21 的 [command.test.ts](../../../../src/command.test.ts)在本机实际 Git Bash 验证 stdout/stderr、非零退出、超限、启动失败、预取消、超时／取消清理 Node 父子进程，并核对心跳停止及 PID 退出；主轮取消记录 uncertain 且不执行后续工具。Linux 分支和远程 CI 尚未在本轮运行，不能从 Windows 结果推断通过。

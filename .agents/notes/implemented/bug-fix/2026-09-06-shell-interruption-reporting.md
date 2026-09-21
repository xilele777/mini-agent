# Agent Note: 区分命令失败、输出超限和中断后的部分副作用

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

shell 可能在返回非零状态、超时或输出超限之前已经修改文件。若把缓冲超限当作普通退出码或正常完成，模型可能错误判断结果并继续执行依赖步骤。

## Decision

run_bash 使用批准后的完整命令，设定 30 秒超时和 stdout/stderr 各自 1 MiB 的缓冲上限。输出展示另截取每个流的前 4000 字符，并附带原始长度。

ERR_CHILD_PROCESS_STDIO_MAXBUFFER 先于数字退出码分支识别，返回中断说明、已捕获输出以及可能已有部分副作用的提示。普通非零退出尽量保留退出码与两路输出。

危险正则仅用于批准预览的提醒，不解析或过滤 shell；这是[具体动作批准](../feature/2026-09-02-action-approval-scope.md)的辅助，而非命令白名单。结果之后还会经过[公共上下文截断](../architecture/2026-09-05-bounded-conversation-context.md)。

## Alternatives considered

- 只根据退出码报告失败：能覆盖常见命令，但缓冲超限使用字符串错误码，无法准确表达中断。
- 无限缓冲输出：最易保留全部信息，但大输出会扩大进程内存与模型上下文。
- 按命令名称做白名单：规则直观，但重定向、管道、解释器和脚本能组合出其他效果，当前范围不实现完整 shell 解析。

## Consequences

模型能区分多类结果并看到部分输出，代价是输出可能不完整、进程终止也不保证撤销副作用或终止所有后代进程。

当前超时分支依据 killed 报告并未附带已捕获输出；缓冲超限说明中的“已超时”标签也不构成实际超时证据。shell 路径与命令超时由启动配置注入 `createBashTool()`，Windows 需显式配置 Git Bash，换机仍须通过 doctor 核对。

## Verification

日期依据：[ad92001](https://github.com/xilele777/mini-agent/commit/ad92001) 于 2026-09-06 单独处理缓冲错误；基础 shell 工具来自 2026-09-02。当前依据：[bash.ts](../../../../src/tools/bash.ts)。已有记录包含 pwd、文件不存在和拒绝执行；没有缓冲超限、超时或完整进程树清理的自动化运行证据。

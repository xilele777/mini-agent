# Agent Note: 批准按具体动作记忆，权限范围限于当前进程

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

允许某工具的一次操作，不足以允许它未来的任意参数。任意路径写入和 shell 可以影响用户文件，过宽或长期缓存会扩大一次有限批准的范围。

## Decision

批准缓存键由工具名、分隔符和校验后完整参数的 JSON 字符串组成。y 只允许本次，n 拒绝本次，a 在当前进程内记住相同键，重启后失效。

主循环依据 Tool.needsApproval 进入批准流程，先经[注册表](../architecture/2026-08-31-tool-registry-boundary.md)准备参数，再通过[共享终端](../architecture/2026-09-02-shared-terminal-input.md)取得决定，最后执行。拒绝也要回填调用结果，并告知模型不重试、不换工具绕过。

批准看操作范围，不单看是否写盘：任意文件和 shell 需批准，路径固定且只维护自身草稿的 todo 不要求每次询问。

## Alternatives considered

- 按工具名记住允许：交互少，但允许 pwd 会连带覆盖其他 shell 命令。
- 完全不缓存：权限语义直接，但重复相同动作会增加人工操作；当前采用有限的会话内复用。
- 将批准写入磁盘：重启后方便，但项目环境和任务意图可能变化，旧批准不能证明新情境下仍合适。

## Consequences

用户可检查具体动作，代价是不同 JSON 属性顺序仍可能触发重复确认。即使参数相同，外部文件变化也可能改变操作结果，缓存不是效果保证。

预览能力存在差异：shell 显示完整命令，write_file 当前只预览前 20 行；不能笼统宣称所有写入内容都被完整展示。拒绝后的停止要求也不是程序强制的跨轮黑名单。

## Verification

日期依据：[f8e6831](https://github.com/xilele777/mini-agent/commit/f8e6831) 于 2026-09-02 引入批准。当前依据：[approval.ts](../../../../src/approval.ts)、[fs.ts](../../../../src/tools/fs.ts)、[bash.ts](../../../../src/tools/bash.ts)。验证需覆盖相同动作缓存、参数变化、重启与拒绝回填；现有自动化测试不替代这些交互用例。

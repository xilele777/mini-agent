# Agent Note: 用 startsTurn 区分真实用户轮与内部继续提示

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

继续提示与真实用户输入都使用 user 角色。按角色计轮时，一次请求里的多条内部提示会被算作多轮，可能把原始目标和约束提前裁掉。

## Decision

本地 HistoryMessage 使用 startsTurn 标记真实轮的开始，只有 REPL 新输入设置它。内部提示、assistant 回复和 tool 结果不产生新轮；ask_user 的回答仍属于发起询问的当前轮。

trimHistory 按标记选择完整轮次。发送请求时，toModelMessages 产生去除本地标记的数组，但不修改本地历史，避免下一次裁剪丢失边界。

本决定细化[整轮上下文裁剪](2026-09-05-bounded-conversation-context.md)。轮边界与[调用结果配对](../bug-fix/2026-09-06-tool-result-history-recovery.md)是相关但不同的约束：误计轮首先会丢目标，不应直接宣称必然导致协议 400。

## Alternatives considered

- 继续按 user 角色计数：无需新字段，但无法区分外部目标和程序内部提示。
- 只增加保留轮数：能延后问题，但轮次仍算错，长一点的内部循环还会触发。
- 把内部提示换成另一种角色：可能改变模型对提示的解释，且仍把本地会话边界绑定到 API 角色；本地标记能直接表达目的。

## Consequences

真实轮数不依赖协议角色，代价是所有新输入入口必须维护标记，旧的无标记历史不会自动修复。标记仅服务本地管理，不随请求传给模型。

这一改动解决轮次识别，不提供 token 硬上限、跨进程会话恢复或全部异常历史修复。

## Verification

日期依据：[cd3fa0c](https://github.com/xilele777/mini-agent/commit/cd3fa0c) 于 2026-09-11 接入并验证。当前依据：[context.ts](../../../../src/context.ts)、[agent.ts](../../../../src/agent.ts)、[turn.ts](../../../../src/turn.ts) 和 [turn.test.ts](../../../../src/turn.test.ts)。上下文测试覆盖整轮裁剪和 API 消息去标记；主轮测试确认持续纯文本追加的内部提示不产生新的 `startsTurn`。

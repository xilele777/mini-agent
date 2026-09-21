# Agent Note: 把任务完成、暂停和执行中提问表达为显式出口

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

无工具调用的文本可能是阶段说明、最终答复或等待用户。无条件继续会在拒绝后反复催促，直接停止又可能让多步任务停在列计划；todo 是否为空也不能说明当前请求是否完成。

## Decision

finish_task 表示当前请求完成，pause_task 表示未完成但需要暂停；二者通过通用 endsTurn 结束本轮。ask_user 在当前轮等待用户回答，并把回答作为工具结果返回。

纯文本回复之后的 CONTINUE_NUDGE 提供执行、完成、询问和暂停四种去向。当前请求决定任务范围，历史待办仅保存计划；“只记录一条待办”在记录后即可完成，暂停或被拒绝的旧任务需要明确恢复。

控制工具沿用[注册表](../architecture/2026-08-31-tool-registry-boundary.md)与[共享输入](../architecture/2026-09-02-shared-terminal-input.md)。退出前仍按[历史恢复规则](../bug-fix/2026-09-06-tool-result-history-recovery.md)补齐同批未执行调用。

## Alternatives considered

- 纯文本后直接返回：节省继续请求，但无法区分阶段说明与实际完成。
- 清空 todo 才结束：规则直观，但会把“只记录”当作未完成，并可能触发旧任务。
- 一律用 finish_task 停止：工具更少，但必要操作被拒绝时，会把暂停错误表述为完成。

## Consequences

出口语义清楚，代价是可能增加模型请求，模型仍可能选错；十次请求上限由[循环预算](2026-09-05-loop-guard-and-request-budget.md)兜底。

[todo](../architecture/2026-09-06-todo-json-persistence.md) 没有任务归属或持久化暂停字段，pause_task 原因只保留在对话中。因此当前语义约束不等于程序层面的任务隔离。

## Verification

日期依据：[cd3fa0c](https://github.com/xilele777/mini-agent/commit/cd3fa0c) 于 2026-09-11 落地。当前依据：[control.ts](../../../../src/tools/control.ts)、[turn.ts](../../../../src/turn.ts) 和 [turn.test.ts](../../../../src/turn.test.ts)。[学习进度](../../../learning/progress.md) 保留只记录待办、询问中拒绝、批准框拒绝及 nudge 后完成的具体记录；主轮测试另覆盖结束工具后同批调用的配对，其范围仍不能推广到所有模型行为。

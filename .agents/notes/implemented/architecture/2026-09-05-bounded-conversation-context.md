# Agent Note: 用结果截断与整轮裁剪控制发送给模型的历史

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

工具输出和跨轮消息会持续积累。如果每次都发送全部内容，成本与上下文压力不断增加；随意切掉若干消息又可能丢失当前目标或拆开调用与结果。

## Decision

工具结果超过 4000 字符时，公共上下文层保留开头 3000 和结尾 1000 字符，并明确指出中间省略。历史在加入新用户输入前裁剪，保留 system 和最近六个已结束的完整用户轮。

真实轮次由[startsTurn 标记](2026-09-11-user-turn-boundaries.md)确定，不能靠消息数量或角色猜测。单次返回不完整时，模型应使用[定位和分页工具](../feature/2026-09-05-bounded-file-retrieval.md)继续取证。

每次模型响应有 usage 时打印 prompt、completion 和 total，供观察请求规模；工具调用结构遵循[原生协议](2026-08-31-native-function-calling.md)。

## Alternatives considered

- 完整保留全部消息：信息最充分，但无法控制长会话的上下文增长。
- 按固定条数切消息：实现简单，但可能保留孤立的 tool 结果或截掉用户目标。
- 立即引入模型摘要和长期记忆：能保留更多跨轮信息，但会增加额外请求、摘要失真与维护逻辑，当前先使用可检查的固定策略。

## Consequences

上下文策略集中在一处，代价是省略内容和早期轮次不可由模型凭记忆恢复。附加截断说明会让结果略超过 4000 字符，六轮也不等于 token 硬上限。

shell 工具自身还有输出截断，公共层看到的结果可能已丢失一部分内容。usage 日志是观察值，不能单凭单次回落证明所有任务的费用已封顶。

## Verification

日期依据：[7b29af1](https://github.com/xilele777/mini-agent/commit/7b29af1) 于 2026-09-05 引入上下文管理。当前依据：[context.ts](../../../../src/context.ts)、[context.test.ts](../../../../src/context.test.ts)、[agent.ts](../../../../src/agent.ts)。测试覆盖头尾截断及整轮保留，无法证明任意输入均不超服务端上下文限额。

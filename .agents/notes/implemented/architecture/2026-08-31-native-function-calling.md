# Agent Note: 用原生 Function Calling 承载动作协议

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

模型的自然语言回复可能夹带解释、改变格式或同时提出多个动作。把 Action 和参数藏在普通文本中，会让业务执行依赖文本正则是否恰好匹配。

## Decision

当前循环从响应的 tool_calls 读取函数名、参数字符串和调用 ID，并通过 tools 提供参数说明。assistant 响应先加入历史，每个调用随后获得带匹配 tool_call_id 的 tool 结果，再进入下一次请求。

服务端返回结构不替代本地校验：参数仍需 JSON.parse 和 Zod 校验，未知工具也必须反馈错误。[工具注册表](2026-08-31-tool-registry-boundary.md)维护具体定义；调用失败或提前停止的配对要求由[历史恢复规则](../bug-fix/2026-09-06-tool-result-history-recovery.md)落实。

## Alternatives considered

- 继续解析 Thought/Action 文本：能直观看到手写协议的工作过程，适合作为初始练习，但格式漂移会影响实际工具调用。
- 相信原生参数无需校验：减少本地代码，但兼容服务、模型输出和工具业务约束仍可能不一致，非法参数不能直接进入执行。
- 只把执行结果作为普通 assistant 文本追加：消息结构简单，但失去调用 ID 对应关系，不能满足当前工具调用协议。

## Consequences

动作协议与普通讲解分开，程序可以处理同一响应中的多个调用。代价是必须维护完整消息配对，并处理不支持的调用类型。

当前工具调用按 for 循环逐个执行。同一响应提出多个动作，不等于程序已实现并行执行或事务。

## Verification

日期依据：[8f4f148](https://github.com/xilele777/mini-agent/commit/8f4f148) 于 2026-08-31 接入 tool_calls。当前实现见 [agent.ts](../../../../src/agent.ts) 与 [tools/index.ts](../../../../src/tools/index.ts)。本次依据代码和 Git 记录整理，不新增真实模型运行证据。

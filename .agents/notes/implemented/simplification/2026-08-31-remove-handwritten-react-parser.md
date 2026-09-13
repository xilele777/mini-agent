# Agent Note: 删除手写 ReAct 解析器，实验保留在 Git 历史

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

手写 Action 解析器完成了初始教学目标后，当前入口使用另一套调用协议。继续保留无人引用的协议文件，会让接手者误以为仍需维护两套有效机制。

## Decision

当前源码只保留正在使用的原生工具调用路径。阶段 1 的 protocol.ts、parse 和 ParseResult 从工作树删除，早期实验可以通过 Git 取回。

工具使用说明放在各工具 description 中；system prompt 承担工作目录、批准语义和本轮目标等跨工具要求。这个取舍依赖[原生 Function Calling](../architecture/2026-08-31-native-function-calling.md)和[注册表](../architecture/2026-08-31-tool-registry-boundary.md)已经成为当前执行路径。

## Alternatives considered

- 原样保留旧文件作参考：离线阅读方便，但无人调用的实现容易被误当成当前约束。
- 同时维护文本协议与原生协议：能兼容没有工具调用能力的模型，但会增加测试和行为分歧，当前没有这一支持目标。
- 在 system prompt 中重复所有工具纪律：集中可见，但会形成两份需同步的说明；跨工具约束仍有必要保留。

## Consequences

运行时协议与当前代码保持一致，代价是阅读阶段 1 需要访问 Git 历史。此次删除不能推广成“所有演示文件都应删除”：index.ts 仍是可独立运行的 API 演示。

若未来确实需要文本协议兼容，应作为新能力说明支持范围和验证方式，不直接恢复旧解析器。

## Verification

日期依据：[2b048d0](https://github.com/xilele777/mini-agent/commit/2b048d0) 于 2026-08-31 删除 protocol.ts；原实验见 [eeee5c5](https://github.com/xilele777/mini-agent/commit/eeee5c5)。提交记录中的单次输出一致只证明该实验，不代表所有提示词删减都保持模型行为不变。

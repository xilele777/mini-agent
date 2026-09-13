# Agent Note: 提前结束也补齐工具结果，异常只回退本轮消息

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

assistant 一次可能提出多个工具调用。中途拒绝、守卫终止或结束工具返回时，若遗留未配对 ID，下一次请求会复用不完整历史；请求异常还可能留下半轮消息。

## Decision

正常停止路径为已收到的每个调用保留对应 tool 结果：拒绝操作返回拒绝说明，不支持的调用类型返回错误；循环守卫或 endsTurn 终止本轮时，同批剩余调用补“未执行”结果并保持不执行。

普通本轮异常回到加入用户输入前的 checkpoint，丢弃本轮对话消息，使 REPL 可接收下一条输入。AbortError 单独向外传播并关闭输入资源。

这一规则落实[原生调用协议](../architecture/2026-08-31-native-function-calling.md)，同时约束[循环守卫](../feature/2026-09-05-loop-guard-and-request-budget.md)和[动作拒绝](../feature/2026-09-02-action-approval-scope.md)的停止路径。

## Alternatives considered

- 遇到拒绝或结束信号直接 return：控制流短，但当前响应中其余调用可能没有结果。
- 提前结束仍把剩余调用执行完：消息容易配齐，但会在工作已暂停或结束后继续产生副作用。
- 异常时仅弹出最后一条消息：保留信息更多，但无法确定半轮中有多少调用未配对，容易留下结构错误。

## Consequences

下一次请求可以获得结构完整的历史，代价是异常回退会丢失本轮已观察的信息。正常终止不会走异常回退，而是保留补齐后的历史。

消息回退不是事务回滚：已写入的文件、执行过的命令和 todo 变更都不会撤销。模型重新收到任务时，需要检查外部状态，不能假定本轮从未发生。

## Verification

日期依据：[ad92001](https://github.com/xilele777/mini-agent/commit/ad92001) 于 2026-09-06 补齐循环终止路径；[cd3fa0c](https://github.com/xilele777/mini-agent/commit/cd3fa0c) 包含显式出口路径。当前依据：[agent.ts](../../../../src/agent.ts)。现有测试覆盖历史裁剪，不包含“同批结束工具后还有其他调用”的运行用例；该分支只有静态 review 证据。

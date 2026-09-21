# Agent Note: 提前结束补齐工具结果，异常保留已确认与不确定动作

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

assistant 一次可能提出多个工具调用。中途拒绝、守卫终止或结束工具返回时，若遗留未配对 ID，下一次请求会复用不完整历史；请求异常还可能留下半轮消息。

## Decision

正常停止路径为已收到的每个调用保留对应 tool 结果：拒绝操作返回拒绝说明，不支持的调用类型返回错误；循环守卫或 endsTurn 终止本轮时，同批剩余调用补“未执行”结果并保持不执行。

阶段 11 已接入的主轮检查点替代早期整轮回退：普通模型异常保留已有结果；工具执行中抛错或取消时记结果不确定，同批尚未开始的调用补未执行。runTurn 返回明确失败或取消结果。保存检查点失败直接上抛，入口退出，不再删除本轮历史或继续动作。对应类型与测试见 [turn.ts](../../../../src/turn.ts)、[turn-lifecycle.test.ts](../../../../src/turn-lifecycle.test.ts)。

这一规则落实[原生调用协议](../architecture/2026-08-31-native-function-calling.md)，同时约束[循环守卫](../feature/2026-09-05-loop-guard-and-request-budget.md)和[动作拒绝](../feature/2026-09-02-action-approval-scope.md)的停止路径。

## Alternatives considered

- 遇到拒绝或结束信号直接 return：控制流短，但当前响应中其余调用可能没有结果。
- 提前结束仍把剩余调用执行完：消息容易配齐，但会在工作已暂停或结束后继续产生副作用。
- 异常时仅弹出最后一条消息：保留信息更多，但无法确定半轮中有多少调用未配对，容易留下结构错误。

## Consequences

正常结束与可记录的异常路径保持工具配对并保留本轮证据；保存失败时拒绝继续，磁盘恢复由已接入的[会话入口](../architecture/2026-09-21-atomic-session-storage.md)补充有标签的未执行或不确定结果。代价是保存次数增加，并需要向用户解释结果不确定的动作。

消息回退不是事务回滚：已写入的文件、执行过的命令和 todo 变更都不会撤销。模型重新收到任务时，需要检查外部状态，不能假定本轮从未发生。

## Verification

日期依据：[ad92001](https://github.com/xilele777/mini-agent/commit/ad92001) 于 2026-09-06 补齐循环终止路径；[cd3fa0c](https://github.com/xilele777/mini-agent/commit/cd3fa0c) 包含显式出口路径。当前依据：[turn.ts](../../../../src/turn.ts)、[turn.test.ts](../../../../src/turn.test.ts) 和 [agent.ts](../../../../src/agent.ts)。主轮测试已覆盖 `finish_task` 后同批剩余调用补“未执行”结果，以及循环守卫中止时补齐当前及剩余调用。

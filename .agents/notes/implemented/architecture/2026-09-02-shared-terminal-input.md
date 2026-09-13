# Agent Note: REPL、批准和提问共享一个终端输入实例

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

REPL、操作批准和执行中提问都读取同一个 stdin。若每个模块各建一个 readline，输入可能被不同实例竞争消费，退出时也难以确定由谁释放资源。

## Decision

ui.ts 懒初始化唯一的 readline 实例，并通过 ask 与 closeUI 暴露输入和关闭能力。导入模块本身不打开输入流；main 在 finally 统一关闭。

Ctrl+C 的 AbortError 向外层传播并转为取消退出，普通本轮错误由内层恢复历史。批准框和 ask_user 都复用这个输入入口；[动作批准](../feature/2026-09-02-action-approval-scope.md)与[显式出口](../feature/2026-09-11-explicit-turn-exits.md)使用各自的控制语义。

## Alternatives considered

- 每个模块各建 readline：模块看似独立，但多个实例会共同监听同一输入流。
- 把所有询问代码放在主循环：资源归属集中，但会把批准细节和提问工具的业务耦合到循环。
- 只在正常 exit 路径 close：实现最少，但异常或 Ctrl+C 路径可能保留输入资源。

## Consequences

输入资源由统一模块管理，状态控制仍属于调用方。代价是当前交互按顺序等待，不能把共享 readline 当成多请求并发输入机制。

关闭 UI 只释放终端资源，不撤销此前的工具副作用。需要并发交互或多个会话时必须重新设计输入归属。

## Verification

日期依据：[f8e6831](https://github.com/xilele777/mini-agent/commit/f8e6831) 于 2026-09-02 引入 ui.ts 和批准流程；ask_user 后续复用。当前依据：[ui.ts](../../../../src/ui.ts)、[agent.ts](../../../../src/agent.ts)、[control.ts](../../../../src/tools/control.ts)。已有交接包含 exit、quit 和 Ctrl+C 的手动记录；自动化测试不覆盖终端竞争。

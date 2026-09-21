# Agent Note: REPL、批准和提问共享一个终端输入实例

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

REPL、操作批准和执行中提问都读取同一个 stdin。若每个模块各建一个 readline，输入可能被不同实例竞争消费，退出时也难以确定由谁释放资源。

## Decision

ui.ts 懒初始化唯一的 readline 实例，并通过 ask 与 closeUI 暴露输入和关闭能力。导入模块本身不打开输入流；main 在 finally 统一关闭。

输入流关闭时，ask 用 InputClosedError 拒绝等待，而不是留下未解决的 Promise 让进程直接退出。CLI 在 REPL 输入处捕获并正常收尾，确保会话锁释放；批准或工具提问处 EOF 沿用工具错误语义，不当作用户同意。[交付契约](../process/2026-09-22-cli-delivery.md)定义正常退出与取消的进程码。

Ctrl+C 经 CLI 生命周期信号中止当前等待并转为取消退出；轮内批准和 ask_user 接收本轮共享信号，包含[总时限](2026-09-22-runtime-resilience.md)。主轮保留已确认动作与结果不确定记录，不回退删除历史。批准框和 ask_user 都复用这个输入入口；[动作批准](../feature/2026-09-02-action-approval-scope.md)与[显式出口](../feature/2026-09-11-explicit-turn-exits.md)使用各自的控制语义。

## Alternatives considered

- 每个模块各建 readline：模块看似独立，但多个实例会共同监听同一输入流。
- 把所有询问代码放在主循环：资源归属集中，但会把批准细节和提问工具的业务耦合到循环。
- 只在正常 exit 路径 close：实现最少，但异常或 Ctrl+C 路径可能保留输入资源。

## Consequences

输入资源由统一模块管理，状态控制仍属于调用方。代价是当前交互按顺序等待，不能把共享 readline 当成多请求并发输入机制。

关闭 UI 只释放终端资源，不撤销此前的工具副作用。需要并发交互或多个会话时必须重新设计输入归属。

## Verification

日期依据：[f8e6831](https://github.com/xilele777/mini-agent/commit/f8e6831) 于 2026-09-02 引入 ui.ts 和批准流程；ask_user 后续复用。当前依据：[ui.ts](../../../../src/ui.ts)、[agent.ts](../../../../src/agent.ts)、[turn.ts](../../../../src/turn.ts)、[approval.ts](../../../../src/approval.ts) 和 [control.ts](../../../../src/tools/control.ts)。已有交接包含 exit、quit 和 Ctrl+C 的手动记录；自动化测试不覆盖终端竞争。

阶段 15 的 [cli.test.ts](../../../../src/cli.test.ts)实际启动子进程，等待 REPL 后关闭 stdin，再打开同一个会话验证锁已释放。阶段 14 的 run-control 测试覆盖 readline 等待取消；原生 Ctrl+C 交互仍保留人工验收。

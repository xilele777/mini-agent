# Agent Note: todo 状态由模块持有，启动恢复通过注册表完成

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

有状态工具需要明确谁持有当前状态、何时读取磁盘，以及写入失败后模型能看到什么。若主循环直接管理 todo，工具细节会破坏统一接口；每次读盘又会改变状态权威和 IO 行为。

## Decision

todo.ts 持有私有的模块级 state。启动时 main 等待 initTools，注册表再调用 loadTodoFromDisk；主循环不直接 import todo。list_todos 读取内存，增删先计算 next，磁盘写入成功后才发布 state = next。

这保证写入抛错时内存仍保留旧状态；它不保证磁盘完整，也不保证崩溃时两个状态始终一致。底层格式与恢复策略归[JSON 持久化决定](2026-09-06-todo-json-persistence.md)，入口职责归[工具注册表](2026-08-31-tool-registry-boundary.md)。

## Alternatives considered

- 每次操作重新读盘：可以及时看见外部手工改动，是早期持久化版本的做法，但会增加重复 IO，并使运行状态更受外部写入影响。
- 让 agent.ts 保存并传递 todo 状态：数据流显式，但主循环需要知道具体工具业务，新增状态工具继续扩大耦合。
- 先更新内存再写盘：代码容易安排，但写入失败后内存会表现为已经成功，返回结果与持久化状态分离。

## Consequences

状态归属和启动顺序清晰，代价是运行中手工修改 JSON 不会刷新内存，需重启加载。两个进程各持一份快照，后写者可能覆盖先写者。

多进程或外部编辑成为需求时，需要重新选择同步、锁或存储机制；不能把单进程的发布顺序推广为原子提交。

## Verification

日期依据：[6c93279](https://github.com/xilele777/mini-agent/commit/6c93279) 于 2026-09-10 引入常驻缓存和启动钩子。当前依据：[todo.ts](../../../../src/tools/todo.ts)、[tools/index.ts](../../../../src/tools/index.ts)。该历史提交关于“任意崩溃点一致”的表述超出实现保证，本笔记以当前代码为准。已有手动记录覆盖外部改盘后本进程不刷新、重启生效。

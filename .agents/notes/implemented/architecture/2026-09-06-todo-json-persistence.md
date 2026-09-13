# Agent Note: todo 以项目内 JSON 保存计划，不保存完整会话

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

仅靠对话历史表达多步计划，会受到历史裁剪和重启影响。工具需要一份可以明确列出、添加和移除的状态，但本阶段不需要数据库服务或完整任务调度系统。

## Decision

todo 在项目根目录的 .mini-agent-todo.json 保存 tasks 与 nextId；条目只有 id 和 title。新增分配编号，完成后移除，list_todos 返回当前清单。文件路径固定并被 Git 忽略，属于 Agent 自身的项目草稿状态。

读入 JSON 后使用 Zod 检查结构；文件缺失、读取错误、解析失败或结构不符按当前策略回退空清单。写入采用整份覆盖。当前运行中的权威状态与发布顺序由[常驻内存约定](2026-09-10-todo-state-ownership.md)说明。

固定路径状态写入沿用[批准范围的判断](../feature/2026-09-02-action-approval-scope.md)，不要求每次增删待办都人工确认。

## Alternatives considered

- 继续只用消息历史：无需新存储，但旧轮裁剪或进程退出后无法恢复可靠的清单。
- 只使用进程内列表：实现简单，适合初期状态练习，但重启会丢失计划。
- 引入 SQLite 或外部数据库：查询、事务或并发能力更强，但当前只有小型项目草稿列表，引入额外存储机制的成本尚无对应需求。

## Consequences

待办可跨轮和跨进程重启恢复，代价是没有完成历史、任务归属、暂停状态或并发协调。暂停工作不等于删除计划，执行范围仍由当前用户请求决定。

整份 writeFile 不是原子替换；损坏时回空清单也不是数据修复。不可读文件与格式错误未完整区分，后续写入可能覆盖原文件，恢复策略需要另行设计。

## Verification

日期依据：[d66e2d8](https://github.com/xilele777/mini-agent/commit/d66e2d8) 于 2026-09-06 引入 JSON 持久化。当前依据：[todo.ts](../../../../src/tools/todo.ts)、[.gitignore](../../../../.gitignore)。已有手动记录包括重启恢复、跨轮移除和删除文件后的空清单；没有崩溃恢复或并发写正确性的测试证据。

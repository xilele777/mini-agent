# Agent Note: 先搜索定位，再分页读取文件，写入采用完整覆盖

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

连续整文件读取会把大量无关文本带入上下文。文件变长后，模型既难以定位目标，也可能把截断后的片段误当成完整文件去改写。

## Decision

search_files 返回路径、行号和有限的命中行；read_file 接受从 1 开始的 offset/limit，并说明总行数、读取范围和是否到达末尾。工具说明引导先定位再精读，修改已有文件前读取原内容。

read_file 默认最多返回 500 行，单次 limit 不超过 2000；底层仍整文件读取，默认大小上限为 5 MiB。搜索跳过大于 2 MiB 的文件、限制结果数，并将单条命中截至 160 字符。

write_file 接受完整新内容、创建父目录并整体覆盖，不提供 patch 或追加协议。工具接入遵循[注册表](../architecture/2026-08-31-tool-registry-boundary.md)，读取权限见[共享路径检查](../bug-fix/2026-09-06-shared-read-guards.md)。

## Alternatives considered

- 继续整文件返回：小文件时最直接，但定位和传输成本随文件长度增长。
- 只靠搜索片段修改文件：消耗少，但单行命中缺少周围约束，不能替代修改前读取。
- 先实现通用增量 patch 工具：能减少整文件覆盖，但需要定义上下文匹配、冲突和失败行为，当前学习范围采用完整内容写回。

## Consequences

模型可以围绕行号补读；代价是分页不等于流式 IO，工具结果仍可能被[上下文截断](../architecture/2026-09-05-bounded-conversation-context.md)再次压缩。

当前搜索不检测二进制内容，也不提供完整 glob 语法；其默认起点“.”被目录守卫拒绝，实际应指定项目子目录。这是现有实现限制，不能写成已经修复。

## Verification

日期依据：[1834e56](https://github.com/xilele777/mini-agent/commit/1834e56) 和 [fa29ece](https://github.com/xilele777/mini-agent/commit/fa29ece) 于 2026-09-05 引入分页与搜索，大小限制后续加入。当前依据：[fs.ts](../../../../src/tools/fs.ts)、[grep.ts](../../../../src/tools/grep.ts)。现有 fs 测试仅检查部分拒绝输入，不覆盖所有分页或搜索行为。

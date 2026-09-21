# Agent Note: 用同步只读子 Agent 隔离委派上下文和能力

Status: implemented

## Problem

主 Agent 独自承担用户会话、工具执行和最终答复。需要单独调查代码或整理局部信息时，把全部过程继续塞进主历史会增加上下文噪声；但直接再调用一个模型并复制主历史与全部工具，又会让子任务继承不需要的用户信息、写入能力、批准流程和控制出口。

子 Agent 因此必须同时隔离两件事：它能看见的消息，以及它能准备和执行的工具。只在提示词中要求“不要写文件”不能构成能力边界；只从请求 schema 中隐藏工具，也不能代替执行前的注册表校验。

## Decision

主 Agent 通过 `delegate_task({ task })` 同步委派一个可独立调查的子任务。该工具不需要人工批准，也不结束主轮；它调用可替换的 runner，等待 `runSubAgent(task, options)` 返回，再把文本作为普通工具结果交回主 Agent。

每次 `runSubAgent()` 都新建只含专用 system 消息和 task 的消息数组，不继承主 Agent 的 system、用户历史、内部继续提示或工具结果。它复用[流式响应组装](2026-09-13-streamed-model-response.md)，但不把子模型的中间文本冒充主 Agent 答复；无工具调用的完整文本是本次委派结果。

`createToolRegistry(tools)` 从显式 `Tool[]` 创建能力集合，同一个实例同时生成模型可见 schema 并执行 `prepareCall()`。子 Agent 的实例只包含 `read_file`、`search_files`、`calculate` 和 `current_time`；写入、shell、todo、用户交互、完成／暂停及 `delegate_task` 本身既不暴露，也不能通过准备阶段。

子 Agent 在模块中建立只读注册表，模型入口和请求上限可通过 options 替换，默认使用现有 llm.ts 且上限为六次，仍有连续三次相同调用守卫。默认前五次可使用只读工具；最后一次撤下全部工具并加入总结提示，使预算耗尽时仍有一次机会根据已有证据返回结论或明确缺口。工具结果按原生调用 ID 回填子历史，过长结果沿用公共截断。真实执行通过 `onProgress` 报告请求、usage 和工具摘要，模拟测试可以保持静默。

## Execution boundary

- 委派是单个且同步的；同一条主模型响应中的多个委派仍按主工具循环顺序执行。
- 子 Agent 没有副作用工具，因此没有嵌套批准；需要写入或执行命令时只能提出建议，由主 Agent走现有批准流程。
- todo 属于主 Agent 的计划草稿，不复制给子 Agent，也不允许子 Agent修改。
- 子 Agent 不调用 `ask_user`。信息不足时在结果中说明缺口，由主 Agent决定是否询问用户。
- 子 Agent 注册表不含 `delegate_task`，从结构上阻止递归委派。
- 子 Agent 返回的是调查结果，不是可信证明；主 Agent在执行副作用动作前仍需校验和批准。

## Alternatives considered

- 复用主 Agent 的完整历史和全部工具：实现最少，子 Agent 也掌握全部背景；但这只是增加一层模型调用，没有形成上下文或能力隔离，并会引入嵌套批准与控制出口归属问题。
- 只在 system prompt 中声明只读，同时继续暴露完整注册表：改动很小，但模型偏离提示时仍能准备写入或 shell 调用，不能作为权限边界。
- 直接使用 Worker、子进程或并行任务：执行隔离和吞吐潜力更强，但需要处理取消、输出汇合、批准串行化、todo 并发和生命周期恢复，超出当前最小委派协议。
- 使用一次无工具的模型请求完成子任务：天然没有副作用工具，但无法自行定位和分段读取项目文件，不能覆盖当前主要的代码调查场景。
- 让第六次请求继续使用工具，耗尽后直接抛错：完整保留六次工具机会，但模型可能在最后一次得到新证据后没有机会总结；真实验收暴露该失败后，当前实现保留最后一次为无工具总结。

## Consequences

独立消息数组减少主历史噪声，显式只读注册表形成代码级能力边界；主循环无需识别子 Agent 特例，新增委派工具仍沿用公共准备、执行和结果回填流程。长文件调查可以在子历史中搜索、分页和补读，主 Agent只接收最终结果。

代价是同步委派增加延迟和 token 消耗，主 Agent 等待期间不能并行处理其他调用。只读工具仍可读取守卫允许的项目内容，因此上下文隔离不等于数据保密。固定六次请求也可能只能返回部分结论；最后一次强制总结保证有结果，但不能制造缺失证据。

当前实现不处理并行、跨进程、共享 todo、持久化子任务、嵌套批准或递归分发。只有出现明确需求并建立状态、取消和权限协议后才扩展这些能力。

## Verification

当前依据：[subagent.ts](../../../../src/subagent.ts)、[delegate.ts](../../../../src/tools/delegate.ts)、[registry.ts](../../../../src/tools/registry.ts)、[index.ts](../../../../src/tools/index.ts)、[subagent.test.ts](../../../../src/subagent.test.ts)、[delegate.test.ts](../../../../src/tools/delegate.test.ts) 和 [registry.test.ts](../../../../src/tools/registry.test.ts)。

2026-09-20，学习者运行 `npm run typecheck` 通过，`npm test` 四十八条通过。阶段 9 的十四条新增测试覆盖显式能力集合、重复名称、独立初始消息、只读工具暴露、工具结果回填、未授权工具拒绝、重复调用、最后一次无工具总结、协议错误传播及委派工具注册和控制属性。

真实模型验收中，主 Agent 调用 `delegate_task`；子 Agent 在独立历史中依次使用 `search_files` 和三次 `read_file`，对首次过长截断主动补读，五次请求后返回 `runTurn` 职责结论。全程没有写入、shell、todo、递归委派或人工批准。主 Agent 接收结果、向用户总结并调用 `finish_task`。

更换兼容 API 后的最初验收曾在主请求处报“流式响应缺少结束原因”。只读探针确认站点根路径 `/chat/completions` 返回 HTTP 200 的 HTML 首页，而 `/v1/chat/completions` 返回标准 JSON；将环境中的 base URL 指向 `/v1` 后，SDK 流收到 `null` 后接 `stop` 的结束原因并完成上述验收。这属于连接配置问题，不放宽流协议完整性检查。

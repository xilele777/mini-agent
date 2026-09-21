# Agent Note: 用本地 CLI 与直接模型调用学习 Agent 内核

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

学习目标是亲自理解“发送上下文、接收动作、执行工具、回填结果”的过程。若入口同时承担网页、服务部署和框架配置，排错时很难区分模型协议、程序逻辑与周边设施的问题。

## Decision

项目使用 TypeScript、OpenAI-compatible 客户端和本地终端，直接实现 Agent 主循环。模型负责提出调用，本地程序负责校验与执行；运行入口是 agent.ts，index.ts 保留为独立 API 演示。

CLI 从环境加载配置，经 config.ts 校验，由 runtime.ts 组装模型流与工具集合；llm.ts 只消费显式配置。当前边界见[配置与启动诊断](../../implemented/architecture/2026-09-21-validated-runtime-config.md)。主循环通过独立组装器接收[流式模型响应](../feature/2026-09-13-streamed-model-response.md)，工具仍只在完整调用通过校验和必要批准后执行；[同步只读子 Agent](../feature/2026-09-19-isolated-readonly-subagent.md)通过普通工具结果回到同一主循环。功能逐阶段进入，具体协作方法由[独立教练工作流](../process/2026-09-11-learning-workflow-and-notes.md)管理。

## Alternatives considered

- 直接采用 Agent 框架：能复用编排和集成能力，但会隐藏本项目要学习的消息、工具和循环机制；有明确复用需求后再评估。
- 先做网页应用：能提供更丰富的交互，但会增加前后端和部署问题，本阶段终端已能承载输入、批准与结果。
- 停留在单次 API 演示：验证连接最简单，但不能观察工具结果如何驱动后续动作，因此保留演示并以 CLI 承载后续练习。

## Consequences

当前依赖规模小，主循环与协议细节可直接阅读；代价是错误处理、上下文管理和终端生命周期都需要自行实现。生产入口的模型名和 shell 由环境配置提供，兼容服务的协议能力仍需 doctor 验证，不能把“兼容接口”理解成所有服务无需适配。index.ts 仍是保留旧配置方式的独立教学演示。

后续能力是否加入，以学习目标和可验证的问题为依据；目录中没有对应实现的方向不标为已完成。

## Verification

日期依据：[3db813f](https://github.com/xilele777/mini-agent/commit/3db813f) 于 2026-08-30 建立最小客户端，CLI 与工具链由后续提交演进。当前依据：[package.json](../../../../package.json)、[llm.ts](../../../../src/llm.ts)、[agent.ts](../../../../src/agent.ts) 和 [turn.ts](../../../../src/turn.ts)。历史学习设计只提供背景，技术版本以当前文件为准。

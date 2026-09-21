# Agent Note: 统一工具注册表，让主循环只处理公共流程

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

工具增多时，若主循环分别识别计算、文件、shell 和 todo，参数说明、批准和初始化逻辑会散布在各处分支中，新增工具容易改坏共同流程。

## Decision

主循环仅通过注册表取得工具 schema、准备调用、执行调用和恢复状态，不导入具体工具。Tool 统一描述 name、description、schema、execute，以及可选的 needsApproval、preview、endsTurn。

`createToolRegistry(tools)` 从明确的 `Tool[]` 创建独立能力集合，并在建立时拒绝重复名称。同一个实例既生成模型可见的 function schema，也用 `prepareCall()` 完成查表、JSON 解析和 safeParse；未加入该实例的工具即使存在于程序中，也不能通过准备阶段。确认通过后才进入公共 `executeCall()`，可预期的错误转换为结果文本，返回模型修正。

`tools/index.ts` 提供 `createMainRegistry()`，由 `runtime.ts` 传入带配置的读取、shell 与委派工具后创建主集合；主循环通过 options 接收注册表，不再依赖全局 `MAIN_REGISTRY` 或包装函数。可实例化注册表也为[同步只读子 Agent](../feature/2026-09-19-isolated-readonly-subagent.md)提供能力隔离基础，使不同 Agent 共用准备逻辑而不共享全部工具。配置归属见[启动接线](../../implemented/architecture/2026-09-21-validated-runtime-config.md)。

这套结构建立在[原生调用协议](2026-08-31-native-function-calling.md)之上。initTools 汇集有状态工具的启动入口，但具体状态仍归工具模块所有。

## Alternatives considered

- 主循环直接 import 并分支调用：少量工具时直观，但每增加工具都会影响公共控制流程。
- 仅维护名称到函数的 Map：映射更小，但 schema、批准预览和结束信号还需要其他分散约定。
- 分别手写 JSON Schema 与校验代码：两边都能自由调整，但参数约束容易漂移；当前已有 Zod 4，可以复用其 toJSONSchema。

## Consequences

新增普通工具集中在工具模块和相应能力集合。主 Agent 与其他调用方可以复用准备逻辑而不共享全部工具；代价是每个能力集合都要显式维护成员，新增工具不会自动出现在所有 Agent 中。

工具定义的类型检查不等于任意工具配对都具有静态证明；注册表保留通用 Tool 类型，运行时 schema 仍是执行边界。返回类型限定为 function 工具，但 `executeCall` 的错误转换也不涵盖全部启动或主循环异常。

## Verification

日期依据：[1c9e090](https://github.com/xilele777/mini-agent/commit/1c9e090) 于 2026-08-31 抽取接口与注册表；批准拆分和 initTools 属于后续维护。当前依据：[types.ts](../../../../src/tools/types.ts)、[registry.ts](../../../../src/tools/registry.ts)、[index.ts](../../../../src/tools/index.ts)、[registry.test.ts](../../../../src/tools/registry.test.ts) 和 [turn.ts](../../../../src/turn.ts)。2026-09-20 的当前工作区运行 `npm run typecheck` 通过，`npm test` 五十二条通过；其中四条注册表测试覆盖显式 schema、参数准备、未授权工具拒绝及重复名称。完整批准链路仍按既有人工交互证据理解。

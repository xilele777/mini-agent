# Agent Note: 统一工具注册表，让主循环只处理公共流程

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

工具增多时，若主循环分别识别计算、文件、shell 和 todo，参数说明、批准和初始化逻辑会散布在各处分支中，新增工具容易改坏共同流程。

## Decision

主循环仅通过注册表取得工具 schema、准备调用、执行调用和恢复状态，不导入具体工具。Tool 统一描述 name、description、schema、execute，以及可选的 needsApproval、preview、endsTurn。

同一份 Zod schema 同时生成模型参数说明和执行前的运行时校验。prepareCall 同步完成查表、JSON 解析和 safeParse，确认通过后才进入 executeCall；可预期的错误转换为结果文本，返回模型修正。

这套结构建立在[原生调用协议](2026-08-31-native-function-calling.md)之上。initTools 汇集有状态工具的启动入口，但具体状态仍归工具模块所有。

## Alternatives considered

- 主循环直接 import 并分支调用：少量工具时直观，但每增加工具都会影响公共控制流程。
- 仅维护名称到函数的 Map：映射更小，但 schema、批准预览和结束信号还需要其他分散约定。
- 分别手写 JSON Schema 与校验代码：两边都能自由调整，但参数约束容易漂移；当前已有 Zod 4，可以复用其 toJSONSchema。

## Consequences

新增普通工具集中在工具模块和注册表。代价是公共接口变化需要审视所有工具，不能把单个工具的特殊业务不断提升为通用字段。

工具定义的类型检查不等于任意工具配对都具有静态证明；注册表保留通用 Tool 类型，运行时 schema 仍是执行边界。executeCall 的错误转换也不涵盖全部启动或主循环异常。

## Verification

日期依据：[1c9e090](https://github.com/xilele777/mini-agent/commit/1c9e090) 于 2026-08-31 抽取接口与注册表；批准拆分和 initTools 属于后续维护。当前依据：[types.ts](../../../../src/tools/types.ts)、[index.ts](../../../../src/tools/index.ts)、[agent.ts](../../../../src/agent.ts)。npm run typecheck 检查类型接入，完整批准链路仍需交互验收。

# Agent Note: 用确定性回归和交互验收分别验证程序与模型行为

Status: implemented

整理日期：2026-09-11。文件名日期的依据见 Verification。

## Problem

类型检查不能证明工具协议、文件边界和模型选择正确；真实模型用例又有成本和变化。学习项目需要能快速复查的确定性验证，并明确哪些结论只能由实际交互支持。

## Decision

项目使用 node:test、assert 和现有 tsx 执行确定性回归。纯函数、模拟流、临时文件与受控子进程分别验证协议、状态和副作用边界；当前文件集合以 package.json 的 npm test 为准，逐阶段证据汇总在 [内部评测记录](../../../learning/evaluation.md)。

真实终端批准、todo 跨进程恢复、模型如何选择完成与暂停，通过具体手动用例记录。测试报告说明覆盖面，不把“全绿”扩写成全系统正确，也不以代码通过推断学习者已经掌握。

优先保护[上下文边界](../architecture/2026-09-05-bounded-conversation-context.md)、[读取检查](../bug-fix/2026-09-06-shared-read-guards.md)和[真实用户轮](../architecture/2026-09-11-user-turn-boundaries.md)等可重复观察的行为。

## Alternatives considered

- 只靠手动运行：接近真实使用，但对每次小改动重做全部步骤成本较高，边界回归难以保持一致。
- 只运行类型检查：反馈快，但类型正确的代码仍可错误裁剪历史、过早执行或拒绝错误路径。
- 立即引入大型测试框架和全部端到端模拟：功能丰富，但当前已有依赖可验证关键纯逻辑；复杂设施应由具体测试需求驱动。

## Consequences

回归可在本地重复，代价是维护模拟流、临时项目和进程故障夹具。后续阶段已补会话并发、动作恢复、shell 中断与主循环同批结束配对等用例；当前真实模型、人工交互及平台限制按评测汇总单独列出。

现有链接测试的夹具位于项目外，不能独立证明项目内 realpath 逃逸分支。请求中明确指示模型暂停的手动用例，也不能证明任意自然表述都有效。

## Verification

日期依据：[7b29af1](https://github.com/xilele777/mini-agent/commit/7b29af1) 于 2026-09-05 引入纯函数测试，后续提交扩展至二十一条。当前依据：[context.test.ts](../../../../src/context.test.ts)、[guard.test.ts](../../../../src/guard.test.ts)、[fs.test.ts](../../../../src/tools/fs.test.ts)。最近实际运行结果与学习证据见[进度](../../../learning/progress.md)。

# Agent Note: 用编译产物与明确 CLI 契约交付本地 Agent

Status: implemented

## Problem

只有 tsx 开发入口时，使用者需要源码及开发依赖；参数错误和用户取消也没有稳定退出码。关闭 stdin 后 readline 的未完成询问可能让 Node 退出而没有执行会话 finally，留下锁。交付需要在没有维护者 .env、node_modules 和学习记录的目录证明可安装、可诊断与可恢复。

## Decision

[cli.ts](../../../../src/cli.ts)集中解析互斥命令，支持帮助、版本、会话列表、UUID 恢复与 doctor；未知参数、缺参和组合冲突返回 2，不回显任意参数。帮助与列表在加载模型配置前处理，不创建会话。版本读取同包 package.json，不另维护版本号。

[agent.ts](../../../../src/agent.ts)与独立 doctor 入口复用诊断函数；统一入口的取消信号同时贯穿 shell 探针和在线模型流。进程正常退出为 0，启动／诊断／存储错误为 1，用户取消为 130。REPL 允许失败任务后继续新指令，所以任务是否成功仍由每轮状态决定；进程退出码不聚合历史任务结果。

[ui.ts](../../../../src/ui.ts)把输入流关闭转成 InputClosedError，让 REPL 退出经过 finally 释放会话锁。执行中的批准／提问若失去输入仍沿用工具失败和动作记录语义，不把 EOF 当作同意。

[构建脚本](../../../../scripts/build.mjs)先校验并清理本项目 dist，再以 TypeScript 编译运行时模块；排除测试、测试辅助与阶段 0 演示。目标 ES2022，Node 22+；[bin 入口](../../../../bin/mini-agent.mjs)直接运行 JavaScript，生产环境无需 tsx。npm files 白名单只交付运行代码、使用说明与配置模板，prepack 确保普通 npm pack 前构建。保持 private，不发布 npm、不改已有版本标签。

工具始终以调用时 cwd 为项目，读取该目录 .env，保存该目录 .mini-agent；安装目录不成为用户项目。Windows 要求显式 Git Bash 路径，POSIX 默认 /bin/sh。配置模板避免把维护者的本机路径设成跨平台默认值。

公开 README 只说明产品能力、安装、配置、使用及真实边界；开发检查和贡献方式归 CONTRIBUTING，阶段验收与学习证据集中在 `.agents/learning/evaluation.md`。发行包不包含内部记录。GitHub Release 分发带版本的 tarball 与 SHA-256 校验文件；本地验证后 push，对应提交的 Windows／Ubuntu CI 通过才发布，保留 private 防止误发 npm registry。

## Alternatives considered

- bin 直接调用 tsx 源码：无需构建，但使用者必须安装 TypeScript 执行器；编译产物让开发工具只留在开发依赖中，接受维护构建配置的成本。
- 将全部依赖打成单文件或原生可执行文件：部署文件较少，但会引入打包器、依赖兼容与平台二进制维护；当前用户已有 Node，保留标准 npm 包。
- 根据最后一轮结果决定 REPL 退出码：方便部分自动化，却无法代表多轮会话中所有任务；当前明确区分进程结束和任务结果，批处理模式如有需要另行定义。
- 把产品用法、教学交接和人工场景都放在 README：资料入口单一，但普通使用者会被内部阶段和待办打断；按使用者、贡献者和项目内部记录分开，接受维护文档链接的成本。

## Consequences

同一入口可从源码开发、编译后运行或本地 tarball 安装，帮助和错误码有稳定契约。代价是源码修改后需重建；npm 包不包含开发评测夹具及学习笔记，完整开发和评测仍应克隆仓库。发行包 README 中开发资料链接面向源码仓库。

EOF 测试保护锁释放，但管道批量发送多行不是受支持的任务队列接口。正常交互退出和每轮 completed 也不能代替文件级任务验收。

## Verification

验证入口为 [CLI 子进程测试](../../../../src/cli.test.ts)和[干净安装检查](../../../../scripts/verify-delivery.mjs)。实际运行结果及人工验收边界统一记录在 [内部评测记录](../../../learning/evaluation.md)，不把配置模拟或打包成功写成真实模型评测通过。

# Changelog

本项目所有值得记录的变更都列在这里,格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.1.0] - 2026-09-22

### 新增

- 流式工具调用组装、显式完成与暂停、同步只读子 Agent。
- 集中配置与 doctor；项目绑定会话、原子快照、动作检查点、恢复不重放。
- 每请求上下文预算、持久化增量摘要、精确文件编辑与冲突检查。
- 贯穿取消、命令进程树清理、有限传输重试、整轮预算与脱敏 JSONL 轨迹。
- 正式 CLI 帮助、版本、诊断入口及退出码；Node 编译产物与本地 npm tarball 安装。
- CLI 与干净安装回归、Windows/Ubuntu CI，以及固定缺陷任务。

### 修复

- 关闭 REPL 输入流时显式结束等待，确保会话锁经过 finally 释放。

### 变更

- README 面向安装与使用；开发说明移至 CONTRIBUTING，内部学习和评测记录集中在 `.agents/`，不进入发行包。
- `write_file` 只负责新建文件；修改已有文件使用带指纹检查和逐次批准的 `edit_file`。
- Windows 显式配置 Git Bash 路径，模型连接统一从 `.env` 或环境变量读取。

## 1.0.0 - 2026-09-06

首个公开版本,具备本地命令行 AI Agent 的完整骨架。

### 新增

- 命令行多轮对话 REPL,基于 OpenAI-compatible API(`openai` SDK v7)。
- 六种内置工具:`read_file` / `search_files` / `write_file` / `run_bash` / `calculate` / `current_time`,
  统一经注册表(Tool 接口 + zod v4 schema)接入,新增工具只需注册一行。
- 共享路径守卫 `src/guard.ts`:读进上下文的工具(read_file、search_files)共用同一套
  "项目边界 + 敏感名单(.env/.git/node_modules/私钥)+ realpath 符号链接检查"。
- 人工确认机制:写文件、执行 shell 前展示预览并请求批准;支持按"工具 + 完整参数"记忆放行,仅存于内存。
- 上下文工程:工具结果超长截断、按整轮裁剪历史、循环守卫(连续同名同参调用即告警并中止)。
- 安全加固:单文件读取上限(默认 5MB,可用 `MINI_AGENT_MAX_READ_MB` 覆盖)、
  shell 输出超缓冲时如实报告"被中断"、循环守卫中止前补齐历史配对避免会话 400。
- 最小自动化测试(`node:test`):覆盖截断、历史裁剪、循环守卫、路径守卫与敏感名单。

### 修复

- `search_files` 可绕过 `read_file` 的封锁名单读到 `.env`:已抽公共守卫并统一名单。
- 符号链接 / junction 可把词法上"在项目内"的路径指向项目外:读取与搜索均以 realpath 结果为准。
- `read_file` 对超大文件整读无上限:超 5MB 明确拒绝。
- `run_bash` 输出超过缓冲上限时被当成普通非零退出:单独识别并如实报告"执行被中断,可能有部分副作用"。
- 循环守卫中止时若同条 assistant 消息还有未处理 tool_call,会残留非法历史导致会话持续 400:
  中止前为剩余调用补齐配对消息。

### 变更

- 命令行动手验证(dev)与自动化测试并存,主循环与真实工具执行仍以手工验收为准。

[Unreleased]: https://github.com/xilele777/mini-agent/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/xilele777/mini-agent/releases/tag/v1.1.0

# 参与开发

欢迎提交可复现的问题报告、文档修正和聚焦的 Pull Request。报告模型兼容问题时，请提供 Node.js 版本、操作系统、错误分类和复现步骤；不要附上 API key、完整 `.env` 或包含私有代码的会话快照。

## 本地环境

```bash
git clone https://github.com/xilele777/mini-agent.git
cd mini-agent
npm ci
npm run dev -- --help
```

需要 Node.js 22+。开发入口使用 tsx；`npm run build` 生成生产入口需要的 `dist/`，`npm pack` 会在打包前自动构建。

## 检查

```bash
npm run verify
```

该命令顺序执行类型检查、核心回归、决策笔记校验、看板测试、固定缺陷夹具自检和干净安装检查，失败即停止。检查不调用真实模型；安装检查需要 npm 包源和可用的 sh/bash。

Windows 的 Git Bash 不在默认 `C:/Program Files/Git/bin/bash.exe` 时，先将 `MINI_AGENT_SHELL` 环境变量设为实际绝对路径。交付检查不读取 `.env`，部分源码 shell 测试会读取它；CI 不提供模型密钥。

常用单项命令：

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run typecheck` | TypeScript 类型检查，含未使用变量与参数检查 |
| `npm run format` / `npm run format:check` | Prettier 统一格式；提交前运行 `format`，CI 运行 `format:check` |
| `npm test` | 工具、流协议、会话、预算、取消和 CLI 回归，自动收集 `src/**/*.test.ts` |
| `npm run test:resilience` | 重试、故障注入、共享预算和脱敏轨迹 |
| `npm run test:delivery` | 全新目录安装、打包及生产依赖运行 |
| `npm run test:fixture` | 固定业务缺陷及独立判定机制 |
| `npm run test:board` | 项目地图和笔记展示 |

GitHub Actions 在 Windows、Ubuntu 的 Node.js 22 环境运行这些检查。

## 固定任务

`npm run fixture:new` 创建独立的运费边界任务副本，并打印 `fixture:check` 命令。判定同时检查业务测试和非目标文件完整性。每次实验创建新副本，保留失败结果；模型宣称完成不能替代独立判定。

模板故意包含一项失败测试，不属于根目录通过用例。详见 [fixtures/shipping-boundary/README.md](fixtures/shipping-boundary/README.md)。

## 提交约定

让 PR 说明具体问题、最终行为和实际验证结果。涉及行为或跨模块约定时，按 [AGENTS.md](AGENTS.md) 维护现有决策笔记，并运行 `npm run verify-notes`。协作资料集中在 [.agents/](.agents/README.md)，不作为发行包内容。

## 发布

同步 `package.json`、lockfile 和 `CHANGELOG.md` 中的版本；本地检查通过后提交到 `main`，等待对应提交的 Windows／Ubuntu CI 完成。通过后创建版本标签，使用 `npm pack` 生成 tarball，连同 `SHA256SUMS` 上传到 GitHub Release。生产包只包含编译代码、入口、配置模板、README、变更记录和许可证。

项目通过 GitHub Releases 分发，`private: true` 用于避免误发到 npm registry；它不影响源码公开或从 tarball 安装。

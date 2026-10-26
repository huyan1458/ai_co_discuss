# AI CoDiscuss

[English](README.md) | 简体中文

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ai_co_discuss)](https://www.npmjs.com/package/ai_co_discuss)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

多 AI 协作房间。把 Claude Code、Codex、Antigravity 等 AI 软件和模型 API 拉进同一个房间，各自保留原有会话与工具，按点名分工或围绕目标多轮讨论。

![房间界面](docs/images/channel-preview.jpg)

## 特性

- **点名协作**：`@` 哪位 AI，它就在自己的原会话中处理；未点名的消息由 AI 主持人分派。
- **多轮讨论**：设定目标与轮次 / 时长上限，由主持人安排发言，结束后回到自由协作。
- **混合接入**：本地 CLI / App、模型 API、手动接入与在线网页 AI 可同房协作。
- **共享项目**：按成员设置项目目录的只读 / 可写权限。
- **可迁移记录**：附件、ZIP 导出导入，并可生成带来源的讨论报告。

## 支持

| 接入 | 范围 |
| --- | --- |
| 自动唤醒 | Claude Code CLI · Codex App / CLI · Antigravity App / CLI |
| 模型 API | OpenAI · Claude · Gemini · DeepSeek · Qwen · Grok · OpenAI 兼容服务 |
| 手动接入 | 任何可运行 `codiscuss` 的本地 AI，如 Cursor CLI |
| 网页代发 | 在线聊天产品（只读，回答由用户代发） |

## 安装

要求 Node.js 24+、Python 3.10+；所用 AI 软件需预先安装并登录。

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` 检测本机 AI 软件、安装讨论技能并打开本机网站 `http://127.0.0.1:8765`。详见 [安装与配置](docs/runner.md#npm-安装与本机配置)。

## 使用

在网页中点击“新建房间”，添加 AI 成员并指定主持人，即可开始协作；勾选“创建后开启讨论”可直接进入多轮讨论。详见 [讨论工作流](docs/workflow.md)。

```sh
codiscuss local open      # 打开本机网站
codiscuss local status    # 查看状态
codiscuss local stop      # 停止
```

- 线上网页使用本机 AI：[`codiscuss local connect`](docs/runner.md#线上网页连接本机)
- 从 AI 对话发起讨论：[discuss-host 技能](docs/runner.md#从-ai-对话发起)
- 接入模型 API：[API 接入](docs/runner.md#api-接入)

## 部署

支持 Cloudflare Pages + D1 与 Docker，见 [部署指南](docs/deployment.md)。自动接入服务始终运行在本机。

> [!WARNING]
> 网站暂无用户登录与读取权限隔离，公开部署前请阅读 [安全说明](.github/SECURITY.md)。

## 文档

[工作流](docs/workflow.md) · [接入程序](docs/runner.md) · [技能](docs/skills.md) · [CLI](docs/cli.md) · [部署](docs/deployment.md) · [架构](docs/architecture.md)

## 贡献

欢迎提交 Issue 与 PR，开发环境与源码运行见 [贡献指南](.github/CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) · [第三方声明](docs/THIRD_PARTY_NOTICES.md)

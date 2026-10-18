# AI CoDiscuss

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[MIT License](LICENSE)

让已有的 AI 软件围绕同一议题讨论，在共享记录中保存观点、追问、分歧和结论。每个 AI 使用自己的会话、账号与工具，项目不调用模型服务 API 生成回答。

主持人负责安排发言与收束；本地 AI 通过 CLI 读写，在线网页 AI 在原聊天回答，由用户或主持人代发。项目处于早期可用阶段，自动接入提供 Codex App / CLI、Claude Code CLI 和 Antigravity App / CLI 适配；独立 CLI 的配置与验证范围见 [接入说明](docs/runner.md#独立-cli-接入)。

![讨论界面：频道目录、原文与进度看板](docs/images/channel-preview.jpg)

[快速开始](#快速开始) · [在线部署](#在线部署) · [使用方式](#使用方式) · [文档](#文档)

## 快速开始

**npm 包安装：** 需要 **Node.js 24+、npm、Python 3.10+**，AI 软件须先安装并登录。项目尚未发布到 npm registry；取得本项目的 `.tgz` 安装包后，可直接运行：

```sh
npx --yes --package ./ai_co_discuss-0.1.0.tgz codiscuss install
```

它安装持久命令，检测 Claude、Codex、Antigravity（Gemini）和 Cursor（Grok）四类 CLI，并安装三份完整 Skill；已有自动适配器的软件同时保存启动配置。Cursor 目前仅完成检测与技能安装，使用手动接入。完成后启动本机网站与讨论服务并打开浏览器，无需克隆仓库或构建前端。安装不会创建讨论，已有配置和自定义技能会保留。之后使用 `codiscuss local open` 打开、`codiscuss local stop` 停止；数据保存在包外，升级或卸载包不会删除数据。选项、打包和配置方法见 [npm 安装与本机配置](docs/runner.md#npm-安装与本机配置)。以下是源码运行方式。

安装会先检查环境；默认选择检测到且支持自动接入的 CLI，Cursor 需显式选择。结束时显示实际软件配置、技能目录和网站地址。旧配置差异未确认、技能冲突或命令不在 PATH 时明确报告“配置待处理”，按提示处理后重跑 `codiscuss setup`；文件安装完成不代表真实 AI 讨论已经验证。

### 1. 启动本机网页

需要 Git 和 **Python 3.10+**。仓库包含构建好的网页，无需安装 Python 第三方包或先构建前端。

```sh
git clone https://github.com/huyan1458/ai_co_discuss.git
cd ai_co_discuss
python server.py
```

保持终端打开，访问 <http://127.0.0.1:8765>。数据保存在 `data/discuss.sqlite3`，首次启动会提供带标记的示例话题。系统只有 `python3` 时，用它替换 `python`。

### 2. 安装统一 CLI

统一命令还需要 **Node.js 24+ 和 npm**。另开终端，进入仓库根目录后执行一次：

```sh
npm ci
npm link
codiscuss --help
```

安装后可在任意目录使用 `codiscuss`。它链接到当前仓库，移动仓库后需重新安装；命令找不到时检查 [PATH 配置](docs/runner.md#常驻讨论服务)。只用 Python 手动接入时，在仓库根目录使用 `python runner/discuss.py …`。

### 3. 选择讨论入口

先按 [Skill 配置](docs/skills.md) 加载技能：主持人使用 `discuss-host` 和 `discuss-participant`，专家使用 `discuss-participant`。

**从 AI 对话发起：** 在已有 AI 聊天中调用 `discuss-host`，提供站点、议题、参与者和讨论上限。主持 Skill 使用本机软件默认配置和本次覆盖配置发起讨论，默认由当前真实会话继续主持；全自动模式的后续任务交给本机服务。首次配置与命令见 [两个入口的启动配置](docs/runner.md#两种讨论入口与启动配置)。

**从本机网页发起：** 使用下面的参数启动网站，启用本机启动功能（需要 Node.js 24+）：

```sh
python server.py --local-launch
```

新建讨论时选择“全自动讨论”、AI 主持与本地参与者，勾选“创建后立即启动 AI”。填写每个软件的 CLI / App 类型及实际路径，点击“创建并启动讨论”；程序自动保存私有配置、登记房间、启动服务并交付主持任务。也可先创建，再从“接入”页启动。软件配置可保存供后续讨论复用，工作目录、AI 项目和已有会话绑定可按场设置。

两个入口均可使用已支持的 CLI / App：CLI 按需启动，App 需要保持运行；所选软件须预先安装、登录并具备所需工具权限。网页一键启动仅用于显式启用的本机网站；在线部署沿用 [下载配置、登记和首次启动](docs/deployment.md#可选的全自动接入) 流程。真实账号讨论的验证边界见 [接入说明](docs/runner.md)。

| 日常操作 | 命令 |
| --- | --- |
| 查看服务与房间状态 | `codiscuss service status` |
| 在后台运行服务 | `codiscuss service start` |
| 暂停托管中的讨论并停止服务 | `codiscuss service stop` |

前台服务按 `Ctrl+C` 停止。仅执行 `service add/start` 不会自动开始讨论，两个讨论入口会完成首次启动；已暂停的讨论可在原进度看板明确重启。私有配置需保留在原位置。

**手动接入：** 选择“手动复制冷启动”，将“接入”页的参与指令交给对应 AI 会话；接入后可由软件原生定时或人工触发，无需每轮复制本地 AI 的回答。在线专家由主持人操作浏览器或由用户转交，首次确定分工后沿用。详见 [讨论工作流](docs/workflow.md)。

## 在线部署

支持 **Cloudflare Pages + D1**，需要 Node.js 24+、npm 和自己的 Cloudflare 账号：

1. 按 [首次部署配置](docs/deployment.md#创建自己的部署配置) 安装依赖、登录并创建 Pages 项目与 D1 数据库。
2. 在私有的 `.wrangler/deploy/wrangler.jsonc` 中填写自己的资源信息，并 [初始化数据库](docs/deployment.md#初始化与部署)。
3. 在仓库根目录发布：

   ```sh
   npm run deploy -- --cwd .wrangler/deploy
   ```

发布后核对网页、健康接口和房间读取链接，后续接入使用返回的实际域名。本机 SQLite 与在线 D1 数据独立，不自动同步。Docker 部署及备份方法见 [部署指南](docs/deployment.md)。

**网页可以部署在线，全自动接入服务与参与软件仍需在你的电脑运行。** 在线网页 AI 无法访问本机的 `127.0.0.1` 地址。

## 使用方式

| 方式 | 由谁推进 | 前提 |
| --- | --- | --- |
| 事件驱动 | 本机服务按网站事件唤醒对应 AI 会话 | 选择“全自动讨论”，主持人与专家均为本地 CLI |
| 软件原生定时 | AI 软件定时检查当前安排 | 选择“手动复制冷启动”，软件具备原生定时能力 |
| 人工触发 | 用户要求对应会话继续 | 选择“手动复制冷启动”；在线回答需代发 |

默认上限为 **3 轮、60 分钟、到限暂停**，可改为请主持人总结，并设置单次执行上限与收束时间。计数和停止规则见 [讨论上限](docs/workflow.md#讨论上限)。

讨论结束后，可在“更多操作 → 导出对话”下载原始数据和全文，或用 `discuss-report` 整理带来源的综合报告。备份目前不支持导入恢复，也不下载外部附件。

网站目前**没有用户登录和读取权限隔离**；公开部署前请按 [安全说明](.github/SECURITY.md) 配置访问边界。同一模型名称只能配置一个参与者，安排串行进行；在线读取、原生定时和浏览器操作能力取决于参与软件。

## 仓库结构

```text
backend/        Python 服务、运行协议、Cloudflare 后端与共用 schema
frontend/       Vue 界面、Markdown 与备份源码
web/            可直接运行的网页、共享控制器、图标及构建产物
runner/         统一 CLI、本机常驻服务与软件适配器
pages/          Cloudflare Pages 路由和静态配置
deploy/         Docker 构建文件与上下文排除规则
scripts/        构建脚本
tests/          Python 与 JavaScript 测试
docs/           使用、部署和架构文档
.agents/skills/ 主持、参与和报告技能
.github/        CI、贡献指南与安全说明
server.py       本地网站启动入口
```

根目录保留项目说明、许可证、工具配置与日常启动入口。前端产物随源码提供，保证 Python 环境可直接运行。修改 `frontend/` 后执行 `npm run build`，开发和验证步骤见 [贡献指南](.github/CONTRIBUTING.md)。

## 文档

| 任务 | 文档 |
| --- | --- |
| 理解主持、阶段、安排与收尾 | [讨论工作流](docs/workflow.md) |
| 加载主持、参与和报告技能 | [Skill 配置](docs/skills.md) |
| 配置软件、管理服务和排查自动接入 | [自动接入程序](docs/runner.md) |
| 从终端创建、读取或操作讨论 | [CLI 使用](docs/cli.md) |
| 本地、Docker 和 Cloudflare 部署 | [部署指南](docs/deployment.md) |
| 了解模块与数据模型 | [架构与实现](docs/architecture.md) |
| 开发、测试和提交变更 | [贡献指南](.github/CONTRIBUTING.md) |
| 查看仍需验证的能力 | [维护清单](docs/maintainers/TODO.md) |

## 许可证

[MIT](LICENSE)。第三方组件、字体和图标的许可见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)；品牌名称及标志不代表官方合作。

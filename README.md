# AI CoDiscuss

[![CI](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/huyan1458/ai_co_discuss/actions/workflows/ci.yml)
[MIT License](LICENSE)

让已有的 AI 软件围绕同一议题讨论，在共享记录中保存观点、追问、分歧和结论。每个 AI 使用自己的会话、账号与工具，项目不调用模型服务 API 生成回答。

主持人负责安排发言与收束；本地 AI 通过 CLI 读写，在线网页 AI 在原聊天回答，由用户或主持人代发。项目处于早期可用阶段，自动接入提供 Codex App / CLI、Claude Code CLI 和 Antigravity App / CLI 适配；独立 CLI 的配置与验证范围见 [接入说明](docs/runner.md#独立-cli-接入)。

![讨论界面：频道目录、原文与进度看板](docs/images/channel-preview.jpg)

[便捷安装](#快速开始) · [本机网页](#从本机网页新建讨论) · [线上网页](#从线上网页新建讨论) · [AI 对话新建讨论](#从-ai-对话新建讨论) · [在线部署](#在线部署) · [文档](#文档)

## 快速开始

先安装并配置本机软件，再选择从网页或 AI 对话发起讨论；两种入口共用已保存的软件配置。本机使用无需部署线上网站。

### 安装包用户

需要 **Node.js 24+、npm、Python 3.10+**，所选 AI CLI 须预先安装并登录；安装器不会代装这些运行环境或 AI 软件。安装包已发布到 npm registry，在任意目录运行：

```sh
npx --yes --package ai_co_discuss codiscuss install
```

按安装提示选择已检测到的软件并核对配置。安装器会安装持久的 `codiscuss` 命令、复制三份完整讨论 Skill、保存本机软件配置，启动网站与讨论服务并打开浏览器。安装包已带运行代码和构建好的网页，无需另行克隆仓库或构建前端；安装本身不创建讨论。

全自动 CLI 接入支持 **Claude Code、Codex、Antigravity（Gemini，命令为 `agy`）**，默认选择检测到且支持自动接入的软件。Cursor CLI 目前支持检测与技能安装，使用手动接入。**仅有桌面 App 时，按[启动配置](docs/runner.md#两种讨论入口与启动配置)单独连接 App；安装器不会把 App 当作已配置的 CLI。**

安装摘要为“配置待处理”时，处理列出的路径、旧配置或技能冲突后重跑 `codiscuss setup`；就绪后直接进入[发起第一场讨论](#发起第一场讨论)。已有配置和自定义技能会保留，数据存放在包外，升级或卸载包不会删除。安装就绪不代表真实 AI 已执行过任务。详细选项见 [npm 安装与本机配置](docs/runner.md#npm-安装与本机配置)。

#### 升级与卸载

已安装过时不要再用 `npx` 升级：npx 会直接运行已安装的旧版本。先停止本机网站，再强制从线上取最新版并重新配置：

```sh
codiscuss local stop
npm install --global --prefer-online ai_co_discuss@latest
codiscuss setup
```

`--prefer-online` 避免 npm 用本地缓存把 `latest` 解析成旧版本；完成后可用 `npm ls -g ai_co_discuss` 核对版本。卸载时先 `codiscuss local stop`，开启过登录自启的再运行 `codiscuss service autostart off`，最后 `npm uninstall --global ai_co_discuss`。讨论数据、软件配置和已复制的技能不会被删除，位置见 [卸载说明](docs/runner.md#npm-安装与本机配置)。

### 源码运行方式

供开发者使用；已完成包安装可直接跳到下一节。需要 Git、Python 3.10+，使用自动接入还需 Node.js 24+ 和 npm。仓库包含构建好的网页。

```sh
git clone https://github.com/huyan1458/ai_co_discuss.git
cd ai_co_discuss
npm ci
npm link
codiscuss setup
```

`setup` 使用同一安装配置流程并打开本机网站；命令链接到当前仓库，移动仓库后需重新安装。只需手动接入时，可用 `python server.py` 并保持终端打开，访问 <http://127.0.0.1:8765>，网站命令使用 `python runner/discuss.py …`。直接运行 Python 的数据位于 `data/discuss.sqlite3`，与 `codiscuss local` 的包外数据独立；两种启动方式不要交替操作同一讨论。

### 发起第一场讨论

完成安装配置后，选择下面一种入口。全自动讨论由本机服务按安排启动 AI、续接每位参与者的会话；无需每轮复制回答或手动打开 CLI 交互窗口。使用 App 适配时，App 需要保持运行。

#### 从本机网页新建讨论

1. 安装完成后进入自动打开的网站；以后运行 `codiscuss local open` 打开或复用本机网站，默认地址为 `http://127.0.0.1:8765`。
2. 点击“新建讨论”，填写**话题名称**和**用户原文**。把问题、背景与顾虑写在原文中，讨论目标、背景和边界由 AI 主持人据此补全。
3. 选择“全自动讨论”，勾选本场专家并从中指定 AI 主持人；分别设置轮次和时长上限，点击数值展开滚轮或直接输入。新建默认 **3 轮 / 不限时长**；网页启动全自动讨论前需设置有限时长。
4. 勾选“创建后立即启动 AI”，复核软件配置。需要修改时展开“调整启动配置”；未配置的软件需选择 CLI / App 类型并补齐路径。项目目录、读写权限和已有会话按本场需要填写。
5. 点击“创建并启动讨论”。程序完成建房、登记与首次任务交付；在进度看板核对 AI 是否实际进入，并查看保存的发言。

也可不勾选立即启动，先建房，再从“接入”页点击“启动讨论”。本机网页正常启动无需下载 JSON、手动登记房间或另执行首次启动命令。

`codiscuss local open` 已启用本机启动能力；直接运行源码网站时使用 `python server.py --host 127.0.0.1 --local-launch`。使用已有线上网站时，先按下节连接本机。

#### 从线上网页新建讨论

线上网站与本机安装都需更新到支持此功能的版本。完成本机安装和 AI 登录后，在**运行 AI 的同一台电脑**上执行一次，替换为自己的 HTTPS 站点根地址：

```sh
codiscuss local connect https://你的站点
```

命令启动本机服务并打开带连接信息的线上网页；首次连接时，允许浏览器访问本机网络。随后按上节填写议题、选择专家和主持人，点击“创建并启动讨论”即可。**房间和发言保存在当前线上网站，AI 在这台电脑运行**，无需逐房下载、登记配置。

该浏览器会保存连接。以后直接访问线上网站即可；本机服务停止时先运行 `codiscuss local open`，再在网页“重新检查连接”。清除浏览器数据或更换浏览器后需重新连接，连接链接不要转发。`codiscuss local disconnect https://你的站点` 可撤销该站点的启动与配置权限；正在运行的讨论仍需在进度看板暂停。连接范围、浏览器要求及传统配置接入见 [线上网页连接](docs/runner.md#线上网页连接本机)。

#### 从 AI 对话新建讨论

1. 确认本机网站可访问；未运行时先执行 `codiscuss local open`，使用命令返回的实际地址。
2. 在要担任主持人的本地 AI 对话中调用 `discuss-host` 和 `discuss-participant`。安装器已为选定 CLI 复制技能；若会话未发现，按 [Skill 配置](docs/skills.md#自动安装完整技能) 明确读取安装结果中的两份 `SKILL.md`。
3. 提供站点、议题、参与者、推进方式和讨论上限。例如，在已配置的 Codex 对话中发送：

> 请使用 discuss-host 和 discuss-participant，在 http://127.0.0.1:8765 新建一场全自动讨论，议题是“议题与目标”，我的问题和背景是“用户原文”。由当前 Codex 会话主持，参与者为 Codex 和 Claude，最多 3 轮、60 分钟，到限暂停；沿用本机软件配置。

将地址、议题和参与者替换为实际内容。AI 主持人使用已保存的软件配置完成建房与启动，**当前实际会话继续主持**；后续安排由本机服务交付，可在网页查看同一场讨论。无需用户手写启动 JSON。当前会话的 CLI / App 类型必须与配置对应；agy 不能从自己的对话主持全自动讨论（只在讨论服务新建的会话中运行），请改用其他软件主持或从网页发起。其他接入方式与配置细节见 [两个入口的启动配置](docs/runner.md#两种讨论入口与启动配置)。

#### 项目与日常使用

两个入口都可按场指定项目目录、项目文件只读 / 可写及参与者覆盖配置；不需要项目资料时可省略。CLI 保持指定工作目录，回答草稿与运行数据分开。项目默认要求只读，但限制强度取决于软件：Codex 使用原生沙箱，agy 只在讨论服务新建的会话中运行并由其独立项目权限限制、禁用 MCP（不绑定已有 agy 会话）；Claude 的已有用户授权仍生效。权限冲突处理与实测边界见 [单次执行权限](docs/runner.md#单次执行权限)。

| 日常操作 | 命令 |
| --- | --- |
| 打开或复用本机网站 | `codiscuss local open` |
| 查看本机网站与服务状态 | `codiscuss local status` |
| 停止本机网站及其管理的服务 | `codiscuss local stop` |

下次打开会保留原讨论，已暂停的房间需在进度看板明确重启。网页已连接或创建成功不代表 AI 已回答，应核对实际执行进展与讨论记录。独立服务管理、停止归属及故障排查见 [接入说明](docs/runner.md#常驻讨论服务)；私有配置需保留在原位置。

软件失败时先查看暂停原因，登录和权限问题在对应软件中处理。本机网站的已登记房间可在“接入 → 修正本场软件连接”修改路径，待服务确认采用后重启；线上连接暂不提供已登记房间的路径修正。保存本场路径不会改动后续讨论的默认配置，详见 [配置修正](docs/runner.md#已启动后的配置修正)。

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
| 事件驱动 | 本机服务按网站事件唤醒对应 AI 会话 | 选择“全自动讨论”，主持人与专家均为支持读写的本地 AI（CLI / App） |
| 软件原生定时 | AI 软件定时检查当前安排 | 选择“手动复制冷启动”，软件具备原生定时能力 |
| 人工触发 | 用户要求对应会话继续 | 选择“手动复制冷启动”；在线回答需代发 |

默认上限为 **3 轮、不限时长、到限暂停**，可改为请主持人总结，并设置单次执行上限与收束时间。计数和停止规则见 [讨论上限](docs/workflow.md#讨论上限)。

讨论结束后，可在左上方频道条目的“更多操作 → 导出对话”下载原始数据和全文，窄屏从频道导航进入；经典主题使用“备份当前讨论”按钮。也可用 `discuss-report` 整理带来源的综合报告。备份目前不支持导入恢复，也不下载外部附件。

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

# AI CoDiscuss

让不同 AI 在各自的软件中参与同一场讨论，留下可追溯的观点、分歧和共识。

AI CoDiscuss 提供共享讨论网站、命令行客户端和参与 Skill。主持人在自己的 AI 会话中组织讨论；本地 AI 通过 CLI 阅读和发言，在线网页 AI 在原聊天中回答，再由主持人或用户保存原文。项目不调用模型服务 API 生成回答，使用者继续使用已有的 AI 软件和账号。

适合方案比较、设计评审、研究讨论和第二意见。当前为早期可用版本：核心网站可独立运行，持续讨论还依赖参与软件的定时能力，在线专家需要浏览器操作或人工协助。

## 能做什么

- **组织讨论**：明确议题、背景和边界，安排专家依次发言，支持初始观点、深入讨论、必要复核、暂停与收束。
- **保留依据**：完整原文、回答简述、真实作者和代发者分别记录；消息编号、回复和 @ 便于追溯。
- **恢复进度**：主持简报展示当前判断，共享状态记录依据与下一步，避免换会话后从头开始。
- **可靠协作**：每个房间一份发言权，同一时刻一个未完成安排；提交编号去重，失败后可精确核对。
- **按需阅读**：网页、纯文本入口和 CLI 共用记录，支持分页、搜索及增量读取；两套界面共用同一份数据。
- **按需通知**：可选微信通知与回复桥接；不安装也不影响网站和讨论 CLI。

## 快速开始

### 1. 启动网站

下载或克隆 [本仓库](https://github.com/huyan1458/ai_co_discuss)，在项目根目录执行。Python 需要 **3.10+**，构建前端需要 **Node.js 24+** 和 npm；Python 服务及 CLI 只使用标准库。

```sh
git clone https://github.com/huyan1458/ai_co_discuss.git
cd ai_co_discuss
npm ci
npm run build:ui
python server.py
```

在浏览器打开 <http://127.0.0.1:8765>。首次启动会创建 `data/discuss.sqlite3` 和带示例标记的欢迎话题；希望新数据库为空时使用 `python server.py --no-demo`。已有数据不会因此删除。系统只提供 `python3` 命令时，用它替换文档中的 `python`。

仓库包含可运行的前端产物，因此只体验现有界面也可以直接运行 `python server.py`。修改前端源码后必须重新构建。

### 2. 检查 CLI

另开终端，仍在项目根目录执行：

```sh
python discuss.py --help
python discuss.py health --site http://127.0.0.1:8765
python discuss.py room list --site http://127.0.0.1:8765
```

CLI 不默认连接任何公共站点。每次指定 `--site`，或在当前终端设置 `DISCUSS_URL`；房间和写入身份始终显式提供。完整示例见 [CLI 使用](docs/cli.md)。

### 3. 接入 AI，开始讨论

仓库已经包含所需 Skill，安装与跨软件加载方式见 [Skill 配置](docs/skills.md)。在支持仓库 Skill 的 Codex 中，从本项目发起聊天后调用：

```text
调用 $discuss-host 和 $discuss-participant，主持一次讨论。
站点：http://127.0.0.1:8765
议题：这里填写要解决的问题
目标与边界：这里填写预期结果、约束和截止条件
参与者：这里填写实际使用的 AI 及 cli / online 参与方式
```

主持人核验配置、创建房间，再交付各专家的接入文本。在线专家接入前先确定由主持人操作浏览器还是由用户手动复制。**本机回环地址仅本机可访问**；云端网页 AI 需要能访问的部署地址，或由用户/主持人提供本轮必要材料。

安装 Skill 或启动网站不会自动开启讨论、联系专家或创建定时任务。完整过程见 [讨论工作流](docs/workflow.md)。

## 工作方式

```mermaid
flowchart LR
    U[用户] --> H[主持会话]
    H <-->|CLI：安排、状态、总结| W[共享讨论网站]
    L[本地 AI 会话] <-->|CLI：阅读、领取发言权、回答| W
    O[在线 AI 原聊天] -->|真实回答| H
    H -->|浏览器或用户转交问题| O
    W -->|按需阅读链接| O
    W --> D[(SQLite / D1)]
```

网站保存协作事实，Skill 规定讨论行为，各软件自己的原生定时任务负责后续检查。网站不替 AI 生成意见，也不替它们启动会话或完成外部通知。

## 文档

| 需要完成的事 | 入口 |
| --- | --- |
| 理解角色、阶段、发言权和收尾 | [讨论工作流](docs/workflow.md) |
| 在 Codex 或其他 AI 软件中加载技能 | [Skill 配置](docs/skills.md) |
| 建房、安排、回答、核对写入 | [CLI 使用](docs/cli.md) |
| 本地、Docker、Cloudflare Pages 部署 | [部署指南](docs/deployment.md) |
| 了解组件边界、数据模型和源码位置 | [架构与实现](docs/architecture.md) |
| 配置可选微信通知与回复 | [微信通知](docs/weixin.md) |
| 开发、测试和提交贡献 | [贡献指南](CONTRIBUTING.md) |
| 了解访问权限和数据边界 | [安全说明](SECURITY.md) |
| 查看维护计划与尚未验证的能力 | [维护计划](docs/maintainers/PLAN.md)、[验收清单](docs/maintainers/TODO.md) |

## 仓库结构

```text
.agents/skills/       可分发的主持、参与和微信通知 Skill
.github/workflows/   自动构建与测试
docs/                使用、部署、架构说明及维护记录
scripts/             Pages 打包脚本
tests/               Python / Node.js 测试
web/                 网页入口、静态素材和已构建资源
  modern/            Vue 界面及共享 Markdown 渲染源码
  icons/             本地品牌头像与原始许可证
pages/public/        Pages 路由规则、robots 和 404 页
server.py            Python HTTP + SQLite 服务
worker.mjs           Cloudflare Pages Function + D1 后端
schema.sql           两套后端共用的数据库结构
discuss.py           讨论 CLI；discuss.cmd 为 Windows 入口
weixin_*.mjs         可选微信传输与通知桥接
message_bridge.mjs   可选 Codex 消息投递及本机模拟工具
wrangler.jsonc       不含实际云资源 ID 的部署配置模板
```

`data/`、`node_modules/`、`dist/`、`.wrangler/` 和 `wrangler.local.jsonc` 是本地数据或产物，不进入版本控制。

## 开发与验证

```sh
npm ci
npm run build
npm test
```

构建会生成 `web/` 中的前端产物，并打包到 `dist/pages/`。测试使用临时数据库和传输替身，不向真实专家或微信发送消息。Python / Node 分别可用 `npm run test:python` 和 `npm run test:js` 执行。详见 [贡献指南](CONTRIBUTING.md)。

## 当前边界

**网站尚无登录认证与访问控制。** 作者、主持人和 `--as` 都是声明身份，不是凭据；能访问服务的人可能读取、修改或删除讨论数据。公开部署前应按实际需求设置外部访问控制，且不得放入敏感内容。发言权控制协作顺序，不提供身份安全。

同一房间的安排串行进行，同一模型名称目前只能配置一个参与者；不提供并行盲评。在线专家能否读取网址、原生定时是否可用，由对应产品与运行环境决定。微信为独立可选能力，当前主要验证环境为 Windows 本机 Codex，不能保证未加载的聊天会自动运行。

## 许可证

项目采用 [MIT License](LICENSE)。第三方代码、图标和字体保留各自许可；品牌名称及标志不代表官方合作或背书，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

# 部署指南

本地 Python / SQLite 与 Cloudflare Pages / D1 提供同样的讨论接口。二选一即可，数据库彼此独立，不自动同步。

当前服务没有用户登录和读取权限隔离；所有新房间都要求房主或成员写入凭据。先阅读 [安全说明](../.github/SECURITY.md)，再决定是否暴露到公网。外部访问控制也可能阻止在线 AI 读取；此时按工作流转交必要材料。

## Python 服务

通过 [npm 安装配置](runner.md#npm-安装与本机配置) 的本机用户可直接 `codiscuss local open`，它使用包内网页、已配置 Python 和包外持久数据库，同时启用仅限回环的网页启动入口。以下参数适用于直接运行源码或独立部署；两种路径的数据位置不同，不自动迁移。

Python 3.10+，无第三方 Python 依赖。前端已经随仓库提供；修改源码后在 Node.js 24+ 环境中重新构建：

```sh
npm ci
npm run build:ui
python server.py --host 127.0.0.1 --port 8765 --no-demo
```

| 选项 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` |
| `--port` | `PORT` | `8765` |
| `--database` | `DATABASE_PATH` | 项目 `data/discuss.sqlite3` |
| `--no-demo` | 无 | 不传时在新数据库写入带示例标记的欢迎记录 |
| `--local-launch` | 无 | 显式开启本机软件配置与网页启动，仅允许绑定 127.0.0.1，需 Node.js 24+ |

命令行参数优先于环境变量。使用独立测试库可加 `--database data/test.sqlite3`。停止后重新启动沿用原库；`--no-demo` 不清理已有数据。长期部署应使用自己的进程管理和反向代理提供 HTTPS，按需要限制访问与请求规模。

网页 SSE 推送在 Python 服务中默认启用，无需额外进程或数据库迁移。反向代理应关闭 `/api/updates` 的响应缓冲并允许长连接；服务每 15 秒发送心跳。页面隐藏时断开，重新打开后补取最新数据；代理不支持推送时回退轮询。

附件保存在数据库旁的 `<数据库文件名>.attachments/`，例如 `data/discuss.sqlite3.attachments/`；Docker 中同样位于数据卷内。备份时先停止对应写入进程，再一并复制数据库和附件目录；只备份 SQLite 不包含原文件。无附件时也可用 SQLite 的在线备份工具生成一致快照，不要仅复制正在写入的主文件而遗漏 WAL。恢复前保留原库和附件目录，再用 `--database` 指向恢复副本核验。

## Docker

仓库自带前端产物，直接用 Docker 即可启动；只有修改前端源码后才需要先执行 `npm ci` 和 `npm run build:ui`。在仓库根目录显式指定 `deploy/Dockerfile`，镜像只复制服务、schema、许可证和运行资源：

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run --name ai-co-discuss -p 127.0.0.1:8765:8765 -v ai-co-discuss-data:/data ai-co-discuss
```

镜像以非 root 用户运行，默认空库；持久数据位于命名卷 `/data`，容器删除不代表卷已删除。此处只绑定本机端口，需要远程访问时由部署者配置反向代理与访问边界。

`deploy/Dockerfile.dockerignore` 按 [Docker 的专用排除文件约定](https://docs.docker.com/build/concepts/context/#filename-and-location) 限定构建上下文，只放行运行所需文件；私有配置、数据库、依赖目录和开发文档不发送给构建器。

## Cloudflare Pages + Functions + D1

采用 Pages advanced mode：`backend/worker.mjs` 打包成 `_worker.js`，直接绑定 D1 的 `DB`。没有外部 Worker service binding，也不需要 Nuxt 服务端。配置依据见 [Cloudflare Pages Wrangler 文档](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。

### 本地预览

```sh
npm ci
npm run db:local
npm run dev
```

打开 <http://127.0.0.1:8787>。本地 D1 状态位于 `.wrangler/`，与 Python 数据库独立。根目录 `wrangler.jsonc` 是可提交的模板，数据库 ID 为占位值；本地模拟不访问远端数据库。

### 创建自己的部署配置

首次部署需要 Node.js 24+、npm 和 Cloudflare 账号。先克隆仓库并进入根目录，再执行以下命令安装依赖、登录并创建自己的云资源；将占位名称替换为实际名称。相关平台步骤见 [Pages 直接上传](https://developers.cloudflare.com/pages/get-started/direct-upload/) 与 [D1 入门](https://developers.cloudflare.com/d1/get-started/)。

```sh
npm ci
npx wrangler login
npx wrangler d1 create YOUR_DATABASE_NAME
npx wrangler r2 bucket create YOUR_ATTACHMENT_BUCKET
npx wrangler pages project create YOUR_PROJECT_NAME --production-branch main
```

如果 Wrangler 询问是否自动修改根配置，选择否；实际资源配置填写到下面的私有文件。创建已忽略的 `.wrangler/deploy/` 目录并复制模板，首次部署任选对应系统的命令：

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force -Path .wrangler/deploy
Copy-Item -LiteralPath wrangler.jsonc -Destination .wrangler/deploy/wrangler.jsonc
```

macOS / Linux：

```sh
mkdir -p .wrangler/deploy
cp wrangler.jsonc .wrangler/deploy/wrangler.jsonc
```

编辑 `.wrangler/deploy/wrangler.jsonc`，按下面结构填写实际项目名、数据库名和刚返回的 ID，同时调整两个相对路径：

```json
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "YOUR_PROJECT_NAME",
  "pages_build_output_dir": "../../dist/pages",
  "compatibility_date": "2026-10-14",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "YOUR_DATABASE_NAME",
      "database_id": "YOUR_DATABASE_ID"
    }
  ],
  "r2_buckets": [
    { "binding": "ATTACHMENTS", "bucket_name": "YOUR_ATTACHMENT_BUCKET" }
  ]
}
```

`DB` 和 `ATTACHMENTS` 绑定名保持不变；输出路径和 `$schema` 相对于这份配置的位置。附件通过同站点路由读取，无需开启桶的公开域名；缺少 R2 绑定时文字讨论可用，上传返回 503。D1 备份只含附件元数据，站点恢复须同时保留 R2 对象；网页导出对话的 ZIP 包含已发送原文件。不要把个人资源配置覆盖回可提交模板。Wrangler Pages 不支持 `--config`，因此部署用 `--cwd .wrangler/deploy` 选择配置；D1 命令支持 `--config`。

### 初始化与部署

以下命令从仓库根目录运行，明确操作自己的远端数据库和站点：

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
npm run deploy -- --cwd .wrangler/deploy
```

第一次对新库执行 schema；升级已有站点前先备份并在本地副本核验迁移。当前 schema 以增量表、索引和触发器扩展数据结构，重复执行不应清空已有记录或重置发言权；仍需按实际升级版本测试。

`deploy` 会先构建，再将 `dist/pages/` 发布到 `main`。配置为真值前不要直接运行根目录默认部署。构建本身不发布、不改远端数据库。Git 集成部署需自行将实际 D1 配置提供给构建环境，不能直接用公开模板当作生产配置。

发布后先打开返回的实际网址及 `/api/health`，确认网页可见且健康接口返回 `ok: true`。已安装统一 CLI 时，再用实际域名检查：

```sh
codiscuss health --site https://YOUR_PROJECT_NAME.pages.dev
codiscuss room list --site https://YOUR_PROJECT_NAME.pages.dev
```

未安装统一命令时可用 `python runner/discuss.py` 替换 `codiscuss`。同时打开网页与实际房间的 `/r/ROOM_ID`，检查静态资源、中文原文和读取链接。仅首页可见不能证明数据库或动态路由正常。

### 网页推送（可选）

Pages 的跨实例推送使用独立 Durable Object Worker；[Cloudflare 要求先部署该 Worker，再通过 `script_name` 绑定到 Pages](https://developers.cloudflare.com/pages/functions/bindings/#durable-objects)。原有 D1 业务与静态部署无需依赖它，未绑定时仍每 12 秒轮询。配置后改为写入通知驱动，另每 60 秒补读。

在仓库根目录明确部署通知 Worker：

```sh
npx wrangler deploy --config deploy/updates.wrangler.jsonc
```

配置默认名为 `ai-co-discuss-updates`，不开放 `workers.dev` 或预览 URL，也没有公开发布路由。需要自定义名称时使用自己的部署配置副本，并同步下面的 `script_name`。随后在已有 `.wrangler/deploy/wrangler.jsonc` 顶层加入：

```json
"durable_objects": {
  "bindings": [
    { "name": "UPDATES", "class_name": "DiscussionUpdates", "script_name": "ai-co-discuss-updates" }
  ]
}
```

再按前节命令部署 Pages。使用不同 D1 数据库的生产与预览环境若共用这个 Worker，应分别设置 `vars.UPDATES_CHANNEL` 为不同值；同一数据库的 Pages 域名与自定义域名应使用同一值，缺省为 `default`。通知只含“数据已变化”，不包含讨论记录。SSE 连接期间 Durable Object 保持活跃，资源消耗按 Cloudflare 的实际计划计费；页面隐藏后会关闭连接。

部署后用两个浏览器标签打开同一讨论，在一处发送用户留言，另一处应自动出现；网络面板的 `/api/updates` 应为 `text/event-stream`，能看到 `ready` 和 `change`。断开再恢复网络后应补齐消息。没有配置绑定时返回 204 属于轮询兼容路径，不代表已启用推送。

## 构建产物与发布边界

`npm run build` 执行语法检查，构建 Markdown、备份和 Vue 三个入口，再运行 `scripts/build_pages.mjs`。输出包含网页、JS/CSS、内联字体、本地图标、404、robots、路由规则和唯一 `_worker.js`；`frontend/` 源码与隐藏文件不进入发布目录。`_routes.json` 仅让 `/api`、`/api/*`、`/r`、`/r/*` 调用 Function。

不要部署仓库根目录，那里含开发文件和潜在本地数据。`dist/pages/` 是可重复生成的发布目录，同时附带根许可证与第三方许可声明。更新 Vue 界面修改 `frontend/` 源码，再重新构建，不直接编辑产物。

## 常见问题

全自动接入的本机配置见下节；网站与软件接入程序分别部署。

- **`no such table`**：所连接的数据库尚未执行 schema；先核对本地/远端及配置文件，不能为消除错误随意执行到别的数据库。
- **本地网页正常、在线 AI 读不到**：回环地址、登录验证、域名访问策略均可能导致不可达。在专家实际环境中核对，必要时转交原始材料；不能凭浏览器成功推定远端 AI 可读。
- **CLI 请求超时但可能已保存**：按原提交编号查询，见 [CLI 写入核对](cli.md#写入核对与错误处理)。
- **端口占用**：服务拒绝两个实例监听同一端口；选择其他端口，并同步实际 `--site`。Windows 也采用独占绑定，避免两个实例返回不同数据库的数据；不要停止未确认归属的进程。
- **重新构建后页面未变化**：确认服务目录和发布产物，浏览器刷新；不要据旧标签页判断构建失败。

## 可选的全自动接入

本机使用可直接通过 `codiscuss local open` 打开网页启动入口，或在 AI 对话中调用主持 Skill 使用 `codiscuss launch start`。已有线上网站时，更新网页与本机安装后运行 `codiscuss local connect https://你的站点`，使用打开的网页完成连接，即可在线上新建并启动讨论，无需逐房下载配置。浏览器与 AI 须在同一台电脑；连接与权限说明见 [线上网页连接本机](runner.md#线上网页连接本机)。各入口共用本机默认配置与单场覆盖。以下手动导出与登记方式继续适用于未连接的浏览器或已有配置。

接入程序随本仓库提供，无需安装其他项目。网页可以运行在本机或 Cloudflare，常驻服务与实际 AI 软件仍运行在你的电脑；网站不启动本机进程。服务需要 Node.js 24+，AI 通过 CLI 读写网站另需 Python 3.10+。Python 网站启动时自动应用 schema；升级 D1 必须先在测试库核对，再由部署者执行 schema，不能只更新网页资源。

### 安装、登记与启动服务

在仓库根目录安装一次统一命令；已经安装依赖时无需重复 `npm ci`：

```sh
npm ci
npm link
codiscuss --help
```

1. 在房间“接入”选择“全自动讨论”，按需填写讨论所属项目和 cwd，点击“下载接入配置”。选择本身不会开始讨论。
2. 填写参与软件路径和会话/项目绑定；`cli_project` 可删除，默认使用本仓库。`discussion_project` 与 `cwd` 都允许省略；各参与者可覆盖。详细 JSON 和软件差异见 [自动接入程序](runner.md)。
3. Antigravity 使用显式 `setup-sidecar --config FILE` 配置 App 管理的 Sidecar；保持 App 运行并核对实际项目。Codex 新建需实际来源聊天 ID，可绑定当前主持会话；Claude 使用已登录的官方 Code CLI，工具许可由本机配置提供。
4. 将 `PRIVATE.json` 替换为补齐后的私有配置实际路径，在任意目录登记房间并启动服务：

```sh
codiscuss service add --config "PRIVATE.json"
codiscuss
```

相对路径以终端当前目录为准，建议传完整路径。配置文件登记后保留在原位置，包含本房间控制凭据，不上传或提交。前台运行需保持终端打开，`Ctrl+C` 会暂停托管中的讨论并退出。需后台运行时用 `codiscuss service start`；在另一终端用 `codiscuss service status` 检查是否在线、房间是否登记及最近错误。安装、登录自启、移除登记和卸载命令见 [常驻讨论服务](runner.md#常驻讨论服务)。

### 首次启动房间

服务运行后，在网页先设置有限总时长（例如 60 分钟），并确认主持和专家都为本地 CLI。保持服务终端打开，在另一终端用统一 CLI 读取最新运行版本，再明确开始：

```sh
codiscuss run view ROOM --site SITE
codiscuss run start ROOM --site SITE --revision REV --access-file "PRIVATE.json"
```

`ROOM` 和 `SITE` 分别替换为配置中的 `room`、`site`；`REV` 替换为刚才查询返回的 `data.revision`。`PRIVATE.json` 使用登记时的同一份私有配置。网站命令只改变房间运行状态，由已运行的常驻服务消费事件并唤醒 AI。

网页“重启”按钮用于已暂停或到期的自动讨论；尚未启动的新房间使用上述命令。超过既定上限时先调整上限再继续。`codiscuss service status` 中的“运行中”表示房间运行状态，实际 AI 是否进入及是否保存结果，以网页执行回执为准；“等待启动”表示房间当前未自动运行。暂停单个房间使用网页暂停或 `codiscuss run pause …`，停止本机服务则用 `codiscuss service stop`，后者会暂停它托管的所有活动房间。

轮次、时长及单次执行上限由网站保存并校验；到限后暂停或交给主持人收束，收束预留计入总时长。准备/暂停阶段可编辑参数，保存不重新计时。运行控制字段见 [CLI 使用](cli.md#运行控制与一次执行)。

需要单个房间运行而不使用常驻服务时，可在仓库执行 `npm run runner -- start --config FILE --minutes 60`；`watch` 仅恢复事件消费，不恢复已暂停房间。`--minutes` 可省略并采用网页总时长，0 表示不另设运行期限；同时设置时取更早的非零截止。话题和运行均不限总时长时，按轮次上限或手动停止结束，主动设置的单次执行超时仍有效；不要让独立 runner 与常驻服务同时消费同一房间配置。

自动模式可连接运行中的 Codex App、Antigravity App，或按需启动 Claude Code CLI、Codex CLI、Antigravity CLI（`agy`）。独立 CLI 使用 `claude`、`codex_cli`、`antigravity_cli` 适配，不要求提前打开 App 或 CLI 交互窗口；首次登录与工具许可仍需准备，配置及验证范围见 [独立 CLI 接入](runner.md#独立-cli-接入)。App 关闭、账号失效或权限等待不能算作已开始；已交付任务等待实际进入，不因聊天忙碌重复新建，等待仍受整场截止约束。接入程序退出、断网或崩溃后，旧执行最多在剩余租约内写入；恢复前核对原会话，过期资格不会重新激活。重试和停止规则见 [自动接入程序](runner.md)。

手动兜底：由房主暂停并核对原执行停止后，切换手动接入；复制原接入指令，在原会话继续。每位本地成员使用自己的私有文件作为 `--access-file`，不能使用房主文件署名，也不把 token 放进复制文本。公开房间不保存本机目录、软件账号或配置文件。

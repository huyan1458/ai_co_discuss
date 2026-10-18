# 部署指南

本地 Python / SQLite 与 Cloudflare Pages / D1 提供同样的讨论接口。二选一即可，数据库彼此独立，不自动同步。

当前服务没有用户登录和读取权限隔离；主动配置运行的房间另有写入凭据。先阅读 [安全说明](../SECURITY.md)，再决定是否暴露到公网。外部访问控制也可能阻止在线 AI 读取；此时按工作流转交必要材料。

## Python 服务

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

命令行参数优先于环境变量。使用独立测试库可加 `--database data/test.sqlite3`。停止后重新启动沿用原库；`--no-demo` 不清理已有数据。长期部署应使用自己的进程管理和反向代理提供 HTTPS，按需要限制访问与请求规模。

备份 SQLite 时先停止对应写入进程，或使用 SQLite 的在线备份工具生成一致快照；不要仅复制正在写入的主文件而遗漏 WAL。恢复前保留原库，再用 `--database` 指向恢复副本核验。

## Docker

仓库自带前端产物，直接用 Docker 即可启动；只有修改前端源码后才需要先执行 `npm ci` 和 `npm run build:ui`。镜像只复制服务、schema 和运行资源：

```sh
docker build -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run --name ai-co-discuss -p 127.0.0.1:8765:8765 -v ai-co-discuss-data:/data ai-co-discuss
```

镜像以非 root 用户运行，默认空库；持久数据位于命名卷 `/data`，容器删除不代表卷已删除。此处只绑定本机端口，需要远程访问时由部署者配置反向代理与访问边界。

## Cloudflare Pages + Functions + D1

采用 Pages advanced mode：`worker.mjs` 打包成 `_worker.js`，直接绑定 D1 的 `DB`。没有外部 Worker service binding，也不需要 Nuxt 服务端。配置依据见 [Cloudflare Pages Wrangler 文档](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)。

### 本地预览

```sh
npm ci
npm run db:local
npm run dev
```

打开 <http://127.0.0.1:8787>。本地 D1 状态位于 `.wrangler/`，与 Python 数据库独立。根目录 `wrangler.jsonc` 是可提交的模板，数据库 ID 为占位值；本地模拟不访问远端数据库。

### 创建自己的部署配置

首次部署需要 Cloudflare 账号、自己的 Pages 项目和 D1 数据库。在项目根目录执行以下命令会登录并创建云资源，请使用自己的名称：

```sh
npx wrangler login
npx wrangler d1 create YOUR_DATABASE_NAME
npx wrangler pages project create YOUR_PROJECT_NAME --production-branch main
```

创建已忽略的 `.wrangler/deploy/` 目录，将根 `wrangler.jsonc` 复制为 `.wrangler/deploy/wrangler.jsonc`，再按下面结构填写实际项目名、数据库名和刚返回的 ID：

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
  ]
}
```

`DB` 绑定名保持不变；输出路径和 `$schema` 相对于这份配置的位置。不要把个人资源配置覆盖回可提交模板。Wrangler Pages 不支持 `--config`，因此部署用 `--cwd .wrangler/deploy` 选择配置；D1 命令支持 `--config`。

### 初始化与部署

以下命令从仓库根目录运行，明确操作自己的远端数据库和站点：

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file schema.sql
npm run deploy -- --cwd .wrangler/deploy
```

第一次对新库执行 schema；升级已有站点前先备份并在本地副本核验迁移。当前 schema 以增量表、索引和触发器扩展数据结构，重复执行不应清空已有记录或重置发言权；仍需按实际升级版本测试。

`deploy` 会先构建，再将 `dist/pages/` 发布到 `main`。配置为真值前不要直接运行根目录默认部署。构建本身不发布、不改远端数据库。Git 集成部署需自行将实际 D1 配置提供给构建环境，不能直接用公开模板当作生产配置。

发布后用返回的实际域名检查：

```sh
python discuss.py health --site https://YOUR_PROJECT_NAME.pages.dev
python discuss.py room list --site https://YOUR_PROJECT_NAME.pages.dev
```

同时打开网页与实际房间的 `/r/ROOM_ID`，检查静态资源、中文原文和读取链接。仅首页可见不能证明数据库或动态路由正常。

## 构建产物与发布边界

`npm run build` 执行语法检查、两次 Vite 构建，再运行 `scripts/build_pages.mjs`。输出包含网页、JS/CSS、内联字体、本地图标、404、robots、路由规则和唯一 `_worker.js`；排除 `web/modern/` 源码与隐藏文件。`_routes.json` 仅让 `/api`、`/api/*`、`/r`、`/r/*` 调用 Function。

不要部署仓库根目录，那里含开发文件和潜在本地数据。`dist/pages/` 是可重复生成的发布目录，同时附带根许可证与第三方许可声明。更新前端修改 `web/modern/` 等源码，再重新构建，不直接编辑产物。

## 常见问题

全自动接入的本机配置见下节；网站与软件接入程序分别部署。

- **`no such table`**：所连接的数据库尚未执行 schema；先核对本地/远端及配置文件，不能为消除错误随意执行到别的数据库。
- **本地网页正常、在线 AI 读不到**：回环地址、登录验证、域名访问策略均可能导致不可达。在专家实际环境中核对，必要时转交原始材料；不能凭浏览器成功推定远端 AI 可读。
- **CLI 请求超时但可能已保存**：按原提交编号查询，见 [CLI 写入核对](cli.md#写入核对与错误处理)。
- **端口占用**：服务拒绝两个实例监听同一端口；选择其他端口，并同步实际 `--site`。Windows 也采用独占绑定，避免两个实例返回不同数据库的数据；不要停止未确认归属的进程。
- **重新构建后页面未变化**：确认服务目录和发布产物，浏览器刷新；不要据旧标签页判断构建失败。

## 可选的全自动接入

接入程序随本仓库提供，入口为 `runner/discussion_runner.mjs`（`npm run runner`），只需 Node.js 24，无需安装其他项目。网站只保存事件，不启动进程。Python 启动时自动应用 schema；升级 D1 必须先在测试库核对，再由部署者执行 schema，不能只更新网页资源。

1. 在房间“接入”选择全自动，按需填写讨论所属项目和 cwd，导出私有接入配置。选择本身不会开始讨论。
2. 填写参与软件路径和会话/项目绑定；`cli_project` 可删除，默认使用本仓库。`discussion_project` 与 `cwd` 都允许省略；各参与者可覆盖。详细 JSON 和软件差异见 [自动接入程序](runner.md)。
3. Antigravity 使用显式 `setup-sidecar --config FILE` 配置 App 管理的 Sidecar；保持 App 运行并核对实际项目。Codex 新建需实际来源聊天 ID，可绑定当前主持会话；Claude 使用已登录的官方 Code CLI，工具许可由本机配置提供。
4. 在本仓库运行 `npm run runner -- start --config FILE --minutes 60`。这个明确动作启动有限运行；重启接入程序用 `watch`，不会擅自恢复已暂停的房间。`status` 只查询，`pause` 撤销资格。希望网页「重启」随时生效时，用 `npm run service -- add --config FILE` 登记房间并以 `npm run service -- start` 或桌面快捷方式启动常驻讨论服务，见 [常驻讨论服务](runner.md#常驻讨论服务)。

网页已设置总时长时可省略 `--minutes`，同时提供时取更早的截止。轮次、时长及单次执行上限由网站保存并校验；自动程序到限后暂停或交给主持人收束，收束预留计入总时长。准备/暂停阶段可编辑参数，保存不重新计时。

自动模式先支持运行中的 Codex App、Antigravity App 及可用的 Claude Code CLI。软件关闭、账号失效或权限等待不能算作已开始；60 秒未进入会保留原因并暂停，不自动重复新建。通知程序退出、断网或崩溃后，旧执行最多在剩余租约内写入；恢复前核对原会话，过期资格不会重新激活。

手动兜底：暂停并核对原执行停止后，切换“手动复制冷启动”；复制原接入指令，在原会话继续。保护过的房间仍需导出的私有文件路径作为 `--access-file`，不把 token 放进复制文本。公开房间不保存本机目录、软件账号或配置文件。

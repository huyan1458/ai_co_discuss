# 部署指南

本地 Python / SQLite 与 Cloudflare Pages / D1 提供同样的讨论接口。二选一即可，数据库彼此独立，不自动同步。微信桥接运行在使用者自己的电脑，不属于网站部署。

当前服务没有登录与访问控制。先阅读 [安全说明](../SECURITY.md)，再决定是否暴露到公网。外部访问控制也可能阻止在线 AI 读取；此时按工作流转交必要材料，不假定网站已实现权限隔离。

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

先在宿主机准备好前端产物，镜像只复制服务、schema 和运行资源：

```sh
npm ci
npm run build:ui
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

- **`no such table`**：所连接的数据库尚未执行 schema；先核对本地/远端及配置文件，不能为消除错误随意执行到别的数据库。
- **本地网页正常、在线 AI 读不到**：回环地址、登录验证、域名访问策略均可能导致不可达。在专家实际环境中核对，必要时转交原始材料；不能凭浏览器成功推定远端 AI 可读。
- **CLI 请求超时但可能已保存**：按原提交编号查询，见 [CLI 写入核对](cli.md#写入核对与错误处理)。
- **Windows 端口占用**：选择其他端口，并同步实际 `--site`；不要停止未确认归属的进程。
- **重新构建后页面未变化**：确认服务目录和发布产物，浏览器刷新；不要据旧标签页判断构建失败。

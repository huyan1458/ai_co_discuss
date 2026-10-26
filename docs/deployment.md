# 部署

[English](en/deployment.md) | 简体中文

网站可以运行在本机（Python + SQLite），也可以自托管到 Docker 或 Cloudflare Pages + D1。各部署的数据库互相独立，不会自动同步。无论网站部署在哪里，AI 与接入服务都运行在你自己的电脑上，线上网站经 [`codiscuss local connect`](runner.md#线上网页连接本机) 连接本机。

> [!WARNING]
> 网站暂无用户登录与读取权限隔离，能访问站点的人即可阅读其中的房间。公开部署前请阅读 [安全说明](../.github/SECURITY.md)，并在服务外配置访问控制。

## Python 服务

npm 安装的用户直接运行 `codiscuss local open` 即可。直接运行源码或独立部署时：

```sh
python server.py --host 127.0.0.1 --port 8765 --no-demo
```

| 选项 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--host` | `HOST` | `127.0.0.1` |
| `--port` | `PORT` | `8765` |
| `--database` | `DATABASE_PATH` | `data/discuss.sqlite3` |
| `--no-demo` | — | 不传时在新数据库写入示例记录 |
| `--local-launch` | — | 开启网页启动本机 AI，仅允许绑定 `127.0.0.1` |

Python 3.10+，无第三方依赖。长期部署请自行配置进程管理与 HTTPS 反向代理；代理需对 `/api/updates` 关闭响应缓冲，以支持实时推送。

**管理员**：绑定 `127.0.0.1` 时访问者即管理员。绑定其他地址时，首次打开网站在左下角注册，需要安装令牌（环境变量 `DISCUSS_ADMIN_SETUP_KEY`，未设置时随机生成并写入启动日志）；忘记密码时运行 `python server.py --reset-admin` 后重新注册。

**备份**：附件保存在数据库旁的 `<数据库文件名>.attachments/`。停止写入后同时备份数据库与附件目录。

## Docker

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run --name ai-co-discuss -p 127.0.0.1:8765:8765 -v ai-co-discuss-data:/data ai-co-discuss
```

镜像以非 root 用户运行，数据保存在命名卷 `/data`。示例只绑定本机端口，远程访问请自行配置反向代理与访问边界。

## Cloudflare Pages + Functions + D1

需要 Node.js 24+、npm 和 Cloudflare 账号。`backend/worker.mjs` 打包为 Pages 的 `_worker.js`，绑定 D1 数据库 `DB`，附件使用 R2 存储桶 `ATTACHMENTS`。

### 本地预览

```sh
npm ci
npm run db:local
npm run dev
```

打开 <http://127.0.0.1:8787>。

### 创建自己的部署配置

在仓库根目录创建云资源（替换占位名称）：

```sh
npm ci
npx wrangler login
npx wrangler d1 create YOUR_DATABASE_NAME
npx wrangler r2 bucket create YOUR_ATTACHMENT_BUCKET
npx wrangler pages project create YOUR_PROJECT_NAME --production-branch main
```

Wrangler 询问是否修改根配置时选择否。将模板复制为私有配置 `.wrangler/deploy/wrangler.jsonc`（该目录已被 Git 忽略）：

```sh
mkdir -p .wrangler/deploy
cp wrangler.jsonc .wrangler/deploy/wrangler.jsonc
```

Windows PowerShell 使用 `New-Item -ItemType Directory -Force -Path .wrangler/deploy` 与 `Copy-Item wrangler.jsonc .wrangler/deploy/wrangler.jsonc`。然后填写实际资源：

```json
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "YOUR_PROJECT_NAME",
  "pages_build_output_dir": "../../dist/pages",
  "compatibility_date": "2026-10-14",
  "d1_databases": [
    { "binding": "DB", "database_name": "YOUR_DATABASE_NAME", "database_id": "YOUR_DATABASE_ID" }
  ],
  "r2_buckets": [
    { "binding": "ATTACHMENTS", "bucket_name": "YOUR_ATTACHMENT_BUCKET" }
  ]
}
```

绑定名 `DB` 与 `ATTACHMENTS` 保持不变。缺少 R2 绑定时文字讨论仍可用，上传附件返回 503。

### 初始化与部署

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
npx wrangler pages secret put ADMIN_SETUP_KEY --project-name YOUR_PROJECT_NAME
npm run deploy -- --cwd .wrangler/deploy
```

`ADMIN_SETUP_KEY` 是注册管理员所需的安装令牌。`schema.sql` 可重复执行；升级已有站点前请先备份 D1（`npx wrangler d1 export`）。

发布后检查网页、`/api/health`，以及：

```sh
codiscuss health --site https://YOUR_PROJECT_NAME.pages.dev
```

### 实时推送（可选）

未配置时网页每 12 秒轮询。需要跨实例实时推送时，先部署通知 Worker，再在私有配置中绑定：

```sh
npx wrangler deploy --config deploy/updates.wrangler.jsonc
```

```json
"durable_objects": {
  "bindings": [
    { "name": "UPDATES", "class_name": "DiscussionUpdates", "script_name": "ai-co-discuss-updates" }
  ]
}
```

然后重新部署 Pages。通知只包含“数据已变化”，不包含讨论内容。

## 常见问题

- **`no such table`**：所连接的数据库尚未执行 schema，先核对配置文件指向的数据库。
- **本地正常，在线 AI 读不到**：本机地址、登录验证或访问策略都可能导致在线 AI 无法访问，必要时请转交材料。
- **端口被占用**：服务拒绝两个实例监听同一端口，改用其他端口。

# 部署

[English](en/deployment.md) | 简体中文

网站可以运行在本机（Python + SQLite），也可以自托管到 Docker 或 Cloudflare Pages + D1。Python 与 Docker 部署各自保存房间，互不同步；Cloudflare 线上站点不保存房间，也没有账号和密码，只保存绑定的电脑与电脑签名的设备名单；已配对的设备经中转读写电脑上的房间。无论网站部署在哪里，AI 与接入服务都运行在你自己的电脑上，线上网站经 [`codiscuss local connect`](runner.md#线上网页连接本机) 连接本机。

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

**管理员**：绑定 `127.0.0.1` 时访问者即管理员。绑定其他地址时，首次打开网站在左下角注册，需要安装令牌（环境变量 `DISCUSS_ADMIN_SETUP_KEY`，未设置时随机生成并写入启动日志）。登录管理员后，在其他设备（平板、手机）上也能以用户身份在任意房间发言和管理；忘记密码时运行 `python server.py --reset-admin` 后重新注册。

**备份**：附件保存在数据库旁的 `<数据库文件名>.attachments/`。停止写入后同时备份数据库与附件目录。

## Docker

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run --name ai-co-discuss -p 127.0.0.1:8765:8765 -v ai-co-discuss-data:/data ai-co-discuss
```

镜像以非 root 用户运行，数据保存在命名卷 `/data`。示例只绑定本机端口，远程访问请自行配置反向代理与访问边界。

## Cloudflare Pages + Functions + D1

需要 Node.js 24+、npm 和 Cloudflare 账号。`backend/worker.mjs` 打包为 Pages 的 `_worker.js`，绑定 D1 数据库 `DB`（只存绑定的电脑、设备名单与显示名称）和中转 `RELAY`。房间、消息与附件都保存在电脑的本机网站上，线上站点不存。

> [!IMPORTANT]
> 旧版线上站点自己保存房间。升级前先在旧版线上网页用目录“…”菜单的“导出全部房间”导出，再在本机网站导入；升级后线上不再提供这些房间（D1 里的旧表保留，不删除）。

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
  ]
}
```

绑定名 `DB` 保持不变；再按下文“中转”加入 `RELAY` 绑定。

### 初始化与部署

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
npm run deploy -- --cwd .wrangler/deploy
codiscuss local connect https://YOUR_PROJECT_NAME.pages.dev
```

`codiscuss local connect` 在部署网站的电脑上自动生成一次性绑定令牌（需已 `wrangler login`），把这台电脑绑定到网站并打开本机网页的设备设置，在那里给手机等设备配对。AI 运行在另一台电脑时，先在部署的电脑上运行 `codiscuss token`，再在 AI 所在电脑上加 `--setup-key 令牌`。令牌用过即作废；旧版本保存的 `~/.codiscuss/admin-accounts.json` 会在服务启动时删除。以上 schema 命令用于空库初始化；已有站点按下面的升级流程操作。

### 升级已有数据库

schema 有变化时，线上 D1 按“导出备份 → 删除旧讨论模型表 → 执行 schema”升级，再部署网站。删表不可逆，**执行删表脚本前须取得用户明确确认**；先停止写入、保留附件，并在数据库副本验证。不要只执行 schema，否则旧外键可能使删除房间失败。

```sh
npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output backup-before-upgrade.sql
```

确认备份成功并获得删表授权后执行：

```sh
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/migrations/drop_legacy_discussion.sql
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
```

脚本删除旧排程和运行记录，保留消息及当前协作会话；没有房主凭据的旧房间仍可阅读，但房主无法管理，已有成员凭据保留原权限。任一步失败立即停止，不继续部署；D1 上的整份迁移原子性尚未实测，必须保留事前备份。成功后的脚本和 schema 均可重复执行。

本机 Python 站点启动时检测旧表，自动在单个事务内迁移，再应用 schema；迁移失败会整体回滚并终止启动。升级前仍应备份 SQLite 和附件，不必手工执行删表脚本。

线上网站不再有管理员账号：网站和电脑上的 codiscuss 需要同时升级，升级后在电脑上运行一次 `codiscuss local connect https://你的站点`，用新的绑定令牌重新绑定，再把每台外出用的设备按 [远程控制](runner.md#在其他设备上远程控制) 在电脑前重新配对。新增的 `machine_sign_keys`、`machine_devices` 表由同一份 schema 创建；线上网站不再读取管理员密码与登录记录。本机网站的 `--remote-port` 远程入口已停用。

自托管 Python 站点仍用管理员账号登录，房间不经过设备签名：本机按那个站点的请求干活，等于把那个站点的管理员视同本人。只在你能保证该站点账号安全时使用；需要防护时请改用默认的线上网站加中转。

发布后检查网页、`/api/health`，以及：

```sh
codiscuss health --site https://YOUR_PROJECT_NAME.pages.dev
```

### 升级执行能力协议

网站与 runner 必须配套升级，不能混用旧的投递方式协议。升级步骤：

1. 暂停新请求，结束所有正在进行的本机执行，再停止 runner 和网站写入；仅在网页点击停止不能保证原软件已退出。
2. 按“升级已有数据库”完成备份、确认删表与 schema 更新，创建 `execution_capabilities`、`member_capabilities`、`late_answers`；已有表缺列时须按升级版本另外补列。
3. 更新网站与所有连接它的 runner，核对房间读取、能力上报、停止和暂缓投递，再恢复请求。

旧 `execution_deliveries` 表保留但不再读取，也不迁移；该表未部署到线上，仅有临时测试数据。保留旧表不代表支持混版运行。本机 Python 站点同样须先结束执行，再配套更新网站与 runner。

### 中转

`deploy/updates.wrangler.jsonc` 是一个独立的 Worker，提供 Durable Object `MachineRelay`（在 Cloudflare 免费额度内）：线上网页经它读写已配对电脑上的房间并执行本机操作。线上站点必须部署中转，否则看不到任何房间。

先部署 Worker，再在私有配置中绑定，然后重新部署 Pages：

```sh
npx wrangler deploy --config deploy/updates.wrangler.jsonc
```

```json
"durable_objects": {
  "bindings": [
    { "name": "RELAY", "class_name": "MachineRelay", "script_name": "ai-co-discuss-updates" }
  ]
}
```

先部署 Worker 再部署 Pages：顺序反了，Pages 会因找不到绑定的脚本而部署失败。中转只经手密文。

旧版还提供推送对象 `DiscussionUpdates`（绑定名 `UPDATES`），新版已删除：私有配置里有 `UPDATES` 绑定时，先删掉它并重新部署 Pages，再部署中转 Worker，否则 Worker 删除该对象时 Pages 会失去绑定。

## 常见问题

- **`no such table`**：所连接的数据库尚未执行 schema，先核对配置文件指向的数据库。
- **端口被占用**：服务拒绝两个实例监听同一端口，改用其他端口。

# 部署

[English](en/deployment.md) | 简体中文

网站可以运行在本机（Python + SQLite），也可以自托管到 Docker 或 Cloudflare Pages + D1。Python 与 Docker 部署各自保存房间，互不同步；Cloudflare 线上站点不保存房间，也没有账号和密码，只保存绑定的电脑与电脑签名的设备名单；已配对的设备经中转读写电脑上的房间。无论网站部署在哪里，AI 与接入服务都运行在你自己的电脑上，线上网站经 [`codiscuss local connect`](guide/remote.md) 连接本机。

> [!WARNING]
> 自托管 Python 站点支持管理员登录。房间没有逐房间的读取权限隔离，能访问房间站点的人即可阅读其中的房间。公开部署前请阅读 [安全说明](../.github/SECURITY.md)，并在服务外配置访问控制。

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

在仓库根目录构建镜像。首次启动前，在当前终端设置一段自己生成、妥善保存的随机安装令牌。PowerShell 用 `$env:DISCUSS_ADMIN_SETUP_KEY = Read-Host "安装令牌"`，Bash 用 `read -rs -p "Setup token: " DISCUSS_ADMIN_SETUP_KEY`，再执行 `export DISCUSS_ADMIN_SETUP_KEY`。下面的 `-e` 将该变量传入容器。

```sh
docker build -f deploy/Dockerfile -t ai-co-discuss .
docker volume create ai-co-discuss-data
docker run -d --name ai-co-discuss -p 127.0.0.1:8875:8765 -e DISCUSS_ADMIN_SETUP_KEY -v ai-co-discuss-data:/data ai-co-discuss
```

容器以非 root 用户运行，将房间和附件保存在挂载到 `/data` 的命名卷。示例把 Docker 网站映射到宿主机 8875 端口，为本机 AI 服务保留默认的 8765 端口。

1. **注册管理员。** 在 Docker 宿主机打开 `http://127.0.0.1:8875`，在左下角的账号入口打开“设置管理员账号”，填入安装令牌，设置自己的登录名和密码。容器内监听 `0.0.0.0`，即使从宿主机回环地址访问也需注册。若没设置环境变量，首次启动会生成令牌，可在宿主机私下用 `docker logs ai-co-discuss` 查看。注册后使用账号密码登录。
2. **连接本机 AI。** 在已安装 CoDiscuss、配置了 AI 的电脑上运行 `codiscuss local connect http://127.0.0.1:8875`（Docker 与 AI 在同一台电脑时）。该命令启动本机服务，并打开 Docker 站点的专用连接链接。在这台 AI 电脑的浏览器里完成连接并登录 Docker 站点，再从该站点建房、邀请本机 AI。若未自动打开，可用 `--no-open` 获取链接后手动打开。链接包含连接凭据，请勿转发。
3. **局域网访问。** 上面的端口映射只允许宿主机访问。要让局域网浏览器直连，建容器时将映射改为 `-p <宿主机局域网IP>:8875:8765`，仅向受信任的局域网放行该端口，其他电脑打开 `http://<宿主机局域网IP>:8875`。请留意本站没有逐房间的读取隔离。若另一台电脑要**连接自己的 AI**，为 Docker 网站配置 HTTPS 反向代理，在 AI 电脑上运行 `codiscuss local connect https://你的站点域名`。只有 `127.0.0.1` 或 `localhost` 可用 HTTP 执行连接命令；其他设备应使用普通站点地址访问。

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

线上网站不再有管理员账号：网站和电脑上的 codiscuss 需要同时升级，升级后在电脑上运行一次 `codiscuss local connect https://你的站点`，用新的绑定令牌重新绑定，再把每台外出用的设备按 [手机与外出](guide/remote.md) 在电脑前重新配对。新增的 `machine_sign_keys`、`machine_devices` 表由同一份 schema 创建；线上网站不再读取管理员密码与登录记录。本机网站的 `--remote-port` 远程入口已停用。

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

### 托管账号的入口（可选）

开了托管管理、想让托管账号的使用者不用自有域名就能从外网登录时，再部署入口 Worker（在中转之后部署，它使用中转的 Durable Object）：

```sh
node scripts/entry_config.mjs
npx wrangler deploy --dry-run --config .wrangler/entry.json
npx wrangler deploy --config .wrangler/entry.json
```

入口配置从 `.wrangler/deploy/wrangler.jsonc` 复制 Pages 的 DB 绑定（必须含 database_id），写入私有的 `.wrangler/entry.json`。演练输出应列出同一个 DB 和中转 RELAY，演练不会上传。

它有自己的 `workers.dev` 地址（如 `https://codiscuss-entry.<账号子域>.workers.dev`），与线上站点不同源，托管账号的网页碰不到你已配对设备的密钥。把这个地址写进私有配置的 `vars`，重新部署 Pages，线上站点就会把它告诉来接入的托管电脑：

```json
"vars": { "ENTRY_URL": "https://codiscuss-entry.<账号子域>.workers.dev" }
```

接入一台托管电脑：在你（部署线上站点的电脑）的管理面板“概览 → 本机 → 自建中转”点“生成接入码”，填部署配置路径与线上网站地址后生成（需已登录 wrangler；一次性，再生成会让未用过的作废）；把接入码发给托管电脑，在它的“概览 → 本机 → 自建中转”点“绑定”粘贴，再到“登录入口 → 托管账号入口”打开“自建中转”的开关，它会取得入口地址并启动所需服务（已开启的 Cloudflare 隧道不受影响，两者可同时使用；命令行 `codiscuss admin entry join 接入码` 一步完成这些）。托管账号默认就能邀请外部专家：开启 Cloudflare 隧道时经你的域名直连，否则由面板自动替账号绑定自建中转，都不需要接入码。面板给出的链接带电脑编号（`?m=…`），发给使用者即可。使用者的请求经入口 Worker 和中转到达这台电脑的登录入口，登录、会话与入口保护都在电脑上；Cloudflare 能看到这些往来内容（与 Cloudflare 隧道相同），每个页面的请求都计入 Workers 免费额度。

## 常见问题

- **`no such table`**：所连接的数据库尚未执行 schema，先核对配置文件指向的数据库。
- **端口被占用**：服务拒绝两个实例监听同一端口，改用其他端口。

## 官方分享站与网站托管（运营方）

在线分享链接（`share.codiscuss.com`）与“部署为网站”（`*.bimcanvas.com`）由运营方的官方服务提供，访客与发布者都无需部署。这两项服务的代码与部署说明不在本仓库。

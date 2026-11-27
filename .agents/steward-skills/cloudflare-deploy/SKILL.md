---
name: cloudflare-deploy
description: "为用户自己的 Cloudflare 账号部署或更新 AI CoDiscuss 线上站点。Deploy or update the user's own AI CoDiscuss Cloudflare site for paired-device access."
---

# 部署自己的 Cloudflare 线上站点 / Deploy your own Cloudflare site

仅部署用户自有的共议 Pages 站点、D1 和中转 Worker，不发布 npm、不操作官方分享站或托管服务。线上站点不保存房间，也不启动 AI；已配对设备经中转访问仍在本机运行的服务。

## 确定源码与目标 / Source and target

1. 需要 Node.js 24+、npm、用户自己的 Cloudflare 账号以及带 `backend/worker.mjs`、构建脚本和 `docs/deployment.md` 的源码工作目录。先核对目标是新建还是升级、目标版本和现有资源。使用选定源码版本的 `docs/deployment.md`（英语 `docs/en/deployment.md`）与 `.github/SECURITY.md`，不要把 npm 安装目录误当源码仓库。
2. 找不到合适源码时，核实当前 `codiscuss` 命令对应的安装包，从该包 `package.json` 的 `repository.url` 取得仓库地址（Git 命令去掉 `git+`）。产品版本取 `codiscuss local status --json` 的 `version`，并与该包 `package.json` 的 `version` 核对，一致时用 `v<版本>` 作标签；不一致（本机服务还在跑旧版）时向用户说明，由用户决定。`codiscuss --version` 是房间 CLI 的协议版本，不是产品版本，不要用它选标签。若连命令对应的安装包也不能确认，先解决版本冲突，不猜标签。列出仓库、标签、主理人工作目录下拟用的全新子目录与命令，**经用户同意后**，用 `git clone --branch <标签> --single-branch <仓库地址> <新目录>` 获取源码并核对标签和 `package.json` 版本。标签不存在或版本不符就停下，不回退到默认分支，也不切换或覆盖其他人正在使用的工作区。
3. 用户的私有部署配置和备份只放在选定源码下已被 Git 忽略的 `.wrangler/deploy/`。根目录 `wrangler.jsonc` 等已跟踪文件只作为模板。使用 Wrangler 直接部署构建出的页面，不连接 Git 自动构建。已有配置先确认归属与是否复用，不复述凭据或把它们写进房间、命令参数或跟踪文件。

If source is missing, obtain consent to clone the repository named in the installed package at the tag `v<version>`, where the version is the `version` from `codiscuss local status --json` and matches the installed package's `package.json`. `codiscuss --version` reports the room CLI protocol version, not the product version. Use an unused subdirectory of the steward's working directory. Keep private configuration and backups under `.wrangler/deploy/` in that checkout.

## 执行与确认 / Deploy and confirm

**每次写远端前**，列出实际 Cloudflare 账号、Pages 项目、D1 和中转 Worker（以该步涉及的资源为准）、完整命令及影响，等用户明确同意再执行。本次部署请求的确认不代替这些逐步确认。未能核对账号或目标就不写远端。使用房间参与技能的阻塞提问流程等待确认。

1. 在选定源码中运行 `npm ci`。需要登录时由用户完成 `npx wrangler login` 的浏览器授权，用 `npx wrangler whoami` 核对账号。说明站点访问边界，默认使用 `pages.dev`，不要求自定义域名。
2. **新建**：按部署文档创建 Pages 项目和 D1 数据库，已有就不重复创建。Wrangler 问是否改写根配置时选否。将模板复制到 `.wrangler/deploy/wrangler.jsonc`，填写实际项目、`DB` 的名称和 ID、`RELAY` 的脚本名，按文档修正相对路径。在执行 schema 前核对 `--config` 及数据库目标。
3. **升级**：在任何远端写入前先确认并导出 D1 备份。例：`npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output .wrangler/deploy/d1-backup-<日期>.sql`。备份失败就不继续。按版本对应的部署文档判断是否需要迁移；涉及删表时，在副本验证并单独取得明确同意，不能把初始化命令当成升级方案直接重跑。
4. **发布**：一般先部署中转 Worker，再按文档发布 Pages（`npm run deploy -- --cwd .wrangler/deploy`）；如有旧版绑定，遵循该版本部署文档的迁移顺序。自定义 Worker 配置也只放 `.wrangler/deploy/`，并按文件位置调整相对路径。未确认的可选资源不创建。任何步骤失败时停止后续写入，保留备份并报告已完成的步骤。

Get explicit approval before each remote write after showing the actual targets, exact command and impact. Back up existing D1 data before an update. Do not proceed after a failed backup or migration.

## 验收 / Verify

打开实际站点，核对 `/api/health` 返回 `ok: true`，再运行 `codiscuss health --site <实际网址>`。如用户也要求连接本机，运行 `codiscuss local connect <实际网址>`，由用户完成网页连接，再核对已配对设备能够读到本机房间。报告实际网址、部署版本、核验结果和备份位置（如有）；仅首页可打开不算验收通过。未执行的连接或配对步骤如实说明。

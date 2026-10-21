# 在线部署（Cloudflare Pages + D1）

把仓库网站部署到用户自己的 Cloudflare 账号。完整命令与配置结构以 [docs/deployment.md](../../../../docs/deployment.md#cloudflare-pages--functions--d1) 为准；本文只规定执行顺序、确认点和核验要求。

在线网站只承载网页与数据，不启动 AI；全自动讨论仍需本机安装与讨论服务。在线 D1 与本机 SQLite 互不同步。

## 部署前说明

开始前向用户说明并确认：

- 需要 Node.js 24+、npm 和用户自己的 Cloudflare 账号。个人使用通常在免费额度内；Durable Object 推送按 Cloudflare 实际计划计费，属于可选项。
- 当前网站没有用户登录和读取权限隔离，部署到公网前阅读 [SECURITY.md](../../../../.github/SECURITY.md)。
- 采用 Wrangler 直接上传 `dist/pages/`，不使用 Cloudflare“连接到 Git”自动构建：根目录 `wrangler.jsonc` 是含占位 ID 的公开模板，实际资源配置只放在私有 `.wrangler/deploy/wrangler.jsonc`。

## 首次部署

每个写远端的步骤执行前，列出将使用的实际名称与命令，等用户同意。

1. **复用检查**：已存在 `.wrangler/deploy/wrangler.jsonc` 时先读取，向用户确认是否沿用其中的项目、数据库与桶，不重复创建。
2. **登录**：`npm ci` 后运行 `npx wrangler login`，浏览器授权由用户完成；用 `npx wrangler whoami` 核对账号。
3. **创建资源**：与用户确定 Pages 项目名、D1 数据库名、R2 附件桶名，再按 deployment.md 执行 `d1 create`、`r2 bucket create`、`pages project create … --production-branch main`。Wrangler 询问是否改写根配置时选否。R2 可省略，此时文字讨论可用、上传返回 503。
4. **私有配置**：创建 `.wrangler/deploy/` 并复制模板，填入实际名称和 `d1 create` 返回的 ID，按 deployment.md 调整 `$schema` 与 `pages_build_output_dir` 两个相对路径；`DB`、`ATTACHMENTS` 绑定名不变。不把实际值写回根目录模板。
5. **初始化数据库**：`npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql`。执行前核对 `--config` 指向的数据库就是刚创建的那个。
6. **发布**：`npm run deploy -- --cwd .wrangler/deploy`；记录返回的实际网址。不要在仓库根目录直接运行未指定 `--cwd` 的部署。

## 核验

全部满足才报告部署成功；只看到首页不能证明数据库和动态路由正常。

- 打开实际网址，页面正常显示；`/api/health` 返回 `ok: true`。
- `codiscuss health --site <实际网址>` 与 `codiscuss room list --site <实际网址>` 成功。
- 已有房间时打开 `/r/<房间ID>`，中文原文与静态资源正常。

## 自定义域名（可选）

在 Cloudflare 控制台的 Pages 项目“自定义域”中添加域名，由用户操作：DNS 托管在 Cloudflare 时自动生效；托管在其他服务商时按页面提示添加指向 `<项目>.pages.dev` 的 `CNAME`。生效并签发证书后，用新域名重复核验，之后统一使用该域名。

## 网页推送（可选）

用户需要多标签实时推送时，按 deployment.md“网页推送”先部署 `deploy/updates.wrangler.jsonc` 的通知 Worker，再在私有配置中加入 `durable_objects` 绑定并重新发布。不配置时网页每 12 秒轮询，功能不受影响。

## 更新已部署的站点

1. 确认本地仓库已是目标版本（见 SKILL.md“升级”）。
2. 经用户同意，先备份远端数据库，例如 `npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output <已忽略目录>/d1-backup.sql`；R2 中的附件需另行保留。
3. 版本含 schema 变化时，再执行一次初始化数据库的命令；schema 为增量扩展，重复执行不应清空记录，但仍以备份为前提。
4. 重新发布并按“核验”检查。

## 连接本机

本机安装已就绪（SKILL.md“验收”通过）后，在运行 AI 的同一台电脑执行 `codiscuss local connect <实际网址>`，由用户在打开的网页完成连接。连接链接不转发；撤销用 `codiscuss local disconnect <实际网址>`。细节见 [docs/runner.md](../../../../docs/runner.md#线上网页连接本机)。

## 常见问题

- **`no such table`**：所连数据库未执行 schema；核对 `--config` 与 `--remote` 后再执行，不对其他数据库试错。
- **发布成功但接口 500**：检查私有配置的 D1 绑定名是否为 `DB`、`database_id` 是否为实际值。
- **本地网页正常、在线 AI 读不到**：访问策略、登录验证或回环地址都可能阻止，在专家实际环境核对，不凭浏览器成功推定。

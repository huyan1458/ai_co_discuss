# 在线部署（Cloudflare Pages + D1）

把仓库网站部署到用户自己的 Cloudflare 账号。完整命令与配置结构以 [docs/deployment.md](../../../../docs/deployment.md#cloudflare-pages--functions--d1) 为准；本文只规定执行顺序、确认点和核验要求。

在线网站只承载网页、管理员账号与电脑配对，不保存房间、不启动 AI；登录后经中转读写已配对电脑上的房间，因此仍需本机安装与讨论服务。

## 部署前说明

开始前向用户说明并确认：

- 需要 Node.js 24+、npm 和用户自己的 Cloudflare 账号。免费部署需要 Pages + D1 + 中转 Durable Object，都在免费额度内。
- 当前网站没有用户登录和读取权限隔离，部署到公网前阅读 [SECURITY.md](../../../../.github/SECURITY.md)。
- 采用 Wrangler 直接上传 `dist/pages/`，不使用 Cloudflare“连接到 Git”自动构建：根目录 `wrangler.jsonc` 是含占位 ID 的公开模板，实际资源配置只放在私有 `.wrangler/deploy/wrangler.jsonc`。

## 首次部署

每个写远端的步骤执行前，列出将使用的实际名称与命令，等用户同意。

1. **复用检查**：已存在 `.wrangler/deploy/wrangler.jsonc` 时先读取，向用户确认是否沿用其中的项目、数据库与桶，不重复创建。
2. **登录**：`npm ci` 后运行 `npx wrangler login`，浏览器授权由用户完成；用 `npx wrangler whoami` 核对账号。
3. **创建资源**：与用户确定 Pages 项目名、D1 数据库名，再按 deployment.md 执行 `d1 create`、`pages project create … --production-branch main`。Wrangler 询问是否改写根配置时选否。
4. **私有配置**：创建 `.wrangler/deploy/` 并复制模板，填入实际名称和 `d1 create` 返回的 ID，按 deployment.md 调整 `$schema` 与 `pages_build_output_dir` 两个相对路径；`DB` 绑定名不变，并按 deployment.md“中转”加入 `RELAY` 绑定。不把实际值写回根目录模板。
5. **初始化数据库**：`npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql`。执行前核对 `--config` 指向的数据库就是刚创建的那个。
6. **发布**：先按 deployment.md“中转”部署 `deploy/updates.wrangler.jsonc`，再 `npm run deploy -- --cwd .wrangler/deploy`；记录返回的实际网址。不要在仓库根目录直接运行未指定 `--cwd` 的部署。

## 核验

全部满足才报告部署成功；只看到首页不能证明数据库和动态路由正常。

- 打开实际网址，页面正常显示；`/api/health` 返回 `ok: true`。
- `codiscuss health --site <实际网址>` 成功。
- 在电脑上运行 `codiscuss local connect <实际网址>` 并登录管理员后，目录“协作房间”列出电脑上的房间。

## 域名

正式地址使用 `<项目>.pages.dev`，不默认绑定自定义域名。

## 更新已部署的站点

1. 确认本地仓库已是目标版本（见 SKILL.md“升级”）。
2. 经用户同意，先备份远端数据库，例如 `npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output <已忽略目录>/d1-backup.sql`。
3. 版本含 schema 变化时，再执行一次初始化数据库的命令；schema 为增量扩展，重复执行不应清空记录，但仍以备份为前提。
4. 重新发布并按“核验”检查。

## 连接本机

本机安装已就绪（SKILL.md“验收”通过）后，在运行 AI 的同一台电脑执行 `codiscuss local connect <实际网址>`，由用户在打开的网页完成连接。连接链接不转发；撤销用 `codiscuss local disconnect <实际网址>`。细节见 [docs/runner.md](../../../../docs/runner.md#线上网页连接本机)。

## 常见问题

- **`no such table`**：所连数据库未执行 schema；核对 `--config` 与 `--remote` 后再执行，不对其他数据库试错。
- **发布成功但接口 500**：检查私有配置的 D1 绑定名是否为 `DB`、`database_id` 是否为实际值。

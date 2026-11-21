---
name: codiscuss-release
description: "AI CoDiscuss 全自动发版。用户说“发版”“发个版”“发布新版本”“发一版”时直接调用，无需再确认：在 CHANGELOG.md 写入本版重点、提交全部变更、升 npm 补丁版本并打标签；schema 有变化时备份并升级线上 D1；部署网站与 Worker、推送到 GitHub，由标签触发 GitHub Actions 经 Trusted Publishing 发布 npm，等 npm 上线新版本；本机更新（codiscuss admin update）只在用户明确要求时执行。不跑测试，不在本机 publish，用户无需手动操作。"
---

# 发版（codiscuss-release）

用户说“发版”即授权第 0–4 阶段（更新日志、提交、部署、推送、经 GitHub Actions 发布 npm），按顺序连续执行，阶段之间只输出一句进度，不停下等用户。例外：第 2 阶段发现线上 D1 有旧表需要删除时，删表须先备份，再取得用户明确确认，“发版”授权不代替。第 5 阶段（更新本机）不属于发版流程，只在用户明确要求更新本机时执行。

不跑测试，除第 0 阶段写更新日志外不查看或分析改动内容，不检查其他窗口，不拆分提交，不在本机 `npm publish`（npm 由推送的 `v*` 标签触发 `.github/workflows/publish.yml` 经 Trusted Publishing 发布，无需用户在浏览器验证），push 不加 `--force`。网络类错误（`fetch failed`、`ECONNRESET`、超时、`EOF` 等）不算失败，原样重试该步，第 3 阶段命令已自带重试，用尽后再手动重试一轮；仍失败或遇到非网络错误时才停止并报告，不执行后续阶段。

版本号默认只升 patch：0.4.9 之后是 0.4.10，不进位成 0.5.0；minor、major 只在用户明确要求时升，不手动改版本号。

**第 0 阶段**（更新 `CHANGELOG.md`）。本次版本号为 `package.json` 的版本升一个 patch（用户要求升 minor、major 时按要求）。用 `git log <上一个 v* 标签>..HEAD` 与 `git status --porcelain` 看本次包含的提交和未提交改动，只为挑重点按需看差异，不做审查。在文件顶部写一节 `## <版本号>（<今天日期 YYYY-MM-DD>）`；已有“（未发布）”一节时把它改成这个标题，并按实际改动增删条目。写法：

- 只挑用户能感知的重点，条数不设上限；内部重构、测试、文档、构建产物不写，同类合并成一条。
- 每条一句话，以“新增：”“调整：”“修复：”开头；修复写出现了什么问题，不写原因和实现。
- 界面文字照抄并加引号；不写文件名、函数名、提交号。

文件随第 1 阶段的 `git add -A` 一起提交，写完直接进入第 1 阶段。

**第 1 阶段**（构建、升版本、再构建、提交全部、打版本标签，并判断 schema 是否自上次发版后有变化），在仓库根目录用 Bash 原样执行，署名行按会话要求替换。先构建一次，构建失败时不升版本；升版本后再构建，让网页左上角显示的版本号就是本次发布的版本：

```bash
npm run build >/dev/null && P=$(git log -1 --format=%H --grep='^chore(release)') && V=$(npm version patch --no-git-tag-version) && npm run build >/dev/null && git add -A && git reset -q -- package.json package-lock.json && (git diff --cached --quiet || git commit -q -m 'chore: 发版前提交全部变更' -m 'Co-Authored-By: <署名>') && git commit -q -m "chore(release): 升级至 ${V#v}" -m 'Co-Authored-By: <署名>' -- package.json package-lock.json && git tag -a "$V" -m "$V" && echo "$V" && (git diff --quiet "$P" HEAD -- backend/schema.sql && echo "schema: 未变化" || echo "schema: 有变化")
```

输出的 `V`（如 `v0.4.54`）在后续阶段中替换 `<V>`。

**第 2 阶段**（仅当第 1 阶段输出“schema: 有变化”时执行；未变化则跳过）：按“导出备份 → 执行 drop_legacy_discussion.sql → 执行 schema.sql”的顺序升级。先停止网站写入和 runner，导出线上 D1 备份，并检查线上是否还有旧表：

```bash
mkdir -p .wrangler/backups && npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output ".wrangler/backups/d1-before-<V>.sql" && npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('discussion_turns','room_floor')"
```

查询结果没有旧表时，不执行删表、不向用户确认，只执行 schema：

```bash
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql 2>&1 | tail -2
```

查询结果有旧表时，确认备份成功，向用户说明将删除旧讨论模型的排程和运行表、保留消息及当前协作会话，并给出备份路径和脚本路径。未获明确确认则停在此处，不部署。获得授权后执行：

```bash
npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/migrations/drop_legacy_discussion.sql && npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
```

整份迁移在 D1 上的原子性尚未实测，失败时保留备份并停止，不继续部署。成功后两个脚本均可重复执行。

**第 3 阶段**（部署后推送，已构建过不再重复构建）。私有配置绑定了 `RELAY` 时，先部署中转 Worker，再部署托管账号的入口 Worker（它绑定中转 Worker 的 Durable Object，须在中转之后），然后部署网站；没有绑定时只部署网站：

```bash
set -o pipefail; retry() { for i in 1 2 3 4 5; do "$@" 2>&1 | tail -3 && return 0; echo "== 第 $i 次失败，重试"; done; return 1; }; (! grep -q '"RELAY"' .wrangler/deploy/wrangler.jsonc || (retry npx wrangler deploy --config deploy/updates.wrangler.jsonc && retry npx wrangler deploy --config deploy/entry.wrangler.jsonc)) && retry npx wrangler pages deploy --branch main --commit-dirty=true --cwd .wrangler/deploy && retry git push --follow-tags
```

入口 Worker 的地址（`https://codiscuss-entry.<账号子域>.workers.dev`）在部署输出里，收尾时报告给用户，托管电脑在管理面板“线上中转”里填它。

`pipefail` 让 `| tail` 不掩盖失败：任一步重试用尽，后续步骤不执行（部署未成功不推送，也就不会发布 npm）。`--follow-tags` 同时推送本次的附注标签 `<V>`，它触发 `publish.yml` 发布 npm；该工作流会核对标签与 `package.json` 版本一致。

若部署报 `.wrangler/deploy/config.json` 相关错误，删除该文件重试一次。

**第 4 阶段**（等待 GitHub Actions 发布 npm 并确认上线）。用 Bash 的 `run_in_background: true` 执行，等完成通知后再收尾，不轮询输出文件：

```bash
V=<V>; R=; for i in $(seq 1 24); do R=$(gh run list --workflow publish.yml --branch "$V" --limit 1 --json databaseId --jq '.[0].databaseId'); [ -n "$R" ] && break; sleep 5; done; [ -n "$R" ] || { echo "publish: 未找到 $V 的工作流运行"; exit 1; }; if gh run watch "$R" --exit-status --interval 15 >/dev/null 2>&1; then echo "publish: 成功 (run $R)"; else gh run view "$R" --log-failed 2>&1 | tail -30; echo "publish: 失败 (run $R)"; exit 1; fi; T="https://registry.npmjs.org/ai_co_discuss/-/ai_co_discuss-${V#v}.tgz"; code() { curl -sI -o /dev/null -w '%{http_code}' "$1"; }; for i in $(seq 1 40); do [ "$(code "$T?t=$(date +%s)")" = 200 ] && break; sleep 15; done; for i in $(seq 1 40); do [ "$(code "$T")" = 200 ] && { echo "npm: ${V#v} 已上线，安装包可下载"; exit 0; }; sleep 15; done; echo "npm: 20 分钟内安装包仍不可下载，registry 或 CDN 可能仍在同步"
```

“已上线”以安装包能下载为准，不以 `npm view` 查到版本号为准：版本信息比安装包先上线，此时安装会 404，且 CDN 会把这个 404 缓存 5 分钟（`max-age=300`）。所以先带查询参数绕过 CDN 等源站有了安装包，再查正常地址（`npm install` 实际请求的地址），返回 200 才报告；正常地址已被缓存 404 时会多等最多 5 分钟。

- 工作流因网络类错误失败时，执行 `gh run rerun <run> --failed` 后重跑本阶段一次；仍失败则停止并报告日志末尾。
- 认证类失败（`ENEEDAUTH`、`E401`、`E403`、OIDC 相关）说明 npm 上的 Trusted Publisher 配置（仓库 `huyan1458/ai_co_discuss`、工作流 `publish.yml`、已允许 `npm publish`）有问题，报告给用户，不在本机尝试 publish。
- 只有安装包检查超时、工作流已成功时，不算失败，收尾时说明版本仍在同步、暂时还不能更新。

**第 5 阶段**（更新本机，手动触发）。发版流程到第 4 阶段为止，收尾时不执行、不询问本机更新；只有用户明确要求更新本机（如“更新一下本机”“装上新版”）时才执行。用 Bash 的 `run_in_background: true` 执行，等完成通知后报告结果：

```bash
codiscuss admin update 2>&1 | tail -30; codiscuss admin status 2>&1 | grep -m2 '"version"'
```

它安装 npm 上的最新版、无提问地执行 `codiscuss setup`（更新本机技能），并重启本机服务、登录入口和原先在运行的实例；重启期间正在进行的房间执行会中断，属预期。两个 `version` 都是 `<V>` 才算成功；不是或命令报错时报告输出，不重试安装、不手动 `npm install`。

**收尾报告**（第 4 阶段完成后给出）：版本号、部署地址（有中转时附入口 Worker 地址）、推送结果、npm 发布结果（附 `https://github.com/huyan1458/ai_co_discuss/actions/runs/<run>`）、D1 是否已升级（升级时给出备份文件路径）。

---
name: codiscuss-release
description: "AI CoDiscuss 全自动发版。用户说“发版”“发个版”“发布新版本”“发一版”时直接调用，无需再确认：在 CHANGELOG.zh-CN.md 与 CHANGELOG.md 写入本版重点、提交全部变更、升 npm 补丁版本并打标签；schema 有变化时备份并升级线上 D1 与分享站 D1；部署网站、Worker 与分享站，推送到 GitHub，由标签触发 GitHub Actions 经 Trusted Publishing 发布 npm，等 npm 上线新版本；本机更新（codiscuss admin update）只在用户明确要求时执行。不跑测试，不在本机 publish，用户无需手动操作。"
---

# 发版（codiscuss-release）

用户说“发版”即授权第 0–4 阶段（更新日志、提交、升级数据库、部署与推送、经 GitHub Actions 发布 npm），按顺序连续执行，阶段之间只输出一句进度，不停下等用户。第 5 阶段（更新本机）不属于发版流程，只在用户明确要求更新本机时执行。用户只要更新日志、不要发版时，只做第 0 阶段，标题写“（未发布）”与“(Unreleased)”。

不跑测试，除第 0 阶段写更新日志外不查看或分析改动内容，不检查其他窗口，不拆分提交，不在本机 `npm publish`（npm 由推送的 `v*` 标签触发 `.github/workflows/publish.yml` 经 Trusted Publishing 发布，无需用户在浏览器验证），push 不加 `--force`。网络类错误（`fetch failed`、`ECONNRESET`、`schannel`、超时、`EOF` 等）不算失败：下文的 wrangler、git 与 gh 命令都已自带重试，用尽后再手动重跑该步一轮；仍失败或遇到非网络错误时才停止并报告，不执行后续阶段。

在房间里执行时，回合结束即判执行失败，所以本技能的所有命令都在前台运行（Bash 超时设 600000 毫秒，一次等不完就再跑一次检查），不放后台等通知。

版本号默认只升 patch：0.4.9 之后是 0.4.10，不进位成 0.5.0；minor、major 只在用户明确要求时升，不手动改版本号。

**第 0 阶段**（更新 `CHANGELOG.zh-CN.md` 与 `CHANGELOG.md`）。本次版本号为 `package.json` 的版本升一个 patch（用户要求升 minor、major 时按要求）。用 `git log <上一个 v* 标签>..HEAD` 与 `git status --porcelain` 看本次包含的提交和未提交改动，只为挑重点按需看差异，不做审查。两个文件顶部各写一节：中文 `## <版本号>（<本机当前时间 YYYY-MM-DD HH:MM>）`，英文 `## <版本号> (<同一时间>)`，时间精确到分钟，用 `date '+%Y-%m-%d %H:%M'` 取；已有“（未发布）”/“(Unreleased)”一节时改成这个标题，并按实际改动增删条目。两份条目一一对应、顺序相同，英文是同一意思的自然英文，不逐字硬译。

这些条目会原样显示在网站左上角点版本号打开的“更新日志”窗口里，读者是用房间的人，不是开发者。写法：

- **挑重点**：每版 2–5 条，只写用的人会注意到、会受益的变化；按影响从大到小排，同类合并成一条。内部重构、测试、文档、构建产物、命令行参数、技能与提示词的措辞、只影响维护者或部署的改动，以及管理面板、托管账号、商业化相关变更都不写；小的样式微调不写。
- **说人话**：写用的人能做什么、会看到什么、哪里不再出问题，不写怎么实现。不出现文件名、函数名、接口、提交号、配置项、版本号以外的技术词（如 schema、Worker、D1、CLI 参数、run_worker_first）；必须提到软件时用它的产品名（如 Antigravity）。
- **短**：每条一句，中文约 40 字以内，英文约 25 词以内；不堆细节，不写数字参数，除非数字本身就是重点（如“最多 100 MB”）。
- **前缀**：中文以“新增：”“调整：”“修复：”开头，英文以“New:”“Changed:”“Fixed:”开头（网页据此显示标签）。修复写原来出了什么问题，不写原因。
- **界面文字**：提到按钮、菜单时照抄当前界面原文加引号，英文用英文界面上的原文（查 `frontend/locales/en/`），查不到就用描述代替，不自造标签。

同时看一眼 `git status --porcelain` 里 `??` 开头的新文件，只看路径和大小、不看内容：明显不属于项目的（仓库根目录或无关目录里的图片、压缩包、安装包、临时文件、日志）记为排除项，第 1 阶段不提交并在收尾时列出；拿不准的照常提交。（推送到 GitHub 即公开，很难撤回。）

两个文件随第 1 阶段的 `git add -A` 一起提交（构建时读入网页），写完直接进入第 1 阶段。

**第 1 阶段**（构建、升版本、再构建、提交全部、打版本标签，并判断两个 schema 与分享站配置是否自上次发版后有变化），在仓库根目录用 Bash 原样执行，署名行按会话要求替换，`X=` 填第 0 阶段的排除项（空格分隔，没有就留空）。先构建一次，构建失败时不升版本；升版本后再构建，让网页左上角显示的版本号就是本次发布的版本：

```bash
X=""; npm run build >/dev/null && P=$(git log -1 --format=%H --grep='^chore(release)') && V=$(npm version patch --no-git-tag-version) && npm run build >/dev/null && git add -A && git reset -q -- package.json package-lock.json $X && (git diff --cached --quiet || git commit -q -m 'chore: 发版前提交全部变更' -m 'Co-Authored-By: <署名>') && git commit -q -m "chore(release): 升级至 ${V#v}" -m 'Co-Authored-By: <署名>' -- package.json package-lock.json && git tag -a "$V" -m "$V" && echo "$V" && (git diff --quiet "$P" HEAD -- backend/schema.sql && echo "schema: 未变化" || echo "schema: 有变化") && (git diff --quiet "$P" HEAD -- backend/updates.mjs backend/entry_worker.mjs deploy/updates.wrangler.jsonc deploy/entry.wrangler.jsonc && echo "workers: 未变化" || echo "workers: 有变化") && rwf() { tr -d ' \n\r' < "$1" | grep -o '"run_worker_first":\[[^]]*\]'; }; [ ! -f ../codiscuss_site/services/share/wrangler.local.jsonc ] || { [ "$(rwf ../codiscuss_site/services/share/wrangler.jsonc)" = "$(rwf ../codiscuss_site/services/share/wrangler.local.jsonc)" ] && echo "share_config: 一致" || echo "share_config: 排除项不一致"; }
```

输出的 `V`（如 `v0.4.54`）在后续阶段中替换 `<V>`，`workers` 一行决定第 3 阶段要不要部署中转与入口 Worker。`git add -A` 遇到读不了的目录会报错并中断命令链：先查是哪个目录，属于临时文件就加进排除项或 `.gitignore` 后重跑。输出“share_config: 排除项不一致”时，把 `../codiscuss_site/services/share/wrangler.jsonc` 的 `run_worker_first` 排除项同步到私有配置 `../codiscuss_site/services/share/wrangler.local.jsonc`（只改这一项，不动绑定与域名），再进入下一阶段。

**第 2 阶段**（升级数据库）。

线上网站 D1（仅当输出“schema: 有变化”）：先导出备份，再执行 schema。`schema.sql` 全部是 `CREATE ... IF NOT EXISTS`，可重复执行：

```bash
r() { for i in 1 2 3 4 5; do "$@" >/tmp/r.out 2>&1 && { tail -2 /tmp/r.out; return 0; }; echo "== 第 $i 次失败"; grep -m1 -iE 'error|failed' /tmp/r.out; done; return 1; }; mkdir -p .wrangler/backups && r npx wrangler d1 export DB --remote --config .wrangler/deploy/wrangler.jsonc --output ".wrangler/backups/d1-before-<V>.sql" && ls -la ".wrangler/backups/d1-before-<V>.sql" && r npx wrangler d1 execute DB --remote --config .wrangler/deploy/wrangler.jsonc --file backend/schema.sql
```

分享站 D1（仅当 `../codiscuss_site/services/share/wrangler.local.jsonc` 存在；分享站代码在官方服务仓库 `../codiscuss_site/services/share/`）：只在它的 `schema.sql` 与上次成功执行时不同才执行，执行成功后把文件摘要记在 `.wrangler/share-schema.sha`（已被 git 忽略）。建表语句都是 `IF NOT EXISTS`，摘要文件丢了重跑一次也无妨：

```bash
S=../codiscuss_site/services/share; [ -f $S/wrangler.local.jsonc ] || { echo "share D1: 跳过（无私有配置）"; exit 0; }; H=$(sha256sum $S/schema.sql | cut -d' ' -f1); [ "$H" = "$(cat .wrangler/share-schema.sha 2>/dev/null)" ] && { echo "share D1: 未变化"; exit 0; }; r() { for i in 1 2 3 4 5; do "$@" >/tmp/r.out 2>&1 && { tail -2 /tmp/r.out; return 0; }; echo "== 第 $i 次失败"; grep -m1 -iE 'error|failed' /tmp/r.out; done; return 1; }; r npx wrangler d1 execute DB --remote --config $S/wrangler.local.jsonc --file $S/schema.sql && echo "$H" > .wrangler/share-schema.sha && echo "share D1: 已执行"
```

失败时保留备份并停止，不继续部署。

**第 3 阶段**（部署后推送，已构建过不再重复构建）。私有配置绑定了 `RELAY`、且第 1 阶段输出“workers: 有变化”时，先部署中转 Worker，再部署托管账号的入口 Worker（它绑定中转 Worker 的 Durable Object，须在中转之后）；两者代码没变就不部署，命令里 `W=` 填 `0`（这两步是网络失败最多的地方）。然后部署网站。网站之后部署官方分享站 Worker（`codiscuss-share`，代码与私有配置在官方服务仓库，私有配置 `../codiscuss_site/services/share/wrangler.local.jsonc`；文件不存在或其中 `name` 不是 `codiscuss-share` 时跳过）。分享站每次发版都部署：分享页的界面由分享站自己托管的 `web/` 资源渲染，不随网站部署更新，漏部署时已发出的链接会一直显示旧界面（0.5.3–0.5.7 曾漏掉）：

```bash
W=1; set -o pipefail; retry() { for i in 1 2 3 4 5; do "$@" 2>&1 | tail -3 && return 0; echo "== 第 $i 次失败，重试"; done; return 1; }; ([ "$W" = 0 ] || ! grep -q '"RELAY"' .wrangler/deploy/wrangler.jsonc || (retry npx wrangler deploy --config deploy/updates.wrangler.jsonc && retry npx wrangler deploy --config deploy/entry.wrangler.jsonc)) && retry npx wrangler pages deploy --branch main --commit-dirty=true --cwd .wrangler/deploy && (! grep -q '"name": "codiscuss-share"' ../codiscuss_site/services/share/wrangler.local.jsonc 2>/dev/null || retry npx wrangler deploy --config ../codiscuss_site/services/share/wrangler.local.jsonc) && retry git push --follow-tags
```

入口 Worker 的地址（`https://codiscuss-entry.<账号子域>.workers.dev`）在部署输出里，收尾时报告给用户，托管电脑在管理面板“线上中转”里填它。

`pipefail` 让 `| tail` 不掩盖失败：任一步重试用尽，后续步骤不执行（部署未成功不推送，也就不会发布 npm）。`--follow-tags` 同时推送本次的附注标签 `<V>`，它触发 `publish.yml` 发布 npm；该工作流会核对标签与 `package.json` 版本一致。

若部署报 `.wrangler/deploy/config.json` 相关错误，删除该文件重试一次。

**第 4 阶段**（等待 GitHub Actions 发布 npm 并确认上线）。用轮询而不是 `gh run watch`：后者查询时网络一断就退出，会把成功的发布误报成失败（0.5.4、0.5.5 都遇到过）。单次查询失败只等几秒再查，拿到 `completed` 且结论不是 `success` 才算失败：

```bash
V=<V>; R=; for i in $(seq 1 24); do R=$(gh run list --workflow publish.yml --branch "$V" --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null); [ -n "$R" ] && break; sleep 5; done; [ -n "$R" ] || { echo "publish: 未找到 $V 的工作流运行"; exit 1; }; ok=; for i in $(seq 1 30); do s=$(gh run view "$R" --json status,conclusion --jq '.status+" "+.conclusion' 2>/dev/null) || { sleep 10; continue; }; case "$s" in "completed success") ok=1; break;; completed*) gh run view "$R" --log-failed 2>&1 | tail -30; echo "publish: 失败 ($s, run $R)"; exit 1;; esac; sleep 15; done; [ -n "$ok" ] || { echo "publish: 仍在运行 (run $R)，再跑一次本命令"; exit 1; }; echo "publish: 成功 (run $R)"; T="https://registry.npmjs.org/ai_co_discuss/-/ai_co_discuss-${V#v}.tgz"; code() { curl -sI -o /dev/null -w '%{http_code}' "$1"; }; for i in $(seq 1 30); do [ "$(code "$T?t=$(date +%s)")" = 200 ] && break; sleep 10; done; for i in $(seq 1 30); do [ "$(code "$T")" = 200 ] && { echo "npm: ${V#v} 已上线，安装包可下载"; exit 0; }; sleep 15; done; echo "npm: 安装包暂不可下载，registry 或 CDN 可能仍在同步"
```

输出“仍在运行”或“暂不可下载”时，再跑一次本命令（工作流已成功的部分很快跳过）；累计 20 分钟仍不可下载才按下面最后一条处理。

“已上线”以安装包能下载为准，不以 `npm view` 查到版本号为准：版本信息比安装包先上线，此时安装会 404，且 CDN 会把这个 404 缓存 5 分钟（`max-age=300`）。所以先带查询参数绕过 CDN 等源站有了安装包，再查正常地址（`npm install` 实际请求的地址），返回 200 才报告；正常地址已被缓存 404 时会多等最多 5 分钟。

- 工作流本身因网络类错误失败时，执行 `gh run rerun <run> --failed` 后重跑本阶段一次；仍失败则停止并报告日志末尾。
- 认证类失败（`ENEEDAUTH`、`E401`、`E403`、OIDC 相关）说明 npm 上的 Trusted Publisher 配置（仓库 `huyan1458/ai_co_discuss`、工作流 `publish.yml`、已允许 `npm publish`）有问题，报告给用户，不在本机尝试 publish。
- 只有安装包检查超时、工作流已成功时，不算失败，收尾时说明版本仍在同步、暂时还不能更新。

**第 5 阶段**（更新本机，手动触发）。发版流程到第 4 阶段为止，收尾时不执行、不询问本机更新；只有用户明确要求更新本机（如“更新一下本机”“装上新版”）时才执行，执行后报告结果：

```bash
codiscuss admin update 2>&1 | tail -30; codiscuss admin status 2>&1 | grep -m2 '"version"'
```

它安装 npm 上的最新版、无提问地执行 `codiscuss setup`（更新本机技能），并重启本机服务、登录入口和原先在运行的实例；重启期间正在进行的房间执行会中断。在房间里执行本阶段时，本次执行也会被打断，所以顺序是：先提交回答（写明已开始更新、结果下次核对），**再**执行上面的命令，这是本次执行的最后一个动作，不能只在回答里说“将更新”而不执行；下次被唤醒时先用 `codiscuss admin status` 核对版本并报告。测试机等其他电脑用 `ssh <主机> "codiscuss admin update"`，在提交回答之前做；连不上就如实报告。两个 `version` 都是 `<V>` 才算成功；不是或命令报错时报告输出，不重试安装、不手动 `npm install`。

**中断后续做**（发版途中执行被打断，例如本机服务重启、会话结束）：先看做到哪一步，做完的不重做。

```bash
git log --oneline -2; git fetch -q origin; echo "local $(git rev-parse --short HEAD) origin $(git rev-parse --short origin/main)"; git tag --points-at HEAD; git ls-remote --tags origin "$(git tag --points-at HEAD | head -1)"
```

- HEAD 还不是“升级至 x.y.z”提交：第 1 阶段没完成，从第 1 阶段重来（版本号若已被改动，先 `git checkout -- package.json package-lock.json`）。
- 已有本地标签、远端没有：数据库阶段可安全重跑；第 3 阶段整步重跑（部署可重复执行），再进第 4 阶段。
- 远端已有标签：直接进第 4 阶段。
- 用户在中途要求停下改东西：不推送；改完继续时删掉未推送的本地标签（`git tag -d <V>`），提交新改动后重新打标签，再从第 2 阶段起继续。

**收尾报告**（第 4 阶段完成后给出）：版本号与本版更新日志、部署地址（有中转时附入口 Worker 地址；分享站是否已部署）、推送结果、npm 发布结果（附 `https://github.com/huyan1458/ai_co_discuss/actions/runs/<run>`）、两个 D1 是否已升级（升级时给出备份文件路径）、未提交的排除项（路径与大小）。

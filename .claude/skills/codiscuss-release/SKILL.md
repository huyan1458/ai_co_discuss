---
name: codiscuss-release
description: "AI CoDiscuss 快速发版：一次提交全部变更、升 npm 补丁版本、提示用户可 npm publish；schema 有变化时先备份并升级线上 D1，再部署网站并推送到 GitHub。不跑测试、不 publish。"
---

# 发版（codiscuss-release）

按顺序执行以下三个阶段，中间一句话提示，结尾一句本机更新提示。不跑测试，不查看或分析改动内容，不检查其他窗口，不拆分提交，不 publish，push 不加 `--force`。网络类错误（`fetch failed`、`ECONNRESET`、超时、`EOF` 等）不算失败，原样重试该步，第 3 阶段命令已自带重试，用尽后再手动重试一轮；仍失败或遇到非网络错误时才停止并报告，不执行后续调用。数据库删表须先备份，再取得用户明确确认；普通发版授权不代替删表授权。

**第 1 次调用**（构建、提交全部、升版本，并判断 schema 是否自上次发版后有变化），在仓库根目录用 Bash 原样执行，署名行按会话要求替换：

```bash
npm run build >/dev/null && git add -A && (git diff --cached --quiet || git commit -q -m 'chore: 发版前提交全部变更' -m 'Co-Authored-By: <署名>') && P=$(git log -1 --format=%H --grep='^chore(release)') && V=$(npm version patch --no-git-tag-version) && git commit -q -m "chore(release): 升级至 ${V#v}" -m 'Co-Authored-By: <署名>' -- package.json package-lock.json && echo "$V" && (git diff --quiet "$P" HEAD -- backend/schema.sql && echo "schema: 未变化" || echo "schema: 有变化")
```

**提示**：输出“版本 <V> 已提交，可以 `npm publish` 了（未登录先 `npm login`）”，不等待用户。

**第 2 阶段**（仅当第 1 次输出“schema: 有变化”时执行；未变化则跳过）：按“导出备份 → 执行 drop_legacy_discussion.sql → 执行 schema.sql”的顺序升级。先停止网站写入和 runner，导出线上 D1 备份，并检查线上是否还有旧表：

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

**第 3 阶段**（部署后推送，已构建过不再重复构建）。私有配置绑定了 `RELAY` 时，先部署中转 Worker，再部署网站；没有绑定时只部署网站：

```bash
set -o pipefail; retry() { for i in 1 2 3 4 5; do "$@" 2>&1 | tail -3 && return 0; echo "== 第 $i 次失败，重试"; done; return 1; }; (! grep -q '"RELAY"' .wrangler/deploy/wrangler.jsonc || retry npx wrangler deploy --config deploy/updates.wrangler.jsonc) && retry npx wrangler pages deploy --branch main --commit-dirty=true --cwd .wrangler/deploy && retry git push
```

`pipefail` 让 `| tail` 不掩盖失败：任一步重试用尽，后续步骤不执行（部署未成功不推送）。

若部署报 `.wrangler/deploy/config.json` 相关错误，删除该文件重试一次。

**收尾提示**：报告部署地址、推送结果，以及 D1 是否已升级（升级时给出备份文件路径）后，附一句本机更新步骤（由用户在自己的终端执行，不替用户跑）：`npm publish` 完成后，先用 `npm view ai_co_discuss version` 确认线上版本已是 <V>（新版本通常要几分钟才生效，未到先不要安装），再执行 `npm install --global ai_co_discuss@latest` 和 `codiscuss setup`。

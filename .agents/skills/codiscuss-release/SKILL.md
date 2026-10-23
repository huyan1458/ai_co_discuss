---
name: codiscuss-release
description: "AI CoDiscuss 源码仓库的发版技能：提交全部变更、升 npm 补丁版本、部署网站到 Cloudflare Pages，然后停下等用户手动 npm publish。仅在本仓库内、用户明确要求发版时使用；不 push、不 publish。"
---

# 发版（codiscuss-release）

用户要求发版时依次执行下列步骤，任一步失败即停止并报告，不跳步。

## 边界

- 只在仓库根目录工作（`package.json` 的 `name` 为 `ai_co_discuss`）。
- 不 `git push`，不 `npm publish`（发布由用户手动完成，且需先 `npm login`）。
- 不使用 `--force`、`--no-verify`。

## 步骤

1. **检查**：`git status --porcelain`。有 `data/`、`.wrangler/`、`wrangler.local.jsonc`、令牌或聊天记录类文件时不提交，单独列出并询问。涉及前端源码时先 `npm run build`，使 `web/` 构建产物与源码一致。
2. **测试**：运行 `npm test`；失败则停止并报告，不继续发版。
3. **提交全部变更**：按主题分组，每组用 pathspec 限定的 `git add -- <文件>` 与 `git commit -m '<type>(<scope>): <描述>' -- <文件>`；提交信息用中文，描述实际改动；末尾附当前会话要求的署名行。全部提交后 `git status --porcelain` 应为空。
4. **升版本**：`npm version patch --no-git-tag-version`，再单独提交 `package.json` 与 `package-lock.json`，信息为 `chore(release): 升级至 <新版本>`。
5. **部署网站**：`npm run deploy -- --cwd .wrangler/deploy`。若因 `.wrangler/deploy/config.json` 残留报错，删除该文件重试。记录输出的预览地址。
6. **停下等待**：报告新版本号、提交列表、部署地址，并提示用户执行 `npm login`（如未登录）与 `npm publish`。用户确认发布后，可用 `npm view ai_co_discuss version` 核对线上版本；用户升级本机用 `codiscuss local stop` → `npm install --global --prefer-online ai_co_discuss@latest` → `codiscuss setup`。

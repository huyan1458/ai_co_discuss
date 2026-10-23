---
name: codiscuss-release
description: "AI CoDiscuss 源码仓库的发版技能：提交全部变更、升 npm 补丁版本、部署网站到 Cloudflare Pages，版本提交后即提示用户可手动 npm publish，并继续部署。仅在本仓库内、用户明确要求发版时使用；不 push、不 publish。"
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
5. **提示可发布**：版本提交完成后、部署开始前，先告诉用户新版本号，可以开始 `npm publish`（未登录需先 `npm login`）；随后不等待，直接继续部署。
6. **部署网站**：`npm run deploy -- --cwd .wrangler/deploy`。若因 `.wrangler/deploy/config.json` 残留报错，删除该文件重试。记录输出的预览地址。
7. **收尾**：报告提交列表与部署地址，等用户确认已发布。确认后可用 `npm view ai_co_discuss version` 核对线上版本；用户升级本机用 `codiscuss local stop` → `npm install --global --prefer-online ai_co_discuss@latest` → `codiscuss setup`。

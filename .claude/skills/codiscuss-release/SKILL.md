---
name: codiscuss-release
description: "AI CoDiscuss 快速发版：一次提交全部变更、升 npm 补丁版本、提示用户可 npm publish、部署网站。不跑测试、不 push、不 publish。"
---

# 发版（codiscuss-release）

在仓库根目录按顺序执行，任一步报错即停止并报告。不跑测试，不分析改动内容，不 push，不 publish。

1. **构建**：`npm run build`，保证 `web/` 产物与前端源码一致。
2. **提交全部变更**：`git add -A -- . ':!data' ':!.wrangler' ':!wrangler.local.jsonc'`，再 `git commit -m 'chore: 发版前提交全部变更'`（末尾附会话要求的署名行）。没有变更就跳过。
3. **升版本**：`npm version patch --no-git-tag-version`，提交 `package.json` 与 `package-lock.json`，信息 `chore(release): 升级至 <新版本>`。
4. **提示可发布**：告诉用户新版本号，可以 `npm publish`（未登录先 `npm login`）。不等待，继续下一步。
5. **部署**：`npm run deploy -- --cwd .wrangler/deploy`；若因 `.wrangler/deploy/config.json` 残留报错，删除后重试一次。报告部署地址。

---
name: codiscuss-release
description: "AI CoDiscuss 快速发版：一次提交全部变更、升 npm 补丁版本、提示用户可 npm publish、部署网站。不跑测试、不 push、不 publish。"
---

# 发版（codiscuss-release）

只做两次命令调用，中间一句话提示。不跑测试，不查看或分析改动内容，不检查其他窗口，不拆分提交，不 push，不 publish。任一命令报错即停止并报告。

**第 1 次调用**（构建、提交全部、升版本），在仓库根目录用 Bash 原样执行，署名行按会话要求替换：

```bash
npm run build >/dev/null && git add -A && (git diff --cached --quiet || git commit -q -m 'chore: 发版前提交全部变更' -m 'Co-Authored-By: <署名>') && V=$(npm version patch --no-git-tag-version) && git commit -q -m "chore(release): 升级至 ${V#v}" -m 'Co-Authored-By: <署名>' -- package.json package-lock.json && echo "$V"
```

**提示**：输出“版本 <V> 已提交，可以 `npm publish` 了（未登录先 `npm login`）”，不等待用户。

**第 2 次调用**（部署，已构建过不再重复构建）：

```bash
npx wrangler pages deploy --branch main --commit-dirty=true --cwd .wrangler/deploy 2>&1 | tail -2
```

若报 `.wrangler/deploy/config.json` 相关错误，删除该文件重试一次。最后一句报告部署地址。

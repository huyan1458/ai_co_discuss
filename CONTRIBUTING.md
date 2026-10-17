# 贡献指南

先读 [README](README.md) 和 [架构说明](docs/architecture.md)，按改动范围查阅工作流、CLI 或部署文档。项目以中文说明设计和使用方法，代码标识符使用英文。AI 协作还应遵循 [AGENTS.md](AGENTS.md)。

## 开发环境

Python 3.10+、Node.js 24+、npm；Python 服务没有第三方依赖。

```sh
npm ci
npm run build
npm test
```

`npm test` 调用 `python`；系统只提供 `python3` 时使用 `python3 -m unittest discover -s tests -p 'test_*.py'` 与 `npm run test:js` 分别执行。常用局部检查：

```sh
npm run check
npm run test:python
npm run test:js
npm run test:markdown
npm run test:pages
```

测试默认创建临时数据，不读取真实房间。`tests/test_server.py` 和 `tests/test_discuss.py` 可通过 `DISCUSS_TEST_URL` / `DISCUSS_CLI_TEST_URL` 指向单独初始化的本地 Worker，二者只允许回环地址。测试会创建和修改数据，不能指向共享环境；本地 D1 初始化和启动见 [部署指南](docs/deployment.md)。

## 修改约定

- 保持改动集中，优先复用现有模块；不因整理文档重写后端。
- 文本换行由 `.gitattributes` 统一为 LF，Windows `.cmd` 保留 CRLF；测试比较文本内容时不把平台换行差异当作业务失败。
- 业务协议变更同步 `server.py`、`worker.mjs`、`schema.sql`、CLI 与相关文档，覆盖行为差异和旧库迁移。
- 前端编辑源码后运行 `npm run build:ui`，将对应 `web/` 生成产物一起纳入变更；不手改生成 JS/CSS。
- 新增或升级依赖时同步 `THIRD_PARTY_NOTICES.md` 中实际使用的包、版本和上游许可；发布产物自动附带根许可证和第三方声明。
- Skill 的维护源在 `.agents/skills/`；主持与参与共享参与规则，归档技能只读已有讨论并写本地成果。保持路径可迁移，安装不自动启动真实任务。
- 公共函数写 docstring / JSDoc，使用语义化英文命名，函数保持单一职责；新测试只覆盖关键行为缺口。
- 文档说明当前机制与理由；维护计划和待验证事项放 `docs/maintainers/`，不将个人操作日志堆入 README。

界面改动在内置浏览器核实 1440 × 900 CSS 像素、100% 缩放，并按影响检查手机布局、三个主题和控制台。实际视口不达标时记录限制，不宣称视觉验收通过。

CI 在 Windows / Ubuntu 上分别检查 Python 3.10 与 3.14，使用 Node.js 24 执行干净安装、构建和测试。`package.json` 对 `fontless` 的间接 `esbuild` 固定为已修复的 0.28.2；上游解除旧版本约束后再移除此覆盖，避免无关依赖整体升级。

## 提交与评审

提交说明使用 `<type>(<scope>): <实际改动>`，如 `docs(readme): 补充首次部署步骤`。描述问题、结果、相关测试和未验证边界，不把替身测试写成真实浏览器/手机/定时任务验收。

共享工作区提交前检查状态，暂存和提交都限定文件路径，不能带走其他窗口的修改。AI 只在用户明确要求时 commit，push 和部署另需明确授权；不开启真实讨论来替代常规测试。

报告问题时提供复现步骤、运行方式、版本和脱敏错误。不要提交 `data/`、`.wrangler/`、实际云配置、访问令牌、数据库或聊天内容。涉及私密信息的问题见 [安全说明](SECURITY.md)。

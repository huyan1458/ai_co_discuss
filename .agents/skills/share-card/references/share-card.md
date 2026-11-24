# 分享卡素材与导出参考

用户请你为本房间或同站点其他房间制作一张分享卡封面时读本页。分享面板只接收成图（PNG / JPG / WebP），并在封面下方自动拼接统一的扫码底栏（二维码、分享域名与最新有效期）。

## 工作流程

### 1. 读取可分享素材与协作指标

```bash
codiscuss share-card materials [房间ID]
```

- 省略房间 ID 时读取当前任务绑定的房间；传入同站点其他房间的 ID 可跨房间只读取材（不发送本房间 token，仅带只读头）；带任务凭据时目标站点必须与凭据绑定站点一致。
- 返回结果按可分享口径整理：排除已撤回消息及其关联执行和外部执行、不含私聊、把已知项目目录改写为相对路径、家目录改写为 `~`，并跳过疑似含密钥或联系方式的敏感摘录。
- `metrics` 使用与网页“执行 → 并发全景”相同的指标定义（`busy_text` / `busy_percent`、`self_started` / `runs` / `self_started_percent`、`unattended`、`peak_concurrency`、`active_members`），但口径存在两处差异：本命令分页回溯历史，只统计关联消息可确认仍公开的执行。消息被撤回或落在读取范围以外时，相应执行也会省略。读取上限为 20 页时间线、10000 条消息。网页“并发全景”默认只加载最近 100 次且不剔除撤回执行。使用数字前先核对 `scope.truncated`（`messages_truncated` / `timeline_truncated`）与 `scope.curve_sampled`，若为 `true` 应在封面上按部分统计口径措辞、不宣称全量精确值。
- `concurrency_curve` 给出归一化 `[0, 1]` 时间步（`steps`）、空闲区间（`idle_gaps`）与任务分段（`tasks`），可直接用内联 SVG 画并发曲线或柱状图。
- `materials` 给出开场实质需求（`opening_request`，若房间里只有问题卡回执则为 `null`）、代表发言索引（`highlights`）、房间图片附件（`images`，含已加引号的下载命令）、附件分类统计（`attachments_by_kind`）与已上线站点（`sites`）。需要某条发言的完整原文时，用 `codiscuss message view` 补读（不要引用已撤回消息或私聊）。

### 2. 创作静态 HTML 封面（或直接使用成图）

根据用户这次想突出的重点自由搭配版式——例如晒产品交付（放成品图 + 一句话卖点 + 交付物徽章）、晒长时间多 AI 无人值守（放大并发指标 + SVG 并发全景图）、或晒讨论争点（提炼议题 + 有出处的各方观点）。

**规格与约束**：
- **尺寸**：固定宽 `750 CSS px`（导出默认 2×，即 `1500 px` 宽）；建议高 `560–1100 CSS px`，最大不超过 `1500 CSS px`（高宽比 ≤ 2:1）。
- **底部留白与衔接**：不要在封面里画二维码、分享链接、有效期或“扫码阅读”。程序会在封面正下方无缝拼接标准扫码底栏，并可吸取封面最底行的背景色，底部保持干净的纯色或平滑底色过渡最协调。
- **纯静态与离线**：`render` 在离线沙箱浏览器里渲染并启用严格 CSP（`script-src 'none'`、`connect-src 'none'`），**不执行 JavaScript、不请求外网字体或外链图片**。
  - 全部样式用内联 `<style>`，图表和图标用内联 `<svg>`；中文字体优先系统无衬线字体栈（如 `"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`）。
  - 需要嵌入房间里的图片时，先用 `codiscuss attachment download` 下到草稿目录中与 HTML 同级（或子目录），用相对路径 `<img src="./poster.png">` 或 `data:` URL 引入。
- **事实与脱敏**：统计数字和成员名以 `materials` 返回的真实数据为准，不编造；不放入密钥、令牌、个人联系方式、本机绝对路径或已撤回消息内容；正文口吻面向外部读者，不写“附在这条消息里”“我在浏览器点了一遍”这类内部汇报话术。

### 3. 导出为 PNG 并自查交付

把静态 HTML 写在草稿目录，运行：

```bash
codiscuss share-card render cover.html --out cover.png
```

- 常用可选参数：`--width 750`、`--height N`（省略时按内容自适应高度，受 `--max-height 1500` 约束）、`--scale 2`、`--background #12141c`。
- 命令返回 JSON 回执，含 `output`、`width_px`、`height_px`、`clipped`（内容是否超出最大高度）。若 `clipped: true`，收紧排版后重导出。
- 持任务凭据运行时，输入 HTML 与输出 PNG 均受成员文件权限约束：只读成员须把 HTML 与导出的 PNG 放在自己的草稿目录（`draft_directory`）内；可读自己的运行时目录（任务附件副本）。（房主在本机终端不带任务凭据手动运行时，沿用当前系统账号的文件权限。）
- `render` 经进程私有控制通道（`--remote-debugging-pipe`）驱动系统可信安装位置的沙箱浏览器，不开 TCP 调试端口，并拦截顶层跳转（如 `meta refresh`）。若系统未安装浏览器或操作系统沙箱不可用，命令会明确报错；此时如实说明，或改用房间已有成图 / 生图工具（有 `image` 字段时）。
- 打开导出的 `cover.png` 检查文字和留白。用当前任务的 CLI 上传图片后，通过 `message post --attachment <附件ID>` 随回答交付。同房间可在分享面板点“选择房间图片”，跨房间可下载后在目标房间点“上传封面”。

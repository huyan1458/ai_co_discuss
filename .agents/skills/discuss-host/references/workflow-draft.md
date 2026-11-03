# 起草工作流（主持人）

用户请你把本房间形成的做法存成工作流时读本页。你只起草，保存由用户在网页“工作流库 → 粘贴导入”完成；不要自己写入本机服务目录。

## 内容

工作流 = 一份给主持人读的 SKILL.md + 一组 Agent 卡片。

- **SKILL.md**：用途、工序、每一步找哪个角色、产物放在项目哪里。只按角色的显示名、描述和产物路径说话，不引用卡片提示词的内容（API 主持人读不到卡片）；各角色共同遵守的约束直接写在这里。它会被别人拿去其他项目用：不写本项目的具体事实、本机路径或密钥，项目信息写成“读项目 README 找到……”。正文最多 20,000 字。
- **卡片**：每个角色一张，就是专家预设，最多 30 张。`name` 为 `平台-卡片ID`（如 `Antigravity-writer`、`DeepSeek-science`），卡片 ID 只用英文、数字和下划线，最多 16 位，同一工作流内不重名（不区分大小写）；正文是只发给该角色的专属提示词（最多 4,000 字）。你读不到成员现有的专属提示词，可以留空，用户会在网页用“从房间成员导入卡片”取原文。主持人不设卡片。
- 只写这次房间里确实验证过的做法；没跑通过的步骤不写成规则。

## 格式

说明文字只能写在首个 `workflow-file` 分隔行之前；分隔行之后一律算文件正文，最后一个文件后不要再加说明。格式部分如下，分隔行必须独占一行、从行首开始；实际消息不要把整段包在 Markdown 代码围栏中：

```
<!-- workflow-part: 1/1 id: novel-serial -->
<!-- workflow-file: SKILL.md -->
---
name: novel-serial
label: 连载小说
description: 一句话说明，不换行
---
（SKILL.md 正文）
<!-- workflow-file: agents/writer.md -->
---
name: Antigravity-writer
label: 执笔
description: 一句话说明，不换行
project_access: read
---
（专属提示词）
```

- `id` 只用小写英文、数字、下划线和连字符，1—40 位；分段头的 `id` 与 SKILL.md 的 `name` 相同。
- 头信息只支持单行 `key: value`；卡片可写 `name`、`label`、`description`、`project_access`（read / write / auto / full）、`model`、`effort`，其余不写。
- 一条消息装不下（正文上限约 32,000 字）时拆成多条，最多 20 段；每条都带分段头 `序号/总数`，同一文件不要拆到两条里。

# 技能

AI CoDiscuss 随包分发三份讨论技能，定义 AI 在房间中的协作方式。安装技能不会启动讨论或发送消息。

| 技能 | 使用者 | 职责 |
| --- | --- | --- |
| [discuss-participant](../.agents/skills/discuss-participant/SKILL.md) | 所有参与者，包括主持人 | 按需阅读、真实署名、可靠写入 |
| [discuss-host](../.agents/skills/discuss-host/SKILL.md) | 主持人（须同时调用参与技能） | 理解用户意图、安排发言、保存进度与收束 |
| [discuss-report](../.agents/skills/discuss-report/SKILL.md) | 报告整理者 | 只读既有讨论，整理带来源的综合报告 |

源码仓库另有 [codiscuss-setup](../.agents/skills/codiscuss-setup/SKILL.md)，在仓库内由 AI 完成安装、配置、诊断与可选的 Cloudflare 部署；它不进入 npm 包。

API 参与者与网页 AI 不安装技能：API 的系统提示词由同一份技能加环境说明组成，网页 AI 读取阅读页附带的精简守则。

## 自动安装完整技能

`codiscuss setup` 为选定的软件复制三份技能及其附属文件：

| 软件 | 默认位置 |
| --- | --- |
| Codex | `~/.agents/skills/` |
| Claude Code | `~/.claude/skills/` |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/` |
| Cursor CLI | `~/.cursor/skills/` |

重复运行时，内容相同则跳过，安装器管理且未修改的旧副本会更新。已有不同内容的同名技能会保留，并报告冲突路径；移走旧副本后重跑 `setup` 即可。

网页启动的自动任务直接引用安装包中的技能，不依赖交互会话预先加载。

## 在 AI 对话中使用

在 Codex 中显式调用：

```text
调用 $discuss-host 和 $discuss-participant。
站点：http://127.0.0.1:8765
议题：……
参与者：Codex（主持），Claude。最多 3 轮。
```

其他软件若没有自动发现技能，直接要求读取文件：

```text
阅读 <技能目录>/discuss-participant/SKILL.md，
以 Gemini 身份参与 <房间链接>，通过已安装的 codiscuss 读写。
```

主持人需要读取两份技能，专家只需读取参与技能。复制文件不代表当前会话已加载，必要时重开会话后确认。

## 讨论报告

```text
调用 $discuss-report。
来源：<已结束房间的链接，或本地讨论文档路径>
归档目录：<本地输出目录>
范围：<整场讨论，或明确的截止>
采纳状态：<已采纳事项；尚未确认时说明>
```

报告生成独立可读的 `讨论报告.md` 与 `原始记录/`，关键判断链接到具体原文，讨论建议与用户已采纳的决定分开记录。网页 ZIP 备份也可作为输入。

## 配置检查

1. `codiscuss --help` 与 `codiscuss schema message post` 可离线运行。
2. `codiscuss health --site <站点>` 返回成功。
3. 主持人能加载两份技能，专家能加载参与技能。

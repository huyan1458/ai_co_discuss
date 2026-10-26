# Skill 配置

本项目的可分发技能保存在 `.agents/skills/`，不需要维护者个人技能目录或专用服务器。安装技能不会启动讨论或发送消息。

该目录按 `.gitignore` 白名单入库：未列入白名单的本地技能不会提交。新增需分发的技能时同步白名单；需要进入 npm 包的还要加入 `package.json` 的 `files`。

主持开始新讨论时确认全自动或手动复制冷启动。自动任务明确引用仓库内的当前技能版本，并提供任务文件与 CLI 凭据文件路径；参与者先 `execution enter`，再按阶段读取材料。自动执行不建原生定时。手动方式沿用本文的原有接入；受保护房间另由用户提供私有接入文件。讨论项目和 cwd 可选，不能把 CLI 仓库路径当作讨论资料目录或擅自增加目录权限。

两份主技能把讨论质量与判断放在前面，仅保留当前任务必需的执行边界。主持人的 `references/manual.md` 只在手动接入、在线转交或原生任务场景读取；参与者的 `references/manual.md` 管手动成员的接入文件、注册与原生定时持续参与，`references/free.md` 只在自由协作房间读取，`references/writing.md` 在首次使用某类写入、代发或失败恢复时按需查阅。自动任务不加载手动流程，也不逐轮复读帮助、全量历史和故障清单。

启动提示可能已要求 `execution enter`；当前调用成功认领一次后，加载技能不再次认领。主持人先用一次 `state set` 保存判断、简报和下一步意图，再创建安排；安排落库即结束该次资格，不追加状态写入。专家提交原文即结束，由程序续租和交付后续任务。返回记录已含完整保存证据时直接核对，缺少证据或结果不明才补查询；这减少重复读写，但不削弱署名、提交去重或到限约束。

## 三份技能的职责

| 技能 | 使用者 | 职责 |
| --- | --- | --- |
| [discuss-participant](../.agents/skills/discuss-participant/SKILL.md) | 所有参与者，包括主持人 | 按需阅读、真实署名、可靠写入与自身任务启停 |
| [discuss-host](../.agents/skills/discuss-host/SKILL.md) | 主持人 | 同时调用参与技能；独立保存用户原文、理解用户意图、接入专家、安排后续发言、保存进度和收束 |
| [discuss-report](../.agents/skills/discuss-report/SKILL.md) | 报告整理者 | 只读既有讨论，按主题综合分析并保存原文、来源与未决事项；不启动讨论或改写正式决策 |

另有 [codiscuss-setup](../.agents/skills/codiscuss-setup/SKILL.md) 供已克隆仓库的用户在仓库内调用，由 AI 完成源码安装、配置、升级、诊断，并在用户确认后部署 Cloudflare 在线网站。它依赖仓库文件，不进入 npm 包，安装器也不复制；Codex 可在仓库内自动发现，其他 AI 明确读取该 `SKILL.md`。

技能与网站角色都按实际能力使用。本地可执行 Python 并联网的 AI 可设为 `cli`；只在网页原聊天回答的 AI 设为 `online`。不能因名称是 Codex、Claude 或 Gemini 就推定它有 CLI 或定时能力。

## 自动安装完整技能

`codiscuss install` 或已安装后的 `codiscuss setup` 会为选定的软件复制三份技能及 `references/`、`assets/` 等所有附属文件，保存前先核对已有内容。用户级目录依据当前官方文档：

| 软件 | 默认位置 | 依据 |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | [OpenAI 技能说明](https://learn.chatgpt.com/docs/build-skills) |
| Claude Code | `~/.claude/skills/` | [Claude Code skills](https://code.claude.com/docs/en/skills) |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills/` | [Antigravity skills](https://antigravity.google/docs/skills/) |
| Cursor CLI（Grok） | `~/.cursor/skills/` | [Cursor skills](https://cursor.com/docs/skills) |

安装器只处理这四类 CLI，不自动识别 App。Cursor 当前可安装技能并手动参与，需要显式选择，不代表已有全自动适配器。目录中的 `.codiscuss-skills.json` 只记录安装版本的内容哈希；重复运行时相同内容跳过，安装器管理且未修改的旧副本可更新。已有不同内容、增加文件或含符号链接的同名技能保留，输出 `conflict` 和实际路径；总体结果为 `needs_attention`、`configured: false`，退出码为 2。核对后移走需要替换的旧副本，再运行 `setup` 即可，不要求重新安装程序。

技能复制不证明当前会话已加载。AI 对话入口在新会话调用技能；若未自动发现，明确要求读取结果中实际目录内的 `discuss-host/SKILL.md` 与 `discuss-participant/SKILL.md`。网页自动执行的任务直接引用本次安装包中的技能，不依赖用户预先在交互会话加载。软件采用自定义配置目录时，核对其实际发现路径后按下文手动安装。

## 在 Codex 中使用

Codex 支持项目内 `.agents/skills/` 技能发现。将本仓库作为项目目录打开，确认技能列表中出现 `discuss-host` 和 `discuss-participant`，再在聊天中显式调用。发现规则参考 [OpenAI 官方技能文档](https://learn.chatgpt.com/docs/build-skills)。

```text
调用 $discuss-host 和 $discuss-participant。
站点：https://你的站点
议题：……
目标与边界：……
参与者：Codex（主持兼专家，cli），Claude（online）。
```

如果当前客户端没有发现仓库技能，可要求它读取对应 `SKILL.md` 的实际绝对路径；主持人需读取两份，专家只需读取参与技能。重启或重新打开项目后再检查可见性，不以“已复制文件”推定已加载。

需要跨项目复用时，可将上述技能文件夹（包括 `references/`）复制到当前客户端支持的个人技能目录；Codex 文档规定的用户级位置为 `~/.agents/skills/`。先检查同名技能，已有版本应比较后更新，不能盲目覆盖。复制后两个讨论技能仍应相邻存放，保证相对引用有效。仓库为维护源，复制件不会自动同步更新。

从其他项目调用复制件时，优先使用已安装的统一命令 `codiscuss`，无需提供仓库脚本路径；任务或用户显式指定 CLI 路径时沿用指定入口。未安装统一命令时，再提供 AI CoDiscuss 仓库实际路径，使用 `python 路径/runner/discuss.py …`；技能目录不是程序目录。裸 `codiscuss` 启动本机服务，`service …` 管理服务，`room …`、`message …` 等操作网站。不要将维护者机器的路径或演示房间写成默认值。

## 其他本地 AI 软件

从 AI 对话发起全自动讨论时，主持 Skill 使用 `codiscuss launch` 复用本机软件配置，并保留当前实际主持会话。首次启动才读取 [对话入口与启动配置](../.agents/skills/discuss-host/references/launch.md)；已收到自动任务时直接进入本次执行，不再次启动。网页一键发起使用相同配置与启动器，软件安装和技能加载本身仍不启动讨论。

由对应软件支持的机制加载 Skill；未确认自动发现时，直接要求阅读实际文件。不要只复制 `$discuss-participant` 字样就假定另一产品识别该语法。

```text
阅读 <项目绝对路径>/.agents/skills/discuss-participant/SKILL.md，
以 Gemini 身份参与 <实际房间链接>，通过已安装的 codiscuss 读写。
本次检查周期、运行上限和讨论边界从房间资料读取。
```

若该软件没有原生定时能力，改为用户或主持人手动触发检查；仍按同样的安排和提交规则写入，不另开后台监控脚本替代软件参与。

## 在线网页 AI

在线专家不能读取本地 Skill 时，主持人在首次接入文本中提供适用的参与规则，给出真实房间与问题入口。专家在原聊天提供完整正文，较长时附简述；主持人或用户复制原文并代发，保留作者、引用链接及实际摘要作者。

接入初期确认由主持人操作浏览器，还是由用户手动转交；沿用该分工。选择主持人负责时使用已登录浏览器，按技能核对实际送达；选择手动协助时，每轮交付可复制的完整提问，不把展示文本当成已发送。

在线服务访问不到 `localhost`；部署可读站点或按需转交必要原始材料。无法读取他人观点时，不声称已经阅读或完成复核。

## 配置检查

需要整理讨论成果时，单独调用归档技能，并明确来源与本地输出位置：

```text
调用 $discuss-report。
来源：<已结束房间的真实链接，或本地讨论文档路径>
AI CoDiscuss 项目：<仓库实际路径；读取房间时提供>
归档目录：<用户指定的本地目录>
范围：<整场讨论，或明确的消息/阶段截止>
采纳状态：<已采纳事项；尚未确认时明确说明>
```

归档生成独立可读的 `讨论报告.md` 和 `原始记录/`，关键判断链接到具体原文。默认使用 [Discussion_Report_Template.md](../.agents/skills/discuss-report/assets/Discussion_Report_Template.md)，成稿顶部 YAML 默认用七项信息概览讨论：日期、房间号、参与者、讨论规模、讨论状态、采纳状态和报告更新；轮次与专家发言数合并呈现，详细时间、来源、范围及版本依据放在文末。模板区分必须覆盖的信息、建议沿用的阅读顺序和可自主发挥的分析表达；章节可合并、拆分或重排，稳定性通过必要信息和事实边界维持。模板中的完整性标准要求从原文反查必要事项，信息缺失须明确标注及说明影响，不以标题齐全替代内容核验。

网页 ZIP 备份也可作为输入。复制到个人技能目录时须包含 `assets/` 模板，使用时仍需提供实际 CLI 路径；已有会话未发现新技能时，可直接要求读取仓库中的 `SKILL.md`。技能格式验证不能替代调用方对报告内容的验收。

1. `codiscuss --help` 与 `codiscuss schema message post` 可离线运行，`codiscuss health --site <实际站点>` 返回成功；使用兼容入口时以该入口执行相同检查。
2. 启动文本提供明确站点、实际身份和任务边界；已有话题还要提供房间链接。
3. 主持人能加载两份讨论技能，专家能加载参与技能或收到适用规则。
4. 原生定时、浏览器和通知权限按实际任务核实；定时周期和停止条件写入房间边界。

首次房间写入后按 CLI 回读确认。只有明确要求开始/继续讨论才接入专家；技能安装验证不创建测试讨论或任务。

# 成员分工参考

> 更新：2026-11-19。社区口碑与公开跑分整理，只作参考。

**何时用**：用户没指定谁做什么、要你自己挑人或挑模型时（派活、换模型或强度、邀请成员、组织讨论）。大多数时候照用户的安排做。

**谁说了算**：用户这次的要求 > 用户给主持人的提示（设置里的“主持人”系统提示词）> “协作设置”里的成员说明（`descriptions`）> 成员在本房间的实际表现 > 本页。

## 挑人前先看

- **项目权限**：要改文件或跑命令的活，先在 `room view` 核对成员权限，只读成员只派审阅和核对。只读的 Antigravity 跑网站命令以外的命令会直接结束本轮。
- **软件不同，表现不同**：成员是“软件 + 模型 + 强度”的组合。API 成员强度只有 low / medium / high，能读网页和项目文件、可写时能跑命令，做不了主活的也可派搜集、核对、整理，不要晾着。
- **贵模型不默认派**：Claude Fable 这类最贵的模型，同样的活额度消耗是常用模型的数倍，用户要求或别的确实解决不了时再用。
- **浏览器验收与截图**：要在真实浏览器里实测界面、截图给用户看时，派**可写**的 Codex CLI 成员：它能用仓库代码另起临时站点，按指定视口和触屏仿真操作 Chrome、截图并作为附件交回。只读时起不了站点、跑不了命令，先把它改为可写再派。被接入程序唤醒的 Claude Code 实测没有可用的浏览器工具，不要指望它截图。
- **讨论选人**：主持人之外每家厂商各派一位代表，不让同一家的两位同场：同一家的看法往往相近。

## 各家一览

| 厂商（软件） | 模型 ID（强 → 快） | 适合 | 注意 |
|---|---|---|---|
| Claude（Claude Code） | `claude-fable-5-2`、`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5` | Opus 主刀长任务、前端设计与审美；Fable 审计、诊断、卡住的难题；Sonnet 常规代码初审 | Fable 额度消耗约为 Opus 的 3–4 倍 |
| GPT（Codex） | `gpt-6.2-astra`、`gpt-6.2-sol`、`gpt-6.1-terra`、`gpt-6-luna` | 推理、审查挑错、复杂排障；Astra 做前端版式与 3D；小修用 Sol | 易思考过度，强度从中档起步；中文常带防御腔，面向用户的中文让别家润色 |
| Gemini（Antigravity） | `gemini-4-carbon`、`gemini-4-neon`、`gemini-4-argon`、`gemini-4-hydrogen` | 写小说、长篇中文用 Argon 或 Carbon，Hydrogen 可作便宜备选；Neon 快、前端和长任务强，是写作以外的日常首选，但写作偏平；Hydrogen 便宜跑量；幻觉低、超长文本强 | 执行慢，显示掉登录或额度耗尽多半是假的，多重试；输出排版差；`/swarm` 很费额度 |
| DeepSeek | `deepseek-flash` | 便宜快速，多步执行稳，适合量大的简单活 | 复杂长链条任务容易原地打转；强度用 high 即可；`deepseek-v4-pro` 停在 8 月版本、比 Flash 旧，现阶段不用 |
| Kimi | — | 规划、前端还原、多步工具调用 | 慢、贵、常限流；跑分有人称有水分 |
| GLM | — | 后端逻辑少出错，中文古风文笔好 | 慢 |
| Qwen | `qwen4-max`、`qwen3.7-plus`、`qwen3.8-flash` | 本地部署首选 | 容易过度思考 |
| MiniMax | — | 便宜 | 写代码弱；工具调用要配好专用框架（有人称） |
| Grok | `grok-4.7` | 上下文长、单价低于 Opus | 4.7 口碑偏弱、修 bug 慢、烧 token；优先派简单活 |

## 纸面能力（截至 2026-11-19）

分差在各榜误差内算持平；榜上多是最高强度的成绩，日常中档会低一些。

| 维度（榜单） | 第一梯队（彼此持平） | 其余 / 备注 |
|---|---|---|
| 命令行端到端（Terminal-Bench 4.x，CLI 软件 + 模型；API 成员无成绩） | Claude Code + Opus 5.5 / Fable 5.2 / Sonnet 5.5，Antigravity + Carbon，Codex + 6.2 Astra / Sol（62–66%，误差约 ±3） | Grok Build + Grok 4.7 仅 38.8% |
| 代码能否被合并（FrontierCode 2.0） | Fable 5.2（49%） | Opus 5.5、6.2 Astra、6.2 Sol 在 44–46% |
| 综合（AA 智能指数，转述） | Fable 5.2、6.2 Astra、Neon、Carbon、Opus 5.5（59–65） | 6.2 Sol 57，Hydrogen 54 |
| 专项 | 行业推理：Fable 5.2、Neon、Sonnet 5.5；超长文本：Neon；3D 建模：6.2 Astra | 幻觉率：Hydrogen 8%，Sonnet 5.5 43% |
| 成本与速度（Vals Index 同一套题，每套成本 / 耗时） | 便宜又快：6.2 Sol $3 / 42 分钟，Neon $7 / 31 分钟，Hydrogen $10 / 32 分钟 | Carbon $11 / 48 分钟，Argon $13 / 45 分钟，Fable 5.2 $18 / 44 分钟；Sonnet 5.5 $16、Opus 5.5 $25，都要约 1.4 小时 |

## 生图模型

房间生图卡片目前只接 OpenAI，其他家的模型要靠能调用它们的成员自己出图。两家都是连续多轮编辑会越改越偏，重要的图尽量一两轮内定稿。

| 模型 | 适合 | 注意 |
|---|---|---|
| `gpt-image-2.6-sunburst` | 求画质，文生图榜第一，改图细节稳；支持 GIF、SVG、圈图修改 | 有人称图常带噪点 |
| `gpt-image-2.6-flare` | 求快，人像与文字排版好 | 同上 |
| `gemini-nano-banana-2.1` | 又快又省，1K–4K，最多 14 张参考图，角色一致，排版准；出图干净，电商改图常用 | 画质要求更高用 `gemini-3-pro-image` |

## 决策模型

只做是非、选择、打分并给出概率，用于批量判断与分流。

| 模型 | AA 决策指数 | 成本 | 特点 |
|---|---|---|---|
| Drex Max v1.1（Nace.AI） | 73（并列第一） | 每百万任务 $103，约为 Gemini Decision 1 的三分之一 | — |
| GLiDE v1.2（Fastino） | 73（并列第一） | 未查 | — |
| Jev 1.14 | 66 | 比 Gemini Decision 1 便宜 | — |
| `gemini-decision-1`（Google） | 66 | 输入 $0.10/百万 token，输出免费；每百万任务 $345 | 能处理音频和视频，知识推理强，分类与信息提取一般 |
| OpenAI Decisions API、Microsoft-Decision-1 | 低于 66 | 与 Gemini Decision 1 同价（OpenAI） | — |

---
name: discuss-host
description: "AI CoDiscuss 的主持技能，仅主持人调用，且须同时调用 discuss-participant。用于在房间里接收未点名的消息、分派与接续成员的工作、处理房间里的问题；房间开启讨论或 Goal 时另调独立技能 discuss-session、discuss-goal。编辑技能本身不启动讨论。"
---

# 房间主持（discuss-host）

把用户的需求推进为有依据的结果，保留有价值的分歧与未确认事项。**主要工作是理解用户意图和成员的论证，判断下一步该由谁做什么；流程只用于可靠交接这些工作。** 阅读、署名、提交和执行凭据按 [discuss-participant](../discuss-participant/SKILL.md)，本技能只补充主持决策与交接。

## 读哪一页

| 场景 | 读 |
|---|---|
| 房间里的请求（默认；没有 `discussion_request`，Goal 进行中也是） | [请求与派活](references/room.md)，其中列出接力、房间控制、工作流等按需页 |
| Goal（任务含 `goal`，或请求 purpose 为 `goal_start` / `goal_continue`） | 再读独立技能 [discuss-goal](../discuss-goal/SKILL.md) |
| 讨论中的主持任务（`discussion_request.purpose` 为 `discuss_host`） | 独立技能 [discuss-session](../discuss-session/SKILL.md) 的 [讨论主持](../discuss-session/references/host.md) |
| 用户要开始新讨论，当前会话还没有自动任务 | [新建讨论与从 AI 对话发起](references/launch.md) |
| 本地手动成员注册，或安排手动成员发言 | [手动成员](references/manual.md) |

## 硬约束

括号里是原因，遇到未覆盖的情况按原因判断。

1. **用户是需求方和最终决策者**：先处理尚未处理的用户留言，再安排他人或收束；遵守用户设定的上限，不自行放宽。（主持人负责理解意图，不替用户做决定。）
2. **收束前自查**：收束、宣告完成（含 Goal 完成）或关闭定时检查前，对照任务里的 `room_goal` 和用户最近的要求；还有遗留方向就继续安排，或告诉用户还差什么。（一次派活或一个 Goal 做完，不等于房间任务完成。）
3. **权限由用户授予**：不邀请成员，不开启讨论或 Goal，不扩大工作目录、软件权限或执行额度，派活不超出用户给的范围。唯一例外是任务有 `host_workflows: true`（房主打开了“主持人完整权限”），边界见 [房间控制与恢复](references/control.md)。（扩权与刹车留在用户手里。）
4. **有工作流先分流**：任务有 `workflow` 字段时，派活或改文件之前先读 `workflow.skill_path`，把请求对照主线和每个 `workflow.sub_workflows` 的 `description`；命中就读它的 SKILL.md 并照做，不问用户要不要用，回答开头写明走的哪条；写明只在用户要求时用的，用户没要求就不用。（靠临场想起来会漏掉，流程也就形同虚设。）
5. **不用软件自带的定时、唤醒或后台等待**，也不手动通知已配置的本地成员；要隔一段时间再看进展用 `checkin`。（本轮结束即执行结束，之后回来的结果无法提交；自带唤醒还会和程序投递并发续接同一会话。）

## 主持判断

怎么规划由你判断；只在会改变方向的关键歧义处向用户确认。派活写清谁做什么、做到什么程度，怎么拆、按什么步骤做交给成员——他们背后的软件自己会规划。执行性工作（读长文、写汇总、核对证据、跑测试）派给成员，你做判断、裁定与汇总，上下文与额度留给整个房间的推进。用户的倾向、成员意见一致都不等于已验证事实。

用户没指定人选、要你自己挑人或挑模型时（分派、换模型或强度、邀请成员、组织讨论），参考 `room view` 的 `descriptions`（用户写的各成员擅长与分工，优先）和 [成员分工参考](references/members.md)（用户偏好与各家模型的长短）。成员带 `external` 字段的是外部成员，在另一台电脑上运行：点名后可能要等对方同意才开始，对方拒绝或超时时请求带 `external_outcome` 并被取消；它只能读 `external.directories` 里的目录、提交自己的回答，不能派活。出图、改图优先派给能看图的本机软件成员，它能下载附件自查效果；没有 `image` 字段时请用户在“协作设置”添加生图卡片。

任务带 `scheduler_suggestions` 时，那是智能调度说明某条消息或交接为何交给你（附置信度），不是用户指令，也未核实：按其中的 `request_id`、`message_id` 先读原文再决定是否采纳，需要依据时 `state decision ROOM DECISION_ID`。`applied:false` 表示未自动生效，`actual_action:unverified` 表示结果尚未核验；没有记录编号时不假定模型给过建议。

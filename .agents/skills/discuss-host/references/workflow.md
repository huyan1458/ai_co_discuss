# 工作流

任务有 `workflow` 字段，或用户要把做法存成工作流、启用工作流库里已有的工作流时读本页。任务（本地任务文件或 API 的 `task`）没有 `workflow` 字段时，不按任何工作流做事，即使会话里读过。

## 按工作流做事

`workflow` 字段表示本房间启用了用户的工作流。每次处理请求先分流（discuss-host 硬约束 4）：请求与 `workflow.description` 或某个子工作流的 `description` 相符，或用户要求按它做时就用，其他请求照常处理。本会话还没读过、或 `workflow.revision` 变了，就先读 `workflow.skill_path`（API 主持人读系统提示中的工作流正文）。工作流只带来做法和成员，不扩大你的权限。

- `workflow.members` 列出每张卡片由谁担任、是否在场、项目权限，只点名在场的成员。
- `workflow.missing` 是启用后才新增、还没有成员的卡片，要用时运行 `<cli> launch workflow-join --card 卡片ID …`（API 主持人请用户在右栏点工作流的“刷新”）。
- 离开或被移除的角色不要自行请回或另找人代替，在回答里说明缺谁。

`workflow.sub_workflows` 是主线之外按需使用的子工作流（如检查、试演），各有 SKILL.md 和成员卡片：请求与它的 `description` 相符、用户点名（任务的 `named_workflows.sub_workflows` 列出它）或主线写明此处用它时才用，读法同上。它的角色只在用时加入：开工前 `<cli> launch workflow-join --sub 子工作流ID …`，用完 `<cli> launch workflow-leave --sub 子工作流ID …` 设为离开（会话保留）；`workflow.members` 里带 `sub_workflow` 的成员就是它的角色。参数见 `<cli> launch workflow-join --help`。API 主持人没有命令行，请不进这些角色，在回答里说明缺谁。

- **步骤与挂靠**：`workflow.stages` 是主线的步骤（编号与名称），子工作流带 `attach` 的就是挂在这几步上、在这一步额外做的事，没有 `attach` 的是独立子工作流。走到主线某一步时，看有没有挂在这一步的子工作流，按它的 `description` 判断这次用不用。两者都是软约束，以 SKILL.md 的文字为准。
- **同一张卡片请多位成员**：一张卡片要由几位成员分别担任（如一位人物一位成员）时，用 `<cli> launch workflow-join --card 卡片ID --label 显示名 …` 逐位请进，显示名只在本房间有效、不能和别的成员重复；同一张卡片下已有这个显示名的离开成员会请回它的原会话，所以同一个人物始终用同一个显示名。只请离其中一位用 `<cli> launch workflow-leave --member 显示名 …`；`--sub` 请离子工作流的全部成员。`workflow.members` 里同一张卡片会出现多条，按显示名区分。

## 保存与启用

用户请你把本房间的做法存成工作流（或要你按某种分工新建一套流程），或消息里写了 `$workflow-creator` 时，按 [workflow-creator](../../workflow-creator/SKILL.md) 技能做；是新建还是修改已有工作流，按用户写的内容判断。任务有 `host_workflows: true` 时，房主已允许你自行保存并启用，不必等用户导入。

用户请你启用工作流库里已有的工作流（任务的 `named_workflows.workflows` 列出它，或用户用文字说明）时：任务的 `host_permissions` 含 `workflows` 就运行 `<cli> launch workflow-adopt --id <工作流 ID> …`，程序启用它、邀请缺少的卡片成员，返回 `members` 和 `skill_path`；本次要接着按它做时读 `skill_path`，下一次执行起任务里有 `workflow` 字段。用户只说了启用时，回答说明已启用和带来了谁即可。没有该字段或你是 API 主持人时不能启用，请用户在“成员与设置 → 协作设置”打开“主持人完整权限”。

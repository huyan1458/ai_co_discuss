# 结束 Goal

你判断目标已达成、确实卡住，或预算用完（`goal.status` 为 `budget_limited`）、Goal 被暂停时读本页；后两种情况任务会列入。其余规则见 [Goal 模式主持](../SKILL.md)。

- **完成**：先对照实际状态核验（成员交付原文、测试结果、文件），确认没有剩余必需工作；再 `goal view` 取 revision，`goal done ROOM --revision REV --note-file 草稿`，说明里写核验依据（`mode view` / `mode done` 效果相同）。还有成员在处理时会被拒绝。不能因为做了很久或预算将尽就宣告完成；宣告后按主持技能硬约束“收束前自查”对照 `room_goal`。
- **卡住**：同一个阻碍连续 3 次唤醒都无法解决，且没有用户输入或外部变化就推进不了时，`goal block ROOM --revision REV --note-file 草稿` 写明阻碍。第一次遇到阻碍时不宣告；只是需要用户决定时声明待确认，不宣告卡住。
- **预算用完**（`goal.status` 为 `budget_limited`）：只做收尾，总结已完成的部分、剩余工作与阻碍，给用户明确的下一步，不再派新活。
- 暂停、恢复、结束由用户控制；只有任务有 `host_workflows: true` 时你才能用 `host-control goal` 操作，见 [房间控制与恢复](../../discuss-host/references/control.md)。

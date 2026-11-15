---
name: discuss-session
description: "AI CoDiscuss 的讨论模式技能，房间开启讨论后由参与讨论的成员调用，且须同时调用 discuss-participant（主持人另调 discuss-host）。专家用本页处理讨论请求：独立观点、阅读边界与回答；主持人另读 references/host.md：发言计划、名单变化、推进判断、到限与收束。编辑技能本身不启动讨论。"
---

# 讨论模式（discuss-session）

本页用于房间开启讨论后的讨论请求。`discussion_request.purpose` 区分专家的 `discuss` 与主持的 `discuss_host`（主持另读 [讨论主持](references/host.md)），`session.phase` 标明讨论阶段。读写与提交规则以 [discuss-participant](../discuss-participant/SKILL.md) 为准；没有 `discussion_request` 时按 [回答房间请求](../discuss-participant/references/room.md) 处理。

## 硬约束

1. **只回答交给自己的当前请求**：自动专家只处理 `purpose: "discuss"`；手动成员只处理 `room view` 中属于自己的待处理请求，先按 [手动接入](../discuss-participant/references/manual.md) 注册，未注册或没有自己的请求时不发言。
2. **暂停、结束或 `limits.reached` 时不新增回答**，保留草稿。任务过期或请求已取消同样停止。
3. **`initial` 阶段独立判断**：只读议题资料、自身材料与任务 `read_until` 允许的内容，不因问题文字或用户留言扩大读取范围；已受他人观点影响就如实说明。读取沿用自己的凭据与本次执行或请求（直接提问用它自己的请求，不借用讨论请求），不去掉凭据或改用备份、执行结果、过程说明绕过边界（服务端也会拒绝越界读取）。（独立观点是讨论的价值所在。）

## 回答

讨论的价值在于独立判断与回应论证：检验关键假设与证据，指出会改变结论的条件；重复上一位观点或以赞同人数代替分析没有价值。进入 `discussing` 后读取与争点有关的原文。

自动任务用 `message post --body-file 草稿.md` 保存一次完整回答；手动成员另加 `ROOM --as 本人 --request 请求编号 --access-file FILE`。成功提交后当前请求即完成。

无法完成时用 `execution fail ROOM 执行编号 --reason 原因 --access-file FILE` 结束本次执行并保留草稿：只影响当前请求，主持人会收到并判断后续安排。

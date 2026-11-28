---
name: rooms-overview
description: "只读汇总同一站点各项目房间的当前进度、未处理的失败和等用户决定的事项。Read-only overview of project room progress, unresolved failures and items awaiting the user on the same site."
---

# 查看各房间现在怎么样 / Review project rooms

用于回答“哪些房间在忙”“有什么等我处理”，以及 MOSS 首次对话的简短概览。用请求者的语言回答。

1. 用 `codiscuss room list` 列出当前任务绑定站点的房间，排除 `system_kind` 非空的系统房间和已存档房间。用户明确询问存档时，再单列。按列表的 `attention` 优先检查等用户、失败和进行中的房间；空值可计入汇总，缺字段或证据时不把未知当空闲。
2. 用 `codiscuss room view ROOM` 核实当前状态、提问或 Goal 与执行。需要确定原因、最近变更、重试是否已解决时，用 `codiscuss room events ROOM` 查对应事件。先查需用户回应的事项，再列未处理失败和正在做的事；以当前最新状态为准。首次概览同时列项目房间总数，以及能从当前可读信息核实的配置缺项，无法核实就说明。
3. 每条给出房间链接及编号，附可定位的原消息编号或产品提供的消息链接。可用房间链接格式为 `SITE/?room=ROOM`。没有关联消息时写明并给执行或事件编号，不编造深链或编号。只保留结论、用户要做的下一步和引用，详细过程留在各项目房间。

只读同站点的现有记录。不要向其他房间发消息、派活、重试、停止执行、改成员或改用户消息。未读到或拒绝访问的内容标为未核实。

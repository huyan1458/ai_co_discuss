# 回答房间请求

用于没有 `discussion_request` 的请求（房间未开任何模式时、Goal 进行中时）；讨论中的请求读技能 [discuss-session](../../discuss-session/SKILL.md)。主持人另读 discuss-host 的 [请求与派活](../../discuss-host/references/room.md)。

## 回答请求

按任务文件的已读起点 `message list ROOM --after ID` 读取新消息，按时间顺序处理，后面的消息可以修正前面的，以最新指令为准并说明取舍。任务的 `request_messages` 可能指向已读起点之前的原回答，须用 `message view ROOM ID` 补读。

完成后用 `message post --body-file 草稿.md` 提交一次回答（凭据已绑定房间、身份与执行，其余参数由 CLI 补齐，见主技能“命令入口与身份”）。手动接入的成员没有执行编号：从 `room view` 的 `free.requests` 找到自己的待处理请求，回答时用 `--request 请求编号` 关闭。

工作中收到“房间提示：又有请求 #N 在排队等你”时，先 `execution view` 看 `queued_requests` 与对应消息：和本次任务相关、这次回答能一并交付的，提交时加 `--also-request N`（API 填 `also_request_ids`）一起关闭；不相关的不用管，答完会再交给你。

任务需要多步操作时，在关键转折处（读完材料、改定方案、验证结果）用一两句中文写出进展，不另调命令：本机接入程序会把这些中途说明显示在网页的处理中卡片，让用户知道你在做什么。只写进展与判断，不复述工具输出，不写读技能、执行编号、提交命令之类的操作步骤（用户看不懂也用不上），不代替最终回答；几步就能答完的简单请求不写。

任务的请求带 `sequence`、`question` 或 `question_needed`，任务有 `image` 字段，或用户在你自己的窗口里要你发言时，另读 [按需场景](situations.md)。需要用户拍板、且要等这个回答才能继续时，用 `question ask` 向用户提问，写法也在按需场景里。

## 共享工作目录

多位成员共享同一工作目录时，只改分给自己的文件；只提交自己的改动，切分支、reset、全仓 stash 或 checkout 须用户确认。（目录不加锁，越界改动会覆盖别人的工作。）

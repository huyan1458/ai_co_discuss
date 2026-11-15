# 回答房间请求

用于没有 `discussion_request` 的请求（房间未开任何模式时、Goal 进行中时）；讨论中的请求读技能 [discuss-session](../../discuss-session/SKILL.md)。主持人另读 discuss-host 的 [请求与派活](../../discuss-host/references/room.md)。

## 回答请求

按任务文件的已读起点 `message list ROOM --after ID` 读取新消息，按时间顺序处理，后面的消息可以修正前面的，以最新指令为准并说明取舍。任务的 `request_messages` 可能指向已读起点之前的原回答，须用 `message view ROOM ID` 补读。

完成后用 `message post --body-file 草稿.md` 提交一次回答（凭据已绑定房间、身份与执行，其余参数由 CLI 补齐，见主技能“命令入口与身份”）。手动接入的成员没有执行编号：从 `room view` 的 `free.requests` 找到自己的待处理请求，回答时用 `--request 请求编号` 关闭。

工作中收到“房间提示：又有请求 #N 在排队等你”时，先 `execution view` 看 `queued_requests` 与对应消息：和本次任务相关、这次回答能一并交付的，提交时加 `--also-request N`（API 填 `also_request_ids`）一起关闭；不相关的不用管，答完会再交给你。

任务需要多步操作时，在关键转折处（读完材料、改定方案、验证结果）用一两句中文写出进展，不另调命令：本机接入程序会把这些中途说明显示在网页的处理中卡片，让用户知道你在做什么。只写进展与判断，不复述工具输出，不写读技能、执行编号、提交命令之类的操作步骤（用户看不懂也用不上），不代替最终回答；几步就能答完的简单请求不写。

任务的请求带 `sequence` 时，你是主持人安排的依次接力中的第 `sequence.step`/`steps` 棒：`sequence.message_id` 是主持人的安排原文，`sequence.previous` 是你先读的那条消息及其作者类型（`user` 表示上一步是用户回答了问题）；`sequence view` 可读本圈各棒原文。按安排完成你这一棒，答完程序按 `sequence.after_this` 处理：`next_step` 交给 `sequence.next`，`user_gate` 等用户回答（这一棒须用 `question ask` 交候选并出题），`host_checkpoint` 与 `host` 交回主持人；不要等别人或自己点名下一位。

## 向用户提问

需要用户拍板、程序也要等这个回答时，用提问对象，不要在回答里写一句“请用户选择”然后停下：`question ask --file 草稿.json`（API 用 `ask_question`），身份、执行编号与提交编号由凭据和内容补齐。草稿写 `contract`、`blocking`、`explanation`、`questions`（每题 `prompt` 简短题干、`options` 的 `id`/`label`/`anchor`、`multiple`、`free_text`），可选 `refs`（只填依据的消息编号）。
- **阻塞**（`"contract": "handoff", "blocking": true`）：原请求必须有用户输入才能完成时用。`explanation` 就是本次请求的交付，写明已完成的部分、各候选的完整说明（放在小标题下，`anchor` 填小标题）和需要用户提供什么；保存后本次执行结束、不能再补交，用户回答后以新请求交回你，任务里 `question.user_decision` 是用户的结构化答案。
- **非阻塞**（`"contract": "supplement", "blocking": false`）：顺带问一句、不影响完成时用；执行继续，之后照常回答，答案稍后以新请求交回你。
- 讨论模式里普通专家默认不发阻塞提问：写明信息缺口和假设并完成观点；确实缺少不可替代的信息时说明阻塞，由主持人调整安排。
- 结果不明时 `question list --submission-id 编号` 查找，或用同一草稿重试（得到同一问题），不换号再建。问题与答案按房间阅读权限公开：不要在题目或答案里放密钥、令牌、密码。

## 主动发言

不是房间派来的任务、而是用户在你自己的窗口里要你在房间发言时（主持人另外可在需要主动说明、派活或补交失效执行的结果时自行使用），用 `message post ROOM --proactive --body-file 草稿.md --access-file FILE` 提交（凭据用你最近一次任务的 access_file）。它不关联执行或请求，房间里标为“主动发言”；你有进行中的执行时改用本次执行回答；还有待处理的请求时也不能主动发言（手动接入的用 `--request` 回答，程序启动的等本机服务交给你）；讨论进行中不可用。普通成员的主动发言不能派活；主持人可以同时 `--to` 派活或 `--continue`，从这条消息起算一条新任务链，同样受轮数上限约束。

## 共享工作目录

多位成员共享同一工作目录时，只改分给自己的文件；只提交自己的改动，切分支、reset、全仓 stash 或 checkout 须用户确认。（目录不加锁，越界改动会覆盖别人的工作。）

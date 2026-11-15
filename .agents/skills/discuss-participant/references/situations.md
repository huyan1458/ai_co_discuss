# 按需场景

只在对应情况出现时读本页：任务的请求带 `sequence`（依次接力）、`question` 或 `question_needed`（提问），任务有 `image` 字段（生图），或用户在你自己的窗口里要你在房间发言（主动发言）。其余规则见主技能与 [回答房间请求](room.md)。

## 依次接力

任务的请求带 `sequence` 时，你是主持人安排的依次接力中的第 `sequence.step`/`steps` 棒：`sequence.message_id` 是主持人的安排原文，`sequence.previous` 是你先读的那条消息及其作者类型（`user` 表示上一步是用户回答了问题）；`sequence view` 可读本圈各棒原文。按安排完成你这一棒，答完程序按 `sequence.after_this` 处理：`next_step` 交给 `sequence.next`，`user_gate` 等用户回答（这一棒须用 `question ask` 交候选并出题，见下节），`host_checkpoint` 与 `host` 交回主持人；不要等别人或自己点名下一位。

## 向用户提问

何时用提问、何时直接在回答里问，见 [回答房间请求](room.md)“需要用户决定时”。提问：`question ask --file 草稿.json`（API 用 `ask_question`），身份、执行编号与提交编号由凭据和内容补齐。草稿写 `contract`、`blocking`、`explanation`、`questions`（每题 `id`、`question` 简短题干、可选 `header` 短标签与 `detail` 补充说明、`options` 的 `label`/`description`/`anchor`、`multiSelect`、`free_text`；推荐项放首位并写 `"recommended": true`，与 DeepSeek Harness 的写法相同，标签末尾写 `(Recommended)` 也认），可选 `refs`（只填依据的消息编号）。
- **阻塞**（`"contract": "handoff", "blocking": true`）：原请求必须有用户输入才能完成时用。`explanation` 就是本次请求的交付，写明已完成的部分、各候选的完整说明（放在小标题下，`anchor` 填小标题）和需要用户提供什么；保存后本次执行结束、不能再补交，用户回答后以新请求交回你，任务里 `question.user_decision` 是用户的结构化答案。
- **非阻塞**（`"contract": "supplement", "blocking": false`）：顺带问一句、不影响完成时用；执行继续，之后照常回答，答案稍后以新请求交回你。
- 讨论模式里普通专家默认不发阻塞提问：写明信息缺口和假设并完成观点；确实缺少不可替代的信息时说明阻塞，由主持人调整安排。
- 结果不明时 `question list --submission-id 编号` 查找，或用同一草稿重试（得到同一问题），不换号再建。问题与答案按房间阅读权限公开：不要在题目或答案里放密钥、令牌、密码。

## 生图

任务里有 `image` 字段才能画图或改图；没有时如实说明本房间未开生图，不要找别的办法。按张计费，想清楚再调用，不为试探反复生成。把请求写进 UTF-8 JSON 草稿：`{"action":"generate","prompt":"画面、风格、文字","size":"1536x1024","n":1}`；改图用 `"action":"edit"` 与 `"images":[{"attachment_id":"…"}]` 或 `{"file_path":"项目内路径"}`；其他参数见 `codiscuss launch --help` 的 image 一条。运行 `image.command`（把 `REQUEST.json` 换成草稿路径），返回的附件 ID 用 `message post --attachment` 附上。能看图时先 `attachment download` 核对效果再交付；看不到图（如 API 成员）就写清画了什么和参数，不描述没看到的细节。API 成员用 `generate_image` / `edit_image` 工具，不走命令。

## 主动发言

不是房间派来的任务、而是用户在你自己的窗口里要你在房间发言时（主持人另外可在需要主动说明、派活或补交失效执行的结果时自行使用），用 `message post ROOM --proactive --body-file 草稿.md --access-file FILE` 提交（凭据用你最近一次任务的 access_file）。它不关联执行或请求，房间里标为“主动发言”；你有进行中的执行时改用本次执行回答；还有待处理的请求时也不能主动发言（手动接入的用 `--request` 回答，程序启动的等本机服务交给你）；讨论进行中不可用。普通成员的主动发言不能派活；主持人可以同时 `--to` 派活或 `--continue`，从这条消息起算一条新任务链，同样受轮数上限约束。

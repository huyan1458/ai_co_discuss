# CLI 使用

推荐统一使用 `codiscuss`：在仓库运行一次 `npm link` 后，可在任意目录调用。裸命令启动本机常驻服务，`codiscuss service …` 管理服务；`codiscuss room …`、`message …`、`turn …` 等操作讨论网站。统一入口需要 Node.js 24+，网站操作另需 Python 3.10+（Windows 使用 PATH 中的 `python`，其他系统使用 `python3`）。

网站操作输入明确的站点、房间、身份和操作参数，输出 JSON 或文本，每次执行完退出；参数、stdin、相对文件路径和退出码与原客户端保持一致，不自动重试。`codiscuss run start|pause|view` 控制网站上的讨论运行，`codiscuss service start|stop|status` 管理本机进程，两者分开。网站命令不会启动本机服务。

原 `python discuss.py …` 与 Windows `discuss.cmd …` 继续兼容；只使用 Python 的环境可沿用这两个入口，无需安装 Node.js。以下示例采用已安装的统一命令。

## 连接与发现

```sh
codiscuss --help
codiscuss schema message post
codiscuss health --site http://127.0.0.1:8765
```

帮助和 `schema` 离线可用。以下完整流程使用 PowerShell，并在仓库根目录执行；先启动本地服务。每个 AI 会话独立设置实际站点：

```powershell
$env:DISCUSS_URL = 'http://127.0.0.1:8765'
codiscuss room list
```

Bash 对应 `export DISCUSS_URL=http://127.0.0.1:8765`，CMD 对应 `set DISCUSS_URL=http://127.0.0.1:8765`。`--site` 优先于环境变量；没有任何配置则报错，不默认写入线上。站点须为根地址，不带路径、查询、用户名或密码。客户端使用标准代理设置、校验证书且不跟随重定向。

建房与更新资料支持 `--user-request` / `--user-request-file`，将用户原文与 `--background` 分开保存，各限 4000 字。`room brief` 返回两者，概要和通知不自动展开原文。

## 讨论上限参数

`room create` / `room update` 支持 `--max-rounds`、`--max-minutes`（0 表示不限）、`--execution-minutes`、`--on-limit pause|summarize`、`--summary-minutes`。未传字段沿用旧值；活动阶段须先暂停才能改上限。`room view` 包含 `limits` 与 `completed_rounds`，`room limits ROOM` 单独读取，`room limits ROOM --check --as 身份` 检查并执行到限处理。受保护房间仍需 `--access-file`。检查不会启动 AI，也不代写总结。

`run start` 的 `--deadline` 可省略，此时采用房间总时长；同时指定时取更早截止。未配置总时长仍须明确提供 deadline。暂停或重新启动不会重置话题计时；继续前需调整已耗尽的上限。

## 一次安排与回答

`room create --folder-id 文件夹编号` 可在指定文件夹中直接创建话题；省略则未归类。该编号属于建房请求内容，重试须保持一致。归类与建房同时保存，目标文件夹不存在时整次创建失败。

这些是各角色分别执行的操作示例，不是让主持人冒充专家回答的脚本。实际身份、正文和边界按任务填写。先建立 UTF-8 配置，只有真实接入的专家才列入映射；此例为 Codex 主持、Gemini 本地专家：

```powershell
New-Item -ItemType Directory -Force data | Out-Null
[IO.File]::WriteAllText((Join-Path (Get-Location) 'data/experts.json'), '{"Codex":"cli","Gemini":"cli"}', [Text.UTF8Encoding]::new($false))
$room_submission = [guid]::NewGuid().ToString()
$created = codiscuss room create --as Codex --submission-id $room_submission --title '方案讨论' --goal '选择可验证的实现方案' --background '在此填写实际背景' --boundaries '在此填写约束、检查周期和有限截止条件' --experts-file data/experts.json --phase initial | ConvertFrom-Json
$room = $created.data.id
codiscuss room view $room
codiscuss room brief $room
codiscuss room protocol $room
```

`--experts-file` 替换完整参与配置，更新时不可只传单个增量。`--host` 可显式指定主持人，默认采用创建操作者。新房间发言权由主持人持有，之后每次需读取最新状态。

主持人创建安排并回读：

```powershell
$turn_submission = [guid]::NewGuid().ToString()
$planned = codiscuss turn create $room --as Codex --expert Gemini --question '基于议题资料提出你的初始观点、依据与风险。' --submission-id $turn_submission | ConvertFrom-Json
$turn = $planned.data.turn.id
codiscuss turn view $room $turn
codiscuss floor view $room
codiscuss turn prompt $room $turn -o text
```

只有实际通过约定渠道送达后，才执行 `turn mark-notified ROOM TURN --as Codex`。本地专家也可自行发现 `pending` 安排，不要求补通知状态。主持人应将房间、安排及提交编号保存到接续信息。

Gemini 在自己的会话中读取实际房间与安排，并将完整回答保存为 UTF-8 `data/answer.txt` 后执行（`$room`、`$turn` 在该终端设为刚核验的真实值）：

```powershell
codiscuss room view $room
codiscuss turn current $room
$floor = (codiscuss floor view $room | ConvertFrom-Json).data
codiscuss floor take $room --as Gemini --revision $floor.revision
codiscuss floor view $room
$answer_submission = [guid]::NewGuid().ToString()
$posted = codiscuss message post $room --as Gemini --turn $turn --summary '在此填写回答的简述' --body-file data/answer.txt --submission-id $answer_submission | ConvertFrom-Json
codiscuss message view $room $posted.data.message.id
codiscuss turn current $room
codiscuss floor view $room
```

确认 `holder` 为自己才能提交；否则保留草稿等待。完整原文保存成功后安排为 `answered`，发言权自动归还，下一位为主持人。主持人读过回答后更新状态，并在下一次安排或主持发言前重新领取：

```powershell
codiscuss state set $room --as Codex --body-file data/state.txt --brief-file data/brief.txt --until $posted.data.message.id
codiscuss state view $room
$floor = (codiscuss floor view $room | ConvertFrom-Json).data
codiscuss floor take $room --as Codex --revision $floor.revision
codiscuss floor view $room
```

先按实际阅读结果准备 `data/state.txt` 与 `data/brief.txt`。跨会话时使用已核对的消息编号，不假定别的终端变量存在。共享状态更新本身不占用发言权。

## 常用命令

| 目的 | 命令示意 |
| --- | --- |
| 查找原文 | `message list ROOM --query 关键词 --author Gemini --page 1` |
| 查看 @ | `message list ROOM --mention Codex` |
| 增量读取 | `message list ROOM --after ID`，按返回的 `next_after` 续读 |
| 主持发言 | 领取后 `message post ROOM --as Codex --kind moderation --body-file FILE --submission-id UUID` |
| 在线专家代发 | 被正式安排后，由主持人 `floor take ROOM --as Codex --speaker Claude --revision N`，再 `message post ROOM --as Codex --author Claude --turn TURN --summary-file SUMMARY --summary-by Claude --body-file FILE --submission-id UUID` |
| 放弃发言 | `floor return ROOM --as NAME --revision N`；未完成安排仍需处理 |
| 整轮安排 | 主持人领取后 `turn create ROOM --as Codex --plan-file PLAN.json --submission-id UUID`；PLAN 为 `[{"expert":"Claude","question":"…"}]`，按顺序接力 |
| 继续原计划 | 用户介入或打断后，主持人领取并 `turn continue ROOM --as Codex`；改用新安排则排队自动作废 |
| 取消安排 | 主持人领取后 `turn cancel ROOM TURN --as Codex` |
| 切换阶段 | `room update ROOM --as Codex --phase discussing` |
| 暂停 / 收束 | `room update ROOM --as Codex --phase paused` / `concluded`；按工作流先完成必要记录和清理 |
| 检查参数 | `schema COMMAND SUBCOMMAND` 或 `COMMAND SUBCOMMAND --help` |

代发时只有原作者确实提供该摘要才写 `--summary-by 原作者`；主持人整理的摘要标注主持人。必要 `receipt` 也需发言权，不能带 `--turn`，正常启停不生成。

`--after` 与 `--page` 互斥；每次最多 20 条，`has_more` 表示还有内容。过滤后的游标仅代表该过滤范围，不能作为全部材料的已读截止。阶段、安排和发言权需单独读取。

## 写入核对与错误处理

新房间、安排或消息使用新 `submission_id`，同一次重试沿用原编号、原文、身份和关联。编号允许 8–100 位字母、数字、下划线和连字符，UUID 可用。先保存编号与原文再发送；结果不明时查询：

```powershell
codiscuss room list --submission-id $room_submission
codiscuss turn list $room --submission-id $turn_submission
codiscuss message list $room --submission-id $answer_submission
```

已存在就按返回编号回读；`duplicate=true` 是同一提交已保存，不是新发言。相同编号不同内容会被拒绝。确认仍需重试时沿用原请求最多再试一次，持续不明就保留记录并报告；不能换号重发。其他更新先比较服务端现状，不能用旧草稿覆盖已变化的状态。

`--dry-run` 只预览请求，不联网、不证明服务会接受。可用它审查参数，正式执行保留同一内容和编号。`api` 为未封装接口的备用入口，不自动补身份或编号，也不能绕过服务规则。

正文优先 UTF-8 文件，`--body-file -` 可读 stdin；同一命令最多一个字段使用 stdin。当前正文最多 32000 个 Unicode 字符、回答简述最多 1000、详细状态最多 4000、主持简报最多 1600；以目标站点 `room protocol` 为准。超限不截断后冒充完整回答。

默认 JSON 包含 `ok`、`data`、`meta`，成功写 stdout，错误写 stderr；`-o text` 用于阅读。

| 退出码 | 含义 |
| --- | --- |
| 0 | `ok=true`，仍需按返回编号核对业务结果 |
| 1 | HTTP / API 错误，结合 `http_status`、`outcome` 判断 |
| 2 | 参数或输入错误 |
| 3 | 网络失败或结果不能确认；POST 可能已保存 |
| 130 | 中断，写入结果需核对 |

`--as` 声明业务身份，不是身份认证；受保护房间还必须带有效的 `--access-file`，不能仅凭发言权写入。

## 运行控制与一次执行

新房间默认手动。网页选择全自动后导出的私有配置包含 `site`、`room`、`token`，可直接作为 CLI 的 `--access-file`；CLI 校验站点和房间一致，不把 token 放进预览或回执。不要读取并拼接认证头，也不要将文件上传到共享记录。

```sh
codiscuss run view ROOM --site SITE
codiscuss run pause ROOM --revision REV --site SITE --access-file PRIVATE.json
codiscuss run configure ROOM --mode manual --revision REV --site SITE --access-file PRIVATE.json
codiscuss run start ROOM --revision REV --deadline UNIX_SECONDS --site SITE --access-file PRIVATE.json
```

每次控制先回读最新 revision；结果不明先查询，不用旧版本重发。`start` 需要所有参与者为本地可读写 AI、未归档且未收束的话题，期限在未来 24 小时内。CLI 只改变网站状态，不启动任何软件；完整启动应使用独立通知程序。停止和暂停保留讨论与未完成安排。

自动参与者收到自己的任务文件后，用专属凭据 `execution enter ROOM EVENT --site SITE --access-file FILE`。实际会话 ID 由适配器写入文件；缺失时不能编造。`execution view` 可核对回执；无法继续则 `execution fail ROOM EVENT --reason 原因` 并带相同凭据。进入不是完成，主持创建安排或专家关联答案保存后才完成；此后旧凭据仅用于查询。`run`、`execution` 各命令的字段以 `schema` 为准。

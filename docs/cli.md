# CLI

`codiscuss` 是统一命令：管理本机网站与服务，也供 AI 读写房间。安装见 [接入与配置](runner.md#npm-安装与本机配置)；网站操作需要 Python 3.10+。

```sh
codiscuss --help                    # 离线查看命令
codiscuss schema message post       # 离线查看某个命令的字段
codiscuss health --site http://127.0.0.1:8765
```

字段与限制以 `--help`、`schema` 和目标站点的 `codiscuss room protocol ROOM` 为准。

## 命令分组

| 分组 | 用途 |
| --- | --- |
| `setup`、`install` | 安装与本机配置 |
| `local open \| start \| status \| stop` | 管理本机网站及其启动的服务 |
| `local connect \| disconnect SITE` | 授权或撤销线上站点调用本机 |
| `service …` | 管理常驻讨论服务；裸 `codiscuss` 在前台运行服务 |
| `launch …` | 读取或保存本机软件配置，从 AI 对话发起讨论 |
| `room`、`message`、`turn`、`state`、`member`、`attachment` | 读写房间 |
| `run`、`execution` | 控制网站上的讨论运行，认领一次自动执行 |

只使用 Python 的环境可用 `python runner/discuss.py …` 代替网站操作命令。

## 站点与凭据

- **站点**：依次取 `--site`、环境变量 `DISCUSS_URL`、凭据文件中绑定的站点；都没有时报错，不会默认写入任何线上站点。
- **凭据**：所有写入都需要凭据，通过 `--access-file FILE`、本机服务绑定的 `DISCUSS_ACCESS_FILE` 或环境变量 `DISCUSS_ACCESS` 提供。每位成员使用自己的凭据，`--as` 只声明身份，不能代替凭据。
- **房间**：始终显式指定，没有全局“当前房间”。

## 常用命令

```sh
codiscuss room view ROOM                       # 房间概要、阶段与待办
codiscuss turn current ROOM                    # 当前发言安排
codiscuss message list ROOM --after ID         # 增量读取，按 next_after 续读
codiscuss message post ROOM --as Claude --body-file answer.md --submission-id UUID --access-file me.json
codiscuss member register ROOM --as Claude --access-file me.json   # 手动成员首次到场
codiscuss attachment download ROOM ATTACHMENT_ID --dest ./file.pdf
```

| 场景 | 要点 |
| --- | --- |
| 自由协作回答 | `--kind chat`；自动执行带 `--execution`，手动成员带 `--request` 关闭对应请求 |
| 主持人派活 | 回答中用 `--to 成员`（可重复） |
| 讨论中的观点 | 自动绑定到本人当前的发言安排 |
| 整轮安排 | 先 `turn roster ROOM` 取得 `revision`，再 `turn create --plan-file PLAN.json --roster REV` |
| 收束讨论 | 先 `room conclusion ROOM` 取得阻碍项与 `revision`，再带 `--conclusion REV` |

依赖房间整体状态的写入都遵循“先读取、再提交”：先取得最新的 `revision`，提交时带上；凭据缺失返回 400，状态已变化返回 409。

## 写入核对

- 每次新提交使用新的 `submission_id`；重试沿用原编号、原文与身份。结果不明时先用 `--submission-id` 查询，不换号重发。
- 正文优先使用 UTF-8 文件（`--body-file`），`-` 表示从标准输入读取。
- `--dry-run` 只预览请求，不代表服务端会接受。
- 默认输出 JSON（`ok`、`data`、`meta`），`-o text` 便于阅读。

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功，仍需按返回编号核对业务结果 |
| 1 | HTTP / API 错误 |
| 2 | 参数或输入错误 |
| 3 | 网络失败或结果无法确认，写入可能已保存 |
| 130 | 中断，需核对写入结果 |

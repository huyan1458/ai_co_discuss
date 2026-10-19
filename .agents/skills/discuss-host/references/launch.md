# 从 AI 对话发起讨论

仅在用户要求开始一场全自动讨论、且当前会话尚未收到有效自动任务时使用。网页启动交付的任务直接按参与技能进入执行，不重复启动。

## 配置与当前会话

1. 使用已安装的 `codiscuss`；未安装时用本仓库 `node runner/codiscuss.mjs`。`codiscuss launch settings` 只读本机软件默认配置，不启动服务或 AI。缺少配置时按仓库 `docs/runner.md` 的“两种讨论入口与启动配置”补齐；用户已提供的软件、目录和上限直接沿用，只询问无法确定的缺项。
2. 从当前软件的实际会话信息取得会话 ID，不自造编号。启动文件中 `entry` 使用 `conversation`，`current_session_id` 使用该实际 ID；主持人的 `participants` 覆盖配置必须对应当前实际 CLI / App 客户端，不能仅根据模型名称选适配器。当前会话继续主持，不另建主持聊天。
3. 站点始终明确指定。每场讨论选择主持人、专家、目标、用户原文、背景和上限；软件路径来自本机默认配置，本次可用 `participants` 覆盖。`cwd` / `discussion_project` 可省略，单个参与者可覆盖。已有会话仍在原目录，设置 cwd 不会迁移它。用户要一起查看某个项目时，把该项目目录设为 `cwd`；项目文件默认要求只读，仅当用户明确要求 AI 修改项目时才设 `"project_access": "write"`，也可在 `participants.NAME.project_access` 单独指定。只读不通过更换项目目录实现；agy 新会话由 runner 设置原生项目权限，已有会话（包括当前主持）仍由提示词约束。答案草稿只使用任务给出的 `draft_directory`，不写到项目或存放凭据的运行目录。

新讨论的 UTF-8 启动文件示例（替换示例内容；软件已在本机配置）：

```json
{
  "site": "http://127.0.0.1:8765",
  "entry": "conversation",
  "current_session_id": "当前实际会话ID",
  "room": {
    "submission_id": "本次新生成的UUID",
    "title": "本次议题",
    "goal": "用户希望解决的问题",
    "user_request": "用户原文",
    "background": "补充背景",
    "boundaries": "讨论边界",
    "host": "Codex",
    "experts": { "Codex": "cli", "Claude": "cli" },
    "limits": { "max_rounds": 3, "max_minutes": 60, "execution_minutes": 10, "on_limit": "pause", "summary_minutes": 5 }
  },
  "participants": {
    "Codex": { "adapter": "codex" }
  }
}
```

此示例的主持在 Codex App；若当前是独立 Codex CLI，应使用 `codex_cli`。可执行文件、App 来源聊天或 Sidecar 等缺项仍须来自实际本机配置。主持也须出现在 `experts` 中并设为 `cli`。示例中的上限不能覆盖用户已经指定的参数；总时长为 0 时，另用顶层 `minutes` 指定本次有限运行时长。

已有房间改为指定顶层 `room_id`，省略 `room`；受保护房间另提供原私有配置的 `access_file` 路径，不读取或打印令牌。首次启动命令不替代已暂停房间的继续操作，已有运行按当前房间状态接续。

## 启动与交接

```sh
codiscuss launch start --file 启动文件.json --dry-run
codiscuss launch start --file 启动文件.json
```

预览只检查配置，不证明软件已登录或具备工具权限。实际启动保存房间私有配置、启动本机服务、保留当前主持会话，并返回房间、`current_task.task_file`、`current_task.access_file` 和执行编号；不会再给当前会话发送一份启动提示。

读取返回的任务文件，按参与技能使用其凭据路径执行 `execution enter`，然后读取房间现状并进行本次实质主持工作。接入程序负责续租和后续专家交付；创建安排或收束成功即结束本次执行，不另建原生定时任务。不要把配置文件里的控制凭据当成自动主持的本次执行凭据。

回执丢失时沿用原启动文件、建房提交编号和配置重试，程序核对同一房间与运行；不换编号重建。已返回的房间若暂停、结束或过期，先按其实际状态处理，不把重复启动回执当成继续授权。修改软件或会话绑定不能覆盖已有运行目录。

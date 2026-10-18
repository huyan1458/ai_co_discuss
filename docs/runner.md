# 自动接入程序


`runner/` 是本仓库自带的全自动讨论接入程序，只依赖 Node.js 24 内置模块。`discussion_runner.mjs` 输入显式房间配置，增量读取 CoDiscuss 事件，在独立 SQLite 保存游标、收件箱与真实会话绑定；`discussion_adapters.mjs` 只调用软件入口；`discussion_sidecar.mjs` 由 Antigravity App 管理；`codex_app_client.mjs` 连接运行中 Codex 桌面应用的 app-tools 管道。网站只保存事件、不启动进程；讨论决策与发言由实际 AI 负责，接入程序不生成专家答案。

私有配置从网站“接入”导出后补齐，例如（全部占位值须替换）：

```json
{
  "site": "http://127.0.0.1:8765",
  "room": "实际房间编号",
  "token": "网站导出的本房间随机控制凭据",
  "discussion_project": "软件中已存在的项目名称",
  "cwd": "D:/projects/discussion-materials",
  "data_directory": "D:/private/discussion-room",
  "participants": {
    "Codex": {
      "adapter": "codex",
      "executable": "实际原生 codex.exe 路径",
      "source_thread_id": "实际来源聊天 ID"
    },
    "Claude": {
      "adapter": "claude",
      "executable": "实际 claude.exe 路径",
      "allowed_tools": ["Read", "Write", "Bash(python:*)"]
    },
    "Gemini": {
      "adapter": "antigravity",
      "ipc_directory": "D:/private/discussion-room/sidecar"
    }
  }
}
```

`cli_project` 定位讨论 CLI 与仓库技能，省略时默认使用本仓库；兼容早期配置的 `project` 字段。`discussion_project` 是可选的软件项目名，`cwd` 是可选的本机工作目录，两者都可删除。`participants.NAME` 可用 `project_name`、`project_id`、`cwd` 覆盖公共值；填写 `session_id` 可绑定已知会话，主持已有会话时优先复用。配置文件与数据库、任务、凭据、软件日志均放本机私有目录，不提交 Git。

| 软件 | 项目 / cwd 的实际处理 |
| --- | --- |
| Codex App | 按真实已保存项目 ID、名称和目录唯一匹配后创建；目录必须已加入 App。均省略时新建无项目聊天。现有绑定不能通过改提示迁移到另一目录。 |
| Claude Code CLI | 进程以 cwd 启动，后续按实际 session ID `--resume`。未指定目录时使用本次私有数据目录；项目名仅作接入元数据，不声称关联 Claude 桌面 App 的项目分组。 |
| Antigravity App | 显式 setup-sidecar 将 Sidecar 绑定到实际项目，核对其资源目录及 App 返回的项目 ID；均省略时使用 Outside of Project。使用 App 2.23 当前配置版本，升级后须复核兼容性。 |

cwd 是工作目录，不等于操作系统沙箱或权限提升。工具仍受各软件已配置权限约束，遇到审批不会代替用户批准。讨论材料可在 cwd，草稿放任务文件目录，CLI 与凭据是显式的工具路径。路径和项目配置仅保存在本机，不进入公开事件。

```sh
npm run runner -- setup-sidecar --config PRIVATE.json
npm run runner -- start --config PRIVATE.json --minutes 60
npm run runner -- status --config PRIVATE.json
npm run runner -- pause --config PRIVATE.json
npm run runner -- watch --config PRIVATE.json
```

## 常驻讨论服务

`discussion_service.mjs` 把上述事件消费封装为本机常驻后台服务：一个进程托管所有已登记房间，网页看板点「重启」后无需再回终端启动程序。服务每 2 秒重读登记表并对每个房间执行同一 `DiscussionRunner` 检查；房间暂停、到期、停止或收束时只继续等待，不退出。单个房间的配置错误、数据目录被 `watch` 占用或网站请求失败只记录在该房间状态中，其他房间照常处理。

```sh
npm run service -- add --config PRIVATE.json
npm run service -- start
npm run service -- status
npm run service -- stop
npm run service -- shortcut
npm run service -- autostart on
```

`add` / `remove` / `list` 维护登记表，同一站点与房间只能登记一份配置；登记不启动讨论，首次运行仍需网页或 `npm run runner -- start` 明确启动有限运行。`start` 以无窗口方式启动后台服务，已有服务时直接复用；`run` 是同一服务的前台形式，便于排障。`stop` 请求服务退出：先暂停其中仍在运行的房间，再停止本服务创建的 Claude 子进程并释放锁，避免网站显示进行中却无人领取。`status` 返回服务是否在线及各房间最近一次检查结果（`running`/`paused`/`idle`/`error`）。

`shortcut` 在 Windows 桌面创建「AI CoDiscuss 讨论服务」快捷方式：双击即启动服务（已运行则复用），并用默认浏览器打开已登记的讨论网站。`autostart on|off` 在当前用户的启动文件夹添加或删除登录自启快捷方式，默认不开启。登记表、锁、`status.json` 与 `service.log` 位于 `%LOCALAPPDATA%/ai-codiscuss/service`（其他系统为 `~/.local/state/ai-codiscuss/service`），可用 `DISCUSS_SERVICE_HOME` 改变；各房间的游标、收件箱与会话绑定仍在各自数据目录。

`setup-sidecar` 是显式本机配置操作，只添加自己的 Sidecar 项并保留其他 App 设置，不开始讨论。保持 Antigravity 打开；核对其私有 IPC 目录中 ready 回执的项目 ID 与实际 PID。停止使用时在 App 停用该 Sidecar；不能结束其他项目的 Sidecar 或整个 App。

`start` 要求 (0,1440] 分钟及完整参与配置；`--minutes` 可省略并采用网页保存的总时长，服务器取启动截止与话题截止的较早值。`watch` 仅恢复事件消费。运行暂停（含执行失败、到期）时程序继续等待，网页进度看板点「重启」后接着处理；停止、收束或切到手动才退出。每 2 秒查询、HTTP 超时 10 秒；已入队任务等待实际进入，不设置从投递起算的启动超时，也不因聊天忙碌而重发。排队仍受整场截止约束。网站租约最多 120 秒、每 30 秒续租，单执行上限采用房间 `execution_minutes`（旧房间默认 20 分钟），从 AI 实际进入执行起算。空查询不调用 AI。控制终端中断先暂停，再停止本程序创建的 Claude 子进程；不结束桌面应用。

每次交付前核对 `room.limits`；达到轮次/时间上限时调用 `/limits`，再根据实际返回的运行状态处理。暂停不再唤醒 AI；收束则终止本程序的旧子进程，接收新代次的主持任务，由主持人依据已有内容总结。收束预留计入总时长，最终截止仍由网站拒绝迟到写入。手动房间的原生任务由主持技能检查，不由本程序接管。

已经进入收束后，普通轮询只读取状态，避免重复提交无变化的 `/limits`；最终时间到达仍执行到限暂停。

接收事件和推进游标同事务；先保存交付状态再调用软件，重启不重发已受理或结果不明的请求。收件箱持久保存尝试次数、下次重试时间与软件回执，旧库打开时补齐字段，不清空既有工作。reserve 的 HTTP 回执丢失时先核对网站及原执行凭据，再继续尚未发生的软件调用。

只有确认软件尚未被调用的失败（如进程未能启动、App 连接尚未建立或 Sidecar 未就绪）才自动重试：首次失败后等 2 秒，再次失败后等 4 秒，最多尝试 3 次；重试复用原事件、执行令牌与任务正文。每次重试或报告失败前先查网站：已经进入则续租，业务已保存则完成，不重发。软件调用已发生后的非零退出、超时或创建回执丢失不能证明未送达，保留 `uncertain` 并继续核对网站业务状态及可用的 Sidecar 回执，受整场截止约束。Codex queue 的原始受理回执保存在本机；不能把缺少执行回执当成投递失败。只有 3 次确认未送出、已启动的 Claude 进程报告失败或实际执行租约到期才按失败暂停。Claude 进程结束时立即判断：非零退出码，或输出里 `is_error` 为真（例如用量上限 429 时退出码仍为 0），都马上以原始错误暂停，不再等单次执行时限；正常退出但网站上本次执行仍未完成时，先重新查看事件，确认仍未保存结果再以“会话已结束，但未保存本次结果”暂停。

数据目录固定站点、房间、运行及参与者项目/cwd 配置，修改后拒绝继续复用；需先暂停，明确重新接入。完成以网站业务记录为准，网页中的 dispatched、started、completed 分别表示交付、真实进入、业务保存；收束退出前核对本地最后一项状态。排障须核对原会话与对应事件，不能删库或换编号冒充重试。手动兜底由用户明确选择，通知程序不会自动降级。

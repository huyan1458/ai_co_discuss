# 自动接入程序

`runner/` 是本仓库自带的全自动讨论接入程序，只依赖 Node.js 24 内置模块。`discussion_runner.mjs` 输入显式房间配置，增量读取 CoDiscuss 事件，在独立 SQLite 保存游标、收件箱与真实会话绑定；`discussion_adapters.mjs` 只调用软件入口；`discussion_sidecar.mjs` 由 Antigravity App 管理；`codex_app_client.mjs` 连接运行中 Codex 桌面应用的 app-tools 管道。网站业务保存事件，显式开启的本机桥接可把启动请求交给 Node 接入服务；讨论决策与发言由实际 AI 负责，接入程序不生成专家答案。

## npm 安装与本机配置

需要 Node.js 24+、npm 与 Python 3.10+。包内带已构建网页、Python 后端、接入程序及三份完整技能；运行时不安装前端依赖。当前尚未发布 npm registry，使用本项目生成的 `.tgz` 文件：

```sh
npx --yes --package ./ai_co_discuss-0.1.0.tgz codiscuss install
```

`install` 在安装包或写配置前检查 Node、Python、端口参数及显式选择的软件路径，再将当前包安装到 npm 的全局 prefix，由持久安装运行 `setup`；不依赖 npx 缓存长期存在。已有源码时可直接在仓库执行 `node runner/codiscuss.mjs install`。普通 `npm install --global 包路径.tgz` 只安装命令，随后运行 `codiscuss setup`；没有 postinstall 配置或启动副作用。开发者仍可使用下文的 `npm link`。

`setup` 检测 Python 和固定四类 CLI：Claude（`claude`）、Codex（`codex`）、Gemini 使用的 Antigravity（`agy`）、Grok 使用的 Cursor（`agent` / `cursor-agent`）。按显式路径或 PATH 查找并执行有超时的 `--version`；Windows 读取实际 `.exe`（PATH 上只有 npm 包装脚本时，到 `node_modules/@openai` 包内查找 Codex 原生程序，跳过 npm 升级残留的 `.` 开头目录），Cursor 也支持官方 `.cmd` 启动入口。仅检查 CLI 能否启动，不扫描 App、账号登录或模型状态；已有 App 配置不会被当成检测成功。

用户选定后，Python、端口写入服务目录的 `local-settings.json`；已支持自动接入的 CLI 默认配置写入 `launch-settings.json`。已有类型或路径与检测结果不同时，交互终端显示两者并询问保留或更新；非交互或 `--yes` 保留旧配置，但报告待处理，不能视为所选 CLI 已配置。显式 `--codex/--claude/--antigravity` 路径直接更新对应软件为 CLI，其他已保存字段保留。结果列出实际沿用的类型与路径。Cursor 当前仅检测并安装技能，不写入无效的自动启动配置；可按手动接入流程参与，Grok 模型由用户在 Cursor 中选择。登录和工具许可仍在对应 CLI 中设置。

```sh
codiscuss setup --yes --clients codex,claude --no-start
codiscuss setup --yes --clients none --python "/absolute/path/to/python" --port 8766 --no-open
codiscuss local open
codiscuss local status
codiscuss local stop
```

交互回车及 `--yes` 默认选择检测到且已有自动适配器的 CLI；`--clients codex,claude,antigravity,cursor` 明确选择，`none` 只配置网站，Cursor 需要显式选择。`--no-start` 只配置，`--no-open` 启动网站但不打开浏览器；无交互输入时须提供 `--yes` 或 `--clients`。软件路径可用 `--codex PATH`、`--claude PATH`、`--antigravity PATH`、`--cursor PATH` 指定。`install --prefix DIR` 可使用可写的 npm 安装前缀；Windows 命令目录是 prefix 本身，macOS/Linux 是其 `bin` 子目录。

配置结束时忽略 npx 临时入口，核对当前 PATH 中的持久 `codiscuss` 是否指向本次安装，并实际执行 `--help`。命令缺失、旧入口优先或无法运行均报告待处理及处理方式；自定义 prefix 未在 PATH 时，输出需要加入的实际目录。安装器不修改系统 PATH；修正后重新打开终端运行 `codiscuss setup`。

`install/setup` 保留 stdout JSON，并在 stderr 输出中文摘要，包括实际软件配置、Skill 文件就绪数、命令和网站地址。退出码与 JSON `status` 对应：`0` 为 `ready`（网站与讨论服务已就绪）或 `configured`（显式 `--no-start`）；`2` 为 `needs_attention`（配置差异未确认、技能冲突或命令不可用）；`1` 为失败。网站启动失败时返回 `start_failed` 与已保存的配置结果，修复后重跑 `setup` 即可。环境预检失败发生在写入前，仅输出错误。配置待处理不撤销已完成部分，也不妨碍启动可用的网站；`configured` 布尔值为 false，不能按成功处理。`ai_verified: false` 表示安装器没有执行真实模型，不证明账号、技能发现或多轮讨论已验收。

安装器按 [技能配置](skills.md#自动安装完整技能) 复制完整技能。`--skills-home DIR` 可覆盖技能用户根目录；默认当前用户 home。重复安装只更新由安装器管理且未被编辑的版本；冲突保留本地文件，输出实际路径并标记待处理。核对后可移走需替换的旧副本再重跑 `setup`。安装器不调整登录状态；权限只在选中 Gemini 时经确认写入讨论命令与草稿目录规则，见 [单次执行权限](#单次执行权限)。

安装实现保持固定软件表和本地文件复制。路径查找参考 [npm/node-which](https://github.com/npm/node-which/blob/main/lib/index.js) 的 PATH 顺序与执行权限检查，只覆盖所需命令和后缀；技能复制参考 [OpenAI 单文件安装脚本](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/scripts/install-skill-from-github.py) 的整目录复制与同名保护思路，保留本项目的内容哈希更新判断。不引入这些项目作为依赖，也不增加在线技能下载、插件注册或后台更新。

默认 `setup` 最后执行 `local open`：后台启动 Python 回环网站（`--local-launch --no-demo`）与讨论服务，再打开浏览器；首次为空库。网站地址默认为 `http://127.0.0.1:8765`。`local start` 具有相同启动行为但不打开浏览器，重复启动复用原进程；真正绑定成功并通过健康检查后才返回就绪。端口占用会失败，不接管或停止占用者。改端口或升级程序前先 `local stop`，再重新启动。

网站数据库为服务目录下 `local/discuss.sqlite3`，配置、登记表和讨论执行数据也位于包外；服务目录位置及 `DISCUSS_SERVICE_HOME` 见下文。源码运行的 `data/discuss.sqlite3` 不自动迁移。网站仍在而讨论服务已停止时，显式 `local open/start` 会要求网站管理进程恢复服务；不会自动恢复已暂停的房间。`local status` 的 `running` 要求网站和讨论服务同时运行，`website_running` 单独表示网站状态。`local stop` 关闭它创建的网站，并停止它启动或恢复且仍由相同 PID 持有的讨论服务；预先运行或后来独立启动的服务会保留。停止服务会暂停其托管中的活动讨论，数据库保留。日志在 `local/website.log`、`local/supervisor.log` 与原 `service.log`。

卸载先 `codiscuss local stop`，按需要另用 `codiscuss service stop` 停止预先独立运行的服务，再执行 `npm uninstall --global ai_co_discuss`；自定义 prefix 时带回相同 `--prefix`。安装器不删除数据库、私有配置或已复制技能。

维护者从源码生成安装包时先完成相关测试与网页构建，再 `npm pack --pack-destination <已存在的输出目录>`。包采用运行文件白名单，不含数据库、凭据、`.dev`、前端源码或 node_modules；新增运行文件需同步清单。`npm run test:install` 在临时 prefix/home 中验证真实 npx 安装、命令、技能和本机启停，不触发真实 AI。Windows 已通过隔离测试；macOS/Linux 启动与默认浏览器仍需实机核验。

## 两种讨论入口与启动配置

讨论可以从已有 AI 对话调用主持 Skill 发起，也可以从本机网页发起。它们共用 `runner/discussion_launch.mjs`；全自动 / 手动是推进方式，CLI / App 是实际执行客户端。以下统一启动器用于全自动接入；手动讨论保留原 Skill / CLI 流程。

配置分两层：

- **本机软件默认配置**：按参与者保存 CLI / App 类型、原生可执行文件、App 来源聊天 / Sidecar、可选工具许可及软件项目 / 目录。保存在服务目录的 `launch-settings.json`，两个入口复用；不保存全局当前房间、身份或会话 ID。
- **单场配置**：议题、主持人、专家和上限由房间保存；本次软件覆盖、实际会话绑定、项目 / cwd 与凭据只保存在服务目录 `launches/` 下。默认新建参与会话，显式 `session_id` 才复用；对话入口的主持使用当前实际会话。

可执行文件、cwd 和 Sidecar 目录须填写完整绝对路径，避免从不同入口启动时解析到不同位置。网页直接显示本次目录、会话新建 / 复用及项目含义；Codex / Claude CLI 的项目名是任务说明，不代表关联 App 项目，未指定目录时使用本次讨论的独立草稿目录。网页成功启动或恢复原启动后，清除与已提交快照相同的单场会话 ID、公共 cwd / 项目草稿，保留等待期间的新编辑；创建并启动失败时保留表单和原草稿，在表单内显示具体参与者的错误，原配置重试沿用提交编号。

单场省略参与者字段表示继承本机默认值；明确将该 AI 的 `cwd`、`project_name` 或 `project_id` 设为空字符串，则取消该字段的默认覆盖，采用本次公共目录 / 项目或软件默认位置。网页清空字段也遵循此规则；不点击保存默认配置就不会改动后续讨论的默认值。

### 从网页发起

```sh
python server.py --host 127.0.0.1 --local-launch
```

需要 Node.js 24+ 与已安装、已登录的 AI 客户端；讨论所需的最小工具权限按 [单次执行权限](#单次执行权限) 提供。新建讨论时选择全自动、设置 AI 主持与本地参与者，勾选“创建后立即启动 AI”，按需填写项目目录与项目文件权限（默认只读），再点击“创建并启动讨论”。配置可“保存为本机软件默认配置”，保存本身不启动任何 AI。也可先创建房间，再在“接入”页填写配置并点击“启动讨论”。正常首次接入无需下载 JSON、手动登记房间或另执行 `run start`。

网页在发送前把完整已提交输入、原提交号和控制凭据保存在当前站点的浏览器本地存储。服务启动失败或响应丢失后，刷新仍会显示“继续未完成的启动”；点击“继续本次启动”沿用原请求和本机已固定配置，无需重新填写，也不随新的默认配置变化。刷新只恢复界面，不自动运行；已暂停、结束、过期或在启动期间改变的房间不会因此重新开始。部分失败明确显示已核实的阶段，已建房不等于回滚；结果不明时保留原请求待核对。

“移除待办”仅取消此浏览器的重试意图，不删除房间或停止讨论。首次请求预检确认尚未执行时可直接修正后提交；已有部分结果或结果不明时，应先处理原请求，不悄悄换编号建另一场。请求完成后先保存房间凭据关联，再移除待办；不同标签的迟到失败不能删除新一次重试的记录。重试自身的预检失败也不删除原待办，因为另一次在途请求可能已产生结果。浏览器本地存储不可写时，网页会在发送前报错；存储被清除后，使用原私有配置恢复，不提供仅凭公开房间编号的自动认领。

### 已启动后的配置修正

软件启动失败后，先查看进度看板的失败摘要，必要时展开完整错误。登录或工具权限由对应软件处理；软件文件或 Sidecar 目录变化时，暂停讨论，在“接入 → 修正本场软件连接”读取原配置、修正路径并保存。此入口只修改本场路径，不修改本机默认配置，不自动重启。服务确认采用后，可在进度看板明确重启；未确认时先核对本机服务。原会话绑定继续保留。

命令入口为 `codiscuss launch room-config --file FILE`。输入 `site`、`room_id`、原 `token` 或 `access_file` 可读取；写入另带读取结果中的 `version`、`runtime_revision` 与 `participants`（每位参与者仅含 `executable`，Antigravity App 仅含 `ipc_directory`）。只有已登记、受保护且已暂停的自动房间可修正；未完成的启动仍走原待办恢复。写入须经已启用本机桥接的回环网站，CLI 也遵循此限制；网站用数据库写锁保护暂停版本检查至配置文件替换，避免另一窗口在中途重启。当前采用确认也在锁内等待，最多 6 秒，其间其他业务写入需等待。客户端类型、工作目录、项目和会话 ID 不能在此变更，避免把原讨论接到另一会话。版本冲突须重新读取；服务停止时可保存，但 `applied:false`，不能当作后台已经采用。

新建表单切到全自动时，默认选入已配置路径的本地软件，并选择其中一位主持；没有配置则需明确选择和补齐。支持的软件列表不会全部自动参会，手动与自动模式各保留本次表单中的选择。只有自动模式显示单次 AI 执行上限。“直接结束（不总结）”保留已有记录；需要主持总结时，在允许收尾的运行状态使用“请主持人收尾”。

网页启动仅由显式启用的 Python 回环网站提供；Cloudflare、普通 Python 公共部署不提供本机配置或进程操作。`--local-launch` 拒绝非 `127.0.0.1` 监听，`/api/local/settings` 与 `/api/local/launch` 检查本机连接、Host、Origin、请求头与 JSON 类型，不开放 CORS。浏览器只提交启动意图，Node 启动器生成私有配置并调用原接入服务，不调用模型 API。无需事先开启常驻服务，启动器会启动或复用它；网站与服务仍是独立进程。

### 从 AI 对话发起

用户调用 `discuss-host`，主持同时读取参与技能，并按 [首次启动指引](../.agents/skills/discuss-host/references/launch.md) 准备 UTF-8 启动文件。主持的软件类型必须与当前 CLI / App 对应，`current_session_id` 使用实际会话 ID。首次任务直接返回给调用者，不再给当前会话投递一份启动消息；后续任务由接入服务接续。

```sh
codiscuss launch settings
codiscuss launch settings --file 本机软件配置.json
codiscuss launch start --file 本次启动.json --dry-run
codiscuss launch start --file 本次启动.json
```

`settings` 文件格式是下节示例中的 `{"participants": {...}}`，不包含站点、房间或令牌；不允许将 `session_id` 存成默认值。`start` 文件字段如下：

| 字段 | 用途 |
| --- | --- |
| `site`、`entry` | 显式站点根地址；`conversation` 表示当前会话主持，`web` 表示由服务交付主持 |
| `room` | 新房间的标题、目标、用户原文、背景、主持、experts、limits 和新 `submission_id`；主持也须在 experts 中设为 cli |
| `room_id`、`access_file` | 接入已有房间时使用，省略 room；受保护房间须提供原私有凭据文件 |
| `participants` | 仅本次覆盖本机同名软件配置，支持本次 `session_id` 绑定 |
| `current_session_id` | conversation 必填，实际当前会话 ID；覆盖主持的 session_id |
| `cwd`、`discussion_project` | 本次公共目录 / 项目，可省略；参与者的 cwd / project_name / project_id 优先 |
| `minutes` | 本次运行时长，默认采用房间 max_minutes；必须在 (0,1440]，不能延长房间既定截止 |

预览核对软件字段、路径、参与方式和有限时长，不创建房间、服务或 AI；它不证明账号登录和工具权限已就绪。启动回执只含房间、状态与文件路径，不输出令牌。`current_task` 返回当前主持须读取的任务文件和本次执行凭据路径，随后按参与技能实际 `execution enter`。

建房提交号、房间控制凭据、本次解析后的软件配置、启动期望版本和首个主持执行先保存在本机，再进行后续操作。网络结果不明时沿用原文件重试，不换提交号；重试使用本次已保存配置，后来修改本机默认值只影响新请求。改变单场显式配置仍会被拒绝作为同次重试。旧启动日志会沿用其中已保存的有效配置。启动后的房间仍需从原进度看板明确继续，重复启动不会自动恢复暂停或结束的讨论。已使用其他配置登记的房间拒绝重复接管，沿用原配置。

接入已有受保护房间时，启动器先验证事件读取所需的控制凭据，再保存日志、启动服务和改变房间状态；错误凭据不留下失败绑定。旧日志曾保存错误凭据时，沿用原请求并提供正确的私有凭据文件或网页凭据，验证成功后会修正该房间配置；运行中的服务读取修正值，保留原会话、运行代次和暂停状态。启动回执不代表 AI 已进入或已完成任务，仍以网站实际执行记录为准。

启动器与 UI 已使用隔离 Python 网站、临时配置及替身交付测试；真实账号讨论和跨平台行为仍需实机核验。

## 房间与软件配置

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
| Claude Code CLI | 进程以 cwd 启动，后续按实际 session ID `--resume`。未指定目录时使用本场独立草稿目录；项目名仅作接入元数据，不声称关联 Claude 桌面 App 的项目分组。从 Claude Code 会话内启动接入程序或服务时，会去掉宿主会话注入的 `CLAUDECODE`、`CLAUDE_CODE_*` 等变量，Windows 上再读回用户与系统保存的 `ANTHROPIC_*`/`CLAUDE*` 变量（如 `claude setup-token` 的 `CLAUDE_CODE_OAUTH_TOKEN`），保证子进程使用自己的登录。 |
| Antigravity App | 显式 setup-sidecar 将 Sidecar 绑定到实际项目，核对其资源目录及 App 返回的项目 ID；均省略时使用 Outside of Project。使用 App 2.23 当前配置版本，升级后须复核兼容性。 |

cwd 是工作目录，不等于操作系统沙箱或权限提升。讨论材料在用户指定的 cwd，回答草稿只放任务中的 `draft_directory`；CLI 与凭据是显式的工具路径。路径和项目配置仅保存在本机，不进入公开事件。

本机服务将回答草稿放在 `<服务目录>/drafts/<运行目录摘要>/`，按运行目录隔离；任务文件、执行凭据、日志和 `runtime.sqlite3` 仍在原运行目录。旧房间配置无需改写，服务加载时为其计算同一草稿位置；已有草稿不自动搬迁。单独运行 `runner` 时默认使用运行目录下的 `drafts/` 子目录。草稿经 `--body-file` 提交后以网站记录为准，日志可能保留 CLI 输出；这里的目录分工不承诺讨论内容只存在网站，也不使凭据对所有 AI 工具不可读。

## 独立 CLI 接入

无需打开桌面 App 时，可将下载配置中的 `participants` 改为下面的配置；外层 `site`、`room`、`token` 和 `data_directory` 沿用本房间实际值。这里仅展示参与者部分，原有 `codex`、`antigravity` 仍表示 App 接入，不会自动切换。

```json
{
  "participants": {
    "Codex": {
      "adapter": "codex_cli",
      "executable": "实际原生 codex 可执行文件路径"
    },
    "Claude": {
      "adapter": "claude",
      "executable": "实际原生 claude 可执行文件路径"
    },
    "Gemini": {
      "adapter": "antigravity_cli",
      "executable": "实际原生 agy 可执行文件路径"
    }
  }
}
```

Windows 的 `executable` 填原生 `.exe`，不填 npm 的 `.cmd` / `.ps1` 包装脚本；其他系统同样使用实际可执行文件。服务直接启动进程，不通过 shell 拼接提示词。首次登录仍须在所选 CLI 中完成，App 的安装或登录不代表独立 CLI 已就绪。

| 适配器 | 首次执行与续接 | 项目与工作目录 |
| --- | --- | --- |
| `codex_cli` | `codex exec --json`，从 `thread.started` 读取实际 ID；后续 `exec resume ID`，不使用 `--last` | 首次与续接均显式 `--cd` 到用户指定项目；省略 cwd 时使用本场独立草稿目录。允许非 Git 目录；项目与草稿的写入权限由本次 permission profile 区分。项目名仅作元数据，不关联 App 项目分组 |
| `claude` | 现有 `claude -p --output-format json`；后续 `--resume ID` | 沿用上表中的 Claude 规则 |
| `antigravity_cli` | `agy -p --output-format stream-json`，从 `init.conversation_id` 读取实际 ID；后续 `--conversation ID`，不使用 `--continue` | 在用户指定项目启动；省略 cwd 时使用本场独立草稿目录。首次可通过 `project_id` 或 `project_name` 传 `--project`，续接时沿用该会话的项目；同时提供任务、技能和草稿目录 |

两种新适配器都不需要 `source_thread_id` 或 `ipc_directory`。实际 ID 在输出流到达时写入本机绑定和本次执行凭据，随后 AI 按任务文件自行 `execution enter` 并通过讨论 CLI 保存业务结果；程序不把终端回答直接代发。已有 App 绑定不能通过改适配器直接复用，须先暂停并使用独立 `data_directory` 明确重新接入。此路径不承诺 CLI 会话同步到桌面 App。

### 单次执行权限

每次执行只开放本场讨论所需的最小权限，不使用全部放行或绕过审批参数。任务文件的 `cli` 为 `codiscuss`，`subcommands` 列出唯一放行的网站子命令：`room`、`message`、`turn`、`state`、`floor`、`execution`、`health`、`schema`；`service`、`launch`、`run`、`api`、`setup`、`install`、`local` 不放行。提示词要求命令以 `codiscuss` 开头，不用 `python discuss.py`、`cd` 或管道。规则不含路径，重装或更换 Python 无需更新；子进程 PATH 中的 `codiscuss` 须指向本次安装，setup 的持久命令检查会核对。

项目文件权限 `project_access` 为 `read`（默认）或 `write`：启动文件顶层设本场值，`participants.NAME.project_access` 覆盖单个 AI，空字符串表示沿用本场值。它只随本次启动保存，不能存入本机默认配置；网页新建讨论在“启动”区直接提供项目目录与项目文件选项，单个 AI 的覆盖在“调整启动配置”中。三种 CLI 都在用户指定的 cwd 启动；省略 cwd 时才使用独立草稿目录。只读与可写不再改变项目上下文。**本项目当前对 agy 的只读要求通过提示词实现，不提供强制文件隔离**：不额外启用自动编辑，但继承的用户规则与模式仍可能允许写入。App 适配器的写权限也由 App 自身决定，任务文件始终写明本场要求。

| 适配器 | 本次追加 | 只读 / 可写差异 |
| --- | --- | --- |
| `claude` | `--add-dir` 运行、草稿与技能目录；每个子命令各一条 `Bash(codiscuss room *)` 与 `PowerShell(codiscuss room *)`，仅对独立草稿增加 `Edit(//<草稿目录>/**)`，再追加用户的 `allowed_tools` | 可写时再加 `Edit(//<项目目录>/**)`；不再对运行目录新增 Edit 放行，已有用户规则仍生效；Windows 路径按 `//c/...` 匹配 |
| `codex_cli` | 每次创建唯一名称的 permission profile，通过 `-c default_permissions=...` 与 `permissions.<名称>=...` 传入，`approval_policy="never"`；运行目录只读，独立草稿目录可写 | 无项目或项目只读时继承 `:read-only`，项目可写时继承 `:workspace`；维持原有广泛读取范围和本次联网能力，未启用域名过滤 |
| `antigravity_cli` | `--add-dir` 运行、草稿与技能目录；安装规则仅新增讨论命令和服务草稿目录写入 | 只读时提示词要求不修改项目，不额外传 `accept-edits`；可写时传 `--mode accept-edits`，该模式也可能允许写附加目录，因此不承诺运行目录或技能目录被强制保护 |

上述 agy 限制是本项目当前实现的边界，不表示 agy 缺少禁止写入的能力。官方支持在 `permissions.deny` 使用 `write_file(目录)`，按目录前缀递归匹配，不使用 `/**`；优先级为 Deny > Ask > Allow，全局 `write_file(*)` 禁令不能再用草稿 allow 例外放行。[官方权限文档](https://antigravity.google/docs/permissions?tab=cli) 与 [Issue #798 后续澄清及 Linux 复测](https://github.com/google-antigravity/antigravity-cli/issues/798) 支持这一判断。若以后实现项目强制只读，还须覆盖 shell、MCP 等其他写入渠道，并保留 `codiscuss` 提交能力；直接禁止 `command(*)` 会一并阻断提交。仅省略 `accept-edits` 或使用 `--mode plan` 都不足以完成这些限制，[plan 模式只添加规划指令，shell 仍受独立权限控制](https://antigravity.google/docs/cli/modes)。这套组合尚未在本机 Windows 验证，本轮按用户选择保留提示词约束。

Codex 要求 CLI 0.163.0 或更新版本，使用 permission profiles 和本地 `app-server config/read`。配置检查先核对初始化回执中的版本；不支持或无法识别的版本拒绝交付。每次交付前只启动本地配置检查进程，不创建会话、不调用模型；发现已加载的旧 `sandbox_mode` / `sandbox_workspace_write` 或新配置未被采用就拒绝交付，避免旧设置覆盖本次限制。报错后需更新不支持的 CLI 或移除冲突的旧配置；接入程序不自动改写用户全局设置。首次与续接使用同一组权限参数，配置检查进程也随暂停或停止清理。[Codex 权限配置](https://learn.chatgpt.com/docs/permissions)

agy 没有单次命令放行参数，规则只能写入 `~/.gemini/antigravity-cli/settings.json` 的 `permissions.allow`。`setup` 选中 Gemini 时询问一次（回车同意，`--yes` 视为同意），追加两条规则：只匹配 `codiscuss` 或 `codiscuss.cmd`、可选一个 `--site` 网址及上述子命令的 `command(regex:...)`，参数不得含分号、`&`、`|`、`<`、`>`、美元符号与反引号，因此无法接第二条命令；以及 `write_file(<服务目录>/drafts)`（Windows 保留盘符、使用正斜杠）。写入前备份原文件到服务目录 `agy-settings.backup.json`，`agy-permission.json` 记录已写规则；升级后重跑 setup 会将本工具曾写入的宽泛 `launches` 写规则替换为 `drafts`，不改其他设置与用户规则。单独运行 runner 时须按任务中的实际草稿目录配置 agy。文件无法解析时不写入并报告待处理；非交互且未加 `--yes` 只报告。

2026-10-18 本机实测（本轮权限调整前）：Claude 主持、Codex 与 Gemini 专家完成一场最小讨论。Windows 的 Codex / agy 经 PowerShell 调用时优先执行 npm 生成的 `codiscuss.ps1`；Codex elevated 沙箱内即使当前用户为 RemoteSigned 也拒绝 `.ps1`，Codex 自行改用 `cmd.exe` 调用 `codiscuss.cmd` 后成功。`agy` 非交互模式下被拒绝的工具也可能伴随退出码 0，最终仍以网站业务保存为准。`agy` 显式使用 `--print-timeout 0`，由房间的单次执行时限和整场截止控制停止，避免额外的 CLI 默认时限提前截断。

结构化失败（Codex `turn.failed`、Antigravity 非 `SUCCESS` 结果）、非零退出码、缺少会话 ID 或成功结束事件均记录为失败；软件已启动后不自动重发。正常退出后若网站尚未保存本次结果，复查后暂停。暂停或停止接入服务会终止本服务创建的 CLI 进程，保留会话绑定和本机日志。

2026-10-19 权限调整验证：Windows / Codex CLI 0.163.0 的本地配置检查采用了本次 profile；以原生 `sandbox`（`unelevated`）运行无模型的文件操作，确认项目 cwd 保持、中文文件可读、只读模式拒绝项目与运行目录写入、可写模式允许项目写入但仍拒绝运行目录写入，两种模式均可写草稿并访问本机 HTTP。此证据不覆盖 elevated 模式、其他平台或本轮调整后的真实模型讨论。

接口依据：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Antigravity CLI 非交互模式](https://antigravity.google/docs/cli/headless/)。2026-10-18 已核对本机 Codex CLI 0.163.0、Antigravity CLI 1.4.2 的版本与帮助参数；自动化测试使用临时 HTTP 服务和子进程替身验证启动、绑定、续接、错误和暂停，真实讨论与本轮调整的验证边界分别如上。

## 常驻讨论服务

`discussion_service.mjs` 把上述事件消费封装为本机常驻服务，`codiscuss.mjs` 提供面向用户的 CLI：一个进程托管所有已登记房间，网页看板点「重启」后无需再回终端启动程序。服务每轮检查后等待 2 秒，重读登记表并对每个房间执行同一 `DiscussionRunner` 检查；房间暂停、到期、停止或收束时只继续等待，不退出。单个房间的配置错误、数据目录被 `watch` 占用或网站请求失败只记录在该房间状态中，其他房间照常处理。

首次在仓库目录安装本机命令（需要 Node.js 24+ 与 npm，安装本身不启动服务）：

```sh
npm link
```

之后在任意目录使用：

```sh
codiscuss service add --config PRIVATE.json
codiscuss
```

`codiscuss`（等同 `codiscuss service run`）在当前终端运行，显示服务 PID、服务目录、已登记房间数、房间状态变化与错误；尚未登记房间时给出接入命令并继续等待。按 `Ctrl+C` 暂停托管中的讨论并退出。已存在服务时显示其状态后返回，不重复启动。配置文件路径相对于当前终端目录解析。`npm link` 将命令链接到本仓库，移动或删除仓库前需重新安装或运行 `npm unlink -g ai_co_discuss` 移除命令；命令不在 PATH 时，将 `npm prefix -g` 对应的 Windows 目录（其他系统为其中的 `bin`）加入 PATH 后重开终端。

```sh
codiscuss service status
codiscuss service stop
codiscuss service start
codiscuss service --help
```

`add` / `remove` / `list` 维护登记表，同一站点与房间只能登记一份配置；登记不启动讨论。常驻服务运行后，首次用 `codiscuss run view` 读取版本，再用 `codiscuss run start` 明确启动有限运行，完整命令见 [首次启动房间](deployment.md#首次启动房间)；已暂停的自动讨论可在网页点“重启”。显式 `service start` 以无窗口方式启动后台服务，已有服务时直接复用。`stop` 请求服务退出：先暂停其中仍在运行的房间，再停止本服务创建的 CLI 子进程并释放锁，避免网站显示进行中却无人领取。`status` 显示服务是否在线及各房间最近一次检查结果（运行中、已暂停、等待启动、异常）。管理命令可加 `--json` 获取原始 JSON（状态值为 `running`/`paused`/`idle`/`error`）；原有 `npm run service -- COMMAND` 入口继续保留 JSON 输出。

登记更新通过服务目录中的 `registry-lock.sqlite3` 写事务互斥，最多等待 5 秒；获得锁后才重读并原子替换 `rooms.json`，避免多个网页 / CLI 进程同时登记或移除时互相覆盖。该数据库只用于锁，登记表格式保持不变；进程中断由 SQLite 释放锁，不要求手动清理过期锁文件。

并发 `service start` 复用取得服务锁的进程，只有创建者报告拥有该进程。启动器等待当前进程写出就绪回执，不能仅因 PID 存活或旧进程留下状态就报告成功。`service status` 的 `running` 表示进程存在，`ready` 表示当前进程已确认初始化；`local status` 只有网站和已就绪讨论服务同时存在时才报告整体运行。就绪不证明各房间已交付，更不证明 AI 已进入。

损坏或缺失的单个房间配置不阻塞其他房间登记；仍可读取站点和房间身份时，即使其软件配置失效，也继续拒绝同房间的第二份登记。原坏配置保留，由服务状态单独报告。网页的“网站已连接”只表示网站可访问；接入页按实际执行事件显示待接入、已交付、执行中、完成或失败，不把网站连接或运行已启用当作模型执行成功。

原有 `codiscuss start|status|stop|add|…` 和不带参数的 `codiscuss run` 保留为兼容别名。网站操作也统一使用 `codiscuss room …` / `message …` 等，需要 Python 3.10+；`codiscuss run start|pause|view` 只控制网站讨论，不管理本机服务进程，详见 [CLI 使用](cli.md)。

### 快捷方式、自启与数据目录

`codiscuss service shortcut` 在 Windows 桌面创建「AI CoDiscuss 讨论服务」快捷方式：双击即启动后台服务（已运行则复用），并用默认浏览器打开已登记的讨论网站。`codiscuss service autostart on|off` 在当前用户的启动文件夹添加或删除登录自启快捷方式，默认不开启。登记表、锁、`status.json` 与 `service.log` 位于 `%LOCALAPPDATA%/ai-codiscuss/service`（其他系统为 `~/.local/state/ai-codiscuss/service`），可用 `DISCUSS_SERVICE_HOME` 改变；各房间的游标、收件箱与会话绑定仍在各自数据目录。

## Antigravity Sidecar

```sh
npm run runner -- setup-sidecar --config PRIVATE.json
```

`setup-sidecar` 是显式本机配置操作，只添加自己的 Sidecar 项并保留其他 App 设置，不开始讨论。保持 Antigravity 打开；核对其私有 IPC 目录中 ready 回执的项目 ID 与实际 PID。停止使用时在 App 停用该 Sidecar；不能结束其他项目的 Sidecar 或整个 App。

## 单房间独立运行

无需常驻服务时，可在仓库目录单独运行一个房间；不要与常驻服务同时消费同一配置。

```sh
npm run runner -- start --config PRIVATE.json --minutes 60
npm run runner -- status --config PRIVATE.json
npm run runner -- pause --config PRIVATE.json
npm run runner -- watch --config PRIVATE.json
```

`start` 要求 (0,1440] 分钟及完整参与配置；`--minutes` 可省略并采用网页保存的总时长，服务器取启动截止与话题截止的较早值。`watch` 仅恢复事件消费。运行暂停（含执行失败、到期）时程序继续等待，网页进度看板点「重启」后接着处理；停止、收束或切到手动才退出。每 2 秒查询、HTTP 超时 10 秒；已入队任务等待实际进入，不设置从投递起算的启动超时，也不因聊天忙碌而重发。排队仍受整场截止约束。网站租约最多 120 秒、每 30 秒续租，单执行上限采用房间 `execution_minutes`（旧房间默认 20 分钟），从 AI 实际进入执行起算。空查询不调用 AI。控制终端中断先暂停，再停止本程序创建的 CLI 子进程；不结束桌面应用。

## 上限与收束

每次交付前核对 `room.limits`；达到轮次/时间上限时调用 `/limits`，再根据实际返回的运行状态处理。暂停不再唤醒 AI；收束则终止本程序的旧子进程，接收新代次的主持任务，由主持人依据已有内容总结。收束预留计入总时长，最终截止仍由网站拒绝迟到写入。手动房间的原生任务由主持技能检查，不由本程序接管。

已经进入收束后，普通轮询只读取状态，避免重复提交无变化的 `/limits`；最终时间到达仍执行到限暂停。

## 交付与故障恢复

接收事件和推进游标同事务；先保存交付状态再调用软件，重启不重发已受理或结果不明的请求。收件箱持久保存尝试次数、下次重试时间与软件回执，旧库打开时补齐字段，不清空既有工作。reserve 的 HTTP 回执丢失时先核对网站及原执行凭据，再继续尚未发生的软件调用。

只有确认软件尚未被调用的失败（如进程未能启动、App 连接尚未建立或 Sidecar 未就绪）才自动重试：首次失败后等 2 秒，再次失败后等 4 秒，最多尝试 3 次；重试复用原事件、执行令牌与任务正文。每次重试或报告失败前先查网站：已经进入则续租，业务已保存则完成，不重发。软件调用已发生后的非零退出、超时或创建回执丢失不能证明未送达，保留 `uncertain` 并继续核对网站业务状态及可用的 Sidecar 回执，受整场截止约束。Codex queue 的原始受理回执保存在本机；不能把缺少执行回执当成投递失败。3 次确认未送出、已启动的 CLI 进程报告失败或实际执行租约到期时按失败暂停。Claude 进程结束时立即判断：非零退出码，或输出里 `is_error` 为真（例如用量上限 429 时退出码仍为 0），都马上以原始错误暂停，不再等单次执行时限；新增独立 CLI 按上节的结构化事件核对。正常退出但网站上本次执行仍未完成时，先重新查看事件，确认仍未保存结果再以“会话已结束，但未保存本次结果”暂停。

数据目录固定站点、房间、运行及参与者项目/cwd 配置，修改后拒绝继续复用；需先暂停，明确重新接入。完成以网站业务记录为准，网页中的 dispatched、started、completed 分别表示交付、真实进入、业务保存；收束退出前核对本地最后一项状态。排障须核对原会话与对应事件，不能删库或换编号冒充重试。手动兜底由用户明确选择，通知程序不会自动降级。

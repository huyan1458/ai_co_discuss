# 自动接入程序

`runner/` 是本仓库自带的全自动讨论接入程序，只依赖 Node.js 24 内置模块。`discussion_runner.mjs` 输入显式房间配置，增量读取 CoDiscuss 事件，在独立 SQLite 保存游标、收件箱与真实会话绑定；`discussion_adapters.mjs` 分派软件和 API 入口；`discussion_sidecar.mjs` 由 Antigravity App 管理；`codex_app_client.mjs` 连接运行中 Codex 桌面应用的 app-tools 管道。网站业务保存事件，显式开启的本机桥接可把启动请求交给 Node 接入服务；讨论决策与发言由实际 AI 负责；软件入口交付原会话，API 入口使用用户明确配置的模型服务和房间工具。

## API 接入

“程序唤醒”支持 Codex（OpenAI）、Claude、Gemini、DeepSeek、Qwen、Grok 的 API 专家和主持人，也支持与已有 CLI / App 参与者混用。供应商列表固定显示，不依赖软件安装检测；API 主持人从网页启动。自由协作房间使用同一 API 适配器，但回答绑定成员执行，不使用讨论轮次。

翻开专家卡片选择 API，核对 Base URL 和请求协议，在“密钥”行填写并点击“保存”，再在“模型”行选择推荐模型或输入完整模型 ID。模型行右侧的刷新按钮（读取模型列表）只请求服务商的 `/models`，不生成回答；下拉展示完整返回列表，不按当前填入的模型名过滤，展示名与调用 ID 分开保存（例如 DeepSeek-V4.1-Flash 的 ID 为 `deepseek-flash`）。失败时仍可手输 ID。下面是 **2026-10-21** 核对的官方默认值，实际可用模型与额度由账号决定：

| 房间身份 / 供应商 | 默认 Base URL | 请求协议 | 推荐模型 ID |
| --- | --- | --- | --- |
| Codex / OpenAI | `https://api.openai.com/v1` | Responses | `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-luna` |
| Claude / Anthropic | `https://api.anthropic.com/v1` | Messages | `claude-sonnet-5-5`、`claude-opus-5-5`、`claude-haiku-5-5`、`claude-fable-5-1` |
| Gemini / Google | `https://generativelanguage.googleapis.com/v1beta` | generateContent | `gemini-4-argon`、`gemini-3.8-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions | `deepseek-flash`、`deepseek-v4-pro` |
| Qwen / 百炼（北京） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions | `qwen3.8-flash`、`qwen3.7-plus`、`qwen3.8-max` |
| Grok / xAI | `https://api.x.ai/v1` | Responses | `grok-4.7` |

来源：[OpenAI 模型](https://developers.openai.com/api/docs/models)、[Claude 模型](https://platform.claude.com/docs/en/models/overview)、[Gemini 模型](https://ai.google.dev/gemini-api/docs/models)、[DeepSeek API](https://api-docs.deepseek.com/zh-cn/)、[百炼模型](https://help.aliyun.com/zh/model-studio/models)、[Grok 模型](https://docs.x.ai/developers/models/grok-4.7)。百炼不同地域的 Key 与地址须匹配。

自定义地址保留完整路径前缀，填写到协议根路径，例如 [OpenRouter](https://openrouter.ai/docs/api_reference/overview) 的 `https://openrouter.ai/api/v1`，选择 Chat Completions 并填写其返回的 `provider/model` ID。程序分别追加 `/responses`、`/chat/completions`、`/messages` 或 `/models/{model}:generateContent`；不改写模型 ID 中的点号、横线或斜线，不按房间身份强制套用官方协议或思考参数。实现参考 [Cherry Studio 的供应商解析说明（固定版本）](https://github.com/CherryHQ/cherry-studio/blob/843a297fe73e9f527c8eb8291c0e1335f2279c04/docs/references/ai/provider-resolution.md) 对供应商、协议、Base URL 与 API 模型 ID 的拆分方式；协议转换独立实现，不引入其代码或 SDK。

`POST /api/local/api-key`（CLI 为 `codiscuss launch api-key --file FILE`）接收 `{base_url, api_key}`，仅向本机服务目录的 `api-keys/UUID.json` 写入，返回 `{api_key_ref}`。文件依赖本机用户目录权限保护，不作加密保险库；不要共享此目录。Base URL 改动后必须重新填写该地址对应的 Key。`launch settings` 读取结果附带 `api_keys`（`{Base URL: api_key_ref}`，同一地址取最近保存的一份，不含密钥），新建表单与改 Base URL 时自动带出该地址已保存的 Key，无需重复填写。网页密钥输入框不设保存按钮，失焦或回车即保存，可切换明文显示；它是用 CSS 遮挡的文本框，避免浏览器提示生成或保存密码。本次输入的密钥只在组件内存保留，保存后仍留在框内，可切换明文；本机不把已保存的密钥回传网页，重新打开时只显示遮挡占位，输入新 Key 即更换；密钥不进入控制器快照、localStorage、启动待办、房间数据或上游错误日志。

`POST /api/local/api-check`（CLI 为 `codiscuss launch api-check --file FILE`）接收 API profile，用该 profile 带一个空工具向模型发送一次极短请求（30 秒超时），一并核对地址、密钥、协议、模型与工具调用支持，成功返回 `{ok:true}`，失败只报 HTTP 状态。会产生一次极小的模型调用费用。网页 API 卡片背面标题右侧的闪电按钮调用此入口。

启动配置中的 API profile 为 `{adapter:"api", base_url, api_protocol, api_key_ref, model}`；`api_protocol` 为 `responses/chat/anthropic/gemini`。启动器在私有房间配置保存 `api_home`，供服务解析密钥引用。API 不需要 executable、项目目录、会话 ID 或技能安装；API 会话编号是本机参与者绑定，不是厂商的聊天 ID。模型列表入口仍为 `launch models` / `/api/local/models`，传入此 profile，只返回模型元数据。

API 参与者不安装技能，也不靠手写的另一套规则：每次执行时，程序从包内读取与本地软件相同的 `discuss-participant`（讨论主持人另加 `discuss-host`）正文作为系统提示词，前面附一段 API 环境说明，列出 CLI 命令对应的房间工具，并说明定时任务、凭据文件、执行认领等段落不适用。技能更新后下一次执行即生效；主持人一次约多出 1 万字符输入。在线网页 AI 同样不加载技能，阅读页 `/r/房间` 末尾附有精简的在线成员守则；本地 AI 的阅读页只指引其调用技能与 `codiscuss room protocol`。

每个有效任务重新读取房间与当前安排，按需读取原文。独立观点阶段不会把他人观点或主持总结送给专家；专家仅可提交本次安排，主持人可写主持说明、整理状态、调整阶段、安排整轮或收束；到限方式为“暂停保留现场”的房间拒绝主持人直接收束，主持人目标提前完成时调用 `declare_done`（对应 `room limits --done`），由程序暂停并交用户选择。API 与网页专家的项目权限固定只读，只有 CLI 专家可选择只读或写入；API 配置即使残留 `project_access="write"` 或本场设置为可写，执行器也强制归一为 `read`。API 没有本机文件、浏览器、附件解析或任意 HTTP 工具，不继承 cwd 的读写权限；消息里的附件对它只是名称、大小与 ID，系统提示词要求它说明未读取、不得凭文件名猜测内容；此权限不限制保存讨论发言及履行主持职责。模型看不到网站令牌和 API Key；房间 HTTP 请求由程序绑定身份与执行。

执行器在后台请求模型，主循环继续续租和处理暂停。单次模型请求超时 180 秒，每个执行最多 24 次模型请求；需显式输出上限的协议使用 8192 tokens。Responses 保留加密 reasoning items，Anthropic 保留签名块，Gemini 保留 thoughtSignature，Chat Completions 保留工具历史；这些推理内容不作为公开发言。未调用保存工具、请求失败或超限时，讨论暂停并保留错误，自由房间只结束该成员的失败执行。暂停或撤销会取消本机请求，服务端继续校验执行有效性；不把迟到回答改作普通发言。每次写入前保存原提交编号和正文，网络结果不明时停止，不换号自动重试。

共享协议为兼容旧房间，仍用 `experts[name]="cli"` 表示可自行提交；实际入口由本机 `adapter` 和成员记录区分。API 原文保存 `source="api"`，沿用原身份、职责、安排关联、耗时和备份规则。测试覆盖四种请求格式、六家身份、API 主持收束、自由回答及暂停取消，使用隔离网站和模拟 API；不代表六家真实账号均已验证。

## npm 安装与本机配置

网站附件由 `codiscuss attachment` 命令按需读写，详见 [CLI 附件](cli.md#附件)。接入程序的事件通知不携带文件字节，也不替实际 AI 解析文件；自动参与者使用本次凭据（进程绑定或显式 `--access-file`）在提交回答前完成上传和关联。本地数据库迁移、备份时同时保留其 `.attachments` 目录。

需要 Node.js 24+、npm 与 Python 3.10+。包内带已构建网页、Python 后端、接入程序及三份完整技能；运行时不安装前端依赖。从 npm registry 安装：

```sh
npx --yes --package ai_co_discuss codiscuss install
```

`install` 在安装包或写配置前检查 Node、Python、端口参数及显式选择的软件路径，再将当前包安装到 npm 的全局 prefix，由持久安装运行 `setup`；不依赖 npx 缓存长期存在。已有源码时可直接在仓库执行 `node runner/codiscuss.mjs install`。维护者生成的 `.tgz` 可将包名换成文件路径。普通 `npm install --global ai_co_discuss` 只安装命令，随后运行 `codiscuss setup`；没有 postinstall 配置或启动副作用。开发者仍可使用下文的 `npm link`。

`setup` 检测 Python 和固定四类 CLI：Claude（`claude`）、Codex（`codex`）、Gemini 使用的 Antigravity（`agy`）、Grok 使用的 Cursor（`agent` / `cursor-agent`）。按显式路径或 PATH 查找并执行有超时的 `--version`；Windows 读取实际 `.exe`（PATH 上只有 npm 包装脚本时，到 `node_modules/@openai` 包内查找 Codex 原生程序，跳过 npm 升级残留的 `.` 开头目录），Cursor 也支持官方 `.cmd` 启动入口。仅检查 CLI 能否启动，不扫描 App、账号登录或模型状态；已有 App 配置不会被当成检测成功。

用户选定后，Python、端口写入服务目录的 `local-settings.json`；已支持自动接入的 CLI 默认配置写入 `launch-settings.json`。已有类型或路径与检测结果不同时，交互终端显示两者并询问保留或更新；非交互或 `--yes` 保留旧配置，但报告待处理，不能视为所选 CLI 已配置。显式 `--codex/--claude/--antigravity` 路径直接更新对应软件为 CLI，其他已保存字段保留。结果列出实际沿用的类型与路径。Cursor 当前仅检测并安装技能，不写入无效的自动启动配置；可按手动接入流程参与，Grok 模型由用户在 Cursor 中选择。登录和工具许可仍在对应 CLI 中设置。

```sh
codiscuss setup --yes --clients codex,claude --no-start
codiscuss setup --yes --clients none --python "/absolute/path/to/python" --port 8766 --no-open
codiscuss local open
codiscuss local status
codiscuss local stop
```

交互终端显示多选列表（方向键移动、空格勾选、回车确认，Ctrl+C 取消），默认勾选检测到且已有自动适配器的 CLI，未检测到的软件不可勾选；`--yes` 同样默认选择这些 CLI；`--clients codex,claude,antigravity,cursor` 明确选择，`none` 只配置网站，Cursor 需要显式选择。`--no-start` 只配置，`--no-open` 启动网站但不打开浏览器；无交互输入时须提供 `--yes` 或 `--clients`。软件路径可用 `--codex PATH`、`--claude PATH`、`--antigravity PATH`、`--cursor PATH` 指定。`install --prefix DIR` 可使用可写的 npm 安装前缀；Windows 命令目录是 prefix 本身，macOS/Linux 是其 `bin` 子目录。

配置结束时忽略 npx 临时入口，核对当前 PATH 中的持久 `codiscuss` 是否指向本次安装，并实际执行 `--help`。命令缺失、旧入口优先或无法运行均报告待处理及处理方式；自定义 prefix 未在 PATH 时，输出需要加入的实际目录。安装器不修改系统 PATH；修正后重新打开终端运行 `codiscuss setup`。

`install/setup` 在 stderr 输出中文摘要，包括实际软件配置、Skill 文件就绪数、命令和网站地址；交互终端显示分步进度、多选列表与对齐的结果汇总（遵循 `NO_COLOR`），输出被重定向时保持逐行纯文本。结果 JSON 在 stdout 被重定向或加 `--json` 时写入 stdout，交互终端默认不打印。退出码与 JSON `status` 对应：`0` 为 `ready`（网站与讨论服务已就绪）或 `configured`（显式 `--no-start`）；`2` 为 `needs_attention`（配置差异未确认、技能冲突或命令不可用）；`1` 为失败。网站启动失败时返回 `start_failed` 与已保存的配置结果，修复后重跑 `setup` 即可。环境预检失败发生在写入前，仅输出错误。配置待处理不撤销已完成部分，也不妨碍启动可用的网站；`configured` 布尔值为 false，不能按成功处理。`ai_verified: false` 表示安装器没有执行真实模型，不证明账号、技能发现或多轮讨论已验收。

安装器按 [技能配置](skills.md#自动安装完整技能) 复制完整技能。`--skills-home DIR` 可覆盖技能用户根目录；默认当前用户 home。重复安装只更新由安装器管理且未被编辑的版本；冲突保留本地文件，输出实际路径并标记待处理。核对后可移走需替换的旧副本再重跑 `setup`。安装器不调整登录状态，也不向 agy 全局设置写入权限规则；只清理早期版本写入的规则，见 [单次执行权限](#单次执行权限)。

安装实现保持固定软件表和本地文件复制。路径查找参考 [npm/node-which](https://github.com/npm/node-which/blob/main/lib/index.js) 的 PATH 顺序与执行权限检查，只覆盖所需命令和后缀；技能复制参考 [OpenAI 单文件安装脚本](https://github.com/openai/skills/blob/main/skills/.system/skill-installer/scripts/install-skill-from-github.py) 的整目录复制与同名保护思路，保留本项目的内容哈希更新判断。不引入这些项目作为依赖，也不增加在线技能下载、插件注册或后台更新。

默认 `setup` 最后执行 `local open`：后台启动 Python 回环网站（`--local-launch --no-demo`）与讨论服务，再打开浏览器；首次为空库。网站地址默认为 `http://127.0.0.1:8765`。`local start` 具有相同启动行为但不打开浏览器，重复启动复用原进程；真正绑定成功并通过健康检查后才返回就绪。端口占用会失败，不接管或停止占用者。网站管理进程脱离启动它的终端在后台运行，关闭终端不会停止网站或讨论服务；本机网站不设登录自启，重启电脑后运行 `local open` 重新启动。安装摘要会同时提示这些状态与停止命令。`setup` 启动前若发现网站已在运行但版本（记录在 `local/status.json`）或端口与当前安装不同，交互终端询问是否重启（默认重启，会暂停托管中的讨论）；`--yes` 或非交互运行不停止服务，报告待处理及 `local stop` / `local open` 命令。版本与端口一致时直接复用。`local open/start/status/stop` 在终端显示中文结果与网站地址；输出被重定向或加 `--json` 时在 stdout 输出 JSON。改端口或升级程序前先 `local stop`，再重新启动。

网站数据库为服务目录下 `local/discuss.sqlite3`，配置、登记表和讨论执行数据也位于包外；服务目录位置及 `DISCUSS_SERVICE_HOME` 见下文。源码运行的 `data/discuss.sqlite3` 不自动迁移。网站仍在而讨论服务已停止时，显式 `local open/start` 会要求网站管理进程恢复服务；不会自动恢复已暂停的房间。`local status` 的 `running` 要求网站和讨论服务同时运行，`website_running` 单独表示网站状态。`local stop` 关闭它创建的网站，并停止它启动或恢复且仍由相同 PID 持有的讨论服务；预先运行或后来独立启动的服务会保留。停止服务会暂停其托管中的活动讨论，数据库保留。日志在 `local/website.log`、`local/supervisor.log` 与原 `service.log`。

默认服务目录 `~/.codiscuss` 不在 AppData，不受下述重定向影响；以下适用于旧版 AppData 目录或设在 AppData 内的 `DISCUSS_SERVICE_HOME`。Windows 的 MSIX 应用（如 Claude 桌面版）可能把派生进程对 AppData 的写入重定向到 `Packages/<包名>/LocalCache/Local/`；同名数据库、锁和停止请求因此与普通终端分离。管理命令在读状态、建房或启动进程前，用临时文件核实实际写入位置，发现重定向就报出两处路径并停止，避免误报已启动或已停止；帮助和纯 HTTP 网站命令仍可使用。检测依据是文件实际位置，不依赖进程是否报告包身份。Python 启动别名与直接执行原生 Python 也可能进入不同文件视图，排查时须核对网站实际使用的可执行文件与数据库。此机制见 [Microsoft MSIX 文件虚拟化说明](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)。

遇到该错误，从应用外的普通终端管理服务；需要所有入口直接管理时，为它们统一设置 AppData 之外的 `DISCUSS_SERVICE_HOME`，已有数据需停机备份后迁移，不会自动合并两份库。若旧版本已在包私有目录启动服务，先核对该目录的 `local/status.json`、`status.json` 和实际 PID，再在普通终端将 `DISCUSS_SERVICE_HOME` 显式设为该物理目录执行 `local stop`；独立启动的讨论服务仍需单独 `service stop`，`local stop` 会明确报告保留的 PID。停止请求必须与目标进程使用同一份目录，仅看到另一个目录没有锁不能证明目标已退出。

已安装后升级不要使用 `npx`（它会运行已安装的旧版本）：先 `codiscuss local stop`，再 `npm install --global --prefer-online ai_co_discuss@latest`，然后重跑 `codiscuss setup`；`--prefer-online` 避免本地缓存把 `latest` 解析为旧版本。

卸载先 `codiscuss local stop`，按需要另用 `codiscuss service stop` 停止预先独立运行的服务，再执行 `npm uninstall --global ai_co_discuss`；自定义 prefix 时带回相同 `--prefix`。安装器不删除数据库、私有配置或已复制技能。

维护者从源码生成安装包时先完成相关测试与网页构建，再 `npm pack --pack-destination <已存在的输出目录>`。包采用运行文件白名单，不含数据库、凭据、`.dev`、前端源码或 node_modules；新增运行文件需同步清单。`npm run test:install` 在临时 prefix/home 中验证真实 npx 安装、命令、技能和本机启停，不触发真实 AI。Windows 已通过隔离测试；macOS/Linux 启动与默认浏览器仍需实机核验。

## 两种讨论入口与启动配置

讨论可以从已有 AI 对话调用主持 Skill 发起，也可以从本机或已连接本机的线上网页发起。它们共用 `runner/discussion_launch.mjs`；全自动 / 手动是推进方式，CLI / App 是实际执行客户端。以下统一启动器用于全自动接入；手动讨论保留原 Skill / CLI 流程。

配置分两层：

- **本机软件默认配置**：按参与者保存 CLI / App 类型、原生可执行文件、App 来源聊天 / Sidecar、可选工具许可及软件项目 / 目录。保存在服务目录的 `launch-settings.json`，两个入口复用；不保存全局当前房间、身份或会话 ID。
- **单场配置**：议题、主持人、专家和上限由房间保存；本次软件覆盖、实际会话绑定、项目 / cwd 与凭据只保存在服务目录 `launches/` 下。默认新建参与会话，显式 `session_id` 才复用；对话入口的主持使用当前实际会话。

可执行文件、cwd 和 Sidecar 目录须填写完整绝对路径，避免从不同入口启动时解析到不同位置。网页直接显示本次目录、会话新建 / 复用及项目含义；Codex / Claude CLI 的项目名是任务说明，不代表关联 App 项目，未指定目录时使用本次讨论的独立草稿目录。网页成功启动或恢复原启动后，清除与已提交快照相同的单场会话 ID、公共 cwd / 项目草稿，保留等待期间的新编辑；创建并启动失败时保留表单和原草稿，在表单内显示具体参与者的错误，原配置重试沿用提交编号。

单场省略参与者字段表示继承本机默认值；明确将该 AI 的 `cwd`、`project_name` 或 `project_id` 设为空字符串，则取消该字段的默认覆盖，采用本次公共目录 / 项目或软件默认位置。网页清空字段也遵循此规则；不点击保存默认配置就不会改动后续讨论的默认值。

### 从网页发起

```sh
python server.py --host 127.0.0.1 --local-launch
```

需要 Node.js 24+ 与已安装、已登录的 AI 客户端；讨论所需的最小工具权限按 [单次执行权限](#单次执行权限) 提供。新建时分别选择房间用法与“程序唤醒”，从卡片下方的“添加”行加入本地参与实例，点卡片上的皇冠指定主持人；自由协作默认由第一位能自行发言的成员主持（用户是需求方），头脑风暴须选择本地 AI 主持。参与区只显示已加入的实例，用独立“移出”按钮调整名单。自动 CLI 卡片翻到背面后通过真实软件目录下拉选择模型，并按该模型支持的档位显示强度滑杆；首档使用 CLI 默认，agy 的思考档位通过原生只读命令查询。恢复默认只清除该实例的模型与强度覆盖，App、网页和手动会话在原软件设置。配置入口不依赖勾选立即启动，移出后重新加入保留本次填写。接入方式默认“程序唤醒”，“创建后立即启动 AI”默认勾选；本机服务未连接时只建房。项目文件权限在各自动 CLI 卡片上按专家设置（默认只读，在线专家固定只读），卡片背面“取消”或 Esc 恢复翻面前的设置，“完成”保留修改；卡片只在缺少软件路径、Sidecar IPC 目录或 Codex App 来源聊天时显示对应输入。项目目录可直接输入，也可点输入框右侧的文件夹图标经 `POST /api/local/pick-directory` 在运行本机服务的电脑上弹出系统目录选择窗口（Windows 用 PowerShell WinForms，macOS 用 osascript，Linux 用 zenity），取消时不返回路径，窗口最长等待 10 分钟。再点击“创建并启动讨论”；不勾选则只建房，之后在“接入”页启动。自由协作的“创建并连接”登记自动成员，后续点名产生任务时才唤醒。复用会话、单个 AI 的工作目录与项目等高级覆盖，以及“保存为本机软件默认配置”，在建房后的“接入”页设置，保存本身不启动任何 AI。卡片输入沿用当前页面的启动草稿，不随只建房请求保存到网站。正常首次自动接入无需下载 JSON、手动登记房间或另执行 `run start`。

网页在发送前把完整已提交输入、原提交号和控制凭据保存在当前站点的浏览器本地存储。服务启动失败或响应丢失后，刷新仍会显示“继续未完成的启动”；点击“继续本次启动”沿用原请求和本机已固定配置，无需重新填写，也不随新的默认配置变化。刷新只恢复界面，不自动运行；已暂停、结束、过期或在启动期间改变的房间不会因此重新开始。部分失败明确显示已核实的阶段，已建房不等于回滚；结果不明时保留原请求待核对。

“移除待办”仅取消此浏览器的重试意图，不删除房间或停止讨论。首次请求预检确认尚未执行时可直接修正后提交；已有部分结果或结果不明时，应先处理原请求，不悄悄换编号建另一场。请求完成后先保存房间凭据关联，再移除待办；不同标签的迟到失败不能删除新一次重试的记录。重试自身的预检失败也不删除原待办，因为另一次在途请求可能已产生结果。浏览器本地存储不可写时，网页会在发送前报错；存储被清除后，使用原私有配置恢复，不提供仅凭公开房间编号的自动认领。

### 本机模型目录

网页的自动 CLI 模型选择通过 `POST /api/local/models` 读取本机软件目录。输入为 `adapter`、可选完整 `executable`；未传路径时沿用该适配器的本机配置。CLI 对应 `codiscuss launch models --file FILE`。返回 `{adapter, models:[{id,label,efforts?}], source, error?}`，只含模型元数据；没有列表时显示原因并允许使用软件默认，不要求手填 ID。部分 CLI 列表较慢（`agy models` 实测约 15 秒），本机服务把成功结果按适配器、路径与可执行文件大小/修改时间缓存在服务目录的 `model-catalogs.json`，24 小时内复用；可执行文件变化或点“重试”（`refresh: true`）时重新查询，查询失败不覆盖上次成功的列表。卡片加入后即在后台预读，不等翻面；页面同样按适配器和路径缓存，模型支持的档位随目录返回；App、纯网页和手动会话在原软件设置。

- Codex：临时运行 `app-server`，依次 `initialize`、`initialized`、分页 `model/list`，不创建 thread 或 turn。见 [官方协议](https://learn.chatgpt.com/docs/app-server#list-models-modellist)。
- Claude：临时以 `--safe-mode --no-session-persistence` 开启流式控制通道，仅发送 initialize，读取软件返回的 models 和 supportedEffortLevels；禁用自定义启动扩展，不发送用户消息。协议依据 [官方客户端初始化](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。旧版本不支持时显示查询失败。
- Antigravity：执行只读 `agy models`，解析软件返回的模型 ID 与显示名；另用 `agy -p /effort --output-format json` 查询默认模型的原生档位，选择模型后附 `--model ID` 查询该模型。该命令不创建模型轮次、不修改软件设置。`models` 入口接受可选 `model`，在原模型目录之外返回顶层 `efforts` 或 `effort_error`；档位按模型单独缓存，切换模型复用完整目录，查询失败不猜测可用档位。见 [官方档位说明](https://antigravity.google/docs/cli/commands/effort)。

查询仅使用 Node 内置模块，进程最长 30 秒、响应最多 1 MiB，结束或失败均关闭查询进程。原始软件诊断和账号字段不返回网页；本机入口沿用 Origin 与站点连接鉴权，不需要房间凭据。目录可能含客户端预置项目，不证明账号额度或实际推理可用。本次以本机三个 CLI 完成只读列表核对，没有发送模型提示词或启动真实讨论。

### 已启动后的配置修正

软件启动失败后，先查看进度看板的失败摘要，必要时展开完整错误。登录或工具权限由对应软件处理。切换 Codex 时，可直接打开进度看板参与者旁的“…”菜单，选择“切换 App / CLI”，在弹窗内暂停、读取配置并保存；已经暂停时直接读取。软件路径仍在“接入 → 修正本场软件连接”修改。两个入口共用本场配置，不修改本机默认配置、不自动重启，保留原房间、发言进度和会话。服务确认采用后，可在进度看板明确重启；未确认时先核对本机服务。

命令入口为 `codiscuss launch room-config --file FILE`。输入 `site`、`room_id`、原 `token` 或 `access_file` 可读取；写入另带读取结果中的 `version`、`runtime_revision` 与 `participants`（软件路径为 `executable`，Antigravity App 为 `ipc_directory`；Codex 还可带 `adapter: "codex"` 或 `"codex_cli"`）。只有已登记、受保护且已暂停的自动房间可修正；未完成的启动仍走原待办恢复。写入须经已启用本机桥接的回环网站，CLI 也遵循此限制；网站用数据库写锁保护暂停版本检查至配置文件替换，避免另一窗口在中途重启。当前采用确认也在锁内等待，最多 6 秒，其间其他业务写入需等待。工作目录、项目和会话 ID 不能由请求替换；其他软件暂不支持切换类型。版本冲突须重新读取；服务停止时可保存，但 `applied:false`，不能当作后台已经采用。

Codex 切换必须已有实际会话；程序从原绑定读取编号，保留运行目录、事件记录及其他参与者的绑定。服务只在暂停状态且自己启动的旧 CLI 进程已退出后采用切换。切到 App 后保持 App 运行，模型、思考强度和实际文件权限由 App 设置，任务仍携带本场项目读写要求；原 CLI 模型设置保留供切回时使用。切回 CLI 前必须让 App 实际释放原会话，不能只看空闲状态；本功能不强制关闭 App 或夺取写入锁，未释放时执行会报占用并暂停。保存或队列受理都不代表已发言，重启后核对执行进入与保存的原文。

新建表单切到全自动时，默认选入已配置路径的本地软件，并选择其中一位主持；没有配置则需明确选择和补齐。支持的软件列表不会全部自动参会，手动与自动模式各保留本次表单中的选择。只有自动模式显示单次 AI 执行上限，默认不限，留空或 0 表示不限，按需填写 1–60 分钟。“结束讨论”保留已有记录并回到自由协作；需要主持总结时，直接请主持人写一份。

网页启动由显式启用的 Python 回环服务执行；Cloudflare、普通 Python 公共部署不提供本机配置或进程操作。`--local-launch` 拒绝非 `127.0.0.1` 监听，本机页面继续使用同源接口；线上页面须先完成下节的站点授权，随后由浏览器直接请求本机服务。Node 启动器生成私有配置并调用接入服务，API 模型调用仅发生在已启动房间的有效执行中。启动器会启动或复用讨论服务；网站与服务仍是独立进程。

### 线上网页连接本机

更新线上网页和本机程序后，在运行 AI 的电脑上完成 `setup`，再执行：

```sh
codiscuss local connect https://你的站点
```

`connect` 只接受 HTTPS 根地址（本机验证允许 `http://127.0.0.1:端口` 或 `http://localhost:端口`），不接受用户名、密码、路径、查询或片段。它启动或复用本机网站及讨论服务，为该站点生成独立的随机连接凭据，打开线上网页。页面从链接片段读取连接后立即清除地址栏片段，保存到该站点的浏览器本地存储；片段不会发送到线上 HTTP 服务。`--no-open` 只输出连接链接供手动打开，链接具有本机配置与启动权限，不应分享。

连接成功后，线上页面可以读取 / 保存本机软件默认配置、新建并启动讨论、启动本机尚未登记的现有未启动房间；程序复用原有持久启动日志和会话绑定。首次连接可能需要允许浏览器访问本机网络；[Chrome 的 Local Network Access 说明](https://developer.chrome.com/blog/local-network-access)规定了这类访问的权限要求。须在运行 AI 的同一台电脑和保存连接的浏览器中使用；手机、另一台电脑、未获本机网络权限的浏览器不因此获得远程控制能力。已有的线上房间事件消费方式不变。

软件路径、连接凭据与启动配置由浏览器直接发到 `http://127.0.0.1:<本机端口>/api/local/`，不经过线上服务器。服务目录的 `site-connections.json` 仅保存站点来源及凭据 SHA-256；每次请求重新核对来源、凭据、回环 Host 和自定义头。CORS 仅返回已登记的精确 Origin，实际请求仍必须提供凭据；预检不启动进程或写配置。启动目标固定为已授权 Origin，忽略请求中伪造的 `site`、`entry` 和 `access_file`。原有控制凭据、去重与暂停后不自动恢复规则继续生效。

本机服务重启保留连接；用 `codiscuss local open` 恢复后，在网页重新检查连接即可。再次 `connect` 会替换该站点旧凭据，旧浏览器连接失效。撤销方式：

```sh
codiscuss local disconnect https://你的站点
```

撤销阻止该站点继续读取配置或发起新启动，不终止已运行的讨论，须另行暂停。连接失败或响应丢失时保留原启动待办，恢复后重试原请求；不换编号重建。线上连接暂不开放 `/api/local/room-config`，既有房间的路径修正仍限本机网站的数据库锁保护流程。未连接浏览器仍可使用[下载配置与登记](deployment.md#可选的全自动接入)方式。

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
| `minutes` | 本次运行时长，默认采用房间 max_minutes；范围 [0,1440]，0 表示不限总时长，仍受房间已设上限约束 |

预览核对软件字段、路径、参与方式和讨论上限，不创建房间、服务或 AI；它不证明账号登录和工具权限已就绪。不限总时长时，运行的 `deadline` 为 0，按轮次上限或手动停止结束；执行租约与单次超时继续有效。启动回执只含房间、状态与文件路径，不输出令牌。`current_task` 返回当前主持须读取的任务文件和本次执行凭据路径，随后按参与技能实际 `execution enter`。

建房提交号、房间控制凭据、各实例的成员凭证、本次解析后的软件配置、启动期望版本和首个主持执行先保存在本机，再进行后续操作。网页已生成的成员凭证由启动器保留，不能重新生成造成交付文件失效。网络结果不明时沿用原文件重试，不换提交号；重试使用本次已保存配置，后来修改本机默认值只影响新请求。改变单场显式配置仍会被拒绝作为同次重试。启动后的房间仍需从原进度看板明确继续，重复启动不会自动恢复暂停或结束的讨论。已使用其他配置登记的房间拒绝重复接管，沿用原配置。

接入已有受保护房间时，启动器先验证事件读取所需的控制凭据，再保存日志、启动服务和改变房间状态；错误凭据不留下失败绑定。旧日志曾保存错误凭据时，沿用原请求并提供正确的私有凭据文件或网页凭据，验证成功后会修正该房间配置；运行中的服务读取修正值，保留原会话、运行代次和暂停状态。启动回执不代表 AI 已进入或已完成任务，仍以网站实际执行记录为准。

启动器与 UI 已通过隔离回归；Windows 下本机网页已实际拉起 Claude Code 2.1.302 与 agy 1.4.2，完成发言、主持总结和收束。其他客户端组合、跨平台行为及公开 HTTPS 页面连接本机的完整链路仍需实机核验，具体证据见下文。

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
| Claude Code CLI | 进程以 cwd 启动，后续按实际 session ID `--resume`。未指定目录时使用本场独立草稿目录；项目名仅作接入元数据，不声称关联 Claude 桌面 App 的项目分组。从 Claude Code 会话内启动接入程序或服务时，会去掉宿主会话注入的 `CLAUDECODE`、`CLAUDE_CODE_*` 等变量，Windows 上再读回用户与系统保存的 `ANTHROPIC_*`/`CLAUDE*` 变量（如 `claude setup-token` 的 `CLAUDE_CODE_OAUTH_TOKEN`），保证子进程使用自己的登录。停止或打断时，Windows 上用 `taskkill /T /F` 结束整个进程树，否则 Claude 已启动的 PowerShell / Bash 工具命令会在停止后继续运行；其他系统和 `taskkill` 不可用时回退为普通结束。已知边界：Codex 0.163.0 的同类实测未复现，Antigravity CLI 未验证，超时与完成后清理路径未单独验证。 |
| Antigravity App | 显式 setup-sidecar 将 Sidecar 绑定到实际项目，核对其资源目录及 App 返回的项目 ID；均省略时使用 Outside of Project。使用 App 2.23 当前配置版本，升级后须复核兼容性。 |

cwd 是工作目录，不等于操作系统沙箱或权限提升。讨论材料在用户指定的 cwd，回答草稿只放任务中的 `draft_directory`；CLI 与凭据是显式的工具路径。路径和项目配置仅保存在本机，不进入公开事件。

本机服务将回答草稿放在 `<服务目录>/drafts/<运行目录摘要>/`，按运行目录隔离；任务文件、执行凭据、日志和 `runtime.sqlite3` 仍在原运行目录。旧房间配置无需改写，服务加载时为其计算同一草稿位置；已有草稿不自动搬迁。单独运行 `runner` 时默认使用与运行目录同级的 `<运行目录名>-drafts/`。草稿经 `--body-file` 提交后以网站记录为准，日志可能保留 CLI 输出；这里的目录分工不承诺讨论内容只存在网站，也不使凭据对所有 AI 工具不可读。

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
| `antigravity_cli` | `agy -p --output-format stream-json`，从 `init.conversation_id` 读取实际 ID；后续 `--conversation ID`，不使用 `--continue` | 保持指定 cwd；省略 cwd 时使用本场独立草稿目录。只在讨论服务新建的会话中执行：每位参与者一个独立原生讨论项目，续接复用该项目；不绑定外部已有会话 |

三种 CLI 适配器可选 `model`：分别作为 `codex -m`、`claude --model`、`agy --model` 的参数传入，留空使用各 CLI 的默认模型；可存入本机默认配置，也可在新建讨论时按实例从软件目录中选择。配置文件的模型名不能以 `-` 开头或含空格。可选 `effort` 设置思考档位：Codex 接受 low / medium / high / xhigh / max / ultra，以 `-c model_reasoning_effort="档位"` 传入；Claude 和 agy 接受 low / medium / high / xhigh / max，以 `--effort` 传入；网页按原生查询结果收窄到该模型实际支持的档位。agy 保留带档位模型名（如 `gemini-4-argon-high`），显式 `effort` 交由 CLI 处理覆盖；留空不传参数，不自动降低强度。App 适配器使用 App 内选择的模型与档位。

本机服务新启动的三种 CLI 子进程通过 `DISCUSS_ACCESS_FILE` 绑定本次私有凭据文件，任务不再要求 AI 在每条命令里复写完整路径。CLI 每次读文件，能取得随后绑定的真实会话 ID；不把 token 放入提示词、参数或环境变量。绑定仅作用于该子进程，不设置全局房间或身份。App 和首次交还已有会话的任务继续传实际文件路径；显式 `--access-file` 仍优先。软件的 cwd、权限、工具、推理和调用顺序不因该绑定改变。

进度看板的参与者姓名下显示本场已登记的模型与思考强度，不使用新建草稿或本机默认配置代替。由本机桥接的只读 `room-models` 返回 `adapter/model/effort`，按当前站点与房间匹配；本机页面和已授权连接的线上页面均可读取，不要求暂停或浏览器持有房间控制凭据，不返回路径、令牌或会话编号。CLI 未显式指定时显示“默认模型 / 默认强度”，agy 未覆盖时显示“模型默认强度”，App 和手动参与提示在原软件内设置；未连接本机、未登记或旧版服务不支持时显示未获取。它展示启动配置，不能证明软件最终采用的默认值，也不提供讨论中改模型的入口。

两种新适配器都不需要 `source_thread_id` 或 `ipc_directory`。实际 ID 在输出流到达时写入本机绑定和本次执行凭据，随后由接入程序在会话启动时直接 `execution enter`（`codex_cli`、`claude` 与 `antigravity_cli`，任务内容内联进提示词，省去模型读文件和进入的往返；其余适配器仍由 AI 自行进入），AI 通过讨论 CLI 保存业务结果；Codex CLI 输出 `turn.completed` 1.5 秒后若进程未退出即终止，避免同会话的下一次投递等待收尾；每个 CLI 进程最长运行 2 小时（环境变量 `CODISCUSS_CLI_MAX_MS` 以毫秒覆盖），超时即终止并按“未保存本次结果”暂停房间，避免进程挂起时租约被一直续期，房间设置的单次执行时限仍优先。设置环境变量 `CODISCUSS_TRACE=1` 启动接入程序时，每次执行才在任务目录写 `event-ID.trace.jsonl`（默认不写）（时间戳加阶段：`event_seen`、`blocked_by_running_process`、`reserve_*`、`permission_check_*`、`cli_spawned`、`enter_*`、Codex 的 `thread.started` / `turn.started` / 工具命令 / `turn.completed`、`kill_after_completed`、`cli_closed`），仅用于定位各阶段耗时，不含凭据；程序不把终端回答直接代发。Codex App / CLI 可通过上述暂停后配置修正保留原绑定切换；其他适配器或项目、会话变更仍须使用独立 `data_directory` 明确重新接入。此路径不承诺 CLI 会话自动出现在桌面 App 的项目列表。

开启 trace 后，`event_seen.event_created_at` 记录服务端事件创建时间，`t` 仍为本机记录该阶段的实际时间，两者分别用于核对事件创建后的等待和本机阶段耗时。

`codex_cli` 的 `exec resume` 需要取得该会话的写入权；已有聊天仍被 Codex App 或另一进程持有时，会报 `thread-store conflict / already has an active writer`，App 显示空闲也不代表已释放。重复重试或仅关闭窗口不能保证解除占用。需要沿用 App 原聊天时，暂停后在本场接入设置中切到 `codex`，由 `codex queue` 向原聊天交付；需要独立 CLI 时，使用未被占用的 CLI 会话或新建讨论时省略会话 ID。接入程序保留这一根因，不让后续模型列表刷新超时覆盖它，也不自动换会话或切换适配器。

### 单次执行权限

每次执行只开放本场讨论所需的最小权限，不使用全部放行或绕过审批参数。任务文件的 `cli` 为 `codiscuss`；Windows 下 Codex 与 agy 经 PowerShell 执行命令，npm 生成的 `codiscuss.ps1` 会被执行策略拒绝，因此改为 `codiscuss.cmd`，Claude 仍用 `codiscuss`。`subcommands` 列出唯一放行的网站子命令：`room`、`message`、`turn`、`state`、`floor`、`execution`、`health`、`schema`；`service`、`launch`、`run`、`api`、`setup`、`install`、`local` 不放行。提示词要求命令以该 `cli` 开头，不用 `python discuss.py`、`cd` 或管道。规则不含路径，重装或更换 Python 无需更新；子进程 PATH 中的 `codiscuss` 须指向本次安装，setup 的持久命令检查会核对。

项目文件权限 `project_access` 为 `read`（默认）或 `write`：启动文件顶层设本场值，`participants.NAME.project_access` 覆盖单个 AI，空字符串表示沿用本场值。它只随本次启动保存，不能存入本机默认配置；网页新建讨论在每张自动 CLI 卡片上设置该 AI 的项目文件权限，不再提供本场共享的权限选项；已建房间的“接入”页仍可设置本场值与单个 AI 覆盖。三种 CLI 都在用户指定的 cwd 启动；省略 cwd 时才使用独立草稿目录。agy 的权限全部由其独立讨论项目执行，见下文。App 适配器的写权限由 App 自身决定，任务文件始终写明本场要求。

| 适配器 | 本次追加 | 只读 / 可写差异 |
| --- | --- | --- |
| `claude` | `--add-dir` 运行、草稿与技能目录；每个子命令各一条 `Bash(codiscuss room *)` 与 `PowerShell(codiscuss room *)`，仅对独立草稿增加 `Edit(//<草稿目录>/**)`，再追加用户的 `allowed_tools` | 可写时再加 `Edit(//<项目目录>/**)`；不再对运行目录新增 Edit 放行，已有用户规则仍生效；Windows 路径按 `//c/...` 匹配 |
| `codex_cli` | 每次创建唯一名称的 permission profile，通过 `-c default_permissions=...` 与 `permissions.<名称>=...` 传入，`approval_policy="never"`；运行目录只读，独立草稿目录可写 | 无项目或项目只读时继承 `:read-only`，项目可写时继承 `:workspace`；维持原有广泛读取范围和本次联网能力，未启用域名过滤 |
| `antigravity_cli` | 始终使用独立 `--project UUID` 与 `--mode accept-edits`；项目规则允许讨论命令和草稿写入，禁止运行目录、技能目录、`~/.gemini` 写入及 MCP 工具调用；每次交付前检查全局设置 | `read` 为项目目录添加 `write_file(目录)` deny，`write` 改为 allow；运行数据禁写不随项目授权放开 |

agy 只用一套方法控制权限：

1. **只在本工具新建的会话中执行**：每位参与者对应一个独立原生讨论项目，权限只写在该项目里。外部已有会话（包括从当前 agy 对话发起主持、在启动配置中填写 `session_id`）会恢复其原项目，无法套用讨论项目权限，因此启动时即拒绝，交付时也再次拒绝。唯一例外是手动专家的托管：agy 在自己的会话里执行 `codiscuss` 时由 `ANTIGRAVITY_CONVERSATION_ID` 上报会话，用户注册后服务把它转为 `antigravity_cli` 并以 `--conversation ID` 续接，不加 `--project`，沿用该会话原项目和用户自己的 agy 权限（无讨论项目规则，也不检查全局放行）；无头模式下 shell 命令须已由用户的规则放行，例如 `command(regex:^codiscuss(\.cmd)? .*$)`，否则被拒绝。
2. **项目内规则**：allow 为受限的讨论命令规则与草稿目录写入（`write` 时加项目目录写入）；deny 为项目目录写入（`read` 时）、运行目录、技能目录、`~/.gemini` 写入与 `mcp(*)`。规则按目录前缀递归匹配，不使用 `/**`；Deny > Ask > Allow，因此草稿不得位于受保护目录中，冲突在交付前报告。
3. **交付前检查全局设置**：CLI 与共享全局 allow 中若有 `*`、`command(*)`、`unsandboxed(*)` 或 `unsandboxed_command(*)` 这类放行全部命令的规则，则拒绝交付，因为它会让 shell 绕过项目的文件规则。具体命令的放行和 `toolPermission` 不检查，属于用户自己的授权。未授权 shell 在非交互模式下被拒绝。
4. **不改用户全局设置**：本工具不向 agy 全局设置写入任何规则；`setup` 只移除早期版本记录在 `agy-permission.json` 中的全局规则（先备份到服务目录 `agy-settings.backup.json`），其他设置与用户规则不变。

原生工具权限不是操作系统沙箱；工具被拒绝时 agy 仍可能退出码为 0，验收以实际文件和网站结果为准。[原生权限文档](https://antigravity.google/docs/permissions?tab=cli)、[CLI 设置](https://antigravity.google/docs/settings?tab=cli)。

独立讨论项目保存在 `~/.gemini/config/projects/<UUID>.json`，运行目录的 `agy-project-<参与者摘要>.json` 保存项目与实际会话绑定。所选原项目及用户全局配置不被改写；新项目只沿用资源目录，不继承原项目的命令放行。项目名为 `CoDiscuss · 讨论标题 · 参与者`，便于在 Antigravity 项目列表中区分。会话继续使用时保留这两份记录，不将生成的讨论会话手动迁入其他项目；讨论收束或存档后仍保留，以便之后在同一会话中继续讨论。只有网站确认房间已被删除（`房间不存在`）时，接入程序才删除该房间建立的讨论项目与记录，不触碰用户自己的项目。缺失已登记的原生项目或会话绑定不匹配时拒绝交付。[项目权限继承](https://antigravity.google/docs/projects?tab=cli)。

Codex 要求 CLI 0.163.0 或更新版本，使用 permission profiles 和本地 `app-server config/read`。配置检查先核对初始化回执中的版本；不支持或无法识别的版本拒绝交付。每次交付前只启动本地配置检查进程，不创建会话、不调用模型；发现已加载的旧 `sandbox_mode` / `sandbox_workspace_write` 或新配置未被采用就拒绝交付，避免旧设置覆盖本次限制。报错后需更新不支持的 CLI 或移除冲突的旧配置；接入程序不自动改写用户全局设置。首次与续接使用同一组权限参数，配置检查进程也随暂停或停止清理。[Codex 权限配置](https://learn.chatgpt.com/docs/permissions)

2026-10-18 本机实测（本轮权限调整前）：Claude 主持、Codex 与 Gemini 专家完成一场最小讨论。Windows 的 Codex / agy 经 PowerShell 调用时优先执行 npm 生成的 `codiscuss.ps1`；Codex elevated 沙箱内即使当前用户为 RemoteSigned 也拒绝 `.ps1`，Codex 自行改用 `cmd.exe` 调用 `codiscuss.cmd` 后成功。`agy` 非交互模式下被拒绝的工具也可能伴随退出码 0，最终仍以网站业务保存为准。`agy` 显式使用 `--print-timeout 0`，由房间的单次执行时限和整场截止控制停止，避免额外的 CLI 默认时限提前截断。

结构化失败（Codex `turn.failed`、Antigravity 非 `SUCCESS` 结果）、非零退出码、缺少会话 ID 或成功结束事件均记录为失败；软件已启动后不自动重发。正常退出后若网站尚未保存本次结果，复查后暂停。agy 无人值守时遇到未放行的命令会自动拒绝并直接结束会话；接入程序记录被拒的命令，并写入暂停原因，任务提示也要求 agy 仅用 `run_command` 运行 codiscuss 子命令、浏览项目改用 `list_dir` 等工具。同一参与者兼任主持与专家时，主持保存安排后进程可能仍在退出；该参与者由本服务创建的进程全部退出前不交付下一次执行，避免续接同一会话时出现两个写入者。暂停或停止接入服务会终止本服务创建的 CLI 进程，保留会话绑定和本机日志。

2026-10-19 权限调整验证：Windows / Codex CLI 0.163.0 的本地配置检查采用了本次 profile；以原生 `sandbox`（`unelevated`）运行无模型的文件操作，确认项目 cwd 保持、中文文件可读、只读模式拒绝项目与运行目录写入、可写模式允许项目写入但仍拒绝运行目录写入，两种模式均可写草稿并访问本机 HTTP。此证据不覆盖 elevated 模式、其他平台或本轮调整后的真实模型讨论。

2026-10-19 agy 原生权限验证：Windows / agy 1.4.2 使用临时项目与合成数据调用真实模型，确认项目文件和运行凭据的文件写入命中原生 deny；MCP 写入工具被拒绝，测试 MCP 服务未收到 `tools/call`；未放行的 shell 写入被拒绝。通过最终 runner 入口新建会话完成项目读取、草稿写入及 `codiscuss.cmd --body-file` 的本机 HTTP 提交，同一会话续接后项目写入仍被 deny，原文件未变。随后实测 `project_access: write` 成功修改项目文件，同一可写会话仍无法修改运行凭据；没有改写用户原项目和全局权限设置。

同日完整业务验证：独立 Python 网站与临时数据库运行真实 `launch_discussion`、`DiscussionService` 和软件适配器，Claude Code 2.1.302 主持、agy 1.4.2 专家完成两轮讨论，保存 4 条观点与 1 条有原文引用的主持总结，房间正常收束。Gemini 首次进入后暂停，旧执行取消、实际 CLI 进程退出且没有新增回答；关闭并重新创建服务实例后沿用原会话继续。两位 AI 分别始终使用同一个会话，项目文件哈希不变，结束后所有记录到的 CLI 进程及测试网站均退出。此测试覆盖本机完整路径配置，不覆盖其他平台、版本或后台服务操作系统进程崩溃；后者的持久化恢复另由自动化测试覆盖。Windows 临时目录含 `ADMINI~1` 等短文件名时，Claude 会拒绝读取；本次改用完整用户目录后通过，短路径兼容性仍有限制。

同日本机网页验证：使用独立服务目录，经 `codiscuss local start` 启动实际网站及后台服务，在内置浏览器 1440 × 900 / 100% 视口点击“创建并启动讨论”，未指定项目目录。Claude Code 2.1.302 与 agy 1.4.2 各保存一条真实观点，Claude 引用两条原文保存总结，房间阶段与运行状态均为 `concluded`，AI 子进程全部退出。首次 agy 因认证等待 60 秒超时而触发暂停；直接运行原生 CLI 刷新已有登录凭据后，在网页重启原房间成功接续，未重复创建房间或发言。这证明本机网页启动与故障恢复，不代表登录状态始终有效或线上 HTTPS 链路已验收。

接口依据：[Codex 非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Antigravity CLI 非交互模式](https://antigravity.google/docs/cli/headless/)。2026-10-18 已核对本机 Codex CLI 0.163.0、Antigravity CLI 1.4.2 的版本与帮助参数；自动化测试使用临时 HTTP 服务和子进程替身验证启动、绑定、续接、错误和暂停，真实讨论与本轮调整的验证边界分别如上。

## 自由协作房间

执行结束后，Git 快照成功时即使没有变化也上报 `changes: []`，供报告卡显示“未观察到文件变化”；非 Git 目录或快照失败不伪造空报告。上报记录是工作区观察，可能包含其他并行进程写入；报告卡不归因修改者。服务重启导致未上报的历史记录仍显示“未提供自动改动检测”。

网页选择“自由协作”及自动接入后，启动器沿用浏览器生成的房间控制凭据和各成员凭证，保存到本机私有配置 `members` 并登记常驻服务，不启用讨论运行。私有配置带 `mode: "free"`，服务据此使用 `free_runner.mjs`。手动建房直接调用网站，不启动或要求本机服务；浏览器保存私有接入资料，按成员分别下载凭据文件。

`codiscuss launch room-member` 在运行中的自由房间邀请（`add`）或请回（`rejoin`）自动成员：先用房间控制凭据核对房主身份，在登记配置中写入成员的软件配置与新凭证，再通知网站；网页通过 `member_token` 提供其已保存的新凭证，结果不明时沿用同一凭证重试。网页邀请默认项目只读，显式选择可写后通过该成员的 `participants[name].project_access` 传递，不改变其他成员；重试保留最初选择。该命令也可为手动成员生成配置旁的 `manual-成员名.access.json`，回执只含文件路径；网页手动邀请和请回则直接在网站完成。常驻服务读取更新后的配置时逐个成员核对：新成员直接采用，已绑定会话的成员若项目、cwd 或接入方式变化，只阻止该成员并报告原因，不影响其他成员。

运行中的讨论同样可用 `room-member` 邀请或请回专家，但只接受由本机唤醒的成员（不接受 `access: manual`）。`participants[name].session_id` 指定已有会话时，成员标记为 `borrowed`，首次投递即续接该会话；网页仅对 Codex CLI / App 与 Claude 提供此项，agy 照旧拒绝。邀请前在本机核对会话确实存在（Codex 查 `CODEX_HOME/sessions`，Claude 查 `CLAUDE_CONFIG_DIR/projects`），填错时当场报错，不会让讨论在轮到它时暂停；Claude 会话只能在原目录续接，未指定项目时沿用原目录，项目目录不同则拒绝。Codex 会话若正被 App 持有，CLI 续接报 active writer，进度看板在暂停原因下提供“切换到 Codex App”，保存采用后可在弹窗内重启。常驻服务每轮检查成员视图：已注册（`registered_at` 非空）且带 `reported_session` 的手动 Claude 专家，`adopt_member_profile` 在本机配置登记其借用会话（会话须存在于 `CLAUDE_CONFIG_DIR/projects` 且 Claude 软件已配置），随后调用 `adopt` 把成员转为托管；任一步失败则保持手动并记录一次日志，同一会话 ID 不重试。讨论配置只新增参与者时常驻服务直接采用，讨论不暂停；已有参与者的项目、cwd 或身份变化仍须暂停后重新接入。

讨论房间同样登记一个 `FreeRoomRunner`（`DiscussionWithQuestions`）：只投递用户的直接提问（`ask`），任务文件说明“这不是发言安排，不领取发言权、不改变讨论进度”；与讨论执行互斥由网站保证。

每次检查读取 `inbox`：成员没有进行中的执行且有待投递消息时，先持久化本地 `client_id` 再领取执行，然后用原适配器续接该成员的绑定会话；任务文件列出执行编号、待处理消息和已读起点，凭据文件只含成员凭证。进程退出而网站未收到回答、软件报错或超过单次执行时限时报告失败；只有确认未送达才退回队列重试，最多 3 次。领取后、调用前中断的投递不自动重发。主持人的任务文件带 `role: "host"` 和每条请求的 `request_purposes`（`ask` / `route` / `handoff`），说明里写明如何用 `--to` 派活与何时结束。网站上执行被打断、成员离开或被移除后，只停止该成员的进程；不同成员各自投递，可以并行。成员配置了 cwd 且位于 Git 工作区时，执行前后各做一次快照，执行结束且进程退出后报告改动的文件，供网站提示可能冲突；服务重启会丢失尚未报告的快照。只能在网页创建自由房间，不支持对话入口。

### 智能调度（可选）

新建房间面板始终显示“智能调度”，可选供应商（TypeSafe Jev 的 `POST /v1/systemone`，或 OpenAI Decisions 的 `POST /v1/decisions`）、模型（预设 `jev-latest` / `gpt-6-luna`）并填写密钥。密钥经 `api-key` 保存到服务目录，绑定供应商官方根地址；密钥旁的闪电按钮调用 `scheduler-check`（`codiscuss launch scheduler-check`），向决策模型发一道是非题核对供应商、模型与密钥。启动请求只带 `scheduler: {provider, model, api_key_ref}`，`validate_config` 核对密钥存在后写入私有房间配置。只在本次由本机服务启动时可开启（自由房间至少有一位本机唤醒成员，讨论须勾选“创建后立即启动”），否则选项禁用并说明原因。目前只能在建房时开启，已建房间不能中途开启或关闭。

`runner/scheduler.mjs` 用中立的题目（`choice` 带选项，`predicate` 为是非题）组装两家的请求，并把答案统一为 `{choice, confidence, probabilities}` 或 `{probability}`。上下文是房间标题、目标与用户原文、最近 10 条消息（每条截断到 600 字）和待处理的那条用户消息。把握程度取所选项的概率（缺失时才用 `confidence`；Jev 的两项选择 `confidence` 明显低于该概率，实测概率 0.82 时只有 0.64），阈值 0.7。讨论中的判断（留言、下一位发言人、下一轮）另带当前焦点、主持简报（前 1200 字）、主持人最近的安排，下一位发言人还带本轮已发言/未发言名单，并多问一道是非题“是否有明确依据要求候选人发言”（简报分工或流程轮到、或被点名追问；仅“本轮还没发言”不算），低于 0.7 即交回主持人，因为主持人预排的安排用完可能是有意结束；选项描述写明各选项的适用条件，“交给主持人”只在偏离目标、卡住或候选都不合适时选。每次调用计时，毫秒数写入决策记录 detail 的 `duration_ms`，决策卡片显示“耗时”；主持人安排卡片的耗时为上一条回答到安排保存的间隔，两种卡片样式一致。请求 30 秒超时，错误只报 HTTP 状态，不含响应正文或密钥。

- **自由房间（推荐，用户决定）**：未点名的消息照常交给主持人，判断在后台进行，不阻塞本次检查和任何投递。每条 `route` 请求只判断一次，选项为各位本机唤醒的非主持成员（描述为软件与项目读写权限）和“交回主持人”；只有选中成员且 `confidence ≥ 0.7` 时，才用 `POST recommendations` 记录推荐。网页在消息旁显示“智能调度建议让 B 回答”与 60 秒倒计时，用户可选“打断主持人，改由它回答”或“主持人答完后再回答”（主持人已答完时直接请 B 回答），过期后提示消失。判断失败、超时或置信度不足时不显示推荐，行为与未开启相同。
- **讨论房间（有把握即执行）**：投递主持事件前先只读判断，置信度 ≥ 0.7 才执行，否则照常唤醒主持人：
  - **插话**：`held_since` 后恰有一条用户留言时判断。仅补充信息且有排队安排 → `turns/continue`；在问某位非主持专家 → 新计划先请该专家回应这条留言（问题引用原文 300 字），原排队安排按原顺序跟在后面（最多 10 项）；改变方向、多条留言或话题修改 → 主持人。仅补充但计划已结束时，按下一条处理。
  - **轮次衔接**：仅 `named_followup` 为 false、无排队、上一轮已完成时判断。继续 → 先请模型选出的专家（不是上一轮最后发言者），其余按房间专家顺序，统一使用 `peer_round_question`；第 1 轮后自动把阶段从 `initial` 改为 `discussing`。可收束、跑偏、重复或卡住 → 主持人。
  - **执行方式**：有把握时 runner 领取该主持事件，以 `smart-scheduler` 会话进入，用本次执行凭据以主持人身份领取发言权、改阶段、创建或继续安排；网站的发言权、上限与凭据校验照常生效。到限、阶段不在进行中或已有进行中安排时不判断。执行中任一写入失败，把同一事件交回主持人软件并标记已进入（任务说明与 API 主持都跳过 `execution enter`）。判断失败或置信度不足时，主持任务附 `scheduler_suggestions` 供参考。
  - **成员变化**：新邀请的专家由网站在入场事务中加入现有队列的末尾，当前执行与其余安排的相对顺序不变，runner 到它的安排生效时才交付；手动专家仍由原会话提交。暂离、移除、请回等需要重排的变化会作废排队安排（留下最近一次实际安排之后的 `skipped`）。本轮未完成且无排队时，runner 不调用模型，按原顺序补回仍在场专家的安排，再请本轮尚未发言的专家开场，不唤醒主持人。
  - 每次实际向决策模型提出的判断（含交回主持人）用控制凭据写入 `POST scheduler-decisions`，`after_message_id` 取最近一条已回答安排的回答，对话中显示为该发言卡片与下一张卡片之间的独立调度卡片（“智能调度：……”）。交回主持人时写明原因：建议收束或拿不准。没有向模型提问的情形（已到讨论上限、同时有多条留言、话题设置有修改、点名追问已开启、本轮只剩主持人或只剩手动接入的专家）直接交回主持人，不调用模型，也不记录调度卡片；主持人的开场任务同样不记录。本轮未完成且没有后续安排时（如点“跳过”后），先补回因成员变动作废的计划，否则由决策模型在本轮未发言、可自动唤醒的专家中选下一位（置信度 ≥ 0.7），拿不准或建议调整方向才交回主持人。无论开新一轮还是本轮继续，每次只安排一位，答完队列为空再判断下一位；队列里已有安排时直接接力，不判断。刚被用户“跳过”的专家本轮不再被选（除非没有别人）；从未发言的专家（如新邀请）使用开场提示词；手动接入的专家不在候选内，也不会被留言分流选中。
- 每次判断与结果写入 `service.log`；阈值 0.7（所有判断统一）未经实测校准，两家的置信度不可互相套用。面板提示：开启后房间标题与最近消息会发给所选供应商。
- 2026-10-23 用真实 Jev 密钥核对：`/v1/systemone` 的请求与答案格式与本模块一致；4 条自由房间分派全部合理（直接派出的置信度 0.91），3 条讨论建议中 2 条符合预期，单次 0.5–1.1 秒（首次连接约 5 秒）。该密钥的 `GET /v1/models` 只列出 `jev-latest` 与 `jev-preview`，没有可锁定的版本，默认仍用 `jev-latest`；Jev 升级可能改变判断结果。OpenAI Decisions 仅按文档实现，未用真实密钥调用。

普通成员的回应建议不会出现在待投递队列。房主转换后沿用同一请求和执行路径：任务文件的 `request_messages` 指向原成员回答，`chain_id` 属于这次用户确认；重复转换不会再次投递，手动与在线目标仍不进入自动投递。

Antigravity App 的 Sidecar 按房间用法校验任务：讨论读取对应事件，自由房间读取对应 `executions/ID` 并核对有效租约。自由执行的受理回执由服务核对并绑定真实会话，即使回答已快速完成也保留绑定；取消、过期或结果不明的投递不重新发送。本次使用替身 Sidecar 与临时服务验证，未重新调用真实 App。

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

`add` / `remove` / `list` 维护登记表，同一站点与房间只能登记一份配置；登记不启动讨论。常驻服务运行后，首次用 `codiscuss run view` 读取版本，再用 `codiscuss run start` 按所选上限明确启动，完整命令见 [首次启动房间](deployment.md#首次启动房间)；已暂停的自动讨论可在网页点“重启”。显式 `service start` 以无窗口方式启动后台服务，已有服务时直接复用。`stop` 请求服务退出：先暂停其中仍在运行的房间，再停止本服务创建的 CLI 子进程并释放锁，避免网站显示进行中却无人领取。`status` 显示服务是否在线及各房间最近一次检查结果（运行中、已暂停、等待启动、异常）。管理命令可加 `--json` 获取原始 JSON（状态值为 `running`/`paused`/`idle`/`error`）；原有 `npm run service -- COMMAND` 入口继续保留 JSON 输出。

登记更新通过服务目录中的 `registry-lock.sqlite3` 写事务互斥，最多等待 5 秒；获得锁后才重读并原子替换 `rooms.json`，避免多个网页 / CLI 进程同时登记或移除时互相覆盖。该数据库只用于锁，登记表格式保持不变；进程中断由 SQLite 释放锁，不要求手动清理过期锁文件。房间在网站上被删除后，服务遇到 404 时会再读一次该房间；网站确认“房间不存在”才撤销这条登记并记入 `service.log`，不再反复报错；其他 404（如接口地址不存在）只报告，不撤销。

并发 `service start` 复用取得服务锁的进程，只有创建者报告拥有该进程。启动器等待当前进程写出就绪回执，不能仅因 PID 存活或旧进程留下状态就报告成功。`service status` 的 `running` 表示进程存在，`ready` 表示当前进程已确认初始化；`local status` 只有网站和已就绪讨论服务同时存在时才报告整体运行。就绪不证明各房间已交付，更不证明 AI 已进入。

损坏或缺失的单个房间配置不阻塞其他房间登记；仍可读取站点和房间身份时，即使其软件配置失效，也继续拒绝同房间的第二份登记。原坏配置保留，由服务状态单独报告。网页的“网站已连接”只表示网站可访问；接入页按实际执行事件显示待接入、已交付、执行中、完成或失败，不把网站连接或运行已启用当作模型执行成功。

原有 `codiscuss start|status|stop|add|…` 和不带参数的 `codiscuss run` 保留为兼容别名。网站操作也统一使用 `codiscuss room …` / `message …` 等，需要 Python 3.10+；`codiscuss run start|pause|view` 只控制网站讨论，不管理本机服务进程，详见 [CLI 使用](cli.md)。

### 快捷方式、自启与数据目录

`codiscuss service shortcut` 在 Windows 桌面创建「AI CoDiscuss 讨论服务」快捷方式：双击即启动后台服务（已运行则复用），并用默认浏览器打开已登记的讨论网站。`codiscuss service autostart on|off` 在当前用户的启动文件夹添加或删除登录自启快捷方式，默认不开启。登记表、锁、`status.json` 与 `service.log` 位于用户目录的 `~/.codiscuss`（Windows 为 `%USERPROFILE%\.codiscuss`），不随 npm 包升级变化，可用 `DISCUSS_SERVICE_HOME` 改变。旧版本的 `%LOCALAPPDATA%/ai-codiscuss/service`（其他系统 `~/.local/state/ai-codiscuss/service`）在新目录不存在、且旧目录的讨论服务与本机网站都已停止时，由下一次命令整体移入新目录，并把 `rooms.json`、`launches/` 等 JSON 及已登记外部房间配置中指向旧目录的绝对路径改写为新路径，运行目录的草稿随之改名；旧服务仍在运行，或命令在会重定向 AppData 的 MSIX 应用内执行时，继续使用旧目录（须从普通终端完成迁移），执行 `codiscuss local stop`（独立服务另需 `service stop`）后再运行命令即可迁移。各房间的游标、收件箱与会话绑定仍在各自数据目录。

`service.log` 除房间状态变化外，还按房间记录全自动讨论的派发（事件、参与者、角色）、每次投递失败（次数、是否确认未送出）、执行失败原因和因运行代次变化被撤销的过期事件，用于排查“重启后原安排又回到暂停”。

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

`start` 要求 [0,1440] 分钟及完整参与配置；`--minutes` 可省略并采用网页保存的总时长，0 表示不限总时长，服务器仍取非零启动截止与话题截止的较早值。`watch` 仅恢复事件消费。运行暂停（含执行失败、到期）时程序继续等待，网页进度看板点「重启」后接着处理；不限总时长的运行重启后仍不限时长，停止、收束或切到手动才退出。每 2 秒查询、HTTP 超时 10 秒；已入队任务等待实际进入，不设置从投递起算的启动超时，也不因聊天忙碌而重发。设置了整场截止时，排队也受其约束。网站租约最多 120 秒、每 30 秒续租，单执行上限采用房间 `execution_minutes`，新建默认 0（不限），旧房间保留已有值；非零上限从 AI 实际进入执行起算，不限时仍须正常续租。空查询不调用 AI。控制终端中断先暂停，再停止本程序创建的 CLI 子进程；不结束桌面应用。

## 上限与收束

每次交付前核对 `room.limits`；达到轮次/时间上限时调用 `/limits`，再根据实际返回的运行状态处理。暂停不再唤醒 AI；收束则终止本程序的旧子进程，接收新代次的主持任务，由主持人依据已有内容总结。最终截止由网站拒绝迟到写入。手动房间的原生任务由主持技能检查，不由本程序接管。

已经进入收束后，普通轮询只读取状态，避免重复提交无变化的 `/limits`；最终时间到达仍执行到限暂停。

## 交付与故障恢复

接收事件和推进游标同事务；先保存交付状态再调用软件，重启不重发已受理或结果不明的请求。收件箱持久保存尝试次数、下次重试时间与软件回执，旧库打开时补齐字段，不清空既有工作。reserve 的 HTTP 回执丢失时先核对网站及原执行凭据，再继续尚未发生的软件调用。

只有确认软件尚未被调用的失败（如进程未能启动、App 连接尚未建立或 Sidecar 未就绪）才自动重试：首次失败后等 2 秒，再次失败后等 4 秒，最多尝试 3 次；重试复用原事件、执行令牌与任务正文。每次重试或报告失败前先查网站：已经进入则续租，业务已保存则完成，不重发。软件调用已发生后的非零退出、超时或创建回执丢失不能证明未送达，保留 `uncertain` 并继续核对网站业务状态及可用的 Sidecar 回执，受整场截止约束。Codex queue 的原始受理回执保存在本机；不能把缺少执行回执当成投递失败。3 次确认未送出、已启动的 CLI 进程报告失败或实际执行租约到期时按失败暂停。Claude 进程结束时立即判断：非零退出码，或输出里 `is_error` 为真（例如用量上限 429 时退出码仍为 0），都马上以原始错误暂停，不再等单次执行时限；新增独立 CLI 按上节的结构化事件核对。正常退出但网站上本次执行仍未完成时，先重新查看事件，确认仍未保存结果再以“会话已结束，但未保存本次结果”暂停。

数据目录固定站点、房间、运行及参与者项目/cwd 配置，修改后拒绝继续复用；需先暂停，明确重新接入。完成以网站业务记录为准，网页中的 dispatched、started、completed 分别表示交付、真实进入、业务保存；收束退出前核对本地最后一项状态。排障须核对原会话与对应事件，不能删库或换编号冒充重试。手动兜底由用户明确选择，通知程序不会自动降级。

### 失败提示与下一步

暂停原因直接展示给用户，所以文案要说明下一步，且“可稍后恢复”不等于“可以重放结果不明的任务”：

- API 的 HTTP 错误按状态分流（`api_status_message`）：401 / 403 提示核对密钥与模型权限，404 提示核对地址、请求协议和模型 ID，429 与 5xx 提示等待恢复后再试，并提醒先核对房间里是否已有本次内容；其他状态保持通用说明。网络超时与连接失败不区分“网络不通”和“地址有误”，两者都在提示里。执行内的模型请求遇到超时、连接失败、429、5xx 时自动重试最多 2 次（间隔 3 秒、6 秒），这类失败发生在房间写入之前；房间写入不重试。模型某轮只回纯文本、未调用工具时，先追加一次提醒让其重试，仍不调用才暂停。
- 进程退出但结果未保存（讨论为“会话已结束，但未保存本次结果”，自由房间为“未提交本次回答”）与自由房间的“超过单次执行时限”都附带“请核对原会话确认是否已有内容”。
- 不识别的软件原始错误保持原样，不猜额度恢复时间，不自动重发。

### 适配器能力与已知限制

各入口对“进入、成功、停止、结果不明”的含义不同，业务层不能把它们当作等价信号。成功只看网站是否保存了本次业务结果；会话 ID 出现、进程退出或受理回执都不等于完成。

| 入口 | “已进入”的依据 | 停止时 | 已验证范围 |
| --- | --- | --- | --- |
| Codex App、Antigravity App（Sidecar） | AI 自己执行 `execution enter`（自由房间无此步） | runner 没有进程可停，只能在服务端撤销执行，迟到回答被拒；自由房间的执行失联会显示“停止未确认” | 迟到回答被拒有测试 |
| `codex_cli`、`antigravity_cli` | runner 在会话 ID 首次上报时代为进入（`thread.started` / `init`），此时模型不一定已读到任务 | `child.kill()`，只结束直接子进程 | Codex 在 Windows 上 1 次实测未见工具进程残留；agy 未验证 |
| `claude` | runner 在进程启动成功后代为进入，此时模型不一定已读到任务 | Windows 用 `taskkill /T /F` 结束整个进程树，其他系统普通结束 | Windows 真实孙进程测试 |
| `api` | runner 在调用模型前自己进入 | 中止请求 | — |

所有入口：确认未送出才有界重试；已调用而送达未知时不自动重发，讨论房间记为 `uncertain` 并继续核对网站，自由房间直接按“投递失败”结束这次执行；进程正常退出但结果未保存时先核对网站，仍未保存则以失败收尾（讨论房间暂停，自由房间只影响该成员的这次执行）；已绑定会话的项目、cwd、接入方式或绑定 ID 变化时阻止并要求重新接入（模型与强度在进行中的讨论里只读）。

新增适配器上线前须过四项：停止后无工具进程残留（在真实进程上验证）、迟到回答被拒、重启后不重发、结果未保存时核对后以失败收尾。

# 接入与配置

本机服务（`runner/`）消费网站事件，在各 AI 的原会话中唤醒它，或调用你配置的模型 API。网站本身不启动模型，也不保存密钥。

## 支持的软件

| 软件 | 接入方式 | 说明 |
| --- | --- | --- |
| Claude Code CLI | 自动 | 按会话 ID `--resume` 续接 |
| Codex CLI | 自动 | `codex exec` 首次执行，`exec resume` 续接；需 0.163.0+ |
| Codex App | 自动 | 向运行中的 App 原聊天投递，App 须保持运行 |
| Antigravity CLI（`agy`） | 自动 | 只在讨论服务新建的会话中运行，每位参与者一个独立项目 |
| Antigravity App | 自动 | 经 App 管理的 Sidecar 接入 |
| Cursor CLI | 手动 | 安装技能后手动参与，暂无自动适配 |
| 模型 API | 自动 | 见 [API 接入](#api-接入) |

使用前须在对应软件中完成安装、登录与工具许可。自动 CLI 可在成员卡片背面选择模型与思考强度，App 与手动会话在原软件中设置。

## npm 安装与本机配置

需要 Node.js 24+、npm 与 Python 3.10+。

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` 检测本机 CLI，按你的选择保存软件配置、复制讨论技能，然后启动本机网站（`http://127.0.0.1:8765`）与讨论服务并打开浏览器。它只检查 CLI 能否启动，不检查账号登录或模型额度。也可以用 `npx --yes --package ai_co_discuss codiscuss install` 一步完成安装与配置。

| 选项 | 作用 |
| --- | --- |
| `--yes` | 非交互运行，默认选择检测到且支持自动接入的 CLI |
| `--clients codex,claude,antigravity,cursor` | 明确选择软件；`none` 只配置网站 |
| `--codex PATH` 等 | 指定软件的可执行文件路径 |
| `--no-start` / `--no-open` | 只配置，不启动 / 启动但不打开浏览器 |
| `--skills-home DIR` | 技能安装的用户根目录 |
| `--prefix DIR` | npm 安装前缀（仅 `install`） |

结果为 `ready` 表示网站与服务已就绪；`needs_attention`（退出码 2）表示有配置差异、技能冲突或命令不在 PATH，按提示处理后重跑 `setup`。就绪不代表 AI 已经执行过任务。

**升级**：先 `codiscuss local stop`，再运行 `npm install --global --prefer-online ai_co_discuss@latest` 和 `codiscuss setup`。已安装后不要用 `npx` 升级，它会运行已安装的旧版本。

**卸载**：先 `codiscuss local stop`，开启过登录自启的再运行 `codiscuss service autostart off`，最后 `npm uninstall --global ai_co_discuss`。数据库、私有配置与已复制的技能不会被删除。

**数据位置**：服务目录默认为 `~/.codiscuss`（Windows 为 `%USERPROFILE%\.codiscuss`），可用环境变量 `DISCUSS_SERVICE_HOME` 修改。网站数据库位于其中的 `local/discuss.sqlite3`；源码直接运行 `python server.py` 的数据位于仓库 `data/`，两者互不同步。

## 两种讨论入口与启动配置

房间可以从网页创建，也可以在 AI 对话中由主持技能发起，两者共用同一套配置：

- **本机软件默认配置**：每个平台的接入类型、可执行文件路径与可选工具许可，保存在服务目录的 `launch-settings.json`。
- **单场配置**：议题、成员与上限保存在房间；本次的软件覆盖、会话绑定、项目目录与凭据只保存在本机。

路径须填写完整的绝对路径。常用项目可在“项目目录”控件中保存为名称与路径，只保存在这台电脑上。

### 从网页发起

运行 `codiscuss local open` 打开本机网站，点击“新建房间”，添加成员并指定主持人后创建。本机网页可点文件夹图标在本机选择项目目录；Windows 目录选择窗口支持在地址栏输入或粘贴完整路径（`Ctrl+L`），也可逐级浏览文件夹。启动失败或响应丢失时，刷新页面会显示“继续未完成的启动”，沿用原请求重试，不会重复建房。

### 从 AI 对话发起

在要担任主持人的本地 AI 对话中调用 `discuss-host` 和 `discuss-participant`，告诉它站点、议题、参与者与上限。主持技能按 [首次启动指引](../.agents/skills/discuss-host/references/launch.md) 准备启动文件并执行：

```sh
codiscuss launch settings                              # 查看本机软件默认配置
codiscuss launch start --file 本次启动.json --dry-run  # 预览
codiscuss launch start --file 本次启动.json
```

| 字段 | 用途 |
| --- | --- |
| `site`、`entry` | 站点根地址；`conversation` 表示当前会话主持 |
| `current_session_id` | 当前实际会话 ID，`conversation` 入口必填 |
| `room` | 新房间的标题、目标、用户原文、主持人、成员、上限与新的 `submission_id` |
| `room_id`、`access_file` | 接入已有房间时使用，替代 `room` |
| `participants` | 仅本次覆盖本机软件配置 |
| `cwd`、`project_access` | 可选的项目目录与文件权限（`read` / `write`） |
| `minutes` | 本次运行时长，0 表示不限 |

当前会话继续主持，后续安排由本机服务交付。agy 不能从自己的对话主持全自动讨论，请改用其他软件主持或从网页发起。

### 线上网页连接本机

使用自己部署的线上网站时，在运行 AI 的同一台电脑上执行一次：

```sh
codiscuss local connect https://你的站点
```

命令启动本机服务并打开带连接信息的线上网页，首次连接需允许浏览器访问本机网络。之后线上网页可以读取本机软件配置并新建房间；房间保存在线上，AI 在这台电脑运行。软件路径与连接凭据由浏览器直接发给本机服务，不经过线上服务器。

连接链接带有本机启动权限，不要转发。撤销：

```sh
codiscuss local disconnect https://你的站点
```

撤销不会停止已运行的讨论。本机服务重启后，运行 `codiscuss local open` 并在网页“重新检查连接”即可恢复。

### 其他设备经已配对电脑建房

手机、平板等没有本机服务的设备，可以经一台已配对的电脑建房：

1. 在已 `connect` 的电脑浏览器中登录网站管理员账号，页面自动完成配对。
2. 在电脑上保存常用项目。
3. 在其他设备上登录同一管理员账号，新建房间时选择项目与成员。
4. 电脑上的服务领取请求，把项目编号换成本机路径后建房并唤醒 AI。

网站只保存电脑凭据的哈希、项目编号与名称，以及各平台的接入类型；项目路径、软件路径与密钥只留在电脑上。电脑离线时请求保留在待办中，上线后继续执行。

## API 接入

翻开成员卡片选择 API，核对 Base URL 与请求协议，填写并保存密钥，再选择或输入模型 ID。API 成员可以担任专家或主持人，与 CLI / App 成员混用。

| 供应商 | 默认 Base URL | 请求协议 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | Responses |
| Anthropic | `https://api.anthropic.com/v1` | Messages |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | generateContent |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| 阿里云百炼（Qwen） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Chat Completions |
| xAI（Grok） | `https://api.x.ai/v1` | Responses |

OpenRouter 等兼容服务填写其协议根地址（如 `https://openrouter.ai/api/v1`），选择 Chat Completions，并填写服务返回的完整模型 ID。卡片上的刷新按钮读取服务商的模型列表；闪电按钮发送一次极短的请求，核对地址、密钥、协议与工具调用支持。

- **密钥**：只保存在本机服务目录的 `api-keys/` 中，不进入网页、房间数据或日志；修改 Base URL 后需要重新填写对应的密钥。
- **能力边界**：API 成员只有房间读写工具，不访问本机文件、浏览器或任意网络地址；附件对它只显示名称与大小。
- **费用**：调用由本机服务发出，按所选账号计费。

## 智能调度（可选）

建房时在“智能调度”下选择供应商（TypeSafe Jev；OpenAI Decisions 为实验性），填写密钥，可用闪电按钮核对。密钥保存在本机服务目录。智能调度需要连接本机服务，目前只能在建房时开启。判断规则见 [使用指南](workflow.md#智能调度)。

## 单次执行权限

每次执行只开放本场所需的最小权限，不使用全部放行参数。AI 只能运行网站读写类的 `codiscuss` 子命令（`room`、`message`、`turn`、`state`、`execution` 等），不能运行 `service`、`launch`、`setup` 等管理命令。

项目文件权限按成员设置，默认只读：

| 软件 | 只读 | 可写 |
| --- | --- | --- |
| Claude Code | 只放行讨论命令与草稿目录写入 | 另放行项目目录写入 |
| Codex CLI | 原生沙箱的只读配置 | 原生沙箱的工作区写入配置 |
| agy | 独立项目中禁止写入项目目录 | 独立项目中允许写入项目目录 |
| App | 由 App 自身决定 | 由 App 自身决定 |

限制强度取决于各软件：Codex 使用原生沙箱；agy 依赖其项目权限规则并禁用 MCP，全局设置中存在放行全部命令的规则时会拒绝交付；Claude Code 中用户已有的授权仍然生效。原生工具权限不等于操作系统沙箱，以实际文件与网站结果为准。

## 常驻讨论服务

`codiscuss local open` 会自动启动讨论服务。单独管理服务时：

```sh
codiscuss service status          # 服务与各房间状态
codiscuss service start           # 后台启动
codiscuss service stop            # 暂停托管中的讨论并停止服务
codiscuss service autostart on    # 登录时自动启动（Windows）
codiscuss service shortcut        # 创建桌面快捷方式（Windows）
```

一个服务进程托管所有已登记的房间，单个房间出错不影响其他房间。停止服务会暂停它托管的活动讨论，数据库保留。日志位于服务目录的 `service.log` 与 `local/` 下。

## 已启动后的配置修正

软件启动失败时，先在进度看板查看暂停原因，登录与权限问题在对应软件中处理。仍保留当前发言安排时，“跳过”取消本次发言并继续讨论，“重启”重试原安排。

本机网页中，Codex 可从进度看板成员旁的“…”菜单“切换 App / CLI”；软件路径在“接入 → 修正本场软件连接”修改。修正只影响本场，保留原会话与讨论进度，确认采用后需在进度看板手动重启。

## 常见问题

- **Codex 报 `already has an active writer`**：原聊天仍被 Codex App 或另一进程占用。暂停后切换到 Codex App 接入，或使用未被占用的会话。
- **Windows 报告两处数据路径（MSIX 文件虚拟化）**：Claude 桌面版等 MSIX 应用会重定向 AppData 写入。从普通终端管理服务，或统一设置 AppData 之外的 `DISCUSS_SERVICE_HOME`。
- **agy 命令被拒绝**：无人值守时未放行的命令会被自动拒绝，暂停原因中会列出被拒的命令。
- **Claude 用量上限**：进程报错（包括 429）时立即以原始错误暂停，等待额度恢复后重启。
- **端口被占用**：服务不会接管占用者，改用其他端口并同步实际站点地址。
- **结果不明**：已交付但无法确认是否送达的任务不会自动重发；先在原会话与房间中核对是否已有内容，再重启。

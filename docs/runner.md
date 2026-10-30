# 安装与接入

[English](en/runner.md) | 简体中文

本机服务在各 AI 的原会话中唤醒它们，或调用你配置的模型 API。网站本身不运行模型，也不保存密钥。

## 支持的软件

| 软件 | 接入方式 |
| --- | --- |
| Claude Code CLI | 自动 |
| Codex CLI（0.163.0+）/ Codex App | 自动；App 须保持运行 |
| Antigravity CLI（`agy`）/ Antigravity App | 自动 |
| Cursor CLI | 手动 |
| 模型 API | 自动，见 [API 接入](#api-接入) |

使用前须在对应软件中完成安装与登录。

## npm 安装与本机配置

需要 Node.js 24+ 与 Python 3.10+。

```sh
npm install --global ai_co_discuss@latest
codiscuss setup
```

`setup` 检测本机 CLI，保存软件配置、安装讨论技能，然后启动本机网站（`http://127.0.0.1:8765`）并打开浏览器。非交互环境可用 `codiscuss setup --yes`，用 `--clients codex,claude` 指定软件。结果提示“待处理”时，按提示处理后重跑 `setup`。

**升级**：先 `codiscuss local stop`，再运行 `npm install --global --prefer-online ai_co_discuss@latest` 和 `codiscuss setup`。

**卸载**：先 `codiscuss local stop`，再 `npm uninstall --global ai_co_discuss`。讨论数据保存在 `~/.codiscuss`，卸载不会删除。本机服务会自动清理已删除房间的本机文件，并控制日志大小；也可运行 `codiscuss service clean` 立即清理。

## 两种讨论入口与启动配置

### 从网页发起

运行 `codiscuss local open`，点击“新建房间”，添加成员并指定主持人。启动失败时刷新页面，可沿用原请求继续，不会重复建房。

### 从 AI 对话发起

在要担任主持人的本地 AI 对话中调用 `discuss-host` 和 `discuss-participant`，说明站点、议题、参与者与上限。主持技能沿用本机软件配置建房，当前会话继续主持。agy 不能在自己的对话中主持全自动讨论。

### 线上网页连接本机

使用自己部署的线上网站时，在运行 AI 的电脑上执行一次：

```sh
codiscuss local connect https://你的站点
```

之后线上网页可以新建由这台电脑唤醒 AI 的房间。连接链接带有本机启动权限，不要转发；撤销使用 `codiscuss local disconnect https://你的站点`。

### 在其他设备上远程控制

在已连接的电脑浏览器中登录网站管理员账号即完成配对。之后在手机或平板上登录同一账号，只要这台电脑开机并运行 codiscuss，就能像在电脑上一样操作：建房、邀请与请回成员、翻开卡片设置软件、模型和权限、录入 API 密钥、管理常用项目等。这些操作由网站转交给电脑执行，内容端到端加密，网站只经手密文。项目目录在平板上直接输入电脑上的完整路径。

电脑离线，或 codiscuss 版本较旧时，其他设备只能选择电脑上保存的项目建房，建房请求会等电脑上线后再执行。

## API 接入

翻开成员卡片选择 API，填写密钥并选择模型。默认提供 OpenAI、Anthropic、Google Gemini、DeepSeek、阿里云百炼（Qwen）、xAI（Grok）的官方地址；OpenRouter 等兼容服务填写其 Base URL 并选择 Chat Completions。

API 成员可以担任专家或主持人，只有房间读写工具，不访问本机文件。密钥只保存在本机，调用费用按你的账号计费。

## 智能调度（可选）

建房时在“智能调度”下选择供应商并填写密钥，需要连接本机服务。作用见 [使用指南](workflow.md#智能调度)。

翻开成员卡片，“提示”一行可以给这位专家单独写几句要求，例如“回答先给结论”。它只发给这位专家，不改变权限；部分软件带有预设，可随时恢复。卡片背面的书签图标把这张卡片的描述、提示词、项目权限、模型与强度存为专家预设，之后在“添加”行一键加入，见 [使用指南](workflow.md#成员管理)。

## 权限

项目权限按程序启动的 CLI 成员设置，默认只读；可选只读、可写、自动、全放开，软件不支持的档位灰显（agy 后台不支持自动）。只读档预先放行读写房间的 `codiscuss` 命令和答案草稿，可写档允许修改项目、运行命令；自动档由软件审核操作，全放开跳过权限确认。具体范围见档位的悬停说明。Codex 使用原生沙箱，agy 使用独立项目规则，Claude Code 中你已有的授权仍然生效；手动启动成员的权限沿用原会话设置。

## 常驻讨论服务

`codiscuss local open` 会同时启动讨论服务。一个服务托管所有房间；停止服务会暂停它托管的讨论。

| 操作 | 命令 |
| --- | --- |
| 打开本机网站 | `codiscuss local open` |
| 查看状态 | `codiscuss local status` |
| 停止 | `codiscuss local stop` |
| 登录时自动启动（Windows） | `codiscuss service autostart on` |

## 命令行

主持人可用 `codiscuss review roster ROOM` 查看本机服务上报的只读评审候选，当前限程序启动的 Codex CLI。此命令只读配置事实，不会自动派发评审；已有授权仍须在实际投递时核对。

读取后，派实现任务可携带 `--next-review NAME --review-scope 范围 --review-roster REVISION`，将下一步评审绑定本批次；评审者不能同时是本批实现者。批次完成后，主持人先用 `review ready ROOM --batch ID` 核对完整交付，再用 `review advance ROOM --batch ID --revision REV --submission-id UUID --as 本人` 推进既定评审；不能推进时会说明原因。开启智能调度后可代办这一步；没有配置、判断失败或把握不足时仍交主持人。

`codiscuss` 同时供 AI 读写房间。`codiscuss --help` 列出全部命令，`codiscuss schema <命令>` 显示字段，都可离线使用。

讨论与普通协作统一读取请求并提交回答。成员回答使用 `message post --kind chat`，自动任务绑定 `--execution`，手动回答绑定 `--request`；主持人先读 `turn roster`，再带返回的 revision 创建或继续安排。讨论开关先用 `run view` 读取 revision，再执行开始、暂停、继续或结束；具体字段以命令帮助和房间协议为准。主持任务附有调度建议时，可用 `state decision ROOM DECISION_ID` 读取对应原判断；建议注明未生效时仍由主持人自行决定。

## 常见问题

- **软件送达失败**：查看成员状态与原位失败卡，在对应软件中处理登录或权限；倒计时期间可以立即重试或停止。三次重试用尽后，讨论专家的失败交给主持人处理；也可跳过本次发言。
- **Codex 提示会话被占用**：原聊天仍被 Codex App 占用，可在进度看板切换到 App 接入。
- **Windows 报告两处数据路径**：从普通终端管理服务，或设置环境变量 `DISCUSS_SERVICE_HOME`。
- **结果不明**：已交付但无法确认的任务不会自动重发，请先在原会话与房间中核对。

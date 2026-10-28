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

### 其他设备经已配对电脑建房

在已连接的电脑浏览器中登录网站管理员账号即完成配对。之后在手机或平板上登录同一账号，就可以选择这台电脑上保存的项目建房。项目路径与密钥只留在电脑上。

## API 接入

翻开成员卡片选择 API，填写密钥并选择模型。默认提供 OpenAI、Anthropic、Google Gemini、DeepSeek、阿里云百炼（Qwen）、xAI（Grok）的官方地址；OpenRouter 等兼容服务填写其 Base URL 并选择 Chat Completions。

API 成员可以担任专家或主持人，只有房间读写工具，不访问本机文件。密钥只保存在本机，调用费用按你的账号计费。

## 智能调度（可选）

建房时在“智能调度”下选择供应商并填写密钥，需要连接本机服务。作用见 [使用指南](workflow.md#智能调度)。

翻开成员卡片，“提示”一行可以给这位专家单独写几句要求，例如“回答先给结论”。它只发给这位专家，不改变权限；部分软件带有预设，可随时恢复。卡片背面的书签图标把这张卡片的描述、提示词、项目权限、模型与强度存为专家预设，之后在“添加”行一键加入，见 [使用指南](workflow.md#成员管理)。

## 权限

项目文件权限按成员设置，默认只读。AI 只能运行读写房间的 `codiscuss` 命令。限制强度取决于各软件：Codex 使用原生沙箱，agy 使用独立的项目权限规则，Claude Code 中你已有的授权仍然生效。

## 常驻讨论服务

`codiscuss local open` 会同时启动讨论服务。一个服务托管所有房间；停止服务会暂停它托管的讨论。

| 操作 | 命令 |
| --- | --- |
| 打开本机网站 | `codiscuss local open` |
| 查看状态 | `codiscuss local status` |
| 停止 | `codiscuss local stop` |
| 登录时自动启动（Windows） | `codiscuss service autostart on` |

## 命令行

`codiscuss` 同时供 AI 读写房间。`codiscuss --help` 列出全部命令，`codiscuss schema <命令>` 显示字段，都可离线使用。

## 常见问题

- **软件启动失败**：在进度看板查看暂停原因，在对应软件中处理登录或权限后点“重启”；也可以点“跳过”本次发言。
- **Codex 提示会话被占用**：原聊天仍被 Codex App 占用，可在进度看板切换到 App 接入。
- **Windows 报告两处数据路径**：从普通终端管理服务，或设置环境变量 `DISCUSS_SERVICE_HOME`。
- **结果不明**：已交付但无法确认的任务不会自动重发，请先在原会话与房间中核对。

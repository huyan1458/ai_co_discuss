# 命令行

按日常使用场景汇总给人用的 `codiscuss` 命令。AI 成员读写房间用的命令由随包技能负责。

## 按场景查找命令

### 安装、配置与升级

| 你想做什么 | 命令 |
| --- | --- |
| 首次安装软件包 | `npm install --global ai_co_discuss@latest` |
| 检测本机 AI 软件、装技能并打开本机网站 | `codiscuss setup` |
| 非交互安装（指定软件） | `codiscuss setup --yes --clients codex,claude` |
| 安装或补装全部随包工作流（覆盖同名前先备份） | `codiscuss setup --workflows` |
| 开启或关闭托管管理 | `codiscuss setup --hosting` / `codiscuss setup --no-hosting` |
| Windows 生成或重新生成“共议”桌面快捷方式 | `codiscuss launcher` |
| 升级到最新版（推荐：经管理面板或 `admin`） | `codiscuss admin update`（只检查更新加 `check`） |
| 手动升级 | 先 `codiscuss panel stop` 和 `codiscuss local stop`，再 `npm install --global --prefer-online ai_co_discuss@latest` 和 `codiscuss setup` |
| 卸载软件包（保留 `~/.codiscuss` 数据） | 先 `codiscuss local stop`，再 `npm uninstall --global ai_co_discuss` |

### 本机站点与本机服务

本机网站保存房间并提供网页；讨论服务是本机负责唤醒 AI、投递任务和收取回答的后台程序。`codiscuss local` 管理网站及其配套服务，`codiscuss service` 单独管理讨论服务。

| 你想做什么 | 命令 |
| --- | --- |
| 启动并打开（或复用）本机网站 | `codiscuss local open` |
| 查看本机网站与服务状态 | `codiscuss local status` |
| 停止本机网站及其管理的服务 | `codiscuss local stop` |
| 查看或重启讨论服务 | `codiscuss service status` / `codiscuss service restart` |
| 重启本机网站和讨论服务（管理面板运行时） | `codiscuss admin service restart` |
| 立即清理已删除房间的本机文件与旧日志 | `codiscuss service clean` |
| 开启 Windows 登录时自动启动 | `codiscuss service autostart on` |
| 打开或停止本机管理面板 | `codiscuss panel` / `codiscuss panel stop` |

### 线上站点与外部成员

| 你想做什么 | 命令 |
| --- | --- |
| 将本机绑定到自己部署的线上站点 | `codiscuss local connect https://你的站点` |
| 在部署网站的电脑上生成一次性绑定令牌 | `codiscuss token` |
| 解绑线上站点 | `codiscuss local disconnect https://你的站点` |
| 借出本机 AI 加入别人电脑的房间 | `codiscuss join <邀请链接> --adapter <软件> --duration 1h`（时长也可填 `today` 或 `3d`） |
| 查看或管理已加入的外部房间 | `codiscuss invited list` / `room <ID>` / `lend <ID> 1h\|today\|3d` / `pause <ID>` / `resume <ID>` / `leave <ID>` / `remove <ID>` |

### 诊断与健康检查

| 你想做什么 | 命令 |
| --- | --- |
| 检查本机或线上站点是否正常响应 | `codiscuss health --site http://127.0.0.1:8765` |
| 查看房间事件记录（排查卡片状态或未唤醒原因） | `codiscuss room events <房间ID>` |
| 检查管理面板与全部服务状态 | `codiscuss admin status --full` |

### 备份、导出与导入

房间的 ZIP 导出与导入在网页端完成（见[房间目录与建房](rooms.md#5-导出导入与分支房间)）：房间菜单 → “导出对话”、目录选项 → “导出全部房间”和“导入房间”。独立部署 Python 服务时，停止写入后直接备份 SQLite 数据库与同级 `<数据库文件名>.attachments/` 目录（见[部署指南](../deployment.md#python-服务)）。

### 远程 / SSH 本机管理

管理面板的启停、更新、绑定线上站点、托管账号、CLI 登录、API 密钥和技能管理都可以通过 `codiscuss admin <子命令>` 完成，常用命令表见[管理面板与托管账号](admin.md#经-ssh-用命令行管理codiscuss-admin)。

## 如何查询完整帮助

| 命令 | 查什么 |
| --- | --- |
| `codiscuss --help` | 列出主要命令入口；在任一子命令后加 `--help`（如 `codiscuss service --help`）查看该组用法 |
| `codiscuss schema [命令]` | 离线查看站点读写命令清单；加命令名（如 `codiscuss schema message post`）查看完整字段 |
| `codiscuss admin --help` | 查看全部本机管理与托管账号命令 |

## 切换命令行语言

命令行提示默认跟随系统区域（中文区域显示中文，其余显示英文）。可设置环境变量 `CODISCUSS_LANG` 覆盖：

- PowerShell：`$env:CODISCUSS_LANG="en"` 或 `$env:CODISCUSS_LANG="zh-CN"`
- macOS / Linux：`CODISCUSS_LANG=en codiscuss --help`

## 要注意什么

- **不要裸跑 `codiscuss`**：不带任何子命令直接运行 `codiscuss` 会在当前终端前台启动服务；平时打开网页请用 `codiscuss local open`。
- **环境变量生效**：修改系统环境变量（如代理、密钥路径）后，从能读取新值的终端重启相应进程；只重启讨论服务时，可运行 `codiscuss service restart`。

# 管理面板与托管账号

通过本机管理面板（或对应 `codiscuss admin` 命令）启停和更新共议（AI CoDiscuss）服务、管理各 AI 软件登录与密钥，还可以给家人或同事开设托管账号共用这台电脑上的 AI。

## 管理面板怎么打开，各页有什么用

- **怎么打开（Windows）**：在终端运行 `codiscuss setup` 时勾选“创建‘共议’快捷方式”（或之后运行 `codiscuss launcher`），双击桌面“共议”快捷方式启动后，任务栏右下角会出现共议图标（首次使用请在 Windows“设置 → 个性化 → 任务栏 → 其他系统托盘图标”里打开“共议”使其常驻）。左键点击托盘图标打开管理面板（或在终端运行 `codiscuss panel`），右键可打开网站、重启或关闭服务。面板只允许在本机打开。
- **“概览”页**：
  - **本机**：查看“共议服务”运行状态，点启动、重启、停止或“打开网站”；开启托管管理后还显示供隔离账号使用的“程序副本”。
  - **管理员入口 / 线上网站**：查看本地网页和已绑定的线上网站地址，可“绑定”、“解绑”或“生成接入码”。
    “线上网站”和 `codiscuss admin status` 均在收到本次连接的心跳回应后显示“中转已连接”，遇到断线、重连或连续 HTTP 请求失败会说明原因，服务停止或记录过期时显示“状态未知”。中转连续 3 分钟未获心跳确认时，服务会重建该网站的连接。也可以点“立即重连”或运行 `codiscuss admin site reconnect`。
  - **托管账号入口**（开启托管管理后显示）：启停“登录入口”，开关“经线上网站中转”或配置“自有域名”（Cloudflare Tunnel）。
  - **设置**：查看当前版本、“检查更新”与“更新并重启”（同步更新房间技能和隔离账号）、开关“登录 Windows 时自动启动”，以及切换管理面板语言。
- **“账号”页**：
  - 左侧默认有“管理员（本机账号）”，开启托管管理后下方列出所有“托管账号”和“新建账号”按钮。
  - 选中“管理员”或某个托管账号，可统一管理它的**命令行登录**（Claude Code / Codex / Gemini 登录状态、切换登录方式或退出，Claude Code 推荐 Setup Token）、**API 密钥**、**技能**（从“技能库”勾选安装或拖入 `.zip`/文件夹导入）、**随包工作流**与**系统提示词**。程序更新不会改动已装的工作流；工作流区右上角常驻“检查”和“同步到最新版”：“检查”对比随包版本，列出缺少的和与最新版不同的；“同步到最新版”补装缺少的、用最新版替换不同的（被替换的旧版先备份到该账号服务目录的 `backups/workflows`，在这里做过的修改也会被替换），都一致时按钮变灰。

## 托管账号：给别人开账号用这台电脑上的 AI

Windows 可以从托盘打开面板。macOS 和 Linux 的命令行入口见下文。

一般自用不需要打开托管管理。想让家人、同事通过外网浏览器登录并使用你电脑上的 AI 时，再开启它：

### 怎么操作

1. **开启托管管理**：运行 `codiscuss setup --hosting`（或在 `codiscuss setup` 的“安装配置”里勾选“托管管理”；关闭用 `--no-hosting`，选择会记住）。
2. **新建账号并隔离**：在管理面板 → “账号” → 点“新建账号”，填写账号名，在 Windows 上默认勾选**隔离**（为该账号创建一个独立的 Windows 用户，电脑会弹出一次管理员确认）。向导会一次装好它的程序副本、房间技能、系统提示词和随包工作流并启动它的网站实例，最后**仅显示一次密码**，记得保存发给对方。
   - **为什么要隔离**：未隔离的托管账号会以你的 Windows 身份运行，其 AI 能读到你的个人文件，且与管理员共用登录和技能；隔离后使用独立的 Windows 用户、登录与目录。
   - **入口保护**：在托管账号详情页默认开启“入口保护”（仅支持 Windows），开启后只有经登录入口验证的使用者和它自己的 AI 能访问该实例网站，防止本机其他程序直接访问。
3. **配置外网入口（二选一或同时开启）**：
   - **经线上网站中转（无需自有域名）**：先按[部署指南](../deployment.md#托管账号的入口可选)部署好入口 Worker；在部署电脑的“概览 → 本机 → 线上网站”生成接入码后，在这台电脑的管理面板“概览 → 线上网站”绑定并打开“托管账号入口”里的“经线上网站中转”（命令行一步完成：`codiscuss admin entry join <接入码>`）。
   - **自有域名**：在“托管账号入口 → 自有域名”点配置，按提示授权 Cloudflare 隧道并绑定托管在 Cloudflare 上的域名（命令行 `codiscuss admin entry tunnel <域名>`）。
4. **管理账号**：在托管账号页面可以启动/停止实例、停用/启用账号、重设密码、删除账号、配置由管理员提供的 API 密钥（对方界面只显示“管理员提供”，无法查看或更换），并复制登录地址与账号发给对方。邀请外部专家需要该实例具备可用的线上中转入口。面板每分钟检查已要求运行的实例，端口拒绝连接时自动重启，10 分钟内最多 3 次。达到上限仍失败时，账号行显示最后原因，`codiscuss admin status` 可查最近一次尝试。修好原因后手动启动可恢复巡检。

### macOS 和 Linux 能不能用？

- **macOS 和 Linux 有面板后台和非隔离账号的代码路径。** `codiscuss panel open` 的窗口启动器依赖 Windows PowerShell、Edge 或 `rundll32`。在其他系统上可先运行 `codiscuss panel start` 启动后台，再用 `codiscuss admin account add <名> --no-isolate`。实例使用运行服务的系统用户身份，账号之间没有操作系统级文件隔离。macOS 和 Linux 上托管账号从创建到外网登录的整套流程仍待实机验证。独立 Windows 用户、入口保护、托盘图标和登录 Windows 时自启属于 Windows 功能。

## 经 SSH 用命令行管理（`codiscuss admin`）

下表各子命令都以 `codiscuss admin` 开头，结果以 JSON 返回，适合经 SSH 远程管理电脑。只有本机管理员可用。

| 场景 | 常用命令 |
| --- | --- |
| 启动、退出、重启、更新（**无需面板已运行**） | `codiscuss admin start` / `stop` / `restart` / `update [check]` |
| 查看状态、启停服务、开机自启 | `codiscuss admin status [--full]`、`service start\|stop\|restart`、`autostart on\|off` |
| 绑定/解绑线上网站、生成接入码 | `codiscuss admin site status`、`site connect <接入码\|站点>`、`site disconnect`、`entry code` |
| 托管入口与隧道 | `codiscuss admin entry start\|stop`、`entry join <接入码>`、`entry open\|close relay\|tunnel`、`entry tunnel <域名>` |
| 托管账号生命周期 | `codiscuss admin account list`、`account add <名>`、`account start\|stop\|disable\|enable\|remove\|password <名>`、`account isolate\|protect <名>` |
| 登录、密钥、技能与提示词 | `codiscuss admin login status <对象>`、`key add <对象> --base-url … --key …`、`skill install <对象> <技能>`、`workflow install <对象>`、`workflow update <对象>`、`prompt set <对象> --file …` |

注：`<对象>` 填 `owner` 代表管理员自己，填托管账号名代表对应托管账号。`account add` 中途失败时，解决问题后重跑同一命令会自动从缺少的步骤续做。

## 要注意什么

- **`admin stop` 不停托管实例**：`codiscuss admin stop` 会彻底退出面板、托盘图标、登录入口、隧道和管理员共议服务，但已启动的托管账号实例照常运行；要停某个托管实例用 `codiscuss admin account stop <名>`。
- **管理员权限提示**：经命令行创建或删除隔离 Windows 用户时，在管理员终端或管理员 SSH 会话里直接执行；非管理员终端会在电脑桌面上弹出 UAC 确认框。
- **面板专有项**：已有托管账号 AI 环境的“重新初始化”与切换管理面板界面语言目前仅在面板界面操作。
- **外网托管流量的边界**：托管账号经线上网站中转或自有域名隧道访问时，登录与会话保护都在你电脑上，但往来流量会经过 Cloudflare（计入 Workers 免费额度）。

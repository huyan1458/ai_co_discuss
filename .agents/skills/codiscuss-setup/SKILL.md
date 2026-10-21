---
name: codiscuss-setup
description: "AI CoDiscuss 源码仓库的安装与运维技能：在已克隆的仓库中完成本机安装、配置、升级与故障诊断，并可按用户确认部署自己的 Cloudflare 在线网站。仅在本仓库内使用；npm 安装包用户使用 codiscuss install。不启动真实讨论。"
---

# 安装与配置（codiscuss-setup）

在用户已克隆的 AI CoDiscuss 仓库中，代替用户走完源码安装、配置、升级、诊断和可选的在线部署。确定性步骤交给仓库已有命令（`codiscuss setup`、`local`、`npm run deploy`），本技能负责检查前提、解读结果、处理待处理项和在关键操作前取得确认；不在对话中重写安装器逻辑。

## 边界

- 只在本仓库根目录工作；先确认当前目录含 `package.json`（`name` 为 `ai_co_discuss`）与 `runner/codiscuss.mjs`。不在仓库外克隆或安装另一份。
- 不安装、登录或升级 Node.js、Python 和 AI CLI，不修改它们的全局设置、系统 PATH 或执行策略；缺失时说明所需版本和官方获取途径，由用户处理后继续。
- 不创建房间、启动讨论或建立定时任务；安装就绪不代表真实 AI 已执行过任务。
- 不提交、推送 Git，不把令牌、私有配置、数据库或本机路径写入可提交文件。私有部署配置只放在已忽略的 `.wrangler/deploy/`。
- 停止进程只用 `codiscuss local stop` / `service stop`；端口被占用时报告占用者并改用其他端口，不结束未确认归属的进程。
- 以下操作每次执行前在对话中说明影响并等用户明确同意：覆盖或移走已有技能副本与配置、`git pull` 等改动工作区的操作、创建或写入任何 Cloudflare 远端资源、发布网站。

## 确定任务

从请求判断属于哪一类，信息已足够就直接进行，只询问缺项：

| 任务 | 进入 |
| --- | --- |
| 首次在本机安装 | 前提检查 → 首次安装 |
| 已安装，更新到仓库最新代码 | 前提检查 → 升级 |
| `setup` 报待处理、网站打不开、服务异常 | 诊断 |
| 卸载本机安装 | 卸载 |
| 部署自己的在线网站，或更新已部署的站点 | 读取 [references/deploy.md](references/deploy.md) |
| 让已有在线网站启动本机 AI | 本机安装就绪后按 deploy.md“连接本机” |

## 前提检查

依次运行并记录实际版本：`git --version`、`node --version`（需 24+）、`npm --version`、Python（Windows 先试 `python --version`，再试 `py -3 --version`；其他系统 `python3 --version`，需 3.10+）。

只需手动接入、不用全自动讨论时，Python 即可运行网站；全自动接入与 `codiscuss` 命令需要 Node.js 24+。AI CLI 由 `setup` 检测，这里不逐个探测。告诉用户：所选 CLI 需事先登录，安装器只检查能否启动，不检查账号。

## 首次安装

1. 询问要配置的软件（`claude`、`codex`、`antigravity`、`cursor`，或 `none` 只配网站）；用户未指定时采用安装器默认：检测到且支持自动接入的 CLI。
2. 依次运行：

   ```text
   npm ci
   npm link
   codiscuss setup --clients <选择> --json
   ```

   AI 运行的终端不是交互终端，必须带 `--clients` 或 `--yes`；`--json` 使结果写到 stdout。需要指定软件或 Python 路径、端口时，按 `codiscuss setup --help` 添加 `--codex PATH`、`--python PATH`、`--port N` 等参数。
3. 按 stdout JSON 与退出码判断：

   | 退出码 / `status` | 处理 |
   | --- | --- |
   | `0` / `ready` | 网站与讨论服务已就绪，进入验收 |
   | `0` / `configured` | 显式 `--no-start`，需要时 `codiscuss local open` |
   | `2` / `needs_attention` | 按结果中的条目进入诊断 |
   | `start_failed` | 配置已保存，按日志排除后重跑 `setup` |
   | `1` 或预检失败 | 未写入配置，修正前提后重跑 |

`npm link` 把命令链接到当前仓库；仓库移动位置后须重新 `npm link` 和 `setup`。

## 升级

1. `git status --porcelain` 检查本地改动；有未提交改动时告知用户，不擅自 stash 或丢弃。
2. `codiscuss local stop`。
3. 经用户同意后 `git pull`；冲突时停下交给用户。
4. `npm ci`，再 `codiscuss setup --clients <沿用原选择> --json`；已有配置会保留，差异按诊断处理。`npm link` 指向仓库，无需重做。
5. 已部署在线网站的，提醒用户同步升级线上站点（见 deploy.md），否则网页与本机版本可能不匹配。

## 诊断

先运行 `codiscuss local status --json`，再按 `setup` 结果中的具体条目处理；细节以 [docs/runner.md](../../../docs/runner.md#npm-安装与本机配置) 为准。

- **配置差异未确认**：列出已保存与检测到的类型、路径，问用户保留还是更新；更新时用对应 `--codex/--claude/--antigravity PATH` 重跑 `setup`。
- **技能冲突**：输出实际路径，比较已有副本与仓库版本的差异给用户看；用户同意后移走旧副本再重跑 `setup`，不直接覆盖。
- **持久命令缺失或指向旧安装**：`npm prefix -g` 与 `where codiscuss`（macOS/Linux 用 `which -a`）核对；告诉用户需加入 PATH 的实际目录，由用户修改后重开终端。
- **网站需重启**（运行中的版本或端口与当前安装不同）：重启会暂停托管中的讨论，经用户同意后运行 `codiscuss local stop`、`codiscuss local open`。
- **端口占用**：报告占用进程，改用 `--port` 另一端口重跑 `setup`，同步告知实际网站地址。
- **MSIX 文件虚拟化**（Windows，错误中报出两处路径）：按 docs/runner.md 说明，由用户在普通终端操作或统一设置 `DISCUSS_SERVICE_HOME`。
- **网站或服务异常**：读服务目录 `local/website.log`、`local/supervisor.log`、`service.log` 的最近错误后再判断，不凭猜测重启。

## 卸载

1. `codiscuss local stop`；开启过登录自启的再 `codiscuss service autostart off`，独立运行的服务用 `codiscuss service stop`。
2. `npm unlink -g ai_co_discuss` 移除命令链接。
3. 数据库、软件配置和已复制的技能保留在服务目录与各 CLI 技能目录，报告实际路径；只有用户明确要求时才删除。

## 验收

- `codiscuss local status` 显示网站与讨论服务均运行，记录实际网站地址；或 `codiscuss health --site <地址>` 返回 `ok`。
- 结果中 `ai_verified: false` 是正常状态：说明尚未用真实 AI 跑过任务，不把安装就绪说成讨论已验证。
- 汇报：安装方式与仓库路径、实际配置的软件及路径、网站地址、技能安装结果、未处理的待办项。下一步指向 README“发起第一场讨论”，由用户决定何时开始。

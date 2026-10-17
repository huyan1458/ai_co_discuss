# 本机微信桥接（独立工具）

此文档记录仓库中已有的本机桥接程序：通过腾讯 iLink 将本机 Codex 会话的通知或问题发送给扫码绑定用户，微信回复经 `codex queue` 返回来源聊天。它独立于讨论网站，不是建房、CLI 或专家协作的依赖。个人通知 Skill 不随本仓库分发；讨论技能只包含主持与参与两份。项目不自动监控所有聊天完成事件。

## 前提

- Node.js 24+，在仓库根目录执行 `npm ci`。
- 已运行的本机 Codex，命令行支持 `codex queue`；Windows 使用原生 `codex.exe`，必要时用 `--codex` 指定实际路径。
- 当前环境提供可信 `CODEX_THREAD_ID`，或已确认的本机聊天 UUID；不要使用最近窗口或虚构 ID。
- 使用者明确要求本任务微信通知。通过 AI 调用时，需在本机单独配置 `weixin-notify`，不从本仓库加载。

当前主要验证环境为 Windows 本机 Codex。队列受理不能证明聊天开始执行；已卸载的聊天可能需要在桌面打开。远程和云端会话不在当前支持范围，微信文字也不会自动点击审批或提交结构化输入控件。

## 首次登录

```sh
node weixin_bridge.mjs login
```

命令返回本地二维码 `qr_path`，用微信扫码并确认，再执行：

```sh
node weixin_bridge.mjs login --complete
```

需要手机验证码时加 `--verify-code`。`waiting` 表示继续完成同一次登录；`expired` 才重新申请二维码；只有 `connected` 确认登录完成。凭据保存在已忽略的 `data/weixin-account.json`，不要贴到聊天、Issue 或 Git。

然后给扫码连接的机器人发一条文字，用于建立发送上下文。后台收件器尚未运行时执行一次 `node weixin_bridge.mjs sync`；它最多等一次 40 秒请求，只刷新上下文，不执行来信正文。收件器已运行会自动处理，无需额外同步。

```sh
node weixin_bridge.mjs notify-status
```

`configured` / `context_available` 仅说明本地有凭据/上下文，不保证远端登录仍有效。

## 发送与接收

在实际 Codex 会话中准备 UTF-8 `data/notice.txt`，使用一次生成并保留的 UUID：

```powershell
$notice_id = [guid]::NewGuid().ToString()
node weixin_bridge.mjs notify --message-id $notice_id --text-file data/notice.txt
node weixin_bridge.mjs notify-status --message-id $notice_id
```

明确提问时用 `ask` 代替 `notify`；两者都支持回复。默认取当前 `CODEX_THREAD_ID` 并读取该聊天的实际名称，可用 `--thread` 提供已确认 UUID、`--title` 提供已核实的真实标题。聊天未命名时先在桌面命名，再沿用原编号和正文重试。

正文使用纯文本和自然段，自动附带来源聊天名称，不需要手写来源头。正文加标题最多 3500 UTF-8 字节，超限会拒绝，不会静默截断。相同编号固定来源与原正文；重复查询/调用成功编号不重发。

有来源聊天的 `notify` / `ask` 自动复用或隐藏启动同一个收件器，发送后即可结束本轮，不需要循环等待。普通回复回最近成功通知来源；手动选择立即生效，后续新通知仍会更新目标。引用回复可明确返回原消息所属聊天，无法确定来源时不猜测。

```sh
node weixin_bridge.mjs reply-status
node weixin_bridge.mjs listen-start
```

前者检查收件与投递状态；后者仅在收件器已停止、需要恢复时使用。没有安装开机任务。多个程序不能同时消费同一微信账号；普通通知发送不占收件锁，不能因发送需要而停止其他已确认正常的收件器。

## 微信命令

| 输入 | 作用 |
| --- | --- |
| `/help` | 查看用法 |
| `/status` | 查看当前目标和消息状态 |
| `/resume` | 查看本桥接联系过的聊天列表；兼容 `/sessions`、`/rusume` |
| `/resume 2` | 按最近一次列表切换到第 2 项 |
| `/resume 2 正文` | 切换并发送正文；列表后也可单独回复序号切换 |
| `/new 问题` | 先选择项目，再建立独立聊天；0 表示无项目 |
| `/clear` | 清理旧会话目录，保留当前目标；不删除实际 Codex 聊天 |

每次列表从 1 连续编号，名称后标记当前绑定，映射在下一次列表刷新前保持稳定。新通知、查询和重启不改变既有列表编号。`/new` 不继承旧聊天历史；创建完成后的回复仍需由新会话调用通知 Skill 发回。

收件器只接受扫码用户的私聊文字，不处理其他人、群聊或机器人回声。媒体不静默丢弃后执行文字说明，会提示改发文字。

## 状态与恢复

| 通知状态 | 含义与处理 |
| --- | --- |
| `api_accepted` | 微信 API 已受理；不是手机显示或已读，原编号不再发送 |
| `waiting_context` | 尚未发送；需要用户来信刷新上下文，再沿用原编号 |
| `pending` | 尚待发送；明确登录过期 `-14` 时重新扫码后沿用原编号 |
| `failed` | 远端明确拒绝，保留错误码并处理原因，不循环换号 |
| `uncertain` | 结果不明，停止重发并保留记录；重启/删库不能消除不确定性 |
| `not_found` | 当前账号未找到编号，核对命令是否执行及数据文件是否相同 |

来信状态中 `received` 表示已保存未投递，`queued` 表示 Codex queue 受理，`uncertain` 表示投递结果不明，`ignored` 表示无法确认有效归属。队列受理不等于任务完成。

默认沿用 `data/weixin-account.json` 与 `data/message-bridge.sqlite3`，支持 `--account` / `--state` 指定私有位置。同一次操作保持同一组文件；它们含令牌、消息正文与路由记录，不应发布。发送/同步退出码 0 表示就绪或受理，2 表示等待/拒绝/不确定，1 表示输入/配置/请求错误；状态查询 0 仅代表查询成功。

## 旧桥接与开发工具

`bind` / `run` 是保留的旧双向桥接：先明确绑定已有聊天 UUID，再持续收发并读取对应轮次结果。它与现代通知收件器共享账号收件锁，不同时运行；普通 Skill 通知无需手动绑定别名。

```sh
node weixin_bridge.mjs --help
node message_bridge.mjs --help
```

`message_bridge.mjs` 的 `send` / `watch` / `status` 用于本机模拟输入和诊断，`send` 会真正向指定 Codex 聊天投递。只运行自动测试可用 `npm run test:bridge`，测试使用临时数据库和传输替身，不需要扫码、不发送真实消息。

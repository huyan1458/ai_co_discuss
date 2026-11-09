---
name: local-tts-setup
description: "为 AI CoDiscuss 安装本机朗读语音：下载 yovoice CLI、推理引擎与 Qwen3-TTS 模型，在这台电脑的显卡上合成朗读，并配置为网页“设置 → 语音”里的“本机”服务。用户要求安装、修复、升级或卸载本地朗读、本机语音、离线 TTS 时使用；不用于填写火山引擎、阿里云、Azure 等云端语音的密钥。"
---

# 本机朗读语音（local-tts-setup）

装好后的样子：

- `SERVICE_HOME/yovoice/cli/`：yovoice CLI（含 `tools/` 下的音频转换器）；`SERVICE_HOME/yovoice/data/`：推理引擎与模型，只给 CoDiscuss 用，不与 yovoice 桌面应用共用（`SERVICE_HOME` 见“前提”第 2 条）。
- 访问令牌存在 CoDiscuss 的本机私有密钥里（地址 `http://127.0.0.1:18765`），不写进其他文件。
- 朗读设置切到“本机”。yovoice 服务由 CoDiscuss 本机程序在朗读时自动启动，只监听 `127.0.0.1:18765`；用户点停止朗读后 5 秒内、或 1 分钟没有朗读请求时自动结束并释放显存（CoDiscuss 崩溃也一样），不需要开机自启。

全程只在用户电脑上操作：不改 CoDiscuss 源码，不把令牌写进回复、日志或命令行参数；下载与安装前把预计占用（下文“前提”）告诉用户。

## 前提

依次检查，任何一项不满足就停下说明，不硬装：

1. **CoDiscuss 版本**：运行 `codiscuss launch tts-settings`，输出的 `catalog` 里要有 `"id": "local"`。没有说明版本过旧，请用户先更新（`npm install -g ai_co_discuss@latest`，再 `codiscuss service restart`）后继续。
2. **服务目录**：设置了环境变量 `DISCUSS_SERVICE_HOME` 时用它，否则是 `~/.codiscuss`。下文记为 `SERVICE_HOME`。
3. **推理后端**（决定 `setup --backend`）：

   | 平台 | 判断 | 后端 |
   |---|---|---|
   | Windows + NVIDIA | `nvidia-smi` 的驱动主版本 ≥ 580 | `cuda13`（RTX 50 系必须用它：CUDA 12.4 不支持 Blackwell） |
   | Windows + NVIDIA | 驱动更旧 | `cuda`，或请用户先升级驱动 |
   | Windows + AMD / Intel 独显 | — | `vulkan` |
   | macOS Apple Silicon | — | `metal` |
   | Linux x64 | 有可用的 Vulkan 驱动 | `vulkan`，否则 `cpu` |

   只能用 `cpu` 时先告诉用户：每段朗读可能要十几秒以上，播放会断断续续，用户同意再装。
4. **显存与磁盘**：模型（Qwen3-TTS 1.7B CustomVoice Q8）约 2.7 GB，需要 4 GB 以上显存；磁盘约 3.5 GB（CUDA 引擎约 0.6 GB + 模型）。

## 安装

命令以 Windows 的 `yovoice.exe` 为例，macOS / Linux 的可执行文件是 `yovoice`。下载走用户当前的网络设置；GitHub 或 ModelScope 访问失败时，先问用户是否有代理，不自行换来源。

1. **下载 CLI**：读 `https://api.github.com/repos/leemysw/yovoice/releases/latest`，取资产 `yovoice-<版本>-cli-<windows-x64 | macos-arm64 | linux-x64>.zip` 与 `SHA256SUMS.txt`，下载到空目录 `SERVICE_HOME/yovoice/download/`，核对 SHA-256 一致后解压到 `SERVICE_HOME/yovoice/cli/`（Windows 用 `tar -xf`），保留 `tools/` 目录。已装过时先结束正在运行的 yovoice 进程再覆盖。用 `yovoice.exe --version` 确认。
2. **推理引擎**：`yovoice.exe setup --backend <后端> --data-dir SERVICE_HOME/yovoice/data`。
3. **模型**：`yovoice.exe models download qwen3-tts-customvoice-q8 --data-dir SERVICE_HOME/yovoice/data`（默认从 ModelScope 下载，失败时可加 `--source huggingface`）。
4. **令牌**：生成 64 位十六进制随机串，写入临时文件 `{"base_url": "http://127.0.0.1:18765", "api_key": "<令牌>"}`，运行 `codiscuss launch api-key --file <临时文件>`，记下返回的 `api_key_ref`，随即删除临时文件。
5. **切换朗读服务**：把 `codiscuss launch tts-settings` 的输出存成临时文件，只改两处：`provider` 设为 `"local"`，`providers.local.api_key_ref` 设为上一步的引用；其余字段不动（读出的 `catalog` 等字段保存时会被忽略），用 `codiscuss launch tts-settings --file <临时文件>` 保存后删除临时文件。用户只要求安装、不想马上切换时，`provider` 保持原值，只写 `api_key_ref`。
6. **验证**：先结束正在运行的 yovoice 进程（推理子进程 `audiocpp_server` 会随之退出），否则旧令牌启动的服务会拒绝新令牌。临时文件写入 `{"text": "你好，这是本机朗读测试。"}`，运行 `codiscuss launch tts --file <临时文件>`：返回 `format` 为 `"m4a"`、`audio` 非空即成功，`SERVICE_HOME/yovoice/serve.log` 会出现一行 `"url":"http://127.0.0.1:18765"`，说明服务是由 CoDiscuss 拉起的。1 分钟内再换一段约 100 字的新文本请求一次，测服务已启动时的速度（同一文本会命中本机缓存，测不出速度）。参考：RTX 5060 8 GB + `cuda13`，短句含启动服务与加载模型约 4 秒；服务已启动时，100 字约 6–7 秒合成约 27 秒音频。
7. **清理与汇报**：删除 `SERVICE_HOME/yovoice/download/` 与所有临时文件。向用户报告后端、模型、实测耗时，并说明：网页“设置 → 语音”选“本机”，可选 9 个音色并分别试听；本机服务不支持调语速，语气提示可用；切回云端服务只需在同一处点选。网页经已在运行的 CoDiscuss 本机服务朗读；刚更新过 CoDiscuss 时，先运行 `codiscuss service restart` 再刷新网页，才会出现“本机”。

## 修复、升级与卸载

- **修复**：读 `SERVICE_HOME/yovoice/serve.log` 与 `SERVICE_HOME/yovoice/data/logs/`，对照下表处理；必要时从出问题的那一步重做，令牌变了就重做第 4、5 步。
- **升级 yovoice**：结束 yovoice 进程，重做第 1 步；新版要求新引擎时重做第 2 步。
- **卸载**：先在设置里切回其他服务（或用第 5 步的方法改 `provider`），结束 yovoice 进程，删除 `SERVICE_HOME/yovoice/`。

| 现象 | 原因与处理 |
|---|---|
| 本机语音尚未安装 | 没找到 `cli/yovoice.exe` 或令牌：重做第 1、4、5 步 |
| 服务拒绝了令牌 | 18765 端口上是旧令牌启动的 yovoice：结束该进程后重试 |
| 服务启动超时 | 看 `serve.log`；端口被其他程序占用时请用户释放该端口 |
| 合成失败（HTTP 500） | 看 `data/logs/`：CUDA 报错时检查驱动，或换后端重做第 2 步；显存不足时关闭占显存的程序 |
| 转码失败 | `cli/tools/` 缺失或损坏：重做第 1 步 |

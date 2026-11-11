---
name: local-stt-setup
description: "为 AI CoDiscuss 安装本机语音识别：下载 CrispASR 与 Qwen3-ASR 模型，在这台电脑上把语音输入转成文字，并配置为网页“设置 → 语音 → 语音输入”里的“本机”服务。用户要求安装、修复、升级或卸载本地语音识别、本机语音输入、离线 ASR 时使用；不用于填写火山引擎等云端语音的密钥，本机朗读见 local-tts-setup。"
---

# 本机语音识别（local-stt-setup）

装好后的样子：

- `SERVICE_HOME/crispasr/cli/`：CrispASR 程序（`crispasr.exe` 及其 DLL）；`SERVICE_HOME/crispasr/models/qwen3-asr-0.6b-q8_0.gguf`：识别模型（约 1 GB）。`SERVICE_HOME` 见“前提”第 2 条。
- 访问令牌存在 CoDiscuss 的本机私有密钥里（地址 `http://127.0.0.1/crispasr`，只用来标识本机识别服务，不含端口），不写进其他文件或命令行。
- 语音输入切到“本机”。CrispASR 由 CoDiscuss 本机程序在识别时自动启动，只监听本机地址，优先用端口 37642，被占用时自动换一个空闲端口；1 分钟没有识别请求自动结束并释放显存（CoDiscuss 崩溃也一样），不需要开机自启。

全程只在用户电脑上操作：不改 CoDiscuss 源码，不把令牌写进回复、日志或命令行参数；下载与安装前把预计占用（下文“前提”）告诉用户。

## 前提

依次检查，任何一项不满足就停下说明，不硬装：

1. **CoDiscuss 版本**：运行 `codiscuss launch tts-settings`，输出的 `stt_catalog` 里要有 `"id": "local"`。没有说明版本过旧，请用户先更新（`npm install -g ai_co_discuss@latest`，再 `codiscuss service restart`）后继续。
2. **服务目录**：设置了环境变量 `DISCUSS_SERVICE_HOME` 时用它，否则是 `~/.codiscuss`。下文记为 `SERVICE_HOME`。
3. **程序包**（GitHub `CrispStrobe/CrispASR` 的 Release 资产）：

   | 平台 | 判断 | 资产 |
   |---|---|---|
   | Windows + NVIDIA | `nvidia-smi` 的驱动主版本 ≥ 580 | `crispasr-windows-x86_64-cuda13.zip`（RTX 50 系可用） |
   | Windows + NVIDIA | 驱动更旧 | `crispasr-windows-x86_64-cuda.zip`（CUDA 12.8，也支持 RTX 50 系），驱动太旧则 `-cuda126.zip` |
   | Windows + AMD / Intel 独显 | — | `crispasr-windows-x86_64-vulkan.zip` |
   | Windows 无独显 | — | `crispasr-windows-x86_64-cpu.zip` |
   | macOS Apple Silicon | — | `crispasr-macos-arm64.tar.gz` |
   | Linux x64 | NVIDIA / 其他独显 / 无 | `crispasr-linux-x86_64-cuda13.tar.gz`（或 `-cuda`）/ `-vulkan.tar.gz` / `crispasr-linux-x86_64.tar.gz` |

   只能用 CPU 时先告诉用户：识别速度约等于录音时长（一段 1 分钟的话要等约 1 分钟），用户同意再装。
4. **显存与磁盘**：识别服务运行时约占 2.5 GB 显存；与本机朗读（约 3 GB）同时运行时，8 GB 显卡余量很紧，两者都是用完 1 分钟后自动退出。磁盘约 1.7 GB（Windows CUDA 13 程序约 0.7 GB + 模型约 1 GB）。

## 安装

命令以 Windows 为例，macOS / Linux 的可执行文件是 `crispasr`。下载走用户当前的网络设置；经代理访问 GitHub 时偶尔会 TLS 握手失败（`schannel: failed to receive handshake`），用 `curl --retry 3 --retry-all-errors` 重试即可，仍失败再问用户是否换网络或代理。

1. **下载程序**：读 `https://api.github.com/repos/CrispStrobe/CrispASR/releases/latest`，取上表对应资产，记下资产的 `digest`（`sha256:...`）。下载到空目录 `SERVICE_HOME/crispasr/download/`，核对 SHA-256 与 `digest` 一致后解压。压缩包里有一层以资产名命名的文件夹，把其中全部文件移到 `SERVICE_HOME/crispasr/cli/`，使 `cli/crispasr.exe` 与 DLL 在同一层。已装过时先结束正在运行的 crispasr 进程再覆盖。用 `crispasr.exe --version` 确认。
2. **模型**：下载 `https://huggingface.co/cstr/qwen3-asr-0.6b-GGUF/resolve/main/qwen3-asr-0.6b-q8_0.gguf` 到 `SERVICE_HOME/crispasr/models/`（约 1 GB）。不要用文件名带 `imatrix` 的版本（长录音可能陷入重复）。
3. **令牌**：生成 64 位十六进制随机串，写入临时文件 `{"base_url": "http://127.0.0.1/crispasr", "api_key": "<令牌>"}`，运行 `codiscuss launch api-key --file <临时文件>`，随即删除临时文件。
4. **切换语音输入**：把 `codiscuss launch tts-settings` 的输出存成临时文件，只改 `stt_provider` 为 `"local"`，其余字段不动（读出的 `catalog`、`stt_catalog` 等字段保存时会被忽略），用 `codiscuss launch tts-settings --file <临时文件>` 保存后删除临时文件。用户只要求安装、不想马上切换时跳过这一步，之后可在网页“设置 → 语音 → 语音输入”里点“本机”。
5. **验证**：先结束正在运行的 crispasr 进程（旧令牌启动的服务会拒绝新令牌）。准备一段 16 kHz 单声道 16 位 WAV（可用本机朗读或任意录音转换），去掉 44 字节文件头得到 PCM，base64 后写入临时文件 `{"upload_id": "<新 UUID>", "index": 0, "data": "<base64>", "final": true}`（单段不超过 256 KB，约 8 秒；更长的录音按序号分段，只有最后一段带 `"final": true`），运行 `codiscuss launch stt --file <临时文件>`：返回 `text` 即成功，`SERVICE_HOME/crispasr/serve.log` 会出现 `crispasr-server: transcribed ...`。第一次要启动服务并加载模型，约 5–15 秒。参考：RTX 5060 8 GB + `cuda13`，服务启动后约 35 倍实时，5 分钟录音约 8.5 秒。
6. **清理与汇报**：删除 `SERVICE_HOME/crispasr/download/` 与所有临时文件。向用户报告程序包、模型与实测耗时，并说明：中英混说、标点与英文大小写识别较好；逐字母念的缩写（如 npm 念成 N-P-M）和代码标识符（如 `tts_providers`）容易识别成别的写法；切回火山引擎只需在设置里点选。

## 修复、升级与卸载

- **修复**：读 `SERVICE_HOME/crispasr/serve.log`，对照下表处理；必要时从出问题的那一步重做，令牌变了就重做第 3 步并结束旧进程。
- **升级 CrispASR**：结束 crispasr 进程，重做第 1 步。
- **卸载**：先在设置里把语音输入切回火山引擎（或用第 4 步的方法改 `stt_provider`），结束 crispasr 进程，删除 `SERVICE_HOME/crispasr/`。

| 现象 | 原因与处理 |
|---|---|
| 本机语音识别尚未安装 | 没找到令牌或 `cli/crispasr.exe`：重做第 1、3 步 |
| 服务拒绝了令牌 | 正在运行的是旧令牌启动的 crispasr：在设置页“本机进程”结束它，或结束 crispasr 进程后重试 |
| 本机服务启动超时 | 看 `serve.log`：缺 DLL 时重做第 1 步（确认文件已移到 `cli/` 同一层）；CUDA 报错时检查驱动，或换 `-vulkan` / `-cpu` 包 |
| 识别失败（HTTP 500） | 看 `serve.log`；显存不足（out of memory）时关闭占显存的程序，或等本机朗读用完自动退出后再试 |

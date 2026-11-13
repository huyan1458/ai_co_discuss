/** Shared launch configuration for an existing AI conversation and the local website. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { account_projects, account_space, create_account_project, draft_folder } from './account_space.mjs';
import { atomic_json } from './files.mjs';
import { bundle_project_markdown, bundle_project_page, outside_directory, project_media, read_only_enforced, read_project_files, room_directories, search_project_roots } from './project_files.mjs';
import { guard_remote_request, list_remote_directories } from './remote_policy.mjs';
import { list_devices, machine_fingerprint, revoke_device, start_pairing } from './device_auth.mjs';
import { setup_sidecar } from './adapters/antigravity_app.mjs';
import { adapter_of, adoption_adapter, BRANCHABLE_ADAPTERS, branch_session, execution_details, session_settings, software_defaults, software_defaults_stamp, software_effort, software_models, software_skills } from './adapters/index.mjs';
import { ADAPTER_IDS, ADAPTER_PROFILES, adapter_profile, DEFAULT_API_MAX_REQUESTS, MAX_API_MAX_REQUESTS, platform_adapters, same_session_family } from './adapters/profiles.mjs';
import { API_PROVIDERS, api_check, api_models, managed_api_keys, save_api_key, saved_api_keys, validate_api_profile } from './discussion_api.mjs';
import { DEFAULT_SCHEDULER_MODE, SCHEDULER_MODES, SCHEDULER_PROVIDERS, scheduler_check } from './scheduler.mjs';
import { save_tts_settings, tts_release, tts_settings, tts_speak } from './tts.mjs';
import { local_service_stop, local_services } from './tts_providers.mjs';
import { weixin_command } from './weixin.mjs';
import { stt_part } from './stt.mjs';
import { image_settings, room_image, save_image_settings } from './image_service.mjs';
import { open_project } from './adapters/api_files.mjs';
import { run_image_tool } from './adapters/api_images.mjs';
import { access_levels, BUILTIN_EXPERT_PRESETS, MAX_EXPERT_PROMPT, PROJECT_ACCESS } from './expert_prompts.mjs';
import { acquire_lock, api, check_extra_directories, DiscussionStore, service_drafts, validate_config } from './discussion_runner.mjs';
import { FreeRoomRunner, free_task_files } from './free_runner.mjs';
import { assert_workflow_enabled, bind_room_workflow, delete_workflow, get_workflow, list_workflows, load_room_workflow, parse_workflow_draft, preview_workflow, rename_workflow, save_workflow, set_workflow_disabled, workflow_cards, workflow_directory, WORKFLOW_ID_PATTERN } from './workflows.mjs';
import { assert_shared_home, CONNECTION_FIELDS, configuration_snapshot, read_registry, registered_identity, register_room, service_home, service_pid, start_service } from './discussion_service.mjs';

// A platform is a type; `Claude-review` is another Claude instance with its own session, model and effort. An ID is
// English letters, digits and underscores only; a Chinese name is a display label.
const INSTANCE_PATTERN = /^(Codex|Claude|Antigravity|DeepSeek|Qwen|Grok|OpenAI|Custom)(?:-[0-9A-Za-z_]{1,16})?$/;

/** The platform of an AI instance name, or null. */
export function platform_of(name) { return typeof name === 'string' ? INSTANCE_PATTERN.exec(name)?.[1] ?? null : null; }

/** The first unused instance name of a platform: the platform itself, then platform-2, platform-3, …. */
export function next_instance(platform, taken) {
  if (!taken.has(platform)) return platform;
  for (let number = 2; ; number++) if (!taken.has(`${platform}-${number}`)) return `${platform}-${number}`;
}

/** A free name from a used one, as the website numbers copies: Codex → Codex-2, Codex-review → Codex-review2. */
function free_instance(name, taken) {
  if (!name.includes('-')) return next_instance(name, taken);
  for (let number = 2; ; number++) if (!taken.has(`${name}${number}`)) return `${name}${number}`;
}

/** Supported local clients of an instance's platform. */
function clients_of(name) { return platform_adapters(platform_of(name)); }
const PROFILE_FIELDS = ['adapter', 'executable', 'model', 'effort', 'source_thread_id', 'ipc_directory', 'allowed_tools', 'cwd', 'project_name', 'project_id', 'base_url', 'api_protocol', 'api_key_ref', 'system_prompt'];
// Saved before drawing became the room's switch; read as absent.
const LEGACY_PROFILE_FIELDS = ['image_model'];
const MAX_MINUTES = 1440;
const SESSION_ID_PATTERN = /^[0-9A-Za-z_-]{8,128}$/;
const LOCAL_MEMBERS_FORMAT = 'ai-codiscuss-local-members';
// Reading the inbox proves the owner credential without transferring any messages.
const CONFIG_APPLY_TIMEOUT_MS = 6000;
const CONFIG_APPLY_POLL_MS = 100;
const HELP = `用法：codiscuss launch settings [--file FILE]
      codiscuss launch start --file FILE [--dry-run]
      codiscuss launch room-config --file FILE
      codiscuss launch room-models --file FILE
      codiscuss launch room-skills --file FILE
      codiscuss launch room-files --file FILE
      codiscuss launch room-page --file FILE
      codiscuss launch room-media --file FILE
      codiscuss launch execution-details --file FILE
      codiscuss launch models --file FILE
      codiscuss launch api-key --file FILE
      codiscuss launch api-check --file FILE
      codiscuss launch scheduler-check --file FILE
      codiscuss launch image-settings [--file FILE]
      codiscuss launch image --file REQUEST [--access-file FILE]
      codiscuss launch tts-settings [--file FILE]
      codiscuss launch tts --file FILE
      codiscuss launch tts-release
      codiscuss launch local-speech [--file FILE]
      codiscuss launch weixin [--file FILE]
      codiscuss launch stt --file FILE
      codiscuss launch room-member --file FILE
      codiscuss launch room-member-access --file FILE
      codiscuss launch room-member-allow --file FILE
      codiscuss launch room-member-model --file FILE
      codiscuss launch room-member-adapter --file FILE
      codiscuss launch room-profiles --file FILE
      codiscuss launch room-restore --file FILE
      codiscuss launch room-fork --file FILE
      codiscuss launch pick-directory
      codiscuss launch browse-directory [--file FILE]
      codiscuss launch device-pairing [--file FILE]
      codiscuss launch devices [--file FILE]
      codiscuss launch projects [--file FILE]
      codiscuss launch presets [--file FILE]
      codiscuss launch machine-link --file FILE
      codiscuss launch workflow-adopt (--draft FILE | --id WORKFLOW) [--access-file FILE]
      codiscuss launch workflow-join [--card ID[,ID] | --sub SUB] [--access-file FILE]
      codiscuss launch workflow-leave --sub SUB [--access-file FILE]
      codiscuss launch host-control ACTION [选项] [--access-file FILE]
      codiscuss launch workflow-check (--dir DIR | --draft FILE)
      codiscuss launch workflow-save (--dir DIR | --draft FILE)

settings 读取本机软件默认配置；指定文件时保存，不启动 AI。
start 使用启动 JSON 创建或接入房间并启动；--dry-run 只校验和预览。
room-config 修正已暂停房间的软件路径或切换 Codex App / CLI，不启动讨论；须提供 site、room_id、token。
room-models 只读指定 site、room_id 的本机登记模型与思考强度，不启动讨论；quick 为 true 时不查询 agy 的默认模型（较慢），该成员标 defaults_pending。
room-skills 只读指定成员本机安装的技能，须提供 site、room_id、token、name；软件与项目目录只取本机已保存配置，不启动 AI。
room-files 只读房间已保存的项目目录，须提供 site、room_id、token，可选相对 path 和目录分页 offset；文件返回最多前 128 KiB 文本；给 query 时改为按名称搜索整个项目（含 / 时按路径），最多返回 50 项。
room-page 只读项目目录里的一个 HTML 文件（path，可选 root），把它按相对路径引用的样式、脚本、图片、字体与音视频内联为 data URL，以 base64 的 data 返回（最多 8 MiB）；Markdown 文件则返回它按相对路径引用的项目图片 {项目路径: data URL} 的 JSON；其他设备经中转时分段返回，按 offset 续读并核对 version；未能载入的引用列在 missing（不存在或在项目目录外）与 skipped（超出大小）。
room-media 核对项目目录里的一个图片、视频或音频文件（path，可选 root）可读：本机网站凭它登记一个 10 分钟有效的播放地址，按 Range 直接读盘，网页拿不到文件路径；其他设备经中转时分段返回 base64 的 data（按 offset 续读并核对 version），最多 64 MB。
execution-details 只读房间某次执行的过程细节（中间说明、命令与输出、搜索、改动、工具调用），由本机日志还原，须提供 site、room_id、token、execution_id；细节只留在本机，不写入网站。
models 按 adapter、executable 或 API profile 读取模型目录，不启动讨论或生成回答。
api-key 将 base_url、api_key 保存于本机私有目录，只返回 api_key_ref。
api-check 用 API profile 向模型发送一次极短请求，核对地址、密钥、协议与模型是否可用。
scheduler-check 用智能调度配置（provider、model、api_key_ref）向决策模型发送一道是非题，核对供应商、模型与密钥是否可用。
image-settings 读取这台电脑的生图服务（base_url、图片模型 model、api_key_ref，configured 表示已配置 Key）；内容非空时保存。
image 成员按任务凭据生图（房间须添加了生图卡片）：REQUEST 为 JSON，必填 action（generate 生成 / edit 改图）与 prompt；可选 size（auto、1024x1024、1536x1024、1024x1536 或 16 倍数的 宽x高）、quality（auto/low/medium/high，2.5、2.6 系列另有 xhigh/max）、n（1–10 张）、output_format（png/jpeg/webp/gif，生成另可 svg）、background（auto/opaque/transparent）、file_name（附件名）、save_path（另存进可写项目）；edit 另需 images（1–16 个 {attachment_id} 或 {file_path}，第一张为主图），可加 mask 或 markup（同样格式，二选一）。图片存为成员的附件，返回附件 ID，再用 message post --attachment 附上。
tts-settings 读取朗读设置；内容非空时保存（语音服务 provider：local（本机，由 local-tts-setup 技能安装）/ volcengine / aliyun / azure / openai，语速 speech_rate，以及 providers.<服务> 的 api_key_ref、speaker、member_voices、file_voice，本机、火山引擎与 OpenAI 另有语气提示 context（各自默认不同），Azure 另有 region；语音输入服务 stt_provider：local / volcengine / openai）。
tts 用朗读设置把 text（不超过 300 字）合成为音频（本机服务为 m4a，其余为 MP3），返回 base64。
weixin 微信通知：action 为 status（默认，读取绑定状态）、login（生成扫码内容）、complete（等待扫码确认，约 20 秒）、test（发一条测试通知）或 unbind（解除本机绑定）。Goal 待确认 5 分钟仍未回复时通知房主，房主在微信回复即作为房主发言发回该房间；只用本机服务目录保存凭据。
tts-release 用户停止朗读：所选服务释放在这台电脑上占用的资源（本机语音在 5 秒内结束、释放显存），云端服务无操作。
local-speech 读取本机朗读（tts，yovoice）与语音识别（stt，crispasr）服务的运行状态（state：running / stopped / other（端口被其他程序占用），及 pid、进程名）；内容为 {"stop": "tts" | "stt"} 时强行结束该服务（连同子进程），只结束端口上属于该服务程序的进程。
stt 按序接收录音片段（upload_id、index、base64 PCM 16 kHz 单声道、final）；最后一段时识别整段录音并返回 text。
pick-directory 在本机弹出系统目录选择窗口，返回所选路径；取消时不返回路径。
browse-directory 列出常用项目及其中的子文件夹（只含文件夹名，分页），供其他设备选择目录；path 为空时列出常用项目。
device-pairing 在本机生成 12 位设备配对码（2 分钟有效，可选 temporary 临时设备、without_passkey 允许这次配对不用通行密钥、site 指定已绑定的网站），扫码链接带本机密钥指纹；只能在这台电脑上执行，新设备只能在电脑前添加。
devices 列出已配对设备；提供 revoke（设备 id）撤销设备。
projects 读取本机已配置的项目（名称与绝对路径）；提供 JSON（projects 列表）时整体替换保存。
presets 读取本机的专家预设（含未删除的内置预设）与各平台默认描述；提供 JSON（presets 列表、description_templates 和/或 hidden_builtins 已删除的内置预设名）时替换对应部分。
machine-link 返回本机连接指定 site 的电脑编号、名称与凭据，供已登录管理员的网页完成配对；不存在时创建。
room-member 为房间邀请、请回一位成员；须提供 site、room_id、token、action（add/rejoin）、name。
room-member-access 修改一位本机唤醒成员的项目权限（project_access 为 read/write/auto/full），下次投递起生效、保留原会话；须提供 site、room_id、token、name、project_access。
room-member-allow 把被拒绝的操作加入一位本机唤醒的 Claude Code 或 agy 成员的 allowed_tools，下次投递起生效；须提供 site、room_id、token、name、rules。
room-member-model 修改一位本机唤醒 CLI 或 API 成员的模型与思考强度（空值恢复软件默认；API 成员空模型保留原模型），下次投递起生效、保留原会话；须提供 site、room_id、token、name、model、effort。
room-member-adapter 把自由房间里空闲的 Codex 成员在 App（codex）与 CLI（codex_cli）间切换，保留原会话；须提供 site、room_id、token、name、adapter。
room-profiles 导出房间的本机成员软件配置与实际会话 ID（不含凭据），供备份附带；须提供 site、room_id、token。
room-restore 把导入房间的本机成员配置登记到本机并核对原会话存在，Claude Code 成员保持手动；须提供 site、room_id、token、local_members。
room-fork 把从原房间分支出的新房间登记到本机，各本机成员从原会话分叉、不含分支点之后的执行，原会话不变；须提供 site、room_id、token、source_room_id、source_token、executions（{成员名: [排除的执行编号]}）。
workflow-adopt 主持人在本房间启用工作流：--draft 把自己的草稿（一段，分段头 1/1）保存进工作流库后启用，--id 启用工作流库里已有的工作流（不改动它）；缺的卡片成员由本机服务邀请，项目权限最高可写；须房主已为本房间打开“主持人完整权限”。凭据为本次任务的 access_file（或 DISCUSS_ACCESS_FILE）。
workflow-join 主持人为本房间在用工作流里还没有成员的卡片（启用后才新增的）邀请成员，不填 --card 即全部主线卡片；无需额外授权，离开或移除的成员由用户请回。--sub 改为请进该子工作流的卡片成员（离开的请回原会话）。凭据同上。
workflow-leave 主持人用完子工作流后，把 --sub 子工作流卡片的成员设为离开（会话保留，下次 workflow-join --sub 请回）；主线成员不能这样请离。凭据同上。
host-control 主持人代房主控制房间，须房主已为本房间打开“主持人完整权限”，凭据同上；成员用 --member（成员 ID 或显示名），除 retry、model、label 外不能是主持人自己：
  诊断：details --execution N 读取该执行的本机过程日志（服务端详情与事件记录用 execution / room events 读取）；
  恢复：stop --member 打断；stop-all 停止全部执行、请求与接力；steer --member --text 话 [--submission-id ID] 向它进行中的执行插话；
        retry --execution N 重试失败的执行（含你自己的）；model --member [--model M] [--effort E] 改 CLI 或 API 成员的模型与强度（空值恢复默认；API 成员不填模型则保留原模型）；
        adapter --member --adapter ID 在同一软件的 App 与 CLI 间切换；access --member --access read|write 调整项目权限；
  成员：invite --name 平台 [--access read|write] [--model M] [--effort E] 用本机已配置的软件邀请，项目权限最高可写；
        away / remove / back --member 暂离、移除、请回；label --member [--label 显示名] [--description 描述]；
  撤回：withdraw --message N 撤回自己的一次派活：接力或循环停下，未开始的请求取消，进行中的停止，不再交回；
  兜底：checkin --minutes N 房间有进行中的工作时每 N 分钟（5–120）给你发一次定时检查，房间空闲、停止全部或换主持人后自动结束；checkin --off 关闭；
  推进：order 读取发言顺序，order --order 甲,乙 --revision REV 调整尚未发言的部分；
        discussion 读取讨论，discussion --do start --goal 目标 --revision REV 开启（上限用房间默认值），--do pause|resume|end --revision REV；
        goal 读取 Goal，goal --do start --goal 目标 --revision REV 开启（预算用房主默认值，默认不限时为 8 次续跑、90 分钟），--do pause|resume|end --revision REV。
  不开放：批准超出上限的轮数、项目权限高于可写或放行工具、改项目目录、撤回回退用户消息、私聊、对主持人自己的其他操作。
workflow-check 按导入规则校验工作流文件夹或单段草稿，返回预览，不保存；workflow-save 校验后保存进工作流库（同 ID 覆盖），卡片按声明的项目权限保存。写法见 workflow-creator 技能。
JSON 指定 site、entry（conversation/web）、room（建房内容，含 submission_id）
或 room_id（已有房间）、participants（本次软件覆盖配置）。
conversation 还须 current_session_id，当前会话接手首个主持任务。
已有受保护房间使用 access_file。路径、凭据只保存在本机。
详见 docs/runner.md 的“两种讨论入口与启动配置”。
`;

// Windows PowerShell 5.1 ships WinForms. A background process cannot take the foreground, so the owner must be
// shown (transparent) as a topmost window; the dialog it owns then stays above the browser that asked for it.
// Keep the owner on-screen because the Common Item Dialog positions itself relative to its owner.
// windowsHide turns the process's first Show into a hide, so the owner is shown a second time to really appear.
// Under the local service the whole process chain has no console and no foreground rights: Windows then silently ignores
// SetWindowPos(HWND_TOPMOST) on the dialog (it returns success). So once the dialog exists, a timer in its message loop
// briefly attaches to the foreground window's input thread (the browser that asked) to borrow its right to raise the dialog.
// The C# source must not contain single quotes: it is embedded in a single-quoted PowerShell string.
const PICKER_RAISE_SOURCE = [
  'using System; using System.Runtime.InteropServices;',
  'public static class PickerRaise {',
  '  delegate bool EnumProc(IntPtr handle, IntPtr arg);',
  '  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr arg);',
  '  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr handle, uint command);',
  '  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, IntPtr process);',
  '  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();',
  '  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint to, bool on);',
  '  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr handle);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);',
  '  public static bool OwnedBy(IntPtr owner) {',
  '    IntPtr dialog = IntPtr.Zero;',
  '    EnumWindows((handle, arg) => { if (GetWindow(handle, 4) == owner) dialog = handle; return dialog == IntPtr.Zero; }, IntPtr.Zero);',
  '    if (dialog == IntPtr.Zero) return false;',
  '    uint current = GetCurrentThreadId(), foreground = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);',
  '    bool attached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);',
  '    SetWindowPos(dialog, (IntPtr)(-1), 0, 0, 0, 0, 0x13); BringWindowToTop(dialog); SetForegroundWindow(dialog);',
  '    if (attached) AttachThreadInput(current, foreground, false);',
  '    return true;',
  '  }',
  '}',
].join(' ');
// Use the Common Item Dialog: unlike Framework WinForms, it has an editable address bar.
// COM declarations retain the native vtable order through the last method used.
const FOLDER_PICKER_SOURCE = `
public static class FolderPicker {
  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int CANCELLED = unchecked((int)0x800704C7);
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem folder);
    void SetFolder(IShellItem folder);
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint format, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  /// <summary>Choose an existing filesystem folder, or return null when cancelled.</summary>
  public static string Show(IntPtr owner) {
    var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
    IShellItem item = null;
    try {
      uint options;
      dialog.GetOptions(out options);
      dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
      dialog.SetTitle("选择项目目录");
      int result = dialog.Show(owner);
      if (result == CANCELLED) return null;
      Marshal.ThrowExceptionForHR(result);
      dialog.GetResult(out item);
      string path;
      item.GetDisplayName(SIGDN_FILESYSPATH, out path);
      return path;
    } finally {
      if (item != null) Marshal.ReleaseComObject(item);
      Marshal.ReleaseComObject(dialog);
    }
  }
}
`;
const WINDOWS_PICKER = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; Opacity = 0; ShowInTaskbar = $false; FormBorderStyle = "None"; StartPosition = "CenterScreen"; Size = New-Object System.Drawing.Size(1, 1) }',
  `Add-Type -TypeDefinition '${PICKER_RAISE_SOURCE} ${FOLDER_PICKER_SOURCE}'`,
  '$owner.Show(); $owner.Hide(); $owner.Show(); $owner.Activate()',
  '$timer = New-Object System.Windows.Forms.Timer -Property @{ Interval = 150 }; $timer.Add_Tick({ if ([PickerRaise]::OwnedBy($owner.Handle)) { $timer.Stop() } }); $timer.Start()',
  'try { [FolderPicker]::Show($owner.Handle) } finally { $timer.Stop(); $timer.Dispose(); $owner.Close(); $owner.Dispose() }',
].join('; ');
const PICKERS = {
  win32: ['powershell.exe', ['-NoProfile', '-STA', '-Command', WINDOWS_PICKER]],
  darwin: ['osascript', ['-e', 'POSIX path of (choose folder with prompt "选择项目目录")']],
  linux: ['zenity', ['--file-selection', '--directory', '--title=选择项目目录']],
};

/** Show the platform's own folder dialog on this computer; cancelling resolves without a path. */
export function pick_directory({ platform = process.platform, spawn_process = spawn } = {}) {
  const picker = PICKERS[platform];
  if (!picker) return Promise.reject(new Error('此系统不支持目录选择窗口，请直接输入完整路径'));
  return new Promise((resolve_result, reject) => {
    const child = spawn_process(picker[0], picker[1], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => reject(new Error('无法打开目录选择窗口，请直接输入完整路径')));
    child.once('close', code => {
      const path = output.trim();
      // Judge the path by the picker's platform, not the host's: a Windows path is not absolute on POSIX.
      const absolute = platform === 'win32' ? win32.isAbsolute(path) : posix.isAbsolute(path);
      resolve_result(code === 0 && absolute ? { path } : { cancelled: true });
    });
  });
}

/** Some CLIs take seconds to list models; reuse a good list for a day unless the executable changes or the user retries. */
const MODEL_CACHE_MS = 24 * 60 * 60 * 1000;

/** The executable's size and modification time, so a reinstalled or updated CLI is read again. */
function executable_stamp(profile) {
  try { const file = statSync(profile.executable); return `${file.size}:${file.mtimeMs}`; } catch { return ''; }
}

/**
 * The model and effort a software runs with when the card leaves them empty. One read from its own settings is
 * cheap and always fresh; one that must run the CLI (agy) is kept for a day, because each run may refresh the
 * software's login and, when that refresh fails, it opens a browser sign-in. `refresh` reads it again.
 * agy updates itself often, so the key leaves out the executable stamp; a failed run is recorded too and keeps the
 * last good answer, so a run that cannot sign in is not repeated on every room read. Changing the default model in the
 * software's own settings (`stamp`) reads it again at once.
 */
export async function cached_software_defaults(home, profile, { refresh = false, query = software_defaults, stamp = software_defaults_stamp } = {}) {
  if (!adapter_profile(profile.adapter)?.defaults_by_query) return query(profile);
  const path = join(home, 'model-catalogs.json');
  const key = JSON.stringify(['defaults', profile.adapter, profile.executable || '']);
  let cache = {};
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const entry = cache[key];
  const setting = stamp(profile);
  if (!refresh && entry && Date.now() - entry.at < MODEL_CACHE_MS && (entry.setting ?? '') === setting) return entry.result;
  const answer = await query(profile);
  const result = answer?.model ? answer : entry?.result || answer;
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  atomic_json(path, { ...cache, [key]: { at: Date.now(), setting, result } });
  return result;
}

/** Return the software catalog, served from the private service home when still valid. */
export async function cached_software_models(home, profile, { refresh = false, query = software_models, query_effort = software_effort, query_defaults = software_defaults } = {}) {
  const path = join(home, 'model-catalogs.json');
  const stamp = executable_stamp(profile);
  const key = JSON.stringify([profile.adapter, profile.executable || '', stamp]);
  const effort_key = JSON.stringify([profile.adapter, profile.executable || '', stamp, 'effort', profile.model || '']);
  let cache = {};
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const cached = entry => !refresh && entry && Date.now() - entry.at < MODEL_CACHE_MS ? entry.result : null;
  const [result, effort, defaults] = await Promise.all([cached(cache[key]) || query(profile),
    adapter_profile(profile.adapter)?.efforts_per_model ? cached(cache[effort_key]) || query_effort(profile) : null,
    cached_software_defaults(home, profile, { refresh, query: query_defaults })]);
  const updates = {};
  if (!cached(cache[key]) && !result.error && result.models.length) {
    updates[key] = { at: Date.now(), result };
  }
  if (effort && !effort.error && !cached(cache[effort_key])) {
    updates[effort_key] = { at: Date.now(), result: effort };
  }
  if (Object.keys(updates).length) {
    try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
    const prefix = JSON.stringify([profile.adapter, profile.executable || '']).slice(0, -1);
    for (const old of Object.keys(cache)) if (old.startsWith(prefix) && !old.startsWith(key.slice(0, -1))) delete cache[old];
    atomic_json(path, { ...cache, ...updates });
  }
  return { ...result, defaults, ...(effort ? { efforts: effort.levels, ...(effort.error ? { effort_error: effort.error } : {}) } : {}) };
}

/** Read private defaults without selecting a global room or identity. */
export function launch_settings(home) {
  const path = join(home, 'launch-settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { participants: {} };
  for (const profile of Object.values(settings.participants || {})) for (const field of LEGACY_PROFILE_FIELDS) delete profile?.[field];
  return settings;
}

/**
 * Read the registered room's model choices, what each software selects for empty ones, and its smart scheduler, never connection secrets.
 * `actual_model` / `actual_effort` (present only when known) are what each member's session last ran with, read from the software's own session log.
 * With `quick`, agy's default model is not queried and its entry is marked `defaults_pending`.
 */
export async function room_models(home, raw, { read_defaults = profile => cached_software_defaults(home, profile), read_session = session_settings } = {}) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id) throw new Error('读取本场模型须提供 room_id');
  const paths = read_registry(home).filter(path => {
    const identity = registered_identity(path);
    return identity?.site === input.site && identity.room === input.room_id;
  });
  if (paths.length > 1) throw new Error('本场存在多份登记配置，无法确定模型设置');
  const config = paths.length ? configuration_snapshot(paths[0]).config : {};
  const profiles = config.participants || {};
  let sessions = {};
  try { if (paths.length) sessions = bound_sessions(config, paths[0]); } catch { /* No readable runtime yet: fall back to borrowed sessions. */ }
  const participants = Object.fromEntries(await Promise.all(Object.entries(profiles).map(async ([name, profile]) => {
    const facts = adapter_profile(profile.adapter);
    // An App chooses its model itself; a CLI or API member's card sets it.
    const card_model = facts?.kind !== 'app';
    // A software read by running it to name its default model takes seconds; a quick read leaves that to a later full read.
    const pending = input.quick === true && Boolean(facts?.defaults_by_query);
    const defaults = pending ? { model: '', effort: '' } : await read_defaults(profile);
    const actual = read_session(profile.adapter, sessions[name] || profile.session_id);
    return [name, { ...(pending ? { defaults_pending: true } : {}), adapter: profile.adapter, model: card_model ? profile.model || '' : '',
      effort: facts?.efforts ? profile.effort || '' : '', default_model: defaults.model, default_effort: defaults.effort,
      ...(actual.model ? { actual_model: actual.model } : {}), ...(actual.effort ? { actual_effort: actual.effort } : {}),
      project_access: !facts?.capabilities.project ? 'read' : profile.project_access || config.project_access || 'read',
      // A member bound to its own conversation may keep that conversation's project, so this tool cannot set its access.
      own_project: Boolean(facts?.own_project_when_bound && profile.session_id),
      // A member working outside every project directory of the room only reads them; the page warns and names its directory.
      ...(facts?.capabilities.project && outside_directory(config, profile) ? { outside_directory: outside_directory(config, profile),
        outside_enforced: read_only_enforced({ ...profile, project_access: profile.project_access || config.project_access || 'read' }) } : {}) }];
  })));
  // Smart scheduling is a local choice; only which model decides is shown, never its key.
  const scheduler = config.scheduler ? { provider: config.scheduler.provider, model: config.scheduler.model, mode: config.scheduler.mode || DEFAULT_SCHEDULER_MODE } : null;
  return { room_id: input.room_id, registered: paths.length > 0, participants, scheduler, project_directory: config.cwd || '',
    extra_directories: config.extra_directories || [],
    workflow: room_workflow_status(config, home), host_workflows: Boolean(config.host_workflows),
    api_max_requests: config.api_max_requests ?? DEFAULT_API_MAX_REQUESTS,
    // Whether members may draw here, and whether this computer has an image service to draw with.
    image_generation: Boolean(config.image_generation), image_configured: image_settings(home).configured };
}

/** Read one member's installed skills for the room owner, using only this computer's saved software and directory. */
export async function room_skills(home, raw, { read_skills = software_skills } = {}) {
  const { input, config } = await member_room_context(home, raw);
  const profile = config.participants?.[input.name];
  if (!profile) return { room_id: input.room_id, member: input.name, available: false, skills: [], reason: '本机没有此成员的软件配置，无法读取技能' };
  const result = await read_skills({ ...profile, cwd: profile.cwd || config.cwd || '' });
  return { room_id: input.room_id, member: input.name, ...result };
}

/**
 * The room's workflow as the right column shows it; `available` is false when its folder is gone or broken, and
 * `cards` lists the card IDs the library has now, so the page offers a refresh only when the room differs from it.
 */
function room_workflow_status(config, home) {
  if (!config.workflow?.id) return null;
  const loaded = load_room_workflow({ ...config, api_home: config.api_home || home, workflow: { ...config.workflow, enabled: true } });
  // `cards` are the main flow's, which a refresh fills; a sub-workflow's cards join only when it is used.
  const cards = Object.values(loaded.cards || {});
  return { id: config.workflow.id, label: loaded.label || config.workflow.id, enabled: Boolean(config.workflow.enabled),
    available: !loaded.error, members: config.workflow.members || {}, cards: cards.filter(card => !card.sub_workflow).map(card => card.card),
    sub_workflows: (loaded.sub_workflows || []).map(sub => ({ id: sub.id, label: sub.label || sub.id, description: sub.description, cards: sub.cards })) };
}

/**
 * Read the owner's saved room projects, never a directory supplied by the request: `root` picks one of the room's
 * directories by index (0, the main one, by default), and a search covers all of them.
 */
export async function room_files(home, raw, { trust = false } = {}) {
  const { input, config } = await member_room_context(home, raw, { trust });
  const directories = room_directories(config);
  if (input.query) return { room_id: input.room_id, ...search_project_roots(directories, input.query) };
  const root = input.root ?? 0;
  if (!Number.isSafeInteger(root) || root < 0 || (directories.length && root >= directories.length)) throw new Error('项目目录编号无效，请刷新后重试');
  return { room_id: input.room_id, root, ...read_project_files(directories[root], input.path, input.offset) };
}

/**
 * `room-files` asked for by another device, answered inside the relay's own process: the same checks as the local
 * entrypoint with `--remote`, without starting Node for every folder opened.
 */
export async function remote_room_files(home, input) {
  assert_shared_home(home);
  guard_remote_request('room-files', input, { projects: granted_projects(home), participants: launch_settings(home).participants, home });
  return room_files(home, input, { trust: true });
}

// A relayed answer carries this much of a page at a time, within the relay's encrypted envelope after base64.
const PAGE_PART_BYTES = 192 * 1024;

/**
 * One HTML file of the room's project with the files it refers to inlined (see `bundle_project_page`), or the images a
 * Markdown file shows (`bundle_project_markdown`), as base64
 * `data` from `offset`. With `parts` (another device, through the relay) at most `PAGE_PART_BYTES` at a time; the
 * caller asks again from where a part ended and checks `version` stays the same.
 */
export async function room_page(home, raw, { trust = false, parts = false } = {}) {
  const { input, config } = await member_room_context(home, raw, { trust });
  const directories = room_directories(config);
  const root = input.root ?? 0;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(root) || root < 0 || root >= Math.max(1, directories.length)) throw new Error('项目目录编号无效，请刷新后重试');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('页面读取位置无效');
  const bundle = /\.(md|markdown)$/i.test(String(input.path || '')) ? bundle_project_markdown : bundle_project_page;
  const { bytes, ...page } = bundle(directories[root], input.path);
  const part = bytes.subarray(offset, parts ? offset + PAGE_PART_BYTES : bytes.length);
  return { room_id: input.room_id, root, ...page, total: bytes.length, offset, data: part.toString('base64') };
}

// Through the relay a media file comes whole, in parts, so another device plays at most this much.
export const REMOTE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

/**
 * One image, video or audio file of the room's project (see `project_media`). For the computer's own page it names
 * the real file, which the local site streams by a ticket and never shows the page; with `parts` (another device,
 * through the relay) it returns base64 `data` from `offset`, at most `PAGE_PART_BYTES` at a time, for files up to
 * `REMOTE_MEDIA_MAX_BYTES`, and the caller checks `version` stays the same.
 */
export async function room_media(home, raw, { trust = false, parts = false } = {}) {
  const { input, config } = await member_room_context(home, raw, { trust });
  const directories = room_directories(config);
  const root = input.root ?? 0;
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(root) || root < 0 || root >= Math.max(1, directories.length)) throw new Error('项目目录编号无效，请刷新后重试');
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('文件读取位置无效');
  const { file, ...media } = project_media(directories[root], input.path);
  if (!parts) return { room_id: input.room_id, root, ...media, file };
  if (media.size > REMOTE_MEDIA_MAX_BYTES) throw new Error(`文件 ${Math.ceil(media.size / 1024 / 1024)} MB，超过其他设备可播放的 ${REMOTE_MEDIA_MAX_BYTES / 1024 / 1024} MB 上限；请在这台电脑上打开`);
  const part = Buffer.alloc(Math.max(0, Math.min(PAGE_PART_BYTES, media.size - offset)));
  const handle = openSync(file, 'r');
  try { readSync(handle, part, 0, part.length, offset); } finally { closeSync(handle); }
  return { room_id: input.room_id, root, ...media, total: media.size, offset, data: part.toString('base64') };
}

/** `room-media` asked for by another device, answered inside the relay's own process in parts. */
export async function remote_room_media(home, input) {
  assert_shared_home(home);
  guard_remote_request('room-media', input, { projects: granted_projects(home), participants: launch_settings(home).participants, home });
  return room_media(home, input, { trust: true, parts: true });
}

/** `room-page` asked for by another device, answered inside the relay's own process in parts, like `remote_room_files`. */
export async function remote_room_page(home, input) {
  assert_shared_home(home);
  guard_remote_request('room-page', input, { projects: granted_projects(home), participants: launch_settings(home).participants, home });
  return room_page(home, input, { trust: true, parts: true });
}

// The newest part of a long-running execution's log is what its detail view needs; older lines are dropped.
const DETAIL_LOG_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * What a member did in one execution, rebuilt from the raw event log its process wrote in the room's runtime directory
 * (`<adapter>-free-<execution>.log`). The log stays on this computer: the page reads it here or through the relay.
 * `available: false` when the execution kept no such log (an App or manual member, or an API member).
 */
export async function execution_details_command(home, raw, { trust = false } = {}) {
  const { input, config } = await member_room_context(home, raw, { trust });
  // A private chat turn (`chat_id`) keeps its log the same way as an execution.
  const chat = input.chat_id !== undefined;
  const execution_id = Number(chat ? input.chat_id : input.execution_id);
  if (!Number.isSafeInteger(execution_id) || execution_id <= 0) throw new Error(chat ? '私聊编号无效' : '执行编号无效');
  const suffix = `-${chat ? 'chat' : 'free'}-${execution_id}.log`;
  const name = existsSync(config.directory) ? readdirSync(config.directory).find(file => file.endsWith(suffix)) : undefined;
  const parsed = name ? execution_details(name.slice(0, -suffix.length), read_log_tail(join(config.directory, name))) : null;
  return { room_id: input.room_id, [chat ? 'chat_id' : 'execution_id']: execution_id, available: Boolean(parsed), ...parsed };
}

/**
 * `execution-details` asked for by another device, answered inside the relay's own process like `remote_room_files`:
 * the private-chat page reads it for every turn and again every poll for a running one, so starting Node and asking
 * the site to check the credential each time made the page wait seconds for what is already on this computer.
 */
export async function remote_execution_details(home, input) {
  assert_shared_home(home);
  guard_remote_request('execution-details', input, { projects: granted_projects(home), participants: launch_settings(home).participants, home });
  return execution_details_command(home, input, { trust: true });
}

/** The last bytes of a log as text, starting at a whole line. */
function read_log_tail(path) {
  const size = statSync(path).size, length = Math.min(size, DETAIL_LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length), descriptor = openSync(path, 'r');
  try { readSync(descriptor, buffer, 0, length, size - length); } finally { closeSync(descriptor); }
  const text = buffer.toString('utf8');
  return length < size ? text.slice(text.indexOf('\n') + 1) : text;
}

const CREATE_PREFERENCE_RANGES = { max_rounds: [0, 100], max_minutes: [0, 1440], goal_max_continues: [0, 100], goal_max_minutes: [0, 1440], chain_rounds: [0, 100],
  api_max_requests: [0, MAX_API_MAX_REQUESTS] };
const CREATE_PREFERENCE_FLAGS = ['named_followup', 'host_workflows', 'advanced_open'];
const MAX_PREFERENCE_MODEL_LENGTH = 200;
const SETTINGS_LOCK_WAIT_MS = 5000;

/** Validate only reusable form choices; room text, members, paths and credentials are never preferences. */
function validate_create_preferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('建房偏好须为对象');
  for (const [field, value] of Object.entries(input)) {
    let valid = false;
    if (CREATE_PREFERENCE_FLAGS.includes(field)) valid = typeof value === 'boolean';
    else if (Object.hasOwn(CREATE_PREFERENCE_RANGES, field)) {
      const [minimum, maximum] = CREATE_PREFERENCE_RANGES[field];
      valid = Number.isInteger(value) && value >= minimum && value <= maximum;
    } else if (field === 'drive') valid = ['free', 'discussion', 'goal'].includes(value);
    else if (field === 'workflow_id') valid = typeof value === 'string' && (!value || WORKFLOW_ID_PATTERN.test(value));
    else if (field === 'scheduler') valid = valid_scheduler_preference(value);
    if (!valid) throw new Error(`建房偏好字段无效：${field}`);
  }
}

/** A scheduler preference carries selections, never a key or even a key reference. */
function valid_scheduler_preference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = {
    enabled: item => typeof item === 'boolean',
    provider: item => typeof item === 'string' && (!item || Object.hasOwn(SCHEDULER_PROVIDERS, item)),
    model: item => typeof item === 'string' && item.length <= MAX_PREFERENCE_MODEL_LENGTH,
    mode: item => typeof item === 'string' && (!item || Object.hasOwn(SCHEDULER_MODES, item)),
  };
  return Object.entries(value).every(([field, item]) => Object.hasOwn(fields, field) && fields[field](item));
}

/** Update software defaults or form preferences independently, preserving the other section. */
export function save_launch_settings(home, input) {
  const patch = {};
  if (Object.hasOwn(input, 'participants')) {
    const participants = {};
    for (const [name, profile] of Object.entries(input.participants || {})) {
      if (platform_of(name) !== name) throw new Error(`本机默认配置按平台保存；${name} 的模型与强度只用于本场讨论`);
      validate_profile(name, profile);
      participants[name] = profile;
    }
    patch.participants = participants;
  }
  if (Object.hasOwn(input, 'create_preferences')) {
    validate_create_preferences(input.create_preferences);
    patch.create_preferences = input.create_preferences;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(home, 'launch-settings-lock.sqlite3'));
  try {
    lock.exec(`PRAGMA busy_timeout=${SETTINGS_LOCK_WAIT_MS}; BEGIN IMMEDIATE`);
    const previous = launch_settings(home);
    const settings = { ...previous, ...patch };
    if (patch.create_preferences) settings.create_preferences = { ...previous.create_preferences, ...patch.create_preferences };
    atomic_json(join(home, 'launch-settings.json'), settings);
    lock.exec('COMMIT');
    return settings;
  } finally { lock.close(); }
}

const PROJECT_NAME_LIMIT = 80;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8,32}$/;

/** Read the named project directories saved on this computer, offered as launch cwd choices. */
export function launch_projects(home) {
  // An ordinary account's projects are the folders under its projects root; it keeps no list of its own.
  const { projects_root } = account_space(home);
  if (projects_root) return { projects: account_projects(projects_root), restricted: true };
  const path = join(home, 'launch-projects.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { projects: [] };
}

/** Replace the project list; every path must be an existing folder on this computer. */
// The id outlives renames and moves: other devices choose a project by id and never see its path.
export function save_launch_projects(home, input) {
  const { projects_root } = account_space(home);
  if (projects_root) {
    if (typeof input.create !== 'string') throw new Error('此账号的项目只能在自己的项目文件夹内新建：请提供 create（项目名称）');
    const created = create_account_project(projects_root, input.create);
    return { ...launch_projects(home), created };
  }
  if (!Array.isArray(input.projects)) throw new Error('projects 必须为列表');
  const projects = input.projects.map(item => ({ id: PROJECT_ID_PATTERN.test(item?.id) ? item.id : randomUUID().replaceAll('-', '').slice(0, 16),
    name: String(item?.name || '').trim(), path: String(item?.path || '').trim() }));
  const names = new Set();
  for (const { name, path } of projects) {
    if (!name || name.length > PROJECT_NAME_LIMIT) throw new Error(`项目名称不能为空，且不超过 ${PROJECT_NAME_LIMIT} 字`);
    if (names.has(name)) throw new Error(`项目名称重复：${name}`);
    names.add(name);
    if (!isAbsolute(path)) throw new Error(`${name}：路径必须为完整绝对路径`);
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${name}：这台电脑上不存在此文件夹：${path}`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, 'launch-projects.json'), { projects });
  return { projects };
}

const MAX_EXPERT_PRESETS = 30;
const MAX_PRESET_DESCRIPTION = 500;
const MAX_PRESET_FIELD = 200;
// name is the instance a preset adds (platform-suffix); label is the free name shown for it, on the add row and in the room.
const PRESET_FIELDS = ['name', 'label', 'description', 'system_prompt', 'project_access', 'model', 'effort'];
const MAX_PRESET_LABEL = 32;

/**
 * Presets saved while IDs could hold Chinese: such an ID becomes `platform-presetN` and its old name the label, so the
 * add row still shows it. The next save keeps the new form.
 */
function english_preset_ids(presets) {
  const taken = new Set(presets.map(preset => preset.name));
  return presets.map(preset => {
    const platform = /^(Codex|Claude|Antigravity|DeepSeek|Qwen|Grok|OpenAI|Custom)(?:-|$)/.exec(preset.name || '')?.[1];
    if (!platform || platform_of(preset.name)) return preset;
    let number = 1;
    while (taken.has(`${platform}-preset${number}`)) number++;
    const name = `${platform}-preset${number}`;
    taken.add(name);
    return { ...preset, name, label: preset.label || preset.name };
  });
}

/** The user's expert presets and per-platform default descriptions saved on this computer, plus the built-in presets the user has not deleted. */
export function expert_presets(home) {
  const path = join(home, 'expert-presets.json');
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const hidden_builtins = saved.hidden_builtins || [];
  // A preset saved while members drew with their own image model keeps the rest; drawing is the room's switch now.
  const presets = (saved.presets || []).map(({ image_model, ...preset }) => preset);
  return { presets: english_preset_ids(presets), description_templates: saved.description_templates || {}, hidden_builtins,
    builtin_presets: BUILTIN_EXPERT_PRESETS.filter(preset => !hidden_builtins.includes(preset.name)) };
}

/** Check one expert preset; a workflow's agent card is a preset and obeys the same rule. */
export function validate_preset(preset) {
  if (!preset || typeof preset !== 'object' || Object.keys(preset).some(key => !PRESET_FIELDS.includes(key))) throw new Error('预设只能包含名称、显示名、描述、提示词、项目权限、模型与强度');
  if (!platform_of(preset.name) || !clients_of(preset.name)) throw new Error(`预设 ID 须为“平台名”或“平台名-后缀”，后缀只用英文、数字和下划线：${preset.name}`);
  if (Object.values(preset).some(value => typeof value !== 'string')) throw new Error(`${preset.name} 的字段必须为文本`);
  if ((preset.label || '').trim().length > MAX_PRESET_LABEL) throw new Error(`${preset.name} 的显示名最多 ${MAX_PRESET_LABEL} 字`);
  if ((preset.description || '').length > MAX_PRESET_DESCRIPTION) throw new Error(`${preset.name} 的描述最多 ${MAX_PRESET_DESCRIPTION} 字`);
  if ((preset.system_prompt || '').length > MAX_EXPERT_PROMPT) throw new Error(`${preset.name} 的提示词最多 ${MAX_EXPERT_PROMPT} 字`);
  if (preset.project_access && !PROJECT_ACCESS.includes(preset.project_access)) throw new Error(`${preset.name} 的项目权限须为 read、write、auto 或 full`);
  if ([preset.model, preset.effort].some(value => (value || '').length > MAX_PRESET_FIELD)) throw new Error(`${preset.name} 的模型或强度过长`);
}

/** Replace the user's presets, default descriptions or deleted built-ins (whichever the input carries); every field is checked first. */
export function save_expert_presets(home, input) {
  const current = expert_presets(home);
  const presets = input.presets === undefined ? current.presets : input.presets;
  const templates = input.description_templates === undefined ? current.description_templates : input.description_templates;
  const hidden_builtins = input.hidden_builtins === undefined ? current.hidden_builtins : input.hidden_builtins;
  const builtin_names = BUILTIN_EXPERT_PRESETS.map(preset => preset.name);
  if (!Array.isArray(hidden_builtins) || hidden_builtins.some(name => !builtin_names.includes(name))) throw new Error(`hidden_builtins 只能列出内置预设：${builtin_names.join('、')}`);
  if (!Array.isArray(presets) || presets.length > MAX_EXPERT_PRESETS) throw new Error(`presets 必须为列表，最多 ${MAX_EXPERT_PRESETS} 个`);
  const names = new Set();
  for (const preset of presets) {
    validate_preset(preset);
    if (names.has(preset.name)) throw new Error(`预设名称重复：${preset.name}`);
    names.add(preset.name);
  }
  if (!templates || typeof templates !== 'object' || Array.isArray(templates) || Object.entries(templates).some(([platform, text]) =>
    platform_of(platform) !== platform || typeof text !== 'string' || !text.trim() || text.length > MAX_PRESET_DESCRIPTION)) {
    throw new Error(`description_templates 须为 {平台名: 描述}，每段 1–${MAX_PRESET_DESCRIPTION} 字`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, 'expert-presets.json'), { presets, description_templates: templates, hidden_builtins });
  return expert_presets(home);
}

/** Reject malformed client fields before saving defaults or creating any discussion. */
function validate_profile(name, profile, binding = false) {
  if (!clients_of(name) || !profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`不支持的软件配置：${name}`);
  if (profile.adapter && !clients_of(name).includes(profile.adapter)) throw new Error(`${name} 的客户端不匹配`);
  // Session bindings and project write access apply to one launch only, never to machine defaults.
  const fields = binding ? [...PROFILE_FIELDS, 'session_id', 'project_access'] : PROFILE_FIELDS;
  if (Object.keys(profile).some(key => !fields.includes(key))) throw new Error('软件配置包含不支持的字段；默认配置不能保存房间或会话绑定');
  for (const [key, value] of Object.entries(profile)) {
    if (key === 'allowed_tools') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${name}.allowed_tools 必须为工具名称数组`);
    } else if (typeof value !== 'string') throw new Error(`${name}.${key} 必须为文本`);
    if (['executable', 'cwd', 'ipc_directory'].includes(key) && value && !isAbsolute(value)) throw new Error(`${name}.${key} 必须为完整绝对路径`);
    // The model is passed as one CLI argument, so it must not look like a flag or contain spaces.
    if (key === 'model' && value && !/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/.test(value)) throw new Error(`${name}.${key} 只能是模型名称，例如 gpt-6-astra、opus 或 gemini-4-argon-high`);
    if (key === 'system_prompt' && value.length > MAX_EXPERT_PROMPT) throw new Error(`${name} 的专属提示词最多 ${MAX_EXPERT_PROMPT} 字`);
  }
  const facts = adapter_profile(profile.adapter);
  if (facts?.kind === 'api') validate_api_profile(profile);
  // The UI discovers each model's supported subset; omitted values keep the CLI's own default.
  if (profile.effort && facts?.kind !== 'api' && !facts?.efforts?.includes(profile.effort)) {
    throw new Error(facts?.efforts ? `${name}.effort 只能是 ${facts.efforts.join(' / ')}` : `${name} 的思考档位在原软件中选择`);
  }
}

/** Send one request without following redirects that could disclose the room credential. */
async function site_request(site, path, token, body, headers = {}) {
  const response = await fetch(`${site}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/** Require an explicit website, launch entry and stable creation identity. */
function launch_input(input) {
  const value = structuredClone(input);
  const url = new URL(value.site);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('site 必须为 HTTP(S) 根地址');
  value.site = url.origin;
  if (!['conversation', 'web'].includes(value.entry)) throw new Error('entry 必须为 conversation 或 web');
  if (value.entry === 'conversation' && (typeof value.current_session_id !== 'string' || !value.current_session_id.trim())) throw new Error('对话入口须提供当前实际会话的 current_session_id');
  if (value.cwd && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) throw new Error('cwd 必须为完整绝对路径');
  // A new room's extra project directories; an existing room changes them through room-settings.
  if (!value.room_id && value.extra_directories?.length) check_extra_directories(value.cwd, value.extra_directories);
  else if (!value.room_id) delete value.extra_directories;
  if (value.project_access && !PROJECT_ACCESS.includes(value.project_access)) throw new Error('project_access 只能为 read、write、auto 或 full');
  if (value.room_id && !/^[A-Za-z0-9_-]+$/.test(value.room_id)) throw new Error('房间编号无效');
  if (!value.room_id && !value.room?.submission_id) throw new Error('新房间须提供 room.submission_id；重试沿用原编号');
  if (value.room?.mode === 'free') {
    // P1: a free room is launched once, at creation, from the web page.
    if (value.entry !== 'web' || value.room_id) throw new Error('房间目前只能在网页创建时启动');
    const members = value.room.members;
    const names = members?.map(member => typeof member === 'string' ? member : member.name);
    const woken = Array.isArray(members) ? members.filter(woken_member).map(member => typeof member === 'string' ? member : member.name) : [];
    if ((!woken.length && !value.scheduler && !value.cwd) || !names?.length || new Set(names).size !== names.length || woken.some(name => !clients_of(name))) {
      throw new Error('房间须选择至少 1 位支持自动接入的 AI 成员（或开启智能调度、指定项目目录），且不能重复');
    }
  }
  if (value.access_file) {
    const access = JSON.parse(readFileSync(resolve(value.access_file), 'utf8'));
    if (access.site?.replace(/\/$/, '') !== value.site || access.room !== value.room_id) throw new Error('access_file 与本次站点或房间不符');
    value.token = access.token;
  }
  return value;
}

/** Discussion experts the member list marks as manual: they answer with their own credential and need no local software. */
function manual_experts(room) {
  return new Set((room.members || []).filter(member => member && typeof member === 'object' && member.access === 'manual').map(member => member.name));
}

/** Merge machine defaults and explicit room overrides, preserving the selected participants. */
function launch_config(home, input, room, directory, options) {
  // In a creation input, mode='free' means no immediate discussion; omitted mode still requests a hosted discussion.
  if (room.mode === 'free') return free_launch_config(home, input, room, directory, options);
  if (!clients_of(room.host)) throw new Error('请选择支持全自动讨论的 AI 主持人');
  if (!room.experts || room.experts[room.host] !== 'cli') throw new Error('请将 AI 主持人的参与方式设为本地读写');
  const other = Object.entries(room.experts).filter(([, mode]) => mode !== 'cli').map(([name]) => name);
  if (other.length) throw new Error(`全自动讨论的参与方式须为本地读写：${other.join('、')}`);
  const defaults = options.defaults || launch_settings(home).participants;
  const manual = manual_experts(room);
  if (manual.has(room.host)) throw new Error('AI 主持人由本机服务续接，不能选择手动接入');
  const participants = {};
  for (const name of new Set([room.host, ...Object.keys(room.experts)])) {
    if (!manual.has(name)) participants[name] = participant_profile(name, defaults, input, name === room.host);
  }
  const members = launch_members(input, Object.keys(participants), options);
  return validate_config({ site: input.site, room: room.id || 'preview', token: options.token, mode: 'free', participants, members, api_home: home,
    scheduler: input.scheduler || undefined,
    cwd: input.cwd, extra_directories: input.extra_directories, discussion_project: input.discussion_project, project_access: input.project_access || undefined,
    data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) }, directory);
}

/** A free-room member the local service wakes; manual members join without local configuration. */
function woken_member(member) { return typeof member === 'string' || !member.access || member.access === 'runner'; }

/** Free rooms add one private credential per woken member, kept with the room configuration for retries. */
function free_launch_config(home, input, room, directory, options) {
  const defaults = options.defaults || launch_settings(home).participants;
  const names = room.members.filter(woken_member).map(member => typeof member === 'string' ? member : member.name);
  const participants = Object.fromEntries(names.map(name => [name, participant_profile(name, defaults, input, false)]));
  const members = launch_members(input, names, options);
  // A workflow chosen at creation is written with the members, so the first wake already carries it.
  const workflow = input.workflow ? bind_room_workflow({}, { ...input.workflow, enabled: true }).workflow : undefined;
  if (workflow) { get_workflow(home, workflow.id); assert_workflow_enabled(home, workflow.id); }
  if (workflow && Object.values(workflow.members).some(name => !names.includes(name))) throw new Error('工作流成员须在本次邀请的成员中');
  return validate_config({ site: input.site, room: room.id || 'preview', token: options.token, mode: 'free', participants, members, api_home: home,
    scheduler: input.scheduler || undefined, cwd: input.cwd, extra_directories: input.extra_directories, project_access: input.project_access || undefined, workflow,
    host_workflows: input.host_workflows === true || undefined, api_max_requests: input.api_max_requests,
    image_generation: input.image_generation === true || undefined,
    data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) }, directory);
}

/** Members in the order of the creation form's cards, so the room's joining order (and default speaking order) follows it. */
function card_order(cards, members) {
  const names = (cards || []).map(member => typeof member === 'string' ? member : member?.name);
  const place = (name) => names.includes(name) ? names.indexOf(name) : names.length;
  return [...members].sort((left, right) => place(left.name) - place(right.name));
}

/** Preserve caller-generated member credentials; journal newly generated ones before creation. */
function launch_members(input, names, options) {
  return Object.fromEntries(names.map(name => {
    const supplied = input.room?.members?.find(member => member?.name === name);
    return [name, { token: supplied?.token || options.members?.[name]?.token || `${randomUUID()}${randomUUID()}` }];
  }));
}

/**
 * Merge one participant's machine defaults with this launch's overrides and check its software. A launch from another
 * device (`input.without_saved_tools`) takes no tool approvals saved here, whichever way its members are named.
 */
export function participant_profile(name, defaults, input, current_host) {
  const platform = platform_of(name);
  // An extra instance starts from its platform's settings but never from another instance's bound session.
  const { session_id: ignored_session, ...inherited } = name === platform ? {} : input.participants?.[platform] || {};
  const saved = { ...defaults[platform], ...(name === platform ? {} : defaults[name]) };
  if (input.without_saved_tools) delete saved.allowed_tools;
  const profile = { ...saved, ...inherited, ...input.participants?.[name] };
  for (const field of ['cwd', 'model', 'effort', 'project_name', 'project_id', 'project_access']) if (profile[field] === '') delete profile[field];
  validate_profile(name, profile, true);
  if (!clients_of(name)?.includes(profile.adapter)) throw new Error(`请配置 ${name} 的 CLI / App 客户端`);
  const facts = adapter_profile(profile.adapter);
  if (facts?.kind === 'api') {
    if (input.entry === 'conversation' && current_host) throw new Error('API 主持人请从网页启动；当前软件会话主持须选择对应 CLI / App');
    return profile;
  }
  if (facts?.location === 'executable' && (!existsSync(profile.executable || '') || !statSync(profile.executable).isFile()
    || (process.platform === 'win32' && !/\.exe$/i.test(profile.executable)))) throw new Error(`${name}：请指定实际原生可执行文件，Windows 使用 .exe`);
  const cwd = profile.cwd || input.cwd;
  if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new Error(`${name}：工作目录不存在或不是文件夹，请核对本次目录配置`);
  if (input.entry === 'conversation' && current_host) profile.session_id = input.current_session_id;
  // A new agy conversation always gets this tool's discussion project; only a manual agy expert the owner chose to host (input.adopt) keeps its own.
  if (!facts?.host_existing && profile.session_id && !input.adopt) throw new Error(`${name}：${facts?.label || profile.adapter} 不能绑定已有会话或从当前对话主持全自动讨论；请从网页或其他软件发起，它会由讨论服务新建会话`);
  return profile;
}

/** List every file below a directory, or nothing when the software has never stored a session there. */
function session_files(directory) {
  return existsSync(directory) ? readdirSync(directory, { recursive: true }).map(path => join(directory, String(path))) : [];
}

/** Compare directories as the operating system resolves them (Windows short names and case). */
function same_directory(left, right) {
  const real = path => { try { return realpathSync.native(path); } catch { return resolve(path); } };
  const [a, b] = [real(left), real(right)];
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Prove an invited existing conversation is on this machine before it can hold a turn, so a mistyped ID
 * fails here instead of pausing the discussion later. Claude stores sessions per directory and resumes only
 * from the original one, so its cwd follows the session: a session kept elsewhere than the room's project joins as a
 * member working in its own directory (it only reads the room's directories); only a directory the member's own
 * settings name explicitly must match.
 */
export function borrowed_session(name, profile, room_cwd, env = process.env) {
  const id = profile.session_id;
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`${name}：会话 ID 格式不正确`);
  const adapter = adapter_of(profile.adapter);
  if (!adapter?.adopt || !adapter.session) {
    const adoptable = ADAPTER_IDS.filter(item => ADAPTER_PROFILES[item].adopt).map(item => ADAPTER_PROFILES[item].label);
    throw new Error(`${name}：只有 ${adoptable.join('、')} 可以接入已有会话`);
  }
  if (!adapter.session.exists(id, { env })) throw new Error(`${name}：本机找不到 ${adapter.label} 会话 ${id}，请核对会话 ID`);
  if (adapter.adopt !== 'own_cwd') return profile;
  const cwd = adapter.session.cwd(id, { env });
  if (!cwd) throw new Error(`${name}：${adapter.label} 会话 ${id} 没有记录原工作目录，无法续接`);
  if (profile.cwd && !same_directory(profile.cwd, cwd)) throw new Error(`${name}：这个 ${adapter.label} 会话属于 ${cwd}，只能在原目录续接；请让此 AI 的工作目录与它一致，或留空会话 ID 新建会话`);
  return { ...profile, cwd: profile.cwd || (room_cwd && same_directory(room_cwd, cwd) ? room_cwd : cwd) };
}

// An owner credential the website accepted is trusted this long for read-only file browsing in a long-running process
// (the relay), so each folder opened from another device does not ask the website again.
const ROOM_FILES_TRUST_MS = 60000;
const trusted_room_tokens = new Map();

/** Find the one registered configuration of a room after proving the owner's credential; `trust` reuses a recent proof. */
async function member_room_context(home, raw, { trust = false } = {}) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim()) throw new Error('管理成员须提供房间编号和房间控制凭据');
  const paths = read_registry(home).filter(path => {
    const identity = registered_identity(path);
    return identity?.site === input.site && identity.room === input.room_id;
  });
  if (paths.length !== 1) throw new Error('未找到本房间唯一的已登记配置，请核对本机接入服务');
  const config = configuration_snapshot(paths[0]).config;
  const proof = `${input.site}
${input.room_id}
${createHash('sha256').update(input.token).digest('hex')}`;
  if (!trust || !(Date.now() - (trusted_room_tokens.get(proof) ?? -Infinity) < ROOM_FILES_TRUST_MS)) {
    // Both reads need the owner credential; the inbox transfers no messages.
    await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
    trusted_room_tokens.set(proof, Date.now());
  }
  return { input, path: paths[0], config };
}

/** Write a manual member's private credential next to the room configuration, never into a receipt. */
function manual_access(path, input, name, token) {
  const access_path = join(dirname(path), `manual-${name}.access.json`);
  atomic_json(access_path, { site: input.site, room: input.room_id, member: name, token });
  return access_path;
}

/**
 * Invite (add) or bring back (rejoin) one member of a room.
 * The local configuration is written before the website call, so a retry reuses the same credential.
 * A manual member answers with its own credential and is never woken.
 */
export async function room_member(home, raw, locked = false, headers = {}) {
  const { input, path } = await member_room_context(home, raw);
  const { action, name } = input;
  const access = input.access || 'runner';
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  if (!['add', 'rejoin'].includes(action) || !platform_of(name) || (access !== 'manual' && !clients_of(name)) || !['runner', 'manual'].includes(access)) {
    throw new Error('action 须为 add/rejoin，成员须为支持的 AI，接入方式须为 runner/manual');
  }
  const release = locked ? () => {} : acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    config.api_home = home;
    const roster = room.free.members;
    if (action === 'add' && input.new_instance) {
      // A name once bound keeps its session locally, so a new instance never reuses a removed member's name.
      const taken = new Set([...roster.map(member => member.name), ...Object.keys(config.participants), ...Object.keys(config.members || {})]);
      return room_member(home, { ...raw, name: next_instance(platform_of(name), taken), new_instance: false }, true, headers);
    }
    const current = roster.find(member => member.name === name);
    if (input.member_token !== undefined && (typeof input.member_token !== 'string' || input.member_token.length < 32 || input.member_token.length > 256)) throw new Error('member_token 须为 32–256 字符');
    if (current?.status === 'active' && input.member_token && config.members?.[name]?.token === input.member_token) {
      const view = await site_request(input.site, `/api/rooms/${input.room_id}/members/${current.id}`, input.token, { action: 'active', token: input.member_token }, headers);
      return { room_id: input.room_id, member: name, access: current.access, free: view, access_file: null };
    }
    if (action === 'add' && !current && config.participants[name] && !locked) {
      // A removed member's name keeps its bound session locally, so the new one joins under the next free name; a retry
      // finds the name its own credential was saved under.
      const taken = new Set([...roster.map(member => member.name), ...Object.keys(config.participants), ...Object.keys(config.members || {})]);
      const retried = Object.keys(config.members || {}).find(key => key !== name && input.member_token && config.members[key].token === input.member_token
        && !roster.some(member => member.name === key));
      const renamed = retried || free_instance(name, taken);
      const participants = raw.participants?.[name] ? { participants: { ...raw.participants, [renamed]: raw.participants[name] } } : {};
      return room_member(home, { ...raw, name: renamed, ...participants }, true, headers);
    }
    if (action === 'rejoin' && current?.status !== 'away') throw new Error(`${name} 不是离开状态，无需请回`);
    if (action === 'add' && current) throw new Error(`${name} 已是本房间成员；离开的成员请用请回`);
    const manual = action === 'rejoin' ? current.access === 'manual' : access === 'manual';
    const pending = input.retry_token && config.members?.[name]?.pending === input.retry_token;
    const token = input.member_token || (pending ? config.members[name].token : `${randomUUID()}${randomUUID()}`);
    let profile = config.participants[name];
    if (!manual) {
      if (action === 'add') {
        profile = participant_profile(name, launch_settings(home).participants, { ...input, cwd: input.cwd || config.cwd }, false);
        if (profile.session_id) profile = borrowed_session(name, profile, input.cwd || config.cwd);
      }
      if (!profile) throw new Error(`${name} 没有本机接入配置；请移除后重新邀请`);
      const next = { ...config, participants: { ...config.participants, [name]: profile },
        members: { ...config.members, [name]: { token, pending: input.retry_token || '' } } };
      validate_config(next, dirname(path));
      atomic_json(path, next);
    }
    const access_file = manual ? manual_access(path, input, name, token) : null;
    const body = action === 'add'
      ? { name, adapter: manual ? '' : profile.adapter, token, access, session_mode: profile?.session_id ? 'borrowed' : 'new' }
      : { action: 'active', token };
    const view = await site_request(input.site, action === 'add' ? `/api/rooms/${input.room_id}/members` : `/api/rooms/${input.room_id}/members/${current.id}`,
      input.token, body, headers);
    return { room_id: input.room_id, member: name, access: manual ? 'manual' : 'runner', free: view, access_file };
  } finally { release(); }
}


/**
 * Change this room's runner settings, any of: `api_max_requests`, how many model requests one execution of an API member
 * may make (0 = no limit); `cwd`, the main project directory, accepted only while the room has none (once set it never
 * changes: sessions and file-change tracking are bound to it); `extra_directories`, the project directories shared
 * besides the main one, replaced as a whole. Members already in a room that gets its main directory keep working where
 * their sessions are (their `cwd` is pinned to '') and reach the room's directories as extra ones; members invited later
 * work in it; `image_generation`, whether members may draw with this computer's image service; `scheduler`, the room's
 * smart scheduling ({provider, model, api_key_ref, mode}, or null to turn it off), picked up by the running service at
 * its next tick. Everything is read at each delivery, so it applies from the next execution and keeps every session.
 */
export async function room_settings(home, raw) {
  const { input, path } = await member_room_context(home, raw);
  const { api_max_requests: requests, extra_directories: directories, cwd, image_generation: images, scheduler } = input;
  if (requests === undefined && directories === undefined && cwd === undefined && images === undefined && scheduler === undefined) throw new Error('须提供 api_max_requests、image_generation、scheduler、cwd 或 extra_directories');
  if (scheduler !== undefined && scheduler !== null && (typeof scheduler !== 'object' || Array.isArray(scheduler))) throw new Error('scheduler 须为智能调度配置或 null');
  if (requests !== undefined && !Number.isInteger(requests)) throw new Error('api_max_requests 须为整数');
  if (images !== undefined && typeof images !== 'boolean') throw new Error('image_generation 须为 true 或 false');
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const next = { ...config, ...(requests !== undefined ? { api_max_requests: requests } : {}), ...(images !== undefined ? { image_generation: images } : {}) };
    // Off is written as null, not dropped, so the running service's merge of the new configuration turns it off too.
    if (scheduler !== undefined) next.scheduler = scheduler && { provider: scheduler.provider, model: scheduler.model, api_key_ref: scheduler.api_key_ref, ...(scheduler.mode ? { mode: scheduler.mode } : {}) };
    if (cwd !== undefined) {
      if (config.cwd) throw new Error('本房间已有项目目录，建房后不能更改；可添加其他项目目录');
      if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('项目目录须为本机已有文件夹的完整路径');
      next.cwd = cwd;
      next.participants = Object.fromEntries(Object.entries(config.participants || {}).map(([name, profile]) => [name, { ...profile, cwd: profile.cwd ?? '' }]));
    }
    if (directories !== undefined) {
      check_extra_directories(next.cwd, directories);
      next.extra_directories = directories.length ? directories : undefined;
    }
    validate_config(next, dirname(path));
    atomic_json(path, next);
    return { room_id: input.room_id, ...(requests !== undefined ? { api_max_requests: requests } : {}), ...(images !== undefined ? { image_generation: images } : {}),
      ...(scheduler !== undefined ? { scheduler: next.scheduler ? { provider: next.scheduler.provider, model: next.scheduler.model, mode: next.scheduler.mode || DEFAULT_SCHEDULER_MODE } : null } : {}),
      ...(cwd !== undefined ? { project_directory: cwd } : {}), ...(directories !== undefined ? { extra_directories: directories } : {}) };
  } finally { release(); }
}

/**
 * Switch one woken member's project files between read-only and writable after the room is created. Every run builds its
 * permissions from the configuration, so the change applies from the member's next delivery and keeps its session.
 */
export async function room_member_access(home, raw) {
  const { input, path } = await member_room_context(home, raw);
  const { name, project_access } = input;
  if (!PROJECT_ACCESS.includes(project_access)) throw new Error('project_access 只能为 read、write、auto 或 full');
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const profile = config.participants?.[name];
    if (!profile) throw new Error(`${name} 不由本机唤醒，项目权限由它自己的会话决定`);
    if (profile.project_access === 'own') throw new Error(`${name} 是手动接入的成员，权限沿用它自己会话的软件设置`);
    const facts = adapter_profile(profile.adapter);
    // A CLI's project access is set per run; an App follows its own settings and an API member only reads.
    if (!facts?.access_levels) throw new Error(!facts?.capabilities.project ? `${name} 没有本机文件工具，项目固定只读` : `${name} 的项目权限在 App 内设置`);
    if (!facts.access_levels.includes(project_access)) throw new Error(facts.unsupported_hints?.[project_access] || `${facts.label} 不支持此档位`);
    if (facts.own_project_when_bound && profile.session_id) throw new Error(`${name} 续接的是它自己的 ${facts.label} 对话，项目权限沿用该对话所在项目，请在原软件中设置`);
    if (project_access === 'write' && !(profile.cwd || config.cwd)) throw new Error('本房间没有指定项目目录，可写没有作用；请在新建房间时选择项目目录');
    const next = { ...config, participants: { ...config.participants, [name]: { ...profile, project_access } } };
    validate_config(next, dirname(path));
    atomic_json(path, next);
    return { room_id: input.room_id, member: name, project_access };
  } finally { release(); }
}

/**
 * Change a woken CLI or API member's model and thinking effort after the room is created. Each run passes them to the
 * software, and neither is part of the member's session context, so the change applies from its next delivery and keeps
 * its session. An empty value goes back to the software's default; an API member has no default model, so an empty
 * model keeps its current one.
 */
export async function room_member_model(home, raw) {
  const { input, path } = await member_room_context(home, raw);
  const { name } = input;
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const effort = typeof input.effort === 'string' ? input.effort.trim() : '';
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const profile = config.participants?.[name];
    if (!profile) throw new Error(`${name} 不由本机唤醒，模型由它自己的会话决定`);
    if (profile.project_access === 'own') throw new Error(`${name} 是手动接入的成员，模型与强度沿用它自己会话的设置`);
    const facts = adapter_profile(profile.adapter);
    // An App chooses its model and effort in its own window; a CLI or API member's run is started with them.
    if (!facts || facts.kind === 'app') throw new Error(`${name} 的模型在 ${facts?.label || '它的软件'} 内设置`);
    if (effort && !facts.efforts?.includes(effort)) {
      throw new Error(`${facts.label} 不支持思考强度 ${effort}${facts.efforts ? `，可选 ${facts.efforts.join(' / ')}` : ''}`);
    }
    const next = { ...profile, model: model || (facts.kind === 'api' ? profile.model : ''), effort };
    if (!next.model) delete next.model;
    if (!effort) delete next.effort;
    const updated = { ...config, participants: { ...config.participants, [name]: next } };
    validate_config(updated, dirname(path));
    atomic_json(path, updated);
    return { room_id: input.room_id, member: name, model: next.model || '', effort };
  } finally { release(); }
}

const MAX_ALLOWED_TOOLS = 50;

/**
 * Allow operations a woken member's software refused, by adding the rules the runner reported with them to its
 * `allowed_tools`: Claude passes them to `--allowedTools`, agy adds them to its discussion project's grants. Like the
 * project access, they apply from the member's next delivery and keep its session.
 */
export async function room_member_allow(home, raw) {
  const { input, path } = await member_room_context(home, raw);
  const { name, rules } = input;
  if (!Array.isArray(rules) || !rules.length || rules.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 300)) {
    throw new Error('rules 须为要放行的规则列表');
  }
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const profile = config.participants?.[name];
    if (!profile) throw new Error(`${name} 不由本机唤醒，权限由它自己的会话决定`);
    const facts = adapter_profile(profile.adapter);
    if (!facts?.per_tool_allow) throw new Error(`${name} 的软件不支持逐条放行，请改用更高的权限档位`);
    if (facts.own_project_when_bound && profile.session_id) throw new Error(`${name} 续接的是它自己的 ${facts.label} 对话，权限沿用该对话所在项目，请在原软件中设置`);
    const allowed_tools = [...new Set([...(profile.allowed_tools || []), ...rules.map(rule => rule.trim())])];
    if (allowed_tools.length > MAX_ALLOWED_TOOLS) throw new Error(`每位成员最多放行 ${MAX_ALLOWED_TOOLS} 条规则`);
    const next = { ...config, participants: { ...config.participants, [name]: { ...profile, allowed_tools } } };
    validate_config(next, dirname(path));
    atomic_json(path, next);
    return { room_id: input.room_id, member: name, allowed_tools };
  } finally { release(); }
}

/**
 * Switch an idle free-room Codex member between the App and the CLI, keeping its conversation: the App resumes the
 * bound chat by its session, and the CLI resumes it only after the App has released it. Model and effort are chosen
 * in the App, so switching to it drops them.
 */
export async function room_member_adapter(home, raw) {
  const { input, path } = await member_room_context(home, raw);
  const { name, adapter } = input;
  if (!ADAPTER_IDS.some(other => same_session_family(other, adapter))) throw new Error('只能在共用会话的 App 与 CLI 接入之间切换');
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  const member = room.free.members.find(item => item.name === name);
  if (member?.pending > 0 || ['dispatched', 'started'].includes(member?.execution?.status)) throw new Error(`${name} 正在处理请求，请等它完成或先停止`);
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const profile = config.participants?.[name];
    if (profile?.adapter !== adapter && !same_session_family(profile?.adapter, adapter)) throw new Error(`${name} 不是本机唤醒、能切换到该接入方式的成员`);
    if (profile.adapter === adapter) return { room_id: input.room_id, member: name, adapter };
    const context = { config, path };
    const next = { ...profile };
    switch_codex_adapter(context, name, next, adapter);
    // An App chooses its own model and effort.
    if (!adapter_profile(adapter).models) delete next.model;
    if (!adapter_profile(adapter).efforts) delete next.effort;
    const updated = { ...config, participants: { ...config.participants, [name]: next } };
    validate_config(updated, dirname(path));
    atomic_json(path, updated);
    return { room_id: input.room_id, member: name, adapter };
  } finally { release(); }
}

/**
 * Register a manual Claude, Codex or agy expert's own session as a hosted participant, so the service resumes it for later turns.
 * Returns the adapter used. Throws when the local software is not configured or the session is not found on this machine; the member then stays manual.
 */
export function adopt_member_profile(home, path, name, session_id, client, member_token) {
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    // The adapter whose store holds the session: a desktop chat is resumed through its App, others through the CLI.
    const adapter = adoption_adapter(client, session_id);
    if (!adapter) throw new Error(`${name}：本机不能接管 ${client} 的会话`);
    // An App conversation is reached through this room's own Sidecar, which the App starts as soon as it is configured.
    const sidecar = adapter_profile(adapter).location === 'ipc_directory' ? { ipc_directory: join(dirname(path), 'agy-app-sidecar') } : {};
    // A manually started member keeps its own session's permissions; the room's 只读 / 可写 does not apply to it.
    const input = { cwd: config.cwd, adopt: true, participants: { [name]: { adapter, session_id, project_access: 'own', ...sidecar } } };
    // Its model, effort, prompt and tools stay as the user set them in that session; machine defaults never override them.
    const { model, effort, allowed_tools, system_prompt, ...own } = participant_profile(name, launch_settings(home).participants, input, false);
    const profile = borrowed_session(name, own, config.cwd);
    if (sidecar.ipc_directory) setup_sidecar(sidecar);
    // A room delivers with each member's own credential; the browser-made one is not kept locally, so the owner issues a new one.
    const next = { ...config, participants: { ...config.participants, [name]: profile },
      members: { ...config.members, [name]: { token: member_token, pending: '' } } };
    validate_config(next, dirname(path));
    atomic_json(path, next);
    return adapter;
  } finally { release(); }
}

/** The one registered configuration of a room on this machine, or null when it was never registered here. */
function registered_room_path(home, site, room_id) {
  const paths = read_registry(home).filter(path => {
    const identity = registered_identity(path);
    return identity?.site === site && identity.room === room_id;
  });
  if (paths.length > 1) throw new Error('本房间存在多份登记配置，无法确定成员会话');
  return paths[0] || null;
}

/** The session each participant actually resumes, read without writing to a runtime the service may be using. */
function bound_sessions(config, path) {
  const file = join(resolve(config.data_directory || join(dirname(path), `discussion-${config.room}`)), 'runtime.sqlite3');
  if (!existsSync(file)) return {};
  const db = new DatabaseSync(file, { readOnly: true });
  try { return Object.fromEntries(db.prepare('SELECT participant,session_id FROM bindings').all().map(row => [row.participant, row.session_id])); }
  finally { db.close(); }
}

/**
 * Export a room's local member software and the sessions they hold, so a backup imported on this machine resumes them.
 * Requires the owner's credential; member credentials and API keys are never included (only the key reference).
 * Returns `local_members: null` when the room is not registered here.
 */
export async function room_profiles(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim()) throw new Error('导出本机成员配置须提供房间编号和房间控制凭据');
  const path = registered_room_path(home, input.site, input.room_id);
  if (!path) return { room_id: input.room_id, local_members: null };
  const config = configuration_snapshot(path).config;
  await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
  const sessions = bound_sessions(config, path);
  const participants = Object.fromEntries(Object.entries(config.participants).map(([name, profile]) => {
    const kept = Object.fromEntries(Object.entries(profile).filter(([key]) => [...PROFILE_FIELDS, 'project_access'].includes(key)));
    const session_id = sessions[name] || profile.session_id;
    return [name, session_id ? { ...kept, session_id } : kept];
  }));
  return { room_id: input.room_id, local_members: { format: LOCAL_MEMBERS_FORMAT, version: 1, mode: 'free',
    cwd: config.cwd, discussion_project: config.discussion_project, project_access: config.project_access, scheduler: config.scheduler,
    workflow: config.workflow, participants } };
}

/**
 * Register an imported free room on this machine with its exported member software, each member resuming its original session.
 * A session or software missing here fails that member instead of starting a new conversation. Claude Code members stay manual,
 * and are never taken over, because a background resume forks the session away from its original window.
 * Returns `{room_id, registered, members: [{name, status: resumed|manual|failed, session_id?, cwd?, error?}]}`.
 */
export async function restore_room(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  const local = input.local_members;
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim()) throw new Error('恢复本机成员须提供房间编号和房间控制凭据');
  if (local?.format !== LOCAL_MEMBERS_FORMAT || local.version !== 1 || !local.participants || typeof local.participants !== 'object') throw new Error('本机成员配置格式无效');
  await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  if (registered_room_path(home, input.site, input.room_id)) throw new Error('本房间已在本机登记，不重复恢复');
  if (local.cwd && (!isAbsolute(local.cwd) || !existsSync(local.cwd) || !statSync(local.cwd).isDirectory())) throw new Error(`房间项目目录 ${local.cwd} 在本机不存在`);
  const keep_manual = room.free.members.filter(member => member.access === 'manual' && member.status !== 'removed'
    && platform_adapters(platform_of(member.name)).some(id => ADAPTER_PROFILES[id].restore_manual)).map(member => member.name);
  const participants = {}, members = [];
  for (const [name, exported] of Object.entries(local.participants)) {
    try {
      const profile = participant_profile(name, {}, { cwd: local.cwd, adopt: true, participants: { [name]: exported } }, false);
      // A member whose software cannot take over other conversations (an API member) resumes only its own session, and
      // only while this machine still has it; otherwise, like one without a session store, it starts fresh.
      const software = adapter_of(profile.adapter);
      if (!software?.session || (!software.adopt && !software.session.exists(profile.session_id))) delete profile.session_id;
      const resumed = profile.session_id && software.adopt ? borrowed_session(name, profile, local.cwd) : profile;
      if (adapter_profile(profile.adapter)?.restore_manual) {
        keep_manual.push(name);
        const cwd = resumed.cwd || local.cwd || '';
        const command = resumed.session_id && adapter_profile(profile.adapter).resume_command?.(resumed.session_id);
        members.push({ name, status: 'manual', session_id: resumed.session_id || '', cwd,
          resume: command ? { command, cwd } : null });
      } else {
        participants[name] = resumed;
        members.push({ name, status: 'resumed', session_id: resumed.session_id || '' });
      }
    } catch (error) { members.push({ name, status: 'failed', error: error.message }); }
  }
  if (!Object.keys(participants).length && !local.cwd && !local.scheduler) return { room_id: input.room_id, registered: false, members };
  register_copied_room(home, input, local, participants, keep_manual);
  return { room_id: input.room_id, registered: true, members };
}

/**
 * Register an imported or forked free room's local members under a fresh launch directory; `seed` writes the new
 * runtime's bindings before the service can see the room. Returns the runtime directory.
 */
function register_copied_room(home, input, local, participants, keep_manual, seed = () => {}) {
  const key = createHash('sha256').update(`${input.site}/${input.room_id}`).digest('hex');
  // A leftover directory of a deleted room with the same ID would carry its old bindings, so a restore never reuses one.
  const base = join(home, 'launches', key), directory = existsSync(base) ? `${base}-${Date.now()}` : base;
  // Members arrive away; these placeholders are replaced by the credential issued when the owner brings each one back.
  const config = { site: input.site, room: input.room_id, token: input.token, mode: 'free', participants, keep_manual, api_home: home,
    members: Object.fromEntries(Object.keys(participants).map(name => [name, { token: `${randomUUID()}${randomUUID()}`, pending: '' }])),
    scheduler: local.scheduler || undefined, cwd: local.cwd || undefined, discussion_project: local.discussion_project || undefined,
    project_access: local.project_access || undefined, workflow: local.workflow || undefined, data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) };
  validate_config(config, directory);
  mkdirSync(directory, { recursive: true });
  atomic_json(join(directory, 'config.json'), config);
  seed(config.data_directory);
  register_room(home, join(directory, 'config.json'));
  return config.data_directory;
}

// Software whose session a fork branches; other local members start a new conversation in the forked room.

/**
 * Register a room forked from another on this machine: each local member continues from its own session as it stood
 * at the fork point, without the executions the fork leaves out. The source room's sessions are never changed.
 * Requires both rooms' owner credentials; members the new room keeps manual are not registered here.
 * Returns `{room_id, registered, members: [{name, status: forked|fresh|failed, error?}]}`.
 */
export async function fork_room(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim() || typeof raw.source_room_id !== 'string' || typeof raw.source_token !== 'string') {
    throw new Error('分支须提供新房间与原房间的编号和控制凭据');
  }
  const local = (await room_profiles(home, { site: input.site, room_id: raw.source_room_id, token: raw.source_token })).local_members;
  if (!local) return { room_id: input.room_id, registered: false, members: [] };
  await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  if (registered_room_path(home, input.site, input.room_id)) throw new Error('分支房间已在本机登记');
  const runners = new Set(room.free.members.filter(member => member.access === 'runner' && member.status !== 'removed').map(member => member.name));
  const left_out = raw.executions && typeof raw.executions === 'object' ? raw.executions : {};
  const participants = {}, members = [], bindings = {}, forks = {};
  for (const [name, exported] of Object.entries(local.participants)) {
    if (!runners.has(name)) continue;
    try {
      const profile = participant_profile(name, {}, { cwd: local.cwd, adopt: true, participants: { [name]: exported } }, false);
      if (!profile.session_id || !BRANCHABLE_ADAPTERS.includes(profile.adapter)) {
        delete profile.session_id;
        participants[name] = profile;
        members.push({ name, status: 'fresh' });
        continue;
      }
      // Claude resumes a session only in its original directory, so the forked member works there too.
      const located = adapter_profile(profile.adapter)?.adopt === 'own_cwd' ? borrowed_session(name, profile, local.cwd) : profile;
      const branch = await branch_session(located, profile.session_id, (left_out[name] || []).filter(Number.isInteger), { always: true });
      const { session_id, ...forked } = located;
      participants[name] = forked;
      bindings[name] = branch.session_id;
      if (branch.fork) forks[name] = branch.fork;
      members.push({ name, status: branch.session_id ? 'forked' : 'fresh' });
    } catch (error) { members.push({ name, status: 'failed', error: error.message }); }
  }
  if (!Object.keys(participants).length && !local.cwd && !local.scheduler) return { room_id: input.room_id, registered: false, members };
  register_copied_room(home, input, local, participants, [], data_directory => {
    const store = new DiscussionStore(data_directory);
    try {
      for (const [name, session_id] of Object.entries(bindings)) store.bind(name, session_id);
      // A Claude fork happens on the member's next turn; the runner keeps it pending until that session exists.
      for (const [name, fork] of Object.entries(forks)) store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run(`session-fork:${name}`, JSON.stringify(fork));
    } finally { store.close(); }
  });
  return { room_id: input.room_id, registered: true, members };
}

/** Stable signatures make changed retry requests explicit without putting credentials in receipts. */
function signature(value) {
  if (Array.isArray(value)) return `[${value.map(signature).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${signature(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Inherit the topic duration unless overridden; zero leaves the run without a time limit. */
function launch_minutes(input, room) {
  const minutes = Number(input.minutes ?? room.limits?.max_minutes ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MINUTES) throw new Error('讨论总时长或 minutes 须在 [0,1440]，0 表示不限时长');
  return minutes;
}

/** Refuse a second registry owner before changing the website runtime. */
function check_registration(home, config, path) {
  for (const registered of read_registry(home)) {
    if (resolve(registered) === path || !existsSync(registered)) continue;
    const other = registered_identity(registered);
    if (other?.site === config.site && other.room === config.room) throw new Error('房间已使用另一份接入配置登记；请沿用原配置，不重复接入');
  }
}

/** Start a session once, reconciling a lost response from the durable start intent. */
async function start_session(config, record, persist, room, minutes) {
  const state = await api(config, '/discussion');
  if (record.session_id && state.session?.id === record.session_id && !record.start_pending) {
    if (record.start_submission_id && state.session.start_submission_id !== record.start_submission_id) {
      throw new Error('房间当前讨论的启动编号与本次记录不同');
    }
    if (state.session.status !== 'active') throw new Error('讨论已暂停或结束；请在房间核对状态后再操作');
    return state.session;
  }
  if (record.session_id && state.session?.id !== record.session_id) throw new Error('房间当前讨论与本次启动记录不同');
  if (state.session && !record.start_pending) {
    if (state.session.status !== 'active') throw new Error('讨论已暂停或结束；请在房间核对状态后再操作');
    throw new Error('房间已有进行中的讨论；请沿用原启动记录');
  }
  if (room.session?.status === 'concluded' && !record.start_pending) throw new Error('房间中的讨论已结束；请从房间明确开启新讨论');
  if (!record.start_submission_id) record.start_submission_id = randomUUID();
  if (!record.start_request) {
    if (record.start_revision && record.start_revision !== state.revision) throw new Error('开启期间讨论状态已变化，请重新读取房间状态');
    const topic_minutes = Number(room.limits?.max_minutes || 0);
    const session_minutes = topic_minutes > 0 ? (minutes > 0 ? Math.min(topic_minutes, minutes) : topic_minutes) : minutes;
    record.start_revision = state.revision;
    record.start_request = { action: 'start', revision: state.revision, submission_id: record.start_submission_id,
      goal: room.goal || room.title, named_followup: Boolean(room.named_followup),
      limits: { max_rounds: room.limits?.max_rounds ?? 0, max_minutes: session_minutes,
        execution_minutes: room.limits?.execution_minutes ?? 0 } };
    record.start_pending = true;
    persist();
  }
  const result = await api(config, '/discussion', record.start_request);
  if (!result.session || result.session.start_submission_id !== record.start_submission_id) throw new Error('网站返回的讨论会话与本次启动编号不符');
  record.session_id = result.session.id;
  record.start_pending = false;
  persist();
  if (result.session.status !== 'active') throw new Error('本次讨论已暂停或结束；请在房间核对状态后再操作');
  return result.session;
}

/** Reserve the first host task for the calling conversation without sending it a duplicate prompt. */
async function current_host_task(config, record, persist, room) {
  if (record.current_task) return record.current_task;
  const discussion = await api(config, '/discussion');
  if (discussion.session?.status !== 'active' || discussion.session.id !== record.session_id) throw new Error('本次讨论会话已暂停、结束或变化；请核对原房间');
  const page = await api(config, '/inbox');
  const member = page.members.find(item => item.name === room.host && item.role === 'host');
  const request = member?.pending.find(item => item.purpose === 'discuss_host' && item.session_id === record.session_id);
  if (!member || (!request && !record.execution_client_id && !record.execution_id)) throw new Error('没有可由当前会话接手的主持请求；请核对原房间');
  record.execution_client_id ||= randomUUID();
  persist();
  const execution = record.execution_id ? await api(config, `/executions/${record.execution_id}`)
    : await api(config, '/executions', { member_id: member.id, client_id: record.execution_client_id, cwd: '' });
  if (!['dispatched', 'started'].includes(execution.status)) throw new Error('主持请求已不再等待执行；请核对原房间');
  if (!execution.requests?.some(item => item.purpose === 'discuss_host' && item.session_id === record.session_id)) {
    throw new Error('预约到的执行不属于本次讨论主持请求');
  }
  record.execution_id = execution.id;
  persist();
  const store = new DiscussionStore(config.directory);
  try {
    store.context(config);
    store.scope(config);
    const session_id = config.participants[room.host].session_id;
    store.bind(room.host, session_id);
    const task = free_task_files(config, member, execution, { session_id }, { session: discussion.session, process_access: false });
    new FreeRoomRunner(config, store).save(room.host, { client_id: record.execution_client_id, execution_id: execution.id,
      status: 'running', attempts: 0, started: Date.now(), last_renew: Date.now() });
    record.current_task = { execution_id: execution.id, access_file: task.access_path, task_file: join(config.directory, `${task.id}.task.json`) };
    persist();
    return record.current_task;
  } finally { store.close(); }
}

/** Return launch evidence and paths, never raw control or execution tokens. */
async function launch_receipt(config, record, config_path) {
  const room = await api(config, '');
  const discussion = record.session_id ? await api(config, '/discussion') : null;
  return { entry: record.entry, room, url: `${config.site}/?room=${config.room}`, config_path,
    status: discussion?.session?.status || (record.session_id ? 'concluded' : 'free'), current_task: record.current_task || null };
}

/** Read a saved launch without creating state during validation or preview. */
function read_launch(directory) {
  const path = join(directory, 'launch.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Find the registered room only after proving the caller's original control credential. */
async function room_config_context(home, raw, options = {}) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim()) throw new Error('读取本场配置须提供房间编号和原控制凭据');
  const room = options.local_guard ? { id: input.room_id, archived: false }
    : await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  const config = { site: input.site, room: input.room_id, token: input.token };
  if (!options.local_guard) await verify_control(config, room);
  const discussion = options.local_guard
    ? { session: { status: 'paused' }, revision: raw.session_revision ?? raw.runtime_revision }
    : await api(config, '/discussion');
  if (room.archived || discussion.session?.status !== 'paused') throw new Error('请先暂停本场讨论，再修正软件路径');
  const paths = read_registry(home).filter(path => {
    const identity = registered_identity(path);
    return identity?.site === input.site && identity.room === input.room_id;
  });
  if (paths.length !== 1) throw new Error('未找到本场唯一的已登记配置，请核对原接入服务');
  const path = paths[0];
  const journal = read_launch(dirname(path));
  if (journal && !journal.finished) throw new Error('本次启动尚未完成，请先核对原启动待办');
  return { input, room, discussion, path, ...configuration_snapshot(path) };
}

/** Expose only editable connection paths, never credentials or unrelated room settings. */
function connection_view(context) {
  return { room_id: context.room.id, session_revision: context.discussion.revision, runtime_revision: context.discussion.revision, version: context.version,
    participants: Object.fromEntries(Object.entries(context.config.participants).map(([name, profile]) =>
      [name, Object.fromEntries(['adapter', ...CONNECTION_FIELDS].filter(field => profile[field] !== undefined).map(field => [field, profile[field]]))])) };
}

/** Switch only Codex's execution entrypoint, keeping its actual original conversation. */
function switch_codex_adapter(context, name, profile, adapter) {
  if (!same_session_family(profile.adapter, adapter)) throw new Error('本场仅支持共用会话的 App / CLI 接入之间切换');
  const current = validate_config(context.config, dirname(context.path));
  let session = profile.session_id;
  if (existsSync(join(current.directory, 'runtime.sqlite3'))) {
    const store = new DiscussionStore(current.directory);
    try {
      const binding = store.binding(name).session_id;
      if (session && binding && session !== binding) throw new Error('原会话绑定不一致，请先核对原会话');
      session = binding || session;
    } finally { store.close(); }
  }
  if (!session) throw new Error('尚无实际 Codex 会话，不能切换；请先完成首次接入');
  profile.adapter = adapter;
  profile.session_id = session;
}

/** Validate paused-room paths and Codex entrypoints without replacing the discussion or session. */
function corrected_configuration(context) {
  const config = structuredClone(context.config);
  for (const [name, patch] of Object.entries(context.input.participants)) {
    const profile = config.participants[name];
    const field = adapter_profile(profile?.adapter)?.location || 'executable';
    const fields = ADAPTER_IDS.some(other => same_session_family(other, profile?.adapter)) ? [field, 'adapter'] : [field];
    if (!profile || !patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !fields.includes(key))) throw new Error('本场修正仅支持软件路径、Sidecar 目录及 Codex App / CLI；参与者、项目及会话保持不变');
    validate_profile(name, patch);
    if (patch.adapter && patch.adapter !== profile.adapter) switch_codex_adapter(context, name, profile, patch.adapter);
    const path = patch[field] ?? profile[field];
    if (typeof path !== 'string' || !path || !existsSync(path)
      || (field === 'executable' ? !statSync(path).isFile() || (process.platform === 'win32' && !/\.exe$/i.test(path)) : !statSync(path).isDirectory())) throw new Error(`${name}：请提供有效的软件文件或连接目录`);
    profile[field] = path;
  }
  validate_config(config, dirname(context.path));
  return config;
}

/** Wait for the resident worker to read this version before suggesting a manual restart. */
async function configuration_applied(home, path, version) {
  for (let waited = 0; waited < CONFIG_APPLY_TIMEOUT_MS; waited += CONFIG_APPLY_POLL_MS) {
    const pid = service_pid(home);
    if (!pid) return false;
    const status_path = join(home, 'status.json');
    const status = existsSync(status_path) ? JSON.parse(readFileSync(status_path, 'utf8')) : {};
    const worker = status.rooms?.find(item => resolve(item.config) === resolve(path));
    if (status.pid === pid && worker?.config_version === version && worker.status !== 'error') return true;
    await sleep(CONFIG_APPLY_POLL_MS);
  }
  return false;
}

/** Read or save a paused room's connection paths without changing its runtime or global defaults. */
export async function room_configuration(home, raw, options = {}) {
  let context = await room_config_context(home, raw, options);
  if (raw.participants !== undefined && !options.local_guard) {
    const saved = await save_room_connection(raw);
    return { ...saved, applied: await configuration_applied(home, context.path, saved.version) };
  }
  if (raw.participants === undefined) return connection_view(context);
  if (!raw.participants || typeof raw.participants !== 'object' || Array.isArray(raw.participants)) throw new Error('participants 须为本场软件路径对象');
  const release = acquire_lock(join(dirname(context.path), 'configuration-edit'));
  try {
    context = await room_config_context(home, raw, options);
    const config = corrected_configuration(context);
    if (raw.version !== context.version || (raw.session_revision ?? raw.runtime_revision) !== context.discussion.revision) throw new Error('房间状态或配置已变化，请重新读取本场配置后核对');
    atomic_json(context.path, config);
    const saved = { ...context, ...configuration_snapshot(context.path) };
    // The local website holds its database write lock here; the worker can acknowledge only after that lock is released.
    return { ...connection_view(saved), applied: false };
  } finally { release(); }
}

/** Serialize file replacement with runtime changes through the local website's database guard. */
async function save_room_connection(raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  const url = new URL(input.site);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('本场路径修正须通过已启用本机启动的回环网站');
  const response = await fetch(`${input.site}/api/local/room-config`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CoDiscuss-Local': '1' },
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '本场配置保存失败'}`);
  return result;
}

/** Prove dispatcher access before a protected room is started or a corrected credential is saved. */
async function verify_control(config, room) {
  await api({ ...config, room: room.id }, '/inbox');
}

/** Pin resolved defaults, while comparing retries against only the caller's explicit request. */
async function prepare_launch(home, input, directory, options = {}) {
  const previous = read_launch(directory);
  if (options.browser_request && (typeof input.token !== 'string' || !input.token.trim())) throw new Error('网页启动须携带本次原始控制凭据，不能认领其他启动记录');
  const { token: ignored_token, access_file: ignored_access, ...request } = input;
  const request_signature = signature(request);
  if (previous?.request_signature && previous.request_signature !== request_signature) throw new Error('启动配置与原请求不同；同一次重试须沿用原配置，新讨论请使用新提交编号');
  const config_path = join(directory, 'config.json');
  const saved = previous?.config || (previous && existsSync(config_path) ? JSON.parse(readFileSync(config_path, 'utf8')) : null);
  const token = input.token || previous?.token || randomUUID();
  const room_id = input.room_id || previous?.room_id || (saved?.room !== 'preview' ? saved?.room : null);
  if (options.browser_request && previous && token !== previous.token && !room_id) throw new Error('尚未确认原房间，不能替换本次控制凭据');
  const room = room_id ? await site_request(input.site, `/api/rooms/${room_id}`, token) : input.room;
  const config = previous?.request_signature ? { ...structuredClone(saved), token }
    : launch_config(home, input, room, directory, { token, defaults: saved?.participants, members: saved?.members });
  config.draft_directory = service_drafts(home, config.directory);
  if (previous?.request_signature && !previous.finished) validate_config(config, directory);
  const minutes = previous?.minutes ?? launch_minutes(input, room);
  const draft = signature({ entry: input.entry, room_id: input.room_id, room: input.room, participants: config.participants, cwd: input.cwd, discussion_project: input.discussion_project, minutes });
  if (room.id) await verify_control(config, room);
  return { input, config, room, minutes, draft, request_signature, directory, previous };
}

/** Launch a room through either entry, using a durable journal for safe retries. */
export async function launch_discussion(home, raw, options = {}) {
  assert_shared_home(home);
  const input = launch_input(raw);
  // A room created from the page without a project works in its own folder of the draft space, which is then its project.
  if (!input.room_id && !input.cwd && input.entry === 'web' && !options.dry_run) input.cwd = draft_folder(home, input.room.title, input.room.submission_id);
  const key = createHash('sha256').update(`${input.site}/${input.room_id || input.room.submission_id}`).digest('hex');
  const directory = join(home, 'launches', key);
  let release;
  try {
    const preview = await prepare_launch(home, input, directory, options);
    if (options.dry_run) return { dry_run: true, entry: input.entry, site: input.site, room_id: input.room_id || null,
      host: preview.room.host, participants: preview.config.participants, cwd: preview.config.cwd || null,
      discussion_project: preview.config.discussion_project || null, minutes: preview.minutes };
    release = acquire_lock(directory);
    return await perform_launch(home, await prepare_launch(home, input, directory, options), options);
  } catch (error) {
    error.launch ||= { stage: existsSync(join(directory, 'launch.json')) ? 'unconfirmed' : 'not_started' };
    throw error;
  } finally { release?.(); }
}

/** Persist preparation before writes, hand off the current host when needed, then register once. */
async function perform_launch(home, context, options) {
  const { input, config, minutes, draft, request_signature, directory, previous } = context;
  // This is the creation input's start-discussion choice, not the persisted room model (always free).
  const discussion = previous?.discussion ?? (input.room ? input.room.mode !== 'free' : Boolean(context.room.session && context.room.session.status !== 'concluded'));
  const record = previous || { token: config.token, signature: draft, request_signature, config, minutes, entry: input.entry, discussion };
  record.discussion = discussion;
  const persist = () => atomic_json(join(directory, 'launch.json'), record);
  if (!previous) persist();
  const progress = { stage: 'unconfirmed' };
  try {
    let room = context.room;
    if (!input.room_id) room = await site_request(input.site, '/api/rooms', config.token, {
      ...input.room,
      members: card_order(input.room.members, [...Object.keys(config.participants).map(name => ({ name, adapter: config.participants[name].adapter,
        token: config.members[name].token, access: 'runner', session_mode: config.participants[name].session_id ? 'borrowed' : 'new' })),
      // Manual members keep the credentials the browser generated; nothing local is configured for them.
      ...(input.room.members || []).filter(member => record.discussion ? member?.access === 'manual' : !woken_member(member))
        .map(({ name, token, access }) => ({ name, token, access, adapter: '', session_mode: 'new' }))]),
    });
    config.room = room.id;
    await verify_control(config, room);
    Object.assign(progress, { stage: 'created', room_id: room.id });
    Object.assign(record, { token: config.token, request_signature, config, minutes, room_id: room.id });
    persist();
    const config_path = join(directory, 'config.json');
    check_registration(home, config, config_path);
    if (record.finished) {
      const saved = existsSync(config_path) ? JSON.parse(readFileSync(config_path, 'utf8')) : config;
      if (saved.token !== config.token || !existsSync(config_path)) atomic_json(config_path, { ...saved, token: config.token });
      return launch_receipt(config, record, config_path);
    }
    atomic_json(config_path, config);
    const service = await (options.start_service || start_service)(home);
    if (!service?.running) throw new Error('讨论服务未就绪，未开始本次讨论');
    if (record.discussion) await start_session(config, record, persist, room, minutes);
    progress.stage = 'started';
    if (record.discussion && input.entry === 'conversation') record.current_task = await current_host_task(config, record, persist, room);
    register_room(home, config_path);
    record.finished = true;
    persist();
    return launch_receipt(config, record, config_path);
  } catch (error) { error.launch = progress; throw error; }
}

/** The workflow library: list, read, save, rename, disable or enable, delete, preview an import, or read a room's member cards. */
export function workflows_command(home, input = {}) {
  const action = input.action || 'list';
  if (action === 'list') return workflow_library(home);
  if (action === 'get') return get_workflow(home, input.id);
  if (action === 'save') return save_workflow(home, input.workflow, validate_preset);
  if (action === 'delete') return delete_workflow(home, input.id);
  if (action === 'rename') return rename_workflow(home, input.id, input.label);
  if (action === 'disable' || action === 'enable') return set_workflow_disabled(home, input.id, action === 'disable');
  if (action === 'preview') {
    return preview_workflow(input, validate_preset, name => card_platform_ready(home, name));
  }
  if (action === 'room-cards') return room_cards(home, input);
  throw new Error('action 须为 list、get、save、rename、disable、enable、delete、preview 或 room-cards');
}

/** Cards made from a registered room's members as configured here, prompts verbatim; no credential or path is returned. */
async function room_cards(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id) throw new Error('读取成员卡片须提供 room_id');
  const path = registered_room_path(home, input.site, input.room_id);
  if (!path) throw new Error('本机没有登记这个房间');
  const config = configuration_snapshot(path).config;
  const room = await api(config, ''), taken = new Set();
  const members = new Set((room.free?.members || []).filter(member => member.status !== 'removed').map(member => member.name));
  return { cards: Object.entries(config.participants || {}).filter(([name]) => members.has(name)).map(([name, profile]) => {
    const suffix = (name.split('-')[1] || platform_of(name)).toLowerCase();
    let card = suffix.slice(0, 16);
    for (let number = 2; taken.has(card.toLowerCase()); number++) card = `${suffix.slice(0, 16 - String(number).length)}${number}`;
    taken.add(card.toLowerCase());
    // A card names its member platform-card; the room member it came from may have another suffix.
    return { card, name: `${platform_of(name)}-${card}`, label: room.labels?.[name] || '', description: room.descriptions?.[name] || '',
      ...Object.fromEntries(['system_prompt', 'project_access', 'model', 'effort']
      .filter(field => profile[field] && profile[field] !== 'own').map(field => [field, profile[field]])) };
  }) };
}

/**
 * Bind a room's workflow, or end and resume it with the members it brought. Members are invited or brought back by the
 * usual member commands first; enabling only records which card each member plays, and a different workflow replaces
 * the binding (its members stay as ordinary members). `away` (and the older `disable`) sends its members away and ends
 * it, keeping who played which card; `back` brings them back to their sessions and resumes it. `sync` refreshes it
 * after a library edit (see refresh_room_workflow).
 */
export async function room_workflow(home, raw) {
  if (raw?.action === 'sync') return refresh_room_workflow(home, raw);
  const { input, path } = await member_room_context(home, raw);
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    if (input.action === 'host') {
      // The owner's per-room grant that lets the host save and enable workflows by itself (workflow-adopt).
      const next = { ...config, host_workflows: input.allowed === true || undefined };
      atomic_json(path, next);
      return { room_id: input.room_id, host_workflows: Boolean(next.host_workflows) };
    }
    if (input.action === 'enable') {
      get_workflow(home, input.workflow?.id);
      assert_workflow_enabled(home, input.workflow.id);
      const next = bind_room_workflow(config, { ...input.workflow, enabled: true });
      validate_config({ ...next, api_home: home }, dirname(path));
      atomic_json(path, next);
      return { room_id: input.room_id, workflow: room_workflow_status(next, home) };
    }
    if (!['away', 'back', 'disable'].includes(input.action)) throw new Error('action 须为 enable、sync、away、back、disable 或 host');
    if (!config.workflow?.id) throw new Error('本房间没有工作流');
    const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
    const names = new Set(Object.values(config.workflow.members || {}));
    const members = room.free.members.filter(item => names.has(item.name) && item.role !== 'host');
    if (input.action === 'back') {
      // Each comes back to its own session; a removed member stays removed.
      for (const member of members.filter(item => item.status === 'away')) await room_member(home, { ...raw, action: 'rejoin', name: member.name }, true);
    } else {
      for (const member of members.filter(item => item.status === 'active')) {
        await site_request(input.site, `/api/rooms/${input.room_id}/members/${member.id}`, input.token, { action: 'away' });
      }
    }
    // Sending its members away ends the workflow; bringing them back resumes it.
    const next = { ...config, workflow: { ...config.workflow, enabled: input.action === 'back' } };
    atomic_json(path, next);
    return { room_id: input.room_id, workflow: room_workflow_status(next, home) };
  } finally { release(); }
}

// The most a host-made card may ask for; anything above writing is lowered to it.
const HOST_CARD_ACCESS = ['read', 'write'];

/**
 * The registered room whose present host holds this task's access file.
 * Returns its configuration path, configuration and the site's member list; throws for anyone else.
 */
async function host_room(home, access_file) {
  if (!access_file) throw new Error('凭据用 --access-file 或 DISCUSS_ACCESS_FILE');
  const access = JSON.parse(readFileSync(resolve(access_file), 'utf8').replace(/^﻿/, ''));
  const path = registered_room_path(home, String(access.site || '').replace(/\/$/, ''), access.room);
  if (!path) throw new Error('本机没有登记这个房间');
  const config = configuration_snapshot(path).config;
  const host = Object.keys(config.members || {}).find(name => config.members[name].token === access.token);
  const room = await api(config, '');
  const roster = room.free?.members || [];
  if (!host || !roster.some(member => member.name === host && member.role === 'host' && member.status === 'active')) throw new Error('只有本房间的主持人能运行此命令');
  return { path, config, roster, labels: room.labels || {}, host };
}

const IMAGE_ACTIONS = { generate: 'generate_image', edit: 'edit_image' };

/**
 * One drawing by a member, with its task credential: `{action: generate|edit, ...the image tool's arguments}` (the same
 * arguments an API member's generate_image / edit_image take). Allowed only while the room's owner has drawing on and
 * this computer has an image service. The images become the member's attachments, which it posts with
 * `message post --attachment ID`; project files are read and written under the member's own project access.
 */
export async function draw_image(home, { access_file, request }) {
  if (!access_file) throw new Error('凭据用 --access-file 或 DISCUSS_ACCESS_FILE');
  const access = JSON.parse(readFileSync(resolve(access_file), 'utf8').replace(/^﻿/, ''));
  const path = registered_room_path(home, String(access.site || '').replace(/\/$/, ''), access.room);
  if (!path) throw new Error('本机没有登记这个房间');
  const config = configuration_snapshot(path).config;
  const member = Object.keys(config.members || {}).find(name => config.members[name].token === access.token);
  if (!member) throw new Error('凭据不属于本房间的成员');
  if (!config.image_generation) throw new Error('本房间没有添加生图服务，请房主在“成员与设置 → 协作设置”的“生图”中添加');
  const image = room_image(home, config);
  if (!image) throw new Error('这台电脑的生图服务还没有填写密钥（房间“生图”卡片的设置）');
  const { action, ...args } = request || {};
  if (!IMAGE_ACTIONS[action]) throw new Error('action 须为 generate 或 edit');
  const profile = config.participants?.[member] || {};
  const project = open_project({ cwd: profile.cwd ?? config.cwd, project_access: profile.project_access === 'read' ? 'read' : 'write',
    extra_directories: config.extra_directories || [] }, [home, dirname(path)]);
  const context = { home, image, site: config.site, room: config.room, token: access.token, participant: member, directory: dirname(path),
    project, signal: new AbortController().signal, generated_attachments: [] };
  const result = await run_image_tool(context, IMAGE_ACTIONS[action], args);
  if (result.error) throw new Error(result.error);
  return { ...result, note: '图片已存为你的附件；回答时用 message post --attachment 附件ID 附上（可重复，最多 10 个）' };
}

/**
 * The API settings a program-started card on a platform without local software starts from, as the invite form fills
 * them: the platform's official API with the key last saved here for that root. Null when the platform has saved
 * software settings or local software, or no key is saved.
 */
function card_api_profile(home, platform) {
  if (launch_settings(home).participants[platform] || platform_adapters(platform).some(id => adapter_profile(id).kind !== 'api')) return null;
  const provider = API_PROVIDERS[platform];
  const api_key_ref = provider && saved_api_keys(home)[provider.base_url];
  return api_key_ref ? { adapter: 'api', base_url: provider.base_url, api_protocol: provider.api_protocol, model: provider.models[0], api_key_ref } : null;
}

/** The platforms a card may name on this computer: saved software settings, or an API with a saved key. */
function configured_platforms(home) {
  return [...new Set([...Object.keys(launch_settings(home).participants), ...Object.keys(API_PROVIDERS).filter(platform => card_api_profile(home, platform))])];
}

/** The library as listed: each workflow with the cards this computer cannot start, and the platforms cards may name here. */
function workflow_library(home) {
  return { workflows: list_workflows(home, name => card_platform_ready(home, name)), platforms: configured_platforms(home) };
}

/** Whether a card's platform can start here: saved software settings, or an API with a saved key. */
function card_platform_ready(home, name) {
  const platform = platform_of(name || '');
  return Boolean(platform && (launch_settings(home).participants[platform] || card_api_profile(home, platform)));
}

/**
 * Give cards of the room's workflow a member: a present one stays, one that left is brought back, and a card with
 * none (or whose member was removed) is invited as a program-started member with the card's settings, label and
 * description. `cards` limits it to those card IDs. Returns the updated {card ID: member name} map.
 */
async function join_workflow_cards(home, config, roster, workflow, members, cards) {
  const owner = { site: config.site, room_id: config.room, token: config.token };
  const next = { ...members }, labels = {}, descriptions = {};
  // Without a list, the main flow's cards; a sub-workflow's cards are named when it is used.
  for (const agent of cards ? workflow_cards(workflow).filter(item => cards.includes(item.card)) : workflow.agents) {
    const current = roster.find(member => member.name === next[agent.card] && member.status !== 'removed');
    if (current?.status === 'active') continue;
    if (current?.status === 'away') { await room_member(home, { ...owner, action: 'rejoin', name: current.name }); continue; }
    const taken = new Set([...roster.map(member => member.name), ...Object.values(next)]);
    const name = taken.has(agent.name) ? free_instance(agent.name, taken) : agent.name;
    const api = card_api_profile(home, platform_of(agent.name));
    const card = Object.fromEntries(['project_access', 'model', 'effort'].filter(field => agent[field]).map(field => [field, agent[field]]));
    // An API member has no command line, so a card asking for more than writing gets the most it allows.
    if (api && card.project_access && !access_levels('api').includes(card.project_access)) card.project_access = 'write';
    const profile = { ...api, ...card };
    const joined = await room_member(home, { ...owner, action: 'add', name, participants: { [name]: profile } });
    next[agent.card] = joined.member;
    if (agent.label) labels[joined.member] = agent.label;
    if (agent.description) descriptions[joined.member] = agent.description;
  }
  if (Object.keys(labels).length) await site_request(config.site, `/api/rooms/${config.room}/labels`, config.token, { labels });
  if (Object.keys(descriptions).length) await site_request(config.site, `/api/rooms/${config.room}/descriptions`, config.token, { descriptions });
  return next;
}

/**
 * Bring the room's binding in line with its workflow as saved now, after the workflow was edited while in use: the
 * given cards (all when omitted) join as in join_workflow_cards, and cards the workflow no longer has leave the
 * binding, their members staying as ordinary members. Returns the room's workflow status and the card map.
 */
async function sync_workflow_cards(home, path, config, roster, cards) {
  if (!config.workflow?.id || !config.workflow.enabled) throw new Error('本房间没有在用的工作流');
  const workflow = get_workflow(home, config.workflow.id);
  const known = workflow_cards(workflow).map(agent => agent.card);
  const unknown = (cards || []).filter(card => !known.includes(card));
  if (unknown.length) throw new Error(`工作流 ${workflow.id} 没有这些卡片：${unknown.join('、')}；现有卡片：${known.join('、') || '无'}`);
  const kept = Object.fromEntries(Object.entries(config.workflow.members || {}).filter(([card]) => known.includes(card)));
  const members = await join_workflow_cards(home, config, roster, workflow, kept, cards);
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const current = configuration_snapshot(path).config;
    if (current.workflow?.id !== workflow.id) throw new Error('本房间的工作流已更换，请重新读取后再试');
    // The map is replaced, not merged, so dropped cards leave it.
    const next = { ...current, workflow: { ...current.workflow, members } };
    atomic_json(path, next);
    return { room_id: config.room, workflow: room_workflow_status(next, home), members };
  } finally { release(); }
}

/**
 * The owner refreshes the room's workflow after editing it in the library (`room-workflow` `sync`): every card gets
 * a member and dropped cards leave the binding. Returns the room's workflow status and the card map.
 */
async function refresh_room_workflow(home, raw) {
  const { path } = await member_room_context(home, raw);
  const config = configuration_snapshot(path).config;
  const roster = (await api(config, '')).free?.members || [];
  return sync_workflow_cards(home, path, config, roster);
}

/**
 * The host brings in members for cards added to the room's workflow after it was enabled; the owner's enabling
 * authorized the workflow's cards, so this needs no further grant. Only cards with no member yet may be named, so a
 * member the user sent away or removed stays so. Returns the room's workflow status and the card map.
 */
export async function join_workflow(home, { access_file, cards, sub }) {
  const { path, config, roster } = await host_room(home, access_file);
  if (sub) return sync_workflow_cards(home, path, config, roster, sub_workflow_cards(home, config, sub));
  const mapped = Object.keys(config.workflow?.members || {});
  const taken = (cards || []).filter(card => mapped.includes(card));
  if (taken.length) throw new Error(`这些卡片已有成员：${taken.join('、')}；离开或移除的成员由用户请回`);
  const known = config.workflow?.id && config.workflow.enabled ? get_workflow(home, config.workflow.id).agents.map(agent => agent.card) : [];
  return sync_workflow_cards(home, path, config, roster, cards?.length ? cards : known.filter(card => !mapped.includes(card)));
}

/** The cards a sub-workflow of the room's workflow in use brings; refuses one it lacks or one with no cards. */
function sub_workflow_cards(home, config, sub) {
  if (!config.workflow?.id || !config.workflow.enabled) throw new Error('本房间没有在用的工作流');
  const list = get_workflow(home, config.workflow.id).sub_workflows;
  const found = list.find(item => item.id === sub);
  if (!found) throw new Error(`工作流 ${config.workflow.id} 没有子工作流 ${sub}；现有子工作流：${list.map(item => item.id).join('、') || '无'}`);
  if (!found.agents.length) throw new Error(`子工作流 ${sub} 没有卡片，不需要请成员加入`);
  return found.agents.map(agent => agent.card);
}

/**
 * The host ends a sub-workflow's use: the members its cards brought are set away (pending requests cancelled, running work
 * stopped, sessions kept), so `workflow-join --sub` brings them back to their own sessions. Only a sub-workflow's cards
 * may be sent away this way; the main flow's members stay for the user to manage.
 */
export async function leave_sub_workflow(home, { access_file, sub }) {
  if (!sub) throw new Error('须用 --sub 指定子工作流');
  const { config, roster } = await host_room(home, access_file);
  const cards = sub_workflow_cards(home, config, sub);
  const names = cards.map(card => config.workflow.members?.[card]).filter(Boolean);
  const away = roster.filter(member => names.includes(member.name) && member.status === 'active' && member.role !== 'host');
  for (const member of away) await site_request(config.site, `/api/rooms/${config.room}/members/${member.id}`, config.token, { action: 'away' });
  return { room_id: config.room, sub, away: away.map(member => member.name) };
}

// When the owner left the room's goal budget at no limit, a goal the host opens itself still stops by these.
const HOST_GOAL_BUDGET = { max_continues: 8, max_minutes: 90 };
const LIVE_EXECUTION = ['dispatched', 'started'];

/**
 * The active-or-away member a host names by member ID or display name. The host itself only with `self`: changes that
 * apply from its next delivery (model, label) let it recover, e.g. from one model's quota; stopping, access and
 * presence stay with the owner.
 */
function host_target({ roster, labels, host }, wanted, { self = false } = {}) {
  if (!wanted) throw new Error('须用 --member 指定成员（成员 ID 或显示名）');
  const member = roster.find(item => item.status !== 'removed' && (item.name === wanted || labels[item.name] === wanted));
  if (!member) throw new Error(`本房间没有成员 ${wanted}`);
  if (member.name === host && !self) throw new Error('主持人不能对自己执行此操作（自己只能改模型与强度、显示名）；更换或移除主持人由用户决定');
  return member;
}

/** The profile a host-invited member starts from: this computer's saved settings, project access at most write. */
function host_invite_profile(home, name, { access, model, effort }) {
  if (access && !HOST_CARD_ACCESS.includes(access)) throw new Error('主持人邀请的成员项目权限只能是 read 或 write');
  if (!card_platform_ready(home, name)) {
    const ready = configured_platforms(home);
    throw new Error(`本机没有配置 ${name} 的软件或 API Key；只能邀请本机已配置的平台：${ready.join('、')}`);
  }
  const api = card_api_profile(home, platform_of(name));
  const saved = launch_settings(home).participants[platform_of(name)]?.project_access;
  const project_access = access || (HOST_CARD_ACCESS.includes(saved) ? saved : 'write');
  return { ...api, project_access, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/** The positive execution number a host passes with --execution. */
function execution_number(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('须用 --execution 指定执行编号');
  return id;
}

/** Read the discussion, or start (room default limits), pause, resume or end it with the revision just read. */
function host_discussion(ctx, { do: step, goal, revision, submission_id }) {
  if (!step) return ctx.call('/discussion');
  if (step === 'start') {
    if (!goal) throw new Error('开启讨论须用 --goal 写明讨论目标');
    return ctx.call('/discussion', { action: 'start', goal, revision, submission_id: submission_id || randomUUID() });
  }
  if (!['pause', 'resume', 'end'].includes(step)) throw new Error('--do 须为 start、pause、resume 或 end');
  return ctx.call('/discussion', { action: step, revision });
}

/** Read the goal, or open it under the owner's default budget (a bounded one when that is unlimited), pause, resume or end it. */
function host_goal(ctx, { do: step, goal, revision }) {
  if (!step) return ctx.call('/goal');
  if (step === 'start') {
    if (!goal) throw new Error('开启 Goal 须用 --goal 写明目标');
    const preferences = launch_settings(ctx.home).create_preferences || {};
    const budget = {
      max_continues: preferences.goal_max_continues || HOST_GOAL_BUDGET.max_continues,
      max_minutes: preferences.goal_max_minutes || HOST_GOAL_BUDGET.max_minutes,
    };
    return ctx.call('/goal', { action: 'start', objective: goal, revision, ...budget });
  }
  if (!['pause', 'resume', 'end'].includes(step)) throw new Error('--do 须为 start、pause、resume 或 end');
  return ctx.call('/goal', { action: step === 'end' ? 'clear' : step, revision });
}

/** Steer a member's running execution with an interjection; a retry passes the same --submission-id. */
function host_steer(ctx, { member: wanted, text, submission_id }) {
  const member = host_target(ctx, wanted);
  if (!text) throw new Error('须用 --text 写明要对它说的话');
  if (!LIVE_EXECUTION.includes(member.execution?.status)) throw new Error(`${wanted} 当前没有进行中的执行；要它发言请在回答里用 --to 点名`);
  return ctx.call(`/executions/${member.execution.id}`, { action: 'interject', text, submission_id: submission_id || randomUUID() });
}

/** Set a member's display name and, optionally, its description. */
async function host_label(ctx, { member: wanted, label, description }) {
  const member = host_target(ctx, wanted, { self: true });
  if (!label && !description) throw new Error('须用 --label 或 --description 指定显示名或描述');
  if (label) await ctx.call('/labels', { labels: { [member.name]: label } });
  if (description) await ctx.call('/descriptions', { descriptions: { [member.name]: description } });
  return { member: member.name, label: label || null, description: description || null };
}

/** Invite a member from this computer's configured software, project access at most write. */
async function host_invite(ctx, options) {
  if (!options.name) throw new Error('须用 --name 指定要邀请的平台（如 Claude、Codex）');
  const taken = new Set(ctx.roster.map(member => member.name));
  const name = taken.has(options.name) ? free_instance(options.name, taken) : options.name;
  const profile = host_invite_profile(ctx.home, name, options);
  const joined = await room_member(ctx.home, { ...ctx.owner, action: 'add', name, participants: { [name]: profile } }, false, ctx.headers);
  return { member: joined.member, project_access: profile.project_access };
}

/** Read the speaking order, or change its not-yet-spoken part with the revision just read; display names are accepted. */
function host_order(ctx, { order, revision }) {
  if (!order) return ctx.call('/speaking-order');
  if (!revision) throw new Error('调整发言顺序前先不带 --order 读取当前顺序，再用 --revision 带上其 revision');
  const names = order.split(',').map(name => name.trim()).filter(Boolean)
    .map(name => ctx.roster.find(member => member.status === 'active' && ctx.labels[member.name] === name && member.name !== name)?.name || name);
  return ctx.call('/speaking-order', { revision, order: names });
}

const HOST_CONTROLS = {
  stop: (ctx, o) => ctx.call(`/members/${host_target(ctx, o.member).id}/interrupt`, {}),
  'stop-all': ctx => ctx.call('/stop', {}),
  steer: host_steer,
  retry: (ctx, o) => ctx.call(`/executions/${execution_number(o.execution)}`, { action: 'retry' }),
  details: (ctx, o) => execution_details_command(ctx.home, { ...ctx.owner, execution_id: execution_number(o.execution) }),
  order: host_order,
  invite: host_invite,
  away: (ctx, o) => ctx.call(`/members/${host_target(ctx, o.member).id}`, { action: 'away' }),
  remove: (ctx, o) => ctx.call(`/members/${host_target(ctx, o.member).id}`, { action: 'remove' }),
  back: (ctx, o) => room_member(ctx.home, { ...ctx.owner, action: 'rejoin', name: host_target(ctx, o.member).name }, false, ctx.headers),
  model: (ctx, o) => room_member_model(ctx.home, { ...ctx.owner, name: host_target(ctx, o.member, { self: true }).name, model: o.model || '', effort: o.effort || '' }),
  access: (ctx, o) => {
    if (!HOST_CARD_ACCESS.includes(o.access)) throw new Error('主持人只能把成员的项目权限设为 read 或 write');
    return room_member_access(ctx.home, { ...ctx.owner, name: host_target(ctx, o.member).name, project_access: o.access });
  },
  adapter: (ctx, o) => room_member_adapter(ctx.home, { ...ctx.owner, name: host_target(ctx, o.member).name, adapter: o.adapter }),
  label: host_label,
  discussion: host_discussion,
  goal: host_goal,
  withdraw: (ctx, o) => {
    const id = Number(o.message);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('须用 --message 指定要撤回的派活消息编号');
    return ctx.call(`/dispatches/${id}/withdraw`, {});
  },
  checkin: (ctx, o) => {
    if (o.off) return ctx.call('/host-checkin', { off: true });
    const minutes = Number(o.minutes);
    if (!Number.isSafeInteger(minutes)) throw new Error('须用 --minutes 指定间隔分钟数（5–120），或 --off 关闭');
    return ctx.call('/host-checkin', { minutes });
  },
};

/**
 * The host runs a room control the owner otherwise does in the web page, when the owner granted this room full host
 * control (`host_workflows`), so it can keep work moving and handle what goes wrong by itself: stop, steer or retry a
 * member, read an execution's local log, change the speaking order, invite (configured software, at most write), send
 * away, remove or bring back members, change a member's model, effort, client or access (read/write only), label it,
 * and read, start, pause, resume or end the discussion or goal. The site checks every write as for the owner (revisions
 * included). What stays the owner's: acting on the host itself, approving rounds beyond the limit, access above write
 * or tool approvals, project directories, the owner's messages and private chats.
 */
export async function host_control(home, action, options) {
  if (!Object.hasOwn(HOST_CONTROLS, action || '')) throw new Error(`操作须为 ${Object.keys(HOST_CONTROLS).join('、')} 之一`);
  const { config, roster, labels, host } = await host_room(home, options.access_file);
  if (!config.host_workflows) throw new Error('房主没有为本房间打开“主持人完整权限”；请让用户在电脑上“成员与设置 → 协作设置”打开后再试');
  const headers = { 'User-Agent': `AI-CoDiscuss-host:${host}` };
  const owner = { site: config.site, room_id: config.room, token: config.token };
  const call = (path, body) => site_request(config.site, `/api/rooms/${config.room}${path}`, config.token, body, headers);
  return HOST_CONTROLS[action]({ home, config, roster, labels, host, headers, owner, call }, options);
}

/** Cards as the host may bring them: any access above writing is lowered to it. */
const host_cards = agents => agents.map(agent => agent.project_access && !HOST_CARD_ACCESS.includes(agent.project_access)
  ? { ...agent, project_access: 'write' } : agent);

/**
 * The host enables a workflow in its own room, when the owner allowed that for this room (`host_workflows`): either
 * its own draft, saved into the library first (the same ID again updates it), or one already in the library, named by
 * `workflow_id` and left unchanged there. Each card the room lacks is invited as a program-started member with at most
 * write access, one that left is brought back. Returns which member plays which card and where its SKILL.md is, so the
 * host can follow it and name them in the same execution.
 */
export async function adopt_workflow(home, { access_file, draft_file, workflow_id }) {
  if (!draft_file === !workflow_id) throw new Error('须提供 --draft 草稿文件或 --id 工作流库中的工作流 ID 之一；凭据用 --access-file 或 DISCUSS_ACCESS_FILE');
  const { config, roster } = await host_room(home, access_file);
  if (!config.host_workflows) throw new Error('房主没有为本房间打开“主持人完整权限”；请让用户在电脑上“成员与设置 → 协作设置”打开后再试');
  const bound = config.workflow?.id;
  let workflow;
  if (workflow_id) workflow = get_workflow(home, workflow_id);
  else {
    const draft = parse_workflow_draft([readFileSync(resolve(draft_file), 'utf8')]);
    if (bound !== draft.id && list_workflows(home).some(item => item.id === draft.id)) throw new Error(`工作流库已有 ${draft.id}，主持人不能覆盖其他工作流；要启用它请用 --id ${draft.id}，新建请换一个 ID`);
    workflow = draft;
  }
  assert_workflow_enabled(home, workflow.id);
  const missing = workflow.agents.filter(agent => !card_platform_ready(home, agent.name)).map(agent => agent.name || agent.card);
  if (missing.length) {
    const ready = configured_platforms(home);
    throw new Error(`本机没有配置这些卡片的软件或 API Key：${missing.join('、')}；卡片的 platform 只能用本机已配置的平台 ID：${ready.join('、')}`);
  }
  workflow = workflow_id ? { ...workflow, agents: host_cards(workflow.agents) }
    : save_workflow(home, { ...workflow, agents: host_cards(workflow.agents) }, validate_preset);
  const owner = { site: config.site, room_id: config.room, token: config.token };
  const members = await join_workflow_cards(home, config, roster, workflow, bound === workflow.id ? config.workflow.members || {} : {});
  const enabled = await room_workflow(home, { ...owner, action: 'enable', workflow: { id: workflow.id, members } });
  return { ...enabled, members, skill_path: join(workflow_directory(home, workflow.id), 'SKILL.md') };
}

/**
 * Check a workflow folder or one-part draft as an import would, and optionally save it. A local AI uses this outside
 * rooms with its user present, so the cards keep the project access they declare.
 */
export function check_or_save_workflow(home, { dir, draft }, save = false) {
  if (!dir === !draft) throw new Error('须提供 --dir 工作流文件夹或 --draft 草稿文件之一');
  const source = dir ? { folder: dir } : { parts: [readFileSync(resolve(draft), 'utf8')] };
  const preview = workflows_command(home, { action: 'preview', ...source });
  if (!save) return preview;
  const declared = list => list.map(({ requested_access, ...agent }) => requested_access ? { ...agent, project_access: requested_access } : agent);
  const sub_workflows = preview.sub_workflows?.map(sub => ({ ...sub, agents: declared(sub.agents) }));
  return save_workflow(home, { ...preview, agents: declared(preview.agents), ...(sub_workflows ? { sub_workflows } : {}) }, validate_preset);
}

const WRITING_ACCESS = new Set(['write', 'auto', 'full', 'own']);

/** The configuration this computer keeps for a room, found by its id; null when it runs no such room. */
function room_config_by_id(home, room_id) {
  if (typeof room_id !== 'string' || !room_id) return null;
  const paths = read_registry(home).filter(path => registered_identity(path)?.room === room_id);
  return paths.length === 1 ? configuration_snapshot(paths[0]).config : null;
}

/**
 * The folders a request without this computer owner's standing may use: for an ordinary account, its own projects and
 * draft space; for another device of the owner, the saved projects.
 */
function granted_projects(home) {
  const { projects_root, workspace } = account_space(home);
  if (!projects_root) return launch_projects(home).projects;
  mkdirSync(workspace, { recursive: true });
  return [...account_projects(projects_root), { name: '草稿空间', path: workspace }];
}

/** Fill program locations another device left out with the ones saved here, so saving defaults cannot drop them. */
function keep_saved_locations(home, participants) {
  const saved = launch_settings(home).participants;
  return Object.fromEntries(Object.entries(participants).map(([name, profile]) => {
    const kept = Object.fromEntries(['executable', 'ipc_directory'].filter(field => !profile?.[field] && saved[name]?.[field]).map(field => [field, saved[name][field]]));
    return [name, { ...profile, ...kept }];
  }));
}

/** CLI and local HTTP bridge use the same commands and configuration validation. */
export async function launch_main(args = process.argv.slice(2), input_text) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, 'dry-run': { type: 'boolean' }, browser: { type: 'boolean' }, remote: { type: 'boolean' }, device: { type: 'string' },
    'configuration-locked': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    draft: { type: 'string' }, 'access-file': { type: 'string' }, dir: { type: 'string' }, card: { type: 'string' }, sub: { type: 'string' }, id: { type: 'string' },
    member: { type: 'string' }, order: { type: 'string' }, revision: { type: 'string' }, name: { type: 'string' }, access: { type: 'string' },
    model: { type: 'string' }, effort: { type: 'string' }, do: { type: 'string' }, execution: { type: 'string' }, text: { type: 'string' },
    goal: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, adapter: { type: 'string' }, 'submission-id': { type: 'string' },
    message: { type: 'string' }, minutes: { type: 'string' }, off: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return process.stdout.write(HELP);
  if (positionals[0] === 'workflow-adopt') {
    const home = service_home();
    const result = await adopt_workflow(home, { draft_file: values.draft, workflow_id: values.id, access_file: values['access-file'] || process.env.DISCUSS_ACCESS_FILE });
    return process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (positionals[0] === 'host-control') {
    const { member, order, revision, name, access, model, effort, execution, text, goal, label, description, adapter } = values;
    const result = await host_control(service_home(), positionals[1], { member, order, revision, name, access, model, effort, execution, text, goal,
      label, description, adapter, message: values.message, minutes: values.minutes, off: values.off, do: values.do, submission_id: values['submission-id'], access_file: values['access-file'] || process.env.DISCUSS_ACCESS_FILE });
    return process.stdout.write(`${JSON.stringify(result)}
`);
  }
  if (positionals[0] === 'workflow-join') {
    const cards = (values.card || '').split(',').map(card => card.trim()).filter(Boolean);
    const result = await join_workflow(service_home(), { cards, sub: values.sub, access_file: values['access-file'] || process.env.DISCUSS_ACCESS_FILE });
    return process.stdout.write(`${JSON.stringify(result)}
`);
  }
  if (positionals[0] === 'workflow-leave') {
    const result = await leave_sub_workflow(service_home(), { sub: values.sub, access_file: values['access-file'] || process.env.DISCUSS_ACCESS_FILE });
    return process.stdout.write(`${JSON.stringify(result)}
`);
  }
  if (positionals[0] === 'image') {
    if (!values.file) throw new Error('用 --file 指定请求 JSON：{"action":"generate"|"edit","prompt":"…",…}');
    const request = JSON.parse(readFileSync(values.file, 'utf8').replace(/^﻿/, ''));
    const result = await draw_image(service_home(), { request, access_file: values['access-file'] || process.env.DISCUSS_ACCESS_FILE });
    return process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (['workflow-check', 'workflow-save'].includes(positionals[0])) {
    const result = check_or_save_workflow(service_home(), { dir: values.dir, draft: values.draft }, positionals[0] === 'workflow-save');
    return process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  const input = input_text === undefined ? (values.file ? JSON.parse(readFileSync(values.file, 'utf8').replace(/^\uFEFF/, '')) : null) : JSON.parse(input_text);
  const home = service_home();
  assert_shared_home(home);
  // Another device's request may only use what this computer granted; the flag is set by the relay, never by the request.
  // An ordinary account's instance holds every request, from any page, to that account's own folders.
  const space = account_space(home), restricted = Boolean(space.projects_root);
  if (values.remote || restricted) {
    guard_remote_request(positionals[0], input, { projects: granted_projects(home), participants: launch_settings(home).participants, home });
    if (values.remote && positionals[0] === 'room-workflow' && input?.action === 'host') throw new Error('“主持人完整权限”只能在电脑上开启');
    if (restricted && positionals[0] === 'pick-directory') throw new Error('此账号只能使用自己的项目文件夹');
    // Another device repeats the saved program locations it cannot see; keep them rather than dropping them.
    if (positionals[0] === 'settings' && input?.participants) input.participants = keep_saved_locations(home, input.participants);
  }
  if (values.remote) {
    // Tool approvals saved here stay this computer's decision; a room created from another device does not take them.
    if (positionals[0] === 'start' && input) input.without_saved_tools = true;
  }
  let result;
  if (positionals[0] === 'settings') result = { ...(input ? save_launch_settings(home, input) : launch_settings(home)), api_providers: API_PROVIDERS,
    scheduler_providers: SCHEDULER_PROVIDERS, scheduler_modes: SCHEDULER_MODES, scheduler_default_mode: DEFAULT_SCHEDULER_MODE, api_keys: saved_api_keys(home), managed_api_keys: restricted ? managed_api_keys(home) : [], projects: launch_projects(home).projects, projects_restricted: restricted, workspace: space.workspace, user_home: restricted ? homedir() : '', ...expert_presets(home), ...workflow_library(home) };
  else if (positionals[0] === 'projects') result = input ? save_launch_projects(home, input) : launch_projects(home);
  else if (positionals[0] === 'presets') result = input ? save_expert_presets(home, input) : expert_presets(home);
  else if (positionals[0] === 'workflows') result = await workflows_command(home, input || {});
  else if (positionals[0] === 'room-workflow' && input) result = await room_workflow(home, input);
  else if (positionals[0] === 'room-settings' && input) result = await room_settings(home, input);
  else if (positionals[0] === 'api-key' && input) result = save_api_key(home, { base_url: input.base_url, api_key: input.api_key });
  else if (positionals[0] === 'api-check' && input) result = await api_check(home, input);
  else if (positionals[0] === 'scheduler-check' && input) result = await scheduler_check(home, input);
  else if (positionals[0] === 'image-settings') result = input && Object.keys(input).length ? save_image_settings(home, input) : image_settings(home);
  else if (positionals[0] === 'tts-settings') result = input && Object.keys(input).length ? save_tts_settings(home, input) : tts_settings(home);
  else if (positionals[0] === 'tts' && input) result = await tts_speak(home, input);
  else if (positionals[0] === 'tts-release') result = tts_release(home);
  else if (positionals[0] === 'local-speech') result = input?.stop ? await local_service_stop(home, input.stop) : await local_services(home);
  else if (positionals[0] === 'weixin') result = await weixin_command(home, input || {});
  else if (positionals[0] === 'stt' && input) result = await stt_part(home, input);
  else if (positionals[0] === 'room-models' && input) result = await room_models(home, input);
  else if (positionals[0] === 'room-skills' && input) result = await room_skills(home, input);
  else if (positionals[0] === 'room-files' && input) result = await room_files(home, input);
  else if (positionals[0] === 'room-page' && input) result = await room_page(home, input, { parts: Boolean(values.remote) });
  else if (positionals[0] === 'room-media' && input) result = await room_media(home, input, { parts: Boolean(values.remote) });
  else if (positionals[0] === 'execution-details' && input) result = await execution_details_command(home, input);
  else if (positionals[0] === 'models' && adapter_profile(input?.adapter)?.kind === 'api') result = await api_models(home, input);
  else if (positionals[0] === 'models' && input) {
    const saved = Object.values(launch_settings(home).participants).find(profile => profile.adapter === input.adapter);
    result = await cached_software_models(home, { adapter: input.adapter, executable: input.executable || saved?.executable,
      ...(input.model ? { model: input.model } : {}) }, { refresh: input.refresh === true });
  }
  else if (positionals[0] === 'room-member' && input) result = await room_member(home, input);
  else if (positionals[0] === 'room-member-access' && input) result = await room_member_access(home, input);
  else if (positionals[0] === 'room-member-allow' && input) result = await room_member_allow(home, input);
  else if (positionals[0] === 'room-member-adapter' && input) result = await room_member_adapter(home, input);
  else if (positionals[0] === 'room-member-model' && input) result = await room_member_model(home, input);
  else if (positionals[0] === 'room-profiles' && input) result = await room_profiles(home, input);
  else if (positionals[0] === 'room-restore' && input) result = await restore_room(home, input);
  else if (positionals[0] === 'room-fork' && input) result = await fork_room(home, input);
  else if (positionals[0] === 'pick-directory') result = await pick_directory();
  else if (positionals[0] === 'browse-directory') result = list_remote_directories(input || {}, { projects: granted_projects(home), home });
  // Device trust from this computer's own screen; other devices reach the same actions through the relay instead.
  else if (positionals[0] === 'device-pairing' && !values.remote) {
    // The QR code opens the paired website and carries this computer's key fingerprint for the new device to check.
    const { keyed_links } = await import('./remote_launch.mjs');
    const [site, link] = Object.entries(keyed_links(home).sites).find(([origin]) => !input?.site || origin === input.site) || [];
    if (!link) throw new Error('这台电脑还没有绑定线上网站，请先运行 codiscuss local connect 网站地址');
    result = start_pairing(home, { site, fingerprint: machine_fingerprint(link), temporary: input?.temporary === true, without_passkey: input?.without_passkey === true });
  }
  else if (positionals[0] === 'devices' && !values.remote) {
    result = input?.revoke ? revoke_device(home, String(input.revoke)) : list_devices(home);
    // The website takes devices only from the list this computer signs, so a revocation is sent at once.
    if (input?.revoke) await (await import('./remote_launch.mjs')).sync_remote_launches(home).catch(() => {});
  }
  else if (positionals[0] === 'machine-link' && input) result = (await import('./remote_launch.mjs')).machine_link(home, input.site);
  else if (positionals[0] === 'start' && input) {
    result = await launch_discussion(home, input, { dry_run: values['dry-run'], browser_request: values.browser });
  }
  else if (positionals[0] === 'room-config' && input) result = await room_configuration(home, input, { local_guard: values['configuration-locked'] });
  else throw new Error(HELP);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const stdin = args.includes('--stdin') ? readFileSync(0, 'utf8') : undefined;
  launch_main(args.filter(arg => arg !== '--stdin'), stdin).catch(error => {
    // A request that needs the page to do something first (pair, renew, confirm writing) says so in a field it can read.
    const need = error.need ? { need: error.need, ...(error.room_id ? { room_id: error.room_id } : {}) } : {};
    const failure = args.includes('--browser') ? JSON.stringify({ error: error.message, ...need, launch: error.launch || { stage: 'not_started' } })
      : error.need ? JSON.stringify({ error: error.message, ...need }) : error.message;
    process.stderr.write(`${failure}\n`); process.exitCode = 1;
  });
}

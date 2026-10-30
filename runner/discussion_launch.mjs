/** Shared launch configuration for an existing AI conversation and the local website. */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { atomic_json, setup_sidecar } from './discussion_adapters.mjs';
import { session_settings, software_defaults, software_effort, software_models } from './discussion_models.mjs';
import { API_PROVIDERS, api_check, api_models, save_api_key, saved_api_keys, validate_api_profile } from './discussion_api.mjs';
import { SCHEDULER_PROVIDERS, scheduler_check } from './scheduler.mjs';
import { access_levels, BUILTIN_EXPERT_PRESETS, MAX_EXPERT_PROMPT, PROJECT_ACCESS } from './expert_prompts.mjs';
import { BRANCHABLE_ADAPTERS, branch_session } from './session_cut.mjs';
import { acquire_lock, api, CODEX_ADAPTERS, DiscussionStore, service_drafts, validate_config } from './discussion_runner.mjs';
import { FreeRoomRunner, free_task_files } from './free_runner.mjs';
import { assert_shared_home, CONNECTION_FIELDS, configuration_snapshot, read_registry, registered_identity, register_room, service_home, service_pid, start_service } from './discussion_service.mjs';

const CLIENTS = { Codex: ['codex_cli', 'codex', 'api'], Claude: ['claude', 'api'], Gemini: ['antigravity_cli', 'antigravity', 'api'], DeepSeek: ['api'], Qwen: ['api'], Grok: ['api'] };
// A platform is a type; `Claude-评审` is another Claude instance with its own session, model and effort.
const INSTANCE_PATTERN = /^(Codex|Claude|Gemini|DeepSeek|Qwen|Grok)(?:-[0-9A-Za-z_一-鿿]{1,16})?$/;

/** The platform of an AI instance name, or null. */
export function platform_of(name) { return typeof name === 'string' ? INSTANCE_PATTERN.exec(name)?.[1] ?? null : null; }

/** The first unused instance name of a platform: the platform itself, then platform-2, platform-3, …. */
export function next_instance(platform, taken) {
  if (!taken.has(platform)) return platform;
  for (let number = 2; ; number++) if (!taken.has(`${platform}-${number}`)) return `${platform}-${number}`;
}

/** Supported local clients of an instance's platform. */
function clients_of(name) { return CLIENTS[platform_of(name)]; }
// The UI discovers each model's supported subset; omitted values keep the CLI's own default.
const EFFORT_LEVELS = { codex_cli: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  antigravity_cli: ['low', 'medium', 'high', 'xhigh', 'max'] };
const PROFILE_FIELDS = ['adapter', 'executable', 'model', 'effort', 'source_thread_id', 'ipc_directory', 'allowed_tools', 'cwd', 'project_name', 'project_id', 'base_url', 'api_protocol', 'api_key_ref', 'system_prompt'];
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
      codiscuss launch models --file FILE
      codiscuss launch api-key --file FILE
      codiscuss launch api-check --file FILE
      codiscuss launch scheduler-check --file FILE
      codiscuss launch room-member --file FILE
      codiscuss launch room-member-access --file FILE
      codiscuss launch room-member-allow --file FILE
      codiscuss launch room-member-adapter --file FILE
      codiscuss launch room-profiles --file FILE
      codiscuss launch room-restore --file FILE
      codiscuss launch room-fork --file FILE
      codiscuss launch pick-directory
      codiscuss launch projects [--file FILE]
      codiscuss launch presets [--file FILE]
      codiscuss launch machine-link --file FILE
      codiscuss launch admin-account --file FILE

settings 读取本机软件默认配置；指定文件时保存，不启动 AI。
start 使用启动 JSON 创建或接入房间并启动；--dry-run 只校验和预览。
room-config 修正已暂停房间的软件路径或切换 Codex App / CLI，不启动讨论；须提供 site、room_id、token。
room-models 只读指定 site、room_id 的本机登记模型与思考强度，不启动讨论；quick 为 true 时不查询 agy 的默认模型（较慢），该成员标 defaults_pending。
models 按 adapter、executable 或 API profile 读取模型目录，不启动讨论或生成回答。
api-key 将 base_url、api_key 保存于本机私有目录，只返回 api_key_ref。
api-check 用 API profile 向模型发送一次极短请求，核对地址、密钥、协议与模型是否可用。
scheduler-check 用智能调度配置（provider、model、api_key_ref）向决策模型发送一道是非题，核对供应商、模型与密钥是否可用。
pick-directory 在本机弹出系统目录选择窗口，返回所选路径；取消时不返回路径。
projects 读取本机已配置的项目（名称与绝对路径）；提供 JSON（projects 列表）时整体替换保存。
presets 读取本机的专家预设（含内置预设）与各平台默认描述；提供 JSON（presets 列表和/或 description_templates）时替换对应部分。
machine-link 返回本机连接指定 site 的电脑编号、名称与凭据，供已登录管理员的网页完成配对；不存在时创建。
admin-account 把在指定 site 注册的管理员用户名与密码保存到服务目录的 admin-accounts.json；须提供 site、username、password。
room-member 为运行中的自由房间或讨论邀请、请回一位成员（讨论只接受本机唤醒的成员）；须提供 site、room_id、token、action（add/rejoin）、name。
room-member-access 修改一位本机唤醒成员的项目权限（project_access 为 read/write/auto/full），下次投递起生效、保留原会话；须提供 site、room_id、token、name、project_access。
room-member-allow 把被拒绝的操作加入一位本机唤醒的 Claude Code 或 agy 成员的 allowed_tools，下次投递起生效；须提供 site、room_id、token、name、rules。
room-member-adapter 把自由房间里空闲的 Codex 成员在 App（codex）与 CLI（codex_cli）间切换，保留原会话；须提供 site、room_id、token、name、adapter。
room-profiles 导出房间的本机成员软件配置与实际会话 ID（不含凭据），供备份附带；须提供 site、room_id、token。
room-restore 把导入房间的本机成员配置登记到本机并核对原会话存在，Claude Code 成员保持手动；须提供 site、room_id、token、local_members。
room-fork 把从原房间分支出的新房间登记到本机，各本机成员从原会话分叉、不含分支点之后的执行，原会话不变；须提供 site、room_id、token、source_room_id、source_token、executions（{成员名: [排除的执行编号]}）。
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

/** Return the software catalog, served from the private service home when still valid. */
export async function cached_software_models(home, profile, { refresh = false, query = software_models, query_effort = software_effort, query_defaults = software_defaults } = {}) {
  const path = join(home, 'model-catalogs.json');
  let stamp = '';
  try { const file = statSync(profile.executable); stamp = `${file.size}:${file.mtimeMs}`; } catch {}
  const key = JSON.stringify([profile.adapter, profile.executable || '', stamp]);
  const effort_key = JSON.stringify([profile.adapter, profile.executable || '', stamp, 'effort', profile.model || '']);
  let cache = {};
  try { cache = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  const cached = entry => !refresh && entry && Date.now() - entry.at < MODEL_CACHE_MS ? entry.result : null;
  // Defaults are read on every request, so a changed software setting shows without waiting out the cache.
  const [result, effort, defaults] = await Promise.all([cached(cache[key]) || query(profile),
    profile.adapter === 'antigravity_cli' ? cached(cache[effort_key]) || query_effort(profile) : null, query_defaults(profile)]);
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
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { participants: {} };
}

/**
 * Read the registered room's model choices, what each software selects for empty ones, and its smart scheduler, never connection secrets.
 * `actual_model` / `actual_effort` (present only when known) are what each member's session last ran with, read from the software's own session log.
 * With `quick`, agy's default model is not queried and its entry is marked `defaults_pending`.
 */
export async function room_models(home, raw, { read_defaults = software_defaults, read_session = session_settings } = {}) {
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
    const cli = ['codex_cli', 'claude', 'antigravity_cli', 'api'].includes(profile.adapter);
    // agy has no settings file and is run to name its default model, which takes seconds; a quick read leaves that to a later full read.
    const pending = input.quick === true && profile.adapter === 'antigravity_cli';
    const defaults = pending ? { model: '', effort: '' } : await read_defaults(profile);
    const actual = profile.adapter === 'api' ? { model: '', effort: '' } : read_session(profile.adapter, sessions[name] || profile.session_id);
    return [name, { ...(pending ? { defaults_pending: true } : {}), adapter: profile.adapter, model: cli ? profile.model || '' : '',
      effort: EFFORT_LEVELS[profile.adapter] ? profile.effort || '' : '', default_model: defaults.model, default_effort: defaults.effort,
      ...(actual.model ? { actual_model: actual.model } : {}), ...(actual.effort ? { actual_effort: actual.effort } : {}),
      project_access: profile.adapter === 'api' ? 'read' : profile.project_access || config.project_access || 'read',
      // An agy member resuming its own conversation keeps that conversation's project, so this tool cannot set its access.
      own_project: profile.adapter === 'antigravity_cli' && Boolean(profile.session_id) }];
  })));
  // Smart scheduling is a local choice; only which model decides is shown, never its key.
  const scheduler = config.scheduler ? { provider: config.scheduler.provider, model: config.scheduler.model } : null;
  return { room_id: input.room_id, registered: paths.length > 0, participants, scheduler };
}

/** Save only reusable client settings; room credentials and session bindings are never defaults. */
export function save_launch_settings(home, input) {
  const participants = {};
  for (const [name, profile] of Object.entries(input.participants || {})) {
    if (platform_of(name) !== name) throw new Error(`本机默认配置按平台保存；${name} 的模型与强度只用于本场讨论`);
    validate_profile(name, profile);
    participants[name] = profile;
  }
  const settings = { participants };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, 'launch-settings.json'), settings);
  return settings;
}

const PROJECT_NAME_LIMIT = 80;
const PROJECT_ID_PATTERN = /^[0-9a-f]{8,32}$/;

/** Read the named project directories saved on this computer, offered as launch cwd choices. */
export function launch_projects(home) {
  const path = join(home, 'launch-projects.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { projects: [] };
}

/** Replace the project list; every path must be an existing folder on this computer. */
// The id outlives renames and moves: other devices choose a project by id and never see its path.
export function save_launch_projects(home, input) {
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

/** The user's expert presets and per-platform default descriptions saved on this computer, plus the built-in presets. */
export function expert_presets(home) {
  const path = join(home, 'expert-presets.json');
  const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { presets: saved.presets || [], description_templates: saved.description_templates || {}, builtin_presets: BUILTIN_EXPERT_PRESETS };
}

/** Replace the user's presets or default descriptions (whichever the input carries); every field is checked first. */
export function save_expert_presets(home, input) {
  const current = expert_presets(home);
  const presets = input.presets === undefined ? current.presets : input.presets;
  const templates = input.description_templates === undefined ? current.description_templates : input.description_templates;
  if (!Array.isArray(presets) || presets.length > MAX_EXPERT_PRESETS) throw new Error(`presets 必须为列表，最多 ${MAX_EXPERT_PRESETS} 个`);
  const names = new Set();
  for (const preset of presets) {
    if (!preset || typeof preset !== 'object' || Object.keys(preset).some(key => !PRESET_FIELDS.includes(key))) throw new Error('预设只能包含名称、显示名、描述、提示词、项目权限、模型与强度');
    if (!platform_of(preset.name) || !clients_of(preset.name)) throw new Error(`预设名称须为“平台名”或“平台名-后缀”：${preset.name}`);
    if (names.has(preset.name)) throw new Error(`预设名称重复：${preset.name}`);
    names.add(preset.name);
    if (Object.values(preset).some(value => typeof value !== 'string')) throw new Error(`${preset.name} 的字段必须为文本`);
    if ((preset.label || '').trim().length > MAX_PRESET_LABEL) throw new Error(`${preset.name} 的显示名最多 ${MAX_PRESET_LABEL} 字`);
    if ((preset.description || '').length > MAX_PRESET_DESCRIPTION) throw new Error(`${preset.name} 的描述最多 ${MAX_PRESET_DESCRIPTION} 字`);
    if ((preset.system_prompt || '').length > MAX_EXPERT_PROMPT) throw new Error(`${preset.name} 的提示词最多 ${MAX_EXPERT_PROMPT} 字`);
    if (preset.project_access && !PROJECT_ACCESS.includes(preset.project_access)) throw new Error(`${preset.name} 的项目权限须为 read、write、auto 或 full`);
    if ([preset.model, preset.effort].some(value => (value || '').length > MAX_PRESET_FIELD)) throw new Error(`${preset.name} 的模型或强度过长`);
  }
  if (!templates || typeof templates !== 'object' || Array.isArray(templates) || Object.entries(templates).some(([platform, text]) =>
    platform_of(platform) !== platform || typeof text !== 'string' || !text.trim() || text.length > MAX_PRESET_DESCRIPTION)) {
    throw new Error(`description_templates 须为 {平台名: 描述}，每段 1–${MAX_PRESET_DESCRIPTION} 字`);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, 'expert-presets.json'), { presets, description_templates: templates });
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
    if (key === 'model' && value && !/^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/.test(value)) throw new Error(`${name}.model 只能是模型名称，例如 gpt-6-astra、opus 或 gemini-4-argon-high`);
    if (key === 'system_prompt' && value.length > MAX_EXPERT_PROMPT) throw new Error(`${name} 的专属提示词最多 ${MAX_EXPERT_PROMPT} 字`);
  }
  if (profile.adapter === 'api') validate_api_profile(profile);
  if (profile.effort && profile.adapter !== 'api' && !EFFORT_LEVELS[profile.adapter]?.includes(profile.effort)) {
    throw new Error(EFFORT_LEVELS[profile.adapter] ? `${name}.effort 只能是 ${EFFORT_LEVELS[profile.adapter].join(' / ')}`
      : `${name} 的思考档位在原软件中选择`);
  }
}

/** Send one request without following redirects that could disclose the room credential. */
async function site_request(site, path, token, body) {
  const response = await fetch(`${site}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token },
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
  if (value.project_access && !PROJECT_ACCESS.includes(value.project_access)) throw new Error('project_access 只能为 read、write、auto 或 full');
  if (value.room_id && !/^[A-Za-z0-9_-]+$/.test(value.room_id)) throw new Error('房间编号无效');
  if (!value.room_id && !value.room?.submission_id) throw new Error('新房间须提供 room.submission_id；重试沿用原编号');
  if (value.room?.mode === 'free') {
    // P1: a free room is launched once, at creation, from the web page.
    if (value.entry !== 'web' || value.room_id) throw new Error('自由协作房间目前只能在网页创建时启动');
    const members = value.room.members;
    const names = members?.map(member => typeof member === 'string' ? member : member.name);
    const woken = Array.isArray(members) ? members.filter(woken_member).map(member => typeof member === 'string' ? member : member.name) : [];
    if ((!woken.length && !value.scheduler && !value.cwd) || !names?.length || new Set(names).size !== names.length || woken.some(name => !clients_of(name))) {
      throw new Error('自由协作房间须选择至少 1 位支持自动接入的 AI 成员（或开启智能调度、指定项目目录），且不能重复');
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
  if (room.mode === 'free') return free_launch_config(home, input, room, directory, options);
  if (!clients_of(room.host)) throw new Error('请选择支持全自动讨论的 AI 主持人');
  if (!room.experts || room.experts[room.host] !== 'cli') throw new Error('请将 AI 主持人的参与方式设为本地读写');
  const online = Object.entries(room.experts).filter(([, mode]) => mode !== 'cli').map(([name]) => name);
  if (online.length) throw new Error(`全自动无法接入在线专家：${online.join('、')}。请调整参与方式或改用手动推进`);
  const defaults = options.defaults || launch_settings(home).participants;
  const manual = manual_experts(room);
  if (manual.has(room.host)) throw new Error('AI 主持人由本机服务续接，不能选择手动接入');
  const participants = {};
  for (const name of new Set([room.host, ...Object.keys(room.experts)])) {
    if (!manual.has(name)) participants[name] = participant_profile(name, defaults, input, name === room.host);
  }
  const members = launch_members(input, Object.keys(participants), options);
  return validate_config({ site: input.site, room: room.id || 'preview', token: options.token, participants, members, api_home: home,
    scheduler: input.scheduler || undefined,
    cwd: input.cwd, discussion_project: input.discussion_project, project_access: input.project_access || undefined,
    data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) }, directory);
}

/** A free-room member the local service wakes; manual and online members join without local configuration. */
function woken_member(member) { return typeof member === 'string' || !member.access || member.access === 'runner'; }

/** Free rooms add one private credential per woken member, kept with the room configuration for retries. */
function free_launch_config(home, input, room, directory, options) {
  const defaults = options.defaults || launch_settings(home).participants;
  const names = room.members.filter(woken_member).map(member => typeof member === 'string' ? member : member.name);
  const participants = Object.fromEntries(names.map(name => [name, participant_profile(name, defaults, input, false)]));
  const members = launch_members(input, names, options);
  return validate_config({ site: input.site, room: room.id || 'preview', token: options.token, mode: 'free', participants, members, api_home: home,
    scheduler: input.scheduler || undefined, cwd: input.cwd, project_access: input.project_access || undefined,
    data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) }, directory);
}

/** Preserve caller-generated member credentials; journal newly generated ones before creation. */
function launch_members(input, names, options) {
  return Object.fromEntries(names.map(name => {
    const supplied = input.room?.members?.find(member => member?.name === name);
    return [name, { token: supplied?.token || options.members?.[name]?.token || `${randomUUID()}${randomUUID()}` }];
  }));
}

/** Merge one participant's machine defaults with this launch's overrides and check its software. */
function participant_profile(name, defaults, input, current_host) {
  const platform = platform_of(name);
  // An extra instance starts from its platform's settings but never from another instance's bound session.
  const { session_id: ignored_session, ...inherited } = name === platform ? {} : input.participants?.[platform] || {};
  const profile = { ...defaults[platform], ...(name === platform ? {} : defaults[name]), ...inherited, ...input.participants?.[name] };
  for (const field of ['cwd', 'model', 'effort', 'project_name', 'project_id', 'project_access']) if (profile[field] === '') delete profile[field];
  validate_profile(name, profile, true);
  if (!clients_of(name)?.includes(profile.adapter)) throw new Error(`请配置 ${name} 的 CLI / App 客户端`);
  if (profile.adapter === 'api') {
    if (input.entry === 'conversation' && current_host) throw new Error('API 主持人请从网页启动；当前软件会话主持须选择对应 CLI / App');
    return profile;
  }
  if (profile.adapter !== 'antigravity' && (!existsSync(profile.executable || '') || !statSync(profile.executable).isFile()
    || (process.platform === 'win32' && !/\.exe$/i.test(profile.executable)))) throw new Error(`${name}：请指定实际原生可执行文件，Windows 使用 .exe`);
  const cwd = profile.cwd || input.cwd;
  if (cwd && (!existsSync(cwd) || !statSync(cwd).isDirectory())) throw new Error(`${name}：工作目录不存在或不是文件夹，请核对本次目录配置`);
  if (input.entry === 'conversation' && current_host) profile.session_id = input.current_session_id;
  // A new agy conversation always gets this tool's discussion project; only a manual agy expert the owner chose to host (input.adopt) keeps its own.
  if (profile.adapter === 'antigravity_cli' && profile.session_id && !input.adopt) throw new Error(`${name}：agy 不能绑定已有会话或从当前 agy 对话主持全自动讨论；请从网页或其他软件发起，agy 会由讨论服务新建会话`);
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
 * from the original one, so its cwd follows the session; a different room project is refused.
 */
export function borrowed_session(name, profile, room_cwd, env = process.env) {
  const id = profile.session_id;
  if (!SESSION_ID_PATTERN.test(id)) throw new Error(`${name}：会话 ID 格式不正确`);
  if (CODEX_ADAPTERS.includes(profile.adapter)) {
    const sessions = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
    if (!session_files(sessions).some(path => path.endsWith(`-${id}.jsonl`))) throw new Error(`${name}：本机找不到 Codex 会话 ${id}，请核对会话 ID`);
    return profile;
  }
  if (['antigravity', 'antigravity_cli'].includes(profile.adapter)) {
    if (!existsSync(agy_conversation(profile.adapter, id))) throw new Error(`${name}：本机找不到 agy 会话 ${id}，请核对会话 ID`);
    return profile;
  }
  if (profile.adapter !== 'claude') throw new Error(`${name}：只有 Codex、Claude 与 agy 可以接入已有会话`);
  const projects = join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
  const file = session_files(projects).find(path => path.endsWith(`${id}.jsonl`) && dirname(dirname(path)) === projects);
  if (!file) throw new Error(`${name}：本机找不到 Claude 会话 ${id}，请核对会话 ID`);
  const cwd = readFileSync(file, 'utf8').split('\n').map(line => { try { return JSON.parse(line).cwd; } catch { return undefined; } }).find(Boolean);
  if (!cwd) throw new Error(`${name}：Claude 会话 ${id} 没有记录原工作目录，无法续接`);
  const wanted = profile.cwd || room_cwd;
  if (wanted && !same_directory(wanted, cwd)) throw new Error(`${name}：这个 Claude 会话属于 ${cwd}，只能在原目录续接；请让项目目录与它一致，或留空会话 ID 新建会话`);
  return { ...profile, cwd: wanted || cwd };
}

/** Find the one registered configuration of a room after proving the owner's credential. */
async function member_room_context(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim()) throw new Error('管理成员须提供房间编号和房间控制凭据');
  const paths = read_registry(home).filter(path => {
    const identity = registered_identity(path);
    return identity?.site === input.site && identity.room === input.room_id;
  });
  if (paths.length !== 1) throw new Error('未找到本房间唯一的已登记配置，请核对本机接入服务');
  const config = configuration_snapshot(paths[0]).config;
  // Both reads need the owner credential; the inbox transfers no messages.
  await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
  return { input, path: paths[0], config };
}

/** Write a manual member's private credential next to the room configuration, never into a receipt. */
function manual_access(path, input, name, token) {
  const access_path = join(dirname(path), `manual-${name}.access.json`);
  atomic_json(access_path, { site: input.site, room: input.room_id, token });
  return access_path;
}

/**
 * Invite (add) or bring back (rejoin) one member of a running free room or discussion.
 * The local configuration is written before the website call, so a retry reuses the same credential.
 * A discussion's manual expert answers with its own credential and is never woken.
 */
export async function room_member(home, raw, locked = false) {
  const { input, path, config: registered } = await member_room_context(home, raw);
  const { action, name } = input;
  const access = input.access || 'runner';
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  const free = room.mode === 'free';
  if (!['add', 'rejoin'].includes(action) || !platform_of(name) || (access !== 'manual' && !clients_of(name)) || !['runner', 'manual'].includes(access)) {
    throw new Error('action 须为 add/rejoin，成员须为支持的 AI，接入方式须为 runner/manual');
  }
  const release = locked ? () => {} : acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    config.api_home = home;
    const roster = free ? room.free.members : room.members;
    if (action === 'add' && input.new_instance) {
      // A name once bound keeps its session locally, so a new instance never reuses a removed member's name.
      const taken = new Set([...roster.map(member => member.name), ...Object.keys(config.participants), ...Object.keys(config.members || {})]);
      return room_member(home, { ...raw, name: next_instance(platform_of(name), taken), new_instance: false }, true);
    }
    const current = roster.find(member => member.name === name);
    if (input.member_token !== undefined && (typeof input.member_token !== 'string' || input.member_token.length < 32 || input.member_token.length > 256)) throw new Error('member_token 须为 32–256 字符');
    if (current?.status === 'active' && input.member_token && config.members?.[name]?.token === input.member_token) {
      const view = await site_request(input.site, `/api/rooms/${input.room_id}/members/${current.id}`, input.token, { action: 'active', token: input.member_token });
      return { room_id: input.room_id, member: name, access: current.access, [free ? 'free' : 'room']: view, access_file: null };
    }
    if (action === 'add' && !current && config.participants[name] && !locked) throw new Error(`${name} 曾在本房间使用过并绑定了会话；请换一个名称`);
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
      input.token, body);
    return { room_id: input.room_id, member: name, access: manual ? 'manual' : 'runner', [free ? 'free' : 'room']: view, access_file };
  } finally { release(); }
}

// CLIs whose project file access this tool sets per run; App members follow the App's own settings, API members only read.
const ACCESS_ADAPTERS = ['codex_cli', 'claude', 'antigravity_cli'];

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
    if (!access_levels(profile.adapter).includes(project_access)) throw new Error('agy 无人值守不支持自动档，请选只读、可写或全放开');
    if (!ACCESS_ADAPTERS.includes(profile.adapter)) throw new Error(profile.adapter === 'api' ? 'API 成员没有本机文件工具，项目固定只读' : `${name} 的项目权限在 App 内设置`);
    if (profile.adapter === 'antigravity_cli' && profile.session_id) throw new Error(`${name} 续接的是它自己的 agy 对话，项目权限沿用该对话所在项目，请在 agy 中设置`);
    if (project_access === 'write' && !(profile.cwd || config.cwd)) throw new Error('本房间没有指定项目目录，可写没有作用；请在新建房间时选择项目目录');
    const next = { ...config, participants: { ...config.participants, [name]: { ...profile, project_access } } };
    validate_config(next, dirname(path));
    atomic_json(path, next);
    return { room_id: input.room_id, member: name, project_access };
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
    if (!['claude', 'antigravity_cli'].includes(profile.adapter)) throw new Error(`${name} 的软件不支持逐条放行，请改用更高的权限档位`);
    if (profile.adapter === 'antigravity_cli' && profile.session_id) throw new Error(`${name} 续接的是它自己的 agy 对话，权限沿用该对话所在项目，请在 agy 中设置`);
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
  const { input, path, config: registered } = await member_room_context(home, raw);
  const { name, adapter } = input;
  if (registered.mode !== 'free') throw new Error('讨论进行中不能切换；结束讨论后再切换，或暂停后在“接入”页修正');
  if (!CODEX_ADAPTERS.includes(adapter)) throw new Error('adapter 只能为 codex（App）或 codex_cli（CLI）');
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  const member = room.free.members.find(item => item.name === name);
  if (member?.pending > 0 || ['dispatched', 'started'].includes(member?.execution?.status)) throw new Error(`${name} 正在处理请求，请等它完成或先停止`);
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const profile = config.participants?.[name];
    if (!CODEX_ADAPTERS.includes(profile?.adapter)) throw new Error(`${name} 不是本机唤醒的 Codex 成员`);
    if (profile.adapter === adapter) return { room_id: input.room_id, member: name, adapter };
    const context = { config, path };
    const next = { ...profile };
    switch_codex_adapter(context, name, next, adapter);
    if (adapter === 'codex') { delete next.model; delete next.effort; }
    const updated = { ...config, participants: { ...config.participants, [name]: next } };
    validate_config(updated, dirname(path));
    atomic_json(path, updated);
    return { room_id: input.room_id, member: name, adapter };
  } finally { release(); }
}

/** A Codex desktop chat is resumed through the app, any other Codex session through the CLI. */
function codex_session_adapter(session_id, env = process.env) {
  const sessions = join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions');
  const file = session_files(sessions).find(path => path.endsWith(`-${session_id}.jsonl`));
  const meta = file ? readFileSync(file, 'utf8').split('\n', 1)[0] : '';
  return /"originator":"Codex Desktop"/.test(meta) ? 'codex' : 'codex_cli';
}

/** Where the Antigravity App or agy CLI keeps one conversation; the two keep separate stores. */
function agy_conversation(adapter, session_id) {
  return join(homedir(), '.gemini', adapter === 'antigravity' ? 'antigravity' : 'antigravity-cli', 'conversations', `${session_id}.db`);
}

/**
 * Register a manual Claude, Codex or agy expert's own session as a hosted participant, so the service resumes it for later turns.
 * Returns the adapter used. Throws when the local software is not configured or the session is not found on this machine; the member then stays manual.
 */
export function adopt_member_profile(home, path, name, session_id, client = 'claude', member_token = '') {
  const release = acquire_lock(join(dirname(path), 'configuration-edit'));
  try {
    const config = configuration_snapshot(path).config;
    const adapter = client === 'codex' ? codex_session_adapter(session_id)
      : client === 'antigravity' ? (existsSync(agy_conversation('antigravity', session_id)) ? 'antigravity' : 'antigravity_cli') : 'claude';
    // An App conversation is reached through this room's own Sidecar, which the App starts as soon as it is configured.
    const sidecar = adapter === 'antigravity' ? { ipc_directory: join(dirname(path), 'agy-app-sidecar') } : {};
    // A manually started member keeps its own session's permissions; the room's 只读 / 可写 does not apply to it.
    const input = { cwd: config.cwd, adopt: true, participants: { [name]: { adapter, session_id, project_access: 'own', ...sidecar } } };
    // Its model, effort, prompt and tools stay as the user set them in that session; machine defaults never override them.
    const { model, effort, allowed_tools, system_prompt, ...own } = participant_profile(name, launch_settings(home).participants, input, false);
    const profile = borrowed_session(name, own, config.cwd);
    if (sidecar.ipc_directory) setup_sidecar(sidecar);
    // A free room delivers with each member's own credential; the browser-made one is not kept locally, so the owner issues a new one.
    const next = { ...config, participants: { ...config.participants, [name]: profile },
      ...(member_token ? { members: { ...config.members, [name]: { token: member_token, pending: '' } } } : {}) };
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
  return { room_id: input.room_id, local_members: { format: LOCAL_MEMBERS_FORMAT, version: 1, mode: config.mode || 'brainstorm',
    cwd: config.cwd, discussion_project: config.discussion_project, project_access: config.project_access, scheduler: config.scheduler, participants } };
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
  if (local.mode !== 'free') throw new Error('只有自由协作房间可以恢复本机成员会话');
  await site_request(input.site, `/api/rooms/${input.room_id}/inbox`, input.token);
  const room = await site_request(input.site, `/api/rooms/${input.room_id}`, input.token);
  if (registered_room_path(home, input.site, input.room_id)) throw new Error('本房间已在本机登记，不重复恢复');
  if (local.cwd && (!isAbsolute(local.cwd) || !existsSync(local.cwd) || !statSync(local.cwd).isDirectory())) throw new Error(`房间项目目录 ${local.cwd} 在本机不存在`);
  const keep_manual = room.free.members.filter(member => member.access === 'manual' && member.status !== 'removed' && platform_of(member.name) === 'Claude').map(member => member.name);
  const participants = {}, members = [];
  for (const [name, exported] of Object.entries(local.participants)) {
    try {
      const profile = participant_profile(name, {}, { cwd: local.cwd, adopt: true, participants: { [name]: exported } }, false);
      // An API member's binding lives in the old runtime directory, not in any software's session store, so it starts fresh.
      if (profile.adapter === 'api') delete profile.session_id;
      const resumed = profile.session_id ? borrowed_session(name, profile, local.cwd) : profile;
      if (profile.adapter === 'claude') {
        keep_manual.push(name);
        members.push({ name, status: 'manual', session_id: resumed.session_id || '', cwd: resumed.cwd || local.cwd || '' });
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
    project_access: local.project_access || undefined, data_directory: join(directory, 'runtime'), draft_directory: service_drafts(home, join(directory, 'runtime')) };
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
 * Requires both rooms' owner credentials; members the new room keeps manual or online are not registered here.
 * Returns `{room_id, registered, members: [{name, status: forked|fresh|failed, error?}]}`.
 */
export async function fork_room(home, raw) {
  const input = launch_input({ ...raw, entry: 'web' });
  if (!input.room_id || typeof input.token !== 'string' || !input.token.trim() || typeof raw.source_room_id !== 'string' || typeof raw.source_token !== 'string') {
    throw new Error('分支须提供新房间与原房间的编号和控制凭据');
  }
  const local = (await room_profiles(home, { site: input.site, room_id: raw.source_room_id, token: raw.source_token })).local_members;
  if (!local) return { room_id: input.room_id, registered: false, members: [] };
  if (local.mode !== 'free') throw new Error('只有协作房间可以分支');
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
      const located = profile.adapter === 'claude' ? borrowed_session(name, profile, local.cwd) : profile;
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
  if (!CODEX_ADAPTERS.includes(profile.adapter) || !CODEX_ADAPTERS.includes(adapter)) throw new Error('本场仅支持 Codex App / CLI 切换');
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
    const field = profile?.adapter === 'antigravity' ? 'ipc_directory' : 'executable';
    const fields = CODEX_ADAPTERS.includes(profile?.adapter) ? [field, 'adapter'] : [field];
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
  const legacy = previous && !previous.request_signature ? JSON.parse(previous.signature) : null;
  const config_path = join(directory, 'config.json');
  const saved = previous?.config || (previous && existsSync(config_path) ? JSON.parse(readFileSync(config_path, 'utf8')) : null);
  const token = input.token || previous?.token || randomUUID();
  const room_id = input.room_id || previous?.room_id || (saved?.room !== 'preview' ? saved?.room : null);
  if (options.browser_request && previous && token !== previous.token && !room_id) throw new Error('尚未确认原房间，不能替换本次控制凭据');
  const room = room_id ? await site_request(input.site, `/api/rooms/${room_id}`, token) : input.room;
  if (room.runtime?.protected && !input.token && !previous) throw new Error('已有房间需要原接入配置的 access_file');
  if (!previous && room.runtime && room.runtime.status !== 'ready') throw new Error('房间已启动过；请沿用原配置核对或从原进度看板明确继续');
  const config = previous?.request_signature ? { ...structuredClone(saved), token }
    : launch_config(home, input, room, directory, { token, defaults: saved?.participants || legacy?.participants, members: saved?.members });
  config.draft_directory = service_drafts(home, config.directory);
  if (previous?.request_signature && !previous.finished) validate_config(config, directory);
  const minutes = previous?.minutes ?? legacy?.minutes ?? launch_minutes(input, room);
  const draft = signature({ entry: input.entry, room_id: input.room_id, room: input.room, participants: config.participants, cwd: input.cwd, discussion_project: input.discussion_project, minutes });
  if (legacy && previous.signature !== draft) throw new Error('启动配置与原请求不同；同一次重试须沿用原配置，新讨论请使用新提交编号');
  if (room.id) await verify_control(config, room);
  return { input, config, room, minutes, draft, request_signature, directory, previous };
}

/** Launch a room through either entry, using a durable journal for safe retries. */
export async function launch_discussion(home, raw, options = {}) {
  assert_shared_home(home);
  const input = launch_input(raw);
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
      members: [...Object.keys(config.participants).map(name => ({ name, adapter: config.participants[name].adapter,
        token: config.members[name].token, access: 'runner', session_mode: config.participants[name].session_id ? 'borrowed' : 'new' })),
      // Manual and online members keep the credentials the browser generated; nothing local is configured for them.
      ...(input.room.members || []).filter(member => record.discussion ? member?.access === 'manual' : !woken_member(member))
        .map(({ name, token, access }) => ({ name, token, access, adapter: '', session_mode: 'new' }))],
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

/** CLI and local HTTP bridge use the same commands and configuration validation. */
export async function launch_main(args = process.argv.slice(2), input_text) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    file: { type: 'string' }, 'dry-run': { type: 'boolean' }, browser: { type: 'boolean' },
    'configuration-locked': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) return process.stdout.write(HELP);
  const input = input_text === undefined ? (values.file ? JSON.parse(readFileSync(values.file, 'utf8').replace(/^\uFEFF/, '')) : null) : JSON.parse(input_text);
  const home = service_home();
  assert_shared_home(home);
  let result;
  if (positionals[0] === 'settings') result = { ...(input ? save_launch_settings(home, input) : launch_settings(home)), api_providers: API_PROVIDERS,
    scheduler_providers: SCHEDULER_PROVIDERS, api_keys: saved_api_keys(home), projects: launch_projects(home).projects, ...expert_presets(home) };
  else if (positionals[0] === 'projects') result = input ? save_launch_projects(home, input) : launch_projects(home);
  else if (positionals[0] === 'presets') result = input ? save_expert_presets(home, input) : expert_presets(home);
  else if (positionals[0] === 'api-key' && input) result = save_api_key(home, input);
  else if (positionals[0] === 'api-check' && input) result = await api_check(home, input);
  else if (positionals[0] === 'scheduler-check' && input) result = await scheduler_check(home, input);
  else if (positionals[0] === 'room-models' && input) result = await room_models(home, input);
  else if (positionals[0] === 'models' && input?.adapter === 'api') result = await api_models(home, input);
  else if (positionals[0] === 'models' && input) {
    const saved = Object.values(launch_settings(home).participants).find(profile => profile.adapter === input.adapter);
    result = await cached_software_models(home, { adapter: input.adapter, executable: input.executable || saved?.executable,
      ...(input.model ? { model: input.model } : {}) }, { refresh: input.refresh === true });
  }
  else if (positionals[0] === 'room-member' && input) result = await room_member(home, input);
  else if (positionals[0] === 'room-member-access' && input) result = await room_member_access(home, input);
  else if (positionals[0] === 'room-member-allow' && input) result = await room_member_allow(home, input);
  else if (positionals[0] === 'room-member-adapter' && input) result = await room_member_adapter(home, input);
  else if (positionals[0] === 'room-profiles' && input) result = await room_profiles(home, input);
  else if (positionals[0] === 'room-restore' && input) result = await restore_room(home, input);
  else if (positionals[0] === 'room-fork' && input) result = await fork_room(home, input);
  else if (positionals[0] === 'pick-directory') result = await pick_directory();
  else if (positionals[0] === 'machine-link' && input) result = (await import('./remote_launch.mjs')).machine_link(home, input.site);
  else if (positionals[0] === 'admin-account' && input) result = (await import('./admin_account.mjs')).save_admin_account(home, input);
  else if (positionals[0] === 'start' && input) result = await launch_discussion(home, input, { dry_run: values['dry-run'], browser_request: values.browser });
  else if (positionals[0] === 'room-config' && input) result = await room_configuration(home, input, { local_guard: values['configuration-locked'] });
  else throw new Error(HELP);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const stdin = args.includes('--stdin') ? readFileSync(0, 'utf8') : undefined;
  launch_main(args.filter(arg => arg !== '--stdin'), stdin).catch(error => {
    const failure = args.includes('--browser') ? JSON.stringify({ error: error.message, launch: error.launch || { stage: 'not_started' } }) : error.message;
    process.stderr.write(`${failure}\n`); process.exitCode = 1;
  });
}

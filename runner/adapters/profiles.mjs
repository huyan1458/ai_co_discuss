/**
 * What each supported software is and can do, as plain data: the adapter layer's static facts. Imports nothing, so the
 * runner, the launch settings and the web page (bundled by Vite) all read the same table; behaviour lives in each
 * software's own module (see index.mjs). Product code reads these fields, never a software name (AGENTS.md red line 9).
 *
 * Fields of one profile:
 * - `platform`: the AI platform it serves (`Codex`, `Claude`, `Antigravity`); '' serves any platform (model API).
 * - `label`: display name. `kind`: `cli` (a process the runner starts), `app` (a desktop App) or `api` (a model API the runner calls through Pi).
 * - `location`: the config field locating the installed software (`executable`, `ipc_directory`), or '' when none.
 * - `fields`: further config fields the user may set for it.
 * - `efforts`: thinking levels it accepts, or null when chosen inside the App or with the model itself; `efforts_per_model`:
 *   the levels are read from the software for the chosen model. `models`: whether its CLI lists models (an API member's
 *   model is a typed ID).
 * - `access_levels`: project access levels it can enforce per run, or null when the App or API decides; `access_hints`
 *   says what each level does in it (measured headless on Claude Code 2.1.312, Codex CLI 0.163, agy 1.4.10; not yet
 *   rechecked on Claude Code 2.1.319 or agy 1.5.2) and
 *   `unsupported_hints` why a level it lacks is disabled.
 * - `per_tool_allow`: a refused operation can be allowed one rule at a time.
 * - `client`: the software a manual member says it runs in when it registers (`codex`, `claude`, `antigravity`).
 * - `adopt`: an existing conversation can be taken over: `session`, or `own_cwd` when it must resume in the directory it
 *   was made in; '' when it cannot. `host_existing`: it may also host from, or be bound to, an existing conversation.
 *   `own_project_when_bound`: bound to an existing conversation, it keeps that conversation's project and permissions.
 *   `restore_manual`: a restored room keeps it manual, never taken over (a background resume would fork the session
 *   away from its original window).
 *   `resume_command(session_id)`: a command the owner can copy to reopen a restored manual conversation.
 *   `browse_sessions`: its stored conversations can be listed and previewed on this machine, so the owner picks the one a
 *   new member resumes from a browsing window instead of typing its ID; a picked conversation may be bound even without
 *   `host_existing`.
 *   `copy_bound`: a woken member bound to an existing conversation (picked in that window, given by ID or restored)
 *   works in a copy of it made at its first turn, so the original stays as it was: resuming it in the background beside
 *   a window still open on it would split it. A taken-over manual member (`own`) keeps its original conversation.
 * - `defaults_by_query`: its default model is read by running it (seconds), so a quick read leaves it for later.
 * - `capabilities`: `delivery` `{stoppable, progress}` of a usual delivery (each delivery reports its own); `rewind`: `cut`
 *   (the runner cuts the session), `fresh` (context rebuilt each time) or `kept` (cannot be cut here); `project` (works in
 *   a project directory); `images` (a usual delivery takes the woken messages' images with the prompt, as a
 *   screenshot pasted into the software does; measured on Claude Code 2.1.325 and Codex CLI 0.163, 2026-11-14;
 *   `'configured'` when the member's own `image_input` setting says its model reads images, see `takes_images`); `access_env` (its process takes the credential file by environment); `enforces_read_only`
 *   (its sandbox enforces a read-only project); `ripgrep` (bundles rg for reading on Windows); `file_tools` (works on
 *   the project only through the runner's file tools, running no commands); `limits_directories` (a directory it may
 *   only read stays read-only even while it may write elsewhere and run commands: a sandbox or file tools, not rules
 *   that a command could bypass); `chat` (the owner's private chat runs as a turn of its own session and its reply is
 *   read from the software's output); `resume` (a stopped turn can go on in the same session, so the owner may pause
 *   a room execution from the private chat without ending it; not yet measured on real software); `close_grace_ms` (after a
 *   normal completion its process is left this long to record the receipt it got before it is stopped; measured per
 *   software, absent means it is stopped at once). `schedule_reports`: where a schedule the member set in its own
 *   software can be followed when it fires, so the host's comes into the room (`'window'`: only a delivery into its open
 *   window; absent: none). `tool_lockdown`: a task with `tool_lockdown: true` can be confined
 *   to the codiscuss subcommands, with no other local file access, no web and no MCP (see `lockdown_support`; not yet
 *   measured on real software, 2026-11-15).
 * - `capabilities.system_prompt`: where the member's own prompt can go into the software's system prompt: `session`
 *   (set when the runner starts a new session and kept by it after: Claude Code's snapshot, a Codex thread's developer
 *   instructions; a changed prompt then goes into the next task text), `launch` (rebuilt at every launch, so always
 *   current); absent when it cannot, and the prompt goes into the first task sent to each session instead.
 * - `lockdown_hint`: why it cannot be confined, shown when a confined task is refused.
 * - `session_family`: profiles sharing one session store; switching among them keeps the conversation.
 * - `windows_command`: how its shell names the codiscuss CLI on Windows.
 * - `task_rules(cli, {runs_commands})`: fixed task text this software needs, added by the runner so no member prompt drops it;
 *   built from `rules`: each `{ id, when, text(cli) }`, `when` being `always` or `read_only` (only while it may not run
 *   any command). The settings page shows each by its `id` with a line for people (SystemPrompts.vue).
 * - `sandbox_needs_desktop`: its sandbox cannot start in a background session without a desktop, so there it runs without
 *   one and `adapter_capabilities` reports `no_sandbox` and no enforced limits (see `NO_DESKTOP_VARIABLE`).
 */
const ALL_ACCESS = ['read', 'write', 'auto', 'full'];
/**
 * The card shows only the software's text between tool calls, not its thinking (Claude Code, measured 2026-11-21; agy
 * 1.5.16 gives only a thinking token count, 2026-11-25): without this rule a user waiting sees nothing of its progress.
 */
const PROGRESS_RULE = { id: 'progress', when: 'always', text: () => '多步任务中，转入新的一段工作时（如读完代码开始修改、改完开始验证）先用一句话说明再继续：'
  + '用户等待时网页卡片只显示这些话，看不到你的思考。用请求者的语言写，即使代码和工具输出是英文；一句即可，不打断手头的工作。' };
/** The fixed task text of a software's rules that apply now. */
function rules_text(rules, cli, { runs_commands }) {
  return rules.filter(rule => rule.when === 'always' || !runs_commands).map(rule => rule.text(cli)).join('');
}
/**
 * Set to '1' by the start script of an instance running as a background task of its own Windows user. Codex CLI 0.169's
 * sandbox process exits with 0xC0000142 there, while the same settings start on a desktop (tested 2026-11-18).
 */
export const NO_DESKTOP_VARIABLE = 'CODISCUSS_NO_DESKTOP';
// The web page bundles this file and has no process.
const no_desktop = () => globalThis.process?.env?.[NO_DESKTOP_VARIABLE] === '1';
/** API slot defaults; identity and wire protocol stay independent, and a custom slot starts without a provider. */
export const API_PROVIDERS = {
  Codex: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', api_protocol: 'responses', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] },
  Claude: { label: 'Anthropic', base_url: 'https://api.anthropic.com/v1', api_protocol: 'anthropic', models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'] },
  Antigravity: { label: 'Google', base_url: 'https://generativelanguage.googleapis.com/v1beta', api_protocol: 'gemini', models: ['gemini-4-argon', 'gemini-3.8-flash'] },
  DeepSeek: { label: 'DeepSeek', base_url: 'https://api.deepseek.com/v1', api_protocol: 'chat', models: ['deepseek-flash', 'deepseek-v4-pro'] },
  Qwen: { label: '阿里云百炼', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_protocol: 'chat', models: ['qwen3.8-flash', 'qwen3.7-plus', 'qwen3.8-max'] },
  Grok: { label: 'xAI', base_url: 'https://api.x.ai/v1', api_protocol: 'responses', models: ['grok-4.7'] },
  OpenAI: { label: 'OpenAI', base_url: 'https://api.openai.com/v1', api_protocol: 'responses', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] },
  Custom: { label: '自定义 API', base_url: '', api_protocol: 'chat', models: [] },
};
/**
 * Image models this computer's image service (image_service.mjs) offers for the Images API, newest first: 2.6 adds
 * complexity, SVG and GIF output; 2.5 and 2.6 take markup edits and the xhigh / max qualities (OpenAI docs, 2026-11-10).
 * Any other ID may still be typed in.
 */
export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst',
  'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest'];
/** Model requests one model-API execution may make unless the room sets its own; 0 means no limit, up to the maximum. */
export const DEFAULT_API_MAX_REQUESTS = 300;
export const MAX_API_MAX_REQUESTS = 1000;
const PROCESS = { stoppable: true, progress: true };
const IN_APP = { stoppable: false, progress: false };
// `capture`: what the runner saves as the answer (`source: auto`) when the software ends normally while the service has no
// answer for the execution and no refused submit from it; false when the delivery never captures (spec #3262 items 3, 7).
const FINAL_REMARK = 'final_remark';

export const ADAPTER_PROFILES = {
  codex_cli: {
    platform: 'Codex', label: 'Codex CLI', kind: 'cli', location: 'executable', fields: ['project_id', 'project_name'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], models: true, access_levels: ALL_ACCESS, per_tool_allow: false,
    access_hints: { read: '只读沙箱', write: '项目可写的沙箱，命令在沙箱内运行、可联网',
      auto: '沙箱外的操作由模型申请提权，Codex 自动审核代替人工批准', full: '无沙箱、无审批（--dangerously-bypass-approvals-and-sandbox）' },
    client: 'codex', adopt: 'session', host_existing: true, session_family: 'codex', browse_sessions: true, copy_bound: true,
    lockdown_hint: '沙箱只读档仍可读整个磁盘、运行任意只读命令，无法只放行 codiscuss 命令',
    sandbox_needs_desktop: true,
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, enforces_read_only: true, limits_directories: true, ripgrep: true, chat: true, resume: true, images: true, capture: FINAL_REMARK,
      tool_lockdown: false, system_prompt: 'session',
      // Codex CLI 0.163 records a command's output in its session about 0.1 s after reporting it done (2026-11-15).
      close_grace_ms: 1500 },
  },
  codex: {
    platform: 'Codex', label: 'Codex App', kind: 'app', location: 'executable', fields: ['source_thread_id', 'project_id', 'project_name'],
    efforts: null, models: false, access_levels: null, per_tool_allow: false,
    client: 'codex', adopt: 'session', host_existing: true, session_family: 'codex', browse_sessions: true,
    lockdown_hint: '权限由 App 决定，接入程序无法逐次收窄',
    capabilities: { delivery: IN_APP, rewind: 'cut', project: true, chat: true, capture: false, tool_lockdown: false },
  },
  claude: {
    platform: 'Claude', label: 'Claude Code', kind: 'cli', location: 'executable', fields: ['allowed_tools'],
    // `models_open`: the listed models are its picker's aliases and the CLI also takes full model IDs, so a model missing
    // from the list is not known to be unavailable.
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: true, models_open: true, access_levels: ALL_ACCESS, per_tool_allow: true,
    access_hints: { read: '只放行网站命令与草稿，不改项目文件、不跑其他命令', write: '可改项目文件，Bash / PowerShell 命令全部放行（无沙箱）',
      auto: 'Claude auto 模式：由分类器判断，实测项目外写入和联网都会放行', full: 'bypassPermissions：跳过全部权限检查' },
    client: 'claude', adopt: 'own_cwd', host_existing: true, restore_manual: true, browse_sessions: true, copy_bound: true,
    resume_command: session_id => `claude --resume ${session_id}`,
    // Claude Code runs commands through bash on Windows too, where the npm shim works without .cmd.
    windows_command: 'codiscuss',
    // Confined by --restricted --safe-mode --tools and dontAsk (claude_lockdown); a taken-over manual member keeps its own window.
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, chat: true, resume: true, images: true, capture: FINAL_REMARK, tool_lockdown: true, system_prompt: 'session',
      // Only the window's session log marks a fire; a `-p` process loses its schedules when it exits (2.1.326).
      schedule_reports: 'window' },
    // The card shows only Claude's text between tool calls, not its thinking; without this rule it wrote one line per
    // five to fourteen calls, often in English (2026-11-21 session record).
    rules: [PROGRESS_RULE],
    task_rules(cli, options) { return rules_text(this.rules, cli, options); },
  },
  antigravity_cli: {
    platform: 'Antigravity', label: 'Antigravity CLI', kind: 'cli', location: 'executable', fields: ['project_id', 'project_name'],
    // agy names the thinking level inside the model ID (gemini-4-neon-xhigh) and, since 1.5, refuses a separate --effort
    // that disagrees with it, so the level is chosen with the model and no effort is offered.
    efforts: null, models: true, defaults_by_query: true,
    // Headless agy refuses `--mode auto` ("not available for this account", 1.4.10–1.4.11 and 1.5.16), so 自动 is not offered.
    access_levels: ['read', 'write', 'full'], per_tool_allow: true,
    access_hints: { read: '只放行网站命令；碰到未放行的命令会直接结束本轮', write: '可写项目，命令全部放行（在 agy 沙箱内）',
      full: '跳过全部权限确认（--dangerously-skip-permissions），并放开沙箱外命令与 MCP 工具' },
    unsupported_hints: { auto: 'agy 只在交互窗口提供自动模式，后台运行（-p）不支持' },
    // Only a conversation this tool created gets its session rules; an existing one keeps its own project and permissions.
    client: 'antigravity', adopt: 'session', host_existing: false, own_project_when_bound: true, browse_sessions: true, copy_bound: true,
    // Confined by session rules that allow only the codiscuss commands and deny MCP and web reads (agy_lockdown_grants).
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, chat: true, capture: FINAL_REMARK, tool_lockdown: true },
    // A read-only agy session allows only codiscuss commands and headless agy ends the turn on a denied one; agy streams no
    // thinking text, so without a word at each turning point the page cannot show how far it got.
    // A denied command ends headless agy's turn at once (1.5.16, 2026-11-25), so it must not list or read through the shell.
    rules: [{ id: 'commands_only', when: 'read_only', text: cli => `无人值守下 run_command 只能运行 ${cli} 的 subcommands 子命令，其他命令会被自动拒绝，本轮任务随即中断；列目录、搜索或读取文件用你环境自带的文件工具，不要经 run_command。` },
      PROGRESS_RULE],
    task_rules(cli, options) { return rules_text(this.rules, cli, options); },
  },
  antigravity: {
    platform: 'Antigravity', label: 'Antigravity App', kind: 'app', location: 'ipc_directory', fields: ['project_id', 'project_name'],
    efforts: null, models: false, access_levels: null, per_tool_allow: false,
    client: 'antigravity', adopt: 'session', host_existing: true,
    lockdown_hint: '权限由 App 决定，接入程序无法逐次收窄',
    capabilities: { delivery: IN_APP, rewind: 'kept', project: true, chat: true, capture: false, tool_lockdown: false },
  },
  api: {
    platform: '', label: '模型 API', kind: 'api', location: '', fields: ['base_url', 'api_protocol', 'api_key_ref', 'image_input'],
    // Pi passes the level as each protocol's own reasoning parameter; it clamps xhigh / max to high without a per-model map,
    // so only the three levels every protocol takes are offered. A chat endpoint without a reasoning parameter ignores it.
    efforts: ['low', 'medium', 'high'], models: false, access_levels: ['read', 'write'], per_tool_allow: false, adopt: '', host_existing: false,
    access_hints: { read: '用 Pi 自带的读取工具读项目；写入只放行草稿目录，命令只放行网站命令（由接入程序拦截）；可读取网页，本机保存了 DeepSeek API Key 时可联网搜索（由 DeepSeek 计费）',
      write: '用 Pi 自带的读写、编辑与命令行在项目里工作，和本地 CLI 可写一致；Pi 没有审批，可写即可直接运行命令；可读取网页，本机保存了 DeepSeek API Key 时可联网搜索（由 DeepSeek 计费）' },
    unsupported_hints: { auto: 'Pi 没有需要软件审批的操作，可写即可直接运行命令', full: 'Pi 没有需要软件审批的操作，可写即可直接运行命令' },
    // Runs as Pi itself (api_pi.mjs), like a CLI member (user 2026-11-25): Pi's own tools and skills, codiscuss in its
    // Git Bash with the credential in its environment, the last remark captured, a private chat a turn of its session.
    // Pi has no sandbox; read-only is enforced by our extension's tool_call check. Whether a model reads images depends on the model, not
    // the protocol: the owner says so on the card (`image_input`). Confined (lent to another computer's room), it keeps
    // only our room tools (api_lockdown).
    windows_command: 'codiscuss',
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, enforces_read_only: true, chat: true, images: 'configured', capture: FINAL_REMARK, tool_lockdown: true, system_prompt: 'launch' },
  },
};

/** Every configured `adapter` value this version supports. */
export const ADAPTER_IDS = Object.keys(ADAPTER_PROFILES);

/** The profile of one adapter with its defaults filled in, or null for a value this version does not support. */
export function adapter_profile(id) {
  const profile = ADAPTER_PROFILES[id];
  return profile ? { id, session_family: id, windows_command: 'codiscuss.cmd', ...profile } : null;
}

/** Whether two different adapters share one session store, so switching between them keeps the conversation. */
export function same_session_family(left, right) {
  const [a, b] = [adapter_profile(left), adapter_profile(right)];
  return Boolean(a && b && left !== right && a.session_family === b.session_family);
}

/**
 * The project access a member takes over from another, as when it becomes the host in its place: the highest level its
 * own software offers that does not exceed the other's, and never below what it has now. Levels rank in ALL_ACCESS
 * order, so software with fewer levels lands on the nearest one beneath (自动 becomes 可写 where 自动 is not offered)
 * without a table of software pairs. Access the runner does not set (an App, a taken-over session's `own`) is neither
 * given nor taken.
 * @param {{adapter: string, project_access: string}} member - the member taking over, with its present access.
 * @param {{adapter: string, project_access: string}} source - the member whose access is taken over.
 * @returns {string} the member's access afterwards; its present one when nothing changes.
 */
export function inherited_access(member, source) {
  const rank = level => ALL_ACCESS.indexOf(level);
  const offered = ADAPTER_PROFILES[member.adapter]?.access_levels;
  const limit = ADAPTER_PROFILES[source.adapter]?.access_levels ? rank(source.project_access) : -1;
  if (!offered || rank(member.project_access) < 0 || limit < 0) return member.project_access;
  const reachable = offered.filter(level => rank(level) <= limit && rank(level) > rank(member.project_access));
  return reachable.sort((left, right) => rank(right) - rank(left))[0] || member.project_access;
}

/** The adapters serving one platform, in table order; a model API serves every platform. */
export function platform_adapters(platform) {
  return ADAPTER_IDS.filter(id => ADAPTER_PROFILES[id].platform === platform || ADAPTER_PROFILES[id].platform === '');
}

/**
 * Whether a member's usual delivery takes images with its prompt: its software always does, or its model does by the
 * owner's own setting (`image_input: 'image'`), never guessed from a model name.
 */
export function takes_images(profile) {
  const images = ADAPTER_PROFILES[profile?.adapter]?.capabilities.images;
  return images === true || (images === 'configured' && profile.image_input === 'image');
}

/**
 * Whether a task confined to the codiscuss subcommands (`tool_lockdown`) can run on a member: `{supported, reason}`.
 * A taken-over manual member keeps its own session's permissions and window, so it cannot be confined either.
 */
export function lockdown_support(id, config = {}) {
  const profile = ADAPTER_PROFILES[id];
  if (!profile) return { supported: false, reason: '不支持的软件适配器' };
  if (!profile.capabilities.tool_lockdown) return { supported: false, reason: profile.lockdown_hint || '' };
  if (config.project_access === 'own') return { supported: false, reason: '托管的已有会话沿用它自己的权限，无法收窄' };
  return { supported: true, reason: '' };
}

/** What an adapter can do; an unknown adapter can do nothing. */
export function adapter_capabilities(id) {
  const profile = ADAPTER_PROFILES[id];
  if (!profile) return { delivery: IN_APP, rewind: 'kept', project: false, capture: false };
  return profile.sandbox_needs_desktop && no_desktop()
    ? { ...profile.capabilities, no_sandbox: true, enforces_read_only: false, limits_directories: false } : profile.capabilities;
}

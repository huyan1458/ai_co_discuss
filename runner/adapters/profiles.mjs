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
 * - `efforts`: thinking levels it accepts, or null when chosen inside the App; `efforts_per_model`: the levels are read
 *   from the software for the chosen model. `models`: whether its CLI lists models.
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
 * - `defaults_by_query`: its default model is read by running it (seconds), so a quick read leaves it for later.
 * - `capabilities`: `delivery` `{stoppable, progress}` of a usual delivery (each delivery reports its own); `rewind`: `cut`
 *   (the runner cuts the session), `fresh` (context rebuilt each time) or `kept` (cannot be cut here); `project` (works in
 *   a project directory); `access_env` (its process takes the credential file by environment); `enforces_read_only`
 *   (its sandbox enforces a read-only project); `ripgrep` (bundles rg for reading on Windows); `file_tools` (works on
 *   the project only through the runner's file tools, running no commands); `limits_directories` (a directory it may
 *   only read stays read-only even while it may write elsewhere and run commands: a sandbox or file tools, not rules
 *   that a command could bypass); `chat` (the owner's private chat runs as a turn of its own session and its reply is
 *   read from the software's output); `resume` (a stopped turn can go on in the same session, so the owner may pause
 *   a room execution from the private chat without ending it; not yet measured on real software).
 * - `session_family`: profiles sharing one session store; switching among them keeps the conversation.
 * - `windows_command`: how its shell names the codiscuss CLI on Windows.
 * - `task_rules(cli, {runs_commands})`: fixed task text this software needs, added by the runner so no member prompt drops it.
 */
const ALL_ACCESS = ['read', 'write', 'auto', 'full'];
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

export const ADAPTER_PROFILES = {
  codex_cli: {
    platform: 'Codex', label: 'Codex CLI', kind: 'cli', location: 'executable', fields: ['project_id', 'project_name'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], models: true, access_levels: ALL_ACCESS, per_tool_allow: false,
    access_hints: { read: '只读沙箱', write: '项目可写的沙箱，命令在沙箱内运行、可联网',
      auto: '沙箱外的操作由模型申请提权，Codex 自动审核代替人工批准', full: '无沙箱、无审批（--dangerously-bypass-approvals-and-sandbox）' },
    client: 'codex', adopt: 'session', host_existing: true, session_family: 'codex',
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, enforces_read_only: true, limits_directories: true, ripgrep: true, chat: true, resume: true },
  },
  codex: {
    platform: 'Codex', label: 'Codex App', kind: 'app', location: 'executable', fields: ['source_thread_id', 'project_id', 'project_name'],
    efforts: null, models: false, access_levels: null, per_tool_allow: false,
    client: 'codex', adopt: 'session', host_existing: true, session_family: 'codex',
    capabilities: { delivery: IN_APP, rewind: 'cut', project: true, chat: true },
  },
  claude: {
    platform: 'Claude', label: 'Claude Code', kind: 'cli', location: 'executable', fields: ['allowed_tools'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], models: true, access_levels: ALL_ACCESS, per_tool_allow: true,
    access_hints: { read: '只放行网站命令与草稿，不改项目文件、不跑其他命令', write: '可改项目文件，Bash / PowerShell 命令全部放行（无沙箱）',
      auto: 'Claude auto 模式：由分类器判断，实测项目外写入和联网都会放行', full: 'bypassPermissions：跳过全部权限检查' },
    client: 'claude', adopt: 'own_cwd', host_existing: true, restore_manual: true,
    resume_command: session_id => `claude --resume ${session_id}`,
    // Claude Code runs commands through bash on Windows too, where the npm shim works without .cmd.
    windows_command: 'codiscuss',
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, chat: true, resume: true },
  },
  antigravity_cli: {
    platform: 'Antigravity', label: 'Antigravity CLI', kind: 'cli', location: 'executable', fields: ['project_id', 'project_name'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], efforts_per_model: true, models: true, defaults_by_query: true,
    // Headless agy refuses `--mode auto` ("not available for this account", 1.4.10–1.4.11), so 自动 is not offered.
    access_levels: ['read', 'write', 'full'], per_tool_allow: true,
    access_hints: { read: '只放行网站命令；碰到未放行的命令会直接结束本轮', write: '可写项目，命令全部放行（在 agy 沙箱内）',
      full: '跳过全部权限确认（--dangerously-skip-permissions），并放开沙箱外命令与 MCP 工具' },
    unsupported_hints: { auto: 'agy 只在交互窗口提供自动模式，后台运行（-p）不支持' },
    // Only a conversation this tool created gets its session rules; an existing one keeps its own project and permissions.
    client: 'antigravity', adopt: 'session', host_existing: false, own_project_when_bound: true,
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, access_env: true, chat: true },
    // A read-only agy session allows only codiscuss commands and headless agy ends the turn on a denied one; agy streams no
    // thinking text, so without a word at each turning point the page cannot show how far it got.
    task_rules: (cli, { runs_commands }) => (runs_commands ? ''
      : `无人值守下 run_command 只能运行 ${cli} 的 subcommands 子命令，其他命令会被自动拒绝并使会话直接结束；列目录、搜索或读取文件用 list_dir、find_by_name、grep_search、view_file。`)
      + '多步任务中，在关键转折处用一句话写出进展再继续：agy 不输出思考过程，网页只能靠这些话显示你做到哪一步。',
  },
  antigravity: {
    platform: 'Antigravity', label: 'Antigravity App', kind: 'app', location: 'ipc_directory', fields: ['project_id', 'project_name'],
    efforts: null, models: false, access_levels: null, per_tool_allow: false,
    client: 'antigravity', adopt: 'session', host_existing: true,
    capabilities: { delivery: IN_APP, rewind: 'kept', project: true, chat: true },
  },
  api: {
    platform: '', label: '模型 API', kind: 'api', location: '', fields: ['base_url', 'api_protocol', 'api_key_ref'],
    efforts: null, models: false, access_levels: ['read', 'write'], per_tool_allow: false, adopt: '', host_existing: false,
    access_hints: { read: '用接入程序的文件工具读取、搜索项目文件，可运行工作流登记的只读命令',
      write: '还可新建、覆盖、局部编辑项目文件，可运行工作流登记的全部命令；没有通用命令行' },
    unsupported_hints: { auto: 'API 成员没有通用命令行，没有需要软件审批的操作', full: 'API 成员没有通用命令行，没有需要软件审批的操作' },
    // Runs in the Pi harness (api_pi.mjs), which keeps a session the runner cuts like a CLI's.
    capabilities: { delivery: PROCESS, rewind: 'cut', project: true, file_tools: true, limits_directories: true, chat: true },
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

/** The adapters serving one platform, in table order; a model API serves every platform. */
export function platform_adapters(platform) {
  return ADAPTER_IDS.filter(id => ADAPTER_PROFILES[id].platform === platform || ADAPTER_PROFILES[id].platform === '');
}

/** What an adapter can do; an unknown adapter can do nothing. */
export function adapter_capabilities(id) {
  return ADAPTER_PROFILES[id]?.capabilities || { delivery: IN_APP, rewind: 'kept', project: false };
}

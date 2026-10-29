/**
 * Prompts for one expert, beside the shared skills: a skill holds rules for everyone, this holds what one
 * software or one member needs. Presets exist only where a software needs one; a member's own
 * system_prompt, even an empty one, replaces its preset. They add guidance and never widen permissions.
 */

export const MAX_EXPERT_PROMPT = 4000;

// A software's must-know rules are fixed by the runner (agy below, API in its system prompt), so no preset is needed now.
export const EXPERT_PROMPT_PRESETS = {};

/**
 * Expert presets: a named instance with its description, prompt, project access and optionally model and effort,
 * added in one click. The user's own presets live on this computer (`expert-presets.json` in the service home);
 * one with a built-in's name replaces it.
 */
export const BUILTIN_EXPERT_PRESETS = [
  { name: 'Codex-评审', builtin: true, project_access: 'read',
    description: '专门做代码评审：对照计划文档检查改动，只提问题不改代码。',
    system_prompt: '你是本房间的评审。先读主持人给出的计划文档与改动范围（执行报告列有改动文件，可用 git diff 查看），检查：是否符合计划与约定的接口、有无正确性问题、有无越出分工的改动、测试是否覆盖关键行为。按严重程度列出问题，每条附文件与行号和理由；没有问题就明确说通过。只评审，不修改文件。' },
  { name: 'Gemini-文档', builtin: true, project_access: 'write',
    description: '专门整理文档：按改动同步说明，只改文档不改代码。',
    system_prompt: '你负责整理文档。先读计划文档与本次改动，按仓库现有文档的分工同步说明，只改文档文件，不改代码；不确定的事实标为待核实，不自行补写。' },
];

/** The prompt this member receives: its own text when set, otherwise its software's preset. */
export function expert_prompt(profile = {}) {
  const own = Object.hasOwn(profile, 'system_prompt');
  return String((own ? profile.system_prompt : EXPERT_PROMPT_PRESETS[profile.adapter]) || '').trim();
}

/** The line that introduces the member's own prompt after the fixed task text; the prompt dialog shows the same line. */
export const EXPERT_PROMPT_HEADING = '用户为你单独设置的提示（补充做法与偏好，不改变权限与技能规则）：';

/** Append the member's prompt to a task prompt, marked as the user's own guidance for this member. */
export function with_expert_prompt(prompt, profile) {
  const extra = expert_prompt(profile);
  return extra ? `${prompt}\n\n${EXPERT_PROMPT_HEADING}\n${extra}` : prompt;
}

/*
 * The fixed task text the runner adds for a member woken on this computer. It lives here, free of Node modules, so the
 * expert prompt dialog shows the same text the runner sends, with placeholders for the values known only at delivery.
 */

/**
 * Project access of a member woken on this computer: 只读, 可写 (project files and any command), 自动 (the software's own
 * automatic approval) and 完全放开 (no approval or sandbox). A manual member the service took over is `own`.
 */
export const PROJECT_ACCESS = ['read', 'write', 'auto', 'full'];

const ACCESS_LABELS = { read: '只读', write: '可写', auto: '自动', full: '完全放开' };

/** What each level does in each software, measured headless (Claude Code 2.1.312, Codex CLI 0.163, agy 1.4.10). */
const ACCESS_HINTS = {
  claude: { read: '只放行网站命令与草稿，不改项目文件、不跑其他命令', write: '可改项目文件，Bash / PowerShell 命令全部放行（无沙箱）',
    auto: 'Claude auto 模式：由分类器判断，实测项目外写入和联网都会放行', full: 'bypassPermissions：跳过全部权限检查' },
  codex_cli: { read: '只读沙箱', write: '项目可写的沙箱，命令在沙箱内运行、可联网',
    auto: '沙箱外的操作由模型申请提权，Codex 自动审核代替人工批准', full: '无沙箱、无审批（--dangerously-bypass-approvals-and-sandbox）' },
  antigravity_cli: { read: '只放行网站命令；碰到未放行的命令会直接结束本轮', write: '可写项目，命令全部放行（在 agy 沙箱内）',
    full: '再放开沙箱外命令与 MCP 工具' },
};

/** agy has no automatic mode headless ("not available for this account", tested 1.4.10), so it offers no 自动. */
export function access_levels(adapter) {
  return adapter === 'antigravity_cli' ? PROJECT_ACCESS.filter(level => level !== 'auto') : PROJECT_ACCESS;
}

/** The levels a software supports, labelled for the page, with what each does there on hover. */
export function access_options(adapter) {
  return access_levels(adapter).map(value => ({ value, label: ACCESS_LABELS[value], hint: ACCESS_HINTS[adapter]?.[value] || '' }));
}

/** The page's name for a level; `own` reads as decided by the member's own session. */
export function access_label(level) { return level === 'own' ? '自行决定' : ACCESS_LABELS[level] || '只读'; }

/**
 * Whether a member may run commands beyond the codiscuss subcommands: every level but 只读, and 可写 only with a project.
 * A taken-over manual member (`own`) keeps its own session's permissions, so the room's limits do not apply.
 */
export function runs_commands(config) {
  const access = config.project_access;
  return ['own', 'auto', 'full'].includes(access) || (access === 'write' && Boolean(config.cwd || config.workdir));
}

/** The task text's rule for project files and commands; `purpose` says what the member works for (按请求 / 按议题需要). */
export function project_rule(profile, purpose) {
  if (profile.project_access === 'own') return '项目文件与命令权限沿用你自己会话的软件设置。';
  if (profile.project_access === 'auto') return `由软件自动审批：可${purpose}修改项目文件并运行所需命令；被沙箱或审批拦下时按软件方式申请放行（Codex 申请提权），仍被拒绝就在回答中说明。`;
  if (profile.project_access === 'full') return `已跳过软件审批与沙箱，可${purpose}修改文件并运行所需命令。`;
  if (!profile.cwd) return '未指定项目目录。';
  return profile.project_access === 'write' ? `用户允许${purpose}修改 cwd 中的项目文件并运行所需命令。` : 'cwd 中的项目文件只读，不修改。';
}

/** A read-only agy project allows only codiscuss commands and headless agy ends the turn on a denied one, so every such agy task states it; no member prompt can drop it. */
export function agy_command_rule(adapter, cli, config = {}) {
  return adapter === 'antigravity_cli' && !runs_commands(config) ? `无人值守下 run_command 只能运行 ${cli} 的 subcommands 子命令，其他命令会被自动拒绝并使会话直接结束；列目录、搜索或读取文件用 list_dir、find_by_name、grep_search、view_file。` : '';
}

/** agy streams no thinking text, so without a word at each turning point the page cannot show how far it got; fixed, so no member prompt drops it. */
export function agy_progress_rule(adapter) {
  return adapter === 'antigravity_cli' ? '多步任务中，在关键转折处用一句话写出进展再继续：agy 不输出思考过程，网页只能靠这些话显示你做到哪一步。' : '';
}

/** Windows PowerShell mis-decodes UTF-8 files; the runner adds this where the member's commands can run rg. */
export const READ_RULE = '读含中文的文件用 rg --encoding utf-8 . 文件路径，不用 Get-Content（Windows PowerShell 会读成乱码）。';

/**
 * A free-room task's fixed text: `instructions` saved in the task file and `prompt` sent with each wake-up, followed by
 * the member's own prompt. `discussion` is a direct question asked while a discussion runs in the room.
 * Loaded in steps: the prompt says who was named, how to answer a simple message without loading the skills, and
 * otherwise where the task file is, plus how to read files at all; the task file's fields carry this execution's values
 * (messages, read point, execution, role, credentials), the skills it lists say how to use them, and `instructions`
 * holds only the limits no skill can know. `access_file` is set where the credential is not bound to the process.
 */
export function free_task_text({ name, discussion, profile, cli, room, messages, read_after, execution_id, task_path, draft_directory, access_file = '', read_rule = '' }) {
  const scope = discussion ? `讨论进行中，用户直接向你提问（${messages}）：这不是你的发言安排，不领取发言权、不安排他人、不改变讨论进度，只回答这个提问。` : '';
  const commands = runs_commands(profile) ? '' : `命令只用 subcommands 列出的 ${cli} 子命令。`;
  const instructions = `${agy_command_rule(profile.adapter, cli, profile)}${agy_progress_rule(profile.adapter)}${scope}${project_rule(profile, '按请求')}${commands}草稿写在 draft_directory。`;
  // A greeting deserves a quick answer, and reading the skills first costs it one or two model rounds.
  const access = access_file ? ` --access-file ${access_file}` : '';
  const quick = `只是问候、确认、致谢这类不用查资料也不改文件的简单消息时，不必读技能：用 ${cli} message list ${room} --after ${read_after}${access} 看原文，再用一条命令把回答写进 ${draft_directory} 下的新文件并执行 ${cli} message post ${room} --as ${name} --kind chat --execution ${execution_id} --body-file 该文件 --submission-id 新UUID${access}。`;
  const prompt = `用户在${discussion ? '讨论' : '自由协作'}房间点名了你（${name}），对应消息 ${messages}。${quick}其他情况先读任务文件 ${task_path}，按其中列出的技能处理并提交一次回答。${read_rule}`;
  return { instructions, prompt };
}

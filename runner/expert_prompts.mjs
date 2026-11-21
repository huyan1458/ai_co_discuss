/**
 * Prompts for one expert, beside the shared skills: a skill holds rules for everyone, this holds what one
 * software or one member needs. Presets exist only where a software needs one; a member's own
 * system_prompt, even an empty one, replaces its preset. They add guidance and never widen permissions.
 */
// Plain data with no imports of its own, so this module stays loadable by the web page.
import { adapter_profile } from './adapters/profiles.mjs';

export const MAX_EXPERT_PROMPT = 4000;

// A software's must-know rules are fixed by the runner (its adapter profile's task_rules, API in its system prompt), so no preset is needed now.
export const EXPERT_PROMPT_PRESETS = {};

/**
 * Expert presets: a named instance with its description, prompt, project access and optionally model and effort,
 * added in one click. The user's own presets live on this computer (`expert-presets.json` in the service home);
 * one with a built-in's name replaces it.
 */
export const BUILTIN_EXPERT_PRESETS = [
  { name: 'Codex-review', label: 'Codex-评审', builtin: true, project_access: 'read',
    description: '专门做代码评审：对照计划文档检查改动，只提问题不改代码。',
    system_prompt: '你是本房间的评审。先读主持人给出的计划文档与改动范围（执行报告列有改动文件，可用 git diff 查看），检查：是否符合计划与约定的接口、有无正确性问题、有无越出分工的改动、测试是否覆盖关键行为。按严重程度列出问题，每条附文件与行号和理由；没有问题就明确说通过。只评审，不修改文件。' },
  { name: 'Antigravity-docs', label: 'Gemini-文档', builtin: true, project_access: 'write',
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
 * automatic approval) and 全放开 (no approval or sandbox). A manual member the service took over is `own`.
 */
export const PROJECT_ACCESS = ['read', 'write', 'auto', 'full'];

const ACCESS_LABELS = { read: '只读', write: '可写', auto: '自动', full: '全放开' };

/** The levels a software can enforce headless, from its adapter profile; an App or API member is offered all of them. */
export function access_levels(adapter) {
  return adapter_profile(adapter)?.access_levels || PROJECT_ACCESS;
}

/**
 * All four levels labelled for the page, with what each does in this software on hover; ones it lacks are shown but
 * disabled, so every CLI card lines up the same four levels. `full_only_hint`, given where this computer can run the
 * software only without its sandbox, disables every level but 全放开 and says why.
 */
export function access_options(adapter, full_only_hint = '') {
  const levels = access_levels(adapter), profile = adapter_profile(adapter);
  return PROJECT_ACCESS.map(value => {
    if (!levels.includes(value)) return { value, label: ACCESS_LABELS[value], hint: profile?.unsupported_hints?.[value] || '该软件不支持此档位', disabled: true };
    if (full_only_hint && value !== 'full') return { value, label: ACCESS_LABELS[value], hint: full_only_hint, disabled: true };
    return { value, label: ACCESS_LABELS[value], hint: profile?.access_hints?.[value] || '' };
  });
}

/** The page's name for a level; `own` reads as decided by the member's own session. */
export function access_label(level) { return level === 'own' ? '自行决定' : ACCESS_LABELS[level] || '只读'; }

/**
 * Subcommands an automatic task may run; service, run, api, setup and the rest of launch stay unapproved.
 * `launch workflow-adopt`, `launch workflow-join`, `launch workflow-leave` and `launch host-control` check themselves that the caller is the room's host (adopt and host-control also need the owner's grant).
 */
export const TASK_SUBCOMMANDS = ['room', 'message', 'turn', 'state', 'goal', 'mode', 'review', 'sequence', 'question', 'execution', 'health', 'schema', 'launch workflow-adopt', 'launch workflow-join', 'launch workflow-leave', 'launch host-control', 'attachment', 'launch image', 'repo'];

/**
 * The limit on a quick answer given inline with --body: a run allowed only codiscuss commands refuses a command line
 * carrying shell symbols, and PowerShell rewrites `$` and backticks inside quotes. The participant skill says the same.
 */
export const INLINE_BODY_RULE = '--body 只用于不超过 200 字的短答，不能含反引号、英文括号、$、;、&、|、<、> 或换行，否则写草稿再用 --body-file';
// How many times one execution is resumed to correct commands it can fix itself (2026-11-19 user: three).
export const MAX_REFUSAL_RETRIES = 3;
const REFUSED_COMMAND_SHOWN = 200;

/**
 * Which refusals a member can correct itself: the adapter's denials carrying a `retry_hint`, as `{command, hint}`.
 */
export const correctable_refusals = denials => (denials || []).filter(item => item.retry_hint)
  .map(item => ({ command: String(item.detail || '').slice(0, REFUSED_COMMAND_SHOWN), hint: item.retry_hint }));

/**
 * What a member hears when the program resumes its session after refused commands: every refusal so far in this
 * execution, oldest first, each with what to change, and how many corrections are left.
 */
export function refusal_retry_prompt(execution_id, refusals, attempt = 1) {
  const listed = refusals.map((item, index) => `${index + 1}. 命令「${item.command}」被拒：${item.hint}`).join('\n');
  const left = MAX_REFUSAL_RETRIES - attempt;
  return `你在这次房间任务（执行 #${execution_id}，仍在进行）里的命令被本机安全规则拒绝，回答还没有提交（第 ${attempt} 次提醒，`
    + `${left ? `之后还有 ${left} 次改正机会` : '这是最后一次改正机会'}）：\n\n${listed}\n\n`
    + '按上面改正后接着完成，已经做完的部分不必重做，最后提交这次执行的回答。';
}

/**
 * The task text for a member woken on this computer for a room on another computer (an external member): the project
 * lives over there and is read only through `repo`; a locked-down run (`lockdown`) may run only codiscuss subcommands and
 * write only in `draft_directory`. `access_file` is the run's external access file. `directories` are what the other
 * side opens now (`[{root, name}]`), empty when it opens no project (only discussion).
 */
export function external_task_text({ name, messages, requests = [], cli, access_file, task_path, lockdown, draft_directory, directories = [] }) {
  const access = ` --access-file ${access_file}`;
  const opened = directories.map(item => `${item.root} ${item.name}`).join('、');
  const reading = directories.length
    ? `项目在对方电脑上，本机没有它的文件；对方开放的目录（序号 名称）：${opened}。用 ${cli} repo ls 目录 --root 序号${access}、${cli} repo read 文件 --root 序号${access}、${cli} repo grep 关键词 --root 序号${access} 只读查看；读不到的（范围外、敏感文件、配额用尽）如实说明，不猜测内容。`
    : '对方这次只请你参与讨论，没有开放项目文件，不要用 repo 读取；需要看代码时在回答里说明。';
  const limits = lockdown ? `本次只能运行 ${cli} 子命令，只能在 ${draft_directory} 写草稿，不能读写其他本机文件或联网。` : '';
  const instructions = `你作为外部成员参加另一台电脑上的房间，只读对方开放的项目，不修改任何文件。命令只用 subcommands 列出的 ${cli} 子命令。${limits}${reading}`;
  const prompt = `${wake_opening(requests, name)}（来自另一台电脑上的房间），对应消息 ${messages}。${instructions}`
    + `用 ${cli} message view 消息编号${access} 看原文，${cli} room view${access} 看房间概况。`
    + `做完用 ${cli} message post --body-file 草稿${access} 提交一次回答（简短回答可用 --body "回答"；${INLINE_BODY_RULE}）。房间按 Markdown 显示回答，内容较多时用分段、标题或列表排版。先读任务文件 ${task_path} 与其中列出的技能。`;
  return { instructions, prompt };
}

/**
 * Whether a member may run commands beyond the codiscuss subcommands: every level but 只读, and 可写 only with a project
 * (its own, or one of the room's directories it may write, `extra_directories`). A taken-over manual member (`own`)
 * keeps its own session's permissions, so the room's limits do not apply.
 */
export function runs_commands(config, extra_directories = []) {
  const access = config.project_access;
  return ['own', 'auto', 'full'].includes(access) || (access === 'write'
    && Boolean(config.cwd || config.workdir || extra_directories.some(item => item.access === 'write')));
}

/**
 * The task text's rule for project files and commands; `purpose` says what the member works for (按请求 / 按议题需要).
 * A member without its own project may still have the room's directories in `extra_directories`.
 */
export function project_rule(profile, purpose, extra_directories = []) {
  if (profile.project_access === 'own') return '项目文件与命令权限沿用你自己会话的软件设置。';
  if (profile.project_access === 'auto') return `由软件自动审批：可${purpose}修改项目文件并运行所需命令；被沙箱或审批拦下时按软件方式申请放行（Codex 申请提权），仍被拒绝就在回答中说明。`;
  if (profile.project_access === 'full') return `已跳过软件审批与沙箱，可${purpose}修改文件并运行所需命令。`;
  if (!profile.cwd && extra_directories.length) return runs_commands(profile, extra_directories)
    ? `用户允许${purpose}修改项目文件并运行所需命令。` : '项目文件只读，不修改。';
  if (!profile.cwd) return '未指定项目目录。';
  return profile.project_access === 'write' ? `用户允许${purpose}修改 cwd 中的项目文件并运行所需命令。` : 'cwd 中的项目文件只读，不修改。';
}

/** The fixed rules one software needs in every task, from its adapter profile; no member prompt can drop them. */
export function software_rules(config, cli, extra_directories = []) {
  return adapter_profile(config.adapter)?.task_rules?.(cli, { runs_commands: runs_commands(config, extra_directories) }) || '';
}

/** Windows PowerShell mis-decodes UTF-8 files; the runner adds this where the member's commands can run rg. */
export const READ_RULE = '读含中文的文件用 rg --encoding utf-8 . 文件路径，不用 Get-Content（Windows PowerShell 会读成乱码）。';

/**
 * A free-room task's fixed text: `instructions` saved in the task file and `prompt` sent with each wake-up, followed by
 * the member's own prompt. `discussion` is a direct question asked while a discussion runs in the room;
 * `discussion_request` is the session request for a scheduled speaker or the host.
 * Loaded in steps: the prompt says who was named, how to answer a simple message without loading the skills, and
 * otherwise where the task file is, plus how to read files at all; the task file's fields carry this execution's values
 * (messages, read point, execution, role, credentials), the skills it lists say how to use them, and `instructions`
 * holds only the limits no skill can know. `access_file` is set where the credential is not bound to the process.
 * `extra_directories` are the room's other project directories this member works with, each read-only or writable.
 */
export function free_task_text({ name, discussion, discussion_request, profile, cli, messages, read_after, task_path, access_file = '', read_rule = '',
  extra_directories = [], attachments = [], requests = [], workflow = false }) {
  const files = attachments_text(attachments, cli);
  const scope = discussion ? `讨论进行中，用户直接向你提问（${messages}）：只回答这个提问，不改变讨论安排和进度。` : '';
  const commands = runs_commands(profile, extra_directories) ? '' : `命令只用 subcommands 列出的 ${cli} 子命令。`;
  const extras = extra_directories.length ? 'extra_directories 是本房间的其他项目目录，access 为 read 的只读、不修改。' : '';
  const instructions = `${software_rules(profile, cli, extra_directories)}${scope}${project_rule(profile, '按请求', extra_directories)}${extras}${commands}草稿写在 draft_directory。`;
  if (discussion_request) {
    const role = discussion_request.purpose === 'discuss_host' ? '主持任务' : '发言请求';
    const prompt = `你（${name}）收到了讨论中的${role}。先读任务文件 ${task_path}，按其中列出的技能处理本次请求并保存结果。${read_rule}${files}`;
    return { instructions, prompt };
  }
  // A greeting deserves a quick answer, and reading the skills first costs it one or two model rounds.
  const access = access_file ? ` --access-file ${access_file}` : '';
  // The credential already names the room, the member and this execution, so the commands carry only what changes.
  // The message numbers are already known, so the original is one `message view` away instead of a list (#3129).
  // A one-line answer goes inline: a draft file guards long or symbol-laden text and retries, which a greeting does not need.
  const quick = `问候、致谢等简单消息可跳过技能：${cli} message view 上面的消息编号${access} 看原文，${cli} message post --body "回答"${access} 回复（${INLINE_BODY_RULE}）。`;
  const opening = `${wake_opening(requests, name, discussion)}，对应消息 ${messages}。`;
  // Choosing a sub-workflow was left to the host's memory and got skipped, so every host task now asks for it (#4487).
  const route = workflow ? '本房间启用了工作流：派活或改文件之前，先读 workflow.skill_path，把这次请求对照主线和 workflow.sub_workflows 每一项的 description；命中就读它的 SKILL.md 并照做，不问要不要用，回答开头用一句话写明走的哪条；都不命中就按普通请求处理，回答里不必说明。' : '';
  // A message with files is never a mere greeting: the quick path would skip them (2026-11-14, #3143); nor is a
  // hand-back, notice, Goal or host assignment, so the shortcut only goes with a user's own message (#3145 四.5).
  const prompt = files || !from_user(requests)
    ? `${opening}先读任务文件 ${task_path}，按其中列出的技能处理并提交一次回答。${route}${read_rule}${files}`
    : `${opening}${quick}其他请求先读任务文件 ${task_path}，按其中列出的技能处理并提交一次回答。${route}${read_rule}`;
  return { instructions, prompt };
}

/**
 * What woke the member, one phrase per request source (purpose and who created it), so a hand-back or a notice is not
 * announced as the user naming the member. `requests` are this execution's requests; none (the prompt preview) reads
 * as a user's message. Requests from several sources are listed together.
 */
const WAKE_SOURCES = {
  route: name => `用户在房间发了未点名的消息，交给主持人（${name}）处理`,
  notice: name => `系统给主持人（${name}）发来一条通知`,
  handoff: name => `你（${name}）派出的工作已交回，等你处理`,
  keep_working: name => `你（${name}）此前派活后选择继续工作，现在接着完成`,
  goal_start: name => `用户开启了 Goal，交给主持人（${name}）`,
  goal_continue: name => `Goal 续跑：主持人（${name}）继续推进当前目标`,
  discuss_start: name => `用户请求开启讨论，交给主持人（${name}）`,
  host_ask: name => `主持人给你（${name}）安排了一项请求`,
  detach: name => `主持人派你（${name}）在后台独立完成一项工作：不等你交回，做完照常提交，失败时程序会告诉主持人`,
  system_ask: name => `系统给你（${name}）安排了一项请求`,
};

function request_source(request) {
  const purpose = request.purpose || 'ask';
  if (WAKE_SOURCES[purpose]) return purpose;
  // A member sent along with `--detach` has no batch to hand back to: it works on its own in the background.
  if (request.created_by === 'host') return request.batch_id === 0 ? 'detach' : 'host_ask';
  if (request.created_by === 'system') return 'system_ask';
  return 'user';
}

/** Whether every request comes from the user's own message, the only case a greeting shortcut fits. */
function from_user(requests) {
  return requests.every(item => request_source(item) === 'user');
}

export function wake_opening(requests = [], name = '', discussion = false) {
  const user = `用户在${discussion ? '讨论中的' : ''}房间点名了你（${name}）`;
  const sources = [...new Set((requests.length ? requests : [{}]).map(request_source))];
  const phrases = sources.map(source => source === 'user' ? user : WAKE_SOURCES[source](name));
  return phrases.length === 1 ? phrases[0] : `你（${name}）有 ${requests.length} 项请求：${phrases.join('；')}`;
}

/**
 * The files of the messages that woke this task, one line each as `[图片 #n]` in the message text names them, with the
 * local copy the runner saved; a file it could not fetch points to `attachment download`. Empty when there are none.
 */
export function attachments_text(attachments, cli) {
  if (!attachments.length) return '';
  const lines = attachments.map(item => `#${item.message_id} ${item.placeholder} ${item.file_name}：${item.path
    ? `本机副本 ${item.path}` : `未能取到本机副本（${item.error || '未知原因'}），用 ${cli} attachment download 下载`}`);
  return `\n\n消息附件（消息正文里的 [图片 #n] / [文件 #n] 指对应附件；已能直接看到的图片不必再打开，其余用你的工具读取本机副本，读不了时如实说明）：\n${lines.join('\n')}`;
}

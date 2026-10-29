/**
 * Prompts for one expert, beside the shared skills: a skill holds rules for everyone, this holds what one
 * software or one member needs. Presets exist only where a software needs one; a member's own
 * system_prompt, even an empty one, replaces its preset. They add guidance and never widen permissions.
 */

export const MAX_EXPERT_PROMPT = 4000;

export const EXPERT_PROMPT_PRESETS = {
  // agy streams no thinking text, so without a word between tools the page cannot show how far it got.
  antigravity_cli: '多步任务中，在关键转折处用一句话写出进展再继续。',
  // An API expert sees only the room, so what it knows of local files comes from other members and it must ask for the rest.
  api: '你读不到本地文件，相关内容以其他成员贴出的为准，不凭文件名猜测。缺信息时在回答里写明缺什么。',
};

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
    system_prompt: '你负责整理文档。先读计划文档与本次改动，按仓库现有文档的分工同步说明，只改文档文件，不改代码；不确定的事实标为待核实，不自行补写。多步任务中，在关键转折处用一句话写出进展再继续。' },
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
 * 可写 means the member may both change its project files and run any command; 只读 keeps only the codiscuss subcommands.
 * A manual member the service took over (`own`) keeps its own session's permissions, so neither limit applies.
 */
export function runs_commands(config) {
  return config.project_access === 'own' || (config.project_access === 'write' && Boolean(config.cwd || config.workdir));
}

/** A read-only agy project allows only codiscuss commands and headless agy ends the turn on a denied one, so every such agy task states it; no member prompt can drop it. */
export function agy_command_rule(adapter, cli, config = {}) {
  return adapter === 'antigravity_cli' && !runs_commands(config) ? `无人值守下 run_command 只能运行 ${cli} 的 subcommands 子命令，其他命令会被自动拒绝并使会话直接结束；列目录、搜索或读取文件用 list_dir、find_by_name、grep_search、view_file。` : '';
}

/** Windows PowerShell mis-decodes UTF-8 files; the runner adds this where the member's commands can run rg. */
export const READ_RULE = '读取含中文的技能或文本文件时用 rg --encoding utf-8 . 文件路径，不用 Get-Content（Windows PowerShell 会按系统编码读出乱码，需要反复重试）。';

/**
 * A free-room task's fixed text: `instructions` saved in the task file and `prompt` sent with each wake-up, followed by
 * the member's own prompt. `discussion` is a direct question asked while a discussion runs in the room.
 */
export function free_task_text({ name, role, discussion, profile, cli, room, messages, read_after, execution_id, task_path, read_rule = '', inbox = false }) {
  // A task posted into a member's own open window has no process environment of ours, so it names the credential file.
  const bound_access = !inbox && ['claude', 'codex_cli', 'antigravity_cli'].includes(profile.adapter);
  const access_arg = bound_access ? '' : ' --access-file 凭据路径';
  const access_rule = bound_access ? '本次凭据文件已通过进程环境 DISCUSS_ACCESS_FILE 绑定，codiscuss 自动读取，命令无需 --access-file。' : '';
  const project_rule = profile.project_access === 'own' ? '项目文件与命令权限沿用你自己会话的软件设置。'
    : !profile.cwd ? '未指定项目目录。'
    : profile.project_access === 'write' ? '用户允许按请求修改 cwd 中的项目文件并运行所需命令。' : 'cwd 中的项目文件只读，不修改。';
  // The host routes unnamed messages and receives hand-backs; it may name members in its answer.
  const host_rule = role === 'host' && !discussion
    ? `你是本房间的主持人：按任务 skills 中 discuss-host 的自由协作主持说明处理 route、handoff 与 all 请求。先用 ${cli} room view ${room} 查看成员与状态；派活在回答中加 --to 成员名（不能点名自己），只点名一位且还要它交回时加 --handoff。`
    : '';
  const instructions = `${agy_command_rule(profile.adapter, cli, profile)}${discussion ? '讨论房间：用户直接向你提问（' + messages + '）。这不是你的发言安排，不要领取发言权、不要安排他人，也不改变讨论进度，只回答这个提问。' : '自由协作房间：用户点名了你（' + messages + '）。'}${access_rule}先用 ${cli} message list ${room} --after ${read_after}${access_arg} 读取新消息，按时间顺序处理，后面的消息可能修正前面的，以最新指令为准。${host_rule}完成后用 ${cli} message post ${room} --as ${name} --kind chat --execution ${execution_id} --body-file 草稿 --submission-id 新UUID${access_arg} 提交一次回答。提交被拒绝说明本次执行已被打断或过期：保留草稿并结束，不要去掉 --execution 改作普通发言。草稿只写入 draft_directory；${project_rule}不读取或打印凭据内容，不建定时任务。`;
  const prompt = `用户在${discussion ? '讨论' : '自由协作'}房间点名了你（${name}），对应消息 ${messages}。请先读取任务文件：${task_path}，按其中说明读取新消息、完成请求，并用 ${cli} message post 带 --execution ${execution_id} 提交一次回答后结束。${runs_commands(profile) ? '网站读写' : '命令'}只用任务内 subcommands 列出的 ${cli} 子命令；${project_rule}不读取凭据内容。${read_rule}`;
  return { instructions, prompt };
}

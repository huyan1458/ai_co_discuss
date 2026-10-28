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

/** Append the member's prompt to a task prompt, marked as the user's own guidance for this member. */
export function with_expert_prompt(prompt, profile) {
  const extra = expert_prompt(profile);
  return extra ? `${prompt}\n\n用户为你单独设置的提示（补充做法与偏好，不改变权限与技能规则）：\n${extra}` : prompt;
}

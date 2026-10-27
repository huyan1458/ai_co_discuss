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

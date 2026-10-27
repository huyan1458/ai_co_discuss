/**
 * Prompts for one expert, beside the shared skills: a skill holds rules for everyone, this holds what one
 * software or one member needs. Presets exist only where a software needs one; a member's own
 * system_prompt, even an empty one, replaces its preset. They add guidance and never widen permissions.
 */

export const MAX_EXPERT_PROMPT = 4000;

export const EXPERT_PROMPT_PRESETS = {
  // Headless agy ends the turn when a command needs approval, and tends to work without a word between tools.
  antigravity_cli: `无人值守下 run_command 只能运行 codiscuss 的子命令，其他命令会被自动拒绝并使会话直接结束；列目录、搜索或读取文件用 list_dir、find_by_name、grep_search、view_file。
任务需要多步操作时，在读完材料、改定方案、验证结果这类关键转折处，用一两句中文写出进展再继续。`,
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

import { t } from "./i18n.js";

/**
 * MOSS's skills as the settings show them. Platform skills (install, deploy, configure) work only in the owner's own
 * window (`.dev/plans/MOSS对外窗口/` §12.3); the computer marks them with `platform: true`, and until it does the page
 * falls back to this list, the same as `CONFIRMATION_SKILLS` in `runner/steward.mjs`.
 */
export const PLATFORM_SKILLS = new Set(["local-stt-setup", "local-tts-setup", "notify-setup", "cloudflare-deploy"]);

const SKILL_LABELS = {
  "dispatch-analysis": () => t("派活分析"),
  "share-card": () => t("AI 制作分享卡"),
  "local-tts-setup": () => t("安装本机朗读"),
  "local-stt-setup": () => t("安装本机语音输入"),
  "notify-setup": () => t("配置通知渠道"),
  "discuss-report": () => t("整理讨论报告"),
  "codiscuss-draft-cleanup": () => t("共议占用盘点与清理"),
  "cloudflare-deploy": () => t("部署线上站点"),
  "codiscuss-help": () => t("使用帮助与排障"),
  "rooms-overview": () => t("房间总览"),
};

/** A skill's name for the page: ours by id, a global one by the name the computer gives, else its id. */
export const skill_label = (skill) => SKILL_LABELS[skill.id]?.() || skill.name || skill.id;
/** Whether a skill only works in the owner's own window. */
export const is_platform_skill = (skill) => skill.platform ?? PLATFORM_SKILLS.has(skill.id);

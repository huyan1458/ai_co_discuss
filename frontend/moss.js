import moss_idle_src from "./moss-idle.png";
import moss_running_src from "./moss-running.png";
import moss_waiting_src from "./moss-waiting.png";
import { t } from "./i18n.js";

/**
 * MOSS's picture for its room's state: waiting on the user, at work, or idle. No text label; the title says it on hover.
 * @param {object|undefined} room The MOSS room from the room list (`attention`, `running`).
 * @param {boolean} [running] The open room's own live state, fresher than the list's.
 * @returns {{ src: string, title: string, state: string }}
 */
export function moss_avatar(room, running = false) {
  if (room?.attention === "waiting_user") return { src: moss_waiting_src, title: t("MOSS 在等你回答"), state: "waiting" };
  if (running || room?.running || room?.attention === "running") return { src: moss_running_src, title: t("MOSS 正在工作"), state: "running" };
  return { src: moss_idle_src, title: t("MOSS 待机"), state: "idle" };
}

/** Whether the open room has a run going, from its live member states (fresher than the room list). */
export function moss_running(room) {
  return (room?.free?.members || []).some((member) => ["dispatched", "started"].includes(member.execution?.status));
}

/** The tone each report state is drawn in: amber only when the user is the one waited on. */
const REPORT_TONES = { completed: "completed", waiting_user: "waiting_user", waiting: "waiting", failed: "failed", unreported: "unreported", cancelled: "cancelled", running: "running" };

/**
 * The words for where a delegated piece of work stands, shared by the send card and MOSS's rail.
 * @param {string} state `relay_report_state`, or `running` for work under way without a report yet.
 * @param {boolean} [moss] Whether MOSS sent it; another host's relay reads "等主持人决定".
 * @returns {string} The label, or "" when the state has none.
 */
export function report_state_label(state, moss = true) {
  if (state === "completed") return t("已完成");
  if (state === "waiting_user") return t("等你决定");
  if (state === "waiting") return moss ? t("等 MOSS 决定") : t("等主持人决定");
  if (state === "failed") return t("失败");
  if (state === "cancelled") return t("已取消");
  if (state === "unreported") return t("未回报");
  if (state === "running") return t("进行中");
  return "";
}
export const report_tone = (state) => REPORT_TONES[state] || "";

/** A MOSS send card's state: its report once the program has one, else the work is under way. */
export const delegation_state = (message) => message.relay_report_state || "running";

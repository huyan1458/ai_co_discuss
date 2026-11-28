import moss_idle_src from "./moss-idle.png";
import moss_running_src from "./moss-running.png";
import moss_waiting_src from "./moss-waiting.png";
import { t } from "./i18n.js";

/**
 * MOSS's three kinds of window (`.dev/plans/MOSS对外窗口/` §12.1): the owner's own (主理人), the private chat every channel
 * comes into (私聊), and one per chat group. Each is a room of its kind; all show as MOSS pages.
 */
export const MOSS_KINDS = ["steward", "steward_private", "steward_group"];
export const is_moss_room = (room) => MOSS_KINDS.includes(room?.system_kind);
/** The key a group window's settings are kept under (`steward.windows`), from its room's `window`. */
export const moss_window_key = (room) => room?.window ? `${room.window.channel}:${room.window.chat_id}` : "";
/** A group window's settings when the owner has not set them (the computer's own defaults, `group-settings`). */
export const WINDOW_DEFAULTS = { habit: "", about: "", work_policy: "small", daily_limit: 30, daily_tasks: 5, model: "", effort: "", read_directory: "", skills: [] };
/** The fields of one group's draft that differ from what is saved, defaults filled in: what `group-settings` is sent. */
export function window_changes(draft = {}, saved = {}) {
  const value = (source, field) => source[field] ?? WINDOW_DEFAULTS[field];
  return Object.fromEntries(Object.keys(WINDOW_DEFAULTS).filter((field) => JSON.stringify(value(draft, field)) !== JSON.stringify(value(saved, field)))
    .map((field) => [field, value(draft, field)]));
}

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

/**
 * A room's one-line state at the end of its sidebar row (MOSS's entry uses the same, #15888); the wait timestamp
 * takes precedence over legacy attention.
 * @returns {{ kind: string, label: string } | null}
 */
export function room_attention(room, running) {
  if (room.waiting_user_since > 0) return { kind: "awaiting", label: t("在等你") };
  const { attention } = room;
  if (attention === "waiting_user") return { kind: attention, label: t("等你回答") };
  if (attention === "failed") return { kind: attention, label: t("执行失败") };
  if (attention === "running" || running) return { kind: "running", label: t("进行中") };
  return null;
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

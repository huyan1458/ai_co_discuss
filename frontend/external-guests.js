/**
 * External users: a person without CoDiscuss whom the room's owner lets into one room for a limited time, from a
 * browser page on the owner's own online site. This module is the owner side's one place for the guest state of a
 * room, the operations on it and the labels the invite card, the rail's presence card and the bar above the composer
 * share. Contract: .dev/plans/临时外部用户/API.md §2 (owner routes `/api/rooms/{room}/guest`, local `guest-invite`).
 */
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { t } from "./i18n.js";
import { lockdown_problem } from "./external-members.js";

/** Local service operation that registers an invitation and signs its link (runner). */
export const GUEST_INVITE_OPERATION = "guest-invite";
// Owner routes answer {ok, data} (API.md §1); older-style answers are taken as they are.
const unwrap = (result) => (result && result.ok === true && "data" in result ? result.data : result);
const guest_route = (room_id, action = "") => `/api/rooms/${encodeURIComponent(room_id)}/guest${action ? `/${action}` : ""}`;

const MINUTE_S = 60, HOUR_S = 60 * MINUTE_S;
/** Longest total stay, from entering the room (API.md §1). */
export const MAX_DURATION_S = 24 * HOUR_S;
export const DEFAULT_DURATION_S = 15 * MINUTE_S;
// Compact labels (no space) so the four choices fit on the invite card's back in both languages.
export const DURATIONS = [
  { value: 15 * MINUTE_S, label: t("15分钟") },
  { value: HOUR_S, label: t("1小时") },
  { value: 4 * HOUR_S, label: t("4小时") },
  { value: MAX_DURATION_S, label: t("24小时") },
];
/** What the owner can add while the guest is in the room; the total never passes MAX_DURATION_S. */
export const EXTENSIONS = [{ value: 15 * MINUTE_S, label: t("+15 分钟") }, { value: HOUR_S, label: t("+1 小时") }];
export const SCOPES = [
  { value: "chat", label: t("仅聊天"), description: t("文件页灰显；AI 的回答仍可能引用项目内容") },
  { value: "project", label: t("可读项目"), description: t("文件页只读显示本房间项目目录，固定排除 .env、密钥、凭据、data/ 与 .git") },
];
export const MODES = [
  { value: "conservative", label: t("保守"), description: t("本房间的 AI 只能读本房间项目、只能运行房间命令，不能运行其他命令或联网；做不到的成员暂停接单") },
  { value: "trust", label: t("信任"), description: t("AI 保持原有权限，能运行任意命令；对方的消息可能诱导 AI 越权，等于把对方当作你自己") },
];
export const MODE_SHORT = { conservative: t("保守"), trust: t("信任") };
/** How the owner names the guest before the link is sent; the guest may change it before entering. */
export const DEFAULT_LABEL = t("访客");

// Guest state changes on the guest's side (redeeming, entering) without the room view telling: read it this often.
const POLL_MS = { none: 30_000, ended: 30_000, invited: 5_000, waiting: 2_000, active: 5_000 };

/** "14:22" or "3:05:09" for a remaining time in milliseconds; "0:00" once past. */
export function clock_label(left_ms) {
  const total = Math.max(0, Math.ceil(left_ms / 1000));
  const hours = Math.floor(total / HOUR_S), minutes = Math.floor((total % HOUR_S) / MINUTE_S), seconds = total % MINUTE_S;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** The label of a duration in seconds, as the invite card lists it, else in minutes or hours. */
export function duration_label(seconds) {
  const listed = DURATIONS.find((item) => item.value === seconds);
  if (listed) return listed.label;
  return seconds % HOUR_S ? t("{count} 分钟", { count: Math.round(seconds / MINUTE_S) }) : t("{count} 小时", { count: seconds / HOUR_S });
}

/**
 * Why a member takes no work while the conservative mode holds, in the page language, or "" when it can be confined.
 * Follows the adapter layer's own declaration (`lockdown_support`), never the software's name.
 */
export function paused_reason(adapter, config = {}) {
  return adapter ? lockdown_problem(adapter, config) : "";
}

/** The owner's credential for a room when this browser holds one; without it the local website acts as the owner. */
function owner_token(room_id) {
  try { return localStorage.getItem(`discuss-access:${room_id}`) || ""; } catch { return ""; }
}

const stores = new Map();
/**
 * The link this page last generated per room, with the choices it was made from: the computer keeps only the code's
 * hash, so copying it again or showing its QR code after the invite dialog closed needs this copy; regenerating reuses
 * the choices. Lost on reload, when only regenerating from the invite dialog remains.
 */
export const guest_invites = new Map();

/**
 * The guest state of one room, shared by every component showing it: read on first use, then polled while anyone
 * shows it. `state` is the backend's State (API.md §2); `now` ticks each second on the server's clock, so countdowns
 * agree with the computer's expiry; `pending` holds an operation's target state until the backend confirms it.
 */
export function use_guest_state(bridge, room_id_source) {
  const room_id = computed(() => (typeof room_id_source === "function" ? room_id_source() : room_id_source.value) || "");
  const store = shallowRef(null);
  watch(room_id, (id, previous) => {
    if (previous) release(previous);
    store.value = id ? acquire(bridge, id) : null;
  }, { immediate: true });
  onScopeDispose(() => { if (room_id.value) release(room_id.value); });
  const state = computed(() => store.value?.state.value || null);
  const view = computed(() => {
    const current = state.value;
    if (!current) return null;
    const overlay = store.value.pending.value;
    return overlay ? { ...current, ...overlay, guest: current.guest && { ...current.guest, ...(overlay.guest || {}) } } : current;
  });
  return {
    state: view,
    now: computed(() => store.value?.now.value || Date.now()),
    left_ms: computed(() => {
      const expires = view.value?.guest?.expires_at;
      return view.value?.phase === "active" && expires ? expires - (store.value?.now.value || Date.now()) : 0;
    }),
    refresh: () => store.value?.refresh(),
    operations: computed(() => store.value?.operations || null),
  };
}

function acquire(bridge, room_id) {
  let store = stores.get(room_id);
  if (!store) { store = create_store(bridge, room_id); stores.set(room_id, store); }
  store.users += 1;
  return store;
}

function release(room_id) {
  const store = stores.get(room_id);
  if (!store || --store.users > 0) return;
  store.stop();
  stores.delete(room_id);
}

function create_store(bridge, room_id) {
  const state = shallowRef(null);
  const pending = shallowRef(null);
  // Server clock minus this browser's clock, from the last read.
  let offset = 0, poll_timer = 0, stopped = false, generation = 0;
  const now = ref(Date.now());
  const tick = setInterval(() => { now.value = Date.now() + offset; }, 1000);
  const token = () => owner_token(room_id) || undefined;

  function accept(next) {
    if (!next || stopped) return;
    if (next.server_time) offset = next.server_time - Date.now();
    state.value = next;
    now.value = Date.now() + offset;
  }
  async function refresh() {
    const asked = ++generation;
    try {
      const next = unwrap(await bridge.request(guest_route(room_id), undefined, token()));
      // A read that left before a write's answer must not put back the state the write replaced.
      if (asked === generation) accept(next);
    } catch { /* The next poll retries; actions report their own failures. */ }
    schedule();
  }
  function schedule() {
    clearTimeout(poll_timer);
    if (stopped) return;
    poll_timer = setTimeout(refresh, POLL_MS[state.value?.phase] || POLL_MS.none);
  }
  /** Run a write that needs the latest revision; the target state shows at once and is dropped if the write fails. */
  async function write(action, payload, overlay = null) {
    if (overlay) pending.value = overlay;
    generation++;
    try {
      const body = { revision: state.value?.revision, ...payload };
      const result = unwrap(await bridge.request(guest_route(room_id, action), body, token()));
      accept(result?.state || result);
      return result;
    } catch (error) {
      bridge.notify("error", guest_error(error));
      throw error;
    } finally {
      if (overlay) pending.value = null;
      schedule();
    }
  }
  const operations = {
    /** Register an invitation and get its link; the runner fills invite_id and signs the link (API.md §2). */
    invite: async (options) => {
      generation++;
      try {
        const result = unwrap(await bridge.local_request(GUEST_INVITE_OPERATION, { room_id, revision: state.value?.revision,
          ...(owner_token(room_id) ? { token: owner_token(room_id) } : {}), ...options }));
        accept(result?.state);
        if (result?.url) guest_invites.set(room_id, { ...result, options });
        return result;
      } finally { schedule(); }
    },
    protection: (mode) => write("protection", { mode }, { mode }),
    extend: (duration_seconds) => {
      const guest = state.value?.guest;
      return write("extend", { duration_seconds }, guest?.joined_at ? { guest: { duration_seconds, expires_at: guest.joined_at + duration_seconds * 1000 } } : null);
    },
    admit: (guest_id) => write("admit", { guest_id }, { stop_for_admission: true }),
    // An invitation not opened yet is voided by its id; the link stops working at once (backend O/revoke).
    revoke: (invite_id) => { guest_invites.delete(room_id); return write("revoke", { invite_id }, { phase: "none", invite_id: null, invite_expires_at: null }); },
    disconnect: (guest_id) => write("disconnect", { guest_id }, { phase: "ended", mode: "none", guest: { ended_at: Date.now() + offset, reason: "disconnected" } }),
  };
  refresh();
  return {
    users: 0, state, pending, now, refresh, operations,
    stop() { stopped = true; clearTimeout(poll_timer); clearInterval(tick); },
  };
}

// Backend refusals by code (API.md §1), in the page language; other failures show their own message.
const ERRORS = {
  stale_revision: t("状态刚刚变化，请再试一次"),
  guest_occupied: t("本房间已有外部用户在场，先断开再邀请"),
  guest_waiting: t("已有外部用户在等待入场，先断开再邀请"),
  guest_ended: t("外部用户已离开"),
  invalid_input: t("输入无效"),
};

/** A failed guest operation in the page language. */
export function guest_error(error) {
  const message = error?.message && error.message !== "[object Object]" ? error.message : "";
  return ERRORS[error?.code] || message || t("操作失败");
}

/** Whether a member is held back while the conservative mode holds, and why (API.md §2, PLAN §三). */
export function member_protection(state, member, saved) {
  if (state?.phase !== "active" || member?.access !== "runner") return null;
  if (state.mode !== "conservative") return null;
  const profile = saved?.participants?.[member.name] || {};
  const reason = paused_reason(member.adapter || profile.adapter, profile);
  return reason ? { paused: true, reason } : { paused: false, reason: "" };
}

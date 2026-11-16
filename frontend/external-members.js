/**
 * External members: an AI on another computer (A) that joins a room on this one (B) through B's relay and only reads
 * B's project. This module is the page's one place for the operations both sides call and for the labels they share:
 * B invites, adjusts and revokes (its right rail and invite dialog), A keeps its invited records (left sidebar, middle
 * page and right rail). Every request goes through the shared controller: `bridge.local_request` for this computer's
 * local service (relayed for paired devices), `bridge.request` for room routes of the room backend.
 *
 * Contracts: room routes 子Task1 CONTRACT §1–2, invitations 子Task2 CONTRACT §2.2, invited records 子Task4 CONTRACT §1–2.
 */
import { computed, effectScope, inject, ref, shallowRef, watch } from "vue";
import { locale, t } from "./i18n.js";
import { lockdown_support } from "../runner/adapters/profiles.mjs";
import runner_english from "../runner/i18n_en.mjs";

// Local service operations (runner), in one table so a renamed operation changes here only.
export const OPERATIONS = {
  // B: invitations (the runner signs them and keeps only their hashes).
  invite_create: "room-invite",
  invite_list: "room-invites",
  invite_revoke: "room-invite-revoke",
  // A: invited records.
  invited_list: "invited-list",
  invited_join: "invited-join",
  invited_trust: "invited-trust",
  invited_pause: "invited-pause",
  invited_approve: "invited-approve",
  invited_refuse: "invited-refuse",
  invited_leave: "invited-leave",
  invited_room: "invited-room",
};
// Room routes of the room backend, with the owner's credential.
export const ROUTES = {
  members: (room_id) => `/api/rooms/${encodeURIComponent(room_id)}/external-members`,
  member: (room_id, member_id) => `/api/rooms/${encodeURIComponent(room_id)}/external-members/${encodeURIComponent(member_id)}`,
  reads: (room_id, member_id, after = 0) => `/api/rooms/${encodeURIComponent(room_id)}/external-members/${encodeURIComponent(member_id)}/reads?after=${after}&limit=500`,
};

/** What B opens to an external member (`scope` in the room backend, `level` in invitations). */
export const LEVELS = [
  { value: "discuss", label: t("只讨论"), description: t("只看房间里点名给它的请求并回答，不读项目文件") },
  { value: "read", label: t("可读项目"), description: t("另可列目录、读文件、搜索所选目录；不能写入或执行") },
];
/** The short form for the rail and the records list. */
export const LEVEL_SHORT = { discuss: t("只讨论"), read: t("只读项目") };
/** How long an invitation's member stays in the room. */
export const DURATIONS = [
  { value: "1h", label: t("1 小时") },
  { value: "today", label: t("今天") },
  { value: "3d", label: t("3 天") },
];
/** A's three trust levels, recorded per inviting computer. */
export const TRUST_LEVELS = [
  { value: "default", label: t("默认"), description: t("对方点名后先问你，同意才唤醒；AI 只能用共议命令") },
  { value: "borrow", label: t("完全借用"), description: t("点名即唤醒，受下面的次数与期限上限；AI 只能用共议命令") },
  { value: "trusted", label: t("信任设备"), description: t("点名即唤醒，不设上限，按普通只读成员运行；这台电脑之后的邀请直接接受") },
];
export const TRUST_LABELS = Object.fromEntries(TRUST_LEVELS.map((item) => [item.value, item.label]));
/** How long 完全借用 lasts, in hours (`invited-trust` takes 1–720). */
export const BORROW_HOURS = [
  { value: 24, label: t("1 天") },
  { value: 72, label: t("3 天") },
  { value: 168, label: t("7 天") },
];

// Why an adapter cannot be confined to the codiscuss subcommands (runner/adapters/profiles.mjs `lockdown_hint` and
// `lockdown_support`), in the page language; text the adapter layer adds later shows as written until listed here.
const LOCKDOWN_REASONS = {
  "沙箱只读档仍可读整个磁盘、运行任意只读命令，无法只放行 codiscuss 命令": t("沙箱只读档仍可读整个磁盘、运行任意只读命令，无法只放行 codiscuss 命令"),
  "权限由 App 决定，接入程序无法逐次收窄": t("权限由 App 决定，接入程序无法逐次收窄"),
  "文件读取、网页读取与搜索工具是否全部受权限规则约束尚未核实，无法保证只放行 codiscuss 命令": t("文件读取、网页读取与搜索工具是否全部受权限规则约束尚未核实，无法保证只放行 codiscuss 命令"),
  "不支持的软件适配器": t("不支持的软件适配器"),
  "托管的已有会话沿用它自己的权限，无法收窄": t("托管的已有会话沿用它自己的权限，无法收窄"),
};

/** "" when this software can be confined to the codiscuss subcommands, else why not, in the page language. */
export function lockdown_problem(adapter, config = {}) {
  if (!adapter) return "";
  const { supported, reason } = lockdown_support(adapter, config);
  return supported ? "" : LOCKDOWN_REASONS[reason] || reason || t("不能收窄");
}

const MINUTE_MS = 60_000, HOUR_MS = 60 * MINUTE_MS, DAY_MS = 24 * HOUR_MS;

/** Epoch milliseconds from a backend time (seconds, milliseconds or ISO text), or 0. */
export function time_ms(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** "剩余 2 小时" and the like; "已到期" once past, "" without an end. */
export function remaining_label(expires_at, now = Date.now()) {
  const end = time_ms(expires_at);
  if (!end) return "";
  const left = end - now;
  if (left <= 0) return t("已到期");
  if (left >= DAY_MS) return t("剩余 {count} 天", { count: Math.floor(left / DAY_MS) });
  if (left >= HOUR_MS) return t("剩余 {count} 小时", { count: Math.floor(left / HOUR_MS) });
  return t("剩余 {count} 分钟", { count: Math.max(1, Math.ceil(left / MINUTE_MS)) });
}

/**
 * The external part of a room member (`free.members[]` with `access: "external"` and its `external` field), or null
 * for an ordinary member. Directories are only their last names here: the room view carries no paths.
 */
/** Shared arrival gate for manual sessions and reserved external seats. */
export const awaiting_member = (member) => member?.status === "active" &&
  (member.access === "manual" ? !member.registered_at : member.access === "external" && member.external?.claimed_at === 0);
export const seat_invites = new Map();
export function external_of(member) {
  if (!member || (member.access !== "external" && !member.external)) return null;
  const details = member.external || {};
  return {
    level: details.scope === "read" ? "read" : "discuss",
    expires_at: time_ms(details.expires_at),
    directories: (details.directories || []).map((item) => (typeof item === "string" ? item : item.name)),
    computer: details.machine_label || "",
    pending: details.claimed_at === 0,
    ended: member.status === "removed",
  };
}

/** The rail's quiet line for an external member: "外部 · 只读项目 · 剩余 2 小时". */
// The rail's line is narrow: the tiniest level names and time left ("剩 59 分" / "59m"), the full wording on hover.
const LEVEL_TINY = { discuss: t("仅讨论"), read: t("只读文件") };

/** "剩 59 分" / "59m" and the like; "已到期" once past, "" without an end. */
export function remaining_short(expires_at, now = Date.now()) {
  const end = time_ms(expires_at);
  if (!end) return "";
  const left = end - now;
  if (left <= 0) return t("已到期");
  if (left >= DAY_MS) return t("剩 {count} 天", { count: Math.floor(left / DAY_MS) });
  if (left >= HOUR_MS) return t("剩 {count} 小时", { count: Math.floor(left / HOUR_MS) });
  return t("剩 {count} 分", { count: Math.max(1, Math.ceil(left / MINUTE_MS)) });
}

/**
 * The rail's quiet line for an external member: short ("外部 · 只读文件 · 剩 2 小时") to fit beside the name, or with
 * `full` the wording for its hover text ("外部 · 只读项目 · 剩余 2 小时").
 */
export function external_tag(member, now = Date.now(), { full = false } = {}) {
  const info = external_of(member);
  if (!info) return "";
  if (info.pending) return t("外部专家 · 待签到");
  if (info.ended) return t("外部 · 已结束");
  return full ? [t("外部"), LEVEL_SHORT[info.level], remaining_label(info.expires_at, now)].filter(Boolean).join(" · ")
    : [t("外部"), LEVEL_TINY[info.level], remaining_short(info.expires_at, now)].filter(Boolean).join(" · ");
}

/** Whether the invited computer turned a request down or let it time out (`external_outcome` on the request). */
export const declined = (request) => request?.external_outcome === "declined" || request?.external_outcome === "timeout";

/**
 * A later end for 延长, in seconds: an hour or three days past the current end (or now, if already past), or the end
 * of today when that is later.
 */
export function extended_until(expires_at, duration, now = Date.now()) {
  const base = Math.max(time_ms(expires_at), now);
  if (duration === "1h") return Math.floor((base + HOUR_MS) / 1000);
  if (duration === "3d") return Math.floor((base + 3 * DAY_MS) / 1000);
  const tonight = new Date(now);
  tonight.setHours(23, 59, 59, 0);
  return Math.floor(Math.max(tonight.getTime(), base + MINUTE_MS) / 1000);
}

/** B's operations on its invitations and external members. */
/**
 * An invitation the new-room panel asked for, waiting for the room it creates: `{ options, known, at }`, where `options`
 * are the card's choices and `known` the rooms that existed when it was submitted. The first new room opened within
 * INVITE_AFTER_CREATION_MS takes it; a failed creation leaves it to expire.
 */
export const invite_after_creation = shallowRef(null);
export const INVITE_AFTER_CREATION_MS = 120000;

export function room_operations(bridge) {
  // The room's owner credential when this browser holds one; without it the local website acts as the computer's owner.
  const owner = (room_id) => {
    try { return localStorage.getItem(`discuss-access:${room_id}`) || ""; } catch { return ""; }
  };
  const with_token = (room_id, payload) => ({ room_id, ...(owner(room_id) ? { token: owner(room_id) } : {}), ...payload });
  return {
    create_invite: async (room_id, options) => {
      const result = await bridge.local_request(OPERATIONS.invite_create, with_token(room_id, options));
      seat_invites.set(`${room_id}:${result.member_id}`, result);
      return result;
    },
    list_invites: (room_id) => bridge.local_request(OPERATIONS.invite_list, with_token(room_id, {})),
    revoke_invite: (room_id, invite_id) => bridge.local_request(OPERATIONS.invite_revoke, with_token(room_id, { invite_id })),
    member: (room_id, member_id) => bridge.request(ROUTES.member(room_id, member_id), undefined, owner(room_id) || undefined),
    reads: (room_id, member_id, after = 0) => bridge.request(ROUTES.reads(room_id, member_id, after), undefined, owner(room_id) || undefined),
    update: (room_id, member_id, changes) => bridge.request(ROUTES.member(room_id, member_id), { action: "update", ...changes }, owner(room_id) || undefined),
    revoke: (room_id, member_id) => bridge.request(ROUTES.member(room_id, member_id), { action: "revoke" }, owner(room_id) || undefined),
  };
}

// A reads its records this often while the local service is reachable: a default-level request waits for an answer.
const INVITED_POLL_MS = 5000;
let invited = null;

/** A's invited records, shared by the sidebar, the middle page and the rail; created on first use. */
export function use_invited_rooms() {
  if (!invited) invited = effectScope(true).run(() => create_invited(inject("discussion")));
  return invited;
}

/** Why a record is no longer active (`status: ended` with `end_reason`, or `status: left`), in the page language. */
export const END_REASONS = { revoked: t("被对方撤销"), expired: t("已到期"), left: t("你已退出") };
/** "" for an active record, else "已结束：被对方撤销" and the like. */
export function end_label(record) {
  if (!record || !record.status || record.status === "active") return "";
  const reason = record.status === "left" ? "left" : record.end_reason;
  return t("已结束：{reason}", { reason: END_REASONS[reason] || reason || t("原因未知") });
}

/**
 * Text the local service (runner) wrote in Chinese, in the page language: its own English dictionary
 * (runner/i18n_en.mjs) by exact text, or by template with the parameters taken back out of the text. Text it does not
 * know stays as written. A reply with `error_text` is localized by the shared controller before it gets here.
 */
let runner_templates = null;
/** A runner `{ template, params }` (`error_text`, `reason_text`) in the page language, else `runner_text(fallback)`. */
export function runner_message(localized, fallback = "") {
  if (!localized?.template) return runner_text(fallback);
  const source = locale === "zh-CN" ? localized.template : runner_english[localized.template] || localized.template;
  return source.replace(/\{(\w+)\}/g, (match, name) => (name in (localized.params || {}) ? runner_text(String(localized.params[name])) : match));
}
export function runner_text(text) {
  if (!text || locale === "zh-CN") return text || "";
  if (runner_english[text]) return runner_english[text];
  runner_templates ||= Object.entries(runner_english).filter(([source]) => /\{\w+\}/.test(source)).map(([source, english]) => {
    const names = [];
    const pattern = source.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{(\w+)\\?\}|\{(\w+)\}/g, (match, escaped, plain) => { names.push(escaped || plain); return "(.+?)"; });
    return { pattern: new RegExp(`^${pattern}$`, "s"), names, english };
  });
  for (const { pattern, names, english } of runner_templates) {
    const found = text.match(pattern);
    if (found) return english.replace(/\{(\w+)\}/g, (match, name) => (names.includes(name) ? runner_text(found[names.indexOf(name) + 1]) : match));
  }
  return text;
}

/**
 * The middle page's items for one invited record: requests waiting for you, then each run (its history entries merged
 * by execution: woken, then ended or failed) and each refusal, newest first, and finally how the membership ended. An
 * answer this AI gave (`author` is the record's member) is placed under the request it answers (`request_message_id`),
 * and a request with an answer reads as answered whatever the run's exit said.
 *
 * @param {object} record An `invited-list` record.
 * @param {object[]} messages The top-level `messages` of `invited-room`: requests naming this AI and its own answers,
 *   read from the other room, or, when it cannot be reached, the texts this computer kept (`kept: true`).
 * @returns {object[]} `{ key, at, outcome, message_ids, requests, answers, reason }`; outcome is one of waiting,
 *   running, answered, finished, failed, refused, timeout, limit, lockdown_unsupported, ai_unavailable, ended.
 */
export function invited_items(record, messages = []) {
  if (!record) return [];
  const by_id = new Map(messages.map((message) => [message.id, message]));
  const answers = messages.filter((message) => message.author === record.member);
  const answered = new Set();
  const item = (key, at, outcome, message_ids = [], extra = {}) => {
    const ids = [...new Set(message_ids)];
    const replies = answers.filter((message) => ids.includes(message.request_message_id) || (extra.execution_id && message.execution_id === extra.execution_id));
    replies.forEach((message) => answered.add(message.id));
    const final = replies.length && outcome !== "waiting" ? "answered" : outcome;
    const requests = ids.map((id) => by_id.get(id)).filter(Boolean);
    return { key, at, outcome: final, message_ids: ids, requests, answers: replies, reason: "", reason_text: null, ...extra,
      // An answer settles the request: the process's note after it (an exit code, local paths) is not shown as content.
      ...(final === "answered" ? { reason: "", reason_text: null } : {}),
      // Answered, yet neither text can be read any more: the page says where they are instead.
      missing_text: final === "answered" && !replies.length && !requests.length };
  };
  const runs = new Map(), others = [];
  for (const entry of record.history || []) {
    if (entry.execution_id) {
      const run = runs.get(entry.execution_id) || { at: entry.at, message_ids: [], outcome: "running", reason: "", reason_text: null };
      run.message_ids.push(...(entry.message_ids || []));
      if (entry.outcome !== "woken") Object.assign(run, { outcome: entry.outcome === "ended" ? "finished" : entry.outcome, reason: entry.reason || "", reason_text: entry.reason_text || null });
      runs.set(entry.execution_id, run);
    } else if (!["ended", "left"].includes(entry.outcome)) others.push(entry);
  }
  const running = record.running?.execution_id;
  const history = [
    ...[...runs].map(([id, run]) => item(`e${id}`, run.at, id === running ? "running" : run.outcome, run.message_ids, { execution_id: id, reason: run.reason, reason_text: run.reason_text })),
    ...others.map((entry, index) => item(`h${index}`, entry.at, entry.outcome, entry.message_ids, { reason: entry.reason || "", reason_text: entry.reason_text || null })),
  ].sort((a, b) => time_ms(b.at) - time_ms(a.at));
  const waiting = (record.approvals || []).map((approval) => item(`a${approval.id}`, approval.received_at, "waiting", approval.message_ids, { by: approval.created_by }));
  // Answers no run accounts for (an older run, or one this computer did not record) still show, each on its own.
  const loose = answers.filter((message) => !answered.has(message.id))
    .map((message) => item(`m${message.id}`, message.created_at, "answered", message.request_message_id ? [message.request_message_id] : []));
  const ended = end_label(record) ? [{ key: "end", at: (record.history || []).findLast?.((entry) => ["ended", "left"].includes(entry.outcome))?.at || 0,
    outcome: "ended", message_ids: [], requests: [], answers: [], reason: end_label(record) }] : [];
  return [...ended, ...waiting, ...[...history, ...loose].sort((a, b) => time_ms(b.at) - time_ms(a.at))];
}

function create_invited({ view, bridge }) {
  const available = computed(() => Boolean(view.value.launch.available || view.value.launch.remote));
  const records = ref([]), loaded = ref(false), failure = ref("");
  // Whether the middle shows an invited room in place of a room, and which one.
  const page_open = ref(false), selected_id = ref("");
  const selected = computed(() => records.value.find((record) => record.id === selected_id.value) || null);
  // The join dialog, with a link or code handed over by the online explanation page.
  const joining = ref(false), join_text = ref("");
  // What the other room says about this member now (`invited-room` → `room.me`), by record: its scope and end follow
  // the owner's later changes, which the record learns only on its next pull.
  const room_me = ref({});
  // D6a: 信任设备 is set only on this computer's own page; through the relay or from an online page it stays greyed.
  const trust_local = computed(() => Boolean(view.value.admin?.local) || ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname));
  const busy = ref("");
  const announced = new Set();
  let timer = 0;

  /** Read the records; newly waiting default-level requests raise a notice once each. */
  async function load() {
    if (!available.value) return;
    try {
      const result = await bridge.local_request(OPERATIONS.invited_list, {});
      // Ended and left records stay: their history and why they ended remain readable.
      records.value = result.records || [];
      failure.value = "";
      for (const record of records.value) {
        for (const approval of record.approvals || []) {
          const key = `${record.id}:${approval.id}`;
          if (announced.has(key)) continue;
          announced.add(key);
          if (loaded.value) bridge.notify("warning", t("「{room}」点名了你的 AI，等你同意", { room: record.room_title || record.room || "" }));
        }
      }
    } catch (error) { failure.value = runner_text(error.message); }
    finally { loaded.value = true; }
  }
  watch(available, (ready) => {
    clearInterval(timer);
    if (!ready) return;
    load();
    timer = setInterval(load, INVITED_POLL_MS);
  }, { immediate: true });

  /** Run one write, show its error as a notice, and read the records again; returns the result or null. */
  async function run(name, operation, payload, success = "") {
    if (busy.value) return null;
    busy.value = name;
    try {
      const result = await bridge.local_request(operation, payload);
      if (success) bridge.notify("info", success);
      await load();
      return result || {};
    } catch (error) {
      bridge.notify("error", runner_text(error.message));
      return null;
    } finally { busy.value = ""; }
  }

  const open = (id) => { selected_id.value = id; page_open.value = true; };
  const close = () => { page_open.value = false; };
  /** Join, then set the trust level if the user chose one above 默认 (`invited-join` starts at the computer's level). */
  async function join({ trust, ...payload }) {
    const result = await run("join", OPERATIONS.invited_join, payload);
    if (!result?.record) return result;
    if (trust && trust.trust !== result.record.trust) await set_trust(result.record.id, trust);
    return result;
  }
  /** `trust`: { trust, max_wakes, hours }; the limits apply to 完全借用 only. */
  const set_trust = (id, { trust, max_wakes, hours }, success = "") => run("trust", OPERATIONS.invited_trust,
    { id, trust, ...(trust === "borrow" ? { max_wakes, hours } : {}) }, success);
  const set_paused = (id, paused) => run("pause", OPERATIONS.invited_pause, { id, paused }, paused ? t("已暂停") : t("已恢复"));
  const approve = (id, approval) => run(`decide:${approval}`, OPERATIONS.invited_approve, { id, approval }, t("已同意，正在唤醒"));
  const refuse = (id, approval) => run(`decide:${approval}`, OPERATIONS.invited_refuse, { id, approval }, t("已拒绝，对方会看到“对方未同意”"));
  async function leave(id) {
    const done = await run("leave", OPERATIONS.invited_leave, { id });
    if (!done) return done;
    bridge.notify(done.remote === "unreachable" ? "warning" : "info", done.remote === "unreachable"
      ? t("已在这台电脑上退出；对方电脑不在线，它那边要等撤销或到期才会移除") : t("已退出该房间"));
    if (selected_id.value === id) page_open.value = false;
    return done;
  }
  /** One invited room: `{ record, room, error? }`, room being this computer's AI's view of the other room. */
  const read_room = (id) => bridge.local_request(OPERATIONS.invited_room, { id });
  /** Open the join dialog, optionally filled with a link or code. */
  function start_join(text = "") { join_text.value = text; joining.value = true; }

  return { available, records, loaded, failure, page_open, selected_id, selected, joining, join_text, busy, room_me, trust_local,
    load, open, close, join, set_trust, set_paused, approve, refuse, leave, read_room, start_join };
}

/**
 * The link or code a join form receives: the explanation page hands it over as `#join=<link>`; reading it removes it
 * from the address so a reload does not ask again.
 */
export function take_join_fragment() {
  // web/app.js opens the last room on load and rewrites the address (`/?room=…`) before this workspace mounts, so the
  // fragment as the page first loaded is kept by i18n-runtime.js, the first script every page runs.
  const initial = globalThis.codiscuss_initial_hash;
  delete globalThis.codiscuss_initial_hash;
  const value = new URLSearchParams((initial || "").slice(1)).get("join") || new URLSearchParams((location.hash || "").slice(1)).get("join");
  const fragment = new URLSearchParams((location.hash || "").slice(1));
  if (fragment.has("join")) {
    fragment.delete("join");
    const rest = fragment.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
  }
  return value || "";
}

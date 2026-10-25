<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ScheduleCard from "./ScheduleCard.vue";
import { motion, useReducedMotion, useSpring, useTransform } from "motion-v";

const emit = defineEmits(["detail", "edit"]);
const topic_expanded = ref(false);
const topic_body = ref(null);
const topic_overflows = ref(false);
const TOPIC_BODY_MAX_HEIGHT = 240;
const { view, bridge, field, act, pending } = inject("discussion");
const text = field("message-input");
const text_length = computed(() => [...text.value].length);
const EDITOR_MAX_ROWS = 6;
const LENGTH_WARNING_RATIO = 0.9;
const near_length_limit = computed(() => text_length.value >= bridge.max_message_length * LENGTH_WARNING_RATIO);
const author = field("author-select");
const kind = field("message-kind");
const answer_summary = field("message-summary");
const summary_source = field("message-summary-source");
const needs_summary = computed(() => ["opinion", "forward"].includes(kind.value) && author.value !== "用户");
const summary_sources = [{ value: "author", label: "原作者摘要" }, { value: "submitter", label: "代发者整理" }];
const search = field("search-input");
const transcript = ref(null);
const expanded_answers = ref(new Set());
const MESSAGE_PREVIEW_LENGTH = 160;
const MESSAGE_PREVIEW_MIN_LENGTH = 100;
const MESSAGE_PREVIEW_CODE_LINES = 4;
const MESSAGE_PREVIEW_TABLE_ROWS = 3;
const answer_preview_cache = new WeakMap();
/** Reuse immutable message excerpts while the room refreshes. */
const answer_previews = computed(() => new Map(view.value.messages.map((message) => {
  if (!answer_preview_cache.has(message)) answer_preview_cache.set(message, build_answer_preview(message));
  return [message.id, answer_preview_cache.get(message)];
})));
/** The channel's purpose shown above the transcript; old rooms without a user request fall back to background. */
const topic = computed(() => {
  const value = room.value || {};
  const request = value.user_request?.trim() ? { label: "用户原文", text: value.user_request } : value.background?.trim() ? { label: "背景", text: value.background } : null;
  const experts = Object.entries(value.experts || {}).map(([name]) => ({ name, mode: bridge.participant_access(name, value) }));
  const limits = value.limits || {};
  const bounds = value.mode === "free" ? `自由协作 · 单次执行最多 ${value.free?.execution_minutes || 20} 分钟`
    : [limits.max_rounds ? `${limits.max_rounds} 轮` : "轮次不限", limits.max_minutes ? `${limits.max_minutes} 分钟` : "时长不限",
      value.runtime?.mode === "automatic" ? "全自动" : "手动"].join(" · ");
  return { request, goal: value.goal, boundaries: value.boundaries, host: value.host, experts, bounds };
});
const topic_key = computed(() => JSON.stringify(topic.value));
const message_map = ref(null);
const navigation_keyboard = ref(false);
const active_message = ref(null);
const jump_target = ref(null);
const preview_message = ref(null);
const preview_entry = ref(null);
const preview_is_round = ref(false);
const preview_open = ref(false);
const preview_content = ref(null);
const preview_left = ref(0);
const preview_top = ref(0);
const preview_size = ref(0);
const reduced_motion = useReducedMotion();
// Feel.words("snappy, precise"): m 1, 3.91 Hz, ζ 0.91; keep velocity when retargeting.
const NAV_SPRING = { type: "spring", mass: 1, stiffness: 604.0197893466687, damping: 44.729801589453814 };
const PREVIEW_WIDTH = 320;
const PREVIEW_PADDING = 34; // Two 16px paddings and two 1px borders.
const PREVIEW_INSET = 12;
const PREVIEW_GAP = 16;
const NAV_ENTRY_HEIGHT = 14;
const NAV_TICK_WIDTH = 8;
const NAV_ACTIVE_WIDTH = 28;
const NAV_READING_WIDTH = 18;
const NAV_TICK_HEIGHT = 1;
const NAV_ACTIVE_HEIGHT = 1.5;
const NAV_HOVER_REACH = 3;
const NAV_HOVER_EXTENSION = 6;
const NAV_TICK_OPACITY = 0.62;
const NAV_READING_OPACITY = 0.72;
const NAV_ACTIVE_OPACITY = 0.88;
const NAV_HOVER_OPACITY = 0.16;
const NAV_EDGE_INSET = 12;
const NAV_LONG_PRESS_MS = 450;
const NAV_TOUCH_SLOP = 8;
let navigation_press = null;
let suppress_navigation_click = false;
const preview_y = useSpring(0, NAV_SPRING);
const preview_height = useSpring(0, NAV_SPRING);
const preview_visibility = useSpring(0, NAV_SPRING);
const preview_scale = useTransform(preview_visibility, [0, 1], [0.96, 1]);
const preview_x = useTransform(preview_visibility, [0, 1], [-8, 0]);
const preview_opacity = useTransform(preview_visibility, [0, 1], [0, 1]);
const preview = computed(() => view.value.messages.find((message) => message.id === preview_message.value));
const preview_group = computed(() => navigation_groups.value.find((group) => group.messages.some((message) => message.id === preview_message.value)));
const preview_round = computed(() => preview_group.value?.label);
const preview_index = computed(() => preview_open.value ? navigation_entries.value.findIndex((entry) => entry.key === preview_entry.value) : -1);
const prompt = ref(null);
const follow_tail = ref(true);
const FOLLOW_TAIL_THRESHOLD = 70;
const READING_OFFSET = 20;
const room = computed(() => view.value.room);
// Registered after `room` exists: the immediate watch evaluates the topic, which reads it.
/** Show "展开全文" only when the whole topic body is taller than its folded height. */
async function measure_topic() {
  await nextTick();
  topic_overflows.value = (topic_body.value?.scrollHeight || 0) > TOPIC_BODY_MAX_HEIGHT;
}
watch(topic_key, measure_topic, { immediate: true });
watch(() => view.value.tab, measure_topic);
const reply_glow = ref(null);
// Feel.words("calm, smooth"): m 1, f 1.407 Hz, ζ 1.05 → k 78.167, c 18.567.
// A constant force equal to a spring stretched by 1/8 of the sweep gives a calm,
// steady scan; mass sets acceleration, damping sets the terminal speed F/c.
const REPLY_GLOW_MASS = 1;
const REPLY_GLOW_DAMPING = 18.566573373612275;
const REPLY_GLOW_FORCE = 78.16726685662772 / 8;
/** Move only the text's highlight; removal and reduced motion cancel the loop. */
watch([reply_glow, reduced_motion], ([element, reduce_motion], _previous, cleanup) => {
  if (!element || reduce_motion) return;
  const relaxation = REPLY_GLOW_MASS / REPLY_GLOW_DAMPING;
  const terminal_speed = REPLY_GLOW_FORCE / REPLY_GLOW_DAMPING;
  let position = 0, velocity = 0, previous_time = performance.now(), frame = 0;
  element.classList.add("is-glowing");
  /** Integrate m·x″ = F − c·x′ exactly, independent of frame rate. */
  function advance_glow(now) {
    const seconds = (now - previous_time) / 1000;
    const decay = Math.exp(-seconds / relaxation);
    position = (position + terminal_speed * seconds
      + (velocity - terminal_speed) * relaxation * (1 - decay)) % 1;
    velocity = terminal_speed + (velocity - terminal_speed) * decay;
    previous_time = now;
    element.style.setProperty("--reply-glow-position", `${100 * (1 - position)}%`);
    frame = requestAnimationFrame(advance_glow);
  }
  frame = requestAnimationFrame(advance_glow);
  cleanup(() => {
    cancelAnimationFrame(frame);
    element.classList.remove("is-glowing");
    element.style.removeProperty("--reply-glow-position");
  });
}, { flush: "post" });
const speaking_turn = computed(() => ["pending", "notified"].includes(room.value?.current_turn?.status)
  && !["paused", "concluded"].includes(room.value.phase) ? room.value.current_turn : null);
const is_manual_member = (member) => member?.access === "manual" && member.status === "active";
const speaking_member = computed(() => (room.value.members || []).find((member) => member.name === speaking_turn.value?.expert));
// The first invited manual expert that has not registered yet; the notice stays until it does.
const unregistered_member = computed(() => ["paused", "concluded"].includes(room.value?.phase) ? null
  : (room.value?.members || []).find((member) => is_manual_member(member) && !member.registered_at) || null);
const queue_hint = computed(() => {
  const member = speaking_member.value;
  if (!speaking_turn.value || !member) return "";
  const name = bridge.display_name(member.name);
  if (is_manual_member(member)) return member.registered_at ? `${name} 是手动启动，轮到它时需到其 AI 会话触发；不接入可在进度看板点「跳过」本次发言` : "";
  return text.value.trim() ? `新消息会在 ${name} 回复后交给主持人；可在进度看板点「跳过」本次发言` : "";
});
const free = computed(() => room.value?.mode === "free");
/** Members of a free room that are working on a live execution, or have requests nobody has picked up yet. */
const free_busy = computed(() => {
  if (!free.value || room.value.archived) return [];
  return (room.value.free?.members || []).flatMap((member) => {
    const execution = member.execution;
    if (execution && ["dispatched", "started"].includes(execution.status)) {
      return [{ id: `free-${execution.id}`, author: member.name, member_id: member.id,
        text: execution.stale ? "执行失联：网站已不再接受本次回答，软件停止未确认" : "正在处理…",
        seconds: Math.max(0, Math.floor(Date.now() / 1000) - execution.created_at) }];
    }
    return member.pending ? [{ id: `queue-${member.id}`, author: member.name, member_id: member.id, text: "待投递：等待本机服务接手", seconds: null }] : [];
  });
});
/** One working card: the first busy member leads, the others are listed in the same line. */
const free_activity = computed(() => {
  const [first, ...others] = free_busy.value;
  if (!first) return null;
  const text = others.length ? [first, ...others].map((item) => `${bridge.display_name(item.author)}：${item.text}`).join(" · ") : first.text;
  return { ...first, is_host: false, round: "", text };
});
/** Says in the note line who the draft will reach: the @mentioned members, else the host. */
const recipient_hint = computed(() => {
  if (view.value.free_proxy) return `本条作为 ${bridge.display_name(view.value.free_proxy)} 的回答原文保存，并关闭它的待处理请求`;
  const named = free_members.value.filter((member) => MENTION_PATTERN(member.name).test(draft_prose.value));
  if (named.length) return `发给 ${named.map((member) => bridge.display_name(member.name)).join("、")}`;
  if (free_members.value.length === 1) return `发给 ${bridge.display_name(free_members.value[0].name)}`;
  return free_host.value ? `发给主持人 ${bridge.display_name(free_host.value.name)}；@ 其他成员让它们发言` : "未 @ 任何成员：只作留言，不会唤醒 AI";
});
const has_draft = computed(() => Boolean(text.value.trim() || view.value.attachment_drafts.length));
/** Active members a free-room message can name; chips appear only when there is a choice. */
const free_members = computed(() => free.value ? (room.value.free?.members || []).filter((member) => member.status === "active") : []);
const free_host = computed(() => free_members.value.find((member) => member.role === "host"));
const free_online = computed(() => free_members.value.filter((member) => member.access === "online"));
/** In a discussion, an @mention of an active member is a direct question: it wakes that member outside turns, rounds and limits. */
const ask_members = computed(() => free.value ? [] : (room.value?.members || []).filter((member) => member.status === "active" && member.name !== "用户"));
const asked_names = computed(() => ask_members.value.filter((member) => MENTION_PATTERN(member.name).test(draft_prose.value)).map((member) => bridge.display_name(member.name)));
const mention_pool = computed(() => free.value ? free_members.value : ask_members.value);
/** Combine immutable suggestions with live membership and conversion status. */
const response_suggestions = computed(() => {
  if (!free.value) return new Map();
  const members = new Map((room.value.free?.members || []).map(member => [member.id, member]));
  const requests = new Map((room.value.free?.requests || []).map(request => [`${request.message_id}:${request.member_id}`, request]));
  return new Map(view.value.messages.map(message => [message.id, (message.suggestions || []).map(suggestion => {
    const request_id = requests.get(`${message.id}:${suggestion.member_id}`)?.id || suggestion.request_id;
    const status = members.get(suggestion.member_id)?.status || "removed";
    return { ...suggestion, request_id, status,
      can_convert: !request_id && status === "active" && view.value.access?.can_manage && !room.value.archived && !pending.value };
  })]));
});
/** A draft @mentions a member only outside code and quotes. */
const MENTION_PATTERN = (name) => new RegExp(`(^|[\\s(（，,。；;：:])@${name}(?![\\w-])`, "u");
const draft_prose = computed(() => text.value.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, ""));
const SCHEDULER_LABELS = { jev: "TypeSafe Jev", decisions: "OpenAI Decisions" };
const FREE_REQUEST_LABELS = { pending: ["待投递", "neutral"], delivering: ["处理中", "info"], completed: ["已回复", "success"],
  cancelled: ["已停止", "neutral"], failed: ["失败", "error"] };
/** Each user message in a free room shows what happened to its request for every named member. */
const request_badges = computed(() => {
  const badges = new Map();
  const source = free.value ? room.value.free : room.value.asks;
  if (!source) return badges;
  const failures = new Map((source.executions || []).map((execution) => [execution.id, execution.result]));
  for (const request of source.requests || []) {
    const [label, color] = FREE_REQUEST_LABELS[request.status];
    const title = request.status === "failed" ? failures.get(request.execution_id) || "执行失败" : "";
    badges.set(request.message_id, [...(badges.get(request.message_id) || []),
      { key: request.id, label: `${bridge.display_name(request.member)} · ${label}`, color, title }]);
  }
  return badges;
});
/** Attach each terminal execution to its answer, or to the original request when it has no answer. */
const execution_reports = computed(() => {
  const reports = new Map();
  const source = free.value ? room.value.free : room.value.asks;
  if (!source) return reports;
  for (const execution of source.executions || []) {
    if (!["completed", "failed", "cancelled"].includes(execution.status)) continue;
    const message_id = execution.answer_id || execution.request_message_id;
    const report = { ...execution, label: { completed: "已完成", failed: "失败", cancelled: "已停止" }[execution.status],
      seconds: Math.max(0, execution.finished_at - execution.created_at),
      files_text: !execution.changes_recorded ? "未提供自动改动检测（非 Git 目录或未上报）"
        : execution.changes.length ? execution.changes.join("、") : "未观察到文件变化" };
    reports.set(message_id, [...(reports.get(message_id) || []), report]);
  }
  return reports;
});
/** Show live executions or an explicit manual wait, without implying that a manual expert is working. */
const pending_message = computed(() => {
  const value = room.value;
  if (free.value) return view.value.query || view.value.mention_only ? null : free_activity.value;
  const runtime = value?.runtime;
  if (view.value.query || view.value.mention_only || value?.archived || ["paused", "concluded"].includes(value?.phase)
    || runtime?.mode !== "automatic" || runtime.status !== "running" || runtime.expired) return null;
  const execution = (runtime.participants || []).find((item) => !item.stale
    && ["dispatched", "started"].includes(item.status)
    && (item.role === "host" ? item.participant === value.host
      : item.turn_id === speaking_turn.value?.id && item.participant === speaking_turn.value?.expert));
  const groups = value.round_groups || value.rounds || [];
  const latest_round = groups.at(-1);
  const round = latest_round?.completed === false || execution?.role === "host"
    ? latest_round?.number : groups.filter((item) => item.completed).length + 1;
  if (!execution) {
    const turn = speaking_turn.value;
    const member = (value.members || []).find((item) => item.name === turn?.expert);
    if (!turn || member?.access !== "manual" || member.status !== "active") return null;
    return { id: `turn-${turn.id}`, author: turn.expert, is_host: false, manual: true,
      round: `第 ${round} 轮`, text: "等待发言，请在该 AI 会话中发送启动指令。", seconds: null };
  }
  const timing = runtime.timings?.items.find((item) => item.id === execution.id);
  const is_host = execution.role === "host";
  const text = is_host ? (execution.status === "dispatched" ? "正在唤醒主持人…" : "正在安排下一步…")
    : (execution.status === "dispatched" ? "正在唤醒…" : "正在准备回复…");
  return { id: execution.id, author: execution.participant, is_host,
    round: round ? `第 ${round} 轮` : "", text,
    seconds: timing?.wake_seconds == null ? null : timing.wake_seconds + (timing.work_seconds || 0) };
});
/** Cancelled assignments stay in the transcript under the message they followed. */
const cancelled_turns = computed(() => {
  const rows = new Map();
  if (free.value) return rows;
  for (const turn of room.value.cancelled_turns || []) rows.set(turn.after_message_id, [...(rows.get(turn.after_message_id) || []), turn]);
  return rows;
});
/** A user's message is waiting for the host while it is at or after the relay hold. */
const waits_for_host = (message) => message.author === "用户" && room.value?.held_since > 0 && message.id >= room.value.held_since;
/** Smart scheduling's recommendations count down from when the room view arrived; an expired open one disappears. */
const recommendation_clock = ref(Date.now());
const recommendation_received = ref(Date.now());
watch(() => room.value.free?.recommendations, () => { recommendation_received.value = recommendation_clock.value = Date.now(); });
const adopting = ref(0);
const recommendations = computed(() => {
  const rows = new Map();
  if (!free.value) return rows;
  const elapsed = Math.floor((recommendation_clock.value - recommendation_received.value) / 1000);
  const routes = new Map((room.value.free?.requests || []).filter((request) => request.purpose === "route").map((request) => [request.message_id, request]));
  for (const item of room.value.free?.recommendations || []) {
    const remaining = item.expires_in - elapsed;
    if (item.status === "open" && remaining <= 0) continue;
    const host_busy = ["pending", "delivering"].includes(routes.get(item.message_id)?.status);
    rows.set(item.message_id, { ...item, remaining, host_busy, label: SCHEDULER_LABELS[item.provider] || item.provider,
      can_adopt: item.status === "open" && view.value.access?.can_manage && !room.value.archived && !pending.value });
  }
  return rows;
});
// Tick only while an open recommendation is counting down.
const recommendation_timer = window.setInterval(() => {
  if ((room.value.free?.recommendations || []).some((item) => item.status === "open")) recommendation_clock.value = Date.now();
}, 1000);
onBeforeUnmount(() => window.clearInterval(recommendation_timer));
/** Adopt with the chosen timing; a finished host leaves only "ask now", sent as mode after. */
/** In a discussion, each smart-scheduling decision shows under the message it followed. */
const scheduler_decisions = computed(() => {
  const rows = new Map();
  if (free.value) return rows;
  for (const item of room.value.scheduler_decisions || []) {
    // A skip asked the model nothing (no confidence, nothing applied, no question), so there is no decision to show.
    if (item.confidence === null && !item.applied && !item.detail?.length) continue;
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, title: `${SCHEDULER_LABELS[item.provider] || item.provider}${item.confidence === null ? "" : `，置信度 ${Number(item.confidence).toFixed(2)}`}` }]);
  }
  return rows;
});
const DECISION_OPTIONS = { __host__: "交给主持人", __note__: "仅补充信息", continue: "继续下一轮" };
const option_name = (name) => DECISION_OPTIONS[name] || bridge.display_name(name);
/** The host's own plans stand beside the decisions, under the message they followed. */
const host_arrangements = computed(() => {
  const rows = new Map();
  if (free.value) return rows;
  for (const item of room.value.host_arrangements || []) {
    rows.set(item.after_message_id, [...(rows.get(item.after_message_id) || []),
      { ...item, label: item.turns.map((turn) => bridge.display_name(turn.expert)).join(" → ") }]);
  }
  return rows;
});
function adopt(message_id, mode) {
  adopting.value = 0;
  act("adopt_recommendation", { message_id, mode });
}
const ELAPSED_TICK_MS = 1000;
const pending_seconds = ref(null);
/** Tick from dispatch time, resync with each server snapshot, and stop when the card disappears. */
watch([() => pending_message.value?.id, () => pending_message.value?.seconds], ([_id, seconds], _previous, cleanup) => {
  pending_seconds.value = seconds ?? null;
  if (pending_seconds.value === null) return;
  const baseline = performance.now();
  const timer = setInterval(() => {
    pending_seconds.value = seconds + Math.floor((performance.now() - baseline) / ELAPSED_TICK_MS);
  }, ELAPSED_TICK_MS);
  cleanup(() => clearInterval(timer));
}, { immediate: true });
/** Format recorded seconds consistently; missing timing is never estimated. */
function format_elapsed(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}
const pending_duration = computed(() => format_elapsed(pending_seconds.value));
/** A scheduler call's milliseconds: sub-second calls stay in milliseconds, longer ones use the shared format. */
function format_ms(ms) {
  return ms < 1000 ? `${ms}毫秒` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}秒` : format_elapsed(Math.round(ms / 1000));
}
/** The host's arrangement time: from the answer it followed to the moment the plan was saved. */
function arrangement_seconds(plan, anchor) {
  const seconds = Math.round((new Date(plan.created_at) - new Date(anchor.created_at)) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}
/** A reply's recorded time: the discussion turn's timing, or in a free room the execution that delivered it. */
function message_elapsed(message) {
  if (message.elapsed_seconds != null) return message.elapsed_seconds;
  return execution_reports.value.get(message.id)?.find((report) => report.answer_id === message.id)?.seconds ?? null;
}
const identities = computed(() => ["用户", ...Object.keys(room.value?.experts || {}).filter(name => room.value.experts[name] === "online")].map(name => {
  const identity = bridge.identities[name];
  return { label: bridge.display_name(name), value: name,
    avatar: { src: identity.icon, text: identity.initials, alt: bridge.display_name(name), class: `channel-avatar ${identity.style}` },
    description: name === "用户" ? "本人发言" : "代发在线成员原文" };
}));
const selected_identity = computed(() => identities.value.find((item) => item.value === author.value));
const kinds = [{ label: "普通发言 / 代发", value: "opinion", icon: "i-lucide-message-square" }, { label: "主持发言", value: "moderation", icon: "i-lucide-list-checks" }, { label: "代发在线观点", value: "forward", icon: "i-lucide-forward" }];
const date_formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const author_note = computed(() => kind.value === "forward" ? "由用户代发" : kind.value === "moderation" ? "主持发言" : author.value === "用户" ? "本人发言" : `代发 ${author.value} 的观点`);

const blank = (match) => " ".repeat(match.length);
const escape_html = (value) => value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
/** Paint the @mentions that will wake a member behind the transparent editor text; code and quotes do not count. */
const mention_mirror = computed(() => {
  const value = text.value;
  if (!mention_pool.value.length || !value.includes("@")) return "";
  // Masking keeps every offset, so matches in the masked copy point at the same characters of the draft.
  const masked = value.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank).replace(/^>.*$/gm, blank);
  const ranges = mention_pool.value.flatMap(({ name }) => [...masked.matchAll(new RegExp(MENTION_PATTERN(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).source, "gu"))]
    .map((match) => [match.index + match[1].length, match.index + match[0].length])).sort((a, b) => a[0] - b[0]);
  if (!ranges.length) return "";
  let html = "", cursor = 0;
  for (const [start, end] of ranges) {
    html += `${escape_html(value.slice(cursor, start))}<span class="channel-mention">${escape_html(value.slice(start, end))}</span>`;
    cursor = end;
  }
  // The trailing space keeps a final empty line, which the textarea also shows.
  return `${html}${escape_html(value.slice(cursor))} `;
});
const mirror = ref(null);
/** Keep the painted copy at the editor's scroll position. */
function sync_mirror() {
  if (mirror.value && prompt.value?.textareaRef) mirror.value.scrollTop = prompt.value.textareaRef.scrollTop;
}
watch(mention_mirror, () => nextTick(sync_mirror), { flush: "post" });

const mention_context = ref(null);
const mention_index = ref(0);
const mention_list = ref(null);
let mention_composing = false;
const mention_members = computed(() => {
  const names = free.value ? free_members.value.map(member => member.name)
    : [...new Set([room.value?.host, ...Object.keys(room.value?.experts || {})])].filter(name => name && name !== "用户");
  const query = mention_context.value?.query.toLocaleLowerCase() || "";
  return names.filter(name => `${name} ${bridge.display_name(name)}`.toLocaleLowerCase().includes(query));
});
const mention_active = computed(() => mention_members.value[Math.min(mention_index.value, mention_members.value.length - 1)]);
watch([() => room.value?.id, () => view.value.tab], () => { mention_context.value = null; });

/** Locate an @ token at a collapsed caret, excluding email addresses, code and quotes. */
function find_mention(value, start, end = start) {
  if (start !== end) return null;
  const prefix = value.slice(0, start);
  const match = prefix.match(/(?:^|[\s(（，,。；;：:])@([^\s@`，,。；;：:()（）]*)$/u);
  if (!match) return null;
  const prose = prefix.replace(/```[\s\S]*?```/g, "");
  const line = prose.split("\n").at(-1);
  if (prose.includes("```") || /^\s*>/.test(line) || line.replace(/`[^`]*`/g, "").includes("`")) return null;
  const remainder = value.slice(start).match(/^[^\s@`，,。；;：:()（）]*/u)[0];
  return { start: start - match[1].length - 1, end: start + remainder.length, query: match[1] };
}

/** Read the native caret after typing or moving through the existing draft. */
function update_mention(event) {
  const editor = prompt.value?.textareaRef;
  if (event.target !== editor || mention_composing) return;
  if (event.type === "keyup" && !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const context = find_mention(editor.value, editor.selectionStart, editor.selectionEnd);
  if (context?.query !== mention_context.value?.query || context?.start !== mention_context.value?.start) mention_index.value = 0;
  mention_context.value = context;
}

/** Replace just the active token and leave the caret ready for the next word. */
async function select_mention(name) {
  if (!mention_context.value || !mention_members.value.includes(name)) return;
  const { start, end } = mention_context.value;
  const insertion = `@${name} `;
  text.value = text.value.slice(0, start) + insertion + text.value.slice(end).replace(/^ /, "");
  mention_context.value = null;
  await nextTick();
  const editor = prompt.value?.textareaRef;
  editor?.focus();
  editor?.setSelectionRange(start + insertion.length, start + insertion.length);
}

/** Keep suggestion keys local to the editor; modified Enter is left to the editor. */
function mention_keydown(event) {
  if (event.target !== prompt.value?.textareaRef || !mention_context.value || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.key === "Escape") mention_context.value = null;
  else if (["ArrowDown", "ArrowUp"].includes(event.key) && mention_members.value.length) {
    const direction = event.key === "ArrowDown" ? 1 : -1;
    mention_index.value = (mention_members.value.indexOf(mention_active.value) + direction + mention_members.value.length) % mention_members.value.length;
    nextTick(() => mention_list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
  } else if (["Enter", "Tab"].includes(event.key) && mention_active.value) select_mention(mention_active.value);
  else return;
  event.preventDefault();
  event.stopPropagation();
}

/** Let the input method own candidate selection before reopening member suggestions. */
function mention_composition(event) {
  mention_composing = event.type === "compositionstart";
  mention_context.value = null;
  if (!mention_composing) update_mention(event);
}

/** The autocomplete never moves focus away from the draft. */
function keep_mention_focus(event) { event.preventDefault(); }

/** End a structured excerpt after complete code lines or table rows. */
function trim_preview_blocks(fragment) {
  for (const block of fragment.querySelectorAll('pre code, tbody')) {
    const range = fragment.ownerDocument.createRange();
    if (block.tagName === 'TBODY') {
      if (block.children.length <= MESSAGE_PREVIEW_TABLE_ROWS) continue;
      range.setStartAfter(block.children[MESSAGE_PREVIEW_TABLE_ROWS - 1]);
    } else {
      const lines = block.textContent.trimEnd().split('\n');
      if (lines.length <= MESSAGE_PREVIEW_CODE_LINES) continue;
      range.setStart(block.firstChild, lines.slice(0, MESSAGE_PREVIEW_CODE_LINES).join('\n').length);
    }
    range.setEnd(fragment, fragment.childNodes.length);
    range.deleteContents();
    return true;
  }
  return false;
}

/** Clip rendered text at a nearby sentence boundary while keeping valid markup. */
function build_answer_preview(message) {
  const full = { truncated: false, html: message.rendered_text };
  if (message.kind === "receipt") return full;
  const template = document.createElement("template");
  template.innerHTML = message.rendered_text;
  const clipped_blocks = trim_preview_blocks(template.content);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => node.parentElement?.closest('.katex-mathml') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const characters = [...nodes.map((node) => node.textContent).join("").trimEnd()];
  if (characters.length <= MESSAGE_PREVIEW_LENGTH) return { truncated: clipped_blocks, html: template.innerHTML };
  const prefix = characters.slice(0, MESSAGE_PREVIEW_LENGTH).join("");
  const boundary = [...prefix.matchAll(/[。！？；]\s*|[.!?;](?:\s|$)|\n/gu)].at(-1);
  const boundary_end = boundary ? boundary.index + boundary[0].length : 0;
  const natural_end = [...prefix.slice(0, boundary_end)].length >= MESSAGE_PREVIEW_MIN_LENGTH;
  let remaining = natural_end ? boundary_end : prefix.length;
  for (const node of nodes) {
    if (remaining > node.textContent.length) { remaining -= node.textContent.length; continue; }
    const range = template.content.ownerDocument.createRange();
    const formula = node.parentElement?.closest('.katex');
    const row = node.parentElement?.closest('tr');
    if (row?.previousElementSibling) range.setStartBefore(row);
    else if (row) range.setStartAfter(row);
    else if (formula) range.setStartAfter(formula.closest('.katex-display') || formula);
    else range.setStart(node, remaining);
    range.setEnd(template.content, template.content.childNodes.length);
    range.deleteContents();
    if (!natural_end && !formula && !row) node.textContent += "…";
    break;
  }
  return { truncated: true, html: template.innerHTML };
}

/** Retain failed attempts in the transcript, including after retry, refresh and conclusion. */
const failed_messages = computed(() => {
  if (free.value || view.value.query || view.value.mention_only) return [];
  return (room.value.runtime?.failures || []).map(execution => ({
    id: `execution-${execution.id}`, author: execution.participant, created_at: execution.created_at,
    failure: execution, can_retry: Boolean(view.value.access?.can_manage && bridge.can_retry_execution(execution, room.value)),
  }));
});
/** Merge execution cards without adding them to message counts, references or round navigation. */
const transcript_messages = computed(() => {
  const messages = [...view.value.messages];
  for (const failure of failed_messages.value) {
    const index = messages.findIndex(message => new Date(message.created_at) > new Date(failure.created_at)
      || (!message.failure && failure.failure.turn_id && message.turn_id === failure.failure.turn_id));
    messages.splice(index < 0 ? messages.length : index, 0, failure);
  }
  return messages;
});
/** Split continuous chronological history at local calendar boundaries. */
const message_groups = computed(() => {
  const groups = [];
  for (const message of transcript_messages.value) {
    const date = new Date(message.created_at);
    const key = date.toLocaleDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, label: date_formatter.format(date), messages: [] });
    groups.at(-1).messages.push(message);
  }
  return groups;
});

/** Preserve room-wide round boundaries while navigating filtered history. */
const navigation_groups = computed(() => {
  const groups = [];
  for (const message of view.value.messages) {
    const round = bridge.round_groups(room.value)?.findLast((item) => item.start_id <= message.id);
    const number = round?.number || 0;
    if (groups.at(-1)?.number !== number) {
      const label = number ? `第 ${number} 轮` : "未分组";
      const progress = round ? `${round.opinions ?? round.speakers.length}/${Object.keys(room.value.experts).length} 人已发言` : "尚无参与专家的观点";
      groups.push({ number, label, description: `${label} · ${round?.completed ? '已完成' : progress}`, messages: [] });
    }
    groups.at(-1).messages.push(message);
  }
  return groups;
});

const active_round = computed(() => navigation_groups.value.find((group) => group.messages.some((message) => message.id === active_message.value))?.number);
// Free rooms have no rounds, so their messages carry no round label.
const message_round_labels = computed(() => new Map(free.value ? [] : navigation_groups.value.flatMap((group) => group.messages.map((message) => [message.id, group.label]))));

/** Keep each round number beside its messages and preserve keyboard order. */
const navigation_sections = computed(() => {
  let index = 0;
  return navigation_groups.value.map((group) => ({
    number: group.number, count: group.messages.length,
    entries: [
      { key: `round-${group.number}`, round: true, number: group.number, message: group.messages[0], label: group.description, index: index++ },
      ...group.messages.map((message) => ({ key: `message-${message.id}`, round: false, message,
        label: `${group.label} · ${bridge.display_name(message.author)} 的发言 #${message.id}`, index: index++ })),
    ],
  }));
});
const navigation_entries = computed(() => navigation_sections.value.flatMap((section) => section.entries));

/** The glass top bar overlays the transcript, so readable content starts below it. */
function reading_top(element) {
  return element.getBoundingClientRect().top + (parseFloat(getComputedStyle(element).getPropertyValue("--channel-topbar-height")) || 0);
}

/** Polling follows new messages only while the reader is near the end. */
function track_scroll() {
  const element = transcript.value;
  if (!element || !element.clientHeight) return;
  follow_tail.value = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
  const bounds = element.getBoundingClientRect();
  const top = reading_top(element);
  const messages = [...element.querySelectorAll('[data-message-id]')];
  const target = messages.find((item) => Number(item.dataset.messageId) === jump_target.value);
  if (target && target.getBoundingClientRect().bottom > top && target.getBoundingClientRect().top < bounds.bottom) {
    active_message.value = jump_target.value;
    return;
  }
  jump_target.value = null;
  const current = messages.find((item) => item.getBoundingClientRect().bottom > top + READING_OFFSET);
  active_message.value = current ? Number(current.dataset.messageId) : null;
}

/** Reveal saved messages without interrupting a reader of earlier records. */
async function follow_messages() {
  await nextTick();
  if (follow_tail.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
  track_scroll();
}
watch([() => view.value.messages, pending_message, failed_messages], follow_messages, { immediate: true });
watch([() => view.value.room?.id, () => view.value.query, () => view.value.mention_only], () => {
  jump_target.value = null;
  active_message.value = null;
  reset_preview();
  follow_tail.value = true;
});
watch(() => view.value.tab, (tab) => {
  reset_preview();
  if (tab === "discussion") follow_messages();
});
watch(() => view.value.room?.id, () => expanded_answers.value.clear());

/** Expand in place; collapsing a long answer restores its visible beginning. */
async function toggle_answer(message, event) {
  const card = event.currentTarget.closest('[data-message-id]');
  const collapsing = expanded_answers.value.has(message.id);
  const scroll_position = transcript.value.scrollTop;
  follow_tail.value = false;
  if (collapsing) expanded_answers.value.delete(message.id);
  else expanded_answers.value.add(message.id);
  reset_preview();
  await nextTick();
  if (!collapsing) transcript.value.scrollTop = scroll_position;
  if (collapsing && card.getBoundingClientRect().top < reading_top(transcript.value)) {
    transcript.value.scrollTop += card.getBoundingClientRect().top - reading_top(transcript.value) - READING_OFFSET;
  }
  track_scroll();
}

/** Jump anywhere in the history while preserving the shared composer draft. */
function jump_to(id) {
  const element = transcript.value;
  const message = element?.querySelector(`[data-message-id="${id}"]`);
  if (!message) return;
  close_preview();
  jump_target.value = id;
  active_message.value = id;
  element.scrollTop += message.getBoundingClientRect().top - reading_top(element) - READING_OFFSET;
  message.focus({ preventScroll: true });
  track_scroll();
}

/** Manual scrolling resumes tracking the message at the viewport's upper edge. */
function resume_tracking(event) {
  if (event.type !== "keydown" || ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) jump_target.value = null;
}

/** One Tab stop enters the map; arrow keys can inspect every compact tick. */
function navigate_by_key(event, index) {
  const positions = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: navigation_entries.value.length - 1 };
  if (!Object.hasOwn(positions, event.key)) return;
  event.preventDefault();
  const target = Math.max(0, Math.min(positions[event.key], navigation_entries.value.length - 1));
  message_map.value.querySelectorAll('button')[target].focus({ preventScroll: true });
}

/** Reveal an entry by scrolling only the fixed navigation window. */
function reveal_navigation_entry(entry) {
  const nav = message_map.value;
  if (!nav?.clientHeight || !entry) return;
  const bounds = nav.getBoundingClientRect();
  const position = entry.getBoundingClientRect();
  if (position.top < bounds.top + NAV_EDGE_INSET) nav.scrollTop += position.top - bounds.top - NAV_EDGE_INSET;
  else if (position.bottom > bounds.bottom - NAV_EDGE_INSET) nav.scrollTop += position.bottom - bounds.bottom + NAV_EDGE_INSET;
}

/** Follow actual reading changes without undoing independent wheel browsing. */
async function reveal_reading_position() {
  await nextTick();
  reveal_navigation_entry(message_map.value?.querySelector(`[data-jump-id="${active_message.value}"]`));
}
watch(active_message, reveal_reading_position);

/** Keyboard previews use the entry's visible position after revealing it. */
function focus_preview(item, event) {
  if (navigation_press || !event.currentTarget.matches(":focus-visible")) return;
  navigation_keyboard.value = true;
  const anchor = item.round ? event.currentTarget.parentElement.querySelector('[data-jump-id]') : event.currentTarget;
  reveal_navigation_entry(anchor);
  show_preview(item, event);
}

/** Begin a touch preview only after a stationary hold, leaving native scrolling available. */
function start_navigation_press(item, event) {
  suppress_navigation_click = false;
  if (!["touch", "pen"].includes(event.pointerType)) return;
  close_preview();
  navigation_keyboard.value = false;
  const press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, target: event.currentTarget };
  navigation_press = press;
  press.timer = setTimeout(() => {
    if (navigation_press !== press) return;
    suppress_navigation_click = true;
    show_preview(item, { currentTarget: press.target });
  }, NAV_LONG_PRESS_MS);
}

/** Clear a hold when scrolling, changing views, or leaving the navigation. */
function cancel_navigation_press() {
  if (navigation_press) clearTimeout(navigation_press.timer);
  navigation_press = null;
}

/** Release the preview without turning a long press into a jump. */
function finish_navigation_press(event) {
  if (navigation_press?.pointer !== event.pointerId) return;
  if (event.type === "pointercancel") suppress_navigation_click = true;
  close_preview();
}

/** A stationary pointer must not replace a keyboard preview or bypass the touch hold. */
function hover_preview(item, event) {
  if (["touch", "pen"].includes(event.pointerType)) {
    if (navigation_press?.pointer === event.pointerId && Math.hypot(event.clientX - navigation_press.x, event.clientY - navigation_press.y) > NAV_TOUCH_SLOP) {
      suppress_navigation_click = true;
      close_preview();
    }
    return;
  }
  if (event.type === "pointerenter" && navigation_keyboard.value) return;
  navigation_keyboard.value = false;
  if (preview_entry.value !== item.key || !preview_open.value) show_preview(item, event);
}

/** Keep short taps and keyboard activation as jumps; consume the click after a hold. */
function activate_navigation(item, event) {
  if (suppress_navigation_click && event.detail !== 0) {
    suppress_navigation_click = false;
    event.preventDefault();
    return;
  }
  jump_to(item.message.id);
}

/** Keep the native touch menu from interrupting an active navigation preview. */
function navigation_context_menu(event) {
  if (navigation_press) event.preventDefault();
}

/** Native wheel scrolling changes only the navigation, with no queued animation. */
function browse_navigation(event) {
  if (!event.deltaX && !event.deltaY) return;
  navigation_keyboard.value = false;
  close_preview();
}

/** Return to the newest record and resume following newly arriving messages. */
function return_to_latest() {
  close_preview();
  jump_target.value = null;
  follow_tail.value = true;
  follow_messages();
}

/** Move the shared preview toward the entry without resetting a moving spring. */
async function show_preview(item, event) {
  const message = item.message;
  const entry = event.currentTarget.getBoundingClientRect();
  const nav = message_map.value.getBoundingClientRect();
  const width = Math.min(PREVIEW_WIDTH, innerWidth - PREVIEW_INSET * 2);
  const left = nav.right + PREVIEW_GAP;
  preview_left.value = Math.max(PREVIEW_INSET, Math.min(left, innerWidth - width - PREVIEW_INSET));
  preview_message.value = message.id;
  preview_entry.value = item.key;
  preview_is_round.value = item.round;
  preview_open.value = true;
  await nextTick();
  if (!preview_open.value || preview_entry.value !== item.key) return;
  preview_size.value = preview_content.value.scrollHeight + PREVIEW_PADDING;
  const midpoint = (Math.max(entry.top, nav.top + NAV_EDGE_INSET) + Math.min(entry.bottom, nav.bottom - NAV_EDGE_INSET)) / 2;
  const top = midpoint - preview_size.value / 2;
  preview_top.value = Math.max(PREVIEW_INSET, Math.min(top, innerHeight - preview_size.value - PREVIEW_INSET));
  const snap = reduced_motion.value || preview_visibility.get() === 0;
  preview_y[snap ? "jump" : "set"](preview_top.value);
  preview_height[snap ? "jump" : "set"](preview_size.value);
}

/** Leaving the navigation and its adjoining preview releases the same spring. */
function close_preview(event) {
  if (event?.relatedTarget?.closest?.('.channel-message-map, .channel-nav-preview')) return;
  cancel_navigation_press();
  preview_open.value = false;
}

/** A new layout or message set invalidates the previous floating coordinates. */
function reset_preview() {
  cancel_navigation_press();
  preview_open.value = false;
  preview_visibility.jump(0);
  preview_message.value = null;
}

/** Reflow changes message heights; keep tail following and the current tick in sync. */
async function refresh_layout() {
  reset_preview();
  measure_topic();
  await follow_messages();
  await reveal_reading_position();
}

/** Reuse round groups while the preview stays beyond their hover reach. */
function section_preview_position(section) {
  const last = section.entries.length - 1;
  return Math.max(-NAV_HOVER_REACH, Math.min(last + NAV_HOVER_REACH, preview_index.value - section.entries[0].index));
}

/** Nearby ticks respond by distance; the actual reading position stays distinct. */
function tick_state(item, index) {
  const distance = preview_index.value < 0 ? Infinity : Math.abs(index - preview_index.value);
  const influence = Math.max(0, 1 - distance / NAV_HOVER_REACH);
  const current = active_message.value === item.message.id;
  const selected = distance === 0 || (current && preview_index.value < 0);
  const base = NAV_TICK_WIDTH;
  return {
    scaleX: selected ? NAV_ACTIVE_WIDTH / base : current ? NAV_READING_WIDTH / base : 1 + influence * NAV_HOVER_EXTENSION / base,
    height: selected ? NAV_ACTIVE_HEIGHT : NAV_TICK_HEIGHT,
    opacity: selected ? NAV_ACTIVE_OPACITY : current ? NAV_READING_OPACITY : NAV_TICK_OPACITY + influence * NAV_HOVER_OPACITY,
  };
}

watch([preview_open, reduced_motion], () => {
  const target = preview_open.value ? 1 : 0;
  if (reduced_motion.value) { preview_visibility.jump(target); preview_y.jump(preview_top.value); preview_height.jump(preview_size.value); }
  else preview_visibility.set(target);
});
onMounted(() => window.addEventListener("resize", refresh_layout));
onBeforeUnmount(() => window.removeEventListener("resize", refresh_layout));

/** Re-fits the editor rows when its width changes; Nuxt UI only measures on mount and on input, so a draft measured while the column was narrow stays too tall. */
function fit_editor() {
  const editor = prompt.value?.textareaRef;
  if (!editor) return;
  editor.rows = 1;
  const style = getComputedStyle(editor);
  const lines = (editor.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight);
  editor.rows = Math.min(Math.max(Math.floor(lines), 1), EDITOR_MAX_ROWS);
}
let editor_width = 0;
const editor_observer = new ResizeObserver(([entry]) => {
  if (Math.round(entry.contentRect.width) === editor_width) return;
  editor_width = Math.round(entry.contentRect.width);
  fit_editor();
});
onMounted(() => prompt.value?.textareaRef && editor_observer.observe(prompt.value.textareaRef));
onBeforeUnmount(() => editor_observer.disconnect());
onBeforeUnmount(cancel_navigation_press);

const COPY_FEEDBACK_MS = 2000;
const launch_copied = ref("");
let launch_copy_timer;
/** Clear the composer copy feedback when it expires or the arrangement changes. */
function reset_launch_copy() {
  clearTimeout(launch_copy_timer);
  launch_copied.value = "";
}
/** Confirm the copy only after the clipboard write succeeds for this member in this room. */
async function copy_launch(name) {
  const room_id = room.value.id;
  reset_launch_copy();
  if (!await act("copy_member_launch", name)) return;
  if (room.value?.id !== room_id) return;
  launch_copied.value = name;
  launch_copy_timer = setTimeout(reset_launch_copy, COPY_FEEDBACK_MS);
}
watch([() => room.value?.id, () => speaking_turn.value?.id], reset_launch_copy);
onBeforeUnmount(reset_launch_copy);

/** Reuse the existing original-record actions in the message overflow menu. */
function message_actions(message) {
  return [[
    { label: "复制原文链接", icon: "i-lucide-link", onSelect: () => copy_message(message) },
    { label: "查看原文", icon: "i-lucide-expand", onSelect: () => emit("detail", message.id) },
  ]];
}

/** Select the shared reply target and focus the library's chat editor. */
async function reply_to(message) { await act("reply", message); prompt.value?.textareaRef?.focus(); }

/** Send the shared draft through the established idempotent controller. */
async function send() {
  if (!has_draft.value || pending.value || view.value.sending_message) return;
  mention_context.value = null;
  follow_tail.value = true;
  await act("send");
  await follow_messages();
}

/** The chat prompt ignores empty text, so attachment-only drafts send on Enter here. */
function attachment_shortcut(event) {
  if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.isComposing || text.value.trim()) return;
  if (!view.value.attachment_drafts.length) return;
  event.preventDefault();
  event.stopPropagation();
  send();
}

/** Copy a durable reference to the original record. */
function copy_message(message) { act("copy", `${location.origin}/r/${room.value.id}/messages/${message.id}`); }

</script>

<template>
  <section class="channel-conversation" :class="{ 'channel-has-messages': view.messages.length }" role="tabpanel" aria-label="消息">
    <div v-if="view.query || view.mention_only" class="channel-filter-summary"><span>{{ view.query ? `“${view.query}”` : `@${bridge.display_name(author)}` }} · {{ view.total }} 条结果</span><UButton label="清除筛选" size="xs" variant="link" color="neutral" @click="search = ''; act('filter', { query: '', mention: false })" /></div>
    <nav v-if="view.messages.length" ref="message_map" class="channel-message-map" :style="{ '--nav-entry-height': `${NAV_ENTRY_HEIGHT}px` }" aria-label="发言快速导航" @wheel.stop.passive="browse_navigation" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview" @contextmenu="navigation_context_menu">
      <div class="channel-map-track">
        <div v-for="section in navigation_sections" :key="section.number" v-memo="[section, reduced_motion, preview_open, active_round === section.number ? active_message : null, section_preview_position(section)]" class="channel-map-round" :style="{ '--round-message-count': section.count }">
          <button v-for="item in section.entries" :key="item.key" type="button" class="channel-navigation-entry" :class="item.round ? 'channel-round-range' : 'channel-message-jump'" :data-author="item.round ? undefined : bridge.identities[item.message.author]?.style" :data-jump-id="item.round ? undefined : item.message.id" :data-round-jump="item.round ? item.label : undefined" :aria-label="item.label" :tabindex="!item.round && item.message.id === (active_message || view.messages[0]?.id) ? 0 : -1" :aria-current="!item.round && active_message === item.message.id ? 'location' : undefined" :aria-describedby="preview_open && preview_entry === item.key ? 'channel-navigation-preview' : undefined" @pointerenter="hover_preview(item, $event)" @pointermove="hover_preview(item, $event)" @pointerdown="start_navigation_press(item, $event)" @pointerup="finish_navigation_press" @pointercancel="finish_navigation_press" @focus="focus_preview(item, $event)" @keydown="navigate_by_key($event, item.index)" @click="activate_navigation(item, $event)">
            <span v-if="item.round" class="channel-round-number" aria-hidden="true">{{ item.number || '–' }}</span>
            <motion.span v-else class="channel-jump-tick" aria-hidden="true" :initial="false" :animate="reduced_motion ? undefined : tick_state(item, item.index)" :style="reduced_motion ? tick_state(item, item.index) : undefined" :transition="NAV_SPRING" />
          </button>
        </div>
      </div>
    </nav>
    <Teleport to="body">
      <motion.div v-if="preview" id="channel-navigation-preview" class="channel-nav-preview" role="tooltip" :aria-hidden="!preview_open" :inert="!preview_open" :data-open="preview_open" :style="{ left: preview_left, y: preview_y, x: preview_x, opacity: preview_opacity, scale: preview_scale, height: preview_height, '--preview-gap': `${PREVIEW_GAP}px` }" @pointerleave="close_preview" @focusout="close_preview" @keydown.esc.stop="close_preview">
        <div ref="preview_content" class="channel-nav-preview-content">
          <h3 v-if="preview_is_round" class="channel-nav-preview-round">{{ preview_round }}</h3>
          <div class="channel-nav-preview-header">
            <UAvatar :src="bridge.identities[preview.author]?.icon" :text="bridge.identities[preview.author]?.initials || '?'" :alt="bridge.display_name(preview.author)" size="sm" class="channel-avatar" :class="bridge.identities[preview.author]?.style" />
            <strong>{{ bridge.display_name(preview.author) }}</strong><span>#{{ preview.id }}</span>
          </div>
          <div class="channel-nav-preview-meta">{{ preview_round }} · {{ bridge.sources[preview.source] }} · {{ bridge.format_time(preview.created_at) }}<span v-if="preview.kind === 'moderation'"> · 主持人</span><span v-else-if="preview.kind === 'receipt'"> · 运行回执</span></div>
          <div class="channel-nav-preview-text markdown-body" v-html="preview.summary ? preview.rendered_summary : preview.rendered_text"></div>
        </div>
      </motion.div>
    </Teleport>
    <div ref="transcript" v-memo="[message_groups, message_round_labels, active_message, expanded_answers.size, room.title, view.query, view.mention_only, topic_key, topic_expanded, topic_overflows, pending_message, pending_seconds, request_badges, execution_reports, response_suggestions, recommendations, adopting, scheduler_decisions, pending, view.free_error]" class="channel-transcript" aria-label="聊天记录" @scroll="track_scroll" @wheel.passive="resume_tracking" @touchstart.passive="resume_tracking" @keydown="resume_tracking">
      <div v-if="!view.query && !view.mention_only" class="channel-message-group channel-topic-group"><section class="channel-message channel-topic-card" :class="{ 'is-expanded': topic_expanded }" aria-label="议题">
        <header class="channel-topic-heading"><span class="channel-topic-eyebrow"><UIcon name="i-lucide-target" />议题</span><h2>{{ room.title }}</h2><UButton icon="i-lucide-pencil" label="编辑" color="neutral" variant="ghost" size="xs" @click="emit('edit')" /></header>
        <div ref="topic_body" class="channel-topic-body" :class="{ 'is-clamped': topic_overflows && !topic_expanded }">
        <div v-if="topic.request" class="channel-topic-section channel-topic-request"><h3>{{ topic.request.label }}</h3><p class="channel-topic-text">{{ topic.request.text }}</p></div>
        <div v-if="topic.goal" class="channel-topic-section"><h3>目标</h3><p class="channel-topic-text">{{ topic.goal }}</p></div>
        <div v-if="topic.boundaries" class="channel-topic-section"><h3>边界</h3><p class="channel-topic-text">{{ topic.boundaries }}</p></div>
        </div>
        <UButton v-if="topic_overflows || topic_expanded" :label="topic_expanded ? '收起' : '展开全文'" :trailing-icon="topic_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" @click="topic_expanded = !topic_expanded" />
        <div v-if="room.parent_room" class="channel-topic-section"><h3>来源</h3><p class="channel-topic-text">从自由协作「<button type="button" class="channel-link-button" @click="act('room', room.parent_room.id)">{{ room.parent_room.title }}</button>」发起<template v-if="room.phase === 'concluded'"> · <button type="button" class="channel-link-button" @click="act('return_conclusion')">把结论发回</button></template></p></div>
        <div class="channel-topic-section channel-topic-config"><h3>参与配置</h3><div class="channel-topic-people">
          <span v-for="person in topic.experts" :key="person.name" class="channel-topic-person"><UAvatar :src="bridge.identities[person.name]?.icon" :text="bridge.identities[person.name]?.initials" :alt="person.name" size="2xs" class="channel-avatar" :class="bridge.identities[person.name]?.style" />{{ bridge.display_name(person.name) }}<small>{{ person.name === topic.host ? `主持 · ${person.mode}` : person.mode }}</small></span>
          <span v-if="free || topic.host === '用户'" class="channel-topic-person">{{ bridge.display_name('用户') }}<small>{{ free ? '需求方' : '主持' }}</small></span>
        </div><small class="channel-topic-bounds">{{ topic.bounds }}</small></div>
      </section></div>
      <!-- The opening plan has no answer to follow, so it stands right under the topic. -->
      <div v-if="host_arrangements.get(0)?.length" class="channel-message-group">
        <ScheduleCard v-for="plan in host_arrangements.get(0)" :key="`arrangement-${plan.id}`" icon="i-lucide-list-ordered" plain :title="`${bridge.display_name(room.host)} 创建的发言安排`" label="主持人安排" toggle-label="展开或收起各专家的任务">
          <template #text>主持人安排：{{ plan.label }}</template>
          <p v-for="turn in plan.turns" :key="`${plan.id}-${turn.expert}-${turn.question}`"><span>{{ bridge.display_name(turn.expert) }}：{{ turn.question }}</span></p>
        </ScheduleCard>
      </div>
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <template v-for="message in group.messages" :key="message.id">
        <section v-if="message.failure" :id="message.id" class="channel-message channel-failed-execution" :data-author="bridge.identities[message.author]?.style" :aria-label="`${bridge.display_name(message.author)} 执行失败`">
          <div class="channel-message-byline">
            <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
            <div class="channel-message-meta">
              <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span v-if="message.failure.role === 'host'" class="channel-message-round">主持工作</span><UBadge label="执行失败" color="error" variant="soft" size="xs" /></div>
              <div class="channel-message-provenance"><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time><span>执行 #{{ message.failure.id }}</span><span v-if="message.failure.turn_id">安排 #{{ message.failure.turn_id }}</span></div>
            </div>
            <span v-if="message.failure.elapsed_seconds != null" class="channel-message-provenance channel-message-elapsed">耗时 {{ format_elapsed(message.failure.elapsed_seconds) }}</span>
          </div>
          <p class="channel-message-text channel-failure-reason">{{ message.failure.result || '执行失败，未提供原因' }}</p>
          <div v-if="message.can_retry" class="channel-failure-actions">
            <UButton label="重试" icon="i-lucide-rotate-ccw" size="sm" variant="soft" color="primary" :aria-label="`重试 ${bridge.display_name(message.author)} 的失败执行`" :loading="pending === 'retry_execution'" :disabled="!!pending" @click="act('retry_execution', message.failure.id)" />
            <p v-if="view.free_error" class="channel-failure-error" role="alert">{{ view.free_error }}</p>
          </div>
        </section>
        <template v-else>
        <UChatMessage :id="String(message.id)" v-memo="[message, view.admin?.identity_version, message_round_labels.get(message.id), expanded_answers.has(message.id), active_message === message.id, waits_for_host(message), request_badges.get(message.id), execution_reports.get(message.id), response_suggestions.get(message.id), recommendations.get(message.id), adopting === message.id]" :data-message-id="message.id" :data-author="bridge.identities[message.author]?.style" tabindex="-1" :role="message.author === '用户' ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :class="{ 'channel-current-message': active_message === message.id }" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-message-round">{{ message_round_labels.get(message.id) }}</span><UBadge size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'moderation'" size="xs" color="neutral" variant="soft" class="channel-source">主持人</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">运行回执</UBadge><UBadge v-if="waits_for_host(message)" size="xs" color="warning" variant="soft" class="channel-source" :title="speaking_turn ? `${bridge.display_name(speaking_turn.expert)} 说完后交给主持人处理` : '等待主持人处理'">待主持人处理</UBadge><UBadge v-for="badge in request_badges.get(message.id) || []" :key="badge.key" size="xs" :color="badge.color" variant="soft" class="channel-source" :title="badge.title">{{ badge.label }}</UBadge></div>
                <div class="channel-message-provenance"><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="`查看原文 #${message.id}`" class="channel-message-id" @click="emit('detail', message.id)" /><span v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')">{{ bridge.display_name(message.submitted_by) }} 代发</span><span v-if="message.turn_id">回答安排 #{{ message.turn_id }}</span></div>
              </div>
              <span v-if="message_elapsed(message) !== null" class="channel-message-provenance channel-message-elapsed">耗时 {{ format_elapsed(message_elapsed(message)) }}</span>
            </div>
            <UButton v-if="message.reply_to" :label="`回复 #${message.reply_to}`" icon="i-lucide-corner-up-left" variant="link" color="neutral" size="xs" class="channel-message-reference" :aria-label="`回复 #${message.reply_to} 查看原文`" @click="emit('detail', message.reply_to)" />
            <details v-if="message.kind === 'receipt'" class="channel-receipt">
              <summary :aria-label="`查看运行回执 #${message.id}`">运行回执详情</summary>
              <div class="channel-message-text markdown-body" v-html="message.rendered_text"></div>
            </details>
            <div v-else class="channel-answer">
              <div :id="`channel-answer-${message.id}`" class="channel-message-text markdown-body" v-html="expanded_answers.has(message.id) ? message.rendered_text : answer_previews.get(message.id).html"></div>
              <UButton v-if="answer_previews.get(message.id).truncated" :label="expanded_answers.has(message.id) ? '收起' : '展开全文'" :trailing-icon="expanded_answers.has(message.id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" :aria-label="`${expanded_answers.has(message.id) ? '收起回答' : '展开完整回答'} #${message.id}`" :aria-expanded="expanded_answers.has(message.id)" :aria-controls="`channel-answer-${message.id}`" @click="toggle_answer(message, $event)" />
            </div>
            <div v-if="message.summary" class="channel-answer-summary"><small>回答摘要<span v-if="message.summary_by && message.summary_by !== message.author"> · {{ bridge.display_name(message.summary_by) }} 整理</span></small><div class="channel-message-text markdown-body" v-html="message.rendered_summary"></div></div>
            <div v-if="message.attachments?.length" v-html="bridge.attachment_markup(message.attachments)"></div>
            <div v-if="recommendations.get(message.id)" class="channel-recommendation" :class="`is-${recommendations.get(message.id).status}`" aria-label="智能调度推荐" aria-live="polite">
              <template v-for="item in [recommendations.get(message.id)]" :key="item.message_id">
                <UIcon name="i-lucide-zap" class="channel-recommendation-icon" />
                <span v-if="item.status === 'open'">智能调度建议让 <strong>{{ bridge.display_name(item.member) }}</strong> 回答<small :title="`${item.label}，置信度 ${Number(item.confidence).toFixed(2)}`">置信度 {{ Number(item.confidence).toFixed(2) }} · {{ item.remaining }} 秒</small></span>
                <span v-else-if="item.status === 'waiting'">已采纳：主持人答完后请 {{ bridge.display_name(item.member) }} 回答</span>
                <span v-else>已采纳：{{ item.mode === 'interrupt' ? `已打断主持人，改由 ${bridge.display_name(item.member)} 回答` : `已请 ${bridge.display_name(item.member)} 回答` }}</span>
                <template v-if="item.can_adopt">
                  <UButton v-if="adopting !== item.message_id" label="采纳" icon="i-lucide-check" size="xs" variant="soft" color="primary" :aria-label="`采纳建议，请 ${item.member} 回答 #${item.message_id}`" @click="item.host_busy ? adopting = item.message_id : adopt(item.message_id, 'after')" />
                  <template v-else>
                    <UButton :label="`打断主持人，改由 ${bridge.display_name(item.member)} 回答`" size="xs" variant="soft" color="warning" @click="adopt(item.message_id, 'interrupt')" />
                    <UButton :label="`主持人答完后再请 ${bridge.display_name(item.member)}`" size="xs" variant="soft" color="neutral" @click="adopt(item.message_id, 'after')" />
                    <UButton icon="i-lucide-x" aria-label="取消采纳" size="xs" variant="ghost" color="neutral" @click="adopting = 0" />
                  </template>
                </template>
              </template>
            </div>
            <div v-if="free && message.suggestions?.length" class="channel-response-suggestions" aria-label="回应建议">
              <div v-for="suggestion in response_suggestions.get(message.id) || []" :key="suggestion.member_id">
                <span>建议请 {{ bridge.display_name(suggestion.member) }} 回应</span>
                <span v-if="suggestion.request_id">已转请求 #{{ suggestion.request_id }}</span>
                <span v-else-if="suggestion.status !== 'active'">成员已离开</span>
                <UButton v-else-if="view.access?.can_manage && !room.archived" label="转为请求" icon="i-lucide-send" size="xs" variant="soft" color="neutral" :disabled="!suggestion.can_convert" :aria-label="`请 ${suggestion.member} 回应 #${message.id}`" @click="act('convert_suggestion', { message_id: message.id, member_id: suggestion.member_id })" />
              </div>
            </div>
            <section v-for="report in execution_reports.get(message.id) || []" :key="report.id" class="channel-execution-report" :aria-label="`执行报告 #${report.id}`">
              <div><strong>执行 #{{ report.id }} · {{ report.label }}</strong><span>{{ format_elapsed(report.seconds) }}</span></div>
              <p>请求 {{ report.request_ids.map((id) => `#${id}`).join('、') }}</p>
              <p>工作区观察：{{ report.files_text }}</p>
              <p v-if="report.status !== 'completed' && report.result">{{ report.result }}</p>
            </section>
          </template>
          <template #header><div class="channel-message-actions"><div class="channel-message-toolbar">
            <UTooltip text="回复"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="`回复 #${message.id}`" @click="reply_to(message)" /></UTooltip>
            <UDropdownMenu :items="message_actions(message)" :content="{ align: 'end', sideOffset: 5 }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="`消息 #${message.id} 的更多操作`" /></UDropdownMenu>
          </div></div></template>
        </UChatMessage>
        <!-- A decision stands between the card that ended the round and the next speaker. -->
        <ScheduleCard v-for="decision in scheduler_decisions.get(message.id) || []" :key="`decision-${decision.id}`" icon="i-lucide-zap" :skipped="!decision.applied" :title="decision.title" label="智能调度决策" toggle-label="展开或收起判断详情" :expandable="Boolean(decision.detail?.length)">
          <template #text>智能调度：{{ decision.label }}<small v-if="decision.confidence !== null">置信度 {{ Number(decision.confidence).toFixed(2) }}</small><small v-if="decision.detail?.[0]?.duration_ms != null">耗时 {{ format_ms(decision.detail[0].duration_ms) }}</small></template>
          <p v-for="(item, index) in decision.detail" :key="index"><span>问：{{ item.question }}（{{ item.choices.map(option_name).join(" / ") }}）</span><span>答：{{ item.choice ? option_name(item.choice) : "无" }}<small v-if="item.probabilities[item.choice] !== undefined">概率 {{ Number(item.probabilities[item.choice]).toFixed(2) }}</small></span></p>
        </ScheduleCard>
        <ScheduleCard v-for="plan in host_arrangements.get(message.id) || []" :key="`arrangement-${plan.id}`" icon="i-lucide-list-ordered" plain :title="`${bridge.display_name(room.host)} 创建的发言安排`" label="主持人安排" toggle-label="展开或收起各专家的任务">
          <template #text>主持人安排：{{ plan.label }}<small>耗时 {{ format_elapsed(arrangement_seconds(plan, message)) }}</small></template>
          <p v-for="turn in plan.turns" :key="`${plan.id}-${turn.expert}-${turn.question}`"><span>{{ bridge.display_name(turn.expert) }}：{{ turn.question }}</span></p>
        </ScheduleCard>
        <!-- A cancelled assignment keeps the card that waited for it, marked as missed. -->
        <UChatMessage v-for="turn in cancelled_turns.get(message.id) || []" :key="`cancelled-${turn.id}`" :id="`turn-${turn.id}`" :data-author="bridge.identities[turn.expert]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[turn.expert]?.icon" :text="bridge.identities[turn.expert]?.initials || '?'" :alt="bridge.display_name(turn.expert)" size="md" class="channel-avatar" :class="bridge.identities[turn.expert]?.style" />
              <div class="channel-message-meta"><div class="channel-message-author"><strong>{{ bridge.display_name(turn.expert) }}</strong></div></div>
              <span class="channel-message-provenance channel-message-elapsed">已错过 · 安排 #{{ turn.id }}</span>
            </div>
            <div class="channel-message-text" role="status">本次发言已被跳过或取消，未回答。</div>
          </template>
        </UChatMessage>
        </template>
        </template>
      </div>
      <div v-if="pending_message" class="channel-message-group">
        <ScheduleCard v-if="pending_message.is_host" :id="`execution-${pending_message.id}`" icon="i-lucide-list-ordered" plain :expandable="false" :label="`${bridge.display_name(pending_message.author)} 主持工作`">
          <template #text><span role="status" :aria-label="`${bridge.display_name(pending_message.author)} ${pending_message.text}`">{{ bridge.display_name(pending_message.author) }} 主持工作：<span ref="reply_glow" class="channel-reply-glow">{{ pending_message.text }}</span></span><small>已用 {{ pending_duration }}</small></template>
        </ScheduleCard>
        <UChatMessage v-else :id="`execution-${pending_message.id}`" :data-author="bridge.identities[pending_message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[pending_message.author]?.icon" :text="bridge.identities[pending_message.author]?.initials || '?'" :alt="bridge.display_name(pending_message.author)" size="md" class="channel-avatar" :class="bridge.identities[pending_message.author]?.style" />
              <div class="channel-message-meta"><div class="channel-message-author"><strong>{{ bridge.display_name(pending_message.author) }}</strong><span v-if="pending_message.round" class="channel-message-round">{{ pending_message.round }}</span></div></div>
              <span class="channel-message-provenance channel-message-elapsed">{{ pending_message.manual ? '手动启动' : `已用 ${pending_duration}` }}</span>
            </div>
            <div class="channel-message-text" role="status" :aria-label="`${bridge.display_name(pending_message.author)} ${pending_message.text}`"><span v-if="pending_message.manual">{{ pending_message.text }}</span><span v-else ref="reply_glow" class="channel-reply-glow">{{ pending_message.text }}</span></div>
          </template>
        </UChatMessage>
      </div>
      <div v-if="!transcript_messages.length && !pending_message" class="channel-empty"><UIcon :name="view.query || view.mention_only ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view.query || view.mention_only ? '没有找到消息' : room.title }}</h2><p>{{ view.query || view.mention_only ? '试试其他关键词，或清除筛选。' : bridge.empty_discussion_message(room) }}</p></div>
    </div>
    <div v-if="(transcript_messages.length || pending_message) && !follow_tail" class="channel-latest-dock"><UButton icon="i-lucide-arrow-down" color="neutral" variant="outline" aria-label="回到最新消息" class="channel-latest-button" @click="return_to_latest" /></div>
    <div class="channel-composer-dock"><div class="channel-composer-column" @dragover="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments" @keydown.capture="mention_keydown($event); attachment_shortcut($event)" @input="update_mention" @click="update_mention" @keyup="update_mention" @select="update_mention" @compositionstart="mention_composition" @compositionend="mention_composition" @scroll.capture="sync_mirror">
      <UPopover :open="!!mention_context" :reference="prompt?.$el" :content="{ side: 'top', align: 'start', sideOffset: 8, onOpenAutoFocus: keep_mention_focus, onCloseAutoFocus: keep_mention_focus }" :ui="{ content: 'channel-select-menu channel-mention-menu' }" @update:open="!$event && (mention_context = null)">
        <template #content>
          <div class="channel-mention-heading"><span>选择成员</span><small>↑↓ 选择 · Enter 确认</small></div>
          <div id="channel-mention-list" ref="mention_list" role="listbox" aria-label="选择成员" class="channel-mention-list">
            <button v-for="(name, index) in mention_members" :id="`channel-mention-${index}`" :key="name" type="button" role="option" :aria-selected="name === mention_active" tabindex="-1" class="channel-mention-option" @pointerdown.prevent @click="select_mention(name)" @pointermove="mention_index = index">
              <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="bridge.display_name(name)" size="xs" :class="['channel-avatar', bridge.identities[name]?.style]" />
              <span>{{ bridge.display_name(name) }}</span><small>@{{ name }}</small>
            </button>
            <p v-if="!mention_members.length" class="channel-mention-empty">没有匹配的成员</p>
          </div>
        </template>
      </UPopover>
      <UChatPrompt ref="prompt" v-model="text" :disabled="view.sending_message" :submit-on-enter="true" :autofocus="false" :rows="1" :maxrows="EDITOR_MAX_ROWS" :placeholder="`发消息到 # ${room.title}`" aria-label="留言正文" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" :aria-expanded="!!mention_context" :aria-controls="mention_context ? 'channel-mention-list' : undefined" :aria-activedescendant="mention_context && mention_active ? `channel-mention-${mention_members.indexOf(mention_active)}` : undefined" variant="outline" color="neutral" class="channel-composer" :class="{ 'has-mentions': mention_mirror }" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="send">
        <template #header>
          <div v-if="view.attachment_drafts.length" class="attachment-drafts">
            <div v-for="file in view.attachment_drafts" :key="file.id" :class="file.preview_url ? 'attachment-draft-image' : 'attachment-draft-file'">
              <img v-if="file.preview_url" :src="file.preview_url" :alt="file.file_name" :title="file.file_name">
              <template v-else>
                <span v-html="bridge.attachment_file_icon(file.file_name)"></span>
                <span class="attachment-name"><span :title="file.file_name">{{ file.file_name }}</span><small>{{ bridge.attachment_size(file.size) }}</small></span>
              </template>
              <button type="button" class="attachment-remove" :aria-label="`移除 ${file.file_name}`" :disabled="view.sending_message" @click="act('remove_attachment', file.id)"><UIcon name="i-lucide-x" /></button>
            </div>
          </div>
          <p v-if="view.composer_error || view.upload_status" class="attachment-status" :role="view.composer_error ? 'alert' : 'status'">{{ view.composer_error || view.upload_status }}</p>
          <div v-if="unregistered_member" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-user-round-x" /><span>{{ bridge.display_name(unregistered_member.name) }} 尚未注册：需把启动指令粘贴到其 AI 会话，由它自己注册后才算到场</span><UButton v-if="view.access?.can_manage" :icon="launch_copied === unregistered_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === unregistered_member.name ? '已复制' : '复制启动指令'" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(unregistered_member.name)" /></div>
          <div v-if="queue_hint" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-clock" /><span>{{ queue_hint }}</span><UButton v-if="is_manual_member(speaking_member) && view.access?.can_manage" :icon="launch_copied === speaking_member.name ? 'i-lucide-check' : 'i-lucide-copy'" :label="launch_copied === speaking_member.name ? '已复制' : '复制启动指令'" aria-live="polite" size="xs" color="neutral" variant="ghost" class="channel-launch-copy" @click="copy_launch(speaking_member.name)" /></div>
          <div v-if="view.reply_to || view.turn_reply_to" class="channel-reply-draft"><UIcon name="i-lucide-corner-up-left" /><span>{{ view.turn_reply_to ? `回答安排 #${view.turn_reply_to} · ${bridge.display_name(room.host)} 代发` : `回复 #${view.reply_to}` }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="view.turn_reply_to ? '取消关联安排' : '取消回复'" @click="act(view.turn_reply_to ? 'cancel_answer' : 'cancel_reply')" /></div>
          <div v-if="needs_summary" class="channel-answer-editor"><UTextarea v-model="answer_summary" :rows="2" aria-label="回答摘要" class="w-full" placeholder="先说结论，保留关键理由、条件和不确定性。完整内容写在正文中。" /><USelect v-model="summary_source" :items="summary_sources" aria-label="摘要提供者" size="xs" /></div>
        </template>
        <div v-if="mention_mirror" ref="mirror" class="channel-editor channel-editor-mirror" aria-hidden="true" v-html="mention_mirror"></div>
        <template #footer>
          <UButton type="button" icon="i-lucide-paperclip" aria-label="添加附件" title="图片、PDF 或其他文件 · 每个最多 20 MiB" color="neutral" variant="ghost" size="sm" :disabled="view.sending_message" @click="act('choose_attachments')" />
          <div v-if="free_online.length" class="channel-free-recipients" role="group" aria-label="代发在线成员的回答">
            <span>代发</span>
            <button v-for="member in free_online" :key="member.id" type="button" :aria-pressed="view.free_proxy === member.name" :class="{ 'is-on': view.free_proxy === member.name }" @click="act('set_proxy', member.name)">{{ bridge.display_name(member.name) }}</button>
          </div>
          <div v-if="!free" class="channel-composer-identity">
            <USelectMenu v-model="author" :items="identities" value-key="value" :avatar="selected_identity?.avatar" :disabled="kind === 'moderation'" :search-input="{ placeholder: '搜索身份…', icon: 'i-lucide-search' }" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言身份" class="channel-author-select" :ui="{ content: 'channel-select-menu channel-identity-menu', itemLeadingAvatarSize: 'xs' }" />
            <USelect v-model="kind" :items="kinds" :icon="kinds.find((item) => item.value === kind)?.icon" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言职责" class="channel-kind-select" :ui="{ content: 'channel-select-menu' }" />
          </div>
          <UButton type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" aria-label="发送" title="发送 · Enter" :disabled="!has_draft || (needs_summary && !answer_summary.trim())" :loading="pending === 'send' || view.sending_message" @click="send" />
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span v-if="free">{{ recipient_hint }}<span class="channel-note-divider">·</span>手动成员需在原会话触发</span><span v-else>{{ author_note }}<template v-if="asked_names.length"><span class="channel-note-divider">·</span>直接提问 {{ asked_names.join("、") }}，不计轮次</template><span class="channel-note-divider">·</span>在线 AI 的观点需代发</span><span class="channel-draft-length"><span v-if="text_length" :class="{ 'is-near-limit': near_length_limit }">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span></span><span class="channel-key-hint"><kbd>Enter</kbd> 发送<span class="channel-note-divider">·</span><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span></span></div>
    </div></div>
  </section>
</template>

<style scoped>
.channel-free-recipients { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-width: 0; font-size: 12px; color: var(--ui-text-muted); }
.channel-free-recipients button { min-height: 24px; padding: 0 8px; border: 1px solid transparent; border-radius: 4px; color: var(--ui-text-muted); transition: background .12s, color .12s; }
.channel-free-recipients button:hover { background: #ffffff0d; color: var(--ui-text-highlighted); }
.channel-free-recipients button.is-on { border-color: color-mix(in srgb, var(--channel-accent) 40%, transparent); background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
.channel-link-button { color: var(--channel-accent); text-decoration: underline; text-underline-offset: 2px; }
.channel-message-elapsed { align-self: center; margin-left: auto; white-space: nowrap; }
.channel-reply-glow { display: inline-block; max-width: 100%; }
@media (prefers-reduced-motion: no-preference) {
  .channel-reply-glow.is-glowing {
    background-image: linear-gradient(90deg,
      color-mix(in srgb, currentColor 76%, transparent) 40%,
      currentColor 50%,
      color-mix(in srgb, currentColor 76%, transparent) 60%);
    background-size: 250% 100%;
    background-position: var(--reply-glow-position, 100%) 0;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
}
</style>

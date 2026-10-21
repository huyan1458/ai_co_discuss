<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, useReducedMotion, useSpring, useTransform } from "motion-v";

const emit = defineEmits(["detail", "edit"]);
const topic_expanded = ref(false);
const topic_body = ref(null);
const topic_overflows = ref(false);
const TOPIC_BODY_MAX_HEIGHT = 240;
const { view, bridge, field, act, pending } = inject("discussion");
const text = field("message-input");
const text_length = computed(() => [...text.value].length);
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
  const experts = Object.entries(value.experts || {}).map(([name, mode]) => ({ name, mode: mode === "cli" ? "CLI" : "在线" }));
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
/** Active members a free-room message can name; chips appear only when there is a choice. */
const free_members = computed(() => free.value ? (room.value.free?.members || []).filter((member) => member.status === "active") : []);
const free_host = computed(() => free_members.value.find((member) => member.role === "host"));
const free_online = computed(() => free_members.value.filter((member) => member.access === "online"));
/** A chip is on when clicked or when the draft @mentions that member outside code. */
const MENTION_PATTERN = (name) => new RegExp(`(^|[\\s(（，,。；;：:])@${name}(?![\\w-])`, "u");
const draft_prose = computed(() => text.value.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, ""));
const recipient_on = (name) => view.value.free_to.includes(name) || MENTION_PATTERN(name).test(draft_prose.value);
const FREE_REQUEST_LABELS = { pending: ["待投递", "neutral"], delivering: ["处理中", "info"], completed: ["已回复", "success"],
  cancelled: ["已停止", "neutral"], failed: ["失败", "error"] };
/** Each user message in a free room shows what happened to its request for every named member. */
const request_badges = computed(() => {
  const badges = new Map();
  if (!free.value) return badges;
  const failures = new Map((room.value.free?.members || []).map((member) => [member.execution?.id, member.execution?.result]));
  for (const request of room.value.free?.requests || []) {
    const [label, color] = FREE_REQUEST_LABELS[request.status];
    const title = request.status === "failed" ? failures.get(request.execution_id) || "执行失败" : "";
    badges.set(request.message_id, [...(badges.get(request.message_id) || []),
      { key: request.id, label: `${bridge.display_name(request.member)} · ${label}`, color, title }]);
  }
  return badges;
});
/** Show only a live automatic execution; assignments alone are not evidence of a reply in progress. */
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
  if (!execution) return null;
  const latest_round = value.rounds?.at(-1);
  const round = latest_round?.completed === false || execution.role === "host"
    ? latest_round?.number : (value.completed_rounds || 0) + 1;
  const timing = runtime.timings?.items.find((item) => item.id === execution.id);
  const is_host = execution.role === "host";
  const text = is_host ? (execution.status === "dispatched" ? "正在唤醒主持人…" : "正在安排下一步…")
    : (execution.status === "dispatched" ? "正在唤醒…" : "正在准备回复…");
  return { id: execution.id, author: execution.participant, is_host,
    round: round ? `第 ${round} 轮` : "", text,
    seconds: timing?.wake_seconds == null ? null : timing.wake_seconds + (timing.work_seconds || 0) };
});
/** A user's message is waiting for the host while it is at or after the relay hold. */
const waits_for_host = (message) => message.author === "用户" && room.value?.held_since > 0 && message.id >= room.value.held_since;
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
const identities = computed(() => Object.entries(bridge.identities).map(([name, identity]) => ({
  label: bridge.display_name(name), value: name,
  avatar: { src: identity.icon, text: identity.initials, alt: bridge.display_name(name), class: `channel-avatar ${identity.style}` },
  description: name === "用户" ? "发起与协助" : room.value?.experts?.[name] === "cli" ? "本地 CLI · 读写" : room.value?.experts?.[name] === "online" ? "在线 AI · 只读" : "未配置参与方式",
})));
const selected_identity = computed(() => identities.value.find((item) => item.value === author.value));
const kinds = [{ label: "运行回执", value: "receipt" }, { label: "普通发言 / 代发", value: "opinion", icon: "i-lucide-message-square" }, { label: "主持发言", value: "moderation", icon: "i-lucide-list-checks" }, { label: "主持人代发", value: "forward", icon: "i-lucide-forward" }];
const date_formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const author_note = computed(() => kind.value === "receipt" ? "运行回执，由用户录入" : kind.value === "forward" ? `${bridge.display_name(room.value.host)} 代发` : kind.value === "moderation" ? "主持发言" : author.value === "用户" ? "本人发言" : `代发 ${author.value} 的观点`);

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

/** Split continuous chronological history at local calendar boundaries. */
const message_groups = computed(() => {
  const groups = [];
  for (const message of view.value.messages) {
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
    const round = room.value.rounds?.findLast((item) => item.start_id <= message.id);
    const number = round?.number || 0;
    if (groups.at(-1)?.number !== number) {
      const label = number ? `第 ${number} 轮` : "未分组";
      const progress = round ? `${round.speakers.length}/${Object.keys(room.value.experts).length} 人已发言` : "尚无参与专家的观点";
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

/** Polling follows new messages only while the reader is near the end. */
function track_scroll() {
  const element = transcript.value;
  if (!element || !element.clientHeight) return;
  follow_tail.value = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
  const bounds = element.getBoundingClientRect();
  const messages = [...element.querySelectorAll('[data-message-id]')];
  const target = messages.find((item) => Number(item.dataset.messageId) === jump_target.value);
  if (target && target.getBoundingClientRect().bottom > bounds.top && target.getBoundingClientRect().top < bounds.bottom) {
    active_message.value = jump_target.value;
    return;
  }
  jump_target.value = null;
  const current = messages.find((item) => item.getBoundingClientRect().bottom > bounds.top + READING_OFFSET);
  active_message.value = current ? Number(current.dataset.messageId) : null;
}

/** Reveal saved messages without interrupting a reader of earlier records. */
async function follow_messages() {
  await nextTick();
  if (follow_tail.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
  track_scroll();
}
watch([() => view.value.messages, pending_message], follow_messages, { immediate: true });
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
  if (collapsing && card.getBoundingClientRect().top < transcript.value.getBoundingClientRect().top) {
    transcript.value.scrollTop += card.getBoundingClientRect().top - transcript.value.getBoundingClientRect().top - READING_OFFSET;
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
  element.scrollTop += message.getBoundingClientRect().top - element.getBoundingClientRect().top - READING_OFFSET;
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
onBeforeUnmount(cancel_navigation_press);

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
  if ((!text.value.trim() && !view.value.attachment_drafts.length) || pending.value || view.value.sending_message) return;
  follow_tail.value = true;
  await act("send");
  await follow_messages();
}

/** Let attachment-only drafts use the same shortcut as text messages. */
function attachment_shortcut(event) {
  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.isComposing || text.value.trim()) return;
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
    <div ref="transcript" v-memo="[message_groups, message_round_labels, active_message, expanded_answers.size, room.title, view.query, view.mention_only, topic_key, topic_expanded, topic_overflows, pending_message, pending_seconds, request_badges]" class="channel-transcript" aria-label="聊天记录" @scroll="track_scroll" @wheel.passive="resume_tracking" @touchstart.passive="resume_tracking" @keydown="resume_tracking">
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
          <span v-if="topic.host === '用户'" class="channel-topic-person">{{ bridge.display_name('用户') }}<small>主持</small></span>
        </div><small class="channel-topic-bounds">{{ topic.bounds }}</small></div>
      </section></div>
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <UChatMessage v-for="message in group.messages" :id="String(message.id)" :key="message.id" v-memo="[message, message_round_labels.get(message.id), expanded_answers.has(message.id), active_message === message.id, waits_for_host(message), request_badges.get(message.id)]" :data-message-id="message.id" :data-author="bridge.identities[message.author]?.style" tabindex="-1" :role="message.author === '用户' ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :class="{ 'channel-current-message': active_message === message.id }" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[message.author]?.icon" :text="bridge.identities[message.author]?.initials || '?'" :alt="bridge.display_name(message.author)" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" />
              <div class="channel-message-meta">
                <div class="channel-message-author"><strong>{{ bridge.display_name(message.author) }}</strong><span class="channel-message-round">{{ message_round_labels.get(message.id) }}</span><UBadge size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'moderation'" size="xs" color="neutral" variant="soft" class="channel-source">主持人</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">运行回执</UBadge><UBadge v-if="waits_for_host(message)" size="xs" color="warning" variant="soft" class="channel-source" :title="speaking_turn ? `${bridge.display_name(speaking_turn.expert)} 说完后交给主持人处理` : '等待主持人处理'">待主持人处理</UBadge><UBadge v-for="badge in request_badges.get(message.id) || []" :key="badge.key" size="xs" :color="badge.color" variant="soft" class="channel-source" :title="badge.title">{{ badge.label }}</UBadge></div>
                <div class="channel-message-provenance"><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="`查看原文 #${message.id}`" class="channel-message-id" @click="emit('detail', message.id)" /><span v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')">{{ bridge.display_name(message.submitted_by) }} 代发</span><span v-if="message.turn_id">回答安排 #{{ message.turn_id }}</span></div>
              </div>
              <span class="channel-message-provenance channel-message-elapsed">耗时 {{ format_elapsed(message.elapsed_seconds) }}</span>
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
          </template>
          <template #header><div class="channel-message-actions"><div class="channel-message-toolbar">
            <UTooltip text="回复"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="`回复 #${message.id}`" @click="reply_to(message)" /></UTooltip>
            <UDropdownMenu :items="message_actions(message)" :content="{ align: 'end', sideOffset: 5 }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :aria-label="`消息 #${message.id} 的更多操作`" /></UDropdownMenu>
          </div></div></template>
        </UChatMessage>
      </div>
      <div v-if="pending_message" class="channel-message-group">
        <section v-if="pending_message.is_host" :id="`execution-${pending_message.id}`" class="channel-host-work" :aria-label="`${bridge.display_name(pending_message.author)} 主持工作`">
          <UAvatar :src="bridge.identities[pending_message.author]?.icon" :text="bridge.identities[pending_message.author]?.initials || '?'" :alt="bridge.display_name(pending_message.author)" size="md" class="channel-avatar" :class="bridge.identities[pending_message.author]?.style" />
          <div class="channel-host-work-heading"><strong>{{ bridge.display_name(pending_message.author) }}</strong><span>主持工作</span></div>
          <span class="channel-host-work-elapsed">已用 {{ pending_duration }}</span>
          <p class="channel-host-work-status" role="status" :aria-label="`${bridge.display_name(pending_message.author)} ${pending_message.text}`"><span ref="reply_glow" class="channel-reply-glow">{{ pending_message.text }}</span></p>
        </section>
        <UChatMessage v-else :id="`execution-${pending_message.id}`" :data-author="bridge.identities[pending_message.author]?.style" role="assistant" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
          <template #body>
            <div class="channel-message-byline">
              <UAvatar :src="bridge.identities[pending_message.author]?.icon" :text="bridge.identities[pending_message.author]?.initials || '?'" :alt="bridge.display_name(pending_message.author)" size="md" class="channel-avatar" :class="bridge.identities[pending_message.author]?.style" />
              <div class="channel-message-meta"><div class="channel-message-author"><strong>{{ bridge.display_name(pending_message.author) }}</strong><span v-if="pending_message.round" class="channel-message-round">{{ pending_message.round }}</span></div></div>
              <span class="channel-message-provenance channel-message-elapsed">已用 {{ pending_duration }}</span>
            </div>
            <div class="channel-message-text" role="status" :aria-label="`${bridge.display_name(pending_message.author)} ${pending_message.text}`"><span ref="reply_glow" class="channel-reply-glow">{{ pending_message.text }}</span></div>
          </template>
        </UChatMessage>
      </div>
      <div v-if="!view.messages.length && !pending_message" class="channel-empty"><UIcon :name="view.query || view.mention_only ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view.query || view.mention_only ? '没有找到消息' : room.title }}</h2><p>{{ view.query || view.mention_only ? '试试其他关键词，或清除筛选。' : bridge.empty_discussion_message(room) }}</p></div>
    </div>
    <div v-if="(view.messages.length || pending_message) && !follow_tail" class="channel-latest-dock"><UButton icon="i-lucide-arrow-down" color="neutral" variant="outline" aria-label="回到最新消息" class="channel-latest-button" @click="return_to_latest" /></div>
    <div class="channel-composer-dock"><div class="channel-composer-column" @dragover="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments" @keydown.capture="attachment_shortcut">
      <UChatPrompt ref="prompt" v-model="text" :disabled="view.sending_message" :submit-on-enter="false" :autofocus="false" :rows="1" :maxrows="6" :placeholder="`发消息到 # ${room.title}`" aria-label="留言正文" variant="outline" color="neutral" class="channel-composer" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="send">
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
          <div v-if="free_online.length" class="channel-free-recipients" role="group" aria-label="代发在线成员的回答">
            <span>代发</span>
            <button v-for="member in free_online" :key="member.id" type="button" :aria-pressed="view.free_proxy === member.name" :class="{ 'is-on': view.free_proxy === member.name }" @click="act('set_proxy', member.name)">{{ bridge.display_name(member.name) }}</button>
            <small>{{ view.free_proxy ? `本条作为 ${bridge.display_name(view.free_proxy)} 的回答原文保存，并关闭它的待处理请求` : '粘贴在线 AI 的回答时选择对应成员' }}</small>
          </div>
          <div v-if="free_members.length > 1 && !view.free_proxy" class="channel-free-recipients" role="group" aria-label="发给哪些成员">
            <span>发给</span>
            <button v-for="member in free_members" :key="member.id" type="button" :aria-pressed="recipient_on(member.name)" :class="{ 'is-on': recipient_on(member.name) }" @click="act('toggle_recipient', member.name)">{{ bridge.display_name(member.name) }}</button>
            <small>{{ free_members.some((member) => recipient_on(member.name)) ? '可同时点名多位，也可在正文中 @ 成员' : free_host ? `未点名：交给主持人 ${bridge.display_name(free_host.name)} 分配` : '未点名任何成员：只作留言，不会唤醒 AI' }}</small>
          </div>
          <div v-if="speaking_turn" class="channel-reply-draft channel-queue-hint"><UIcon name="i-lucide-clock" /><span>新消息会在 {{ bridge.display_name(speaking_turn.expert) }} 回复后交给主持人；点「停止」取消本次安排</span></div>
          <div v-if="view.reply_to || view.turn_reply_to" class="channel-reply-draft"><UIcon name="i-lucide-corner-up-left" /><span>{{ view.turn_reply_to ? `回答安排 #${view.turn_reply_to} · ${bridge.display_name(room.host)} 代发` : `回复 #${view.reply_to}` }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="view.turn_reply_to ? '取消关联安排' : '取消回复'" @click="act(view.turn_reply_to ? 'cancel_answer' : 'cancel_reply')" /></div>
          <div v-if="needs_summary" class="channel-answer-editor"><UTextarea v-model="answer_summary" :rows="2" aria-label="回答摘要" class="w-full" placeholder="先说结论，保留关键理由、条件和不确定性。完整内容写在正文中。" /><USelect v-model="summary_source" :items="summary_sources" aria-label="摘要提供者" size="xs" /></div>
        </template>
        <template #footer>
          <UButton type="button" icon="i-lucide-paperclip" aria-label="添加附件" title="图片、PDF 或其他文件 · 每个最多 20 MiB" color="neutral" variant="ghost" size="sm" :disabled="view.sending_message" @click="act('choose_attachments')" />
          <div v-if="!free" class="channel-composer-identity">
            <USelectMenu v-model="author" :items="identities" value-key="value" :avatar="selected_identity?.avatar" :disabled="kind === 'moderation'" :search-input="{ placeholder: '搜索身份…', icon: 'i-lucide-search' }" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言身份" class="channel-author-select" :ui="{ content: 'channel-select-menu channel-identity-menu', itemLeadingAvatarSize: 'xs' }" />
            <USelect v-model="kind" :items="kinds" :icon="kinds.find((item) => item.value === kind)?.icon" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言职责" class="channel-kind-select" :ui="{ content: 'channel-select-menu' }" />
          </div>
          <span class="channel-shortcut"><UKbd value="ctrl" /><UKbd value="enter" /></span>
          <UButton v-if="free_activity" icon="i-lucide-square" label="停止" color="neutral" variant="outline" size="sm" class="channel-stop" :title="`停止 ${free_busy.map((item) => bridge.display_name(item.author)).join('、')} 当前的工作，并取消尚未投递的请求`" :loading="pending === 'interrupt_free'" @click="act('interrupt_free')" />
          <UButton v-if="speaking_turn" icon="i-lucide-square" label="停止" color="neutral" variant="outline" size="sm" class="channel-stop" :title="`打断 ${bridge.display_name(speaking_turn.expert)} 的发言（本次作废），交给主持人`" :loading="pending === 'cancel_turn'" @click="act('cancel_turn')" />
          <UButton type="button" trailing-icon="i-lucide-arrow-up" color="neutral" label="发送" size="sm" class="channel-primary-button channel-send" :disabled="(!text.trim() && !view.attachment_drafts.length) || (needs_summary && !answer_summary.trim())" :loading="pending === 'send' || view.sending_message" @click="send" />
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span v-if="free">{{ free_members.length > 1 ? '点名的成员会各自处理' : `消息会交给 ${free_members.map((member) => bridge.display_name(member.name)).join('、') || 'AI'} 处理` }}<span class="channel-note-divider">·</span>处理中可随时停止</span><span v-else>{{ author_note }}<span class="channel-note-divider">·</span>在线 AI 的观点需代发</span><span class="channel-draft-length">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span>Enter 换行</span></div>
    </div></div>
  </section>
</template>

<style scoped>
.channel-free-recipients { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px 2px; font-size: 12px; color: var(--ui-text-muted); }
.channel-free-recipients button { min-height: 26px; padding: 2px 8px; border: 1px solid var(--ui-border); border-radius: 6px; color: var(--ui-text-toned); }
.channel-free-recipients button.is-on { border-color: var(--channel-accent); background: color-mix(in srgb, var(--channel-accent) 14%, transparent); color: var(--ui-text-highlighted); }
.channel-free-recipients small { flex-basis: 100%; color: var(--ui-text-dimmed); font-size: 11px; }
.channel-link-button { color: var(--channel-accent); text-decoration: underline; text-underline-offset: 2px; }
.channel-message-elapsed { align-self: flex-start; margin-left: auto; line-height: 28px; white-space: nowrap; }
.channel-host-work { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; column-gap: 10px; row-gap: 2px; align-items: start; margin: 0 var(--message-inset-end, 16px) 20px 16px; padding: 12px 18px; border: 1px solid var(--ui-border-muted); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 35%, transparent); }
.channel-host-work > .channel-avatar { grid-row: 1 / 3; align-self: center; width: 28px; height: 28px; font-size: 9px; }
.channel-host-work-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px; min-width: 0; line-height: 20px; }
.channel-host-work-heading strong { color: var(--ui-text); font-size: 13px; font-weight: 600; }
.channel-host-work-heading span, .channel-host-work-elapsed { color: var(--ui-text-dimmed); font-size: 11px; line-height: 20px; }
.channel-host-work-elapsed { white-space: nowrap; font-variant-numeric: tabular-nums; }
.channel-host-work-status { grid-column: 2 / -1; margin: 0; color: var(--ui-text-toned); font-size: 13px; line-height: 20px; }
@media (max-width: 700px) {
  .channel-host-work { margin: 0 8px 14px; padding: 12px 15px; }
}
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

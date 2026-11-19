<script setup>
import { awaiting_member } from "./external-members.js";
import { t } from './i18n.js';
/** Right-rail board of a free room, laid out like the discussion progress board. */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import InviteDialog from "./InviteDialog.vue";
import WorkflowControl from "./WorkflowControl.vue";
import { active_workflow } from "./workflow-state.js";
import StartDiscussionDialog from "./StartDiscussionDialog.vue";
import StartGoalDialog from "./StartGoalDialog.vue";
import { format_duration } from "./LimitPicker.vue";
import ProgressBoard from "./ProgressBoard.vue";
import SpeakingOrder from "./SpeakingOrder.vue";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import { busy, member_actions } from "./member-actions.js";
import MemoBlock from "./memo-block.js";
import ExternalMemberDialog from "./ExternalMemberDialog.vue";
import { declined, external_of, external_tag, revoke_member } from "./external-members.js";

const { view, bridge, act, pending } = inject("discussion");
const LIVE = ["dispatched", "started"];
const ACCESS_LABELS = { runner: t('本机唤醒'), manual: t('手动接入') };
const TASK_PREVIEW_LENGTH = 90;
const room = computed(() => view.value.room);
const free = computed(() => room.value.free || {});
const discussion = computed(() => ["active", "paused"].includes(room.value.session?.status));
// The open goal, if any; an ended one only leaves its end notice in the transcript.
const goal = computed(() => ["active", "paused"].includes(room.value.goal_state?.goal?.status) ? room.value.goal_state.goal : null);
// Outside a discussion the brief bar is hidden, so past briefs, consensus and discussions open from here.
const has_history = computed(() => !discussion.value && !!(room.value.host_brief?.text || room.value.state_text || room.value.discussions?.length));
const emit = defineEmits(["history"]);
// The rail is narrow: about four lines of objective show before it folds.
const GOAL_PREVIEW_LENGTH = 60;
const goal_usage = computed(() => {
  const value = goal.value;
  if (!value) return "";
  const continues = t('已续跑 {value1}{value2} 次', { value1: value.continues, value2: value.max_continues ? ` / ${value.max_continues}` : "" });
  const minutes = Math.floor((value.elapsed_seconds || 0) / 60);
  return t('{value1} · 用时 {value2}{value3}', { value1: continues, value2: format_duration(minutes), value3: value.max_minutes ? ` / ${format_duration(value.max_minutes)}` : "" });
});
// What the goal is doing now: the host may say it waits on background work or on you, which holds idle wake-ups.
const goal_phase = computed(() => {
  const value = goal.value;
  if (!value) return "";
  if (value.status !== "active") return t('已暂停');
  const until = value.phase_until ? t('，{value1} 兜底唤醒', { value1: new Date(value.phase_until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }) : "";
  if (value.phase === "pending") return t('待你确认{value1}', { value1: until || t('，等你回复') });
  if (value.phase === "waiting") return t('等待后台工作{value1}', { value1: until });
  return value.idle ? t('进行中 · 空闲，稍后唤醒主持人') : t('进行中');
});
const goal_expanded = ref(false);
const goal_dialog = ref(false);
const current_round = computed(() => discussion.value ? room.value.current_turn?.round || (room.value.completed_rounds || 0) + 1 : 0);
const host = computed(() => (free.value.members || []).find((member) => member.role === "host" && member.status === "active"));
// External members that have gone stay listed, dimmed, with why: they take no requests.
const ended_externals = computed(() => free.value.ended_externals || []);
const ENDED_REASONS = { expired: t("已到期"), left: t("对方已退出"), revoked: t("已撤销") };
const ended_reason = (member) => ENDED_REASONS[member.external?.end_reason] || t("已结束");
// Shown only while in use: sending its members away ends it, and "/" starts it again.
const workflow = computed(() => active_workflow(view.value.launch.room_models?.workflow, free.value.members));
const in_workflow = (name) => Boolean(workflow.value?.enabled && Object.values(workflow.value.members || {}).includes(name));
const invite_workflow_id = ref("");
// Closing the section only hides it in this browser; the workflow keeps running. The mark is per room and cleared once
// the room's settings are read and that workflow is no longer in use, so another or a restarted workflow shows again.
const WORKFLOW_HIDDEN_PREFIX = "discuss-workflow-hidden:";
const workflow_hidden = ref(false);
watch(() => [room.value.id, view.value.launch.room_models, workflow.value?.id], ([room_id, models, workflow_id]) => {
  const key = WORKFLOW_HIDDEN_PREFIX + room_id;
  let saved = "";
  try { saved = localStorage.getItem(key) || ""; } catch { /* Treat as not hidden. */ }
  const settled = models?.room_id === room_id && !models.loading && !models.error;
  if (saved && settled && saved !== workflow_id) {
    try { localStorage.removeItem(key); } catch { /* Cleared on a later read. */ }
    saved = "";
  }
  workflow_hidden.value = Boolean(workflow_id) && saved === workflow_id;
}, { immediate: true });
function hide_workflow() {
  try { localStorage.setItem(WORKFLOW_HIDDEN_PREFIX + room.value.id, workflow.value.id); } catch { /* Shown again on the next refresh. */ }
  workflow_hidden.value = true;
}

// Rows follow the room's speaking order; members who left are listed after it.
const member_named = (name) => (free.value.members || []).find((member) => member.name === name);
const away_names = computed(() => (free.value.members || []).filter((member) => member.status === "away").map((member) => member.name));

// The room resends its conflicts on every refresh. Only pairs that appear while the page is open are announced:
// conflicts already there on the first read were handed to the host as a room notice when they happened.
const CONFLICT_FILE_PREVIEW = 2;
const conflict_key = (item) => item.executions.join("-");
const known_conflicts = new Map();
/** Warn about conflicts that appeared since this page first read the room. */
function announce_conflicts(room_id, conflicts) {
  // Before the room view loads there is no list; treating it as empty would make every existing conflict look new.
  if (!room_id || !Array.isArray(conflicts)) return;
  const keys = conflicts.map(conflict_key);
  const seen = known_conflicts.get(room_id);
  known_conflicts.set(room_id, new Set([...(seen || []), ...keys]));
  if (!seen) return;
  for (const item of conflicts.filter((conflict) => !seen.has(conflict_key(conflict)))) {
    // Both members' own edit tools wrote these files.
    const listed = item.files;
    const files = listed.slice(0, CONFLICT_FILE_PREVIEW).join("、") + (listed.length > CONFLICT_FILE_PREVIEW ? t(' 等') : "");
    const members = item.members.map((name) => bridge.display_name(name)).join(t(' 与 '));
    bridge.notify("warning", t('冲突：{value1} 同时编辑了 {value2} 个相同文件（{value3}），后保存的可能覆盖了先保存的，请核对', { value1: members, value2: listed.length, value3: files }));
  }
}
watch(() => [room.value.id, free.value.conflicts], ([room_id, conflicts]) => announce_conflicts(room_id, conflicts), { immediate: true });

/** Status dot colour, matching the discussion progress board. */
const unregistered = awaiting_member;
function member_tone(member) {
  if (member.status === "away") return "neutral";
  // An external member that ended or expired is inert; one whose computer refused the last request needs a look.
  const external = external_of(member);
  if (external && (external.ended || (external.expires_at && external.expires_at <= clock.value))) return "neutral";
  if (external_declined.value.has(member.id) && !busy(member)) return "warning";
  if (unregistered(member)) return "warning";
  if (member.execution?.stale || (member.pending && member.adopt_error)) return "error";
  if (member.held_until) return "warning";
  if (busy(member)) return member.pending && !LIVE.includes(member.execution?.status) ? "warning" : "primary";
  return member.execution?.status === "failed" ? "error" : "neutral";
}

/** One line per member: live execution, queued requests, its place in a one-after-another queue, or the last outcome. */
function member_status(member, state) {
  if (external_of(member)?.ended) return t('已结束：不能再领取请求或读取文件');
  if (external_of(member) && external_of(member).expires_at && external_of(member).expires_at <= clock.value) return t('已到期：不能再领取请求或读取文件');
  if (member.status === "away") return t('已离开：不会被唤醒，可请回');
  if (unregistered(member)) return member.access === 'external' ? t('待签到') : t('待注册');
  const execution = member.execution;
  if (execution && LIVE.includes(execution.status)) return execution.stale ? t('执行失联，停止未确认') : t('正在处理');
  // Out of quota: nothing is delivered until the reset, except that the owner's next message to it is tried at once.
  if (member.quota_until) return t('额度已用尽，预计 {value1} 恢复；给它发新消息会立即再试', { value1: new Date(member.quota_until * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
  // Voided in a window or App the runner cannot stop: that turn may still run, so new messages wait for it.
  if (member.held_until) return t('{value1}，等待结束确认或迟到回答；{value2}最晚 {value3} 送达', { value1: execution?.stop_result === "unconfirmed" ? t('上一轮停止未确认') : t('上一轮已作废，可能仍在生成'), value2: member.pending ? t('{value1} 条新消息', { value1: member.pending }) : t('新消息'), value3: bridge.format_time(member.held_until * 1000) });
  if (member.pending && member.adopt_error) return t('无法投递 {value1} 条', { value1: member.pending });
  if (member.pending) return t('待投递 {value1} 条', { value1: member.pending });
  if (external_declined.value.has(member.id)) return t('对方未同意');
  if (state === "queued") return discussion.value ? t('本轮排队') : t('等待依次发言');
  if (execution?.status === "failed") return t('执行失败');
  return !execution && member.access === "manual" ? t('已注册') : t('空闲');
}

/**
 * The quiet line beside a name: a woken CLI shows only its model and effort, since being woken here is the usual case;
 * API, manual and web members also say how they take part; one that can make images names its image model too. The crown already marks the host.
 */
function member_tag(member) {
  // An external member's tag sits on its own line below (member_setup): beside a name like "DeepSeek-ext" it would be cut.
  if (external_of(member)) return "";
  if (member.access !== "runner") return ACCESS_LABELS[member.access];
  return [member.adapter === "api" ? "API" : "", member_model(member)].filter(Boolean).join(" · ");
}

/** Only woken members have a model the site knows; others choose it in their own chat. */
function member_model(member) {
  return member.access === "runner" ? bridge.participant_model(member.name, room.value, view.value.launch.room_models) : "";
}

/** Session and project files of a woken member, e.g. "借用会话 · 可写"; web members only read. */
function member_setup(member) {
  // The line below the name wraps, so "外部 · 只读文件 · 剩 56 分" stays whole at the rail's default 280px.
  if (external_of(member)?.pending) return "";
  if (external_of(member)) return external_tag(member, clock.value);
  const session = member.access === "runner" ? (member.session_mode === "borrowed" ? t('借用会话') : t('独立会话')) : "";
  return [session, bridge.participant_files(member.name, room.value, view.value.launch.room_models)].filter(Boolean).join(" · ");
}

/** Ways to let a stopped chain run on: what the host asked for, else one more round or as many as the room's limit. */
const continue_choices = computed(() => status.value.asked_rounds ? [...new Set([status.value.asked_rounds, 1])]
  : [...new Set([1, free.value.max_rounds || 1])]);
const continuing = ref(0);
async function continue_chain(chain_id, rounds) {
  continuing.value = rounds;
  try { await bridge.continue_chain(chain_id, rounds); } catch { /* The controller shows the error as a toast. */ }
  finally { continuing.value = 0; }
}

const status = computed(() => {
  if (room.value.archived) return { tone: "neutral", title: t('已存档'), detail: "" };
  const working = (free.value.members || []).filter(busy);
  if (working.some((member) => member.execution?.stale)) return { tone: "error", title: t('执行失联'), detail: t('停止未确认，可在成员菜单中停止后重发') };
  const undeliverable = working.find((member) => member.pending && member.adopt_error && !LIVE.includes(member.execution?.status));
  if (undeliverable) return { tone: "error", title: t('无法投递'), detail: t('{value1} 的消息未送达，原因见对话区', { value1: bridge.display_name(undeliverable.name) }) };
  const latest_chain = latest_chain_id.value;
  if (working.length) return { tone: "primary", title: t('处理中'), detail:
    working.map((member) => `${bridge.display_name(member.name)} ${LIVE.includes(member.execution?.status) ? t('正在处理') : member.held_until ? t('等上一轮结束') : t('待投递 {value1} 条', { value1: member.pending })}`).join(" · ") };
  const halted = (free.value.halted_chains || []).find((chain) => chain.chain_id === latest_chain);
  if (halted?.reason === "budget" && halted.asked_rounds) return { tone: "warning", title: t('主持人申请轮数'), continue_chain: latest_chain,
    asked_rounds: halted.asked_rounds, detail: t('申请再给 {value1} 轮：{value2}。批准即发出暂存的派活；发新消息则重新开始', { value1: halted.asked_rounds, value2: halted.asked_reason }) };
  if (halted?.reason === "budget") return { tone: "warning", title: t('任务链已停'), continue_chain: latest_chain,
    detail: t('达到连续派活上限；主持人的下一次派活已暂存，继续即发出。发新消息则重新开始') };
  if (halted) return { tone: "warning", title: t('任务链已停'), detail: t('派出的成员都失败了；发新消息即重新开始') };
  if (!(free.value.members || []).length) return { tone: "neutral", title: t('暂无成员'), detail: t('在下方邀请 AI 加入') };
  return { tone: "neutral", title: t('空闲'), detail: host.value
    ? t('消息默认交给 {value1}；@ 其他成员让它们发言', { value1: bridge.display_name(host.value.name) }) : t('没有主持人：消息只作留言') };
});

/** Requests on messages the user has not retracted or rewound; the rest no longer count as work. */
const live_requests = computed(() => {
  const withdrawn = new Set((room.value.withdrawals || []).map((item) => item.message_id));
  return (free.value.requests || []).filter((request) => !withdrawn.has(request.message_id));
});

const latest_chain_id = computed(() => Math.max(0, ...(free.value.requests || []).map((request) => request.chain_id)));
const latest_rounds = computed(() => (free.value.chain_rounds || []).find((chain) => chain.chain_id === latest_chain_id.value) || null);

/** How far the latest chain got against the room's chain limit, while it runs or after it stopped there; it says when the room stops by itself. */
const rounds_meter = computed(() => {
  const rounds = latest_rounds.value;
  if (!rounds || !(status.value.title === t('处理中') || status.value.continue_chain)) return null;
  if (rounds.allowed == null) return { text: t('第 {value1} 轮 · 不限', { value1: rounds.used }), ratio: null };
  const used = Math.min(rounds.used, rounds.allowed);
  return { text: t('{value1} / {value2} 轮', { value1: used, value2: rounds.allowed }), ratio: used / rounds.allowed };
});

/** The user message behind the newest unfinished request, so the rail says what the room is working on; none once all are answered. */
const task = computed(() => {
  const request = live_requests.value.filter((item) => item.created_by === "user" && ["pending", "delivering"].includes(item.status)).at(-1);
  if (!request) return "";
  const message = (view.value.messages || []).find((item) => item.id === request.message_id);
  // A goal wake-up is not a task of its own; the goal section already says what the host is pursuing.
  if (message?.source === "goal") return "";
  return message ? message.text : `#${request.message_id}`;
});
const task_expanded = ref(false);
watch(() => room.value.id, () => { task_expanded.value = false; });

/**
 * Everything one speaking-order row shows or its menu offers, as one string, so a row re-renders only when it changes
 * rather than on every view publish (each of which rebuilds the menu items and avatar props).
 */
function member_row_key(member, state) {
  const identity = bridge.identities[member.name];
  return JSON.stringify([member, state, discussion.value, member_tag(member), member_setup(member), member_model(member),
    bridge.participant_session_hint(member.name, room.value, view.value.launch.room_models), bridge.display_name(member.name),
    room.value.descriptions?.[member.name], external_declined.value.has(member.id), external_of(member) && Math.floor(clock.value / CLOCK_TICK_MS), in_workflow(member.name) && workflow.value.label, identity?.icon, identity?.initials, identity?.style,
    view.value.access, room.value.session?.status, view.value.launch.available]);
}

/** The rail's quick entry to a member's actions; the room overview lays the same list out in full. */
function member_menu(member) {
  return member_actions(member, { view: view.value, act, describe: (name) => { describing.value = name; },
    external: (target) => { external_member.value = target; external_reinvite.value = false; external_open.value = true; },
    revoke: (target) => revoke_member(bridge, act, room.value.id, target) });
}

const inviting = ref(false);
// The external member whose dialog is open.
const external_member = ref(null), external_open = ref(false), external_reinvite = ref(false);
// Remaining times count down on the rail; a minute is fine-grained enough for "剩余 N 分钟".
const CLOCK_TICK_MS = 30_000;
const clock = ref(Date.now());
const clock_timer = setInterval(() => { clock.value = Date.now(); }, CLOCK_TICK_MS);
onBeforeUnmount(() => clearInterval(clock_timer));
/** External members whose latest request their computer turned down or let time out. */
const external_declined = computed(() => {
  const latest = new Map();
  for (const request of free.value.requests || []) latest.set(request.member_id, request);
  return new Set([...latest].filter(([, request]) => declined(request)).map(([id]) => id));
});
// Someone redeeming an invitation becomes a member at once, with no approval step: say so, so the owner can revoke.
const known_external = new Map();
watch(() => [room.value.id, free.value.members], ([room_id, members]) => {
  if (!room_id || !Array.isArray(members)) return;
  const ids = members.filter((member) => external_of(member) && !awaiting_member(member)).map((member) => member.id);
  const seen = known_external.get(room_id);
  known_external.set(room_id, new Set(ids));
  if (!seen) return;
  for (const member of members.filter((item) => external_of(item) && !awaiting_member(item) && !seen.has(item.id)))
    bridge.notify("warning", t('{name} 经邀请加入了房间（外部 · {level}）；不是你邀请的就在成员菜单里撤销', { name: bridge.display_name(member.name), level: external_tag(member) }));
}, { immediate: true });
// The member whose description is open for editing; the scheduler and the host read it from the room.
const describing = ref(""), describing_saving = ref(false);
watch(() => room.value.id, () => { inviting.value = false; describing.value = ""; });

/** Save one member's description in this room, and optionally as its platform's default for later rooms. */
async function save_description({ text, label, as_template }) {
  describing_saving.value = true;
  try {
    await bridge.describe_member(describing.value, text, label);
    if (as_template) bridge.save_description_template(describing.value, text);
    describing.value = "";
  } catch { /* The controller shows the error as a toast. */ }
  finally { describing_saving.value = false; }
}

/** The host's timed check-in, when it set one. */
const checkin = computed(() => room.value.free?.host_checkin || null);

const starting = ref(false);
/** A discussion needs an AI host the local service wakes. */
const can_start = computed(() => Boolean(host.value && host.value.access === "runner") && view.value.launch.available);
watch(() => room.value.id, () => { starting.value = false; });
</script>

<template>
  <div class="progress-board is-docked">
    <header class="pb-header"><strong>{{ discussion ? t('讨论进度') : t('房间') }}</strong><span class="pb-mode">{{ host ? t('{value1} 主持', { value1: bridge.display_name(host.name) }) : t('无主持人') }}</span></header>
    <ProgressBoard v-if="discussion" />
    <section v-else class="pb-status" :class="`is-${status.tone}`" :aria-label="t('房间状态')">
      <div class="pb-status-line"><span class="pb-dot"></span><strong role="status">{{ status.title }}</strong>
        <UButton v-if="status.title === t('处理中') &amp;&amp; view.access?.can_manage" :label="t('全部停止')" size="xs" color="error" variant="soft" class="pb-stop-all" :title="t('停止所有成员正在做的工作，并取消还没投递的请求；发新消息即重新开始')"
          :loading="pending === 'stop_room'" :disabled="!!pending" @click="act('stop_room')">
          <template #leading><span v-if="pending !== 'stop_room'" class="pb-stop-glyph" aria-hidden="true"></span></template>
        </UButton>
      </div>
      <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
      <div v-if="rounds_meter" class="pb-meter pb-rounds" :title="t('主持人连续派活的轮数；到上限自动停下，可继续')">
        <div class="pb-meter-label"><span>{{ t('连续派活') }}</span><b>{{ rounds_meter.text }}</b></div>
        <div v-if="rounds_meter.ratio !== null" class="pb-bar"><i :style="{ width: `${Math.round(rounds_meter.ratio * 100)}%` }"></i></div>
      </div>
      <div v-if="checkin" class="pb-checkin" :title="t('主持人给自己设的定时检查：房间还有进行中的工作时按间隔唤醒它查看进展，房间空闲后自动结束')">
        <span>{{ t('定时检查 · 每 {value1} 分钟 · 下次 {value2}', { value1: checkin.minutes, value2: bridge.format_time(checkin.due_at * 1000) }) }}</span>
        <UButton v-if="view.access?.can_manage" :label="t('关闭')" size="xs" color="neutral" variant="ghost" :loading="pending === 'stop_host_checkin'" :disabled="!!pending" @click="act('stop_host_checkin')" />
      </div>
      <div v-if="status.continue_chain && view.access?.can_manage" class="pb-chain-actions">
        <UButton v-for="rounds in continue_choices" :key="rounds" :label="rounds === status.asked_rounds ? t('批准 {value1} 轮', { value1: rounds }) : t('继续 {value1} 轮', { value1: rounds })" icon="i-lucide-play" size="sm" color="neutral" variant="outline" class="pb-action" data-tone="success"
          :loading="continuing === rounds" :disabled="Boolean(continuing)" @click="continue_chain(status.continue_chain, rounds)" />
      </div>
    </section>
    <section v-if="goal" class="pb-section" aria-label="Goal">
      <h4>Goal</h4>
      <div class="pb-goal-status" :class="goal.status !== 'active' ? 'is-paused' : goal.phase === 'pending' ? 'is-warning' : 'is-success'"><span class="pb-dot"></span><span role="status">{{ goal_phase }}</span></div>
      <p v-if="goal.status === 'active' && goal.phase !== 'doing' && goal.phase_note" class="pb-goal-usage">{{ goal.phase_note }}</p>
      <p class="pb-focus" :class="{ 'is-expanded': goal_expanded }">{{ goal.objective }}</p>
      <button v-if="goal.objective.length > GOAL_PREVIEW_LENGTH" type="button" class="pb-link" @click="goal_expanded = !goal_expanded">{{ goal_expanded ? t('收起') : t('展开') }}</button>
      <p class="pb-goal-usage">{{ goal_usage }}</p>
      <div v-if="view.access?.can_manage && !room.archived" class="pb-goal-actions">
        <UButton :label="goal.status === 'active' ? t('暂停') : t('继续')" :icon="goal.status === 'active' ? 'i-lucide-pause' : 'i-lucide-play'" size="xs" color="neutral" variant="outline" class="pb-action" :data-tone="goal.status === 'active' ? 'warning' : 'success'"
          :title="goal.status === 'active' ? t('房间空闲时不再唤醒主持人，正在进行的工作不受影响') : t('继续推进，房间空闲时唤醒主持人')"
          :loading="pending === 'goal_control'" :disabled="Boolean(pending)" @click="act('goal_control', goal.status === 'active' ? 'pause' : 'resume')" />
        <UButton :label="t('编辑')" icon="i-lucide-pencil" size="xs" color="neutral" variant="outline" class="pb-action" data-tone="accent" :disabled="Boolean(pending)" @click="goal_dialog = true" />
        <UButton :label="t('结束')" icon="i-lucide-square" size="xs" color="neutral" variant="outline" class="pb-action" data-tone="danger" :title="t('结束 Goal，主持人不再自动推进；正在进行的工作不受影响')"
          :loading="pending === 'goal_control'" :disabled="Boolean(pending)" @click="act('goal_control', 'clear')" />
      </div>
    </section>
    <section v-if="task && !discussion" class="pb-section" :aria-label="t('当前任务')">
      <h4>{{ t('当前任务') }}</h4>
      <p class="pb-focus" :class="{ 'is-expanded': task_expanded }">{{ task }}</p>
      <button v-if="task.length > TASK_PREVIEW_LENGTH" type="button" class="pb-link" @click="task_expanded = !task_expanded">{{ task_expanded ? t('收起') : t('展开') }}</button>
    </section>
    <section v-if="workflow && !workflow_hidden" class="pb-section" :aria-label="t('房间工作流')">
      <h4>{{ t('工作流') }}</h4>
      <WorkflowControl :workflow="workflow" dismissible @dismiss="hide_workflow" />
    </section>
    <section class="pb-section" :aria-label="t('发言顺序')">
      <h4>{{ t('发言顺序') }}</h4>
      <SpeakingOrder :away="away_names" :round="current_round">
        <template #default="{ item }">
          <MemoBlock v-for="member in [member_named(item.name)].filter(Boolean)" :key="member.id" :deps="[member_row_key(member, item.state)]">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="pb-member-body">
              <div class="pb-member-name" :title="room.descriptions?.[member.name] || undefined">{{ bridge.display_name(member.name) }}<span v-if="!external_of(member) && bridge.display_name(member.name) !== member.name" class="member-id">{{ member.name }}</span><UIcon v-if="member.role === 'host'" name="i-lucide-crown" :title="t('主持人')" /><small :title="member_tag(member) || undefined">{{ member_tag(member) }}</small></div>
              <div v-if="member_setup(member) || in_workflow(member.name)" class="pb-member-model" :title="external_of(member) ? external_tag(member, clock, { full: true }) : bridge.participant_session_hint(member.name, room, view.launch.room_models)"><small v-if="in_workflow(member.name)" class="pb-workflow-member" :title="t('来自工作流「{value1}」', { value1: workflow.label })">{{ t('工作流') }}</small>{{ member_setup(member) }}</div>
              <div class="pb-member-status" :class="`is-${member_tone(member)}`"><span class="pb-dot"></span><span class="pb-member-status-text" :title="member.execution?.status === 'failed' ? member.execution.result : member.held_until ? member_status(member, item.state) : undefined">{{ member_status(member, item.state) }}</span></div>
            </div>
            <UDropdownMenu :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="t('{value1} 的更多操作', { value1: member.name })" /></UDropdownMenu>
          </MemoBlock>
        </template>
      </SpeakingOrder>
      <ul v-if="ended_externals.length" class="pb-ended-members" :aria-label="t('已离开的外部专家')">
        <li v-for="member in ended_externals" :key="member.id" class="pb-member is-away">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <div class="pb-member-body">
            <div class="pb-member-name">{{ bridge.display_name(member.name) }}</div>
            <div class="pb-member-status is-neutral" :title="member.external?.ended_at ? bridge.format_time(member.external.ended_at * 1000) : undefined"><span class="pb-dot"></span><span class="pb-member-status-text">{{ t("已离开：{reason}", { reason: ended_reason(member) }) }}</span></div>
          </div>
          <UButton v-if="!room.archived" icon="i-lucide-user-round-plus" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="t('重新邀请 {name}', { name: bridge.display_name(member.name) })" :title="t('重新邀请')"
            @click="external_member = member; external_reinvite = true; external_open = true" />
        </li>
      </ul>
      <UButton v-if="!room.archived" icon="i-lucide-plus" :label="t('邀请 AI 加入')" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block pb-action-add" @click="invite_workflow_id = ''; inviting = true" />
    </section>
    <section v-if="!room.archived && !discussion && !goal" class="pb-actions pb-start-actions" :aria-label="t('操作')">
      <div class="pb-start-pair">
        <UButton icon="i-lucide-messages-square" :label="t('开启讨论')" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" :title="t('由主持人推进成员轮流发言，到上限或结束时停止')" :disabled="!can_start" @click="starting = true" />
        <UButton icon="i-lucide-target" :label="t('开启 Goal')" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" :title="t('主持人持续推进一个目标：房间空闲时自动接着做，直到完成、卡住或你结束')" :disabled="!can_start" @click="goal_dialog = true" />
      </div>
      <p v-if="!can_start" class="pb-free-note">{{ t('开启讨论或 Goal 需要一位由本机唤醒的 AI 主持人。') }}</p>
    </section>
    <section v-if="has_history" class="pb-actions pb-history-actions" :aria-label="t('共识与讨论记录')"><UButton icon="i-lucide-history" :label="t('共识与讨论记录')" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block" @click="emit('history')" /></section>
  <StartDiscussionDialog v-model:open="starting" />
  <StartGoalDialog v-model:open="goal_dialog" :edit="Boolean(goal)" :initial="goal" />
  <InviteDialog v-model:open="inviting" :workflow-id="invite_workflow_id" :description="t('新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。')" />
  <ExternalMemberDialog v-model:open="external_open" :member="external_member" :reinvite="external_reinvite" />
  <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.default_name(bridge.platform_of(describing)) : ''" :default_label="describing ? bridge.default_name(describing) : ''"
    :text="room.descriptions?.[describing] || ''" :label="room.labels?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
    @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </div>
</template>

<style scoped>
.pb-member.is-away { opacity: .6; }
.pb-ended-members { display: flex; flex-direction: column; gap: 6px; margin: 6px 0 0; padding: 0; list-style: none; }
.pb-ended-members .pb-member { display: flex; align-items: flex-start; gap: 8px; padding: 4px 8px; line-height: 1.35; font-size: 12px; }
.pb-ended-members .pb-member-body { min-width: 0; }
/* A member from another computer: a dashed ring marks it apart from this computer's own AIs. */
.pb-goal-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.pb-goal-status.is-paused { color: var(--ui-text-muted); }
.pb-goal-usage { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 11px; }
.pb-goal-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
/* Speaking-order rows stay compact: name, then the workflow tag and setup on one line, then the status. */
.speaking-order-row .pb-member-body { line-height: 1.35; }
.pb-workflow-member { color: var(--ui-text-muted); font-size: 10px; }
.pb-workflow-member:not(:last-child)::after { content: " · "; }
.pb-member-model { margin: 1px 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
/* A member with a nickname also shows its ID, which AI messages, @ and records use. */
.member-id { margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; font-weight: 400; }
</style>

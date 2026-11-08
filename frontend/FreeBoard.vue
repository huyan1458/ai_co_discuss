<script setup>
/** Right-rail board of a free room, laid out like the discussion progress board. */
import { computed, inject, ref, watch } from "vue";
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

const { view, bridge, act, pending } = inject("discussion");
const LIVE = ["dispatched", "started"];
const ACCESS_LABELS = { runner: "本机唤醒", manual: "手动接入" };
const TASK_PREVIEW_LENGTH = 90;
const room = computed(() => view.value.room);
const free = computed(() => room.value.free || {});
const discussion = computed(() => ["active", "paused"].includes(room.value.session?.status));
// The open goal, if any; an ended one only leaves its end notice in the transcript.
const goal = computed(() => ["active", "paused"].includes(room.value.goal_state?.goal?.status) ? room.value.goal_state.goal : null);
// The rail is narrow: about four lines of objective show before it folds.
const GOAL_PREVIEW_LENGTH = 60;
const goal_usage = computed(() => {
  const value = goal.value;
  if (!value) return "";
  const continues = `已续跑 ${value.continues}${value.max_continues ? ` / ${value.max_continues}` : ""} 次`;
  const minutes = Math.floor((value.elapsed_seconds || 0) / 60);
  return `${continues} · 用时 ${format_duration(minutes)}${value.max_minutes ? ` / ${format_duration(value.max_minutes)}` : ""}`;
});
const goal_expanded = ref(false);
const goal_dialog = ref(false);
const current_round = computed(() => discussion.value ? room.value.current_turn?.round || (room.value.completed_rounds || 0) + 1 : 0);
const host = computed(() => (free.value.members || []).find((member) => member.role === "host" && member.status === "active"));
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
    // `confirmed`: both members' own edit tools wrote these; otherwise the files changed while both ran and the writer is unknown.
    const listed = item.confirmed?.length ? item.confirmed : item.files;
    const files = listed.slice(0, CONFLICT_FILE_PREVIEW).join("、") + (listed.length > CONFLICT_FILE_PREVIEW ? " 等" : "");
    const members = item.members.map((name) => bridge.display_name(name)).join(" 与 ");
    bridge.notify("warning", item.confirmed?.length
      ? `冲突：${members} 同时编辑了 ${listed.length} 个相同文件（${files}），后保存的可能覆盖了先保存的，请核对`
      : `可能冲突：${members} 同时运行期间有 ${listed.length} 个文件被改动（${files}），无法确认是谁改的`);
  }
}
watch(() => [room.value.id, free.value.conflicts], ([room_id, conflicts]) => announce_conflicts(room_id, conflicts), { immediate: true });

/** Status dot colour, matching the discussion progress board. */
const unregistered = (member) => member.access === "manual" && member.status === "active" && !member.registered_at;
function member_tone(member) {
  if (member.status === "away") return "neutral";
  if (unregistered(member)) return "warning";
  if (member.execution?.stale || (member.pending && member.adopt_error)) return "error";
  if (member.held_until) return "warning";
  if (busy(member)) return member.pending && !LIVE.includes(member.execution?.status) ? "warning" : "primary";
  return member.execution?.status === "failed" ? "error" : "success";
}

/** One line per member: live execution, queued requests, its place in a one-after-another queue, or the last outcome. */
function member_status(member, state) {
  if (member.status === "away") return "已离开：不会被唤醒，可请回";
  if (unregistered(member)) return "待注册";
  const execution = member.execution;
  if (execution && LIVE.includes(execution.status)) return execution.stale ? "执行失联，停止未确认" : "正在处理";
  // Voided in a window or App the runner cannot stop: that turn may still run, so new messages wait for it.
  if (member.held_until) return `${execution?.stop_result === "unconfirmed" ? "上一轮停止未确认" : "上一轮已作废，可能仍在生成"}，等待结束确认或迟到回答；${member.pending ? `${member.pending} 条新消息` : "新消息"}最晚 ${bridge.format_time(member.held_until * 1000)} 送达`;
  if (member.pending && member.adopt_error) return `无法投递 ${member.pending} 条`;
  if (member.pending) return `待投递 ${member.pending} 条`;
  if (state === "queued") return discussion.value ? "本轮排队" : "等待依次发言";
  if (execution?.status === "failed") return "执行失败";
  return !execution && member.access === "manual" ? "已注册" : "空闲";
}

/**
 * The quiet line beside a name: a woken CLI shows only its model and effort, since being woken here is the usual case;
 * API, manual and web members also say how they take part. The crown already marks the host.
 */
function member_tag(member) {
  if (member.access !== "runner") return ACCESS_LABELS[member.access];
  return [member.adapter === "api" ? "API" : "", member_model(member)].filter(Boolean).join(" · ");
}

/** Only woken members have a model the site knows; others choose it in their own chat. */
function member_model(member) {
  return member.access === "runner" ? bridge.participant_model(member.name, room.value, view.value.launch.room_models) : "";
}

/** Session and project files of a woken member, e.g. "借用会话 · 可写"; web members only read. */
function member_setup(member) {
  const session = member.access === "runner" ? (member.session_mode === "borrowed" ? "借用会话" : "独立会话") : "";
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
  if (room.value.archived) return { tone: "neutral", title: "已存档", detail: "" };
  const working = (free.value.members || []).filter(busy);
  if (working.some((member) => member.execution?.stale)) return { tone: "error", title: "执行失联", detail: "停止未确认，可在成员菜单中停止后重发" };
  const undeliverable = working.find((member) => member.pending && member.adopt_error && !LIVE.includes(member.execution?.status));
  if (undeliverable) return { tone: "error", title: "无法投递", detail: `${bridge.display_name(undeliverable.name)} 的消息未送达，原因见对话区` };
  const latest_chain = latest_chain_id.value;
  if (working.length) return { tone: "primary", title: "处理中", detail:
    working.map((member) => `${bridge.display_name(member.name)} ${LIVE.includes(member.execution?.status) ? "正在处理" : member.held_until ? "等上一轮结束" : `待投递 ${member.pending} 条`}`).join(" · ") };
  const halted = (free.value.halted_chains || []).find((chain) => chain.chain_id === latest_chain);
  if (halted?.reason === "budget" && halted.asked_rounds) return { tone: "warning", title: "主持人申请轮数", continue_chain: latest_chain,
    asked_rounds: halted.asked_rounds, detail: `申请再给 ${halted.asked_rounds} 轮：${halted.asked_reason}。批准即发出暂存的派活；发新消息则重新开始` };
  if (halted?.reason === "budget") return { tone: "warning", title: "任务链已停", continue_chain: latest_chain,
    detail: "达到连续派活上限；主持人的下一次派活已暂存，继续即发出。发新消息则重新开始" };
  if (halted) return { tone: "warning", title: "任务链已停", detail: "派出的成员都失败了；发新消息即重新开始" };
  if (!(free.value.members || []).length) return { tone: "neutral", title: "暂无成员", detail: "在下方邀请 AI 加入" };
  return { tone: "success", title: "空闲", detail: host.value
    ? `消息默认交给 ${bridge.display_name(host.value.name)}；@ 其他成员让它们发言` : "没有主持人：消息只作留言" };
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
  if (!rounds || !(status.value.title === "处理中" || status.value.continue_chain)) return null;
  if (rounds.allowed == null) return { text: `第 ${rounds.used} 轮 · 不限`, ratio: null };
  const used = Math.min(rounds.used, rounds.allowed);
  return { text: `${used} / ${rounds.allowed} 轮`, ratio: used / rounds.allowed };
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
    room.value.descriptions?.[member.name], in_workflow(member.name) && workflow.value.label, identity?.icon, identity?.initials, identity?.style,
    view.value.access, room.value.session?.status, view.value.launch.available]);
}

/** The rail's quick entry to a member's actions; the room overview lays the same list out in full. */
function member_menu(member) {
  return member_actions(member, { view: view.value, act, describe: (name) => { describing.value = name; } });
}

const inviting = ref(false);
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
    <header class="pb-header"><strong>{{ discussion ? '讨论进度' : '自由协作' }}</strong><span class="pb-mode">{{ host ? `${bridge.display_name(host.name)} 主持` : '无主持人' }}</span></header>
    <ProgressBoard v-if="discussion" />
    <section v-else class="pb-status" :class="`is-${status.tone}`" aria-label="房间状态">
      <div class="pb-status-line"><span class="pb-dot"></span><strong role="status">{{ status.title }}</strong>
        <UButton v-if="status.title === '处理中' && view.access?.can_manage" label="全部停止" size="xs" color="error" variant="soft" class="pb-stop-all" title="停止所有成员正在做的工作，并取消还没投递的请求；发新消息即重新开始"
          :loading="pending === 'stop_room'" :disabled="!!pending" @click="act('stop_room')">
          <template #leading><span v-if="pending !== 'stop_room'" class="pb-stop-glyph" aria-hidden="true"></span></template>
        </UButton>
      </div>
      <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
      <div v-if="rounds_meter" class="pb-meter pb-rounds" title="主持人连续派活的轮数；到上限自动停下，可继续">
        <div class="pb-meter-label"><span>连续派活</span><b>{{ rounds_meter.text }}</b></div>
        <div v-if="rounds_meter.ratio !== null" class="pb-bar"><i :style="{ width: `${Math.round(rounds_meter.ratio * 100)}%` }"></i></div>
      </div>
      <div v-if="checkin" class="pb-checkin" title="主持人给自己设的定时检查：房间还有进行中的工作时按间隔唤醒它查看进展，房间空闲后自动结束">
        <span>定时检查 · 每 {{ checkin.minutes }} 分钟 · 下次 {{ bridge.format_time(checkin.due_at * 1000) }}</span>
        <UButton v-if="view.access?.can_manage" label="关闭" size="xs" color="neutral" variant="ghost" :loading="pending === 'stop_host_checkin'" :disabled="!!pending" @click="act('stop_host_checkin')" />
      </div>
      <div v-if="status.continue_chain && view.access?.can_manage" class="pb-chain-actions">
        <UButton v-for="rounds in continue_choices" :key="rounds" :label="rounds === status.asked_rounds ? `批准 ${rounds} 轮` : `继续 ${rounds} 轮`" icon="i-lucide-play" size="sm" color="neutral" variant="outline" class="pb-action"
          :loading="continuing === rounds" :disabled="Boolean(continuing)" @click="continue_chain(status.continue_chain, rounds)" />
      </div>
    </section>
    <section v-if="goal" class="pb-section" aria-label="Goal">
      <h4>Goal</h4>
      <div class="pb-goal-status" :class="goal.status === 'active' ? 'is-success' : 'is-paused'"><span class="pb-dot"></span><span role="status">{{ goal.status === 'active' ? (goal.idle ? '进行中 · 空闲，稍后唤醒主持人' : '进行中') : '已暂停' }}</span></div>
      <p class="pb-focus" :class="{ 'is-expanded': goal_expanded }">{{ goal.objective }}</p>
      <button v-if="goal.objective.length > GOAL_PREVIEW_LENGTH" type="button" class="pb-link" @click="goal_expanded = !goal_expanded">{{ goal_expanded ? '收起' : '展开' }}</button>
      <p class="pb-goal-usage">{{ goal_usage }}</p>
      <div v-if="view.access?.can_manage && !room.archived" class="pb-goal-actions">
        <UButton :label="goal.status === 'active' ? '暂停' : '继续'" :icon="goal.status === 'active' ? 'i-lucide-pause' : 'i-lucide-play'" size="xs" color="neutral" variant="outline"
          :title="goal.status === 'active' ? '房间空闲时不再唤醒主持人，正在进行的工作不受影响' : '继续推进，房间空闲时唤醒主持人'"
          :loading="pending === 'goal_control'" :disabled="Boolean(pending)" @click="act('goal_control', goal.status === 'active' ? 'pause' : 'resume')" />
        <UButton label="编辑" icon="i-lucide-pencil" size="xs" color="neutral" variant="outline" :disabled="Boolean(pending)" @click="goal_dialog = true" />
        <UButton label="结束" icon="i-lucide-square" size="xs" color="neutral" variant="outline" title="结束 Goal，房间回到自由协作；正在进行的工作不受影响"
          :loading="pending === 'goal_control'" :disabled="Boolean(pending)" @click="act('goal_control', 'clear')" />
      </div>
    </section>
    <section v-if="task && !discussion" class="pb-section" aria-label="当前任务">
      <h4>当前任务</h4>
      <p class="pb-focus" :class="{ 'is-expanded': task_expanded }">{{ task }}</p>
      <button v-if="task.length > TASK_PREVIEW_LENGTH" type="button" class="pb-link" @click="task_expanded = !task_expanded">{{ task_expanded ? '收起' : '展开' }}</button>
    </section>
    <section v-if="workflow && !workflow_hidden" class="pb-section" aria-label="房间工作流">
      <h4>工作流</h4>
      <WorkflowControl :workflow="workflow" dismissible @dismiss="hide_workflow" />
    </section>
    <section class="pb-section" aria-label="发言顺序">
      <h4>发言顺序</h4>
      <SpeakingOrder :away="away_names" :round="current_round">
        <template #default="{ item }">
          <MemoBlock v-for="member in [member_named(item.name)].filter(Boolean)" :key="member.id" :deps="[member_row_key(member, item.state)]">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="pb-member-body">
              <div class="pb-member-name" :title="room.descriptions?.[member.name] || undefined">{{ bridge.display_name(member.name) }}<span v-if="bridge.display_name(member.name) !== member.name" class="member-id">{{ member.name }}</span><UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /><small :title="member_model(member) || undefined">{{ member_tag(member) }}</small></div>
              <small v-if="in_workflow(member.name)" class="pb-workflow-member" :title="`来自工作流「${workflow.label}」`">工作流</small>
              <div v-if="member_setup(member)" class="pb-member-model" :title="bridge.participant_session_hint(member.name, room, view.launch.room_models)">{{ member_setup(member) }}</div>
              <div class="pb-member-status" :class="`is-${member_tone(member)}`"><span class="pb-dot"></span><span class="pb-member-status-text" :title="member.execution?.status === 'failed' ? member.execution.result : member.held_until ? member_status(member, item.state) : undefined">{{ member_status(member, item.state) }}</span></div>
            </div>
            <UDropdownMenu :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
          </MemoBlock>
        </template>
      </SpeakingOrder>
      <UButton v-if="!room.archived" icon="i-lucide-plus" label="邀请 AI 加入" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block pb-action-add" @click="invite_workflow_id = ''; inviting = true" />
    </section>
    <section v-if="!room.archived && !discussion && !goal" class="pb-actions pb-start-actions" aria-label="操作">
      <div class="pb-start-pair">
        <UButton icon="i-lucide-messages-square" label="开启讨论" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="由主持人推进成员轮流发言，到上限或结束后房间回到自由协作" :disabled="!can_start" @click="starting = true" />
        <UButton icon="i-lucide-target" label="开启 Goal" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="主持人持续推进一个目标：房间空闲时自动接着做，直到完成、卡住或你结束" :disabled="!can_start" @click="goal_dialog = true" />
      </div>
      <p v-if="!can_start" class="pb-free-note">开启讨论或 Goal 需要一位由本机唤醒的 AI 主持人。</p>
    </section>
  <StartDiscussionDialog v-model:open="starting" />
  <StartGoalDialog v-model:open="goal_dialog" :edit="Boolean(goal)" :initial="goal" />
  <InviteDialog v-model:open="inviting" :workflow-id="invite_workflow_id" description="新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。" />
  <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.default_name(bridge.platform_of(describing)) : ''" :default_label="describing ? bridge.default_name(describing) : ''"
    :text="room.descriptions?.[describing] || ''" :label="room.labels?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
    @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </div>
</template>

<style scoped>
.pb-member.is-away { opacity: .6; }
.pb-goal-status { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.pb-goal-status.is-paused { color: var(--ui-text-muted); }
/* The two start buttons share one row; the note on why they are disabled sits below them. */
.progress-board > .pb-start-actions { flex-direction: column; align-items: stretch; }
.pb-start-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pb-start-pair .pb-action { justify-content: center; }
.pb-goal-usage { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 11px; }
.pb-goal-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.pb-workflow-member { color: var(--ui-text-muted); font-size: 10px; }
.pb-member-model { margin: 2px 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
/* A member with a nickname also shows its ID, which AI messages, @ and records use. */
.member-id { margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; font-weight: 400; }
</style>

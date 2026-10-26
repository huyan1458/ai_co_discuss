<script setup>
/** Progress content shared by the docked right rail and the tablet/phone drawer. */
import { computed, inject, ref, watch } from "vue";
import InviteDialog from "./InviteDialog.vue";
import DiscussionLimits from "./DiscussionLimits.vue";
import SpeakingOrder from "./SpeakingOrder.vue";

const props = defineProps({ docked: { type: Boolean, default: false } });
const { view, bridge, act, pending } = inject("discussion");
const ending = ref(false);
const COPY_FEEDBACK_MS = 2000;
const launch_copied = ref("");
let launch_copy_timer;
/** Show "已复制" on the member's copy button only after the clipboard write succeeds. */
async function copy_launch(name) {
  clearTimeout(launch_copy_timer);
  launch_copied.value = "";
  if (!await act("copy_member_launch", name)) return;
  launch_copied.value = name;
  launch_copy_timer = setTimeout(() => { launch_copied.value = ""; }, COPY_FEEDBACK_MS);
}
const focus_expanded = ref(false);
const connection = ref(null);
const connection_ready = ref(false);
const ACTIVE_TURN = ["pending", "notified"];
const LIVE_EXECUTION_TEXT = { dispatched: "已交付，等待开始", started: "执行中" };
const FOCUS_PREVIEW_LENGTH = 90;
const ERROR_PREVIEW_LENGTH = 100;
const TIMING_STAGES = [
  { key: "queue_seconds", label: "排队", hint: "事件产生到接入程序交付" },
  { key: "wake_seconds", label: "唤醒", hint: "交付到 AI 执行 enter" },
  { key: "work_seconds", label: "执行", hint: "AI 进入到保存结果或结束" },
];
const EXECUTION_STATUS_TEXT = { pending: "排队中", dispatched: "唤醒中", started: "执行中", completed: "完成", cancelled: "已撤销", failed: "失败" };
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
const runtime = computed(() => room.value.runtime || {});
const automatic = computed(() => runtime.value.mode === "automatic");
const turn = computed(() => ACTIVE_TURN.includes(room.value.current_turn?.status) ? room.value.current_turn : null);
const inactive = computed(() => ["paused", "concluded"].includes(room.value.phase));
const concluded = computed(() => room.value.phase === "concluded");
const settled = computed(() => concluded.value || room.value.archived);
// A room paused by a round limit or a declared completion before limits returned the room to free collaboration only offers ending;
// a plain restart would hit the limit again. Rooms without a round budget keep the old flow: edit the limits, then restart.
const limit_decision = computed(() => room.value.phase === "paused" && !room.value.archived && Boolean(room.value.round_budget) && ["round_limit", "goal_done"].includes(limits.value.stop_reason));
const reopening = ref(false);
const reopen_limits = ref(null);
const reopen_rounds = ref(0);
const reopen_minutes = ref(0);
const rounds_info = computed(() => bridge.limit_rounds(limits.value));
const can_reopen = computed(() => concluded.value && automatic.value && Boolean(room.value.round_budget) && !room.value.archived);
const can_restart = computed(() => automatic.value && (runtime.value.status === "paused" || runtime.value.expired)
  && !concluded.value && !room.value.archived && !limit_decision.value);
// A paused run can also skip its retained assignment and resume with the host.
const active = computed(() => ["initial", "discussing"].includes(room.value.phase) && !room.value.archived);
const can_skip = computed(() => Boolean(turn.value && (active.value || can_restart.value)));
/** Writes need this browser's room control credential; without it the board is read-only. */
const can_control = computed(() => Boolean(view.value.access?.can_manage));
const can_end = computed(() => (active.value || room.value.phase === "paused") && !room.value.archived);
/** A concluded discussion in a room with a control credential hands the room back to free collaboration. */
const can_return = computed(() => concluded.value && !room.value.archived && room.value.mode !== "free");
const has_actions = computed(() => active.value || can_restart.value || can_end.value || can_reopen.value || can_return.value);
const members = computed(() => [room.value.host, ...Object.keys(room.value.experts || {}).filter((name) => name !== room.value.host)]
  .filter((name) => name && name !== "用户").map(member_status));
const failed_member = computed(() => members.value.find((member) => member.result));
// The Codex App often takes a conversation's writer from the CLI; that failure offers the switch directly.
const codex_instance = (name) => /^Codex(?:-|$)/.test(name);
const writer_conflict = computed(() => failed_member.value && codex_instance(failed_member.value.name)
  && /active writer/.test(failed_member.value.result) ? failed_member.value : null);
// An away expert keeps its seat and session; it is not scheduled until brought back.
const away_members = computed(() => (room.value.members || []).filter((member) => member.status === "away"));
const record = (name) => (room.value.members || []).find((member) => member.name === name);
// A used platform adds another instance; the invite dialog picks woken or manual delivery.
const can_invite = computed(() => automatic.value && !settled.value);
const inviting = ref(false);
watch(() => room.value.id, () => { inviting.value = false; });
const focus = computed(() => turn.value?.question || room.value.focus || room.value.goal || "");
const focus_long = computed(() => focus.value.length > FOCUS_PREVIEW_LENGTH);
const timings = computed(() => runtime.value.timings || { items: [], totals: {}, count: 0 });
const connection_open = computed({
  get: () => connection.value?.room_id === room.value.id,
  set: (open) => { if (!open) connection.value = null; },
});
const connection_profile = computed(() => connection_ready.value && view.value.launch.repair?.room_id === room.value.id
  ? view.value.launch.repair.participants[connection.value?.name] : null);
/** One sentence that says what is happening now, plus a tone for color. */
const status = computed(() => {
  const value = room.value;
  if (value.archived) return { tone: "neutral", title: "已存档", detail: "" };
  if (concluded.value) return { tone: "neutral", title: "已收束", detail: `共完成 ${limits.value.completed_rounds || 0} 轮` };
  if (value.phase === "preparing") return { tone: "neutral", title: "准备中", detail: "讨论尚未开始" };
  if (value.phase === "paused") {
    if (view.value.free_error && !inviting.value) return { tone: "error", title: "操作失败", detail: view.value.free_error };
    const failure = failed_member.value;
    if (failure) {
      const detail = failure.result.startsWith(failure.name) ? failure.result : `${bridge.display_name(failure.name)} 执行失败：${failure.result}`;
      const summary = detail.split('\n')[0];
      const preview = summary.length > ERROR_PREVIEW_LENGTH ? `${summary.slice(0, ERROR_PREVIEW_LENGTH)}…` : summary;
      return { tone: "error", title: "已暂停", detail: preview, full_detail: detail !== preview ? detail : '' };
    }
    if (limit_decision.value) return { tone: "warning", title: limits.value.stop_reason === "goal_done" ? "目标已完成，已暂停" : "已达轮次上限，已暂停", detail: "点「结束」回到自由协作" };
    return { tone: "warning", title: runtime.value.expired ? "已到截止时间" : "已暂停", detail: turn.value ? `原安排 ${bridge.display_name(turn.value.expert)} 保留` : "" };
  }
  if (limits.value.reached) return { tone: "warning", title: "已达上限", detail: "停止新增安排" };
  return { tone: "primary", title: "进行中", detail: bridge.progress_speaker(value) };
});
/** Bars only exist for configured limits; unlimited values stay plain text. */
const meters = computed(() => {
  const value = limits.value;
  const used = Math.floor((value.elapsed_seconds || 0) / 60);
  if (settled.value) return [];
  // Show the round being discussed; once the limit is reached, show the limit.
  const info = rounds_info.value;
  const budgeted = Boolean(room.value.round_budget);
  const last_round = bridge.round_groups(room.value)?.at(-1);
  const current = budgeted ? info.done + (value.reached ? 0 : 1) : last_round?.completed === false ? last_round.number : (value.completed_rounds || 0) + 1;
  const round = info.cap ? Math.min(current, info.cap) : current;
  return [
    { label: "轮次", text: info.cap ? `${round} / ${info.cap}${info.total ? `（${info.total}）` : ""}` : `${round} 轮`,
      ratio: info.cap ? round / info.cap : null },
    { label: "用时", text: value.max_minutes ? `${used} / ${value.max_minutes} 分钟` : `${used} 分钟`,
      ratio: value.max_minutes ? used / value.max_minutes : null },
  ].filter((meter) => meter.label !== "用时" || value.started_at);
});

/** Combine assignment, round and execution evidence into one participant line. */
function member_status(name) {
  const execution = (runtime.value.participants || []).find((item) => item.participant === name);
  const speakers = room.value.rounds?.at(-1)?.completed === false ? room.value.rounds.at(-1).speakers : [];
  const is_host = name === room.value.host;
  let text = "等待";
  let tone = "neutral";
  const live = LIVE_EXECUTION_TEXT[execution?.status] || "";
  const queue_index = (room.value.queued_turns || []).findIndex((item) => item.expert === name);
  if (turn.value?.expert === name) {
    const groups = bridge.round_groups(room.value) || [];
    const round = groups.at(-1)?.completed === false ? groups.at(-1).number : groups.filter((item) => item.completed).length + 1;
    text = `第 ${round} 轮 · ${live && execution.turn_id === turn.value.id ? live : inactive.value ? "原安排保留" : record(name)?.access === "manual" ? "轮到它了，请去它的 AI 会话触发" : "轮到发言"}`;
    tone = inactive.value ? "neutral" : "primary";
  } else if (is_host && !turn.value && !inactive.value) {
    const duty = "安排下一步";
    text = live && execution.role === "host" ? `${duty} · ${live}` : duty;
    tone = "primary";
  } else if (queue_index >= 0 && !inactive.value) {
    // Its place is the row's number in the speaking order.
    text = "本轮排队";
  } else if (speakers.includes(name)) {
    text = "本轮已发言";
    tone = "success";
  }
  // A manual expert counts as present only after its own session registered with the room.
  const seat = record(name);
  if (seat?.access === "manual" && seat.status === "active" && !is_host) {
    const spoken = speakers.includes(name);
    if (!seat.registered_at) { text = `待注册${text === "等待" ? "" : ` · ${text}`}`; tone = "warning"; }
    else if (!spoken) text = `已注册${text === "等待" ? "" : ` · ${text}`}`;
  }
  if (execution?.status === "failed") { text = "执行失败"; tone = "error"; }
  if (execution?.stale) { text = "疑似卡住（租约已过期）"; tone = "warning"; }
  return { name, is_host, text, tone, manual: record(name)?.access === "manual", failures: execution?.failures || 0, result: execution?.status === "failed" ? execution.result : "",
    model: bridge.participant_model(name, room.value, view.value.launch.room_models),
    session: execution?.session_id || "", mode: bridge.participant_access(name, room.value) };
}

/** Menu entries for one participant; the session ID stays out of the row until needed. */
function member_menu(member) {
  const items = member.session ? [{ label: "复制会话 ID", icon: "i-lucide-copy", onSelect: () => act("copy", member.session) }] : [];
  if (record(member.name)?.access === "manual") items.push({ label: "复制启动指令（含凭证）", icon: "i-lucide-rocket", onSelect: () => act("copy_member_launch", member.name) });
  // A borrowed conversation already has its ID before the first successful execution records one.
  if (codex_instance(member.name) && (member.session || record(member.name)?.session_mode === "borrowed") && automatic.value && !settled.value && view.value.launch.available
    && !view.value.launch.remote && ["running", "paused"].includes(runtime.value.status)) {
    items.push({ label: "切换 App / CLI", icon: "i-lucide-arrow-left-right",
      disabled: Boolean(pending.value), onSelect: () => open_connection(member) });
  }
  const seat = record(member.name);
  if (!seat || member.is_host || settled.value) return [items].filter((group) => group.length);
  const change = (label, icon, action, extra = {}) => ({ label, icon, ...extra,
    onSelect: () => act("change_member", { member_id: seat.id, name: member.name, action }) });
  return [items, [seat.status === "away"
    ? change("请回", "i-lucide-log-in", "rejoin", { disabled: !view.value.launch.available })
    : change("暂离", "i-lucide-log-out", "away")],
  [change("移除", "i-lucide-trash-2", "remove", { color: "error" })]].filter((group) => group.length);
}

/** Open the invite dialog with a clean choice. */
function open_invite() {
  inviting.value = true;
}

/** Open the participant's connection editor without leaving the discussion. */
async function open_connection(member, prefer = "") {
  connection.value = { room_id: room.value.id, name: member.name, prefer };
  connection_ready.value = false;
  if (runtime.value.status === "paused") await read_connection();
}

/** Pause only after the explicit button, then read the same version-checked room configuration. */
async function read_connection() {
  const opened = connection.value;
  if (!opened || opened.room_id !== room.value.id) return;
  if (runtime.value.status === "running" && !await act("pause_runtime")) return;
  if (connection.value !== opened || room.value.id !== opened.room_id || runtime.value.status !== "paused") return;
  await act("load_room_configuration");
  if (connection.value === opened && room.value.id === opened.room_id) {
    connection_ready.value = !view.value.launch.repair_error && view.value.launch.repair?.room_id === opened.room_id;
    if (connection_ready.value && opened.prefer && connection_profile.value?.adapter !== opened.prefer) bridge.write_room_adapter(opened.name, opened.prefer);
  }
}

/** Share of each stage in the run's total, so the slowest stage stands out. */
const timing_shares = computed(() => {
  const totals = timings.value.totals || {};
  const sum = TIMING_STAGES.reduce((value, stage) => value + (totals[stage.key] || 0), 0);
  return TIMING_STAGES.map((stage) => ({ ...stage, seconds: totals[stage.key] || 0,
    percent: sum ? Math.round(((totals[stage.key] || 0) / sum) * 100) : 0 }));
});

/** Render whole seconds compactly; a stage that has not begun shows a dash. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}

/** Open the reopen dialog prefilled with the previous limits. */
function open_reopen() {
  reopen_rounds.value = limits.value.max_rounds || 0;
  reopen_minutes.value = limits.value.max_minutes || 0;
  reopening.value = true;
}

/** Reopen with the chosen limits; blank or invalid numbers fall back to unlimited. */
async function reopen() {
  reopen_limits.value?.settle();
  const whole = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  if (await act("reopen_discussion", { max_rounds: whole(reopen_rounds.value), max_minutes: whole(reopen_minutes.value) })) reopening.value = false;
}

/** Apply one of the two early-ending choices and close the confirmation. */
async function finish(action) {
  if (await act(action)) ending.value = false;
}
</script>

<template>
  <div class="progress-board" :class="{ 'is-docked': props.docked }">
    <header v-if="props.docked" class="pb-header"><strong>讨论进度</strong><span class="pb-mode">{{ automatic ? '全自动' : '手动' }}</span></header>
    <section class="pb-status" :class="`is-${status.tone}`" aria-label="讨论状态">
      <div class="pb-status-line"><span class="pb-dot"></span><strong role="status">{{ status.title }}</strong><span v-if="!props.docked" class="pb-mode">{{ automatic ? '全自动' : '手动' }}</span></div>
      <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
      <details v-if="status.full_detail" class="pb-status-detail"><summary>查看错误详情</summary><pre class="pb-error-detail">{{ status.full_detail }}</pre></details>
      <UButton v-if="writer_conflict && view.launch.available && !view.launch.remote" icon="i-lucide-arrow-left-right" label="切换到 Codex App" size="xs" color="neutral" variant="outline" title="会话正被 Codex App 占用时，改由 App 接入，沿用原聊天和讨论进度" :disabled="Boolean(pending)" @click="open_connection(writer_conflict, 'codex')" />
      <div v-if="meters.length" class="pb-meters">
        <div v-for="meter in meters" :key="meter.label" class="pb-meter">
          <div class="pb-meter-label"><span>{{ meter.label }}</span><b>{{ meter.text }}</b></div>
          <div v-if="meter.ratio !== null" class="pb-bar"><i :style="{ width: `${Math.min(100, Math.round(meter.ratio * 100))}%` }"></i></div>
        </div>
      </div>
    </section>
    <section v-if="focus" class="pb-section" aria-label="当前焦点">
      <h4>当前焦点</h4>
      <p class="pb-focus" :class="{ 'is-expanded': focus_expanded }">{{ focus }}</p>
      <button v-if="focus_long" type="button" class="pb-link" @click="focus_expanded = !focus_expanded">{{ focus_expanded ? '收起' : '展开' }}</button>
    </section>
    <section class="pb-section" aria-label="发言顺序">
      <div class="pb-heading"><h4>发言顺序</h4><button v-if="can_invite" type="button" class="pb-link" @click="open_invite"><UIcon name="i-lucide-plus" />邀请</button></div>
      <p v-if="room.held_since && turn && !inactive" class="pb-status-detail pb-held">用户有新操作，{{ bridge.display_name(turn.expert) }} 说完后交给主持人</p>
      <SpeakingOrder :away="away_members.map((member) => member.name)">
        <template #default="{ item }">
          <template v-if="item.state === 'away'">
            <UAvatar :src="bridge.identities[item.name]?.icon" :text="bridge.identities[item.name]?.initials" :alt="item.name" size="xs" class="channel-avatar" :class="bridge.identities[item.name]?.style" />
            <div class="pb-member-body">
              <div class="pb-member-name">{{ bridge.display_name(item.name) }}<small>暂离</small></div>
              <div class="pb-member-status is-neutral"><span class="pb-dot"></span>保留位置和会话，不参与安排</div>
            </div>
            <UDropdownMenu v-if="member_menu({ name: item.name }).length" :items="member_menu({ name: item.name })" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${item.name} 的更多操作`" /></UDropdownMenu>
          </template>
          <template v-else v-for="member in [member_status(item.name)]" :key="member.name">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="pb-member-body">
              <div class="pb-member-name">{{ bridge.display_name(member.name) }}<UIcon v-if="member.is_host" name="i-lucide-crown" title="主持人" /><small>{{ member.is_host ? `主持 · ${member.mode}` : member.mode }}</small></div>
              <div v-if="member.model" class="pb-member-model" title="本场启动配置；默认模型与默认强度由对应软件决定">{{ member.model }}</div>
              <div v-if="record(member.name)?.session_mode === 'borrowed'" class="pb-member-model" title="续接你已有的会话；它工作时请不要在原窗口继续操作">借用已有会话</div>
              <div v-if="!settled" class="pb-member-status" :class="`is-${member.tone}`"><span class="pb-dot"></span>{{ member.text }}<small v-if="member.failures"> · 失败 {{ member.failures }} 次</small></div>
              <div v-if="member.manual && !settled" class="pb-member-manual">
                <span v-if="!record(member.name)?.registered_at && !member.is_host">需在它的会话中注册，才算到场</span>
                <button v-if="can_control" type="button" class="pb-link" @click="copy_launch(member.name)"><UIcon :name="launch_copied === member.name ? 'i-lucide-check' : 'i-lucide-rocket'" />{{ launch_copied === member.name ? '已复制' : '复制启动指令' }}</button>
              </div>
            </div>
            <UDropdownMenu v-if="member_menu(member).length" :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
          </template>
        </template>
      </SpeakingOrder>
      <p v-if="!inviting && view.free_error && room.phase !== 'paused'" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
      <p v-else-if="view.free_notice" role="status" class="pb-free-note">{{ view.free_notice }}</p>
    </section>
    <section v-if="has_actions" class="pb-actions" aria-label="操作">
      <UButton v-if="can_restart" icon="i-lucide-rotate-ccw" label="重启" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="原安排重新交给对应 AI，需本机接入程序在运行" :loading="pending === 'restart_discussion'" :disabled="!can_control" @click="act('restart_discussion')" />
      <UButton v-if="active" icon="i-lucide-pause" label="暂停" size="sm" color="neutral" variant="outline" class="pb-action" title="暂停讨论，原安排保留" :loading="pending === 'pause_discussion'" :disabled="!can_control" @click="act('pause_discussion')" />
      <UButton v-if="can_skip" icon="i-lucide-skip-forward" label="跳过" size="sm" color="neutral" variant="outline" class="pb-action" :title="`跳过 ${bridge.display_name(turn.expert)} 本次发言，${can_restart ? '恢复讨论，' : ''}交给主持人继续安排`" :loading="pending === 'skip_turn'" :disabled="!can_control || Boolean(pending)" @click="act('skip_turn')" />
      <UButton v-if="can_reopen" icon="i-lucide-rotate-ccw" label="重新开始" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="保留全部记录，设定新的轮次与时长上限后继续讨论，需本机接入程序在运行" :disabled="!can_control || Boolean(pending)" @click="open_reopen" />
      <UButton v-if="can_return" icon="i-lucide-users" label="回到自由协作" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="结束讨论，房间继续自由协作；全部记录与结论保留" :loading="pending === 'end_room_discussion'" :disabled="!can_control || Boolean(pending)" @click="act('end_room_discussion')" />
      <UButton v-if="can_end" icon="i-lucide-flag" label="结束" size="sm" color="neutral" variant="outline" class="pb-action pb-end" title="结束讨论，房间回到自由协作" :disabled="!can_control" @click="ending = true" />
    </section>
    <section v-if="automatic && timings.count" class="pb-section" aria-label="阶段耗时">
      <div class="pb-timing-heading"><h4>耗时</h4><small>共 {{ timings.count }} 次执行</small></div>
      <div class="pb-timing-bar" role="img" :aria-label="timing_shares.map((stage) => `${stage.label} ${stage.percent}%`).join('，')">
        <i v-for="stage in timing_shares" :key="stage.key" :class="`is-${stage.key}`" :style="{ width: `${stage.percent}%` }"></i>
      </div>
      <dl class="pb-timing-totals">
        <div v-for="stage in timing_shares" :key="stage.key" :title="stage.hint"><dt><span :class="`pb-timing-dot is-${stage.key}`"></span>{{ stage.label }}</dt><dd>{{ duration(stage.seconds) }}<small>{{ stage.percent }}%</small></dd></div>
      </dl>
      <details class="pb-timings">
        <summary>查看每次执行</summary>
        <ol>
          <li v-for="item in timings.items" :key="item.id">
            <span class="pb-timing-who">#{{ item.id }} {{ bridge.display_name(item.participant) }}<small>{{ item.role === "host" ? "主持" : "专家" }} · {{ EXECUTION_STATUS_TEXT[item.status] || item.status }}</small></span>
            <span class="pb-timing-stages"><span v-for="stage in TIMING_STAGES" :key="stage.key" :title="stage.hint">{{ stage.label }} {{ duration(item[stage.key]) }}</span></span>
          </li>
        </ol>
        <p v-if="timings.count > timings.items.length" class="pb-note">只列出最近 {{ timings.items.length }} 次，共 {{ timings.count }} 次执行。</p>
      </details>
    </section>
    <UModal v-model:open="connection_open" title="切换 Codex 接入方式" description="沿用原聊天和讨论进度，仅修改本场讨论。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <div class="pb-connection">
          <template v-if="runtime.status === 'running'">
            <p>切换前需要暂停讨论，当前执行会停止，原发言安排保留。</p>
            <UButton label="暂停并读取配置" icon="i-lucide-pause" class="channel-primary-button" :loading="Boolean(pending)" @click="read_connection" />
          </template>
          <template v-else-if="runtime.status === 'paused'">
            <template v-if="connection_profile">
              <UFormField label="接入方式"><USelect :model-value="connection_profile.adapter" :items="[{ label: 'Codex App', value: 'codex' }, { label: 'Codex CLI', value: 'codex_cli' }]" class="w-full" :disabled="Boolean(pending)" @update:model-value="bridge.write_room_adapter(connection.name, $event)" /></UFormField>
              <p class="fine-print">{{ connection_profile.adapter === 'codex' ? 'App 需保持运行，模型与权限沿用原聊天设置。' : '切回 CLI 前，需让 App 释放原聊天；仍被占用时无法执行。' }}</p>
              <UButton label="保存接入方式" class="channel-primary-button" :loading="pending === 'save_room_configuration'" :disabled="Boolean(pending)" @click="act('save_room_configuration')" />
              <p v-if="view.launch.repair?.notice" role="status" class="fine-print">{{ view.launch.repair.notice }}</p>
              <UButton v-if="view.launch.repair?.applied && can_restart" label="重启讨论" icon="i-lucide-rotate-ccw" variant="outline" color="neutral" :loading="pending === 'restart_discussion'" :disabled="Boolean(pending)" @click="act('restart_discussion'); connection_open = false" />
            </template>
            <UButton v-else label="读取本场配置" variant="outline" color="neutral" :loading="Boolean(pending)" @click="read_connection" />
            <p v-if="view.launch.repair_error" role="alert" class="fine-print">{{ view.launch.repair_error }}</p>
          </template>
          <p v-else>本场状态已变化，请关闭后重新核对。</p>
        </div>
      </template>
    </UModal>
    <InviteDialog v-model:open="inviting" description="新专家由程序按本机软件配置启动，或由你手动启动，加入本轮发言队列。" />
    <UModal v-model:open="reopening" title="重新开始讨论" description="保留全部记录和原结论，按新的上限继续。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <form class="pb-reopen" @submit.prevent="reopen">
          <DiscussionLimits ref="reopen_limits" v-model:rounds="reopen_rounds" v-model:minutes="reopen_minutes" :execution="false" />
          <div class="pb-invite-footer">
            <UButton label="取消" color="neutral" variant="ghost" @click="reopening = false" />
            <UButton type="submit" icon="i-lucide-rotate-ccw" label="重新开始" class="channel-primary-button" :loading="pending === 'reopen_discussion'" :disabled="Boolean(pending)" />
          </div>
        </form>
      </template>
    </UModal>
    <UModal v-model:open="ending" title="结束讨论" description="当前发言安排会被取消，已有消息全部保留。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <div class="progress-ending">
          <button type="button" class="progress-ending-option" :disabled="concluded || !!pending" @click="finish('end_room_discussion')">
            <strong>结束讨论</strong><span>保留全部记录，自动运行随之停止，房间回到自由协作；需要总结时可直接请主持人写一份。</span>
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.pb-member.is-away { opacity: .6; }
.pb-member-model { margin: 2px 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.pb-reopen { display: grid; gap: 14px; }
.pb-connection { display: grid; gap: 16px; }
.pb-connection > p { margin: 0; }
.pb-connection > button { justify-self: start; }
.pb-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.pb-heading h4 { margin: 0; }
.pb-heading .pb-link { display: inline-flex; align-items: center; gap: 3px; margin: 0; }
.pb-member-manual { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; margin-top: 4px; color: var(--ui-text-dimmed); font-size: 12px; line-height: 1.5; }
.pb-member-manual .pb-link { margin-top: 0; }
.pb-member-body .pb-link { display: inline-flex; align-items: center; gap: 3px; }
.pb-heading .pb-link > span, .pb-member-body .pb-link > span { width: 12px; height: 12px; }
</style>

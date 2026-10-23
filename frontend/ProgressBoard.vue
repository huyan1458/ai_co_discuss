<script setup>
/** Progress content shared by the docked right rail and the tablet/phone drawer. */
import { computed, inject, ref, watch } from "vue";
import ExpertCard from "./ExpertCard.vue";

const props = defineProps({ docked: { type: Boolean, default: false } });
const { view, bridge, act, pending } = inject("discussion");
const ending = ref(false);
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
const can_restart = computed(() => automatic.value && (runtime.value.status === "paused" || runtime.value.expired)
  && !concluded.value && !room.value.archived);
// Actions appear only when they apply: running phases can pause, interrupt or end; paused ones restart or end.
const active = computed(() => ["initial", "discussing", "reviewing"].includes(room.value.phase) && !room.value.archived);
/** Writes need this browser's room control credential; without it the board is read-only. */
const can_control = computed(() => Boolean(view.value.access?.can_manage));
const can_end = computed(() => (active.value || room.value.phase === "paused") && !room.value.archived);
const has_actions = computed(() => active.value || can_restart.value || can_end.value);
const can_close = computed(() => !inactive.value && room.value.phase !== "preparing" && !room.value.archived && !limits.value.closing);
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
// Discussions only admit members the local service wakes; a used platform adds another instance.
const can_invite = computed(() => automatic.value && !settled.value);
const invite_name = ref("");
const invite_session = ref("");
const inviting = ref(false);
// Board errors from earlier actions stay out of the dialog until this invite is submitted.
const invite_tried = ref(false);
const invite_choices = computed(() => Object.keys(bridge.launch_clients));
const taken_names = computed(() => (room.value.members || []).map((member) => member.name));
const invite_count = (platform) => taken_names.value.filter((name) => bridge.platform_of(name) === platform).length;
// Mirrors the instance name the invite assigns, so the dialog says which seat the card will take.
const invite_instance = computed(() => {
  let instance = invite_name.value;
  for (let number = 2; taken_names.value.includes(instance); number++) instance = `${invite_name.value}-${number}`;
  return instance;
});
/** Same readiness rule as the create form: the card's back must name a runnable entry. */
const invite_status = computed(() => {
  const profile = view.value.launch.profiles[invite_name.value] || {};
  const api = profile.adapter === "api";
  const ready = api ? Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model)
    : Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
  return ready ? { text: api ? "已配置 API" : "已配置本机软件", tone: "ready" } : { text: api ? "待补齐 API 配置" : "待补齐接入配置", tone: "warn" };
});
watch(() => room.value.id, () => { inviting.value = false; invite_name.value = ""; invite_session.value = ""; });
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
  if (limits.value.closing) return { tone: "warning", title: "正在收尾", detail: `等待 ${bridge.display_name(value.host)} 总结` };
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
  return [
    { label: "轮次", text: value.max_rounds ? `${value.completed_rounds || 0} / ${value.max_rounds}` : `${value.completed_rounds || 0} 轮`,
      ratio: value.max_rounds ? (value.completed_rounds || 0) / value.max_rounds : null },
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
    const round = room.value.rounds?.at(-1)?.completed === false ? room.value.rounds.at(-1).number : (room.value.completed_rounds || 0) + 1;
    text = `第 ${round} 轮 · ${live && execution.turn_id === turn.value.id ? live : inactive.value ? "原安排保留" : "轮到发言"}`;
    tone = inactive.value ? "neutral" : "primary";
  } else if (is_host && !turn.value && !inactive.value) {
    const duty = limits.value.closing ? "总结收尾中" : "安排下一步";
    text = live && execution.role === "host" ? `${duty} · ${live}` : duty;
    tone = "primary";
  } else if (queue_index >= 0 && !inactive.value) {
    text = `本轮排队 · 第 ${queue_index + 1} 位`;
  } else if (speakers.includes(name)) {
    text = "本轮已发言";
    tone = "success";
  }
  if (execution?.status === "failed") { text = "执行失败"; tone = "error"; }
  if (execution?.stale) { text = "疑似卡住（租约已过期）"; tone = "warning"; }
  return { name, is_host, text, tone, failures: execution?.failures || 0, result: execution?.status === "failed" ? execution.result : "",
    model: bridge.participant_model(name, room.value, view.value.launch.room_models),
    session: execution?.session_id || "", mode: bridge.participant_access(name, room.value) };
}

/** Menu entries for one participant; the session ID stays out of the row until needed. */
function member_menu(member) {
  const items = member.session ? [{ label: "复制会话 ID", icon: "i-lucide-copy", onSelect: () => act("copy", member.session) }] : [];
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
  // Voiding is only offered while paused, for an expert counted in the unfinished round.
  const last_round = room.value.rounds?.at(-1);
  const voidable = room.value.phase === "paused" && last_round?.completed === false && last_round.speakers.includes(member.name);
  return [items, voidable ? [change("作废本轮发言", "i-lucide-undo-2", "redo")] : [], [seat.status === "away"
    ? change("请回", "i-lucide-log-in", "rejoin", { disabled: !view.value.launch.available })
    : change("暂离", "i-lucide-log-out", "away")],
  [change("移除", "i-lucide-trash-2", "remove", { color: "error" })]].filter((group) => group.length);
}

/** Open the card library with a clean choice; earlier notices belong to the board. */
function open_invite() {
  invite_name.value = "";
  invite_session.value = "";
  invite_tried.value = false;
  inviting.value = true;
}

/** Pick a library card; a platform without local software starts on its API, as in the create form. */
function pick_invite(name) {
  if (!bridge.launch_clients[name]?.some((item) => item.value !== "api") && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api");
  invite_name.value = name;
}

/** Invite through the local service, which configures the expert from its card before the room admits it. */
async function invite() {
  const profile = view.value.launch.profiles[invite_name.value] || {};
  invite_tried.value = true;
  await act("invite_member", { name: invite_name.value, access: "runner",
    project_access: profile.project_access || view.value.launch.workspace?.project_access || "read",
    session_id: bridge.launch_can_bind_session(invite_name.value, view.value.launch) ? invite_session.value : "" });
  if (!view.value.free_error) inviting.value = false;
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
    <section class="pb-section" aria-label="参与者">
      <div class="pb-heading"><h4>参与者</h4><button v-if="can_invite" type="button" class="pb-link" @click="open_invite"><UIcon name="i-lucide-plus" />邀请</button></div>
      <p v-if="room.held_since && turn && !inactive" class="pb-status-detail pb-held">用户有新操作，{{ bridge.display_name(turn.expert) }} 说完后交给主持人</p>
      <ul class="pb-members">
        <li v-for="member in members" :key="member.name" class="pb-member">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <div class="pb-member-body">
            <div class="pb-member-name">{{ bridge.display_name(member.name) }}<UIcon v-if="member.is_host" name="i-lucide-crown" title="主持人" /><small>{{ member.is_host ? `主持 · ${member.mode}` : member.mode }}</small></div>
            <div class="pb-member-model" title="本场启动配置；默认模型与默认强度由对应软件决定">{{ member.model }}</div>
            <div v-if="record(member.name)?.session_mode === 'borrowed'" class="pb-member-model" title="续接你已有的会话；它工作时请不要在原窗口继续操作">借用已有会话</div>
            <div v-if="!settled" class="pb-member-status" :class="`is-${member.tone}`"><span class="pb-dot"></span>{{ member.text }}<small v-if="member.failures"> · 失败 {{ member.failures }} 次</small></div>
          </div>
          <UDropdownMenu v-if="member_menu(member).length" :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
        </li>
        <li v-for="member in away_members" :key="member.id" class="pb-member is-away">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <div class="pb-member-body">
            <div class="pb-member-name">{{ bridge.display_name(member.name) }}<small>暂离</small></div>
            <div class="pb-member-status is-neutral"><span class="pb-dot"></span>保留位置和会话，不参与安排</div>
          </div>
          <UDropdownMenu v-if="member_menu({ name: member.name }).length" :items="member_menu({ name: member.name })" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
        </li>
      </ul>
      <p v-if="!inviting && view.free_error && room.phase !== 'paused'" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
      <p v-else-if="view.free_notice" role="status" class="pb-free-note">{{ view.free_notice }}</p>
    </section>
    <section v-if="has_actions" class="pb-actions" aria-label="操作">
      <UButton v-if="can_restart" icon="i-lucide-rotate-ccw" label="重启" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="原安排重新交给对应 AI，需本机接入程序在运行" :loading="pending === 'restart_discussion'" :disabled="!can_control" @click="act('restart_discussion')" />
      <UButton v-if="active" icon="i-lucide-pause" label="暂停" size="sm" color="neutral" variant="outline" class="pb-action" title="暂停讨论，原安排保留" :loading="pending === 'pause_discussion'" :disabled="!can_control" @click="act('pause_discussion')" />
      <UButton v-if="active && turn" icon="i-lucide-hand" label="打断" size="sm" color="neutral" variant="outline" class="pb-action" :title="`打断 ${bridge.display_name(turn.expert)}：本次发言作废，交给主持人`" :loading="pending === 'cancel_turn'" :disabled="!can_control" @click="act('cancel_turn')" />
      <UButton v-if="can_end" icon="i-lucide-flag" label="结束" size="sm" color="neutral" variant="outline" class="pb-action pb-end" title="结束讨论：选择主持人收尾或直接结束" :disabled="!can_control" @click="ending = true" />
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
    <UModal v-model:open="inviting" title="邀请专家" description="新专家沿用本机软件配置，讨论不中断；主持人会重新安排发言。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <form class="pb-invite" aria-label="邀请专家" @submit.prevent="invite">
          <div class="pb-invite-library" role="group" aria-label="选择 AI">
            <button v-for="name in invite_choices" :key="name" type="button" :aria-pressed="invite_name === name" :title="invite_count(name) ? `已在场 ${invite_count(name)} 位 · 将添加新实例` : ''" @click="pick_invite(name)">
              <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="3xs" class="channel-avatar" :class="bridge.identities[name]?.style" />{{ name }}
            </button>
          </div>
          <template v-if="invite_name">
            <ExpertCard :key="invite_name" :name="invite_name" mode="cli" :status="invite_status" @remove="invite_name = ''" />
            <p v-if="invite_instance !== invite_name" class="fine-print">已有 {{ invite_name }} 在场，将以 {{ invite_instance }} 加入，使用独立会话。</p>
            <UFormField v-if="bridge.launch_can_bind_session(invite_name, view.launch)" label="已有会话 ID（可选）" :description="invite_session.trim() ? '将续接这个原会话，保留它原有的上下文；它工作时请不要在原窗口继续操作。' : '留空则新建会话。'">
              <UInput v-model="invite_session" placeholder="在原会话中用 /status 查看；Codex App 填聊天 ID" aria-label="受邀成员的已有会话 ID" class="w-full" />
            </UFormField>
          </template>
          <p v-else class="pb-invite-empty">选择一位 AI，点卡片翻面设置软件、模型与项目权限。</p>
          <p v-if="!view.launch.available" role="alert" class="fine-print">邀请需要本机服务，请在运行 AI 的电脑打开本机网站。</p>
          <p v-if="invite_tried && view.free_error" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
          <div class="pb-invite-footer">
            <UButton label="取消" color="neutral" variant="ghost" @click="inviting = false" />
            <UButton type="submit" icon="i-lucide-user-plus" label="邀请" class="channel-primary-button" :disabled="!invite_name || !view.launch.available || invite_status.tone === 'warn'" :loading="pending === 'invite_member'" />
          </div>
        </form>
      </template>
    </UModal>
    <UModal v-model:open="ending" title="提前结束讨论" description="当前发言安排会被取消，已有消息全部保留。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <div class="progress-ending">
          <button type="button" class="progress-ending-option" :disabled="!can_close || !!pending" @click="finish('force_close')">
            <strong>请主持人收尾</strong><span>立即进入收束，由 {{ bridge.display_name(room.host) }} 在 {{ limits.summary_minutes || 5 }} 分钟收束预留内根据已有材料总结。</span><small v-if="!can_close">{{ limits.closing ? '已在收尾中。' : '仅进行中的讨论可以收尾；暂停后可先重启再收尾，或直接结束并保留记录。' }}</small>
          </button>
          <button type="button" class="progress-ending-option" :disabled="concluded || !!pending" @click="finish('conclude_discussion')">
            <strong>直接结束（不总结）</strong><span>保留全部记录，阶段设为“已收束”，自动运行随之停止。</span>
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.pb-member.is-away { opacity: .6; }
.pb-member-model { margin: 2px 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.pb-connection { display: grid; gap: 16px; }
.pb-connection > p { margin: 0; }
.pb-connection > button { justify-self: start; }
.pb-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.pb-heading h4 { margin: 0; }
.pb-heading .pb-link { display: inline-flex; align-items: center; gap: 3px; margin: 0; }
.pb-heading .pb-link > span { width: 12px; height: 12px; }
.pb-invite { display: flex; flex-direction: column; gap: 14px; }
.pb-invite > .expert-card { width: min(100%, 320px); }
.pb-invite .fine-print { margin: -6px 0 0; }
.pb-invite-library { display: flex; flex-wrap: wrap; gap: 6px; }
.pb-invite-library > button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 10px 2px 4px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.pb-invite-library > button:hover { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.pb-invite-library > button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--channel-accent) 55%, transparent); background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
.pb-invite-library .channel-avatar { flex-shrink: 0; width: 20px; height: 20px; font-size: 9px; }
.pb-invite-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.pb-invite-footer { display: flex; justify-content: flex-end; gap: 8px; }
@media (pointer: coarse) { .pb-invite-library > button { min-height: 44px; } }
</style>

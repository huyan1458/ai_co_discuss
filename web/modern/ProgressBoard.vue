<script setup>
/** Progress content shared by the docked right rail and the tablet/phone drawer. */
import { computed, inject, ref } from "vue";

const props = defineProps({ docked: { type: Boolean, default: false } });
const { view, bridge, act, pending } = inject("discussion");
const ending = ref(false);
const focus_expanded = ref(false);
const ACTIVE_TURN = ["pending", "notified"];
const LIVE_EXECUTION_TEXT = { dispatched: "已交付，等待开始", started: "执行中" };
const FOCUS_PREVIEW_LENGTH = 90;
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
const can_end = computed(() => (active.value || room.value.phase === "paused") && !room.value.archived);
const has_actions = computed(() => active.value || can_restart.value || can_end.value);
const can_close = computed(() => !inactive.value && room.value.phase !== "preparing" && !room.value.archived && !limits.value.closing);
const members = computed(() => [room.value.host, ...Object.keys(room.value.experts || {}).filter((name) => name !== room.value.host)]
  .filter((name) => name && name !== "用户").map(member_status));
const failed_member = computed(() => members.value.find((member) => member.result));
const focus = computed(() => turn.value?.question || room.value.focus || room.value.goal || "");
const focus_long = computed(() => focus.value.length > FOCUS_PREVIEW_LENGTH);
const timings = computed(() => runtime.value.timings || { items: [], totals: {}, count: 0 });
/** One sentence that says what is happening now, plus a tone for color. */
const status = computed(() => {
  const value = room.value;
  if (value.archived) return { tone: "neutral", title: "已存档", detail: "" };
  if (concluded.value) return { tone: "neutral", title: "已收束", detail: `共完成 ${limits.value.completed_rounds || 0} 轮` };
  if (limits.value.closing) return { tone: "warning", title: "正在收尾", detail: `等待 ${bridge.display_name(value.host)} 总结` };
  if (value.phase === "preparing") return { tone: "neutral", title: "准备中", detail: "讨论尚未开始" };
  if (value.phase === "paused") {
    const failure = failed_member.value;
    if (failure) return { tone: "error", title: "已暂停", detail: failure.result.startsWith(failure.name) ? failure.result : `${bridge.display_name(failure.name)} 执行失败：${failure.result}` };
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
    session: execution?.session_id || "", mode: room.value.experts?.[name] === "cli" ? "CLI" : "在线" };
}

/** Menu entries for one participant; the session ID stays out of the row until needed. */
function member_menu(member) {
  return [[{ label: "复制会话 ID", icon: "i-lucide-copy", onSelect: () => act("copy", member.session) }]];
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
      <h4>参与者</h4>
      <p v-if="room.held_since && turn && !inactive" class="pb-status-detail pb-held">用户有新操作，{{ bridge.display_name(turn.expert) }} 说完后交给主持人</p>
      <ul class="pb-members">
        <li v-for="member in members" :key="member.name" class="pb-member">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <div class="pb-member-body">
            <div class="pb-member-name">{{ bridge.display_name(member.name) }}<UIcon v-if="member.is_host" name="i-lucide-crown" title="主持人" /><small>{{ member.is_host ? `主持 · ${member.mode}` : member.mode }}</small></div>
            <div v-if="!settled" class="pb-member-status" :class="`is-${member.tone}`"><span class="pb-dot"></span>{{ member.text }}<small v-if="member.failures"> · 失败 {{ member.failures }} 次</small></div>
          </div>
          <UDropdownMenu v-if="member.session" :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
        </li>
      </ul>
    </section>
    <section v-if="has_actions" class="pb-actions" aria-label="操作">
      <UButton v-if="can_restart" icon="i-lucide-rotate-ccw" label="重启" size="sm" color="neutral" variant="outline" class="pb-action pb-restart" title="原安排重新交给对应 AI，需本机接入程序在运行" :loading="pending === 'restart_discussion'" @click="act('restart_discussion')" />
      <UButton v-if="active" icon="i-lucide-pause" label="暂停" size="sm" color="neutral" variant="outline" class="pb-action" :loading="pending === 'pause_discussion'" @click="act('pause_discussion')" />
      <UButton v-if="active && turn" icon="i-lucide-hand" :label="`打断 ${bridge.display_name(turn.expert)}`" size="sm" color="neutral" variant="outline" class="pb-action" title="本次发言作废，交给主持人" :loading="pending === 'cancel_turn'" @click="act('cancel_turn')" />
      <UButton v-if="can_end" icon="i-lucide-flag" label="结束讨论…" size="sm" color="neutral" variant="outline" class="pb-action pb-end" @click="ending = true" />
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
    <UModal v-model:open="ending" title="提前结束讨论" description="当前发言安排会被取消，已有消息全部保留。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <div class="progress-ending">
          <button type="button" class="progress-ending-option" :disabled="!can_close || !!pending" @click="finish('force_close')">
            <strong>强行收尾</strong><span>立即进入收束，由 {{ bridge.display_name(room.host) }} 在 {{ limits.summary_minutes || 5 }} 分钟收束预留内根据已有材料总结。</span><small v-if="!can_close">{{ limits.closing ? '已在收尾中。' : '仅进行中的讨论可以收尾；已暂停时请选择直接丢弃。' }}</small>
          </button>
          <button type="button" class="progress-ending-option" :disabled="concluded || !!pending" @click="finish('conclude_discussion')">
            <strong>直接丢弃</strong><span>不再总结，阶段直接设为“已收束”，自动运行随之停止。</span>
          </button>
        </div>
      </template>
    </UModal>
  </div>
</template>

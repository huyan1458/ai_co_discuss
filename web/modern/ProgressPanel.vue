<script setup>
import { computed, inject, ref, watch } from "vue";

const { view, bridge, act, pending } = inject("discussion");
const PANEL_KEY = "ai-codiscuss-progress-panel";
const ACTIVE_TURN = ["pending", "notified"];
const LIVE_EXECUTION_TEXT = { dispatched: "已交付，等待开始", started: "执行中" };
const TIMING_STAGES = [
  { key: "queue_seconds", label: "排队", hint: "事件产生到接入程序交付" },
  { key: "wake_seconds", label: "唤醒", hint: "交付到 AI 执行 enter" },
  { key: "work_seconds", label: "执行", hint: "AI 进入到保存结果或结束" },
];
const EXECUTION_STATUS_TEXT = { pending: "排队中", dispatched: "唤醒中", started: "执行中", completed: "完成", cancelled: "已撤销", failed: "失败" };
const expanded = ref(read_expanded());
const ending = ref(false);
watch(expanded, (value) => {
  try { localStorage.setItem(PANEL_KEY, JSON.stringify({ expanded: value })); }
  catch { /* The panel still toggles for this page. */ }
});
const room = computed(() => view.value.room);
const limits = computed(() => room.value.limits || {});
const runtime = computed(() => room.value.runtime || {});
const turn = computed(() => ACTIVE_TURN.includes(room.value.current_turn?.status) ? room.value.current_turn : null);
const inactive = computed(() => ["paused", "concluded"].includes(room.value.phase));
const concluded = computed(() => room.value.phase === "concluded");
const can_close = computed(() => !inactive.value && room.value.phase !== "preparing" && !room.value.archived && !limits.value.closing);
const rounds = computed(() => limits.value.max_rounds ? `${limits.value.completed_rounds || 0} / ${limits.value.max_rounds}` : `${limits.value.completed_rounds || 0} · 不限`);
const elapsed = computed(() => {
  if (!limits.value.started_at) return "尚未计时";
  const used = Math.floor((limits.value.elapsed_seconds || 0) / 60);
  return limits.value.max_minutes ? `${used} / ${limits.value.max_minutes} 分钟` : `${used} 分钟 · 不限`;
});
const mode = computed(() => runtime.value.mode === "automatic" ? "全自动" : "手动");
const run_status = computed(() => runtime.value.expired ? "已到截止" : ({ ready: "未启动", running: "运行中", paused: "已暂停", stopped: "已停止", concluded: "已收束" }[runtime.value.status] || "未启动"));
const tone = computed(() => concluded.value ? "neutral" : limits.value.closing ? "warning" : inactive.value ? "neutral" : limits.value.reached ? "warning" : "primary");
const headline = computed(() => limits.value.closing && !inactive.value ? "正在收尾 · 等待主持人总结" : bridge.progress_speaker(room.value));
const timings = computed(() => runtime.value.timings || { items: [], totals: {}, count: 0 });
const members = computed(() => [room.value.host, ...Object.keys(room.value.experts || {}).filter((name) => name !== room.value.host)]
  .filter((name) => name && name !== "用户").map(member_status));

/** Restore the last expanded state without failing when storage is unavailable. */
function read_expanded() {
  try { return JSON.parse(localStorage.getItem(PANEL_KEY))?.expanded === true; }
  catch { return false; }
}

/** Combine assignment, round and execution evidence into one participant line. */
function member_status(name) {
  const execution = (runtime.value.participants || []).find((item) => item.participant === name);
  const speakers = room.value.rounds?.at(-1)?.completed === false ? room.value.rounds.at(-1).speakers : [];
  const is_host = name === room.value.host;
  let text = "等待";
  let color = "neutral";
  const live = LIVE_EXECUTION_TEXT[execution?.status] || "";
  if (turn.value?.expert === name) {
    const round = room.value.rounds?.at(-1)?.completed === false ? room.value.rounds.at(-1).number : (room.value.completed_rounds || 0) + 1;
    text = `第 ${round} 轮 · ${live && execution.turn_id === turn.value.id ? live : inactive.value ? "已暂停，原安排保留" : "轮到发言"}`;
    color = inactive.value ? "neutral" : "primary";
  } else if (is_host && !turn.value && !inactive.value) {
    const duty = limits.value.closing ? "总结收尾中" : "主持人安排中";
    text = live && execution.role === "host" ? `${duty} · ${live}` : duty;
    color = "primary";
  } else if (speakers.includes(name)) {
    text = "本轮已发言";
  }
  if (execution?.status === "failed") { text = "执行失败"; color = "error"; }
  if (execution?.stale) { text = "疑似卡住（租约已过期）"; color = "warning"; }
  return { name, is_host, text, color, failures: execution?.failures || 0, result: execution?.status === "failed" ? execution.result : "",
    mode: room.value.experts?.[name] === "cli" ? "CLI" : "在线" };
}

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
  <div class="progress-panel-anchor">
    <button type="button" class="progress-chip" :class="`is-${tone}`" :aria-expanded="expanded" aria-controls="progress-panel" :title="expanded ? '收起进度看板' : '展开进度看板'" @click="expanded = !expanded">
      <span class="progress-dot"></span><span class="progress-chip-text">{{ bridge.progress_round(room) }}</span><UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
    </button>
    <section v-if="expanded" id="progress-panel" class="progress-panel" aria-label="讨论进度看板">
      <header class="progress-panel-heading"><strong>讨论进度</strong><UBadge color="neutral" variant="subtle" size="sm">{{ bridge.phases[room.phase] }}</UBadge><UButton icon="i-lucide-minus" color="neutral" variant="ghost" size="xs" aria-label="收起进度看板" class="progress-collapse" @click="expanded = false" /></header>
      <p class="progress-headline" role="status">{{ headline }}</p>
      <dl class="progress-stats">
        <div><dt>完成轮次</dt><dd>{{ rounds }}</dd></div>
        <div><dt>用时</dt><dd>{{ elapsed }}</dd></div>
        <div><dt>推进方式</dt><dd>{{ mode }} · {{ run_status }}</dd></div>
        <div><dt>发言权</dt><dd>{{ bridge.floor_status(room) }}</dd></div>
      </dl>
      <p v-if="limits.reached && !inactive && !limits.closing" class="progress-warning">已达讨论上限，停止新增安排。</p>
      <ul class="progress-members" aria-label="参与专家状态">
        <li v-for="member in members" :key="member.name">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <span class="progress-member-name">{{ bridge.display_name(member.name) }}<UIcon v-if="member.is_host" name="i-lucide-crown" title="主持人" /><small>{{ member.mode }}</small></span>
          <span class="progress-member-status"><UBadge :color="member.color" variant="subtle" size="sm">{{ member.text }}</UBadge><small v-if="member.failures">累计失败 {{ member.failures }} 次</small></span>
          <small v-if="member.result" class="progress-member-result" :title="member.result">{{ member.result }}</small>
        </li>
      </ul>
      <section v-if="runtime.mode === 'automatic' && timings.count" class="progress-timings" aria-label="阶段耗时">
        <h4>阶段耗时 <small>本次运行 {{ timings.count }} 次执行</small></h4>
        <dl class="progress-stats progress-timing-totals">
          <div v-for="stage in TIMING_STAGES" :key="stage.key" :title="stage.hint"><dt>{{ stage.label }}</dt><dd>{{ duration(timings.totals[stage.key] || 0) }}</dd></div>
        </dl>
        <ol class="progress-timing-list">
          <li v-for="item in timings.items" :key="item.id">
            <span class="progress-timing-who">#{{ item.id }} {{ bridge.display_name(item.participant) }}<small>{{ item.role === "host" ? "主持" : "专家" }} · {{ EXECUTION_STATUS_TEXT[item.status] || item.status }}</small></span>
            <span class="progress-timing-stages"><span v-for="stage in TIMING_STAGES" :key="stage.key" :title="stage.hint">{{ stage.label }} {{ duration(item[stage.key]) }}</span></span>
          </li>
        </ol>
      </section>
      <p v-if="runtime.mode !== 'automatic'" class="fine-print">手动模式没有执行回执，状态只按安排与发言推断。</p>
      <div class="progress-actions">
        <UButton icon="i-lucide-pause" label="暂停" size="sm" color="neutral" variant="outline" :disabled="inactive || room.archived" :loading="pending === 'pause_discussion'" @click="act('pause_discussion')" />
        <UButton icon="i-lucide-hand" label="打断发言" size="sm" color="neutral" variant="outline" :disabled="!turn" :loading="pending === 'cancel_turn'" :title="turn ? `取消 ${turn.expert} 的发言安排 #${turn.id}` : '当前没有进行中的发言'" @click="act('cancel_turn')" />
        <UButton icon="i-lucide-square" label="提前结束" size="sm" color="error" variant="soft" :disabled="concluded" @click="ending = true" />
      </div>
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

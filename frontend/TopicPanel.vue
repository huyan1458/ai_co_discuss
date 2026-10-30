<script setup>
import { computed, inject } from "vue";
import { motion } from "motion-v";

const props = defineProps({ section: { type: String, required: true } });
defineEmits(["open", "detail"]);
const { view, bridge, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
const turn = computed(() => room.value?.current_turn);
const active_turn = computed(() => turn.value && ["open", "pending", "notified"].includes(turn.value.status));
const paused = computed(() => room.value?.session?.status === "paused");
const base = computed(() => `${location.origin}/r/${room.value?.id}`);
const execution = computed(() => room.value?.free?.executions?.[0]);
const repair = computed(() => view.value.launch.repair?.room_id === room.value?.id ? view.value.launch.repair : null);
const EXECUTION_LABELS = { dispatched: "唤醒中", started: "执行中", completed: "已完成", failed: "失败", cancelled: "已停止" };
</script>

<template>
  <motion.section class="merged-section" :class="{ 'access-page': props.section === 'access', 'host-page': props.section === 'host' }" :aria-label="props.section === 'host' ? '当前讨论' : '接入'" :initial="{ opacity: 0, y: 5 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: 0.16 }">
    <template v-if="props.section === 'host'">
      <div class="page-heading"><div><span class="eyebrow">讨论进程</span><h2>当前讨论</h2><p>当前由 {{ bridge.display_name(room.host) }} 主持，围绕具体问题组织下一轮发言。</p></div><UButton icon="i-lucide-pencil" label="编辑议题" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('open', 'edit')" /></div>
      <div class="topic-brief"><div><h3>讨论目标</h3><p>{{ room.session?.goal || room.goal || '待主持人根据用户原文补全' }}</p></div><div><h3>当前焦点</h3><p>{{ room.focus || '尚未设置当前焦点' }}</p></div></div>
      <div v-if="room.limits" class="host-progress"><span>进度</span><p>{{ bridge.limits_label(room.limits) }}</p><UBadge :color="paused ? 'warning' : 'neutral'" variant="subtle">{{ paused ? '已暂停' : '讨论中' }}</UBadge></div>
      <section v-if="active_turn" class="turn-panel host-turn"><div class="turn-header"><h3>当前发言安排</h3><UBadge color="primary" variant="subtle">{{ bridge.turn_label(turn, room) }}</UBadge></div>
        <div class="turn-expert"><UAvatar :src="bridge.identities[turn.expert]?.icon" :text="bridge.identities[turn.expert]?.initials" :alt="turn.expert" class="message-mark channel-avatar" :class="bridge.identities[turn.expert]?.style" /><div><strong>{{ turn.expert }}</strong><small>发言安排 #{{ turn.id }}</small></div></div><p class="turn-question">{{ turn.question }}</p>
        <p class="fine-print">{{ bridge.turn_guidance(turn, room) }}</p>
      </section>
      <p v-else class="host-last-turn">{{ paused ? '讨论已暂停，继续后由主持人重新安排。' : '等待主持人安排下一步。' }}</p>
      <div class="form-footer"><a :href="`${base}/turns`" target="_blank" rel="noopener" class="subtle-link">发言安排历史 <UIcon name="i-lucide-arrow-up-right" /></a></div>
    </template>
    <template v-else>
      <div class="page-heading access-heading"><div><h2>本机连接</h2><p>成员的接入操作在上方；讨论暂停后可修正本机软件连接。</p></div></div>
      <section v-if="execution" class="host-progress access-evidence" aria-label="实际执行进展" role="status"><span>最近执行</span><p>#{{ execution.id }} {{ bridge.display_name(execution.member) }} · {{ EXECUTION_LABELS[execution.status] || execution.status }}</p></section>
      <section v-if="paused && view.launch.available && !room.archived && !view.launch.remote" class="access-setup access-repair" aria-label="本机接入设置">
        <div class="access-repair-heading"><h3>修正本场软件连接</h3><UButton label="读取本场配置" variant="outline" color="neutral" class="channel-surface-button" :loading="pending === 'load_room_configuration'" @click="act('load_room_configuration')" /></div>
        <div class="access-repair-description"><p>修正软件路径，或切换 Codex 的 App / CLI 接入。保留原房间和会话，保存后到进度看板继续。</p><p class="fine-print">App 需保持运行，模型与文件权限沿用原聊天设置。切回 CLI 前，需让 App 释放原聊天。</p></div>
        <div v-if="repair" class="access-repair-fields">
          <div v-for="(profile, name) in repair.participants" :key="name" class="form-two-columns">
            <UFormField v-if="['codex', 'codex_cli'].includes(profile.adapter)" :label="`${name} · 接入方式`"><USelect :model-value="profile.adapter" :items="[{ label: 'Codex App', value: 'codex' }, { label: 'Codex CLI', value: 'codex_cli' }]" class="w-full" @update:model-value="bridge.write_room_adapter(name, $event)" /></UFormField>
            <UFormField :label="`${name} · ${profile.adapter === 'antigravity' ? 'Sidecar 目录' : '软件路径'}`"><UInput :model-value="profile[profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable'] || ''" class="w-full" @update:model-value="bridge.write_room_connection(name, $event)" /></UFormField>
          </div>
          <UButton label="保存本场接入设置" class="channel-primary-button" :loading="pending === 'save_room_configuration'" @click="act('save_room_configuration')" />
        </div>
      </section>
      <p v-else-if="paused && view.launch.remote" class="fine-print">线上连接暂不提供已登记房间的软件路径修正。</p>
      <p v-else-if="!paused" class="fine-print">讨论正在运行；需要修正连接时，先在进度看板暂停。</p>
      <p v-else class="fine-print">本机服务未连接，启动后可读取配置。</p>
    </template>
  </motion.section>
</template>

<style scoped>
.access-page { color: var(--ui-text); }
.access-heading { align-items: flex-start; }
.access-heading > span { margin-top: 2px; white-space: nowrap; }
.access-evidence { margin-bottom: 18px; overflow-wrap: anywhere; }
.access-evidence > .fine-print { flex-basis: 100%; margin: 0; }
.access-section-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.access-section-title h3 { font-size: 13px; font-weight: 600; color: var(--ui-text-highlighted); }
.access-repair { display: grid; gap: 14px; margin: 16px 0; padding: 18px; border: 1px solid var(--ui-border); border-radius: 8px; }
.access-repair-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.access-repair-heading h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.access-repair-heading > button { flex-shrink: 0; }
.access-repair-description { display: grid; gap: 6px; }
.access-repair-description > p { margin: 0; font-size: 12px; line-height: 1.8; }
.access-repair-description > .fine-print { font-size: 11px; }
.access-repair-fields { display: grid; gap: 16px; padding-top: 16px; border-top: 1px solid var(--ui-border-muted); }
.access-repair-fields > button { justify-self: start; }
.access-repair > .fine-print, .access-repair-fields > .fine-print { margin: 0; }
.access-host-entry { margin: 16px 0 22px; color: var(--ui-text-muted); font-size: 12px; line-height: 1.8; }
.access-host-entry code { padding: 2px 5px; border-radius: 4px; background: var(--ui-bg-elevated); color: var(--ui-text); font-size: 11px; white-space: nowrap; }
.access-steps { list-style: none; margin: 0; padding: 0; }
.access-steps > li { display: flex; align-items: flex-start; gap: 14px; padding: 20px 0; }
.access-steps > li + li { border-top: 1px solid var(--ui-border-muted); }
.access-steps > li > div { flex: 1; min-width: 0; }
.access-step-number { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--ui-border); border-radius: 50%; color: var(--ui-text-muted); font-size: 12px; }
.access-steps h4 { margin: 1px 0 6px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.access-steps p, .access-disclosure-body > p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.8; }
.access-steps > li > button { flex-shrink: 0; margin-top: 2px; }
.access-command { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 5px 7px 5px 13px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-bg-muted); }
.access-command code { flex: 1; min-width: 0; font-size: 12px; color: var(--ui-text); overflow-wrap: anywhere; }
.access-command > button { flex-shrink: 0; color: var(--ui-text-muted); }
.access-disclosure { border-top: 1px solid var(--ui-border-muted); }
.access-disclosure > summary { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 14px 0; cursor: pointer; list-style: none; font-size: 12px; color: var(--ui-text); }
.access-disclosure summary::-webkit-details-marker, .access-reading summary::-webkit-details-marker { display: none; }
.access-disclosure > summary > span:first-child { flex: 1; }
.access-disclosure summary small { margin-left: 6px; color: var(--ui-text-dimmed); font-size: 11px; }
.disclosure-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--ui-text-muted); }
.access-disclosure[open] > summary .disclosure-icon { transform: rotate(180deg); }
.access-disclosure-body { padding: 0 0 20px; }
.access-workspace .form-two-columns, .access-disclosure-body > .button-row { margin-top: 16px; }
.access-instructions .access-section { padding: 18px 0 22px; }
.access-instructions .access-section:last-of-type { border-bottom: 0; }
.access-instructions .access-icon { background: var(--ui-bg-elevated); border-color: var(--ui-border); color: var(--ui-text-muted); border-radius: 7px; box-shadow: none; }
.access-reading { margin-top: 14px; }
.access-reading > summary { display: inline-block; cursor: pointer; color: var(--ui-text-muted); font-size: 12px; list-style: none; text-decoration: underline; text-underline-offset: 3px; }
.access-reading .access-address { margin: 12px 0; }
.access-limit-summary { font-size: 11px; color: var(--ui-text-muted); }
.access-failure { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 22px; padding: 12px 14px; border-left: 2px solid var(--ui-warning); background: color-mix(in srgb, var(--ui-warning) 5%, transparent); border-radius: 0 6px 6px 0; color: var(--ui-warning); }
.access-failure > span { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
.access-failure > div { min-width: 0; }
.access-failure strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 500; }
.access-failure summary { cursor: pointer; margin-top: 6px; color: var(--ui-text-muted); font-size: 11px; }
/* The progress of a discussion reads as one line; the rail's board carries the live detail. */
.host-progress { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px; border: 1px solid var(--ui-border-muted); border-radius: 10px; font-size: 13px; }
.host-progress > span { color: var(--ui-text-muted); }
.host-progress > p { flex: 1; min-width: 200px; margin: 0; color: var(--ui-text); line-height: 1.7; }
.host-last-turn { display: flex; flex-wrap: wrap; gap: 10px; color: var(--ui-text-muted); font-size: 12px; }
.access-failure p { margin-top: 8px; color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; line-height: 1.7; }
@media (max-width: 640px) {
  .access-page .access-repair button { min-height: 44px; }
  .access-workspace .form-two-columns { grid-template-columns: 1fr; }
  .access-steps > li { flex-wrap: wrap; gap: 10px; padding: 17px 0; }
  .access-steps > li > div { flex-basis: calc(100% - 34px); }
  .access-steps > li > button { margin-left: 34px; min-height: 44px; }
  .access-command > button { min-width: 44px; min-height: 44px; }
  .access-page :is(button, a), .access-reading > summary, .access-failure summary { min-height: 44px; }
  .access-reading > summary, .access-failure summary { display: flex; align-items: center; }
  .access-limit-summary { max-width: 45%; text-align: right; }
  .access-instructions .button-row > :is(button, a) { min-height: 44px; }
}
</style>

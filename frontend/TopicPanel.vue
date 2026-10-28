<script setup>
import { computed, inject } from "vue";
import { motion, useReducedMotion } from "motion-v";
import LaunchSettings from "./LaunchSettings.vue";

// "host" is the running discussion's arrangement, "access" how members take part; each is one section of a merged page.
const props = defineProps({ section: { type: String, required: true } });
defineEmits(["open", "detail"]);
const { view, bridge, act, pending } = inject("discussion");
const reduced_motion = useReducedMotion();
const room = computed(() => view.value.room);
const turn = computed(() => room.value?.current_turn);
const active_turn = computed(() => turn.value && ["pending", "notified"].includes(turn.value.status));
const inactive = computed(() => ["paused", "concluded"].includes(room.value?.phase));
const can_schedule = computed(() => !active_turn.value && !inactive.value && !room.value?.limits?.reached && Object.keys(room.value?.experts || {}).length > 0);
const base = computed(() => `${location.origin}/r/${room.value?.id}`);
const automatic = computed(() => room.value?.runtime?.mode === "automatic");
const access = computed(() => view.value.access || {});
const execution = computed(() => room.value?.runtime?.latest_execution);
const repair = computed(() => view.value.launch.repair?.room_id === room.value?.id ? view.value.launch.repair : null);
const runtime_status = computed(() => room.value?.runtime?.expired ? "已到截止时间" : ({ ready: "尚未启动", running: "自动推进已启用", paused: "已暂停", stopped: "已停止", concluded: "已收束" }[room.value?.runtime?.status] || "尚未启动"));
const register_command = computed(() => `codiscuss add --config "discussion-${room.value?.id}.json"`);
// A manual expert answers with its own credential, so the local service has nothing to configure for it.
const woken_participants = computed(() => {
  const manual = new Set((access.value.members || []).filter((member) => member.access === "manual").map((member) => member.name));
  return [room.value?.host, ...Object.keys(room.value?.experts || {})].filter((name) => !manual.has(name));
});
</script>

<template>
  <motion.section class="merged-section" :class="{ 'access-page': props.section === 'access', 'host-page': props.section === 'host' }" :aria-label="props.section === 'host' ? '当前讨论' : '接入'" :initial="{ opacity: 0, y: reduced_motion ? 0 : 5 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: 0.16 }">
    <template v-if="props.section === 'host'">
      <div class="page-heading"><div><span class="eyebrow">讨论进程</span><h2>当前讨论</h2><p>当前由 {{ bridge.display_name(room.host) }} 主持，围绕具体问题组织下一轮发言。</p></div><UButton icon="i-lucide-pencil" label="编辑议题" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('open', 'edit')" /></div>
      <div class="topic-brief"><div><h3>讨论目标</h3><p>{{ room.goal || '待主持人根据用户原文补全' }}</p></div><div><h3>当前焦点</h3><p>{{ room.focus || '尚未设置当前焦点' }}</p></div></div>
      <div v-if="room.limits" class="host-progress"><span>进度</span><p>{{ bridge.limits_label(room.limits) }}</p><UBadge :color="room.limits.reached && room.phase !== 'concluded' ? 'warning' : 'neutral'" variant="subtle">{{ room.phase === 'concluded' ? '已收束' : room.limits.reached ? '已达上限' : room.limits.started_at ? '已开始计时' : '尚未计时' }}</UBadge><UButton v-if="room.limits.reached && !inactive" label="检查并执行到限处理" size="xs" variant="outline" color="neutral" :loading="pending === 'check_limits'" @click="act('check_limits')" /></div>
      <section v-if="active_turn" class="turn-panel host-turn"><div class="turn-header"><h3>当前发言安排</h3><UBadge color="primary" variant="subtle">{{ bridge.turn_label(turn, room) }}</UBadge></div>
        <div class="turn-expert"><UAvatar :src="bridge.identities[turn.expert]?.icon" :text="bridge.identities[turn.expert]?.initials" :alt="turn.expert" class="message-mark channel-avatar" :class="bridge.identities[turn.expert]?.style" /><div><strong>{{ turn.expert }}</strong><small>发言安排 #{{ turn.id }}</small></div></div><p class="turn-question">{{ turn.question }}</p>
        <div v-if="!automatic" class="button-row turn-actions"><UButton icon="i-lucide-copy" label="复制通知" :disabled="inactive" color="neutral" variant="outline" class="channel-surface-button" @click="act('copy_turn')" /><UButton icon="i-lucide-check-check" label="确认已通知" color="neutral" variant="outline" class="channel-surface-button" :disabled="inactive || turn.status !== 'pending'" :loading="pending === 'notify'" @click="act('notify')" /><UButton v-if="room.experts[turn.expert] === 'online'" icon="i-lucide-message-square-plus" label="录入在线回答" :disabled="inactive" class="channel-primary-button" @click="act('prepare_answer')" /><UButton label="取消安排" color="neutral" variant="ghost" @click="act('cancel_turn')" /></div>
        <p class="fine-print">{{ bridge.turn_guidance(turn, room) }}</p>
      </section>
      <p v-else-if="turn" class="host-last-turn">最近一次安排：{{ bridge.display_name(turn.expert) }} · #{{ turn.id }} · {{ bridge.turn_label(turn, room) }}<button v-if="turn.answer_id" type="button" class="subtle-link" @click="$emit('detail', turn.answer_id)">查看回答原文</button></p>
      <div class="form-footer"><a :href="`${base}/turns`" target="_blank" rel="noopener" class="subtle-link">发言安排历史 <UIcon name="i-lucide-arrow-up-right" /></a><UButton v-if="!automatic" icon="i-lucide-plus" label="安排下一位专家" class="channel-primary-button" :disabled="!can_schedule" @click="$emit('open', 'schedule')" /></div>
      <p v-if="!automatic && !can_schedule" class="fine-print host-schedule-hint">{{ inactive ? '话题已暂停或收束，修改阶段后可以继续安排。' : active_turn ? '先完成或取消当前安排，再安排下一位。' : room.limits?.reached ? '已达到讨论上限，请检查到限处理；需要继续时先暂停并调整参数。' : '请先在议题资料中配置参与专家。' }}</p>
    </template>
    <template v-else>
      <div class="page-heading access-heading">
        <div><h2>本机启动</h2><p>讨论由本机服务唤醒 AI：在这里启动或修正软件连接；成员的接入操作在上方成员表。</p></div>
        <UBadge v-if="automatic" :color="room.runtime?.status === 'running' ? 'primary' : 'neutral'" variant="subtle">{{ runtime_status }}</UBadge>
      </div>
      <section v-if="automatic" class="host-progress access-evidence" aria-label="实际执行进展" role="status"><span>最近执行</span><p>{{ bridge.execution_label(execution) }}</p><p v-if="room.runtime?.status === 'running' && (!execution || ['pending', 'dispatched'].includes(execution.status))" class="fine-print">尚无 AI 进入记录。请核对本机服务及对应软件的登录和工具权限。</p></section>
      <section v-if="automatic && view.launch.available" class="access-setup" aria-label="网页启动入口">
        <template v-if="room.runtime?.status === 'ready'">
          <div class="access-section-title"><h3>从网页启动</h3></div>
          <LaunchSettings :participants="woken_participants" />
          <UButton label="启动讨论" icon="i-lucide-play" class="channel-primary-button" :loading="pending === 'launch_current_room'" @click="act('launch_current_room')" />
        </template>
        <div v-else-if="room.runtime?.status === 'paused' && !room.archived && !view.launch.remote" class="access-repair">
          <div class="access-repair-heading">
            <h3>修正本场软件连接</h3>
            <UButton label="读取本场配置" variant="outline" color="neutral" class="channel-surface-button" :loading="pending === 'load_room_configuration'" @click="act('load_room_configuration')" />
          </div>
          <div class="access-repair-description">
            <p>修正软件路径，或切换 Codex 的 App / CLI 接入。保留原房间、发言进度和会话，保存后到进度看板重启。</p>
            <p class="fine-print">App 需保持运行，模型与文件权限在 App 内设置。切回 CLI 前须让 App 释放原聊天；未释放时执行仍会暂停。</p>
          </div>
          <div v-if="repair" class="access-repair-fields">
            <div v-for="(profile, name) in repair.participants" :key="name" class="form-two-columns">
              <UFormField v-if="['codex', 'codex_cli'].includes(profile.adapter)" :label="`${name} · 接入方式`"><USelect :model-value="profile.adapter" :items="[{ label: 'Codex App', value: 'codex' }, { label: 'Codex CLI', value: 'codex_cli' }]" class="w-full" @update:model-value="bridge.write_room_adapter(name, $event)" /></UFormField>
              <UFormField :label="`${name} · ${profile.adapter === 'antigravity' ? 'Sidecar 目录' : '软件路径'}`"><UInput :model-value="profile[profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable'] || ''" class="w-full" @update:model-value="bridge.write_room_connection(name, $event)" /></UFormField>
            </div>
            <UButton label="保存本场接入设置" class="channel-primary-button" :loading="pending === 'save_room_configuration'" @click="act('save_room_configuration')" />
            <p v-if="repair.notice" role="status" class="fine-print">{{ repair.notice }}</p>
          </div>
          <p v-if="view.launch.repair_error" role="alert" class="fine-print">{{ view.launch.repair_error }}</p>
        </div>
        <p v-else-if="room.runtime?.status === 'paused' && view.launch.remote" class="fine-print">讨论已暂停，可在进度看板重启。线上连接暂不提供已登记房间的软件路径修正。</p>
        <p v-else-if="room.runtime?.status === 'running'" class="fine-print">讨论正在运行。</p>
        <p v-else class="fine-print">本场讨论已停止或结束，已有记录保留。</p>
        <p class="access-host-entry">另一种入口：在 AI 工具对话中调用 <code>discuss-host</code>，由当前会话主持。</p>
      </section>
      <section v-else-if="automatic" class="access-setup" aria-label="全自动接入步骤">
        <LaunchSettings :participants="woken_participants" />
        <details><summary>手动下载与登记配置</summary>
        <div class="access-section-title"><h3>首次接入</h3><a href="https://github.com/huyan1458/ai_co_discuss/blob/main/docs/runner.md#常驻讨论服务" target="_blank" rel="noopener" class="subtle-link">配置说明 <UIcon name="i-lucide-arrow-up-right" /></a></div>
        <ol class="access-steps">
          <li><span class="access-step-number">1</span><div><h4>下载接入配置</h4><p>包含当前房间信息。下载后，补齐本机软件路径与会话配置。</p></div><UButton v-if="room.runtime?.protected" icon="i-lucide-download" label="下载接入配置" class="channel-primary-button" :loading="pending === 'export_runtime'" @click="act('export_runtime')" /></li>
          <li><span class="access-step-number">2</span><div><h4>登记到本机服务</h4><p>在下载文件所在目录执行；也可以将文件名换成完整路径。</p><div class="access-command"><code>{{ register_command }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制房间登记命令" @click="act('copy', register_command)" /></div></div></li>
          <li><span class="access-step-number">3</span><div><h4>启动服务，保持终端打开</h4><p>启动服务不会自动开始讨论。已暂停的讨论可在进度看板点“重启”。</p><div class="access-command"><code>codiscuss</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制服务启动命令" @click="act('copy', 'codiscuss')" /></div></div></li>
        </ol>
        </details>
      </section>
      <details v-if="!automatic || !view.launch.available" class="access-disclosure access-workspace">
        <summary><span>项目与工作目录 <small>可选</small></span><UIcon name="i-lucide-chevron-down" class="disclosure-icon" /></summary>
        <div class="access-disclosure-body"><p>指定 AI 使用的本机项目和目录，留空使用默认位置。仅保存在本机配置中。</p><div class="form-two-columns"><UFormField label="AI 软件中的项目"><UInput :model-value="view.fields['runtime-project']" placeholder="项目名称" class="w-full" @update:model-value="bridge.write_field('runtime-project', $event)" /></UFormField><UFormField label="工作目录"><UInput :model-value="view.fields['runtime-cwd']" placeholder="已有本机目录的完整路径" class="w-full" @update:model-value="bridge.write_field('runtime-cwd', $event)" /></UFormField></div></div>
      </details>
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

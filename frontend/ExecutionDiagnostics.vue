<script setup>
import { computed, inject, ref, watch } from "vue";
import { t } from "./i18n.js";
import { format_duration } from "./timeline-model.js";

const props = defineProps({ room: { type: String, required: true }, execution: { type: Number, required: true } });
const { bridge } = inject("discussion");
const diagnostics = ref(null);
const REFRESH_MS = 5000;
const ACTIVE = new Set(["dispatched", "started"]);
const time = (ms) => ms ? new Date(ms).toLocaleString() : t('未知');
const duration = (ms) => ms ? format_duration(ms) : t('未知');
const timeout = computed(() => ({ total: t('总时限'), idle: t('无进展时限') }[diagnostics.value?.timeout_kind] || t('未知')));
const layers = computed(() => ({ model: t('模型请求'), adapter: t('适配器重启'), runner: t('接入程序') }));
const states = computed(() => ({ started: t('已开始'), ended: t('已结束'), succeeded: t('成功'), failed: t('失败'), waiting: t('等待') }));
const modes = computed(() => ({ resume: t('续接会话'), redeliver: t('重新投递') }));
const files = computed(() => diagnostics.value?.file_attribution);

watch(() => [props.room, props.execution], ([room, execution], _, on_cleanup) => {
  let closed = false;
  let timer;
  diagnostics.value = null;
  on_cleanup(() => { closed = true; clearTimeout(timer); });
  async function refresh() {
    try {
      const detail = await bridge.request(`/api/rooms/${encodeURIComponent(room)}/executions/${execution}`);
      if (closed) return;
      diagnostics.value = detail.diagnostics || {};
      if (ACTIVE.has(detail.status)) timer = setTimeout(refresh, REFRESH_MS);
    } catch {
      if (!closed && !diagnostics.value) diagnostics.value = {};
    }
  }
  refresh();
}, { immediate: true });
</script>

<template>
  <section v-if="diagnostics" class="run-diagnostics">
    <h4>{{ t('执行诊断') }}</h4>
    <dl>
      <dt>{{ t('最后续租') }}</dt><dd>{{ time(diagnostics.last_heartbeat_at) }}</dd>
      <dt>{{ t('最后模型或工具进展') }}</dt><dd>{{ time(diagnostics.last_activity_at) }}</dd>
      <dt>{{ t('总时限') }}</dt><dd>{{ duration(diagnostics.timeout_limits?.total_ms) }}</dd>
      <dt>{{ t('无进展时限') }}</dt><dd>{{ duration(diagnostics.timeout_limits?.idle_ms) }}</dd>
      <dt>{{ t('触发的时限') }}</dt><dd>{{ timeout }}</dd>
      <dt>{{ t('执行重试') }}</dt>
      <dd>
        <ul v-if="diagnostics.retries?.length">
          <li v-for="(retry, index) in diagnostics.retries" :key="index">
            {{ layers[retry.layer] }} · {{ states[retry.state] }}<template v-if="retry.attempt"> · {{ t('第 {value1} 次', { value1: retry.attempt }) }}</template><template v-if="retry.mode"> · {{ modes[retry.mode] }}</template><template v-if="retry.at"> · {{ time(retry.at) }}</template>
          </li>
        </ul>
        <template v-else>{{ t('未知') }}</template>
      </dd>
      <dt>{{ t('插话确认') }}</dt>
      <dd>
        <ul v-if="diagnostics.interjections">
          <li v-for="(receipt, id) in diagnostics.interjections" :key="id">
            #{{ id }} · {{ receipt.transport === 'resumed_turn' ? t('续接时送交') : t('执行中送交') }} ·
            {{ receipt.status === 'failed' ? t('送交失败') : receipt.confirmed_at ? time(receipt.confirmed_at) : t('确认时间未知') }}
          </li>
        </ul>
        <template v-else>{{ t('未知') }}</template>
      </dd>
      <dt>{{ t('当次工作流绑定') }}</dt>
      <dd>
        <ul v-if="diagnostics.workflow_bindings?.length">
          <li v-for="(workflow, index) in diagnostics.workflow_bindings" :key="index">
            <template v-if="workflow">
              {{ [workflow.id, workflow.revision, workflow.card].filter(Boolean).join(' · ') }}
              <template v-if="workflow.sub_workflow"> · {{ [workflow.sub_workflow, workflow.sub_revision].filter(Boolean).join(' · ') }}</template>
              <small v-if="workflow.skills.length">{{ t('关联技能 {value1}', { value1: workflow.skills.join(', ') }) }}</small>
            </template>
            <template v-else>{{ t('未绑定工作流') }}</template>
          </li>
        </ul>
        <template v-else>{{ t('未知') }}</template>
      </dd>
      <dt>{{ t('文件改动归因') }}</dt>
      <dd v-if="files">
        {{ files.provisional ? t('临时报告') : t('最终报告') }} · {{ t('观察到 {value1} 个文件变化', { value1: files.observed }) }} ·
        {{ files.recorded_writes === null ? t('写入记录未知') : t('记录本次写入 {value1} 个文件', { value1: files.recorded_writes }) }}
        <small v-if="files.omitted">{{ t('另有 {value1} 个文件未列出', { value1: files.omitted }) }}</small>
        <ul v-if="files.paths?.length">
          <li v-for="file in files.paths" :key="file.path"><code>{{ file.path }}</code> · {{ file.recorded_write === null ? t('写入记录未知') : file.recorded_write ? t('记录本次写入') : t('只有快照变化') }}</li>
        </ul>
      </dd>
      <dd v-else>{{ t('未知') }}</dd>
    </dl>
  </section>
</template>

<style scoped>
.run-diagnostics { display: grid; gap: 8px; min-width: 0; font-size: 12px; }
h4 { margin: 0; color: var(--ui-text-muted); }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; margin: 0; }
dt { color: var(--ui-text-muted); }
dd, ul { margin: 0; overflow-wrap: anywhere; }
ul { padding-inline-start: 1rem; }
small { display: block; font-size: inherit; }
</style>

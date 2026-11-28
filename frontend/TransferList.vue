<script setup>
/** The file page's transfer list (state and rules in transfers.js), shown above its project and cloud space views. */
import { computed } from "vue";
import { t } from "./i18n.js";
import { clear_finished, clear_transfer, transfers } from "./transfers.js";

const KINDS = computed(() => ({ drive: t("上传到云空间"), project: t("上传到项目"), prepare: t("准备下载"), land: t("取回到项目"), copy: t("存到云空间"), purge: t("彻底删除") }));
const STATES = computed(() => ({ queued: t("等待中"), running: t("进行中"), done: t("已完成"), failed: t("失败"), cancelled: t("已取消"),
  interrupted: t("已中断，请重新选择文件") }));
const icon = (row) => row.status === "failed" ? "i-lucide-circle-alert" : row.status === "done" ? "i-lucide-circle-check"
  : row.kind === "prepare" ? "i-lucide-cloud-download" : row.kind === "land" ? "i-lucide-folder-down" : "i-lucide-cloud-upload";
const finished = computed(() => transfers.rows.some((row) => !["queued", "running", "failed"].includes(row.status)));
</script>

<template>
  <section v-if="transfers.rows.length" class="transfer-list" :aria-label="t('传输列表')">
    <header>
      <span>{{ t("传输列表") }}</span>
      <button v-if="finished" type="button" @click="clear_finished">{{ t("清除已完成") }}</button>
    </header>
    <div v-for="row in transfers.rows" :key="row.id" class="transfer-row" :class="`is-${row.status}`">
      <UIcon :name="icon(row)" />
      <span class="transfer-name" :title="row.name">{{ row.name }}</span>
      <small class="transfer-kind">{{ KINDS[row.kind] || "" }}</small>
      <span class="transfer-state">
        <template v-if="row.status === 'running'">{{ Math.round(row.progress * 100) }}%</template>
        <template v-else-if="row.status === 'failed'">{{ row.error || STATES.failed }}</template>
        <template v-else>{{ STATES[row.status] }}</template>
      </span>
      <UButton v-if="row.cancel" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="t('取消 {name}', { name: row.name })" @click="row.cancel()" />
      <UButton v-else-if="row.retry" icon="i-lucide-rotate-cw" color="neutral" variant="ghost" size="xs" :aria-label="t('重试 {name}', { name: row.name })" @click="row.retry()" />
      <UButton v-if="!row.cancel && row.status !== 'queued'" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="t('清除 {name}', { name: row.name })" @click="clear_transfer(row.id)" />
    </div>
  </section>
</template>

<style scoped>
.transfer-list { display: grid; gap: 2px; margin-bottom: 10px; padding: 6px 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; font-size: 12px; }
.transfer-list header { display: flex; justify-content: space-between; align-items: center; padding: 2px 2px 4px; color: var(--ui-text-muted); }
.transfer-list header button { color: inherit; font: inherit; background: none; border: 0; cursor: pointer; text-decoration: underline; }
.transfer-row { display: flex; gap: 8px; align-items: center; min-height: 28px; }
.transfer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer-kind { flex-shrink: 0; color: var(--ui-text-muted); }
.transfer-state { flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.transfer-row.is-failed .transfer-state, .transfer-row.is-interrupted .transfer-state { color: #e65c58; }
.transfer-row.is-done .transfer-state { color: #2aa875; }
</style>

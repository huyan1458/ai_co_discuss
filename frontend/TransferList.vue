<script setup>
/** The file page's transfer popover. Transfer state and rules live in transfers.js. */
import { computed } from "vue";
import { t } from "./i18n.js";
import { clear_finished, clear_transfer, transfers } from "./transfers.js";

const KINDS = computed(() => ({ drive: t("上传到云空间"), project: t("上传到项目"), prepare: t("准备下载"), land: t("取回到项目"), copy: t("存到云空间"), purge: t("彻底删除"), download: t("下载"), delete: t("移到回收区") }));
const STATES = computed(() => ({ queued: t("等待中"), running: t("进行中"), done: t("已完成"), failed: t("失败"), cancelled: t("已取消"),
  interrupted: t("已中断，请重新选择文件") }));
const icon = (row) => row.status === "failed" ? "i-lucide-circle-alert" : row.status === "done" ? "i-lucide-circle-check"
  : row.kind === "prepare" ? "i-lucide-cloud-download" : row.kind === "land" ? "i-lucide-folder-down" : "i-lucide-cloud-upload";
const finished = computed(() => transfers.rows.some((row) => !["queued", "running", "failed"].includes(row.status)));
</script>

<template>
  <div class="transfer-anchor">
    <UPopover :content="{ align: 'end', sideOffset: 4 }">
      <UButton icon="i-lucide-arrow-down-up" color="neutral" variant="ghost" size="xs" :label="t('传输列表')"
        :aria-label="t('传输列表')" />
      <template #content>
        <section class="transfer-list" :aria-label="t('传输列表')">
          <header>
            <span>{{ t("传输列表") }}</span>
            <button type="button" :disabled="!finished" :title="!finished ? t('暂无已完成的传输') : undefined" @click="clear_finished">{{ t("清除已完成") }}</button>
          </header>
          <p v-if="!transfers.rows.length" class="transfer-empty">{{ t('暂无传输') }}</p>
          <div v-for="row in transfers.rows" :key="row.id" class="transfer-row" :class="`is-${row.status}`">
            <UIcon :name="icon(row)" />
            <span class="transfer-name" :title="row.name">{{ row.name }}</span>
            <small class="transfer-kind">{{ KINDS[row.kind] || "" }}</small>
            <span class="transfer-state" :title="row.error || STATES[row.status]">
              <template v-if="row.status === 'running'">{{ Math.round(row.progress * 100) }}%</template>
              <template v-else-if="row.status === 'failed'">{{ row.error || STATES.failed }}</template>
              <template v-else>{{ STATES[row.status] }}</template>
            </span>
            <div class="transfer-actions">
              <UButton v-if="row.cancel" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="t('取消 {name}', { name: row.name })" @click="row.cancel()" />
              <UButton v-else-if="row.retry" icon="i-lucide-rotate-cw" color="neutral" variant="ghost" size="xs" :aria-label="t('重试 {name}', { name: row.name })" @click="row.retry()" />
              <UButton v-if="!row.cancel && row.status !== 'queued'" class="transfer-clear" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="t('清除 {name}', { name: row.name })" @click="clear_transfer(row.id)" />
            </div>
          </div>
        </section>
      </template>
    </UPopover>
  </div>
</template>

<style scoped>
.transfer-anchor { display: flex; justify-content: flex-end; }
.transfer-list { display: grid; gap: 2px; inline-size: min(420px, calc(100vw - 24px)); max-block-size: min(360px, 50dvh); overflow: auto; scrollbar-gutter: stable; padding: 6px 8px; font-size: 12px; }
.transfer-list header { display: flex; justify-content: space-between; align-items: center; padding: 2px 2px 4px; color: var(--ui-text-muted); }
.transfer-list header button { color: inherit; font: inherit; background: none; border: 0; cursor: pointer; text-decoration: underline; }
.transfer-list header button:disabled { opacity: .5; cursor: default; }
.transfer-empty { margin: 4px 2px; color: var(--ui-text-muted); }
.transfer-row { display: flex; gap: 8px; align-items: center; min-height: 28px; }
.transfer-actions { display: grid; flex: 0 0 auto; grid-template-columns: repeat(2, 24px); }
.transfer-clear { grid-column: 2; }
.transfer-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer-kind { flex-shrink: 0; color: var(--ui-text-muted); }
.transfer-state { flex: 0 0 min(24%, 90px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.transfer-row.is-failed .transfer-state, .transfer-row.is-interrupted .transfer-state { color: #e65c58; }
.transfer-row.is-done .transfer-state { color: #2aa875; }
</style>

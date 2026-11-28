<script setup>
/**
 * The file page's transfer list: an icon among the heading's fixed icons, with a badge counting the transfers going (red
 * when one failed), opening a list over the page (a popover on a computer, a sheet from the bottom on a phone) that moves
 * nothing under it. Transfer state and rules live in transfers.js.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { t } from "./i18n.js";
import { clear_finished, clear_transfer, ordered_transfers, transfer_counts, transfers } from "./transfers.js";

// A name too long for its line keeps its end (the extension and a little before it): only the start is cut, so the
// ellipsis falls in the middle at any width. The full name is its tooltip.
const NAME_TAIL = 10;
const KINDS = computed(() => ({ drive: t("上传到云空间"), project: t("上传到项目"), prepare: t("准备下载"), land: t("取回到项目"), copy: t("存到云空间"),
  purge: t("彻底删除"), download: t("下载"), delete: t("删除") }));
const ICONS = { drive: "i-lucide-upload", project: "i-lucide-upload", prepare: "i-lucide-download", download: "i-lucide-download",
  copy: "i-lucide-cloud-upload", land: "i-lucide-folder-down", purge: "i-lucide-trash-2", delete: "i-lucide-trash-2" };

const phone_query = window.matchMedia("(max-width: 700px)");
const phone = ref(phone_query.matches);
const follow_phone = () => { phone.value = phone_query.matches; };
phone_query.addEventListener("change", follow_phone);
onBeforeUnmount(() => phone_query.removeEventListener("change", follow_phone));
const open = ref(false);
// `panel`: draw only the list, inside the popover or sheet this component opens.
defineProps({ panel: { type: Boolean, default: false } });

const rows = computed(() => ordered_transfers(transfers.rows));
const counts = computed(() => transfer_counts(transfers.rows));
const badge = computed(() => counts.value.active || counts.value.failed);
const finished = computed(() => transfers.rows.some((row) => row.status === "done" || row.status === "cancelled" || row.status === "interrupted"));

const name_parts = (name) => name.length > NAME_TAIL * 2 ? [name.slice(0, -NAME_TAIL), name.slice(-NAME_TAIL)] : [name, ""];
/** The row's second line: its kind, then how far it got or why it stopped (said in full). */
function state_line(row) {
  const kind = KINDS.value[row.kind] || "";
  const state = row.status === "running" ? `${Math.round(row.progress * 100)}%` : row.status === "queued" ? t("等待中")
    : row.status === "failed" ? t("失败：{reason}", { reason: row.error || t("未知原因") }) : row.status === "done" ? t("已完成")
      : row.status === "cancelled" ? t("已取消") : t("已中断，请重新选择文件");
  return kind ? `${kind} · ${state}` : state;
}
const trigger_label = computed(() => badge.value ? t("传输列表，{count} 项", { count: badge.value }) : t("传输列表"));
const busy = (row) => row.status === "queued" || row.status === "running";
</script>

<template>
  <section v-if="panel" class="transfer-list" :aria-label="t('传输列表')">
    <header>
      <span>{{ counts.active ? t('传输 · {count} 项进行中', { count: counts.active }) : t('传输') }}</span>
      <UButton :label="t('清除已完成')" color="neutral" variant="ghost" size="xs" :disabled="!finished" :title="!finished ? t('暂无已完成的传输') : undefined" @click="clear_finished" />
    </header>
    <p v-if="!rows.length" class="transfer-empty">{{ t('暂无传输任务') }}</p>
    <div v-for="row in rows" :key="row.id" class="transfer-row" :class="`is-${row.status}`">
      <UIcon :name="ICONS[row.kind] || 'i-lucide-arrow-down-up'" class="transfer-icon" />
      <div class="transfer-text">
        <span class="transfer-name" :title="row.name"><span>{{ name_parts(row.name)[0] }}</span>{{ name_parts(row.name)[1] }}</span>
        <span class="transfer-state">{{ state_line(row) }}</span>
        <span v-if="row.status === 'running'" class="transfer-bar" role="progressbar" :aria-valuenow="Math.round(row.progress * 100)" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: `${row.progress * 100}%` }" /></span>
      </div>
      <div class="transfer-actions">
        <UButton v-if="row.cancel" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :title="t('取消')" :aria-label="t('取消 {name}', { name: row.name })" @click="row.cancel()" />
        <UButton v-else-if="row.retry" icon="i-lucide-rotate-cw" color="neutral" variant="ghost" size="xs" :title="t('重试')" :aria-label="t('重试 {name}', { name: row.name })" @click="row.retry()" />
        <span v-else />
        <UButton v-if="!busy(row)" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :title="t('移除')" :aria-label="t('移除 {name}', { name: row.name })" @click="clear_transfer(row.id)" />
      </div>
    </div>
  </section>
  <USlideover v-else-if="phone" v-model:open="open" side="bottom" :title="t('传输列表')"
    :ui="{ overlay: 'channel-drawer-overlay', content: 'channel-menu transfer-sheet', header: 'hidden', body: 'transfer-sheet-body' }">
    <span class="project-files-tool transfer-trigger" :title="t('传输列表')">
      <UButton icon="i-lucide-arrow-down-up" color="neutral" variant="ghost" size="sm" :aria-label="trigger_label" />
      <span v-if="badge" class="transfer-badge" :class="{ 'is-failed': counts.failed }" aria-hidden="true">{{ badge }}</span>
    </span>
    <template #body><TransferList panel /></template>
  </USlideover>
  <UPopover v-else v-model:open="open" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu transfer-popover' }">
    <span class="project-files-tool transfer-trigger" :title="t('传输列表')">
      <UButton icon="i-lucide-arrow-down-up" color="neutral" variant="ghost" size="sm" :aria-label="trigger_label" />
      <span v-if="badge" class="transfer-badge" :class="{ 'is-failed': counts.failed }" aria-hidden="true">{{ badge }}</span>
    </span>
    <template #content><TransferList panel /></template>
  </UPopover>
</template>

<style scoped>
.transfer-trigger { position: relative; }
.transfer-badge { position: absolute; top: 0; right: 0; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: var(--ui-primary); color: var(--ui-bg);
  font-size: 9px; font-weight: 600; line-height: 14px; text-align: center; pointer-events: none; font-variant-numeric: tabular-nums; }
.transfer-badge.is-failed { background: var(--ui-error); color: #fff; }
.transfer-list { display: grid; gap: 2px; font-size: 12px; }
.transfer-list header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 2px 2px 4px 8px; color: var(--ui-text-muted); }
.transfer-empty { margin: 0; padding: 16px 8px; color: var(--ui-text-muted); text-align: center; }
.transfer-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) 52px; gap: 9px; align-items: start; padding: 7px 4px 7px 8px; border-radius: 6px; }
@media (hover: hover) { .transfer-row:hover { background: var(--channel-ghost-hover, var(--ui-bg-accented)); } }
.transfer-icon { width: 14px; height: 14px; margin-top: 2px; color: var(--ui-text-muted); }
.transfer-text { display: grid; gap: 2px; min-width: 0; }
.transfer-name { display: flex; min-width: 0; white-space: nowrap; color: var(--ui-text-highlighted); }
.transfer-name > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.transfer-state { color: var(--ui-text-muted); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.transfer-row.is-failed .transfer-state, .transfer-row.is-interrupted .transfer-state { color: var(--ui-error); }
.transfer-row.is-failed .transfer-icon { color: var(--ui-error); }
.transfer-bar { display: block; height: 2px; margin-top: 3px; border-radius: 1px; background: var(--ui-border); overflow: hidden; }
.transfer-bar > span { display: block; height: 100%; background: var(--ui-primary); transition: width .2s; }
.transfer-actions { display: grid; grid-template-columns: repeat(2, 24px); gap: 4px; }
</style>

<style>
/* Same floating surface as the file page's "…" menus (channel-menu); these only set its size. */
.transfer-popover { width: min(400px, calc(100vw - 24px)); max-height: 60vh; overflow-y: auto; }
.transfer-sheet { max-height: 70dvh; border-radius: 12px 12px 0 0 !important; }
.transfer-sheet-body { overflow-y: auto; padding: 8px 8px calc(8px + env(safe-area-inset-bottom)); }
</style>

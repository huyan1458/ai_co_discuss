<script setup>
/**
 * One external member's protections and reading record, opened from its rail row: what this computer recorded it
 * reading (file, bytes, allowed or refused), and revoke, extend or downgrade to discussion only. The record is this
 * computer's own audit, not anything the other side reports.
 */
import { computed, inject, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { DURATIONS, LEVEL_SHORT, extended_until, external_of, remaining_label, room_operations, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const props = defineProps({ member: { type: Object, default: null }, focus: { type: String, default: "" } });
const open = defineModel("open", { type: Boolean, default: false });
const { view, bridge, act } = inject("discussion");
const operations = room_operations(bridge);
const room = computed(() => view.value.room);
const info = computed(() => external_of(props.member));
const reads = ref([]), detail = ref(null), loading = ref(false), failure = ref("");
const busy = ref(""), extend_to = ref("1h"), confirming = ref(false);

async function load() {
  if (!props.member || !room.value) return;
  loading.value = true;
  failure.value = "";
  try {
    const [record, result] = await Promise.all([operations.member(room.value.id, props.member.id), operations.reads(room.value.id, props.member.id)]);
    detail.value = record;
    // Newest first: the latest reads are what the owner checks.
    reads.value = [...(result.reads || [])].reverse();
  } catch (error) { failure.value = error.message; }
  finally { loading.value = false; }
}
watch(open, (value) => { if (!value) return; reads.value = []; detail.value = null; load(); confirming.value = props.focus === "revoke"; });

/** One change through the room backend; the room is read again so the rail shows it. */
async function change(action, extra, success) {
  if (busy.value) return;
  busy.value = action;
  try {
    if (action === "revoke") await operations.revoke(room.value.id, props.member.id);
    else await operations.update(room.value.id, props.member.id, extra);
    bridge.notify("info", success);
    await act("refresh");
    if (action === "revoke") open.value = false;
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}
const revoke_items = [t("立即生效：之后的请求与读取一律被拒，未完成的执行作废。"), t("已经读出去的内容收不回，会留在对方 AI 的会话里。")];
const date = (value) => bridge.format_time(time_ms(value));
const size = (bytes) => bytes >= 1024 ? t("{count} KiB", { count: Math.round(bytes / 1024) }) : t("{count} 字节", { count: bytes || 0 });
</script>

<template>
  <UModal v-model:open="open" :title="t('外部成员 · {name}', { name: member ? bridge.display_name(member.name) : '' })"
    :description="info ? [info.computer, LEVEL_SHORT[info.level], remaining_label(info.expires_at)].filter(Boolean).join(' · ') : ''" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <div v-if="info" class="external-member">
        <p v-if="info.directories.length" class="fine-print">{{ t("开放目录：{list}", { list: info.directories.map((path) => path.split(/[\\/]/).filter(Boolean).pop()).join("、") }) }}</p>
        <p v-if="detail?.usage" class="fine-print">{{ t("已读 {used} / {limit}，本小时 {hour} / {hour_limit}；被拒 {denied} 次", { used: size(detail.usage.total_bytes), limit: size(detail.quota?.total_bytes), hour: size(detail.usage.hour_bytes), hour_limit: size(detail.quota?.hourly_bytes), denied: detail.usage.denied || 0 }) }}</p>
        <section class="external-actions" :aria-label="t('调整')">
          <div class="external-extend">
            <span>{{ t("延长") }}</span>
            <div class="external-durations" role="radiogroup" :aria-label="t('延长')">
              <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="extend_to === option.value" :class="{ 'is-selected': extend_to === option.value }" @click="extend_to = option.value">{{ option.label }}</button>
            </div>
            <UButton :label="t('延长')" size="xs" color="neutral" variant="outline" :loading="busy === 'extend'" :disabled="Boolean(busy) || info.ended" @click="change('extend', { expires_at: extended_until(info.expires_at, extend_to) }, t('已延长'))" />
          </div>
          <div class="external-buttons">
            <UButton v-if="info.level === 'read'" :label="t('降为只讨论')" icon="i-lucide-eye-off" size="xs" color="neutral" variant="outline" :loading="busy === 'downgrade'" :disabled="Boolean(busy) || info.ended" @click="change('downgrade', { scope: 'discuss' }, t('已降为只讨论，之后不能再读项目文件'))" />
            <UButton :label="t('撤销')" icon="i-lucide-ban" size="xs" color="error" variant="soft" :disabled="Boolean(busy) || info.ended" @click="confirming = true" />
          </div>
        </section>
        <section :aria-label="t('读取记录')">
          <h4>{{ t("读取记录") }}</h4>
          <div v-if="loading" role="status"><USkeleton v-for="row in 3" :key="row" class="external-skeleton" /></div>
          <p v-else-if="failure" class="fine-print" role="alert">{{ failure }} <UButton :label="t('重试')" size="xs" color="neutral" variant="link" @click="load" /></p>
          <p v-else-if="!reads.length" class="fine-print">{{ t("还没有读取记录") }}</p>
          <ul v-else class="external-reads">
            <li v-for="(entry, index) in reads" :key="entry.id || index" :class="{ 'is-denied': !entry.allowed }">
              <small>{{ date(entry.at) }}</small>
              <span class="external-read-path" :title="[entry.directory, entry.path].filter(Boolean).join(' › ')">{{ entry.op ? `${entry.op} ` : "" }}{{ entry.path || "." }}</span>
              <span>{{ entry.allowed ? size(entry.bytes) : t("拒绝：{reason}", { reason: entry.reason || t("超出范围") }) }}</span>
            </li>
          </ul>
          <p class="fine-print">{{ t("记录由这台电脑保存，不采用对方上报的内容。") }}</p>
        </section>
      </div>
      <ConfirmDialog v-model:open="confirming" :title="t('撤销外部成员')" :items="revoke_items" :confirm-label="t('撤销')" danger @confirm="change('revoke', {}, t('已撤销，对方之后的请求都会被拒绝'))" />
    </template>
  </UModal>
</template>

<style scoped>
.external-member { display: flex; flex-direction: column; gap: 12px; }
.external-member .fine-print { margin: 0; }
.external-member h4 { margin: 0 0 6px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.external-actions { display: flex; flex-direction: column; gap: 8px; }
.external-extend, .external-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; }
.external-durations { display: flex; gap: 3px; padding: 3px; border-radius: 6px; background: var(--ui-bg-muted); }
.external-durations button { min-width: 56px; min-height: 26px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); }
.external-durations button.is-selected { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); }
.external-skeleton { height: 18px; margin-bottom: 4px; }
.external-reads { display: flex; flex-direction: column; gap: 2px; max-height: 280px; margin: 0 0 6px; padding: 0; overflow-y: auto; list-style: none; font-size: 12px; }
.external-reads li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; }
.external-reads small { color: var(--ui-text-muted); }
.external-read-path { overflow: hidden; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; text-overflow: ellipsis; }
.external-reads li.is-denied { color: var(--ui-error); }
@media (pointer: coarse) { .external-durations button { min-height: 36px; } }
</style>

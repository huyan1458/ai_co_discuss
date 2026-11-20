<script setup>
/**
 * One external member's protections and reading record, opened from its rail row: what this computer recorded it
 * reading (file, bytes, allowed or refused), and revoke or downgrade to discussion only. How long it stays is the
 * invited computer's choice, shown here as it set it. The record is this computer's own audit, not anything the other
 * side reports.
 */
import { computed, inject, ref, watch } from "vue";
import ExternalInviteCard from "./ExternalInviteCard.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { LEVEL_SHORT, external_ai, external_of, remaining_label, room_operations, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

// `reinvite`: opened to invite an ended member back, so its invitation shows first.
const props = defineProps({ member: { type: Object, default: null }, reinvite: Boolean });
const open = defineModel("open", { type: Boolean, default: false });
const { view, bridge, act } = inject("discussion");
const operations = room_operations(bridge);
const room = computed(() => view.value.room);
// The member as the room shows it now: the opener passes a snapshot, while check-in arrives with a later room read.
const live = computed(() => [...(room.value?.free?.members || []), ...(room.value?.free?.ended_externals || [])]
  .find((item) => item.id === props.member?.id) || props.member);
// The member as this dialog last read it (`GET …/external-members/{id}`), else as the rail passed it: after 降为只讨论
// the dialog reads again, so its header and buttons follow at once.
const info = computed(() => detail.value ? { level: detail.value.scope === "read" ? "read" : "discuss", expires_at: time_ms(detail.value.expires_at),
  directories: (detail.value.directories || []).map((path) => String(path).split(/[\\/]/).filter(Boolean).pop() || path),
  computer: detail.value.machine_label || "", pending: detail.value.claimed_at === 0, ended: detail.value.status === "removed" } : external_of(live.value));
const reads = ref([]), detail = ref(null), loading = ref(false), failure = ref("");
const busy = ref(""), confirming = ref(false);
// Inviting an ended member back: a new link brings the same member (name, label, history) back to its seat.
const reinviting = ref(false);

async function load() {
  if (!props.member || !room.value) return;
  loading.value = true;
  failure.value = "";
  try {
    const record = await operations.member(room.value.id, props.member.id);
    const result = record.claimed_at === 0 ? { reads: [] } : await operations.reads(room.value.id, props.member.id);
    detail.value = record;
    // Newest first: the latest reads are what the owner checks.
    reads.value = [...(result.reads || [])].reverse();
  } catch (error) { failure.value = error.message; }
  finally { loading.value = false; }
}
watch(open, (value) => { if (!value) return; reads.value = []; detail.value = null; reinviting.value = props.reinvite; load(); });
// Checked in while the invitation shows: read again, so the dialog turns into the member's details and reading record.
watch(() => external_of(live.value)?.pending, (pending, was) => { if (open.value && was && pending === false) load(); });

/** One change through the room backend; the room is read again so the rail shows it. */
async function change(action, extra, success) {
  if (busy.value) return;
  busy.value = action;
  try {
    if (action === "revoke") await operations.revoke(room.value.id, props.member.id);
    else await operations.update(room.value.id, props.member.id, extra);
    bridge.notify("info", success);
    await Promise.all([act("refresh"), action === "revoke" ? null : load()]);
    if (action === "revoke") open.value = false;
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}
const pending_expiry = computed(() => t("{count} 天内未签到自动结束", { count: Math.max(0, Math.ceil(((info.value?.expires_at || 0) - Date.now()) / 86400000)) }));
const revoke_items = [t("立即生效：之后的请求与读取一律被拒，未完成的执行作废。"), t("已经读出去的内容收不回，会留在对方 AI 的会话里。")];
const date = (value) => bridge.format_time(time_ms(value));
// Binary units, the same in both languages: whole numbers from 10 up, one decimal below (4 MiB, 1.5 KiB, 306 B).
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB"];
function size(bytes) {
  let value = Number(bytes) || 0, unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) { value /= 1024; unit += 1; }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${shown} ${BYTE_UNITS[unit]}`;
}
</script>

<template>
  <UModal v-model:open="open" :title="t('外部成员 · {name}', { name: live ? bridge.display_name(live.name) : '' })"
    :description="info ? [info.computer, LEVEL_SHORT[info.level], info.ended ? t('已结束') : info.pending ? [t('待签到'), pending_expiry].join(' · ') : remaining_label(info.expires_at)].filter(Boolean).join(' · ') : ''" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <ExternalInviteCard v-if="detail && ((detail.claimed_at === 0 && !info?.ended) || reinviting)" :key="member.id" :member-id="member.id" :settings="{ level: detail.scope, directories: detail.directories, invite_version: detail.invite_version }" />
      <!-- A seat awaiting check-in opens on its invitation: nothing else shows until that has been read. -->
      <div v-if="info?.pending && !detail && !failure" class="external-member-invite-loading" role="status" :aria-label="t('正在读取邀请')"><USkeleton class="external-member-invite-skeleton" /></div>
      <div v-else-if="info" class="external-member">
        <!-- What is open now, laid out like an expert card's facts: a label column and a value column. -->
        <dl class="external-member-facts">
          <div v-if="external_ai(live)"><dt>{{ t("对方的 AI") }}</dt><dd>{{ t("{name}（对方自报）", { name: external_ai(live) }) }}</dd></div>
          <div><dt>{{ t("对方能看到") }}</dt><dd>{{ LEVEL_SHORT[info.level] }}</dd></div>
          <div v-if="info.level === 'read'"><dt>{{ t("开放目录") }}</dt><dd :title="info.directories.join('、')">{{ info.directories.join("、") || "—" }}</dd></div>
          <div v-if="!info.pending"><dt>{{ t("剩余时间") }}</dt><dd>{{ info.ended ? t("已结束") : [remaining_label(info.expires_at) || "—", t("对方设定")].join(" · ") }}</dd></div>
          <div v-if="!info.pending && detail?.usage"><dt>{{ t("用量") }}</dt><dd>{{ t("{used} / {limit} · 本小时 {hour} / {hour_limit} · 被拒 {denied} 次", { used: size(detail.usage.total_bytes), limit: size(detail.quota?.total_bytes), hour: size(detail.usage.hour_bytes), hour_limit: size(detail.quota?.hourly_bytes), denied: detail.usage.denied || 0 }) }}</dd></div>
        </dl>
        <section v-if="!info.ended" class="external-member-actions" :aria-label="t('调整')">
          <div class="external-member-buttons">
            <UButton v-if="!info.pending && info.level === 'read'" :label="t('改为只看消息')" icon="i-lucide-eye-off" size="xs" color="neutral" variant="outline" class="pb-action" :loading="busy === 'downgrade'" :disabled="Boolean(busy)" @click="change('downgrade', { scope: 'discuss' }, t('已降为只讨论，之后不能再读项目文件'))" />
            <UButton :label="info.pending ? t('移除席位') : t('撤销授权')" icon="i-lucide-ban" size="xs" color="error" variant="soft" :disabled="Boolean(busy)" @click="confirming = true" />
          </div>
        </section>
        <div v-else-if="!reinviting" class="external-member-ended" role="status"><UIcon name="i-lucide-circle-slash" /><span>{{ t("这位外部成员已结束。") }}</span>
          <UButton v-if="!room?.archived" :label="t('重新邀请')" icon="i-lucide-user-round-plus" size="xs" color="neutral" variant="outline" class="pb-action" @click="reinviting = true" /></div>
        <section v-if="!info.pending" class="external-member-reads" :aria-label="t('读取记录')">
          <h4>{{ t("读取记录") }}</h4>
          <div v-if="loading && !reads.length" role="status" :aria-label="t('正在读取读取记录')"><USkeleton v-for="row in 3" :key="row" class="external-member-skeleton" /></div>
          <p v-else-if="failure" class="external-member-error" role="alert"><UIcon name="i-lucide-circle-alert" /><span>{{ failure }}</span><UButton :label="t('重试')" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" @click="load" /></p>
          <p v-else-if="!reads.length" class="external-member-empty">{{ t("还没有读取记录") }}</p>
          <ul v-else class="external-member-list">
            <li v-for="(entry, index) in reads" :key="entry.id || index" :class="{ 'is-denied': !entry.allowed }">
              <span class="external-member-time">{{ date(entry.at) }}</span>
              <span class="external-member-op">{{ entry.op || "read" }}</span>
              <span class="external-member-path" :title="[entry.directory, entry.path].filter(Boolean).join(' › ')">{{ entry.path || "." }}</span>
              <span class="external-member-result"><UIcon v-if="!entry.allowed" name="i-lucide-ban" aria-hidden="true" />{{ entry.allowed ? size(entry.bytes) : t("拒绝：{reason}", { reason: entry.reason || t("超出范围") }) }}</span>
            </li>
          </ul>
          <p class="external-member-note">{{ t("记录由这台电脑保存，不采用对方上报的内容。") }}</p>
        </section>
      </div>
      <ConfirmDialog v-model:open="confirming" :title="info?.pending ? t('移除席位') : t('撤销外部成员')" :items="info?.pending ? [] : revoke_items" :confirm-label="info?.pending ? t('移除席位') : t('撤销授权')" danger @confirm="change('revoke', {}, info?.pending ? t('席位已移除') : t('已撤销，对方之后的请求都会被拒绝'))" />
    </template>
  </UModal>
</template>

<style scoped>
.external-member { display: flex; flex-direction: column; gap: 14px; }
/* Facts as on an expert card's front: a dimmed label column and toned values, 12px in a dialog. */
.external-member-facts { display: grid; gap: 4px; margin: 0; font-size: 12px; }
.external-member-facts > div { display: grid; grid-template-columns: 7em minmax(0, 1fr); gap: 8px; }
.external-member-facts dt { color: var(--ui-text-dimmed); white-space: nowrap; }
.external-member-facts dd { margin: 0; color: var(--ui-text-toned); overflow-wrap: anywhere; }
.external-member-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-block: 1px solid var(--ui-border-muted); }
.external-member-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.external-member-label { color: var(--ui-text-dimmed); font-size: 11px; }
.external-member-ended { display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px 10px; border: 1px dashed var(--ui-border); border-radius: 8px; color: var(--ui-text-toned); font-size: 12px; }
.external-member-ended > span { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.external-member-reads h4 { margin: 0 0 8px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.external-member-skeleton { height: 22px; margin-bottom: 4px; }
.external-member-invite-skeleton { height: 360px; border-radius: 8px; }
/* Empty and error states match the invite dialog's dashed box and the device records' inline retry. */
.external-member-empty { margin: 0 0 8px; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.external-member-error { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; color: var(--ui-error); font-size: 12px; }
.external-member-error > span:first-child { flex-shrink: 0; width: 14px; height: 14px; }
.external-member-error > span:nth-child(2) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.external-member-list { display: flex; flex-direction: column; max-height: 300px; margin: 0 0 8px; padding: 0; overflow-y: auto; list-style: none; border: 1px solid var(--ui-border-muted); border-radius: 8px; scrollbar-width: thin; }
.external-member-list li { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 10px; min-height: 30px; padding: 4px 10px; font-size: 12px; }
.external-member-list li + li { border-top: 1px solid var(--ui-border-muted); }
.external-member-time { color: var(--ui-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.external-member-op { padding: 0 5px; border-radius: 4px; background: var(--ui-bg-muted); color: var(--ui-text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 10px; line-height: 16px; }
.external-member-path { overflow: hidden; color: var(--ui-text-toned); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; text-overflow: ellipsis; }
.external-member-result { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.external-member-result > span { width: 12px; height: 12px; }
.external-member-list li.is-denied .external-member-path, .external-member-list li.is-denied .external-member-result { color: var(--ui-error); }
.external-member-note { margin: 0; color: var(--ui-text-dimmed); font-size: 11px; }
/* Phones: each read takes two lines (time and operation, then path and result) instead of squeezing four columns. */
@media (max-width: 480px) {
  .external-member-facts > div { grid-template-columns: 5.5em minmax(0, 1fr); }
  .external-member-list li { grid-template-columns: auto minmax(0, 1fr); row-gap: 2px; }
  .external-member-path, .external-member-result { grid-column: 1 / -1; }
  .external-member-result { white-space: normal; }
}
</style>

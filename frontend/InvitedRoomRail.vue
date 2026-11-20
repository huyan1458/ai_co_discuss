<script setup>
/**
 * The right rail of an invited room: requests waiting for you, how it answers when named, how long it is lent (this
 * computer's choice, renewable or shortened here), how many times the AI was woken, and pause, adjust and leave.
 */
import { computed, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import TrustLevelField from "./TrustLevelField.vue";
import { LEVEL_SHORT, WAKE_LABELS, end_label, lockdown_problem, remaining_label, runner_message, scope_label, time_ms, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

// In the narrow-screen drawer the drawer's own title already names the page, so the rail drops its header there.
defineProps({ drawer: Boolean });
const invited = use_invited_rooms();
const record = invited.selected;
const editing = ref(false), leaving = ref(false), removing = ref(false);
const trust = ref({ wake: "auto", confined: true, duration: "" });
watch(() => record.value?.id, () => { editing.value = false; });
// A record whose time ran out renews here and is back at once (user 2026-11-19): the dialog opens on a new loan of an hour.
const lapsed = computed(() => record.value?.status === "ended" && record.value.end_reason === "expired");
function start_edit() {
  trust.value = { wake: record.value.wake || "ask", confined: record.value.confined !== false, duration: lapsed.value ? "1h" : "" };
  editing.value = true;
}
/** Save how it answers and its local access, then, when a new loan was picked, ask the other computer for the new end. */
async function save() {
  editing.value = false;
  const { duration, ...settings } = trust.value;
  await invited.set_trust(record.value.id, settings, duration ? "" : t("设置已更新"));
  if (duration) await invited.lend(record.value.id, duration);
}
const usage = computed(() => {
  const value = record.value;
  if (!value) return "";
  const count = value.wakes || 0;
  // Whole sentences per case, so each language can say "once" and "of N" its own way.
  return count === 1 ? t("已唤醒 1 次") : t("已唤醒 {count} 次", { count });
});
// 完全借用 runs until its own end; past it (or out of wakes) requests wait for you again.
const CONTACT = { offline: t("对方电脑不在线"), error: t("通信出错") };
const BY ={ user: t("对方房主"), host: t("对方主持人") };
const leave_items = [t("对方房间里的成员身份立即结束，之后点名不再唤醒你的 AI。"), t("你的 AI 已经读到的内容仍留在它的会话里。")];
const remove_items = [t("这台电脑上这个房间的记录、历史和运行文件会被删除，无法恢复。"), t("对方房间不受影响，你的 AI 自己的会话也会保留。")];
const date = (value) => new Date(time_ms(value)).toLocaleString([], { hour12: false });
const busy = invited.busy;
// What the other room says now (`room.me`, read by the middle page) wins over what the record kept from joining.
const me = computed(() => (record.value && invited.room_me.value[record.value.id]) || null);
const open_level = computed(() => me.value?.scope || record.value?.open_level);
const expires_at = computed(() => me.value?.expires_at || record.value?.expires_at);
// An ended or left record keeps its facts here; only the controls go, as there is nothing left to adjust.
const ended = computed(() => end_label(record.value));
const ended_at = computed(() => ended.value ? (record.value.history || []).findLast((entry) => ["ended", "left"].includes(entry.outcome))?.at || 0 : 0);
// Why this record's software cannot run confined, in the page language; "" when it can or runs unrestricted.
const lockdown = computed(() => record.value && record.value.confined !== false ? lockdown_problem(record.value.ai?.adapter) : "");
/** The one line that says how this membership stands now, most urgent first, in the room rail's status style. */
const status = computed(() => {
  const value = record.value;
  if (!value) return { tone: "idle", title: "" };
  if (ended.value) return { tone: "idle", title: ended.value };
  const detail = [remaining_label(expires_at.value) || t("不限"), usage.value].join(" · ");
  const contact = CONTACT[value.contact?.state];
  if (value.approvals?.length) return { tone: "warning", title: t("{count} 个请求待确认", { count: value.approvals.length }), detail };
  if (contact) return { tone: "error", title: contact, detail, hint: runner_message(value.contact.error_text, value.contact.error) };
  if (value.paused) return { tone: "warning", title: t("已暂停"), detail };
  if (value.running) return { tone: "primary", title: t("AI 正在处理"), detail };
  return { tone: "idle", title: t("等待点名"), detail };
});
</script>

<template>
  <div v-if="record" class="progress-board is-docked invited-rail">
    <header v-if="!drawer" class="pb-header"><strong>{{ t("外部房间") }}</strong><span class="pb-mode">{{ record.machine_name || "" }}</span></header>
    <section class="pb-status" :class="`is-${status.tone}`" :aria-label="t('状态')">
      <div class="pb-status-line"><span class="pb-dot"></span><strong role="status" :title="status.hint || undefined">{{ status.title }}</strong></div>
      <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
    </section>
    <section v-if="record.approvals?.length" class="pb-section invited-pending" :aria-label="t('待确认的请求')">
      <h4>{{ t("待确认的请求") }}</h4>
      <div v-for="approval in record.approvals" :key="approval.id" class="invited-pending-item">
        <p class="invited-pending-text">{{ t("{by}点名了你的 AI（{messages}）", { by: BY[approval.created_by] || t("对方"), messages: (approval.message_ids || []).map((id) => `#${id}`).join(" ") }) }}</p>
        <small v-if="approval.expires_at">{{ t("{time} 前不确认视为拒绝", { time: date(approval.expires_at) }) }}</small>
        <div class="invited-pending-actions">
          <UButton :label="t('同意并唤醒')" icon="i-lucide-play" size="xs" color="neutral" variant="outline" class="pb-action" data-tone="success" :loading="busy === `decide:${approval.id}`" :disabled="Boolean(busy)" @click="invited.approve(record.id, approval.id)" />
          <UButton :label="t('拒绝')" size="xs" color="neutral" variant="ghost" :disabled="Boolean(busy)" @click="invited.refuse(record.id, approval.id)" />
        </div>
      </div>
    </section>
    <section v-if="lockdown && !ended" class="pb-section">
      <div class="invited-callout" role="status" :title="lockdown">
        <UIcon name="i-lucide-triangle-alert" />
        <div>
          <strong>{{ t("被点名时不会启动") }}</strong>
          <p>{{ t("这个 AI 只能不受限运行。") }}</p>
        </div>
      </div>
    </section>
    <section class="pb-section" :aria-label="t('详情')">
      <h4>{{ t("详情") }}</h4>
      <dl class="invited-facts">
        <div><dt>{{ t("对方开放") }}</dt><dd>{{ LEVEL_SHORT[open_level] || open_level }}</dd></div>
        <div><dt>{{ t("你的 AI") }}</dt><dd>{{ [record.member_label || record.member, record.ai?.model, record.ai?.effort].filter(Boolean).join(" · ") }}</dd></div>
        <div><dt>{{ t("被点名时") }}</dt><dd>{{ WAKE_LABELS[record.wake] || record.wake }}</dd></div>
        <div><dt>{{ t("本机权限") }}</dt><dd>{{ scope_label(record.confined) }}</dd></div>
        <div v-if="!ended && expires_at"><dt>{{ t("借出到") }}</dt><dd>{{ date(expires_at) }}</dd></div>
        <!-- Countdowns stop with the membership: an ended record says when it ended instead. -->
        <div v-if="ended && ended_at"><dt>{{ t("结束于") }}</dt><dd>{{ date(ended_at) }}</dd></div>
        <div v-if="ended"><dt>{{ t("唤醒") }}</dt><dd>{{ usage }}</dd></div>
      </dl>
      <p v-if="!record.fingerprint_checked" class="fine-print">{{ t("用配对码加入，未核对对方电脑的公钥指纹。") }}</p>
      <p v-if="lapsed" class="fine-print">{{ t("借出时间已到；点“续期”即可回到对方房间。") }}</p>
      <p v-else-if="ended" class="fine-print">{{ t("这台电脑保留这条记录与历史；要再参加，请对方重新邀请。") }}</p>
    </section>
    <section v-if="!ended" class="pb-section" :aria-label="t('调整')">
      <div class="invited-actions">
        <UButton :label="t('调整设置')" icon="i-lucide-shield" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block" data-tone="accent" @click="start_edit" />
        <div class="invited-action-row">
          <UButton :label="record.paused ? t('恢复唤醒') : t('暂停')" :icon="record.paused ? 'i-lucide-play' : 'i-lucide-pause'" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block" :data-tone="record.paused ? 'success' : 'warning'"
            :title="record.paused ? t('恢复后，对方点名按设置处理') : t('暂停期间不领取也不唤醒；已在等你确认的请求到时照常算作未同意')" :loading="busy === 'pause'" :disabled="Boolean(busy)"
            @click="invited.set_paused(record.id, !record.paused)" />
          <UButton :label="t('退出房间')" icon="i-lucide-log-out" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block invited-leave" data-tone="danger" :disabled="Boolean(busy)" @click="leaving = true" />
        </div>
      </div>
    </section>
    <section v-else class="pb-section" :aria-label="t('删除记录')">
      <UButton v-if="lapsed" :label="t('续期')" icon="i-lucide-clock-plus" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block invited-renew" data-tone="accent" :disabled="Boolean(busy)" @click="start_edit" />
      <UButton :label="t('删除记录')" icon="i-lucide-trash-2" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block invited-leave" data-tone="danger"
        :title="record.leave_pending ? t('退出通知还没送达对方电脑，送达后才能删除记录') : undefined" :loading="busy === 'remove'" :disabled="Boolean(busy) || record.leave_pending" @click="removing = true" />
    </section>
    <!-- Too much for the narrow rail beside the facts it repeats, so the settings open in a dialog (user 2026-11-19). -->
      <UModal v-model:open="editing" :title="t('调整「{room}」的设置', { room: record.room_title || '' })" :description="t('只影响你这台电脑上的 AI，对方房间的开放范围由对方决定。')"
        :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
        <template #body>
          <TrustLevelField v-model="trust" :confine_reason="lockdown_problem(record.ai?.adapter)" />
          <p v-if="lapsed" class="fine-print invited-edit-note">{{ t("借出时间已到，保存后立即回到对方房间。") }}</p>
          <p v-else-if="expires_at" class="fine-print invited-edit-note">{{ t("当前借出到 {time}", { time: date(expires_at) }) }}</p>
          <div class="invited-edit-actions">
            <UButton :label="t('取消')" size="sm" color="neutral" variant="ghost" @click="editing = false" />
            <UButton :label="t('保存')" size="sm" class="channel-primary-button" :loading="busy === 'trust' || busy === 'lend'" :disabled="Boolean(busy)" @click="save" />
          </div>
        </template>
      </UModal>
    <ConfirmDialog v-model:open="leaving" :title="t('退出「{room}」', { room: record.room_title || '' })" :items="leave_items" :confirm-label="t('退出房间')" danger @confirm="invited.leave(record.id)" />
    <ConfirmDialog v-model:open="removing" :title="t('删除「{room}」的记录', { room: record.room_title || '' })" :items="remove_items" :confirm-label="t('删除记录')" danger @confirm="invited.remove(record.id)" />
  </div>
</template>

<style scoped>
.invited-pending-item { display: flex; flex-direction: column; gap: 4px; padding: 10px; border: 1px solid color-mix(in srgb, var(--ui-warning) 28%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--ui-warning) 8%, transparent); }
.invited-pending-item + .invited-pending-item { margin-top: 6px; }
.invited-pending-text { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.invited-pending-item small { color: var(--ui-text-muted); font-size: 11px; }
.invited-pending-actions, .invited-edit-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.invited-callout { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border: 1px solid color-mix(in srgb, var(--ui-warning) 28%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--ui-warning) 8%, transparent); }
.invited-callout > [class*="icon"] { flex-shrink: 0; width: 14px; height: 14px; margin-top: 2px; color: var(--ui-warning); }
.invited-callout strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; }
.invited-callout p { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 11.5px; line-height: 1.5; }
.invited-facts { display: flex; flex-direction: column; gap: 8px; margin: 0; font-size: 12px; }
.invited-facts > div { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.invited-facts dt { flex-shrink: 0; color: var(--ui-text-muted); }
.invited-facts dd { min-width: 0; margin: 0; color: var(--ui-text-toned); text-align: right; overflow-wrap: anywhere; }
.invited-actions { display: flex; flex-direction: column; gap: 6px; }
.invited-action-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 6px; }
/* Leaving is rare: it stays quiet beside 暂停 and turns red only when pointed at. */
.invited-edit-actions { margin-top: 16px; }
.invited-edit-note { margin: 10px 0 0; }
.invited-renew { margin-bottom: 6px; }
.invited-rail .fine-print { margin: 10px 0 0; font-size: 11.5px; line-height: 1.5; }
</style>

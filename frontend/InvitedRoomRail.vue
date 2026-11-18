<script setup>
/**
 * The right rail of an invited room: requests waiting for you (默认 level), the trust level and its limits, time
 * left, how many times the AI was woken, and pause, adjust and leave.
 */
import { computed, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import TrustLevelField from "./TrustLevelField.vue";
import { LEVEL_SHORT, TRUST_LABELS, end_label, lockdown_problem, remaining_label, runner_message, time_ms, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

// In the narrow-screen drawer the drawer's own title already names the page, so the rail drops its header there.
defineProps({ drawer: Boolean });
const invited = use_invited_rooms();
const record = invited.selected;
const editing = ref(false), leaving = ref(false);
const trust = ref({ trust: "default", max_wakes: 20, hours: 24 });
const HOUR_MS = 3_600_000;
watch(() => record.value?.id, () => { editing.value = false; });
function start_edit() {
  const value = record.value;
  const left = time_ms(value.limits?.until) - Date.now();
  trust.value = { trust: value.trust || "default", max_wakes: value.limits?.max_wakes || 20, hours: left > 0 ? Math.min(720, Math.max(1, Math.round(left / HOUR_MS))) : 24 };
  editing.value = true;
}
async function save() {
  // 信任设备 cannot be chosen through the relay (D6a): a record already trusted keeps its level until changed here or locally.
  if (!invited.trust_local.value && trust.value.trust === "trusted") { editing.value = false; return; }
  if (await invited.set_trust(record.value.id, trust.value, t("信任等级已更新"))) editing.value = false;
}
const usage = computed(() => {
  const value = record.value;
  if (!value) return "";
  const count = value.wakes || 0;
  // Whole sentences per case, so each language can say "once" and "of N" its own way.
  if (value.trust === "borrow" && value.limits?.max_wakes) return t("已唤醒 {count} / {limit} 次", { count, limit: value.limits.max_wakes });
  return count === 1 ? t("已唤醒 1 次") : t("已唤醒 {count} 次", { count });
});
// 完全借用 runs until its own end; past it (or out of wakes) requests wait for you again.
const borrow_until = computed(() => record.value?.trust === "borrow" ? remaining_label(record.value.limits?.until) : "");
const CONTACT = { offline: t("对方电脑不在线"), error: t("通信出错") };
const BY ={ user: t("对方房主"), host: t("对方主持人") };
const leave_items = [t("对方房间里的成员身份立即结束，之后点名不再唤醒你的 AI。"), t("你的 AI 已经读到的内容仍留在它的会话里。")];
const date = (value) => new Date(time_ms(value)).toLocaleString([], { hour12: false });
const busy = invited.busy;
// What the other room says now (`room.me`, read by the middle page) wins over what the record kept from joining.
const me = computed(() => (record.value && invited.room_me.value[record.value.id]) || null);
const open_level = computed(() => me.value?.scope || record.value?.open_level);
const expires_at = computed(() => me.value?.expires_at || record.value?.expires_at);
// An ended or left record keeps its facts here; only the controls go, as there is nothing left to adjust.
const ended = computed(() => end_label(record.value));
const ended_at = computed(() => ended.value ? (record.value.history || []).findLast((entry) => ["ended", "left"].includes(entry.outcome))?.at || 0 : 0);
// Why this record's software cannot serve below 信任设备, in the page language; "" when it can or is trusted.
const lockdown = computed(() => record.value && record.value.trust !== "trusted" ? lockdown_problem(record.value.ai?.adapter) : "");
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
    <header v-if="!drawer" class="pb-header"><strong>{{ t("被邀请的房间") }}</strong><span class="pb-mode">{{ record.machine_name || "" }}</span></header>
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
          <p>{{ t("这个 AI 软件只能在“信任设备”等级下服务。") }}</p>
        </div>
      </div>
    </section>
    <section class="pb-section" :aria-label="t('详情')">
      <h4>{{ t("详情") }}</h4>
      <dl class="invited-facts">
        <div><dt>{{ t("对方开放") }}</dt><dd>{{ LEVEL_SHORT[open_level] || open_level }}</dd></div>
        <div><dt>{{ t("你的 AI") }}</dt><dd>{{ [record.member_label || record.member, record.ai?.model, record.ai?.effort].filter(Boolean).join(" · ") }}</dd></div>
        <div><dt>{{ t("信任等级") }}</dt><dd>{{ TRUST_LABELS[record.trust] || record.trust }}</dd></div>
        <div v-if="borrow_until && !ended"><dt>{{ t("借用至") }}</dt><dd>{{ borrow_until }}</dd></div>
        <!-- Countdowns stop with the membership: an ended record says when it ended instead. -->
        <div v-if="ended && ended_at"><dt>{{ t("结束于") }}</dt><dd>{{ date(ended_at) }}</dd></div>
        <div v-if="ended"><dt>{{ t("唤醒") }}</dt><dd>{{ usage }}</dd></div>
      </dl>
      <p v-if="!record.fingerprint_checked" class="fine-print">{{ t("用配对码加入，未核对对方电脑的公钥指纹。") }}</p>
      <p v-if="ended" class="fine-print">{{ t("这台电脑保留这条记录与历史；要再参加，请对方重新邀请。") }}</p>
    </section>
    <section v-if="!ended" class="pb-section" :aria-label="t('调整')">
      <template v-if="editing">
        <TrustLevelField v-model="trust" :trusted_locked="!invited.trust_local.value" />
        <div class="invited-edit-actions">
          <UButton :label="t('取消')" size="xs" color="neutral" variant="ghost" @click="editing = false" />
          <UButton :label="t('保存')" size="xs" class="channel-primary-button" :loading="busy === 'trust'" :disabled="Boolean(busy)" @click="save" />
        </div>
        <p class="fine-print">{{ t("信任等级按对方电脑记录：这台电脑邀请的所有房间一起生效。") }}</p>
      </template>
      <div v-else class="invited-actions">
        <UButton :label="t('调整信任等级')" icon="i-lucide-shield" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block" @click="start_edit" />
        <div class="invited-action-row">
          <UButton :label="record.paused ? t('恢复唤醒') : t('暂停')" :icon="record.paused ? 'i-lucide-play' : 'i-lucide-pause'" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block"
            :title="record.paused ? t('恢复后，对方点名按信任等级处理') : t('暂停期间不领取也不唤醒；已在等你确认的请求到时照常算作未同意')" :loading="busy === 'pause'" :disabled="Boolean(busy)"
            @click="invited.set_paused(record.id, !record.paused)" />
          <UButton :label="t('退出房间')" icon="i-lucide-log-out" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block invited-leave" :disabled="Boolean(busy)" @click="leaving = true" />
        </div>
      </div>
    </section>
    <ConfirmDialog v-model:open="leaving" :title="t('退出「{room}」', { room: record.room_title || '' })" :items="leave_items" :confirm-label="t('退出房间')" danger @confirm="invited.leave(record.id)" />
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
:global(html[data-theme^="channel"] .pb-action.invited-leave:hover:not(:disabled)) { border-color: color-mix(in srgb, var(--ui-error) 42%, transparent); background: color-mix(in srgb, var(--ui-error) 12%, transparent); color: var(--ui-error); }
.invited-edit-actions { margin-top: 8px; }
.invited-rail .fine-print { margin: 10px 0 0; font-size: 11.5px; line-height: 1.5; }
</style>

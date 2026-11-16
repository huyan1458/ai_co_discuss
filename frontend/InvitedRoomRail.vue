<script setup>
/**
 * The right rail of an invited room: requests waiting for you (默认 level), the trust level and its limits, time
 * left, how many times the AI was woken, and pause, adjust and leave.
 */
import { computed, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import TrustLevelField from "./TrustLevelField.vue";
import { LEVEL_SHORT, TRUST_LABELS, lockdown_problem, remaining_label, time_ms, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

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
  if (await invited.set_trust(record.value.id, trust.value, t("信任等级已更新"))) editing.value = false;
}
const usage = computed(() => {
  const value = record.value;
  if (!value) return "";
  const limit = value.trust === "borrow" && value.limits?.max_wakes ? ` / ${value.limits.max_wakes}` : "";
  return t("已唤醒 {count}{limit} 次", { count: value.wakes || 0, limit });
});
// 完全借用 runs until its own end; past it (or out of wakes) requests wait for you again.
const borrow_until = computed(() => record.value?.trust === "borrow" ? remaining_label(record.value.limits?.until) : "");
const CONTACT = { online: t("在线"), offline: t("对方电脑不在线"), error: t("通信出错"), unknown: t("未知") };
const BY = { user: t("对方房主"), host: t("对方主持人") };
const leave_items = [t("对方房间里的成员身份立即结束，之后点名不再唤醒你的 AI。"), t("你的 AI 已经读到的内容仍留在它的会话里。")];
const date = (value) => new Date(time_ms(value)).toLocaleString([], { hour12: false });
const busy = invited.busy;
// Why this record's software cannot serve below 信任设备, in the page language; "" when it can or is trusted.
const lockdown = computed(() => record.value && record.value.trust !== "trusted" ? lockdown_problem(record.value.ai?.adapter) : "");
</script>

<template>
  <div v-if="record" class="progress-board is-docked invited-rail">
    <header class="pb-header"><strong>{{ t("被邀请的房间") }}</strong><span class="pb-mode">{{ record.machine_name || "" }}</span></header>
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
    <section class="pb-section" :aria-label="t('状态')">
      <h4>{{ t("状态") }}</h4>
      <dl class="invited-facts">
        <dt>{{ t("房间") }}</dt><dd>{{ record.room_title }}</dd>
        <dt>{{ t("对方开放") }}</dt><dd>{{ LEVEL_SHORT[record.open_level] || record.open_level }}</dd>
        <dt>{{ t("你的 AI") }}</dt><dd>{{ [record.member_label || record.member, record.ai?.model, record.ai?.effort].filter(Boolean).join(" · ") }}</dd>
        <dt>{{ t("信任等级") }}</dt><dd>{{ TRUST_LABELS[record.trust] || record.trust }}{{ record.paused ? t("（已暂停）") : "" }}</dd>
        <template v-if="borrow_until"><dt>{{ t("借用至") }}</dt><dd>{{ borrow_until }}</dd></template>
        <dt>{{ t("剩余时间") }}</dt><dd>{{ remaining_label(record.expires_at) || t("不限") }}</dd>
        <dt>{{ t("唤醒") }}</dt><dd>{{ usage }}</dd>
        <template v-if="record.contact?.state && record.contact.state !== 'online'"><dt>{{ t("连接") }}</dt><dd :title="record.contact.error || undefined">{{ CONTACT[record.contact.state] || record.contact.state }}</dd></template>
      </dl>
      <p v-if="!record.fingerprint_checked" class="fine-print">{{ t("用配对码加入，未核对对方电脑的公钥指纹。") }}</p>
      <p v-if="lockdown" class="fine-print">{{ t("这个 AI 软件无法限制为只用共议命令（{reason}），只能在“信任设备”等级下服务。", { reason: lockdown }) }}</p>
    </section>
    <section class="pb-section" :aria-label="t('调整')">
      <template v-if="editing">
        <TrustLevelField v-model="trust" />
        <div class="invited-edit-actions">
          <UButton :label="t('取消')" size="xs" color="neutral" variant="ghost" @click="editing = false" />
          <UButton :label="t('保存')" size="xs" class="channel-primary-button" :loading="busy === 'trust'" :disabled="Boolean(busy)" @click="save" />
        </div>
        <p class="fine-print">{{ t("信任等级按对方电脑记录：这台电脑邀请的所有房间一起生效。") }}</p>
      </template>
      <div v-else class="invited-actions">
        <UButton :label="t('调整信任等级')" icon="i-lucide-shield" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block" @click="start_edit" />
        <UButton :label="record.paused ? t('恢复') : t('暂停')" :icon="record.paused ? 'i-lucide-play' : 'i-lucide-pause'" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block"
          :title="record.paused ? t('恢复后，对方点名按信任等级处理') : t('暂停期间不领取也不唤醒；已在等你确认的请求到时照常算作未同意')" :loading="busy === 'pause'" :disabled="Boolean(busy)"
          @click="invited.set_paused(record.id, !record.paused)" />
        <UButton :label="t('退出房间')" icon="i-lucide-log-out" size="sm" color="error" variant="soft" class="pb-action pb-action-block" :disabled="Boolean(busy)" @click="leaving = true" />
      </div>
    </section>
    <ConfirmDialog v-model:open="leaving" :title="t('退出「{room}」', { room: record.room_title || '' })" :items="leave_items" :confirm-label="t('退出')" danger @confirm="invited.leave(record.id)" />
  </div>
</template>

<style scoped>
.invited-pending-item { display: flex; flex-direction: column; gap: 4px; padding: 8px; border: 1px solid var(--ui-warning, #e0a33a); border-radius: 8px; }
.invited-pending-item + .invited-pending-item { margin-top: 6px; }
.invited-pending-text { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
.invited-pending-item small { color: var(--ui-text-muted); font-size: 11px; }
.invited-pending-actions, .invited-edit-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.invited-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin: 0; font-size: 12px; }
.invited-facts dt { color: var(--ui-text-muted); }
.invited-facts dd { margin: 0; overflow-wrap: anywhere; }
.invited-actions { display: flex; flex-direction: column; gap: 6px; }
.invited-edit-actions { margin-top: 8px; }
.invited-rail .fine-print { margin: 6px 0 0; }
</style>

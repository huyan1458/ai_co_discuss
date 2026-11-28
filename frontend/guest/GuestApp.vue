<script setup>
/**
 * The external user's page, `/guest/#<invitation>` on the owner's online site: an entry card, then the room in five
 * fixed tabs with a countdown, then an end card once the visit is over. No left sidebar and nothing of the owner's
 * other rooms; only the guest routes of API.md §3 are called.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { t } from "../i18n.js";
import { create_visit, read_invitation } from "./guest-session.js";
import GuestMessages from "./GuestMessages.vue";
import GuestList from "./GuestList.vue";
import GuestFiles from "./GuestFiles.vue";

const invite = read_invitation();
// The invitation leaves the address bar at once: a reload or a shared screen must not hand it on.
if (invite) history.replaceState(null, "", location.pathname);
const visit = create_visit(invite || null);
// No invitation in the address: a reload of a visit under way, restored from this tab's kept key; an unreadable one is
// only reported.
if (invite === null) visit.restore();
else if (invite === false) visit.phase.value = "invalid";
const label = ref(invite?.label || "");
const entering = ref(false), entry_error = ref("");
const WAITING_POLL_MS = 3000, SESSION_POLL_MS = 15000;
const ENDING_MS = 2 * 60_000;
const SCOPE_LABELS = { chat: t("仅聊天"), project: t("可读项目") };
const MODE_LABELS = { conservative: t("保守：房间里的 AI 临时只读"), trust: t("信任：AI 保持原有权限") };
const ENTRY_ERRORS = {
  wrong_site: t("这个链接属于另一个网站，请用对方发来的原始链接打开。"),
  wrong_machine: t("无法确认对方电脑的身份，请让对方重新生成链接。"),
  machine_not_found: t("对方电脑不在这个网站上，请让对方重新生成链接。"),
  guest_occupied: t("房间里已经有一位外部用户，请联系房主。"),
  guest_ended: t("这个链接已失效，请让对方重新生成。"),
  guest_forbidden: t("这个链接已失效，请让对方重新生成。"),
};
const invite_expired = computed(() => invite && invite.invite_expires_at && invite.invite_expires_at <= Date.now());
const duration_text = (seconds) => seconds >= 3600 ? t("{count} 小时", { count: Math.round(seconds / 360) / 10 }) : t("{count} 分钟", { count: Math.round(seconds / 60) });

async function enter() {
  if (entering.value) return;
  entering.value = true;
  entry_error.value = "";
  try { await visit.enter(label.value.trim() || invite.label); }
  catch (error) { entry_error.value = ENTRY_ERRORS[error.code] || (error.code ? t("进入失败（{code}），可以再试一次。", { code: error.code }) : t("连不上对方电脑，请稍后再试。")); }
  finally { entering.value = false; }
}

// Waiting and active both re-read the session: entering, a longer stay, or the end the computer decided.
let session_timer = 0;
function schedule_session() {
  clearTimeout(session_timer);
  if (!["waiting", "active"].includes(visit.phase.value)) return;
  session_timer = setTimeout(async () => { await visit.refresh(); schedule_session(); }, visit.phase.value === "waiting" ? WAITING_POLL_MS : SESSION_POLL_MS);
}
watch(visit.phase, schedule_session);
onBeforeUnmount(() => clearTimeout(session_timer));

const guest = computed(() => visit.info.value?.guest || null);
const room_title = computed(() => visit.info.value?.room_title || invite?.room_title || "");
const clock = computed(() => {
  const total = Math.max(0, Math.ceil(visit.left_ms.value / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
});
const TABS = computed(() => [
  { value: "messages", label: t("消息"), icon: "i-lucide-message-square" },
  { value: "private", label: t("私聊"), icon: "i-lucide-lock", disabled: !guest.value?.private_chat, hint: t("房主未开放私聊") },
  { value: "executions", label: t("执行"), icon: "i-lucide-activity" },
  { value: "room", label: t("房间"), icon: "i-lucide-users" },
  { value: "files", label: t("文件"), icon: "i-lucide-folder", disabled: guest.value?.scope !== "project", hint: t("房主只开放了聊天") },
]);
const tab = ref("messages");
const END_TEXTS = {
  expired: t("时间到了，本次访问已结束。"),
  invite_expired: t("等待入场时邀请已过期，本次访问已结束。"),
  disconnected: t("房主已结束本次访问。"),
  disconnected_by_host: t("房间的主持人已结束本次访问。"),
};
</script>

<template>
  <div class="guest-page">
    <main v-if="visit.phase.value === 'restoring'" class="guest-card" role="status">
      <UIcon name="i-lucide-loader-circle" class="guest-waiting animate-spin" />
      <p>{{ t("正在恢复访问…") }}</p>
    </main>

    <main v-else-if="visit.phase.value === 'invalid'" class="guest-card">
      <h1>{{ invite === null ? t("没有邀请内容") : t("无法读取这个邀请链接") }}</h1>
      <p>{{ invite === null ? t("请打开对方发来的完整链接。") : t("链接可能被截断或改动过，请让对方重新复制完整链接发给你。") }}</p>
    </main>

    <main v-else-if="visit.phase.value === 'entry'" class="guest-card">
      <p class="guest-brand">AI CoDiscuss</p>
      <h1>{{ t("你被邀请进入房间“{room}”", { room: invite.room_title || invite.room }) }}</h1>
      <p v-if="invite_expired" class="guest-warning">{{ t("这个链接已过期，请让对方重新生成。") }}</p>
      <template v-else>
        <dl class="guest-facts">
          <dt>{{ t("访问时长") }}</dt><dd>{{ t("{duration}，从进入房间起算", { duration: duration_text(invite.duration_seconds) }) }}</dd>
          <dt>{{ t("你能做的") }}</dt><dd>{{ t("发消息、点名房间里的 AI；房主全程可见，可随时结束") }}</dd>
          <dt>{{ t("能看到") }}</dt><dd>{{ SCOPE_LABELS[invite.scope] || invite.scope }}{{ invite.private_chat ? t("，私聊只读") : "" }}</dd>
          <dt>{{ t("保护") }}</dt><dd>{{ MODE_LABELS[invite.mode] || invite.mode }}</dd>
        </dl>
        <label class="guest-field">
          <span>{{ t("你的称呼") }}</span>
          <UInput v-model="label" :maxlength="40" :placeholder="invite.label" />
        </label>
        <p v-if="entry_error" class="guest-warning" role="alert">{{ entry_error }}</p>
        <UButton :label="t('进入房间')" icon="i-lucide-log-in" size="lg" block :loading="entering" @click="enter" />
        <p class="guest-fine">{{ t("链接只能用一次，绑定这个浏览器，不需要安装任何东西。刷新页面可以继续访问；关闭这个标签页后要请房主重新邀请。") }}</p>
      </template>
    </main>

    <main v-else-if="visit.phase.value === 'waiting'" class="guest-card" role="status">
      <UIcon name="i-lucide-loader-circle" class="guest-waiting animate-spin" />
      <h1>{{ t("即将进入“{room}”", { room: room_title }) }}</h1>
      <p>{{ t("房间里有任务正在运行，结束后自动进入；倒计时从进入房间起算。") }}</p>
      <p v-if="visit.offline.value" class="guest-warning">{{ t("暂时连不上对方电脑，正在重试…") }}</p>
    </main>

    <main v-else-if="visit.phase.value === 'ended'" class="guest-card guest-ended" role="status">
      <h1>{{ t("本次访问已结束") }}</h1>
      <p>{{ END_TEXTS[visit.end_reason.value] || t("访问已失效，页面内容已清除。") }}</p>
      <p class="guest-fine">{{ t("如需继续，请联系房主重新生成邀请链接。") }}</p>
    </main>

    <div v-else class="guest-room">
      <header class="guest-top">
        <div class="guest-title"><strong>{{ room_title }}</strong><small>{{ t("外部用户 · {name}", { name: guest?.label || "" }) }}</small></div>
        <span class="guest-clock" :class="{ 'is-ending': visit.left_ms.value <= ENDING_MS }" role="timer">{{ t("剩余 {time}", { time: clock }) }}</span>
      </header>
      <nav class="guest-tabs" role="tablist">
        <!-- A tab the owner did not open stays clickable and dimmed: touch screens have no hover, so its panel says why. -->
        <button v-for="item in TABS" :key="item.value" type="button" role="tab" :aria-selected="tab === item.value" :class="{ 'is-locked': item.disabled }" :title="item.disabled ? item.hint : ''" @click="tab = item.value">
          <UIcon :name="item.icon" />{{ item.label }}
        </button>
      </nav>
      <p v-if="visit.offline.value" class="guest-offline" role="status">{{ t("暂时连不上对方电脑，正在重试；倒计时照常进行。") }}</p>
      <section class="guest-panel" role="tabpanel">
        <p v-if="TABS.find((item) => item.value === tab)?.disabled" class="guest-locked"><UIcon name="i-lucide-lock" />{{ TABS.find((item) => item.value === tab).hint }}</p>
        <GuestMessages v-else-if="tab === 'messages'" :visit="visit" />
        <GuestList v-else-if="tab === 'private'" :visit="visit" kind="private" />
        <GuestList v-else-if="tab === 'executions'" :visit="visit" kind="executions" />
        <GuestList v-else-if="tab === 'room'" :visit="visit" kind="room" />
        <GuestFiles v-else-if="tab === 'files'" :visit="visit" />
      </section>
    </div>
  </div>
</template>

<style scoped>
.guest-page { min-height: 100dvh; background: var(--ui-bg); color: var(--ui-text); }
.guest-card { box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; max-width: 560px; margin: 0 auto; padding: 48px 20px; }
.guest-card h1 { margin: 0; color: var(--ui-text-highlighted); font-size: 20px; font-weight: 600; line-height: 1.4; }
.guest-card p { margin: 0; }
.guest-brand { color: var(--ui-text-muted); font-size: 12px; }
.guest-facts { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 0; }
.guest-facts dt { color: var(--ui-text-muted); }
.guest-facts dd { margin: 0; color: var(--ui-text-highlighted); overflow-wrap: anywhere; }
.guest-field { display: flex; flex-direction: column; gap: 6px; color: var(--ui-text-muted); font-size: 13px; }
.guest-warning { color: var(--ui-warning); font-weight: 600; }
.guest-fine { color: var(--ui-text-muted); font-size: 12px; }
.guest-room { display: flex; flex-direction: column; height: 100dvh; }
.guest-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--ui-border); }
.guest-title { display: grid; min-width: 0; }
.guest-title strong { overflow: hidden; color: var(--ui-text-highlighted); white-space: nowrap; text-overflow: ellipsis; }
.guest-title small { color: var(--ui-text-muted); font-size: 12px; }
.guest-clock { flex: none; color: var(--ui-text-toned); font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.guest-clock.is-ending { color: var(--ui-error); }
.guest-offline { margin: 0; padding: 6px 16px; background: color-mix(in srgb, var(--ui-warning) 14%, transparent); color: var(--ui-warning); font-size: 12px; }
.guest-tabs { display: flex; gap: 2px; padding: 6px 12px 0; border-bottom: 1px solid var(--ui-border); overflow-x: auto; }
.guest-tabs button { display: inline-flex; flex: none; align-items: center; gap: 6px; min-height: 36px; padding: 0 12px; border-bottom: 2px solid transparent; color: var(--ui-text-muted); font-size: 13px; }
.guest-tabs button > span { width: 14px; height: 14px; }
.guest-tabs button[aria-selected="true"] { border-bottom-color: var(--ui-primary); color: var(--ui-text-highlighted); }
.guest-tabs button.is-locked { opacity: .45; }
.guest-locked { display: flex; align-items: center; justify-content: center; gap: 6px; margin: 48px 16px; color: var(--ui-text-muted); }
.guest-locked > span { width: 14px; height: 14px; }
.guest-waiting { width: 28px; height: 28px; color: var(--ui-text-muted); }
.guest-top > *, .guest-tabs { box-sizing: border-box; }
.guest-top, .guest-tabs { padding-inline: max(16px, calc((100% - 960px) / 2)); }
.guest-panel { flex: 1; min-height: 0; overflow: hidden; }
@media (max-width: 480px) {
  .guest-card { padding: 24px 14px; }
  .guest-facts { grid-template-columns: 1fr; gap: 2px; }
  .guest-facts dd { margin-bottom: 8px; }
}
</style>

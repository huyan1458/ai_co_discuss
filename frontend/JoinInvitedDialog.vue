<script setup>
/**
 * Join a room on another computer with an invitation link, typed in or read from a QR code (camera, image or pasted
 * screenshot): pick which AI of this computer goes, then set it up on its expert card (ExpertCard.vue in joining mode):
 * software, a new or resumed conversation, model, effort, its own prompt, and its local access and how it answers when
 * named (starting at 只在房间里发言 · 直接回答).
 * The same as `codiscuss join <link>`.
 */
import { computed, inject, ref, watch } from "vue";
import PlatformConfigDialog from "./PlatformConfigDialog.vue";
import RosterAdd from "./RosterAdd.vue";
import ExpertCard from "./ExpertCard.vue";
import { LEVEL_SHORT, lockdown_problem, use_invited_rooms } from "./external-members.js";
import { read_qr_image, use_qr_camera } from "./qr-scan.js";
import { t } from "./i18n.js";

const { view, bridge } = inject("discussion");
const invited = use_invited_rooms();
const open = invited.joining;
const text = ref(""), platform = ref("");
const trust = ref({ wake: "auto", confined: true });
const INVITE_LINK = /^https?:\/\/[^#\s]+\/join#\S+$/i;
/** Fill in a QR code's text when it is an invitation link. */
function take_link(value) {
  const link = String(value || "").trim();
  if (!INVITE_LINK.test(link)) return false;
  text.value = link;
  return true;
}
const { scanning, camera_ready, has_camera, video, scan, stop_scan, check_camera } = use_qr_camera({ accept: take_link,
  denied: () => bridge.notify("error", t("无法打开相机：请允许本网站使用相机，或用系统相机扫码")) });
const image_input = ref(null);
async function read_image(file) {
  if (!take_link(await read_qr_image(file))) bridge.notify("warning", t("这张图片里没有识别到邀请二维码"));
}
function pick_image(event) {
  const [file] = event.target.files;
  event.target.value = "";
  if (file) read_image(file);
}
function paste_image(event) {
  const file = [...(event.clipboardData?.files || [])].find((item) => item.type.startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  read_image(file);
}
// Opens with no AI picked, as the new-room panel starts with no member (user 2026-11-19, #5458).
watch(open, (value) => {
  if (!value) return stop_scan();
  check_camera();
  text.value = invited.join_text.value;
});
const platforms = computed(() => Object.keys(bridge.launch_clients));
// As in the new-room panel, software not set up yet stays grey at the end of the row and its chip opens the setup.
const configuring = ref("");
const items = computed(() => platforms.value.map((name) => ({ value: name, name: bridge.default_name(name), ...bridge.identities[name],
  selected: platform.value === name, aria_label: t("派 {name} 加入", { name: bridge.default_name(name) }),
  ...(bridge.platform_configured(name) ? {} : { unconfigured: true, title: t("未配置，点击配置"), aria_label: t("配置 {value1}", { value1: bridge.default_name(name) }) }) })));
function choose(name) {
  platform.value = name;
  bridge.load_launch_models(name);
}
// Software, model and effort are the platform's own launch settings, set on its expert card as elsewhere.
const profile = computed(() => (platform.value && view.value.launch.profiles[platform.value]) || {});
const card_status = computed(() => bridge.platform_configured(platform.value) ? { text: t("已配置本机软件"), tone: "ready" } : { text: t("待补齐接入配置"), tone: "warn" });
// The link alone says where the inviting computer is and carries its key fingerprint.
const is_link = computed(() => /^https?:\/\//i.test(text.value.trim()));
// Software that cannot be confined to codiscuss commands can only run unrestricted: choosing it switches to 不受限, and
// choosing other software again puts back 只在房间里发言.
const lockdown = computed(() => lockdown_problem(profile.value.adapter, profile.value));
let forced = false;
watch(lockdown, (reason) => {
  if (reason && trust.value.confined) {
    forced = true;
    trust.value = { ...trust.value, confined: false };
  } else if (!reason && forced) {
    forced = false;
    trust.value = { ...trust.value, confined: true };
  }
});
const blocked = computed(() => Boolean(lockdown.value) && trust.value.confined);
const ready = computed(() => Boolean(is_link.value && platform.value && profile.value.adapter && invited.available.value && !blocked.value));

/** What the link carries about the room: its name and what it opens. */
function link_payload(link) {
  try {
    const bytes = Uint8Array.from(atob(link.split("#")[1].replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) || {};
  } catch { return {}; }
}
const offered = computed(() => is_link.value ? link_payload(text.value.trim()) : {});
const link_room_title = (link) => String(link_payload(link).room_name || "");

// The dialog closes at once: joining crosses the relay, and the sidebar shows it under way. A failure reopens it with the link.
async function submit() {
  if (!ready.value) return;
  const link = text.value.trim();
  open.value = false;
  const result = await invited.join({ invite: link, room_title: link_room_title(link),
    adapter: profile.value.adapter, model: profile.value.model || "", effort: profile.value.effort || "", trust: trust.value,
    ...(profile.value.session_id ? { session_id: profile.value.session_id } : {}),
    ...(Object.hasOwn(profile.value, "system_prompt") ? { system_prompt: profile.value.system_prompt } : {}) });
  if (!result) return invited.start_join(link);
  // The resumed conversation now belongs to the joined record; this software's next card starts a new one.
  if (profile.value.session_id) bridge.write_launch(platform.value, "session_id", null);
  bridge.notify("info", t("已加入「{room}」", { room: result.record?.room_title || "" }));
  if (result.record?.id) invited.open(result.record.id);
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="t('加入另一台电脑的房间')"
    :description="t('你的 AI 在这台电脑上运行，只读对方开放的目录，在对方房间里回答。')" :ui="{ content: 'glass-panel studio-modal join-invited-modal', body: 'dialog-body' }">
    <template #body>
      <form class="join-invited" @submit.prevent="submit" @paste="paste_image">
        <UFormField :label="t('邀请链接')">
          <div class="join-invited-link">
            <UInput v-model="text" class="w-full" :placeholder="t('粘贴邀请链接或二维码截图')" autocomplete="off" inputmode="url" />
            <UButton icon="i-lucide-scan-line" color="neutral" variant="outline" :aria-label="t('扫码')" :title="has_camera ? t('扫码') : t('这台设备没有相机，可选择或粘贴二维码图片')" :disabled="scanning || !has_camera" :loading="scanning && !camera_ready" @click="scan" />
            <UButton icon="i-lucide-image" color="neutral" variant="outline" :aria-label="t('选择二维码图片')" :title="t('选择二维码图片')" @click="image_input?.click()" />
            <input ref="image_input" type="file" accept="image/*" hidden @change="pick_image" />
          </div>
        </UFormField>
        <div v-if="scanning" class="join-invited-scan">
          <p v-if="!camera_ready" class="fine-print" role="status">{{ t("正在打开相机…") }}</p>
          <video ref="video" muted playsinline :aria-label="t('相机画面')" />
          <UButton :label="t('取消')" color="neutral" variant="soft" size="xs" @click="stop_scan" />
        </div>
        <p v-if="text.trim() && !is_link" class="fine-print" role="alert">{{ t("这不是邀请链接，请粘贴对方发来的完整链接。") }}</p>
        <p v-else-if="LEVEL_SHORT[offered.level]" class="fine-print" role="note">{{ t("对方开放：{level}", { level: LEVEL_SHORT[offered.level] }) }}</p>
        <PlatformConfigDialog v-model="configuring" />
        <RosterAdd :label="t('派哪个 AI')" :items="items" @add="choose" @configure="(name) => { configuring = name; }" />
        <p v-if="!platforms.length && invited.available.value" class="fine-print" role="note">{{ t("这台电脑还没有可派出的 AI 软件，请先在设置里配置。") }}</p>
        <div v-if="platform" class="join-invited-card">
          <ExpertCard :key="platform" :name="platform" mode="cli" :choices="['cli', 'manual']" :status="card_status" joining v-model:trust="trust" :confine_reason="lockdown" />
        </div>
        <p v-else-if="platforms.length" class="join-invited-empty">{{ t("选择一个 AI 派去对方房间，点卡片翻面可设置软件、模型和本机权限。") }}</p>
        <p v-if="lockdown" class="fine-print" role="note" :title="lockdown">{{ t("这个 AI 只能不受限运行。") }}</p>
        <p v-if="!invited.available.value" class="fine-print" role="alert">{{ t("加入需要本机服务，请在运行 AI 的电脑打开本机网站。") }}</p>
        <div class="join-invited-footer">
          <UButton :label="t('取消')" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" icon="i-lucide-log-in" :label="t('加入')" class="channel-primary-button" :disabled="!ready || Boolean(invited.pending_join.value)" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.join-invited { display: flex; flex-direction: column; gap: 12px; }
.join-invited .fine-print { margin: -6px 0 0; }
.join-invited-link { display: flex; gap: 6px; min-width: 0; }
.join-invited-scan { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.join-invited-scan video { width: 100%; max-width: 320px; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: #000; }
.join-invited-warning { color: var(--ui-warning, #e0a33a); }
.join-invited-footer { display: flex; justify-content: flex-end; gap: 8px; }
/* One card at the invite dialog's card size. */
.join-invited-card { width: min(272px, 100%); }
.join-invited-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
/* A phone gets the new-room panel's spacing (user 2026-11-19, #5458). */
@media (max-width: 600px) {
  .join-invited { gap: 10px; }
  .join-invited :deep(.roster-add) { gap: 4px 6px; }
  .join-invited :deep(.roster-add-chips) { gap: 4px; }
  .join-invited-empty { padding: 8px 10px; }
  :global(html[data-theme^="channel"] .join-invited-modal [data-slot="header"]) { padding: 12px 14px 10px; }
  :global(html[data-theme^="channel"] .join-invited-modal [data-slot="description"]) { display: none; }
  :global(html[data-theme^="channel"] .join-invited-modal [data-slot="close"]) { top: 8px; right: 8px; }
  :global(html[data-theme^="channel"] .join-invited-modal .dialog-body) { padding: 10px 14px 12px; }
}
</style>

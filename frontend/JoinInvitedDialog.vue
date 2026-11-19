<script setup>
/**
 * Join a room on another computer with an invitation link, typed in or read from a QR code (camera, image or pasted
 * screenshot): pick which AI of this computer goes, its model and effort, and the trust level (starting at 完全借用)
 * with its limits. The same as `codiscuss join <link>`.
 */
import { computed, inject, ref, watch } from "vue";
import RosterAdd from "./RosterAdd.vue";
import EffortSlider from "./EffortSlider.vue";
import TrustLevelField from "./TrustLevelField.vue";
import { lockdown_problem, use_invited_rooms } from "./external-members.js";
import { read_qr_image, use_qr_camera } from "./qr-scan.js";
import { t } from "./i18n.js";

const { view, bridge } = inject("discussion");
const invited = use_invited_rooms();
const open = invited.joining;
const text = ref(""), platform = ref("");
const trust = ref({ trust: "borrow", max_wakes: 20, hours: 24 });
const INVITE_LINK = /^https?:\/\/[^#\s]+\/join#\S+$/i;
/** Fill in a QR code's text when it is an invitation link. */
function take_link(value) {
  const link = String(value || "").trim();
  if (!INVITE_LINK.test(link)) return false;
  text.value = link;
  return true;
}
const { scanning, camera_ready, video, scan, stop_scan } = use_qr_camera({ accept: take_link,
  denied: () => bridge.notify("error", t("无法打开相机：请允许本网站使用相机，或用系统相机扫码")) });
const can_scan = Boolean(navigator.mediaDevices?.getUserMedia);
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
watch(open, (value) => {
  if (!value) return stop_scan();
  text.value = invited.join_text.value;
});
const platforms = computed(() => Object.keys(bridge.launch_clients));
const items = computed(() => platforms.value.map((name) => ({ value: name, name: bridge.default_name(name), ...bridge.identities[name],
  selected: platform.value === name, aria_label: t("派 {name} 加入", { name: bridge.default_name(name) }) })));
function choose(name) {
  platform.value = name;
  bridge.load_launch_models(name);
}
// Model and effort are the platform's own launch settings, the same ones its expert card sets.
const profile = computed(() => (platform.value && view.value.launch.profiles[platform.value]) || {});
const model = computed({ get: () => profile.value.model || "__default__", set: (value) => bridge.write_launch_model(platform.value, value) });
const effort = computed({ get: () => profile.value.effort || "", set: (value) => bridge.write_launch(platform.value, "effort", value) });
const models = computed(() => platform.value && view.value ? bridge.launch_model_state(platform.value) : null);
const model_items = computed(() => models.value?.items || []);
const effort_items = computed(() => [{ value: "", label: t("默认强度") }, ...(models.value?.efforts || []).map((value) => ({ value, label: value }))]);
// The link alone says where the inviting computer is and carries its key fingerprint.
const is_link = computed(() => /^https?:\/\//i.test(text.value.trim()));
// Below 信任设备 the AI must be confined to codiscuss commands; software that cannot be is said so before joining.
const lockdown = computed(() => trust.value.trust === "trusted" ? "" : lockdown_problem(profile.value.adapter, profile.value));
const ready = computed(() => Boolean(is_link.value && platform.value && profile.value.adapter && invited.available.value));

/** The room's name the link carries, for the sidebar row shown while joining. */
function link_room_title(link) {
  try {
    const bytes = Uint8Array.from(atob(link.split("#")[1].replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    return String(JSON.parse(new TextDecoder().decode(bytes)).room_name || "");
  } catch { return ""; }
}

// The dialog closes at once: joining crosses the relay, and the sidebar shows it under way. A failure reopens it with the link.
async function submit() {
  if (!ready.value) return;
  const link = text.value.trim();
  open.value = false;
  const result = await invited.join({ invite: link, room_title: link_room_title(link),
    adapter: profile.value.adapter, model: profile.value.model || "", effort: profile.value.effort || "", trust: trust.value });
  if (!result) return invited.start_join(link);
  bridge.notify("info", t("已加入「{room}」", { room: result.record?.room_title || "" }));
  if (result.record?.id) invited.open(result.record.id);
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="t('加入另一台电脑的房间')"
    :description="t('你的 AI 在这台电脑上运行，只读对方开放的目录，在对方房间里回答。')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="join-invited" @submit.prevent="submit" @paste="paste_image">
        <UFormField :label="t('邀请链接')">
          <div class="join-invited-link">
            <UInput v-model="text" class="w-full" :placeholder="t('粘贴邀请链接或二维码截图')" autocomplete="off" inputmode="url" />
            <UButton v-if="can_scan" icon="i-lucide-scan-line" color="neutral" variant="outline" :aria-label="t('扫码')" :title="t('扫码')" :disabled="scanning" :loading="scanning && !camera_ready" @click="scan" />
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
        <RosterAdd :label="t('派哪个 AI')" :items="items" @add="choose" />
        <p v-if="!platforms.length && invited.available.value" class="fine-print" role="note">{{ t("这台电脑还没有可派出的 AI 软件，请先在设置里配置。") }}</p>
        <template v-if="platform">
          <UFormField :label="t('模型')">
            <USelect v-model="model" :items="model_items" class="w-full" :loading="models?.loading" :placeholder="t('软件默认模型')" />
          </UFormField>
          <EffortSlider v-if="effort_items.length > 1" v-model="effort" :items="effort_items" :label="t('强度')" />
        </template>
        <TrustLevelField v-model="trust" :trusted_locked="!invited.trust_local.value" />
        <p v-if="lockdown" class="fine-print join-invited-warning" role="note">{{ t("这个软件不能限制为只用共议命令（{reason}），只能在“信任设备”等级下服务；其他等级下被点名时不会启动。", { reason: lockdown }) }}</p>
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
</style>

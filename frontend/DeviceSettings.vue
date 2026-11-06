<script setup>
/** Paired devices: pair this browser with a code from a trusted screen, add another device by QR code, create or renew this
 * device's passkey, and revoke devices or their remote write grants. The paired computer decides; this only asks it. */
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { renderSVG } from "uqr";
import jsQR from "jsqr";
import ConfirmDialog from "./ConfirmDialog.vue";

const { view, bridge } = inject("discussion");
const local = computed(() => view.value.admin.local);
// Another device reaches the computer through the relay; the computer's own page asks its local service.
const remote = computed(() => !local.value && view.value.launch.available && view.value.launch.remote);
const device = computed(() => view.value.device);
const devices = ref(null);
const audit = ref([]);
const audit_open = ref("");
const busy = ref("");
const code = ref("");
const temporary = ref(false);
// Lets the next code pair a browser that cannot create passkeys; such a device skips the daily confirmation.
const without_passkey = ref(false);
const invite = ref(null);
// The device waiting for the user to confirm unbinding it.
const unbinding = ref(null);
const unbinding_open = ref(false);
const RENEW_SOON_MS = 7 * 86400000;
const INVITE_POLL_MS = 3000;
let invite_timer = null;

watch(() => device.value.pairing_code, (value) => { if (value) code.value = value; }, { immediate: true });

async function run(name, task, success = "") {
  if (busy.value) return false;
  busy.value = name;
  try {
    await task();
    if (success) bridge.notify("info", success);
    return true;
  } catch (error) {
    if (!error.cancelled && !error.need) bridge.notify("error", error.message);
    return false;
  } finally { busy.value = ""; }
}

/** Read the device list; an unpaired browser learns here that it must pair first. */
function load() {
  if (!local.value && !remote.value) return;
  return run("list", async () => {
    const result = await bridge.device.request("device-list");
    devices.value = result.devices;
    audit.value = result.audit || [];
  });
}
onMounted(load);
watch(remote, (value) => { if (value) load(); });

const current = computed(() => devices.value?.find((item) => item.current));
// The computer said this browser is not paired (or no longer is): show the code form even before settings load.
const needs_pairing = computed(() => !local.value && view.value.admin.devices && !view.value.admin.logged_in);
const renew_due = computed(() => current.value && !current.value.temporary && current.value.expires_at - Date.now() < RENEW_SOON_MS);

async function pair() {
  if (await run("pair", () => bridge.device.pair(code.value))) await load();
}

// Scanning in the page: the camera frames are read here until a pairing link shows up, then pairing starts at once.
const scanning = ref(false);
const video = ref(null);
let stream = null;
function stop_scan() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  scanning.value = false;
}
async function scan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
  } catch {
    bridge.notify("error", "无法打开相机：请允许本网站使用相机，或用系统相机扫码");
    return;
  }
  scanning.value = true;
  await new Promise(requestAnimationFrame);
  video.value.srcObject = stream;
  await video.value.play().catch(() => {});
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const frame = () => {
    if (!scanning.value) return;
    const { videoWidth: width, videoHeight: height } = video.value;
    if (width && height) {
      Object.assign(canvas, { width, height });
      context.drawImage(video.value, 0, 0, width, height);
      const found = jsQR(context.getImageData(0, 0, width, height).data, width, height, { inversionAttempts: "dontInvert" });
      const scanned = found && bridge.device.take_scanned(found.data);
      if (scanned) {
        stop_scan();
        code.value = scanned;
        return pair();
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Show a two-minute code and the QR code a phone camera can open, for pairing another device. */
function add_device() {
  return run("invite", async () => {
    const result = await bridge.device.invite(temporary.value, without_passkey.value);
    invite.value = { ...result, svg: result.url ? renderSVG(result.url, { border: 1 }) : "", expired: false };
    watch_invite(devices.value?.length || 0);
  });
}

/** While a code is shown, read the list again: close the code once a new device pairs, and mark it expired on time. */
function watch_invite(known) {
  clearInterval(invite_timer);
  invite_timer = setInterval(async () => {
    if (!invite.value) return clearInterval(invite_timer);
    if (Date.now() >= invite.value.expires_at) {
      invite.value = { ...invite.value, expired: true };
      return clearInterval(invite_timer);
    }
    try {
      const result = await bridge.device.request("device-list");
      devices.value = result.devices;
      audit.value = result.audit || [];
      if (result.devices.length > known) {
        invite.value = null;
        clearInterval(invite_timer);
        bridge.notify("info", "新设备已配对");
      }
    } catch { /* The next tick tries again; the code expires on its own. */ }
  }, INVITE_POLL_MS);
}
onUnmounted(() => { clearInterval(invite_timer); stop_scan(); });

function ask_unbind(item) {
  unbinding.value = item;
  unbinding_open.value = true;
}
const unbind_items = computed(() => unbinding.value?.current
  ? ["这台设备会立即退出，要再用须回到电脑前重新扫码配对。", "已经在运行的工作和已改动的文件不会撤回。"]
  : ["该设备会立即无法访问房间，要再用须在电脑前重新扫码配对。", "已经在运行的工作和已改动的文件不会撤回。"]);

/** Revoke a device on the computer; the website drops it with the next signed device list, which is sent at once. */
async function revoke(item) {
  const done = await run("revoke", () => bridge.device.request("device-revoke", { device_id: item.id }), item.current ? "这台设备已解绑" : "该设备已解绑");
  if (done && item.current) bridge.device.forget();
  else if (done) await load();
}


// What the computer recorded about other devices: trust changes and remote writes, never their content.
const AUDIT_EVENTS = { "device.paired": "配对了新设备", "device.revoked": "解绑了设备", "device.renewed": "设备续期", "pairing.started": "生成了配对码", "device.unlocked": "确认解锁",
  "passkey.registered": "创建了通行密钥", "write.granted": "开启远程可写", "write.revoked": "撤销远程可写" };
const device_name = (id) => !id ? "电脑本机" : devices.value?.find((item) => item.id === id)?.label || `已解绑的设备（${id.slice(0, 6)}）`;
/** One record line; `with_device` names the device for lists that mix several (revoked devices). */
function audit_text(entry, with_device) {
  const prefix = with_device ? `${device_name(entry.device)} ` : "";
  if (entry.event === "command") return `${prefix}远程执行 ${entry.action}${entry.route ? ` ${entry.route}` : ""}${entry.status >= 400 ? "（被拒绝）" : ""}`;
  const paired = entry.event === "device.paired" && entry.temporary ? "（临时）" : "";
  return `${prefix}${AUDIT_EVENTS[entry.event] || entry.event}${paired}${entry.room ? ` · ${room_title(entry.room)}` : ""}`;
}
// Generating a code changes nothing by itself; the list shows only what changed trust or reached the computer.
const shown_audit = computed(() => audit.value.filter((entry) => entry.event !== "pairing.started"));
// Each paired device shows its own records; records of devices no longer paired are kept together below the list.
const device_audit = (id) => shown_audit.value.filter((entry) => entry.device === id);
const revoked_audit = computed(() => shown_audit.value.filter((entry) => !devices.value?.some((item) => item.id === entry.device)));
const toggle_audit = (key) => { audit_open.value = audit_open.value === key ? "" : key; };
const room_title = (room_id) => view.value.rooms?.find((room) => room.id === room_id)?.title || room_id;
const date = (time) => new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <section v-if="local || remote || needs_pairing || device.needs" class="device-settings" aria-labelledby="device-heading">
    <h4 id="device-heading">已配对的设备</h4>
    <p v-if="!needs_pairing" class="fine-print">新设备须在电脑前扫码配对。</p>

    <form v-if="needs_pairing" class="dialog-form device-pair" aria-label="配对这台设备" @submit.prevent="pair">
      <p class="fine-print">扫描电脑本机网页 设置 → 添加设备 的二维码，或输入配对码。</p>
      <div class="device-pair-row">
        <UInput v-model="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" :maxlength="16" class="w-full" aria-label="配对码" />
        <UButton icon="i-lucide-scan-line" color="neutral" variant="outline" aria-label="扫码" title="扫码" :disabled="Boolean(busy)" @click="scan" />
      </div>
      <div v-if="scanning" class="device-scan">
        <video ref="video" muted playsinline aria-label="相机画面" />
        <UButton label="取消" color="neutral" variant="soft" size="xs" @click="stop_scan" />
      </div>
      <div class="account-actions"><UButton type="submit" label="配对" class="channel-primary-button" :loading="busy === 'pair'" :disabled="Boolean(busy) || !code.trim()" /></div>
    </form>

    <p v-else-if="device.needs === 'renew'" class="account-message is-error" role="status">
      这台设备的授权已到期。<UButton label="用通行密钥续期" color="neutral" variant="soft" size="xs" :loading="busy === 'renew'" :disabled="Boolean(busy)" @click="run('renew', async () => { await bridge.device.renew(); await load(); })" />
    </p>
    <template v-else>
      <div class="device-actions">
        <UButton v-if="remote && renew_due" label="续期这台设备" color="neutral" variant="soft" size="sm" :loading="busy === 'renew'" :disabled="Boolean(busy)" @click="run('renew', async () => { await bridge.device.renew(); await load(); })" />
        <UButton v-if="local" label="添加设备" icon="i-lucide-qr-code" color="neutral" variant="outline" size="sm" :loading="busy === 'invite'" :disabled="Boolean(busy)" @click="add_device" />
        <UCheckbox v-if="local" v-model="temporary" label="临时设备（只授权 1 天）" />
        <UCheckbox v-if="local" v-model="without_passkey" label="允许不用通行密钥" description="只在新设备的浏览器不支持通行密钥时勾选：它不需要每天确认，到期须回电脑前重新配对" />
      </div>
      <div v-if="invite" class="device-invite" role="status">
        <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
        <div v-if="invite.svg" class="device-qr" :class="{ 'device-expired': invite.expired }" aria-label="配对二维码" v-html="invite.svg" />
        <div>
          <p>用新设备的相机扫描二维码；没有摄像头就在新设备打开网站，输入配对码：</p>
          <p class="device-code" :class="{ 'device-expired': invite.expired }">{{ invite.code }}</p>
          <p v-if="invite.expired" class="fine-print device-expired-note">已过期，不能再用。</p>
          <p v-else class="fine-print">{{ date(invite.expires_at) }} 前有效（2 分钟），只能用一次{{ invite.temporary ? "；临时设备只授权 1 天" : "" }}{{ invite.without_passkey ? "；允许不用通行密钥" : "" }}。</p>
          <UButton label="重新生成" icon="i-lucide-refresh-cw" color="neutral" variant="outline" size="xs" :loading="busy === 'invite'" :disabled="Boolean(busy)" @click="add_device" />
        </div>
      </div>
      <ul v-if="devices" class="account-device-list">
        <li v-for="item in devices" :key="item.id">
          <div class="device-row">
            <span>
              <strong>{{ item.label }}<template v-if="item.current"> · 当前设备</template><template v-if="item.temporary"> · 临时</template></strong>
              <small>{{ item.expires_at > Date.now() ? `授权至 ${date(item.expires_at)}` : "授权已到期" }}{{ item.passkeys ? "" : " · 未创建通行密钥" }}</small>
            </span>
            <UButton v-if="device_audit(item.id).length" icon="i-lucide-history" :color="audit_open === item.id ? 'primary' : 'neutral'" variant="ghost" size="xs" aria-label="使用记录" title="使用记录" :aria-expanded="audit_open === item.id" @click="toggle_audit(item.id)" />
            <UButton icon="i-lucide-unlink" color="error" variant="ghost" size="xs" aria-label="解绑" :title="item.current ? '解绑这台设备' : '解绑'" :disabled="Boolean(busy)" @click="ask_unbind(item)" />
          </div>
          <div v-if="audit_open === item.id" class="device-audit">
            <ul :aria-label="`${item.label} 的记录`">
              <li v-for="(entry, index) in device_audit(item.id)" :key="index"><small>{{ date(entry.at) }}</small> {{ audit_text(entry, false) }}</li>
            </ul>
            <p class="fine-print">记录由电脑保存。看到不是你做的操作，立即解绑这台设备。</p>
          </div>
        </li>
        <li v-if="!devices.length" class="device-empty">还没有配对的设备</li>
        <li v-if="revoked_audit.length" class="device-revoked">
          <div class="device-row">
            <span><small>已解绑设备的记录</small></span>
            <UButton icon="i-lucide-history" :color="audit_open === 'revoked' ? 'primary' : 'neutral'" variant="ghost" size="xs" aria-label="使用记录" title="使用记录" :aria-expanded="audit_open === 'revoked'" @click="toggle_audit('revoked')" />
          </div>
          <div v-if="audit_open === 'revoked'" class="device-audit">
            <ul aria-label="已解绑设备的记录">
              <li v-for="(entry, index) in revoked_audit" :key="index"><small>{{ date(entry.at) }}</small> {{ audit_text(entry, true) }}</li>
            </ul>
          </div>
        </li>
      </ul>
      <ConfirmDialog v-model:open="unbinding_open" :title="unbinding?.current ? '解绑这台设备' : `解绑「${unbinding?.label || ''}」`" :items="unbind_items"
        confirm-label="解绑" danger @confirm="revoke(unbinding)" />
    </template>
  </section>
</template>

<style scoped>
.device-settings { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.device-settings h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.device-pair { width: 100%; }
.account-device-list { display: flex; flex-direction: column; gap: 4px; width: 100%; margin: 0; padding: 0; list-style: none; }
.account-device-list > li { padding: 6px 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.device-row { display: flex; align-items: center; gap: 4px; min-height: 28px; }
.device-row > span { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.device-row > button { flex-shrink: 0; }
.device-row strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.device-row small { color: var(--ui-text-muted); font-size: 11px; }
/* A device's records open inside its own card, under a divider. */
.device-audit { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--ui-border-muted); }
.device-audit ul { display: flex; flex-direction: column; gap: 2px; max-height: 220px; margin: 0 0 6px; padding: 0; overflow-y: auto; list-style: none; font-size: 12px; }
.device-audit small { color: var(--ui-text-muted); }
.device-empty { color: var(--ui-text-dimmed); font-size: 12px; }
.device-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.device-invite { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--ui-border); border-radius: 10px; }
.device-invite p { margin: 0 0 4px; font-size: 12px; }
.device-expired { opacity: 0.35; filter: grayscale(1); }
.device-pair-row { display: flex; gap: 8px; align-items: center; }
.device-scan { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.device-scan video { width: 100%; max-width: 320px; aspect-ratio: 1; object-fit: cover; border-radius: 10px; background: #000; }
.device-code.device-expired { text-decoration: line-through; }
.device-expired-note { color: var(--ui-error); }
.device-qr { width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.device-qr :deep(svg) { display: block; width: 100%; height: 100%; }
/* Touch screens: buttons and the temporary checkbox take a fingertip. */
@media (pointer: coarse) {
  .device-actions > *, .device-row > button, .device-invite button { min-height: 36px; }
  .device-actions > :not(button) { display: flex; align-items: center; }
}
/* Phones: the QR code sits above its instructions instead of squeezing beside them. */
@media (max-width: 480px) {
  .device-invite { flex-direction: column; align-items: stretch; }
  .device-qr { align-self: center; width: 180px; height: 180px; }
}
.device-code { color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 18px !important; font-weight: 600; letter-spacing: 1px; }
</style>

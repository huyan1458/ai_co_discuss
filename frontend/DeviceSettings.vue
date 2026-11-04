<script setup>
/** Paired devices: pair this browser with a code from a trusted screen, add another device by QR code, create or renew this
 * device's passkey, and revoke devices or their remote write grants. The paired computer decides; this only asks it. */
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { renderSVG } from "uqr";
import jsQR from "jsqr";

const { view, bridge } = inject("discussion");
const local = computed(() => view.value.admin.local);
// Another device reaches the computer through the relay; the computer's own page asks its local service.
const remote = computed(() => !local.value && view.value.launch.available && view.value.launch.remote);
const device = computed(() => view.value.device);
const devices = ref(null);
const audit = ref([]);
const audit_open = ref(false);
const busy = ref("");
const code = ref("");
const temporary = ref(false);
const invite = ref(null);
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
    const result = await bridge.device.invite(temporary.value);
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

/** Revoke a device on the computer; the website drops it with the next signed device list, which is sent at once. */
async function revoke(item) {
  const done = await run("revoke", () => bridge.device.request("device-revoke", { device_id: item.id }), item.current ? "这台设备已取消配对" : "该设备已撤销");
  if (done && item.current) bridge.device.forget();
  else if (done) await load();
}

async function revoke_write(item, grant) {
  if (await run("revoke", () => bridge.device.request("write-revoke", { device_id: item.id, room_id: grant.room_id }), "已撤销远程可写")) await load();
}

// What the computer recorded about other devices: trust changes and remote writes, never their content.
const AUDIT_EVENTS = { "device.paired": "配对了新设备", "device.revoked": "撤销了设备", "device.renewed": "设备续期", "pairing.started": "生成了配对码",
  "passkey.registered": "创建了通行密钥", "write.granted": "开启远程可写", "write.revoked": "撤销远程可写" };
const device_name = (id) => !id ? "电脑本机" : devices.value?.find((item) => item.id === id)?.label || `已撤销的设备（${id.slice(0, 6)}）`;
function audit_text(entry) {
  if (entry.event === "command") return `${device_name(entry.device)} 远程执行 ${entry.action}${entry.route ? ` ${entry.route}` : ""}${entry.status >= 400 ? "（被拒绝）" : ""}`;
  const subject = entry.event === "device.paired" ? `${entry.label || "新设备"}${entry.temporary ? "（临时）" : ""}` : device_name(entry.device);
  return `${AUDIT_EVENTS[entry.event] || entry.event}：${subject}${entry.room ? ` · ${room_title(entry.room)}` : ""}`;
}
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
      <p v-if="devices && devices.length < 2" class="fine-print">建议配对两台：丢了一台，可在外面用另一台撤销它。</p>
      <ul v-if="devices" class="account-device-list">
        <li v-for="item in devices" :key="item.id">
          <span>
            <strong>{{ item.label }}<template v-if="item.current"> · 当前设备</template><template v-if="item.temporary"> · 临时</template></strong>
            <small>{{ item.expires_at > Date.now() ? `授权至 ${date(item.expires_at)}` : "授权已到期" }}{{ item.passkeys ? "" : " · 未创建通行密钥" }}</small>
            <small v-for="grant in item.write_rooms" :key="grant.room_id" class="device-grant">
              远程可写：{{ room_title(grant.room_id) }}，至 {{ date(grant.until) }}
              <button type="button" class="device-link" :disabled="Boolean(busy)" @click="revoke_write(item, grant)">撤销</button>
            </small>
          </span>
          <UButton :label="item.current ? '取消配对' : '撤销'" color="neutral" variant="ghost" size="xs" :disabled="Boolean(busy)" @click="revoke(item)" />
        </li>
        <li v-if="!devices.length" class="device-empty">还没有配对的设备</li>
      </ul>
      <div v-if="audit.length" class="device-audit">
        <button type="button" class="device-link" @click="audit_open = !audit_open">{{ audit_open ? "收起" : "查看" }}最近记录（{{ audit.length }}）</button>
        <ul v-if="audit_open" aria-label="最近记录">
          <li v-for="(entry, index) in audit" :key="index"><small>{{ date(entry.at) }}</small> {{ audit_text(entry) }}</li>
        </ul>
        <p v-if="audit_open" class="fine-print">记录由电脑保存。看到不是你做的操作，立即撤销对应设备。</p>
      </div>
      <div class="device-actions">
        <UButton v-if="remote && renew_due" label="续期这台设备" color="neutral" variant="soft" size="sm" :loading="busy === 'renew'" :disabled="Boolean(busy)" @click="run('renew', async () => { await bridge.device.renew(); await load(); })" />
        <UButton v-if="local" label="添加设备" icon="i-lucide-qr-code" color="neutral" variant="outline" size="sm" :loading="busy === 'invite'" :disabled="Boolean(busy)" @click="add_device" />
        <UCheckbox v-if="local" v-model="temporary" label="临时设备（只授权 1 天）" />
      </div>
      <div v-if="invite" class="device-invite" role="status">
        <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
        <div v-if="invite.svg" class="device-qr" :class="{ 'device-expired': invite.expired }" aria-label="配对二维码" v-html="invite.svg" />
        <div>
          <p>用新设备的相机扫描二维码；没有摄像头就在新设备打开网站，输入配对码：</p>
          <p class="device-code" :class="{ 'device-expired': invite.expired }">{{ invite.code }}</p>
          <p v-if="invite.expired" class="fine-print device-expired-note">已过期，不能再用。</p>
          <p v-else class="fine-print">{{ date(invite.expires_at) }} 前有效（2 分钟），只能用一次{{ invite.temporary ? "；临时设备只授权 1 天" : "" }}。</p>
          <UButton label="重新生成" icon="i-lucide-refresh-cw" color="neutral" variant="outline" size="xs" :loading="busy === 'invite'" :disabled="Boolean(busy)" @click="add_device" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.device-settings { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.device-settings h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.device-pair { width: 100%; }
.account-device-list { display: flex; flex-direction: column; gap: 4px; width: 100%; margin: 0; padding: 0; list-style: none; }
.account-device-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 6px 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.account-device-list span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.account-device-list strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.account-device-list small { color: var(--ui-text-muted); font-size: 11px; }
.device-grant { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.device-link { color: var(--channel-accent); font-size: 11px; text-decoration: underline; }
.device-audit { width: 100%; }
.device-audit ul { display: flex; flex-direction: column; gap: 2px; max-height: 220px; margin: 6px 0 0; padding: 0; overflow-y: auto; list-style: none; font-size: 12px; }
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
.device-code { color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 18px !important; font-weight: 600; letter-spacing: 1px; }
</style>

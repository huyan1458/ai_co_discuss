<script setup>
/** Paired devices: pair this browser with a code from a trusted screen, add another device by QR code, create or renew this
 * device's passkey, and revoke devices or their remote write grants. The paired computer decides; this only asks it. */
import { computed, inject, onMounted, ref, watch } from "vue";
import { renderSVG } from "uqr";

const { view, bridge } = inject("discussion");
const local = computed(() => view.value.admin.local);
// Another device reaches the computer through the relay; the computer's own page asks its local service.
const remote = computed(() => !local.value && view.value.launch.available && view.value.launch.remote);
const device = computed(() => view.value.device);
const devices = ref(null);
const busy = ref("");
const code = ref("");
const temporary = ref(false);
const invite = ref(null);
const RENEW_SOON_MS = 7 * 86400000;

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
  return run("list", async () => { devices.value = (await bridge.device.request("device-list")).devices; });
}
onMounted(load);
watch(remote, (value) => { if (value) load(); });

const current = computed(() => devices.value?.find((item) => item.current));
// The computer said this browser is not paired (or no longer is): show the code form even before settings load.
const needs_pairing = computed(() => !local.value && (device.value.needs === "pairing" || (remote.value && devices.value && !current.value)));
const renew_due = computed(() => current.value && !current.value.temporary && current.value.expires_at - Date.now() < RENEW_SOON_MS);

async function pair() {
  if (await run("pair", () => bridge.device.pair(code.value), "这台设备已与电脑配对")) {
    await load();
    // A passkey lets this device sign in, renew and confirm remote writing without the password.
    run("passkey", () => bridge.device.create_passkey());
  }
}

/** Show a two-minute code and the QR code a phone camera can open, for pairing another device. */
function add_device() {
  return run("invite", async () => {
    const result = await bridge.device.request("device-pairing", { temporary: temporary.value });
    invite.value = { ...result, svg: result.url ? renderSVG(result.url, { border: 1 }) : "" };
  });
}

async function revoke(item) {
  if (await run("revoke", () => bridge.device.request("device-revoke", { device_id: item.id }), item.current ? "这台设备已取消配对" : "该设备已撤销")) await load();
}

async function revoke_write(item, grant) {
  if (await run("revoke", () => bridge.device.request("write-revoke", { device_id: item.id, room_id: grant.room_id }), "已撤销远程可写")) await load();
}

const room_title = (room_id) => view.value.rooms?.find((room) => room.id === room_id)?.title || room_id;
const date = (time) => new Date(time).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
</script>

<template>
  <section v-if="local || remote || device.needs" class="device-settings" aria-labelledby="device-heading">
    <h4 id="device-heading">已配对的设备</h4>
    <p class="fine-print">其他设备第一次连接这台电脑时，须输入在电脑或已配对设备上显示的配对码；之后用它自己的通行密钥确认。偷到密码的人无法配对新设备。</p>

    <form v-if="needs_pairing" class="dialog-form device-pair" aria-label="配对这台设备" @submit.prevent="pair">
      <p class="account-message is-error" role="status">这台设备还没有与电脑配对，暂时不能操作电脑上的房间。</p>
      <UFormField label="配对码" description="在电脑的本机网页或已配对设备的 设置 → 账号 中点“添加设备”获取；扫描二维码会自动填入">
        <UInput v-model="code" placeholder="XXXX-XXXX-XXXX" autocomplete="off" :maxlength="16" class="w-full" aria-label="配对码" />
      </UFormField>
      <div class="account-actions"><UButton type="submit" label="配对" class="channel-primary-button" :loading="busy === 'pair'" :disabled="Boolean(busy) || !code.trim()" /></div>
    </form>

    <p v-else-if="device.needs === 'renew'" class="account-message is-error" role="status">
      这台设备的授权已到期。<UButton label="用通行密钥续期" color="neutral" variant="soft" size="xs" :loading="busy === 'renew'" :disabled="Boolean(busy)" @click="run('renew', async () => { await bridge.device.renew(); await load(); })" />
    </p>
    <template v-else>
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
      <div class="device-actions">
        <UButton v-if="remote && current && !current.passkeys" label="创建通行密钥" color="neutral" variant="soft" size="sm" :loading="busy === 'passkey'" :disabled="Boolean(busy)" @click="run('passkey', () => bridge.device.create_passkey())" />
        <UButton v-if="remote && renew_due" label="续期这台设备" color="neutral" variant="soft" size="sm" :loading="busy === 'renew'" :disabled="Boolean(busy)" @click="run('renew', async () => { await bridge.device.renew(); await load(); })" />
        <UButton label="添加设备" icon="i-lucide-qr-code" color="neutral" variant="outline" size="sm" :loading="busy === 'invite'" :disabled="Boolean(busy)" @click="add_device" />
        <UCheckbox v-model="temporary" label="临时设备（只授权 1 天）" />
      </div>
      <div v-if="invite" class="device-invite" role="status">
        <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
        <div v-if="invite.svg" class="device-qr" aria-label="配对二维码" v-html="invite.svg" />
        <div>
          <p>用新设备的相机扫描二维码，或在新设备上登录后输入配对码：</p>
          <p class="device-code">{{ invite.code }}</p>
          <p class="fine-print">{{ date(invite.expires_at) }} 前有效（2 分钟），只能用一次{{ invite.temporary ? "；临时设备只授权 1 天" : "" }}。</p>
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
.device-empty { color: var(--ui-text-dimmed); font-size: 12px; }
.device-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.device-invite { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px; border: 1px solid var(--ui-border); border-radius: 10px; }
.device-invite p { margin: 0 0 4px; font-size: 12px; }
.device-qr { width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.device-qr :deep(svg) { display: block; width: 100%; height: 100%; }
.device-code { color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 18px !important; font-weight: 600; letter-spacing: 1px; }
</style>

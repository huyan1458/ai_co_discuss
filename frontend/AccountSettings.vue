<script setup>
import { computed, inject, reactive, ref, watch } from "vue";
import DeviceSettings from "./DeviceSettings.vue";
import SecretKeyInput from "./SecretKeyInput.vue";
import { object_storage_fields, object_storage_values } from "./object-storage-fields.js";
import { locale, t } from './i18n.js';

const { view, bridge } = inject("discussion");
const account = computed(() => view.value.admin);
const profile = computed(() => account.value.profile);
// The online website has no accounts: a device is either paired with the computer or not. Self-hosted sites keep a login.
const state_key = computed(() => !account.value.loaded ? "loading" : account.value.devices ? (account.value.logged_in ? "profile" : "unpaired")
  : !account.value.registered ? "register" : !account.value.logged_in ? "login" : "profile");
const busy = ref("");
const auth_form = reactive({ username: "", password: "", confirm: "", setup_key: "" });
const display_name = ref("");
const avatar_input = ref(null);
const name_changed = computed(() => display_name.value.trim() !== (profile.value?.username || ""));
const register_blocked = computed(() => state_key.value === "register" && !account.value.setup_available);
// A hosted account's page opened through the account entry signs out there; opened at the instance itself (the computer
// owner's direct link) there is no entry sign-in to end, so the section is not shown.
const via_entry = computed(() => Boolean(view.value.entry_account));
const can_set_storage = computed(() => Boolean((via_entry.value || view.value.launch.projects_restricted) && view.value.launch.available));
const storage = ref(null), storage_url = ref(""), storage_busy = ref("");
const saved_storage_key = computed(() => storage.value?.configured && normalized_storage_url() === storage.value.base_url);
const storage_request = (payload = {}) => bridge.local_request("object-storage-settings", payload);
function normalized_storage_url() { return storage_url.value.trim().replace(/\/+$/, ""); }
watch(can_set_storage, async (available) => {
  if (!available) { storage.value = null; return; }
  try {
    const settings = await storage_request();
    if (!can_set_storage.value) return;
    storage.value = settings;
    storage_url.value = settings.base_url;
  } catch (error) { bridge.notify("error", error.message); }
}, { immediate: true });

async function save_storage_key(api_key) {
  const base_url = normalized_storage_url();
  storage_busy.value = "save";
  try {
    const { api_key_ref } = await bridge.local_request("api-key", { base_url, api_key });
    storage.value = await storage_request({ base_url, api_key_ref });
    storage_url.value = storage.value.base_url;
    bridge.notify("info", t("已保存"));
    void bridge.execute("refresh", { room: false });
  } finally { storage_busy.value = ""; }
}
// The cloud space's number settings (retention days, quota, threshold), each saved on its own when its field is left.
const storage_fields = computed(() => object_storage_fields(view.value.attachment_limit_mib));
const storage_values = ref({});
watch(storage, (settings) => { if (settings) storage_values.value = object_storage_values(storage_fields.value, settings); });
async function save_storage_field(field) {
  const value = storage_values.value[field.key];
  if (!Number.isInteger(value) || value < field.min || value > field.max) { bridge.notify("error", field.invalid); return; }
  if (value === storage.value?.[field.key] || storage_busy.value) return;
  storage_busy.value = field.key;
  try {
    storage.value = await storage_request({ [field.key]: value });
    bridge.notify("info", t("已保存"));
    void bridge.execute("refresh", { room: false });
  } catch (error) { bridge.notify("error", error.message); }
  finally { storage_busy.value = ""; }
}
// The owner can let this account use the owner's own cloud space instead of a key of its own; only the owner changes it.
// The files themselves are managed in the file page's "云空间".
const uses_admin_storage = computed(() => storage.value?.mode === "admin");
async function manage_storage(action) {
  if (action === "clear" && !window.confirm(t("清除后超过上限的文件将无法上传，已存于对象存储的附件也无法下载。确认清除？"))) return;
  storage_busy.value = action;
  try {
    const result = await storage_request({ action });
    if (action === "clear") {
      storage.value = result;
      storage_url.value = result.base_url;
      void bridge.execute("refresh", { room: false });
    }
    bridge.notify("info", action === "test" ? t("连接成功") : t("已清除"));
  } catch (error) { bridge.notify("error", error.message); }
  finally { storage_busy.value = ""; }
}

watch(() => profile.value?.username, (value) => { display_name.value = value || ""; }, { immediate: true });
watch(state_key, () => { Object.assign(auth_form, { password: "", confirm: "", setup_key: "" }); });

/** Run one account request with a single in-flight guard; the result shows as a toast. */
async function run(name, task, success = "") {
  if (busy.value) return false;
  busy.value = name;
  try {
    await task();
    if (success) bridge.notify("info", success);
    return true;
  } catch (error) {
    bridge.notify("error", error.message);
    return false;
  } finally { busy.value = ""; }
}

/** Create the administrator account, or sign in, from the shared credential form. */
function submit_auth() {
  const registering = state_key.value === "register";
  if (registering && register_blocked.value) return;
  return run(registering ? "register" : "login", () => registering ? bridge.admin.register({ ...auth_form }) : bridge.admin.login({ ...auth_form }),
    registering ? t('管理员账号已创建，并已登录。') : t('已登录。'));
}

/** Save only the name when it changed. */
function save_name() {
  if (!name_changed.value) return;
  return run("name", () => bridge.admin.update_profile({ username: display_name.value }), t('名称已更新。'));
}

/** Upload a picked image after it is resized to a small square. */
async function choose_avatar(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await run("avatar", async () => bridge.admin.update_profile({ avatar: await bridge.admin.avatar_from_file(file) }), t('头像已更新。'));
}

/** Return to the default fingerprint avatar. */
function reset_avatar() {
  return run("avatar", () => bridge.admin.update_profile({ avatar: "" }), t('已恢复默认头像。'));
}

/** Leave this browser. */
async function sign_out() {
  await run("logout", () => bridge.admin.logout(), t('已退出登录。'));
}

// ---- Logins on other devices, and the password: an online site only; the local site has no account. ----
const sessions = ref(null);

/** Read the live logins; shown on demand, since each read touches the website's database. */
function load_sessions() {
  return run("sessions", async () => { sessions.value = await bridge.admin.sessions(); });
}

/** End one other login, or all others, then show the list again. */
async function end_sessions(target, message) {
  if (await run("revoke", () => bridge.admin.revoke(target), message)) await load_sessions();
}

const device_label = (agent) => bridge.device.label(agent);

function seen(seconds) {
  return new Date(seconds * 1000).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const password_form = reactive({ current_password: "", password: "", confirm: "" });
async function save_password() {
  if (await run("password", () => bridge.admin.change_password({ ...password_form }), t('密码已更改，其他设备已退出登录。'))) {
    Object.assign(password_form, { current_password: "", password: "", confirm: "" });
    if (sessions.value) await load_sessions();
  }
}
</script>

<template>
  <section class="account-settings" aria-labelledby="account-heading">
    <h3 id="account-heading">{{ t('账号') }}</h3>
    <p v-if="state_key === 'loading'" class="fine-print" role="status">{{ t('正在读取账号状态…') }}</p>
    <DeviceSettings v-else-if="state_key === 'unpaired'" />

    <form v-else-if="state_key === 'register' || state_key === 'login'" class="dialog-form account-form" :aria-label="state_key === 'register' ? t('设置管理员账号') : t('登录管理员账号')" @submit.prevent="submit_auth">
      <p class="fine-print account-intro">
        <template v-if="state_key === 'register'">{{ t('设置站点管理员账号：名称和头像对所有访客可见，登录后可在没有房间凭据的浏览器中存档、恢复、删除房间。') }}</template>
        <template v-else>{{ t('登录后可管理房间；未登录时仍可阅读并使用本浏览器创建的房间。') }}</template>
      </p>
      <UFormField :label="t('用户名')" :description="state_key === 'register' ? t('1–30 个字符，也是公开显示的名称') : undefined" required>
        <UInput v-model="auth_form.username" autocomplete="username" :maxlength="30" required class="w-full" :aria-label="t('用户名')" />
      </UFormField>
      <UFormField :label="t('密码')" :description="state_key === 'register' ? t('8–128 个字符') : undefined" required>
        <UInput v-model="auth_form.password" type="password" :autocomplete="state_key === 'register' ? 'new-password' : 'current-password'" :maxlength="128" required class="w-full" :aria-label="t('密码')" />
      </UFormField>
      <template v-if="state_key === 'register'">
        <UFormField :label="t('确认密码')" required>
          <UInput v-model="auth_form.confirm" type="password" autocomplete="new-password" :maxlength="128" required class="w-full" :aria-label="t('确认密码')" />
        </UFormField>
        <UFormField :label="t('注册令牌')" required>
          <UInput v-model="auth_form.setup_key" type="password" autocomplete="off" required :disabled="register_blocked" class="w-full" :aria-label="t('注册令牌')" />
        </UFormField>
        <p v-if="register_blocked" class="account-message is-error" role="status">{{ t('尚无可用的注册令牌。请在部署网站的电脑上运行') }} <code>codiscuss token</code>{{ t('，再刷新本页；本地版也可设置环境变量 DISCUSS_ADMIN_SETUP_KEY 后重启。') }}</p>
        <p v-else class="fine-print">{{ t('首个注册者需要令牌，防止他人抢注：在部署网站的电脑上运行') }} <code>codiscuss token</code> {{ t('获取（一次性）；本地版也可用服务端启动日志里的安装令牌。密码只由你自己保管，本机不保存。忘记密码：本地版运行') }} <code>python server.py --reset-admin</code> {{ t('后重新注册；Cloudflare 版需清空管理员表（见部署文档）。') }}</p>
      </template>
      <p v-else class="fine-print">{{ t('忘记密码：本地版运行') }} <code>python server.py --reset-admin</code> {{ t('后重新注册；Cloudflare 版需清空管理员表（见部署文档）。') }}</p>
      <div class="account-actions">
        <UButton type="submit" class="channel-primary-button" :label="state_key === 'register' ? t('创建并登录') : t('登录')" :loading="busy === 'register' || busy === 'login'" :disabled="Boolean(busy) || register_blocked" />
      </div>
    </form>

    <div v-else class="account-profile">
      <!-- Avatar beside the name, its two buttons under the field: the identity takes one compact block, not three rows. -->
      <div class="account-identity">
        <UAvatar :src="bridge.identities['用户'].icon" :alt="t('{value1} 的头像', { value1: bridge.display_name('用户') })" size="lg" class="channel-avatar user account-avatar" />
        <div class="account-identity-fields">
          <form class="dialog-form account-form" :aria-label="t('显示名称')" @submit.prevent="save_name">
            <UFormField :label="t('显示名称')"><div class="account-name-row"><UInput v-model="display_name" autocomplete="username" :maxlength="30" required class="w-full" :aria-label="t('显示名称')" /><UButton type="submit" class="account-icon-action" icon="i-lucide-check" :label="t('保存名称')" :aria-label="t('保存名称')" :title="t('保存名称')" color="neutral" variant="soft" :loading="busy === 'name'" :disabled="Boolean(busy) || !name_changed || !display_name.trim()" /></div></UFormField>
          </form>
          <div class="account-avatar-actions">
            <input ref="avatar_input" type="file" accept="image/*" class="account-file" tabindex="-1" aria-hidden="true" @change="choose_avatar">
            <UButton :label="t('更换头像')" :aria-label="t('更换头像')" :title="t('更换头像')" icon="i-lucide-image-up" color="neutral" variant="outline" class="pb-action account-icon-action" size="xs" :loading="busy === 'avatar'" :disabled="Boolean(busy)" @click="avatar_input.click()" />
            <UButton :label="t('恢复默认头像')" :aria-label="t('恢复默认头像')" :title="t('恢复默认头像')" icon="i-lucide-rotate-ccw" class="account-icon-action" color="neutral" variant="ghost" size="xs" :disabled="Boolean(busy) || !profile?.avatar" @click="reset_avatar" />
          </div>
        </div>
      </div>

      <!-- A hosted account signs in at the entry, not with paired devices: it signs out there, and its password is reset by
           whoever opened the account. -->
      <section v-if="view.launch.projects_restricted && via_entry" class="account-devices" aria-labelledby="account-entry-heading">
        <h4 id="account-entry-heading">{{ t('登录') }}</h4>
        <p class="fine-print">{{ t('你用开通时拿到的账号名和密码登录。忘记密码或想换密码，请联系为你开通服务的人重设；重设后所有设备上的登录都会失效。') }}</p>
        <form method="post" action="/_entry/logout"><UButton type="submit" :label="t('退出登录')" icon="i-lucide-log-out" color="neutral" variant="outline" class="pb-action" size="sm" /></form>
      </section>
      <DeviceSettings v-else-if="!view.launch.projects_restricted" />
      <template v-if="!account.local && !account.devices">
        <section class="account-devices" aria-labelledby="account-devices-heading">
          <h4 id="account-devices-heading">{{ t('网站登录') }}</h4>
          <p class="fine-print">{{ t('登录一周不用或满一个月会自动失效。看到不认识的登录时，退出它并更改密码。没有配对的设备即使登录了网站，也操作不了电脑。') }}</p>
          <UButton v-if="!sessions" :label="t('查看网站登录')" color="neutral" variant="soft" size="sm" :loading="busy === 'sessions'" :disabled="Boolean(busy)" @click="load_sessions" />
          <template v-else>
            <ul class="account-device-list">
              <li v-for="item in sessions" :key="item.id">
                <span><strong>{{ device_label(item.label) }}</strong><small>{{ item.current ? t('当前设备') : t('最近使用 {value1}', { value1: seen(item.last_seen) }) }}</small></span>
                <UButton v-if="!item.current" :label="t('退出')" color="neutral" variant="ghost" size="xs" :disabled="Boolean(busy)" @click="end_sessions({ id: item.id }, t('该设备已退出登录。'))" />
              </li>
            </ul>
            <UButton v-if="sessions.length > 1" :label="t('退出其他所有设备')" color="neutral" variant="outline" class="pb-action" size="sm" :loading="busy === 'revoke'" :disabled="Boolean(busy)" @click="end_sessions({ others: true }, t('其他设备已全部退出登录。'))" />
          </template>
        </section>
        <form class="dialog-form account-form" :aria-label="t('更改密码')" @submit.prevent="save_password">
          <h4>{{ t('更改密码') }}</h4>
          <UFormField :label="t('当前密码')" required><UInput v-model="password_form.current_password" type="password" autocomplete="current-password" :maxlength="128" required class="w-full" :aria-label="t('当前密码')" /></UFormField>
          <UFormField :label="t('新密码')" :description="t('8–128 个字符；更改后其他设备都会退出登录')" required><UInput v-model="password_form.password" type="password" autocomplete="new-password" :maxlength="128" required class="w-full" :aria-label="t('新密码')" /></UFormField>
          <UFormField :label="t('确认新密码')" required><UInput v-model="password_form.confirm" type="password" autocomplete="new-password" :maxlength="128" required class="w-full" :aria-label="t('确认新密码')" /></UFormField>
          <div class="account-actions"><UButton type="submit" :label="t('更改密码')" color="neutral" variant="soft" :loading="busy === 'password'" :disabled="Boolean(busy) || !password_form.current_password || !password_form.password" /></div>
        </form>
        <div class="account-signout account-actions"><UButton :label="t('退出登录')" icon="i-lucide-log-out" color="neutral" variant="outline" class="pb-action" size="sm" :loading="busy === 'logout'" :disabled="Boolean(busy)" @click="sign_out" /></div>
      </template>
    </div>
    <section v-if="can_set_storage && storage" class="account-devices" aria-labelledby="account-object-storage">
      <h4 id="account-object-storage">{{ t("云空间（对象存储）") }} <small v-if="uses_admin_storage || (saved_storage_key && storage.managed)">· {{ t("管理员提供") }}</small></h4>
      <p v-if="uses_admin_storage" class="account-storage-note">{{ t("本账号使用管理员的云空间，由管理员在管理面板设置，不需要填写 Key。") }}</p>
      <template v-else>
        <UFormField :label="t('资源中心地址')" class="w-full">
          <UInput v-model="storage_url" type="url" :disabled="Boolean(storage_busy)" :aria-label="t('资源中心地址')" class="w-full" />
        </UFormField>
        <UFormField :label="t('对象存储 Key')" class="w-full">
          <SecretKeyInput :key="`${normalized_storage_url()} ${storage.api_key_ref}`" :save="save_storage_key" :saved="Boolean(saved_storage_key)" :disabled="Boolean(storage_busy) || !normalized_storage_url()" :label="t('对象存储 Key')" :placeholder="t('填写 Key，失焦或回车保存')" @error="(error) => bridge.notify('error', error.message)" />
        </UFormField>
      </template>
      <!-- The quota is the computer owner's to set (management panel), so a hosted account only sees it here. -->
      <UFormField v-for="field in storage_fields" :key="field.key" :label="field.label" :help="field.key === 'quota_mib' ? t('由管理员在管理面板设置。') : field.help" class="w-full">
        <UInput v-model.number="storage_values[field.key]" type="number" :min="field.min" :max="field.max" step="1" :disabled="Boolean(storage_busy) || field.key === 'quota_mib'" :aria-label="field.label" class="w-32" @change="save_storage_field(field)" />
      </UFormField>
      <div class="account-actions">
        <UButton v-if="!uses_admin_storage" :label="t('测试连接')" :loading="storage_busy === 'test'" :disabled="Boolean(storage_busy) || !saved_storage_key" color="neutral" variant="soft" size="sm" @click="manage_storage('test')" />
        <UButton v-if="!uses_admin_storage" :label="t('清除')" :loading="storage_busy === 'clear'" :disabled="Boolean(storage_busy) || !storage.configured" color="neutral" variant="ghost" size="sm" @click="manage_storage('clear')" />
      </div>
      <p v-if="storage.configured" class="account-storage-note">{{ t("在文件页的“云空间”里管理文件。") }}</p>
    </section>
  </section>
</template>

<style scoped>
.account-devices { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.account-storage-note { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.account-devices h4, .account-form h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.account-device-list { display: flex; flex-direction: column; gap: 4px; width: 100%; margin: 0; padding: 0; list-style: none; }
.account-device-list li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 6px 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.account-device-list span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.account-device-list strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.account-device-list small { color: var(--ui-text-muted); font-size: 11px; }
</style>

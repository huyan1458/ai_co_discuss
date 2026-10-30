<script setup>
import { computed, inject, reactive, ref, watch } from "vue";

const { view, bridge } = inject("discussion");
const account = computed(() => view.value.admin);
const profile = computed(() => account.value.profile);
const state_key = computed(() => !account.value.loaded ? "loading" : !account.value.registered ? "register" : !account.value.logged_in ? "login" : "profile");
const busy = ref("");
const auth_form = reactive({ username: "", password: "", confirm: "", setup_key: "" });
const display_name = ref("");
const avatar_input = ref(null);
const name_changed = computed(() => display_name.value.trim() !== (profile.value?.username || ""));
const register_blocked = computed(() => state_key.value === "register" && !account.value.setup_available);

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
    registering ? "管理员账号已创建，并已登录。" : "已登录。");
}

/** Save only the name when it changed. */
function save_name() {
  if (!name_changed.value) return;
  return run("name", () => bridge.admin.update_profile({ username: display_name.value }), "名称已更新。");
}

/** Upload a picked image after it is resized to a small square. */
async function choose_avatar(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await run("avatar", async () => bridge.admin.update_profile({ avatar: await bridge.admin.avatar_from_file(file) }), "头像已更新。");
}

/** Return to the default fingerprint avatar. */
function reset_avatar() {
  return run("avatar", () => bridge.admin.update_profile({ avatar: "" }), "已恢复默认头像。");
}

/** Leave this browser. */
async function sign_out() {
  await run("logout", () => bridge.admin.logout(), "已退出登录。");
}
</script>

<template>
  <section class="account-settings" aria-labelledby="account-heading">
    <h3 id="account-heading">账号</h3>
    <p v-if="state_key === 'loading'" class="fine-print" role="status">正在读取账号状态…</p>

    <form v-else-if="state_key === 'register' || state_key === 'login'" class="dialog-form account-form" :aria-label="state_key === 'register' ? '设置管理员账号' : '登录管理员账号'" @submit.prevent="submit_auth">
      <p class="fine-print account-intro">
        <template v-if="state_key === 'register'">设置站点管理员账号：名称和头像对所有访客可见，登录后可在没有房间凭据的浏览器中存档、恢复、删除房间。</template>
        <template v-else>登录后可管理房间；未登录时仍可阅读并使用本浏览器创建的房间。</template>
      </p>
      <UFormField label="用户名" :description="state_key === 'register' ? '1–30 个字符，也是公开显示的名称' : undefined" required>
        <UInput v-model="auth_form.username" autocomplete="username" :maxlength="30" required class="w-full" aria-label="用户名" />
      </UFormField>
      <UFormField label="密码" :description="state_key === 'register' ? '8–128 个字符' : undefined" required>
        <UInput v-model="auth_form.password" type="password" :autocomplete="state_key === 'register' ? 'new-password' : 'current-password'" :maxlength="128" required class="w-full" aria-label="密码" />
      </UFormField>
      <template v-if="state_key === 'register'">
        <UFormField label="确认密码" required>
          <UInput v-model="auth_form.confirm" type="password" autocomplete="new-password" :maxlength="128" required class="w-full" aria-label="确认密码" />
        </UFormField>
        <UFormField label="注册令牌" required>
          <UInput v-model="auth_form.setup_key" type="password" autocomplete="off" required :disabled="register_blocked" class="w-full" aria-label="注册令牌" />
        </UFormField>
        <p v-if="register_blocked" class="account-message is-error" role="status">尚无可用的注册令牌。请在部署网站的电脑上运行 <code>codiscuss token</code>，再刷新本页；本地版也可设置环境变量 DISCUSS_ADMIN_SETUP_KEY 后重启。</p>
        <p v-else class="fine-print">首个注册者需要令牌，防止他人抢注：在部署网站的电脑上运行 <code>codiscuss token</code> 获取（一次性）；本地版也可用服务端启动日志里的安装令牌。在已连接本机服务的电脑上注册时，账号与密码会保存到 ~/.codiscuss。忘记密码：本地版运行 <code>python server.py --reset-admin</code> 后重新注册；Cloudflare 版需清空管理员表（见部署文档）。</p>
      </template>
      <p v-else class="fine-print">忘记密码：本地版运行 <code>python server.py --reset-admin</code> 后重新注册；Cloudflare 版需清空管理员表（见部署文档）。</p>
      <div class="account-actions"><UButton type="submit" class="channel-primary-button" :label="state_key === 'register' ? '创建并登录' : '登录'" :loading="busy === 'register' || busy === 'login'" :disabled="Boolean(busy) || register_blocked" /></div>
    </form>

    <div v-else class="account-profile">
      <div class="account-identity">
        <UAvatar :src="bridge.identities['用户'].icon" :alt="`${bridge.display_name('用户')} 的头像`" size="lg" class="channel-avatar user account-avatar" />
        <div class="account-avatar-actions">
          <input ref="avatar_input" type="file" accept="image/*" class="account-file" tabindex="-1" aria-hidden="true" @change="choose_avatar">
          <UButton label="更换头像" icon="i-lucide-image-up" color="neutral" variant="outline" size="sm" :loading="busy === 'avatar'" :disabled="Boolean(busy)" @click="avatar_input.click()" />
          <UButton label="恢复默认头像" color="neutral" variant="ghost" size="sm" :disabled="Boolean(busy) || !profile?.avatar" @click="reset_avatar" />
        </div>
      </div>
      <form class="dialog-form account-form" aria-label="显示名称" @submit.prevent="save_name">
        <UFormField label="显示名称" description="即用户名，对所有访客可见"><div class="account-name-row"><UInput v-model="display_name" autocomplete="username" :maxlength="30" required class="w-full" aria-label="显示名称" /><UButton type="submit" label="保存名称" color="neutral" variant="soft" :loading="busy === 'name'" :disabled="Boolean(busy) || !name_changed || !display_name.trim()" /></div></UFormField>
      </form>

      <div v-if="!account.local" class="account-signout account-actions"><UButton label="退出登录" icon="i-lucide-log-out" color="neutral" variant="outline" size="sm" :loading="busy === 'logout'" :disabled="Boolean(busy)" @click="sign_out" /></div>
    </div>
  </section>
</template>

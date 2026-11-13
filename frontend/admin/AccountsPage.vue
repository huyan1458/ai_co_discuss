<script setup>
/** Hosted accounts: one card each, with its instance, its Windows user and the actions on them. */
import { inject, ref } from "vue";
import { call } from "./api.js";

const adding = defineModel("adding", { type: Boolean, default: false });
const { state, reload, notify } = inject("panel");
const name = ref(""), saving = ref(false), busy = ref("");
// A password is shown once, right after it is made; only its hash is kept.
const secret = ref(null);
const confirming = ref(null);

async function create() {
  saving.value = true;
  try {
    const result = await call("accounts", { name: name.value.trim() });
    secret.value = { title: `用户 ${result.name} 已创建`, password: result.password };
    name.value = ""; adding.value = false;
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { saving.value = false; }
}

/** Run one account action, marking the card busy until it ends. */
async function act(account, action, done_message) {
  busy.value = `${account.name}:${action}`;
  try {
    const result = await call(`accounts/${account.name}/${action}`, {});
    if (result.password) secret.value = { title: `${account.name} 的新密码`, password: result.password };
    else if (done_message) notify("info", done_message);
    await reload();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

const CONFIRMS = {
  remove: { title: "删除用户", text: (account) => `删除后 ${account.name} 无法再登录。它的文件夹 ${account.home} 会保留，需要时手动删除。`, label: "删除", action: "remove", message: "用户已删除" },
  "os-user": { title: "创建 Windows 用户", text: (account) => `为 ${account.name} 创建一个普通 Windows 用户，之后它的 AI 以这个用户运行，读不到你的个人文件。电脑会弹出一次管理员确认，请在这台电脑上点“是”。`, label: "创建", action: "os-user", message: "Windows 用户已创建" },
  "os-user/remove": { title: "删除 Windows 用户", text: (account) => `删除 ${account.os_user} 及其个人目录（其中的命令行登录一并删除）。电脑会弹出一次管理员确认。`, label: "删除", action: "os-user/remove", message: "Windows 用户已删除" },
};
function ask(account, key) { confirming.value = { account, ...CONFIRMS[key] }; }
async function confirm() {
  const { account, action, message } = confirming.value;
  confirming.value = null;
  await act(account, action, message);
}

function menu(account) {
  return [
    [{ label: "重设密码", icon: "i-lucide-key-round", onSelect: () => act(account, "password") }],
    [account.os_user ? { label: "删除 Windows 用户", icon: "i-lucide-user-x", onSelect: () => ask(account, "os-user/remove") }
      : { label: "创建 Windows 用户", icon: "i-lucide-user-plus", onSelect: () => ask(account, "os-user") }],
    [{ label: "删除用户", icon: "i-lucide-trash-2", color: "error", onSelect: () => ask(account, "remove") }],
  ];
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); notify("info", "已复制"); } catch { notify("error", "复制失败，请手动选中复制"); }
}
</script>

<template>
  <section v-if="adding">
    <div class="panel-form-head">
      <button type="button" class="panel-back" aria-label="返回" @click="adding = false"><UIcon name="i-lucide-arrow-left" /></button>
      <h2>新建用户</h2>
    </div>
    <form class="panel-form" @submit.prevent="create">
      <label class="panel-field">账号名
        <input v-model="name" class="panel-input" placeholder="例如 zhang" autocomplete="off" spellcheck="false" maxlength="17" autofocus />
        <small>2–17 位小写字母、数字、下划线或短横线。会建立文件夹 ~\.codiscuss-账号名，内含项目、草稿空间与实例数据。</small>
      </label>
      <p class="panel-note"><UIcon name="i-lucide-info" />创建后会显示一次登录密码。建好后可在卡片菜单里为它创建 Windows 用户，再到“命令行登录”页登录各家 AI。</p>
    </form>
    <div class="panel-form-foot">
      <button type="button" class="panel-button is-plain" @click="adding = false">取消</button>
      <button type="button" class="panel-button is-primary" :disabled="!name.trim() || saving" @click="create"><UIcon name="i-lucide-plus" />添加</button>
    </div>
  </section>

  <section v-else class="panel-list">
    <div v-if="!state.accounts.length" class="panel-empty"><UIcon name="i-lucide-users" />还没有用户。点右上角的 + 新建一个。</div>
    <article v-for="account in state.accounts" :key="account.name" class="panel-card" :class="{ 'is-current': account.running }">
      <div class="panel-tile">{{ account.name.slice(0, 1).toUpperCase() }}</div>
      <div class="panel-main">
        <div class="panel-title">{{ account.name }}
          <span v-if="account.running" class="panel-tag is-green"><UIcon name="i-lucide-circle-check" />运行中</span>
          <span v-else class="panel-tag is-gray">已停止</span>
          <span v-if="account.os_user" class="panel-tag is-blue" :title="`以 Windows 用户 ${account.os_user} 运行`"><UIcon name="i-lucide-shield" />{{ account.os_user }}</span>
          <span v-else class="panel-tag is-amber" title="还没有独立的 Windows 用户：它的 AI 以你的身份运行"><UIcon name="i-lucide-shield-alert" />未隔离</span>
        </div>
        <a class="panel-link" :href="`http://127.0.0.1:${account.port}/`" target="_blank" rel="noopener">http://127.0.0.1:{{ account.port }}</a>
        <span class="panel-sub" :title="account.home">{{ account.home }}<template v-if="account.keys"> · {{ account.keys }} 个 API 密钥</template></span>
      </div>
      <div class="panel-side">
        <button v-if="!account.running" type="button" class="panel-icon-button is-go" :class="{ 'is-spinning': busy === `${account.name}:start` }" :disabled="Boolean(busy)" title="启动实例" aria-label="启动实例" @click="act(account, 'start', '实例已启动')">
          <UIcon :name="busy === `${account.name}:start` ? 'i-lucide-loader' : 'i-lucide-play'" /></button>
        <button v-else type="button" class="panel-icon-button is-stop" :class="{ 'is-spinning': busy === `${account.name}:stop` }" :disabled="Boolean(busy)" title="停止实例" aria-label="停止实例" @click="act(account, 'stop', '实例已停止')">
          <UIcon :name="busy === `${account.name}:stop` ? 'i-lucide-loader' : 'i-lucide-square'" /></button>
        <UDropdownMenu :items="menu(account)" :content="{ align: 'end' }">
          <button type="button" class="panel-icon-button" :disabled="Boolean(busy)" aria-label="更多操作"><UIcon name="i-lucide-ellipsis" /></button>
        </UDropdownMenu>
      </div>
    </article>
  </section>

  <UModal :open="Boolean(secret)" :title="secret?.title" description="密码只显示这一次，请现在交给对方。" @update:open="(open) => !open && (secret = null)">
    <template #body>
      <div class="panel-secret"><span>{{ secret?.password }}</span>
        <button type="button" class="panel-icon-button" aria-label="复制密码" @click="copy(secret.password)"><UIcon name="i-lucide-copy" /></button></div>
    </template>
  </UModal>
  <UModal :open="Boolean(confirming)" :title="confirming?.title" @update:open="(open) => !open && (confirming = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">{{ confirming?.text(confirming.account) }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = null">取消</button>
        <button type="button" class="panel-button is-primary" @click="confirm">{{ confirming?.label }}</button>
      </div>
    </template>
  </UModal>
</template>

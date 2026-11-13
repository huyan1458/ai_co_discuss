<script setup>
/** The management panel: one header with the page switch, and the page below. Pages share the loaded state.
 * Every owner has the overview (this computer's service, updates, startup) and command-line sign-in; the hosting pages
 * (accounts, their API keys) appear once hosting is on. */
import { computed, onMounted, provide, ref } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { call } from "./api.js";
import OverviewPage from "./OverviewPage.vue";
import AccountsPage from "./AccountsPage.vue";
import LoginsPage from "./LoginsPage.vue";
import KeysPage from "./KeysPage.vue";

// Served beside the page by the panel server, not bundled.
const MARK = "/mark.svg";
// Every owner: this computer and its own command-line sign-ins. Hosting adds the accounts and their API keys.
const OWNER_PAGES = [
  { key: "overview", label: "概览", icon: "i-lucide-layout-dashboard" },
  { key: "logins", label: "命令行登录", icon: "i-lucide-terminal" },
];
const HOSTING_PAGES = [
  { key: "accounts", label: "用户", icon: "i-lucide-users" },
  { key: "keys", label: "API 密钥", icon: "i-lucide-key-round" },
];
const state = ref({ hosting: false, service: {}, accounts: [], clis: {}, providers: {}, platform: "" });
const pages = computed(() => (state.value.hosting ? [...OWNER_PAGES, ...HOSTING_PAGES] : OWNER_PAGES));
// The address keeps the page, so a reload or a link from the taskbar lands on the same one; a hosting page while hosting
// is off falls back to the overview.
const chosen = ref(location.hash.slice(1) || "overview");
const page = computed(() => (pages.value.some((item) => item.key === chosen.value) ? chosen.value : "overview"));
const loading = ref(false);
// Each page opens its own "add" form; the header's orange button asks the current page for it.
const adding = ref(false);
const toast = useToast();

/** Show an operation's result in the corner. */
function notify(level, message) {
  toast.add({ title: message, color: level === "error" ? "error" : level === "warning" ? "warning" : "success", duration: level === "error" ? 6000 : 3000 });
}

async function reload() {
  loading.value = true;
  try { state.value = await call("state"); }
  catch (failure) { notify("error", failure.message); }
  finally { loading.value = false; }
}

const can_add = computed(() => ["accounts", "keys"].includes(page.value) && !(page.value === "keys" && !state.value.accounts.length));
function choose(key) { chosen.value = key; adding.value = false; history.replaceState(null, "", `#${key}`); }

provide("panel", { state, reload, notify });
onMounted(reload);
</script>

<template>
  <UApp :locale="zh_cn" :toaster="{ position: 'bottom-right', max: 4 }">
    <div class="panel">
      <header class="panel-head">
        <div class="panel-brand"><img class="panel-mark" :src="MARK" alt="" /><h1>共议</h1><small>管理面板</small></div>
        <nav v-if="pages.length > 1" class="panel-tabs" aria-label="管理页面">
          <button v-for="item in pages" :key="item.key" type="button" class="panel-tab" :class="{ 'is-active': page === item.key }" :aria-current="page === item.key ? 'page' : undefined" @click="choose(item.key)">
            <UIcon :name="item.icon" />{{ item.label }}
          </button>
        </nav>
        <div class="panel-tools">
          <button type="button" class="panel-tool" :class="{ 'is-spinning': loading }" title="刷新" aria-label="刷新" @click="reload"><UIcon name="i-lucide-refresh-cw" /></button>
        </div>
        <button v-if="page !== 'overview'" type="button" class="panel-add" :disabled="!can_add" :title="page === 'keys' ? '添加 API 密钥' : '新建用户'" :aria-label="page === 'keys' ? '添加 API 密钥' : '新建用户'" @click="adding = true">
          <UIcon name="i-lucide-plus" />
        </button>
      </header>
      <p v-if="state.hosting && state.platform && state.platform !== 'win32'" class="panel-note is-amber" style="margin-bottom: 18px"><UIcon name="i-lucide-triangle-alert" />Windows 用户与命令行登录只在 Windows 上可用。</p>
      <OverviewPage v-if="page === 'overview'" />
      <AccountsPage v-else-if="page === 'accounts'" v-model:adding="adding" />
      <LoginsPage v-else-if="page === 'logins'" />
      <KeysPage v-else-if="page === 'keys'" v-model:adding="adding" />
    </div>
  </UApp>
</template>

<script setup>
/** The management panel: one header with the page switch, and the page below. Pages share the loaded state. */
import { computed, onMounted, provide, ref } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { call } from "./api.js";
import AccountsPage from "./AccountsPage.vue";
import LoginsPage from "./LoginsPage.vue";
import KeysPage from "./KeysPage.vue";

// Served beside the page by the panel server, not bundled.
const MARK = "/mark.svg";
const PAGES = [
  { key: "accounts", label: "用户", icon: "i-lucide-users" },
  { key: "logins", label: "命令行登录", icon: "i-lucide-terminal" },
  { key: "keys", label: "API 密钥", icon: "i-lucide-key-round" },
];
// The address keeps the page, so a reload or a link from the taskbar lands on the same one.
const page = ref(PAGES.some((item) => `#${item.key}` === location.hash) ? location.hash.slice(1) : "accounts");
const state = ref({ accounts: [], clis: {}, providers: {}, platform: "" });
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

const can_add = computed(() => page.value !== "logins" && !(page.value === "keys" && !state.value.accounts.length));
function choose(key) { page.value = key; adding.value = false; history.replaceState(null, "", `#${key}`); }

provide("panel", { state, reload, notify });
onMounted(reload);
</script>

<template>
  <UApp :locale="zh_cn" :toaster="{ position: 'bottom-right', max: 4 }">
    <div class="panel">
      <header class="panel-head">
        <div class="panel-brand"><img class="panel-mark" :src="MARK" alt="" /><h1>共议</h1><small>管理面板</small></div>
        <nav class="panel-tabs" aria-label="管理页面">
          <button v-for="item in PAGES" :key="item.key" type="button" class="panel-tab" :class="{ 'is-active': page === item.key }" :aria-current="page === item.key ? 'page' : undefined" @click="choose(item.key)">
            <UIcon :name="item.icon" />{{ item.label }}
          </button>
        </nav>
        <div class="panel-tools">
          <button type="button" class="panel-tool" :class="{ 'is-spinning': loading }" title="刷新" aria-label="刷新" @click="reload"><UIcon name="i-lucide-refresh-cw" /></button>
        </div>
        <button type="button" class="panel-add" :disabled="!can_add" :title="page === 'keys' ? '添加 API 密钥' : '新建用户'" :aria-label="page === 'keys' ? '添加 API 密钥' : '新建用户'" @click="adding = true">
          <UIcon name="i-lucide-plus" />
        </button>
      </header>
      <p v-if="state.platform && state.platform !== 'win32'" class="panel-note is-amber" style="margin-bottom: 18px"><UIcon name="i-lucide-triangle-alert" />Windows 用户与命令行登录只在 Windows 上可用。</p>
      <AccountsPage v-if="page === 'accounts'" v-model:adding="adding" />
      <LoginsPage v-else-if="page === 'logins'" />
      <KeysPage v-else v-model:adding="adding" />
    </div>
  </UApp>
</template>

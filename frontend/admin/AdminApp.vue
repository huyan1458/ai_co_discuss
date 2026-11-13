<script setup>
/**
 * The management panel: one header with the page switch, and the page below. Pages share the loaded state.
 * Every owner has the overview: this computer's service, the owner's own command-line sign-ins, updates and startup.
 * With hosting on, "托管账号" holds everything about the accounts, each on its own page.
 */
import { computed, onMounted, provide, ref } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { call } from "./api.js";
import OverviewPage from "./OverviewPage.vue";
import AccountsPage from "./AccountsPage.vue";

// Served beside the page by the panel server, not bundled.
const MARK = "/mark.svg";
const OVERVIEW = { key: "overview", label: "概览", icon: "i-lucide-layout-dashboard" };
const ACCOUNTS = { key: "accounts", label: "托管账号", icon: "i-lucide-users" };
const state = ref({ hosting: false, service: {}, accounts: [], clis: {}, providers: {}, platform: "" });
const pages = computed(() => (state.value.hosting ? [OVERVIEW, ACCOUNTS] : [OVERVIEW]));
// The address keeps the page, so a reload or a link from the taskbar lands on the same one; the accounts page while
// hosting is off falls back to the overview.
const chosen = ref(location.hash.slice(1) || "overview");
const page = computed(() => (pages.value.some((item) => item.key === chosen.value) ? chosen.value : "overview"));
const loading = ref(false);
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

function choose(key) { chosen.value = key; history.replaceState(null, "", `#${key}`); }

// The header's refresh reloads everything shown: the panel state here, and each card that reads its own (sign-ins, an
// account's AI environment, the version check) re-reads when this number changes. It spins for at least half a second
// and says when it is done, so a quick refresh is still visibly a refresh.
const refreshed = ref(0), refreshing = ref(false);
async function refresh_all() {
  refreshing.value = true;
  refreshed.value += 1;
  await Promise.all([reload(), new Promise((done) => setTimeout(done, 500))]);
  refreshing.value = false;
  notify("info", "已刷新");
}

provide("panel", { state, reload, notify, refreshed });
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
          <button type="button" class="panel-tool" :class="{ 'is-spinning': refreshing }" :disabled="refreshing" title="刷新全部：服务、登录状态、账号与版本" aria-label="刷新全部" @click="refresh_all"><UIcon name="i-lucide-refresh-cw" /></button>
        </div>
      </header>
      <OverviewPage v-if="page === 'overview'" />
      <AccountsPage v-else @local="choose('overview')" />
    </div>
  </UApp>
</template>

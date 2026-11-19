<script setup>
/**
 * The management panel: one header with the page switch, and the page below. Pages share the loaded state.
 * "概览" is this computer: its service, updates, startup, and with hosting on the accounts' entry and program copy.
 * "账号" is one account at a time: the owner ("我"), and with hosting on every hosted account, each with its sign-ins,
 * API keys and skills.
 */
import { computed, onMounted, provide, ref } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { en, zh_cn } from "@nuxt/ui/locale";
import { locale, t } from "../i18n.js";
import { call } from "./api.js";
import OverviewPage from "./OverviewPage.vue";
import AccountsPage from "./AccountsPage.vue";

// Served beside the page by the panel server, not bundled.
const MARK = "/mark.svg";
const OVERVIEW = { key: "overview", label: t('概览'), icon: "i-lucide-layout-dashboard" };
const ACCOUNTS = { key: "accounts", label: t('账号'), icon: "i-lucide-users" };
const state = ref({ hosting: false, service: {}, accounts: [], clis: {}, providers: {}, platform: "" });
const pages = [OVERVIEW, ACCOUNTS];
// The address keeps the page, so a reload or a link from the taskbar lands on the same one.
const chosen = ref(location.hash.slice(1) || "overview");
const page = computed(() => (pages.some((item) => item.key === chosen.value) ? chosen.value : "overview"));
const loading = ref(false);
// The pages wait for the first answer: drawn from the empty state they showed the service as stopped and left out the
// rows that depend on this computer, which then appeared one after another (user 2026-11-18, #4469).
const ready = ref(false);
// Shown beside the name as the website shows it, so the owner sees at a glance which version this computer runs.
const version = computed(() => state.value.service?.version || state.value.version || "");
const toast = useToast();

/** Show an operation's result in the corner. */
function notify(level, message) {
  toast.add({ title: message, color: level === "error" ? "error" : level === "warning" ? "warning" : "success", duration: level === "error" ? 6000 : 3000 });
}

// The state leaves out the entry's checks over the network (the relay can take seconds), so the page shows at once and
// the entry's ways are filled in when their check answers; only the latest check is kept.
let entry_check = 0;
async function check_entry() {
  const check = ++entry_check;
  try { const entry = await call("entry"); if (check === entry_check && entry) state.value = { ...state.value, entry }; }
  catch (failure) { if (check === entry_check) notify("error", failure.message); }
}

async function reload() {
  loading.value = true;
  try {
    state.value = await call("state");
    if (state.value.hosting) check_entry(); else entry_check += 1;
    return true;
  }
  catch (failure) { notify("error", failure.message); return false; }
  finally { loading.value = false; ready.value = true; }
}

function choose(key) { chosen.value = key; history.replaceState(null, "", `#${key}`); }

// The header's refresh reloads everything shown: the panel state here, and each card that reads its own (sign-ins, an
// account's AI environment, the version check) re-reads when this number changes. It spins for at least half a second
// and says when it is done, so a quick refresh is still visibly a refresh.
const refreshed = ref(0), refreshing = ref(false);
async function refresh_all() {
  refreshing.value = true;
  refreshed.value += 1;
  const [ok] = await Promise.all([reload(), new Promise((done) => setTimeout(done, 500))]);
  refreshing.value = false;
  if (ok) notify("info", t('已刷新'));
}

provide("panel", { state, reload, notify, refreshed });
onMounted(reload);
// Notices close on their countdown whatever the pointer or the window does: the toast library pauses every countdown
// while the window is in the background or the pointer is over a notice, which left them stuck on screen. Its pause is an
// event sent to the notice area, stopped here on its way down.
onMounted(() => document.addEventListener("toast.viewportPause", (event) => event.stopPropagation(), true));
</script>

<template>
  <UApp :locale="locale === 'en' ? en : zh_cn" :scroll-body="false" :toaster="{ position: 'bottom-right', max: 4 }">
    <div class="panel">
      <header class="panel-head">
        <div class="panel-brand"><img class="panel-mark" :src="MARK" alt="" /><h1>{{ t('共议') }}</h1><small>{{ t('管理面板') }}<template v-if="version"> · v{{ version }}</template></small></div>
        <nav class="panel-tabs" :aria-label="t('管理页面')">
          <button v-for="item in pages" :key="item.key" type="button" class="panel-tab" :class="{ 'is-active': page === item.key }" :aria-current="page === item.key ? 'page' : undefined" @click="choose(item.key)">
            <UIcon :name="item.icon" />{{ item.label }}
          </button>
        </nav>
        <div class="panel-tools">
          <button type="button" class="panel-tool" :class="{ 'is-spinning': refreshing }" :disabled="refreshing" :title="t('刷新全部：服务、登录状态、账号与版本')" :aria-label="t('刷新全部')" @click="refresh_all"><UIcon name="i-lucide-refresh-cw" /></button>
        </div>
      </header>
      <section v-if="!ready" class="panel-skeleton" role="status" :aria-label="t('正在读取…')">
        <template v-for="rows in [1, 3]" :key="rows">
          <USkeleton class="panel-skeleton-heading" />
          <div class="panel-rows">
            <div v-for="row in rows" :key="row" class="panel-row">
              <USkeleton class="panel-tile" />
              <div class="panel-main"><USkeleton class="panel-skeleton-title" /><USkeleton class="panel-skeleton-sub" /></div>
            </div>
          </div>
        </template>
      </section>
      <OverviewPage v-else-if="page === 'overview'" />
      <AccountsPage v-else />
    </div>
  </UApp>
</template>

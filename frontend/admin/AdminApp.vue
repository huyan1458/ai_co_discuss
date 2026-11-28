<script setup>
/**
 * The management panel: one header with the page switch, and the page below. Pages share the loaded state.
 * "概览" is this computer: its service, updates, startup, and with hosting on the accounts' entry and program copy.
 * "账号" is one account at a time: the owner ("我"), and with hosting on every hosted account, each with its sign-ins,
 * API keys and skills.
 */
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useToast } from "@nuxt/ui/composables";
import { en, zh_cn } from "@nuxt/ui/locale";
import { locale, t } from "../i18n.js";
import { call } from "./api.js";
import OverviewPage from "./OverviewPage.vue";
import AccountsPage from "./AccountsPage.vue";
import StoragePage from "./StoragePage.vue";
import { format_storage_bytes, normalize_storage_snapshot } from "../storage-format.js";

// Served beside the page by the panel server, not bundled.
const MARK = "/mark.svg";
const OVERVIEW = { key: "overview", label: t('概览'), icon: "i-lucide-layout-dashboard" };
const ACCOUNTS = { key: "accounts", label: t('账号'), icon: "i-lucide-users" };
const STORAGE = { key: "storage", label: t('存储'), icon: "i-lucide-hard-drive" };
const state = ref({ hosting: false, service: {}, accounts: [], clis: {}, providers: {}, platform: "", storage: null });
const pages = [OVERVIEW, ACCOUNTS, STORAGE];
// The address keeps the page, so a reload or a link from the taskbar lands on the same one.
const chosen = ref(location.hash.slice(1) || "overview");
const page = computed(() => (pages.some((item) => item.key === chosen.value) ? chosen.value : "overview"));
const loading = ref(false);
// The pages wait for the first answer: drawn from the empty state they showed the service as stopped and left out the
// rows that depend on this computer, which then appeared one after another (user 2026-11-18, #4469).
const ready = ref(false);
// Shown beside the name as the website shows it, so the owner sees at a glance which version this computer runs.
const version = computed(() => state.value.service?.version || state.value.version || "");
const storage_raw = ref(null);
const storage_loading = ref(false);
const storage_error = ref("");
let storage_seq = 0;
const storage_snapshot = computed(() => normalize_storage_snapshot(storage_raw.value));
const storage_warning = computed(() => Boolean(storage_snapshot.value?.warning || storage_snapshot.value?.over_limit || state.value.storage?.warning || state.value.service?.storage?.warning));
const storage_warning_reason = computed(() => {
  const snap = storage_snapshot.value;
  if (snap?.warning_reason) return snap.warning_reason;
  if (snap && (snap.warning || snap.over_limit)) {
    return t("本机 .codiscuss 数据已占 {used}，接近 {limit} 上限（预警线 {warn}）。请及时清理临时文件或旧草稿。",
      { used: format_storage_bytes(snap.total_bytes), limit: format_storage_bytes(snap.limits.home_limit_bytes), warn: format_storage_bytes(snap.limits.home_warn_bytes) });
  }
  return state.value.storage?.warning_reason || state.value.service?.storage?.warning_reason || "";
});
const toast = useToast();

/** Show an operation's result in the corner. */
function notify(level, message) {
  toast.add({ title: message, color: level === "error" ? "error" : level === "warning" ? "warning" : "success", duration: level === "error" ? 6000 : 3000 });
}

let storage_warn_announced = false;
watch(storage_warning, (warn) => {
  if (!warn) { storage_warn_announced = false; return; }
  if (storage_warn_announced) return;
  storage_warn_announced = true;
  notify("warning", storage_warning_reason.value || t("本机 .codiscuss 数据占用接近 10 GiB 上限，请到“存储”页清理临时文件或旧草稿。"));
}, { immediate: true });

/** Read the computer's storage snapshot without blocking panel navigation; stale responses are discarded. */
async function load_storage({ quiet = false } = {}) {
  const seq = ++storage_seq;
  storage_loading.value = true;
  storage_error.value = "";
  try {
    const result = await call("storage");
    if (seq !== storage_seq) return null;
    storage_raw.value = result;
    return result;
  } catch (failure) {
    if (seq !== storage_seq) return null;
    storage_error.value = failure.message;
    if (!quiet) notify("error", failure.message);
    return null;
  } finally {
    if (seq === storage_seq) storage_loading.value = false;
  }
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
    if (outdated(state.value.version)) { window.location.reload(); return true; }
    if (state.value.hosting) check_entry(); else entry_check += 1;
    load_storage({ quiet: true });
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
  // A full reload: the page and its scripts come again from the panel, so what an update changed shows at once (#5679).
  refreshing.value = true;
  window.location.reload();
}
// The version this page was served as; a panel of another version means this page is old and loads the new one.
const PAGE_VERSION = document.querySelector('meta[name="codiscuss-version"]')?.content || "";
const outdated = (version) => Boolean(PAGE_VERSION && version && version !== PAGE_VERSION);

// The panel is also changed from outside this page (codiscuss admin, another window, an update that restarts it), so
// the state is read again when the window comes back to the front and every few seconds while it shows. A panel of
// another version serves another page: this one reloads onto it. A page running the update itself waits for its
// report instead (`updating`).
const SYNC_MS = 15000;
const updating = ref(false);
let syncing = false;
async function sync() {
  if (syncing || loading.value || refreshing.value || updating.value || !ready.value || document.hidden) return;
  syncing = true;
  try {
    const fresh = await call("state");
    if (updating.value || loading.value) return;
    if ((state.value.version && fresh.version && fresh.version !== state.value.version) || outdated(fresh.version)) { window.location.reload(); return; }
    // The entry's network checks are not part of the state; the last answer stays until the next full reload.
    if (JSON.stringify({ ...fresh, entry: undefined }) !== JSON.stringify({ ...state.value, entry: undefined })) state.value = { ...fresh, entry: fresh.entry ?? state.value.entry };
    if (!storage_loading.value) load_storage({ quiet: true });
  } catch {
    // A previously healthy response cannot establish relay health while the panel is unreachable.
    if (state.value.online_site) state.value = { ...state.value, relay_health: { state: 'unknown', reason: 'unavailable' } };
  }
  finally { syncing = false; }
}

// Counts asks to bind the online site from elsewhere (the hosted relay card); "本机 → 自建中转" opens its dialog on each.
const binding = ref(0);
provide("panel", { state, reload, notify, refreshed, updating, binding, storage_raw, storage_loading, storage_error, load_storage });
onMounted(reload);
let sync_timer = 0;
onMounted(() => {
  sync_timer = window.setInterval(sync, SYNC_MS);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync);
});
onBeforeUnmount(() => { window.clearInterval(sync_timer); document.removeEventListener("visibilitychange", sync); window.removeEventListener("focus", sync); });
// Notices close on their countdown whatever the pointer or the window does: the toast library pauses every countdown
// while the window is in the background or the pointer is over a notice, which left them stuck on screen. Its pause is an
// event sent to the notice area, stopped here on its way down. Its resume restarts the countdown from the time left at the
// pause, which without a pause is the whole duration, so moving the pointer off a notice started it over: stopped too.
const stop_toast_event = (event) => event.stopPropagation();
onMounted(() => {
  document.addEventListener("toast.viewportPause", stop_toast_event, true);
  document.addEventListener("toast.viewportResume", stop_toast_event, true);
});
</script>

<template>
  <UApp :locale="locale === 'en' ? en : zh_cn" :scroll-body="false" :toaster="{ position: 'bottom-right', max: 4 }">
    <div class="panel">
      <header class="panel-head">
        <div class="panel-brand"><img class="panel-mark" :src="MARK" alt="" /><h1>{{ t('共议') }}</h1><small>{{ t('管理面板') }}<template v-if="version"> · v{{ version }}</template></small></div>
        <nav class="panel-tabs" :aria-label="t('管理页面')">
          <button v-for="item in pages" :key="item.key" type="button" class="panel-tab" :class="{ 'is-active': page === item.key }" :aria-current="page === item.key ? 'page' : undefined" @click="choose(item.key)">
            <UIcon :name="item.icon" />{{ item.label }}<span v-if="item.key === 'storage'" class="panel-tab-dot" :class="{ invisible: !storage_warning }" :title="storage_warning_reason || t('存储占用接近上限')" aria-hidden="true"></span>
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
      <StoragePage v-else-if="page === 'storage'" />
      <AccountsPage v-else />
    </div>
  </UApp>
</template>

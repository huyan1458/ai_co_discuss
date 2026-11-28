<script setup>
import { computed, inject, ref } from "vue";
import ChangelogDialog from "./ChangelogDialog.vue";
import ChannelDirectory from "./ChannelDirectory.vue";
import InvitedRooms from "./InvitedRooms.vue";
import { use_workflow_library, workflow_problem } from "./workflow-library.js";
import { use_analytics_page } from "./analytics-state.js";
import { moss_avatar as moss_picture, moss_running } from "./moss.js";
import { t } from "./i18n.js";

/** The room sidebar, shared by the docked desktop column and the tablet and phone drawer. */
const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives", "destructions", "workflows", "invited", "analytics", "settings"]);
const { view, bridge, field } = inject("discussion");
const author = field("author-select");
const { page_open: analytics_open } = use_analytics_page();
const can_view_analytics = computed(() => !view.value.share && Boolean(view.value.admin?.local || view.value.admin?.logged_in));
const unavailable_tools = computed(() => view.value.admin?.loaded ? t("登录后可用") : t("正在确认访问权限…"));
const props = defineProps({ stewardSetup: Boolean });
const moss_room = computed(() => view.value.rooms.find(room => room.system_kind === "steward" && !room.archived));
const moss_avatar = computed(() => moss_picture(moss_room.value, moss_room.value?.id === view.value.room?.id && moss_running(view.value.room)));
const moss_current = computed(() => props.stewardSetup || Boolean(moss_room.value && !analytics_open.value && !page_open.value && view.value.room?.id === moss_room.value.id));
/** An existing MOSS room opens at once like any room; only a first visit waits for this computer to set one up. */
function open_moss() {
  if (moss_room.value) emit("select", moss_room.value.id);
  else bridge.open_steward();
}
// 工作流 opens its own page like MOSS and 统计 (#15672); the list, new, import and each workflow's menu live there.
const library = use_workflow_library();
const { workflows, page_open } = library;
// A dot on the row when a workflow needs looking at: it cannot be read, is stopped, waits for trust or misses software.
const workflows_need_care = computed(() => workflows.value.some((item) => item.disabled || item.needs_trust || workflow_problem(item)));
function open_workflows() {
  library.open_overview();
  emit("workflows");
}
const app_version = __APP_VERSION__;
const changelog_open = ref(false);
// The version whose changelog the user last opened on this browser; until it is the running one, a dot marks the link.
const CHANGELOG_SEEN_KEY = "ai-codiscuss-changelog-seen";
const changelog_seen = ref((() => { try { return localStorage.getItem(CHANGELOG_SEEN_KEY) || ""; } catch { return ""; } })());
const changelog_unread = computed(() => changelog_seen.value !== app_version);
function open_changelog() {
  changelog_open.value = true;
  changelog_seen.value = app_version;
  try { localStorage.setItem(CHANGELOG_SEEN_KEY, app_version); } catch { /* Private mode: the dot simply returns next time. */ }
}
/** The footer's second line: the account call to action until signed in, then the site connection. */
const account_status = computed(() => {
  const admin = view.value.admin;
  if (!admin?.loaded) return "";
  if (admin.devices) return admin.logged_in ? "" : t("未配对 · 点击配对");
  if (!admin.registered) return t("设置管理员账号");
  return admin.logged_in ? "" : t("未登录 · 点击登录");
});

</script>

<template>
  <aside id="channel-sidebar" class="channel-sidebar" :aria-label="t('房间导航')">
    <header class="channel-workspace-heading">
      <span class="channel-brand-icon" aria-hidden="true">
        <svg class="channel-brand-dark" viewBox="0 0 100 100"><defs><linearGradient id="brand-d0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#e9ebed"/><stop offset="6.3%" stop-color="#e2e5e7"/><stop offset="12.5%" stop-color="#dcdee1"/><stop offset="18.8%" stop-color="#d5d8db"/><stop offset="25.0%" stop-color="#ced2d5"/><stop offset="31.3%" stop-color="#c8cbcf"/><stop offset="37.5%" stop-color="#c1c5ca"/><stop offset="43.8%" stop-color="#babfc4"/><stop offset="50.0%" stop-color="#b4b9be"/><stop offset="56.3%" stop-color="#a9aeb3"/><stop offset="62.5%" stop-color="#9ea3a9"/><stop offset="68.8%" stop-color="#93999f"/><stop offset="75.0%" stop-color="#888e95"/><stop offset="81.3%" stop-color="#7e848a"/><stop offset="87.5%" stop-color="#737a80"/><stop offset="93.8%" stop-color="#697077"/><stop offset="100.0%" stop-color="#5f666d"/></linearGradient><linearGradient id="brand-d1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#3f86ff"/><stop offset="6.3%" stop-color="#5588ff"/><stop offset="12.5%" stop-color="#6889ff"/><stop offset="18.8%" stop-color="#788aff"/><stop offset="25.0%" stop-color="#878bff"/><stop offset="31.3%" stop-color="#958cff"/><stop offset="37.5%" stop-color="#a78aef"/><stop offset="43.8%" stop-color="#b986d7"/><stop offset="50.0%" stop-color="#ca80bf"/><stop offset="56.3%" stop-color="#da78a6"/><stop offset="62.5%" stop-color="#ea6e8c"/><stop offset="68.8%" stop-color="#f56d78"/><stop offset="75.0%" stop-color="#f77f72"/><stop offset="81.3%" stop-color="#f8906b"/><stop offset="87.5%" stop-color="#f9a163"/><stop offset="93.8%" stop-color="#fab058"/><stop offset="100.0%" stop-color="#fac04a"/></linearGradient><linearGradient id="brand-d2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#d06a49"/><stop offset="6.3%" stop-color="#d36f4f"/><stop offset="12.5%" stop-color="#d67456"/><stop offset="18.8%" stop-color="#d97a5c"/><stop offset="25.0%" stop-color="#dc7f62"/><stop offset="31.3%" stop-color="#df8468"/><stop offset="37.5%" stop-color="#e2896e"/><stop offset="43.8%" stop-color="#e58e74"/><stop offset="50.0%" stop-color="#e8937a"/><stop offset="56.3%" stop-color="#eb9d85"/><stop offset="62.5%" stop-color="#eea68f"/><stop offset="68.8%" stop-color="#f1b09a"/><stop offset="75.0%" stop-color="#f4baa4"/><stop offset="81.3%" stop-color="#f6c3af"/><stop offset="87.5%" stop-color="#f9cdb9"/><stop offset="93.8%" stop-color="#fbd6c4"/><stop offset="100.0%" stop-color="#fde0cf"/></linearGradient><linearGradient id="brand-d3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#4a5cff"/><stop offset="6.3%" stop-color="#5062ff"/><stop offset="12.5%" stop-color="#5768ff"/><stop offset="18.8%" stop-color="#5d6dff"/><stop offset="25.0%" stop-color="#6472ff"/><stop offset="31.3%" stop-color="#6b77ff"/><stop offset="37.5%" stop-color="#717cff"/><stop offset="43.8%" stop-color="#7881ff"/><stop offset="50.0%" stop-color="#7f86ff"/><stop offset="56.3%" stop-color="#8990ff"/><stop offset="62.5%" stop-color="#9399ff"/><stop offset="68.8%" stop-color="#9da2ff"/><stop offset="75.0%" stop-color="#a8abff"/><stop offset="81.3%" stop-color="#b3b4ff"/><stop offset="87.5%" stop-color="#bebdff"/><stop offset="93.8%" stop-color="#c9c5ff"/><stop offset="100.0%" stop-color="#d4ceff"/></linearGradient><clipPath id="brand-d4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-d5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-d6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-d7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-d8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-d9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-d10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-d11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-d4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/></g></svg>
        <svg class="channel-brand-light" viewBox="0 0 100 100"><defs><linearGradient id="brand-l0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#0b0d0f"/><stop offset="6.3%" stop-color="#101315"/><stop offset="12.5%" stop-color="#16191b"/><stop offset="18.8%" stop-color="#1c1f22"/><stop offset="25.0%" stop-color="#222529"/><stop offset="31.3%" stop-color="#282c2f"/><stop offset="37.5%" stop-color="#2e3237"/><stop offset="43.8%" stop-color="#34393e"/><stop offset="50.0%" stop-color="#3b4045"/><stop offset="56.3%" stop-color="#484d52"/><stop offset="62.5%" stop-color="#555a5f"/><stop offset="68.8%" stop-color="#62676d"/><stop offset="75.0%" stop-color="#70757b"/><stop offset="81.3%" stop-color="#7e8389"/><stop offset="87.5%" stop-color="#8c9297"/><stop offset="93.8%" stop-color="#9aa0a6"/><stop offset="100.0%" stop-color="#a9afb5"/></linearGradient><linearGradient id="brand-l1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#2f7bff"/><stop offset="6.3%" stop-color="#487cff"/><stop offset="12.5%" stop-color="#5a7cff"/><stop offset="18.8%" stop-color="#6a7dff"/><stop offset="25.0%" stop-color="#797dff"/><stop offset="31.3%" stop-color="#877dff"/><stop offset="37.5%" stop-color="#997cee"/><stop offset="43.8%" stop-color="#ae79d3"/><stop offset="50.0%" stop-color="#c174b8"/><stop offset="56.3%" stop-color="#d36b9d"/><stop offset="62.5%" stop-color="#e56080"/><stop offset="68.8%" stop-color="#f15d69"/><stop offset="75.0%" stop-color="#f37162"/><stop offset="81.3%" stop-color="#f5835a"/><stop offset="87.5%" stop-color="#f79550"/><stop offset="93.8%" stop-color="#f8a542"/><stop offset="100.0%" stop-color="#f8b52c"/></linearGradient><linearGradient id="brand-l2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#b9502f"/><stop offset="6.3%" stop-color="#bd5534"/><stop offset="12.5%" stop-color="#c15a39"/><stop offset="18.8%" stop-color="#c55f3e"/><stop offset="25.0%" stop-color="#c96443"/><stop offset="31.3%" stop-color="#cd6848"/><stop offset="37.5%" stop-color="#d16d4d"/><stop offset="43.8%" stop-color="#d57252"/><stop offset="50.0%" stop-color="#d97757"/><stop offset="56.3%" stop-color="#dd8060"/><stop offset="62.5%" stop-color="#e08a69"/><stop offset="68.8%" stop-color="#e49372"/><stop offset="75.0%" stop-color="#e79c7b"/><stop offset="81.3%" stop-color="#eaa584"/><stop offset="87.5%" stop-color="#edae8d"/><stop offset="93.8%" stop-color="#f0b796"/><stop offset="100.0%" stop-color="#f3c09f"/></linearGradient><linearGradient id="brand-l3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#2b33e6"/><stop offset="6.3%" stop-color="#3139e9"/><stop offset="12.5%" stop-color="#363fec"/><stop offset="18.8%" stop-color="#3c44ef"/><stop offset="25.0%" stop-color="#4249f3"/><stop offset="31.3%" stop-color="#484ef6"/><stop offset="37.5%" stop-color="#4e53f9"/><stop offset="43.8%" stop-color="#5457fc"/><stop offset="50.0%" stop-color="#5a5cff"/><stop offset="56.3%" stop-color="#6569ff"/><stop offset="62.5%" stop-color="#7075ff"/><stop offset="68.8%" stop-color="#7c80ff"/><stop offset="75.0%" stop-color="#888bff"/><stop offset="81.3%" stop-color="#9595ff"/><stop offset="87.5%" stop-color="#a29fff"/><stop offset="93.8%" stop-color="#afa9ff"/><stop offset="100.0%" stop-color="#bdb3ff"/></linearGradient><clipPath id="brand-l4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-l5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-l6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-l7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-l8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-l9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-l10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-l11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-l4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/></g></svg>
      </span>
      <span class="channel-brand-text"><strong>{{ t("共议") }}</strong><span class="channel-brand-meta">CoDiscuss <button type="button" class="channel-version" :title="t('查看更新日志')" :aria-label="t('查看更新日志')" @click="open_changelog">v{{ app_version }}<i v-if="changelog_unread" class="channel-version-unread" :title="t('有未读的更新日志')" /><UIcon name="i-lucide-chevron-right" aria-hidden="true" /></button></span></span>
      <ChangelogDialog v-model:open="changelog_open" :version="app_version" />
    </header>
    <!-- One column of equal rows, icon then label, as Claude's sidebar (user #15318): no row is a button-shaped block. -->
    <nav class="channel-fixed-tools" :aria-label="t('常用入口')">
      <button type="button" class="channel-nav-item" :disabled="view.directory_pending.includes('create-room')" @click="emit('create', null)"><UIcon name="i-lucide-plus" /><span>{{ t("新建房间") }}</span></button>
      <button type="button" class="channel-nav-item" :class="{ active: moss_current }" :disabled="!can_view_analytics" :title="can_view_analytics ? moss_avatar.title : unavailable_tools" :aria-label="moss_avatar.title" :aria-current="moss_current ? 'page' : undefined" @click="open_moss"><img class="channel-moss-avatar moss-avatar" :class="`is-${moss_avatar.state}`" :src="moss_avatar.src" alt="" /><span>{{ t("MOSS") }}</span></button>
      <button type="button" class="channel-nav-item" :class="{ active: page_open }" :aria-current="page_open ? 'page' : undefined" @click="open_workflows"><UIcon name="i-lucide-network" /><span>{{ t("工作流") }}</span><i v-if="workflows_need_care" class="channel-nav-dot" :title="t('有工作流需要处理')" /></button>
      <button type="button" class="channel-nav-item" :class="{ active: analytics_open }" :disabled="!can_view_analytics" :title="can_view_analytics ? undefined : unavailable_tools" :aria-current="analytics_open ? 'page' : undefined" @click="emit('analytics')"><UIcon name="i-lucide-bar-chart-3" /><span>{{ t("统计") }}</span></button>
    </nav>
    <div v-keep-reading class="channel-sidebar-content">
      <ChannelDirectory :steward-setup="stewardSetup" @select="emit('select', $event)" @manage="emit('manage', $event)" @create="emit('create', $event)" @create-folder="emit('create-folder')" @manage-folder="emit('manage-folder', $event)" @delete-folder="emit('delete-folder', $event)" @archive-folder="emit('archive-folder', $event)" @archives="emit('archives')" @destructions="emit('destructions')" />
      <InvitedRooms @open="emit('invited', $event)" />
    </div>
  <footer class="channel-sidebar-footer">
    <button type="button" class="channel-self-button" :aria-label="t('账号与设置：{name}', { name: bridge.display_name(author) }) + (account_status ? t('，') + account_status : '')" @click="emit('settings')">
      <UAvatar :src="bridge.identities[author]?.icon" :text="bridge.identities[author]?.initials" :alt="bridge.display_name(author)" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
      <span class="channel-self"><strong>{{ bridge.display_name(author) }}</strong><span class="channel-connection" :class="{ 'is-action': account_status }"><span :class="{ connected: view.connected }" :title="view.connected ? t('网站已连接') : t('网站未连接')"></span>{{ account_status || (view.connected ? t('网站已连接') : view.reconnecting ? t('正在重新连接…') : view.rooms_loading ? t('正在连接…') : t('网站未连接')) }}</span></span>
    </button>
    <div :title="view.connected ? t('网站已连接') : undefined"><UTooltip :text="t('重新连接')"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" class="channel-icon-button" :aria-label="t('重新连接网站')" :loading="view.reconnecting" :disabled="view.connected" @click="bridge.reconnect()" /></UTooltip></div>
    <UTooltip :text="t('设置')"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" :aria-label="t('设置')" @click="emit('settings')" /></UTooltip>
  </footer>
  </aside>
</template>

<style scoped>
/* The fixed entries, as Claude's sidebar: equal 32px rows, a 16px glyph and the label, a quiet fill on hover and a
   firmer one for the page on screen (user #15318). Each opens a page; the room list below keeps its own rows. */
.channel-fixed-tools { display: grid; gap: 1px; flex-shrink: 0; padding: 10px 8px 6px; border-bottom: 1px solid var(--channel-line); }
.channel-nav-item { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; height: 32px; padding: 0 8px; border-radius: 8px; color: var(--ui-text-toned); font-size: var(--channel-nav-text); text-align: left; transition: background .12s, color .12s; }
.channel-nav-item > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.channel-nav-item > :deep(svg) { flex-shrink: 0; width: 16px; height: 16px; color: var(--ui-text-muted); }
@media (hover: hover) { .channel-nav-item:hover:not(:disabled) { background: var(--channel-ghost-hover); color: var(--ui-text-highlighted); } }
.channel-nav-item.active { background: var(--channel-ghost-active); color: var(--ui-text-highlighted); font-weight: 600; }
.channel-nav-item:disabled { opacity: .55; }
.channel-nav-item:focus-visible { box-shadow: inset 0 0 0 1px var(--ui-border-accented); }
/* Something in the workflow page wants a look (stopped, untrusted, broken): a small dot at the row's end. */
.channel-nav-dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: var(--ui-warning); }
/* MOSS's own picture stands in the glyph's place, a little larger so its state frame reads; no label beside it. */
.channel-nav-item > .channel-moss-avatar { width: 20px; height: 20px; margin: 0 -2px; object-fit: contain; flex-shrink: 0; }
/* The version number opens the changelog. A small chevron after it says it can be opened without hover, which phones
   never show; no chip around it, so the brand line stays quiet (user 2026-11-23). */
.channel-brand-text > .channel-brand-meta { display: flex; align-items: center; overflow: visible; }
.channel-version { display: inline-flex; align-items: center; gap: 1px; margin-left: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; transition: color .12s; }
.channel-version > :deep([class*="icon"]) { width: 11px; height: 11px; opacity: .7; }
.channel-version:hover, .channel-version:focus-visible { color: var(--ui-text-highlighted); }
.channel-version-unread { flex-shrink: 0; width: 5px; height: 5px; margin-left: 3px; border-radius: 50%; background: color-mix(in srgb, var(--ui-error) 65%, var(--ui-bg)); }
</style>

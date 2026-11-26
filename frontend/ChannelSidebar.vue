<script>
import { ref } from "vue";
const workflows_open = ref(true);
</script>

<script setup>
import { computed, inject, ref } from "vue";
import ChangelogDialog from "./ChangelogDialog.vue";
import ChannelDirectory from "./ChannelDirectory.vue";
import InvitedRooms from "./InvitedRooms.vue";
import { use_workflow_library, workflow_key, workflow_problem } from "./workflow-library.js";
import { use_analytics_page } from "./analytics-state.js";
import { t } from "./i18n.js";

/** The room sidebar, shared by the docked desktop column and the tablet and phone drawer. */
const emit = defineEmits(["select", "manage", "create", "create-folder", "manage-folder", "delete-folder", "archive-folder", "archives", "destructions", "workflows", "invited", "analytics", "settings"]);
const { view, bridge, field } = inject("discussion");
const author = field("author-select");
const { page_open: analytics_open } = use_analytics_page();
const can_view_analytics = computed(() => !view.value.share && Boolean(view.value.admin?.local || view.value.admin?.logged_in));
const library = use_workflow_library();
const {
  workflows, global_workflows, project_workflows, project_roots,
  available, draft, saved_id, saved_key, active_scope,
  page_open, renaming, rename_text, pending_items,
} = library;

// The “当前项目 / 全局” split only appears when the project has workflows (or an unsaved project draft); an empty project
// group would just say “暂无项目工作流” above the global list (2026-11-26 user request, #13351).
const has_project_section = computed(() => project_workflows.value.length > 0
  || (project_roots.value.length > 0 && Boolean(draft.value) && !saved_id.value && active_scope.value === "project"));

/** Show a workflow on the page and close the drawer. */
function open_workflow(item) {
  library.select(item);
  emit("workflows");
}

/** New or import from the heading's "+", then close the drawer once the page shows the draft. */
const add_items = computed(() => library.add_items.value.map((group) => group.map((item) => ({ ...item, onSelect: () => { item.onSelect(); emit("workflows"); } }))));
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

function row_status(item) {
  if (item.error) return t("无法读取");
  if (item.disabled) return t("已停用");
  if (item.unavailable?.length) return t("{count} 张卡片不可用", { count: item.unavailable.length });
  if (item.needs_trust) return t("待信任");
  if (item.readonly) return t("只读");
  return "";
}

function row_icon(item) {
  const key = workflow_key(item);
  if (pending_items.value.has(key)) return "i-lucide-loader-circle";
  if (workflow_problem(item)) return "i-lucide-triangle-alert";
  if (item.disabled) return "i-lucide-circle-pause";
  if (item.needs_trust) return "i-lucide-shield-alert";
  if (item.readonly) return "i-lucide-lock";
  return "i-lucide-network";
}
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
    <div v-keep-reading class="channel-sidebar-content">
      <ChannelDirectory @select="emit('select', $event)" @manage="emit('manage', $event)" @create="emit('create', $event)" @create-folder="emit('create-folder')" @manage-folder="emit('manage-folder', $event)" @delete-folder="emit('delete-folder', $event)" @archive-folder="emit('archive-folder', $event)" @archives="emit('archives')" @destructions="emit('destructions')" />
      <!-- Rooms on other computers this computer's AIs were invited to: their own section, opened in the middle like a room. -->
      <InvitedRooms @open="emit('invited', $event)" />
      <!-- The workflow library shows the current room's project workflows (when any) and global workflows. -->
      <div class="channel-directory-heading channel-tools-heading">
        <button type="button" class="channel-section-toggle" :aria-expanded="workflows_open" @click="workflows_open = !workflows_open; if (workflows_open) library.refresh_list()"><UIcon :name="workflows_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />{{ t("工作流") }}</button>
        <div v-if="available" class="channel-directory-actions">
          <UDropdownMenu :items="add_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-plus" :aria-label="t('新建或导入工作流')" :title="t('新建或导入')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
        </div>
      </div>
      <nav v-show="workflows_open" :aria-label="t('工作流列表')" class="channel-room-list channel-workflow-list">
        <template v-if="available">
          <template v-if="has_project_section">
            <p class="channel-workflow-group">{{ t("当前项目") }}</p>
            <div v-if="draft && !saved_id && active_scope === 'project'" class="channel-room-row" :class="{ active: page_open }">
              <button type="button" class="channel-room-select" :aria-current="page_open ? 'page' : undefined" @click="library.page_open.value = true; emit('workflows')"><UIcon name="i-lucide-file-plus-2" /><span>{{ draft.label || t('未命名工作流') }}</span><small class="channel-room-time">{{ t("未保存") }}</small></button>
            </div>
            <UContextMenu v-for="item in project_workflows" :key="workflow_key(item)" :disabled="!available || renaming === workflow_key(item) || pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :ui="{ content: 'channel-menu channel-topic-menu' }">
            <div class="channel-room-row" :class="{ active: page_open && saved_key === workflow_key(item), 'is-disabled': item.disabled, 'is-broken': workflow_problem(item) }">
              <span v-if="renaming === workflow_key(item)" class="channel-workflow-rename"><UIcon name="i-lucide-network" />
                <input v-model="rename_text" data-workflow-rename :maxlength="32" :aria-label="t('新名称')" @keydown.enter.prevent="library.commit_rename" @keydown.esc.prevent="renaming = ''" @blur="library.commit_rename" /></span>
              <button v-else type="button" class="channel-room-select" :title="[item.project_name ? `${t('项目')}：${item.project_name}` : '', item.readonly ? t('只读目录') : '', workflow_problem(item) || item.description].filter(Boolean).join(' · ')" :aria-current="page_open && saved_key === workflow_key(item) ? 'page' : undefined"
                @click="open_workflow(item)" @dblclick="!item.error && !item.readonly && !pending_items.has(workflow_key(item)) && library.start_rename(item)">
                <UIcon :name="row_icon(item)" :class="{ 'animate-spin': pending_items.has(workflow_key(item)) }" /><span>{{ item.label }}</span>
                <small v-if="row_status(item)" class="channel-room-time">{{ row_status(item) }}</small></button>
              <div v-if="available && renaming !== workflow_key(item)" class="channel-room-actions">
                <UDropdownMenu :disabled="pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :disabled="pending_items.has(workflow_key(item))" :aria-label="t('「{name}」的更多操作', { name: item.label })" :title="t('更多操作')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
              </div>
            </div>
            </UContextMenu>
            <p v-if="!project_workflows.length && !(draft && !saved_id && active_scope === 'project')" class="channel-workflow-empty">{{ t("暂无项目工作流") }}</p>
            <p class="channel-workflow-group">{{ t("全局") }}</p>
          </template>
          <div v-if="draft && !saved_id && (!has_project_section || active_scope !== 'project')" class="channel-room-row" :class="{ active: page_open }">
            <button type="button" class="channel-room-select" :aria-current="page_open ? 'page' : undefined" @click="library.page_open.value = true; emit('workflows')"><UIcon name="i-lucide-file-plus-2" /><span>{{ draft.label || t('未命名工作流') }}</span><small class="channel-room-time">{{ t("未保存") }}</small></button>
          </div>
          <UContextMenu v-for="item in global_workflows" :key="workflow_key(item)" :disabled="!available || renaming === workflow_key(item) || pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :ui="{ content: 'channel-menu channel-topic-menu' }">
          <div class="channel-room-row" :class="{ active: page_open && saved_key === workflow_key(item), 'is-disabled': item.disabled, 'is-broken': workflow_problem(item) }">
            <span v-if="renaming === workflow_key(item)" class="channel-workflow-rename"><UIcon name="i-lucide-network" />
              <input v-model="rename_text" data-workflow-rename :maxlength="32" :aria-label="t('新名称')" @keydown.enter.prevent="library.commit_rename" @keydown.esc.prevent="renaming = ''" @blur="library.commit_rename" /></span>
            <button v-else type="button" class="channel-room-select" :title="workflow_problem(item) || item.description" :aria-current="page_open && saved_key === workflow_key(item) ? 'page' : undefined"
              @click="open_workflow(item)" @dblclick="!item.error && !pending_items.has(workflow_key(item)) && library.start_rename(item)">
              <UIcon :name="row_icon(item)" :class="{ 'animate-spin': pending_items.has(workflow_key(item)) }" /><span>{{ item.label }}</span>
              <small v-if="row_status(item)" class="channel-room-time">{{ row_status(item) }}</small></button>
            <div v-if="available && renaming !== workflow_key(item)" class="channel-room-actions">
              <UDropdownMenu :disabled="pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :content="{ align: 'start', side: 'bottom', sideOffset: 6 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" :disabled="pending_items.has(workflow_key(item))" :aria-label="t('「{name}」的更多操作', { name: item.label })" :title="t('更多操作')" size="xs" color="neutral" variant="ghost" /></UDropdownMenu>
            </div>
          </div>
          </UContextMenu>
          <p v-if="!workflows.length && !draft && !has_project_section" class="channel-directory-empty">{{ t("暂无工作流") }}</p>
          <p v-else-if="has_project_section && !global_workflows.length && !(draft && !saved_id && active_scope !== 'project')" class="channel-workflow-empty">{{ t("暂无全局工作流") }}</p>
        </template>
        <p v-else class="channel-directory-empty">{{ t("连接本机服务后管理工作流") }}</p>
      </nav>
      <!-- Owner-only cross-room analytics entry, last in the left navigation, below workflows (2026-11-26 user request). -->
      <!-- Styled as a section heading, a peer of “协作房间 / 外部房间 / 工作流”: the icon takes the chevron's place. -->
      <div v-if="can_view_analytics" class="channel-directory-heading channel-tools-heading channel-analytics-heading" :class="{ 'is-current': analytics_open }">
        <button type="button" class="channel-section-toggle" :aria-current="analytics_open ? 'page' : undefined" @click="emit('analytics')"><UIcon name="i-lucide-bar-chart-3" />{{ t("统计") }}</button>
      </div>
    </div>
  <footer class="channel-sidebar-footer">
    <button type="button" class="channel-self-button" :aria-label="t('账号与设置：{name}', { name: bridge.display_name(author) }) + (account_status ? t('，') + account_status : '')" @click="emit('settings')">
      <UAvatar :src="bridge.identities[author]?.icon" :text="bridge.identities[author]?.initials" :alt="bridge.display_name(author)" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
      <span class="channel-self"><strong>{{ bridge.display_name(author) }}</strong><span class="channel-connection" :class="{ 'is-action': account_status }"><span :class="{ connected: view.connected }" :title="view.connected ? t('网站已连接') : t('网站未连接')"></span>{{ account_status || (view.connected ? t('网站已连接') : view.reconnecting ? t('正在重新连接…') : view.rooms_loading ? t('正在连接…') : t('网站未连接')) }}</span></span>
    </button>
    <UTooltip v-if="!view.connected" :text="t('重新连接')"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" class="channel-icon-button" :aria-label="t('重新连接网站')" :loading="view.reconnecting" @click="bridge.reconnect()" /></UTooltip>
    <UTooltip :text="t('设置')"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" :aria-label="t('设置')" @click="emit('settings')" /></UTooltip>
  </footer>
  </aside>
</template>

<style scoped>
/* The version number opens the changelog. A small chevron after it says it can be opened without hover, which phones
   never show; no chip around it, so the brand line stays quiet (user 2026-11-23). */
.channel-brand-text > .channel-brand-meta { display: flex; align-items: center; overflow: visible; }
.channel-version { display: inline-flex; align-items: center; gap: 1px; margin-left: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; letter-spacing: inherit; cursor: pointer; transition: color .12s; }
.channel-version > :deep([class*="icon"]) { width: 11px; height: 11px; opacity: .7; }
.channel-version:hover, .channel-version:focus-visible { color: var(--ui-text-highlighted); }
.channel-version-unread { flex-shrink: 0; width: 5px; height: 5px; margin-left: 3px; border-radius: 50%; background: color-mix(in srgb, var(--ui-error) 65%, var(--ui-bg)); }
.channel-workflow-group { margin: 8px 0 2px; padding: 0 8px; overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.channel-workflow-group:first-child { margin-top: 2px; }
.channel-workflow-empty { margin: 0; padding: 4px 8px 6px; color: var(--ui-text-dimmed); font-size: 12px; }
.channel-analytics-heading.is-current .channel-section-toggle { color: var(--ui-text-highlighted); }
</style>

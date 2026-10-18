<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChannelDiscussion from "./ChannelDiscussion.vue";
import TopicPanel from "./TopicPanel.vue";
import WorkspaceDialogs from "./WorkspaceDialogs.vue";
import ChannelDirectory from "./ChannelDirectory.vue";
import ProgressPanel from "./ProgressPanel.vue";
import ProgressBoard from "./ProgressBoard.vue";

const { view, bridge, field, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
const modal = ref("");
const managed_room = ref(null);
const target_folder = ref(null);
const detail_id = ref(null);
const nav_open = ref(false);
const info_open = ref(false);
const summary = field("state-input");
const brief = field("brief-input");
const search = field("search-input");
const author = field("author-select");
const LAYOUT_KEY = "ai-codiscuss-channel-layout";
const READING_WIDTHS = { narrow: { label: "窄", width: 720 }, default: { label: "默认", width: 960 }, wide: { label: "宽", width: 1240 } };
const RAIL_MIN = 220;
const RAIL_MAX = 440;
const RAIL_DEFAULT = 280;
const RAIL_STEP = 16;
const NAV_MIN = 180;
const NAV_MAX = 400;
const NAV_DEFAULT = 248;
const NAV_STEP = 16;
const CONTENT_MIN = 480;
const RAIL_BREAKPOINT = 1200;
const DIVIDER_WIDTH = 6;
const saved_layout = read_layout();
const reading_width = ref(saved_layout.reading);
const rail_width = ref(saved_layout.rail);
const nav_width = ref(saved_layout.nav);
const viewport_width = ref(typeof window === "undefined" ? NAV_DEFAULT + CONTENT_MIN + DIVIDER_WIDTH : window.innerWidth);
const nav_collapsed = ref(saved_layout.collapsed);
const brief_collapsed = ref(saved_layout.brief_collapsed);
const rail_collapsed = ref(saved_layout.rail_collapsed);
const rail_inline = computed(() => viewport_width.value >= RAIL_BREAKPOINT);
const show_rail = computed(() => !!room.value && view.value.tab === "discussion" && !rail_collapsed.value);
const info_label = computed(() => rail_inline.value && view.value.tab === "discussion" ? (rail_collapsed.value ? "展开频道概览" : "收起频道概览") : "频道资料与参与者");
const brief_preview = computed(() => {
  const template = document.createElement("template");
  template.innerHTML = room.value?.rendered_brief || "";
  return template.content.textContent.replace(/\s+/g, " ").trim();
});
const rail_drag = ref(null);
const nav_drag = ref(null);
const nav_max = computed(() => Math.min(NAV_MAX, Math.max(NAV_MIN, viewport_width.value - CONTENT_MIN - DIVIDER_WIDTH)));
const effective_nav_width = computed(() => Math.min(nav_width.value, nav_max.value));
const layout_style = computed(() => ({
  "--channel-reading-width": `${READING_WIDTHS[reading_width.value].width}px`,
  "--channel-rail-width": `${rail_width.value}px`,
  "--channel-main-columns": nav_collapsed.value ? "minmax(0, 1fr)" : `${effective_nav_width.value}px ${DIVIDER_WIDTH}px minmax(0, 1fr)`,
}));
const width_options = Object.entries(READING_WIDTHS).map(([value, option]) => ({ value, label: option.label }));
watch(reading_width, save_layout);
watch(nav_collapsed, save_layout);
watch(brief_collapsed, save_layout);
watch(rail_collapsed, save_layout);
onMounted(() => window.addEventListener("resize", update_viewport_width));
onBeforeUnmount(() => window.removeEventListener("resize", update_viewport_width));
const selected_tab = computed({ get: () => view.value.tab, set: (value) => act("tab", value) });
const tabs = [
  { value: "discussion", label: "消息", icon: "i-lucide-message-square" },
  { value: "context", label: "共识", icon: "i-lucide-file-text" },
  { value: "topic", label: "主持", icon: "i-lucide-list-checks" },
  { value: "access", label: "接入", icon: "i-lucide-plug" },
];
const view_links = computed(() => tabs.map((item) => ({
  ...item, active: view.value.tab === item.value, onSelect: () => { nav_open.value = false; act("tab", item.value); },
})));
const participants = computed(() => [
  { name: "用户", mode: "发起与协助" },
  ...Object.entries(room.value?.experts || {}).map(([name, mode]) => ({ name, mode: mode === "cli" ? "CLI · 读写" : "在线 AI · 只读" })),
]);
const channel_actions = computed(() => [[
  { label: "重命名", icon: "i-lucide-pencil", disabled: view.value.directory_pending.includes(`rename:${room.value?.id}`), onSelect: () => manage_room({ room: room.value, action: "rename" }) },
  { label: "编辑议题", icon: "i-lucide-pencil", onSelect: () => { modal.value = "edit"; } },
  { label: "复制阅读入口", icon: "i-lucide-link", onSelect: () => act("copy_reading") },
  { label: view.value.backup_pending ? "正在备份…" : "备份当前讨论", icon: "i-lucide-download", disabled: view.value.backup_pending || !!pending.value, onSelect: () => act("backup") },
], [
  { label: "刷新消息", icon: "i-lucide-refresh-cw", onSelect: () => act("refresh") },
  { label: "外观设置", icon: "i-lucide-settings-2", onSelect: () => { modal.value = "settings"; } },
], [
  { label: room.value?.archived ? "恢复频道" : "存档频道", icon: room.value?.archived ? "i-lucide-archive-restore" : "i-lucide-archive", disabled: view.value.archive_pending.includes(room.value?.id), onSelect: () => manage_room({ room: room.value, action: room.value.archived ? "restore" : "archive" }) },
  { label: "永久删除", icon: "i-lucide-trash-2", disabled: view.value.directory_pending.includes(`rename:${room.value?.id}`), onSelect: () => manage_room({ room: room.value, action: "delete" }) },
]]);

/** Open management for the exact sidebar item while leaving its draft untouched. */
function manage_room({ room, action }) { managed_room.value = room; nav_open.value = false; modal.value = action; }

/** Open archive management without selecting a channel or changing its draft. */
function open_archives() { nav_open.value = false; modal.value = "archives"; }

/** Select a shared room and close the mobile navigation. */
async function choose_room(id) { nav_open.value = false; await act("room", id); }

/** Open an exact original message without altering the transcript. */
function open_detail(id) { detail_id.value = id; modal.value = "message"; }

/** Open the shared creation form from either navigation surface. */
function create_channel(folder = null) { target_folder.value = folder; nav_open.value = false; modal.value = "create"; }

/** Open folder creation after closing the mobile directory. */
function create_folder() { target_folder.value = null; nav_open.value = false; modal.value = "folder"; }

/** Open the folder name editor without changing the active conversation. */
function edit_folder(folder) { target_folder.value = folder; nav_open.value = false; modal.value = "rename-folder"; }

/** Confirm removal of a grouping without selecting or deleting a conversation. */
function remove_folder(folder) { target_folder.value = folder; nav_open.value = false; modal.value = "delete-folder"; }

/** Restore only supported conversation and sidebar dimensions. */
function read_layout() {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
    return {
      reading: Object.hasOwn(READING_WIDTHS, saved.reading) ? saved.reading : "default",
      rail: Number.isFinite(saved.rail) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, saved.rail)) : RAIL_DEFAULT,
      nav: Number.isFinite(saved.nav) ? Math.min(NAV_MAX, Math.max(NAV_MIN, saved.nav)) : default_nav_width(),
      collapsed: saved.collapsed === true,
      brief_collapsed: saved.brief_collapsed === true,
      rail_collapsed: saved.rail_collapsed === true,
    };
  } catch { return { reading: "default", rail: RAIL_DEFAULT, nav: default_nav_width(), collapsed: false, brief_collapsed: false, rail_collapsed: false }; }
}

/** Preserve the existing responsive navigation width on first use. */
function default_nav_width() {
  if (typeof window === "undefined") return NAV_DEFAULT;
  return window.innerWidth >= 1900 ? 280 : window.innerWidth <= 980 ? 220 : NAV_DEFAULT;
}

/** Keep layout preferences local without blocking adjustments when storage is unavailable. */
function save_layout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ reading: reading_width.value, rail: rail_width.value, nav: nav_width.value, collapsed: nav_collapsed.value, brief_collapsed: brief_collapsed.value, rail_collapsed: rail_collapsed.value })); }
  catch { /* The current page can still use the selected layout. */ }
}

/** Toggle the inline overview rail on wide discussion views; otherwise open channel details. */
function toggle_info() {
  if (rail_inline.value && view.value.tab === "discussion") rail_collapsed.value = !rail_collapsed.value;
  else info_open.value = true;
}

/** Keep the resizable layout within the current viewport. */
function update_viewport_width() { viewport_width.value = window.innerWidth; }

/** Capture the divider so dragging continues outside its narrow hit area. */
function start_rail_resize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.focus();
  rail_drag.value = { pointer: event.pointerId, x: event.clientX, width: rail_width.value };
  event.currentTarget.setPointerCapture(event.pointerId);
}

/** Grow the right sidebar as its left divider moves left. */
function resize_rail(event) {
  if (rail_drag.value?.pointer !== event.pointerId) return;
  rail_width.value = Math.round(Math.min(RAIL_MAX, Math.max(RAIL_MIN, rail_drag.value.width + rail_drag.value.x - event.clientX)));
}

/** Persist the final size and release the active pointer. */
function finish_rail_resize(event) {
  if (rail_drag.value?.pointer !== event.pointerId) return;
  rail_drag.value = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  save_layout();
}

/** Offer the same sidebar adjustment with arrow, Home and End keys. */
function resize_rail_by_key(event) {
  const widths = { ArrowLeft: rail_width.value + RAIL_STEP, ArrowRight: rail_width.value - RAIL_STEP, Home: RAIL_MIN, End: RAIL_MAX };
  if (!Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  rail_width.value = Math.min(RAIL_MAX, Math.max(RAIL_MIN, widths[event.key]));
  save_layout();
}

/** Capture the left divider so the channel navigation width can be dragged. */
function start_nav_resize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.focus();
  nav_drag.value = { pointer: event.pointerId, x: event.clientX, width: effective_nav_width.value };
  event.currentTarget.setPointerCapture(event.pointerId);
}

/** Grow the navigation as its right divider moves right. */
function resize_nav(event) {
  if (nav_drag.value?.pointer !== event.pointerId) return;
  nav_width.value = Math.round(Math.min(nav_max.value, Math.max(NAV_MIN, nav_drag.value.width + event.clientX - nav_drag.value.x)));
}

/** Save the chosen navigation width and release the active pointer. */
function finish_nav_resize(event) {
  if (nav_drag.value?.pointer !== event.pointerId) return;
  nav_drag.value = null;
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  save_layout();
}

/** Adjust the navigation with arrow, Home and End keys. */
function resize_nav_by_key(event) {
  const widths = { ArrowLeft: effective_nav_width.value - NAV_STEP, ArrowRight: effective_nav_width.value + NAV_STEP, Home: NAV_MIN, End: nav_max.value };
  if (!Object.hasOwn(widths, event.key)) return;
  event.preventDefault();
  nav_width.value = Math.min(nav_max.value, Math.max(NAV_MIN, widths[event.key]));
  save_layout();
}
</script>

<template>
  <div class="channel-shell" :class="{ 'channel-resizing': rail_drag || nav_drag, 'channel-nav-collapsed': nav_collapsed, 'channel-has-rail': show_rail }" :style="layout_style">
    <aside id="channel-sidebar" class="channel-sidebar" aria-label="频道导航">
      <header class="channel-workspace-heading">
        <span class="channel-brand-icon"><UIcon name="i-lucide-messages-square" /></span>
        <strong>共议</strong><span>AI CoDiscuss</span>
      </header>
      <div class="channel-sidebar-content">
        <ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" />
        <template v-if="room">
          <div class="channel-directory-heading channel-tools-heading"><span><UIcon name="i-lucide-chevron-down" />频道工具</span></div>
          <UNavigationMenu :items="view_links" orientation="vertical" color="neutral" variant="pill" class="channel-directory channel-view-links" aria-label="频道视图" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkLeadingIcon: 'channel-link-icon' }" />
        </template>
      </div>
      <footer class="channel-sidebar-footer">
        <UAvatar :src="bridge.identities[author]?.icon" :text="bridge.identities[author]?.initials" :alt="bridge.display_name(author)" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
        <div class="channel-self"><strong>{{ bridge.display_name(author) }}</strong><div class="channel-connection"><span :class="{ connected: view.connected }"></span>{{ view.connected ? '服务已连接' : '服务未连接' }}</div></div>
        <UTooltip text="外观设置"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="外观设置" @click="modal = 'settings'" /></UTooltip>
      </footer>
    </aside>
    <div v-if="!nav_collapsed" class="channel-nav-resizer" role="separator" tabindex="0" aria-label="调整频道栏宽度" aria-orientation="vertical" aria-controls="channel-sidebar" :aria-valuemin="NAV_MIN" :aria-valuemax="nav_max" :aria-valuenow="effective_nav_width" :aria-valuetext="`${effective_nav_width} 像素`" title="拖动调整频道栏宽度，也可使用方向键" @pointerdown="start_nav_resize" @pointermove="resize_nav" @pointerup="finish_nav_resize" @pointercancel="finish_nav_resize" @lostpointercapture="finish_nav_resize" @keydown="resize_nav_by_key"></div>

    <main class="channel-main">
      <header class="channel-header">
        <UTooltip :text="nav_collapsed ? '展开频道栏' : '收起频道栏'"><UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-desktop-nav channel-icon-button channel-panel-toggle" :aria-label="nav_collapsed ? '展开频道栏' : '收起频道栏'" :aria-expanded="!nav_collapsed" aria-controls="channel-sidebar" @click="nav_collapsed = !nav_collapsed" /></UTooltip>
        <UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-mobile-nav channel-icon-button channel-panel-toggle" aria-label="打开频道导航" :aria-expanded="nav_open" @click="nav_open = true" />
        <span class="channel-title-icon"><UIcon name="i-lucide-hash" /></span>
        <div class="channel-title"><div class="channel-title-copy"><h1 :title="room?.title">{{ room?.title || '共议' }}</h1><div v-if="room?.floor" class="channel-floor-status" :class="{ 'is-held': room.floor.holder }" role="status" :title="`发言权：${bridge.floor_status(room)}`"><UIcon name="i-lucide-mic" /><span>发言权：{{ bridge.floor_status(room) }}</span></div></div><UBadge v-if="room?.archived" color="neutral" variant="subtle" size="sm">已存档</UBadge></div>
        <span v-if="room" class="channel-header-context">{{ tabs.find((item) => item.value === view.tab)?.label }}<span>·</span>{{ room.message_count }} 条记录</span>
        <div v-if="room" class="channel-header-actions">
          <ProgressPanel :floating="!(show_rail && rail_inline)" />
          <form v-if="view.tab === 'discussion'" class="channel-search" @submit.prevent="act('filter', { query: search })">
            <UInput v-model="search" icon="i-lucide-search" variant="none" size="sm" placeholder="搜索消息" aria-label="搜索讨论记录" class="channel-search-input">
              <template #trailing><UButton v-if="search || view.query" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="清除搜索" @click="search = ''; act('filter', { query: '' })" /><UButton type="submit" icon="i-lucide-corner-down-left" color="neutral" variant="ghost" size="xs" aria-label="搜索" /></template>
            </UInput>
          </form>
          <UTooltip v-if="view.tab === 'discussion'" text="只看提到当前身份的消息"><UButton icon="i-lucide-at-sign" :variant="view.mention_only ? 'soft' : 'ghost'" color="neutral" size="sm" class="channel-icon-button channel-mention-filter" :aria-pressed="view.mention_only" aria-label="提到我" @click="act('filter', { mention: !view.mention_only })" /></UTooltip>
          <UDropdownMenu :items="channel_actions" :content="{ align: 'end', sideOffset: 8 }" :ui="{ content: 'channel-menu channel-topic-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="频道菜单" /></UDropdownMenu>
        </div>
        <UTooltip v-if="room" :text="info_label"><UButton icon="i-lucide-panel-right" color="neutral" variant="ghost" size="sm" class="channel-icon-button channel-panel-toggle channel-info-button" :aria-label="info_label" :aria-expanded="rail_inline && view.tab === 'discussion' ? show_rail : info_open" @click="toggle_info" /></UTooltip>
      </header>
      <div v-if="room" class="channel-tabbar">
        <UTabs v-model="selected_tab" :items="tabs" :content="false" variant="pill" color="neutral" size="sm" class="channel-tabs" aria-label="频道视图" />
      </div>
      <section v-if="room" class="channel-host-brief" :class="{ 'is-collapsed': brief_collapsed }" aria-label="主持简报">
        <div class="channel-brief-inner">
          <div class="channel-brief-heading">
            <button type="button" class="channel-brief-toggle" :aria-label="brief_collapsed ? '展开主持简报' : '收起主持简报'" :aria-expanded="!brief_collapsed" aria-controls="channel-brief-content" @click="brief_collapsed = !brief_collapsed"><UIcon :name="brief_collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><strong>主持简报{{ brief_collapsed ? '：' : '' }}</strong><span v-if="brief_collapsed" class="channel-brief-preview">{{ brief_preview }}</span></button>
            <template v-if="!brief_collapsed"><span class="channel-brief-round">{{ bridge.progress_round(room) }}</span><UButton label="更新简报" color="neutral" variant="link" size="xs" class="channel-brief-update" @click="act('tab', 'context')" /></template>
          </div>
          <div v-show="!brief_collapsed" id="channel-brief-content" class="channel-brief-content">
            <div class="channel-brief-text markdown-body" v-html="room.rendered_brief"></div>
            <div class="channel-brief-footer"><span class="channel-brief-status">{{ bridge.progress_speaker(room) }}</span><small>{{ bridge.brief_meta(room) }}</small></div>
          </div>
        </div>
      </section>
      <div v-if="room" class="channel-body" :class="{ 'channel-body-discussion': view.tab === 'discussion' }">
        <div class="channel-content">
        <ChannelDiscussion v-show="view.tab === 'discussion'" @detail="open_detail" @edit="modal = 'edit'" />
        <section v-if="view.tab === 'context'" class="content-page channel-summary" role="tabpanel" aria-label="共识">
          <div class="page-heading"><div><h2>共识与分歧</h2><p>整理讨论进展，用 #消息编号 保留依据。</p></div><UBadge color="neutral" variant="outline">截止 #{{ room.state_until }}</UBadge></div>
          <section v-if="Array.isArray(room.latest_receipts) && room.latest_receipts.length" class="info-section"><h3>最新运行回执</h3><p class="fine-print">以下回执独立于摘要更新；晚于摘要的回执可能尚未整理，实际运行结果请查看原文。</p><div class="button-row"><UButton v-for="receipt in room.latest_receipts" :key="receipt.id" :label="`${bridge.display_name(receipt.author)} #${receipt.id} · ${new Date(receipt.created_at).toLocaleString('zh-CN')}${receipt.id > room.state_until ? ' · 晚于摘要' : ''}`" variant="link" color="neutral" @click="open_detail(receipt.id)" /></div></section>
          <form @submit.prevent="act('save_context')">
            <UFormField label="主持简报" description="简述结论、共识、歧义，以及接下来要追问或调整什么、为什么。" class="channel-brief-editor"><UTextarea v-model="brief" aria-label="主持简报正文" :rows="4" class="w-full" placeholder="让返回房间的人快速理解讨论进展和主持意图。" /></UFormField>
            <label class="channel-state-label">详细共识与进度</label>
            <UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="15" :maxlength="4000" class="summary-editor" placeholder="已达成的共识、尚未解决的问题与下一步…" />
            <div class="form-footer"><span>依据消息截止 #{{ view.snapshot_id }}</span><UButton type="submit" color="neutral" icon="i-lucide-check" label="保存共识" class="channel-primary-button" :loading="pending === 'save_context'" /></div>
          </form>
        </section>
        <TopicPanel v-if="view.tab === 'topic' || view.tab === 'access'" :key="view.tab" @open="modal = $event" @detail="open_detail" />
        </div>
      </div>
      <div v-else class="channel-empty"><UIcon name="i-lucide-hash" /><h2>新建一个讨论频道</h2><p>每个频道围绕一个议题，保留所有人的观点。</p><UButton icon="i-lucide-plus" label="新建讨论" color="neutral" @click="create_channel()" /></div>
    </main>
    <div v-if="show_rail" class="channel-rail-resizer" role="separator" tabindex="0" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-controls="channel-member-rail" :aria-valuemin="RAIL_MIN" :aria-valuemax="RAIL_MAX" :aria-valuenow="rail_width" :aria-valuetext="`${rail_width} 像素`" title="拖动调整右侧栏宽度，也可使用左右方向键" @pointerdown="start_rail_resize" @pointermove="resize_rail" @pointerup="finish_rail_resize" @pointercancel="finish_rail_resize" @lostpointercapture="finish_rail_resize" @keydown="resize_rail_by_key"></div>
    <aside v-if="show_rail" id="channel-member-rail" class="channel-member-rail" aria-label="当前焦点与讨论进度">
      <section class="channel-rail-board"><ProgressBoard /></section>
    </aside>

    <USlideover v-model:open="nav_open" side="left" title="讨论频道" description="共议 · AI CoDiscuss" :ui="{ content: 'channel-navigation-drawer', body: 'channel-drawer-body' }">
      <template #body><ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" /><UButton block icon="i-lucide-settings-2" color="neutral" variant="ghost" label="外观设置" @click="nav_open = false; modal = 'settings'" /></template>
    </USlideover>
    <USlideover v-model:open="info_open" title="频道资料" description="目标、背景与参与方式" :ui="{ content: 'channel-details', body: 'space-y-6' }">
      <template #body><template v-if="room">
        <div class="channel-detail-title"><UIcon name="i-lucide-hash" /><h2>{{ room.title }}</h2></div>
        <section v-for="item in [{ key: 'goal', label: '讨论目标' }, { key: 'focus', label: '当前焦点' }, { key: 'user_request', label: '用户原文' }, { key: 'background', label: '背景' }, { key: 'boundaries', label: '讨论边界' }]" :key="item.key" class="info-section"><h3>{{ item.label }}</h3><p>{{ room[item.key] || '尚未填写' }}</p></section>
        <USeparator />
        <section class="info-section"><h3>参与身份</h3><div v-for="person in participants" :key="person.name" class="expert-row"><UAvatar :src="bridge.identities[person.name]?.icon" :text="bridge.identities[person.name]?.initials" :alt="bridge.display_name(person.name)" size="sm" class="channel-avatar" :class="bridge.identities[person.name]?.style" /><b>{{ bridge.display_name(person.name) }}</b><small>{{ person.mode }}</small></div></section>
        <UButton icon="i-lucide-pencil" color="neutral" variant="outline" block class="channel-surface-button" label="编辑议题" @click="info_open = false; modal = 'edit'" />
      </template></template>
    </USlideover>
    <WorkspaceDialogs v-model="modal" v-model:reading-width="reading_width" :reading-options="width_options" :detail-id="detail_id" :target-room="managed_room" :target-folder="target_folder" />
  </div>
</template>

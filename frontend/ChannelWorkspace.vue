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
const tools_open = ref(true);
const info_open = ref(false);
const summary = field("state-input");
const brief = field("brief-input");
const search = field("search-input");
const author = field("author-select");
const LAYOUT_KEY = "ai-codiscuss-channel-layout";
const EFFECT_OPTIONS = [{ value: "full", label: "完整" }, { value: "reduced", label: "精简" }];
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
// Resize handles overlap the panel seams (see channel.css), so their grid tracks take no width.
const DIVIDER_WIDTH = 0;
const saved_layout = read_layout();
const reading_width = ref(saved_layout.reading);
const effects = ref(saved_layout.effects);
const rail_width = ref(saved_layout.rail);
const nav_width = ref(saved_layout.nav);
const viewport_width = ref(typeof window === "undefined" ? NAV_DEFAULT + CONTENT_MIN + DIVIDER_WIDTH : window.innerWidth);
const nav_collapsed = ref(saved_layout.collapsed);
// The expanded brief floats over the messages, so it always starts collapsed instead of covering them.
const brief_collapsed = ref(true);
const rail_collapsed = ref(saved_layout.rail_collapsed);
const rail_inline = computed(() => viewport_width.value >= RAIL_BREAKPOINT);
// The rail and channel tools stay in place without a room so the layout never jumps; room-only controls are disabled.
const show_rail = computed(() => view.value.tab === "discussion" && !rail_collapsed.value);
const info_label = computed(() => rail_inline.value && view.value.tab === "discussion" ? (rail_collapsed.value ? "展开频道概览" : "收起频道概览") : "频道资料与参与者");
const brief_preview = computed(() => {
  const template = document.createElement("template");
  template.innerHTML = room.value?.rendered_brief || "";
  return template.content.textContent.replace(/\s+/g, " ").trim();
});
const topbar = ref(null);
// Only the collapsed height offsets the transcript; the expanded brief floats over messages instead of pushing them.
const topbar_height = ref(0);
let topbar_observer = null;
const rail_drag = ref(null);
const nav_drag = ref(null);
const nav_max = computed(() => Math.min(NAV_MAX, Math.max(NAV_MIN, viewport_width.value - CONTENT_MIN - DIVIDER_WIDTH)));
const effective_nav_width = computed(() => Math.min(nav_width.value, nav_max.value));
const layout_style = computed(() => ({
  "--channel-reading-width": `${READING_WIDTHS[reading_width.value].width}px`,
  "--channel-rail-width": `${rail_width.value}px`,
  "--channel-topbar-height": `${topbar_height.value}px`,
  "--channel-main-columns": nav_collapsed.value ? "minmax(0, 1fr)" : `${effective_nav_width.value}px ${DIVIDER_WIDTH}px minmax(0, 1fr)`,
}));
const width_options = Object.entries(READING_WIDTHS).map(([value, option]) => ({ value, label: option.label }));
watch(reading_width, save_layout);
// Portalled menus and dialogs sit outside the shell, so the preference marks the document root.
watch(effects, (value) => { document.documentElement.dataset.effects = value; save_layout(); }, { immediate: true });
watch(nav_collapsed, save_layout);
watch(rail_collapsed, save_layout);
onMounted(() => window.addEventListener("resize", update_viewport_width));
onBeforeUnmount(() => window.removeEventListener("resize", update_viewport_width));
onMounted(() => document.addEventListener("pointerdown", collapse_brief_outside));
onMounted(() => {
  topbar_observer = new ResizeObserver(([entry]) => { if (brief_collapsed.value) topbar_height.value = Math.round(entry.target.offsetHeight); });
  topbar_observer.observe(topbar.value);
});
onBeforeUnmount(() => topbar_observer?.disconnect());
onBeforeUnmount(() => document.removeEventListener("pointerdown", collapse_brief_outside));
const selected_tab = computed({ get: () => view.value.tab, set: (value) => act("tab", value) });
const ALL_TABS = [
  { value: "discussion", label: "消息", icon: "i-lucide-message-square" },
  { value: "context", label: "共识", icon: "i-lucide-file-text" },
  { value: "topic", label: "主持", icon: "i-lucide-list-checks" },
  { value: "access", label: "接入", icon: "i-lucide-plug" },
];
/** Free rooms keep coordination in the conversation and member rail. */
const free_room = computed(() => room.value?.mode === "free");
const tabs = computed(() => free_room.value ? ALL_TABS.slice(0, 1) : ALL_TABS);
const invite_name = ref("");
const invite_access = ref("runner");
watch(() => room.value?.id, () => {
  invite_name.value = "";
  invite_access.value = (room.value?.free?.members || []).some(member => member.access === "runner") ? "runner" : "manual";
}, { immediate: true });
/** Open the creation dialog prefilled for a brainstorm room linked to this free room. */
async function start_brainstorm() { await act("prepare_brainstorm"); target_folder.value = null; modal.value = "create"; }
/** Library cards to invite from; a card already in the room adds another instance (Claude-2, …). */
const invite_choices = computed(() => Object.keys(invite_access.value === "online" ? bridge.identities : bridge.launch_clients).filter((name) => name !== "用户")
  .map((name) => ({ label: bridge.display_name(name), value: name })));
/** A member is busy while it has a live execution or queued requests. */
const free_member_busy = (member) => member.pending > 0 || ["dispatched", "started"].includes(member.execution?.status);
const free_host = computed(() => (room.value?.free?.members || []).find((member) => member.role === "host"));
/** Status dot colour, matching the discussion progress board. */
function free_member_tone(member) {
  if (member.status === "away") return "idle";
  if (member.execution?.stale) return "error";
  if (free_member_busy(member)) return member.pending && !["dispatched", "started"].includes(member.execution?.status) ? "warning" : "primary";
  return member.execution?.status === "failed" ? "error" : "success";
}
/** Owner actions for one member, kept in its menu like the discussion board's member actions. */
function free_member_menu(member) {
  const item = (label, icon, action, extra = {}) => ({ label, icon, onSelect: () => act("change_member", { member_id: member.id, name: member.name, action, ...extra }) });
  const access = view.value.access;
  const available = access?.members?.find((item) => item.name === member.name)?.available;
  return [[
    { label: "复制参与说明", icon: "i-lucide-copy", disabled: !access?.can_manage, onSelect: () => act("copy_member_join", member.name) },
    ...(member.access !== "online" ? [{ label: "下载私有配置", icon: "i-lucide-download", disabled: !access?.can_manage || !available, onSelect: () => act("download_member_access", member.name) }] : []),
  ], [
    ...(free_member_busy(member) ? [item("停止", "i-lucide-square", "interrupt")] : []),
    ...(member.access === "online" && member.pending ? [{ label: "复制阅读通知", icon: "i-lucide-copy", onSelect: () => act("copy_online_notice", member.name) }] : []),
    ...(member.status === "active" && member.access !== "online" ? [item(member.role === "host" ? "取消主持" : "设为主持人", "i-lucide-crown", "role", { role: member.role === "host" ? "member" : "host" })] : []),
    member.status === "active" ? item("离开", "i-lucide-log-out", "away") : { ...item("请回", "i-lucide-log-in", "rejoin"), disabled: member.access === "runner" && !view.value.launch.available },
  ], [{ ...item("移除", "i-lucide-trash-2", "remove"), color: "error" }]];
}
/** One line per member: live execution, queued requests, or the last outcome. */
function free_member_status(member) {
  if (member.status === "away") return "已离开：不会被唤醒，可请回";
  const execution = member.execution;
  if (execution && ["dispatched", "started"].includes(execution.status)) return execution.stale ? "执行失联，停止未确认" : "正在处理";
  if (member.pending) return `待投递 ${member.pending} 条`;
  if (execution?.status === "failed") return `上次失败：${execution.result}`;
  return execution ? "空闲" : "尚未收到消息";
}
watch(() => free_room.value && view.value.tab !== "discussion", (leave) => { if (leave) act("tab", "discussion"); }, { immediate: true });
const view_links = computed(() => tabs.value.map((item) => ({
  ...item, active: !!room.value && view.value.tab === item.value, disabled: !room.value, onSelect: () => { nav_open.value = false; act("tab", item.value); },
})));
const participants = computed(() => [
  { name: "用户", mode: "发起与协助" },
  ...Object.entries(room.value?.experts || {}).map(([name, mode]) => ({ name, mode: mode === "cli" ? "CLI · 读写" : "在线 AI · 只读" })),
]);

/** Open management for the exact sidebar item while leaving its draft untouched. */
function manage_room({ room, action }) { managed_room.value = room; nav_open.value = false; modal.value = action; }

/** Open archive management without selecting a channel or changing its draft. */
function open_archives() { nav_open.value = false; modal.value = "archives"; }

/** Select a shared room and close the mobile navigation. */
async function choose_room(id) { nav_open.value = false; await act("room", id); }

/** Open an exact original message without altering the transcript. */
function open_detail(id) { detail_id.value = id; modal.value = "message"; }

/** Open the shared creation form from either navigation surface. */
function create_channel(folder = null) { bridge.reset_create_form(); target_folder.value = folder; nav_open.value = false; modal.value = "create"; }

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
      effects: saved.effects === "reduced" ? "reduced" : "full",
      rail: Number.isFinite(saved.rail) ? Math.min(RAIL_MAX, Math.max(RAIL_MIN, saved.rail)) : RAIL_DEFAULT,
      nav: Number.isFinite(saved.nav) ? Math.min(NAV_MAX, Math.max(NAV_MIN, saved.nav)) : default_nav_width(),
      collapsed: saved.collapsed === true,
      brief_collapsed: saved.brief_collapsed === true,
      rail_collapsed: saved.rail_collapsed === true,
    };
  } catch { return { reading: "default", effects: "full", rail: RAIL_DEFAULT, nav: default_nav_width(), collapsed: false, brief_collapsed: false, rail_collapsed: false }; }
}

/** Preserve the existing responsive navigation width on first use. */
function default_nav_width() {
  if (typeof window === "undefined") return NAV_DEFAULT;
  return window.innerWidth >= 1900 ? 280 : window.innerWidth <= 980 ? 220 : NAV_DEFAULT;
}

/** Keep layout preferences local without blocking adjustments when storage is unavailable. */
function save_layout() {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ reading: reading_width.value, effects: effects.value, rail: rail_width.value, nav: nav_width.value, collapsed: nav_collapsed.value, brief_collapsed: brief_collapsed.value, rail_collapsed: rail_collapsed.value })); }
  catch { /* The current page can still use the selected layout. */ }
}

/** Toggle the inline overview rail on wide discussion views; otherwise open channel details. */
function toggle_info() {
  if (rail_inline.value && view.value.tab === "discussion") rail_collapsed.value = !rail_collapsed.value;
  else info_open.value = true;
}

/** Keep the resizable layout within the current viewport. */
function update_viewport_width() { viewport_width.value = window.innerWidth; }

/** Toggle the floating host brief; the bar keeps its height so the messages never move. */
function toggle_brief() { brief_collapsed.value = !brief_collapsed.value; }

/** Close the floating brief when the pointer lands anywhere outside it. */
function collapse_brief_outside(event) {
  if (!brief_collapsed.value && !event.target.closest?.(".channel-host-brief")) brief_collapsed.value = true;
}

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
        <span class="channel-brand-icon" aria-hidden="true"><svg viewBox="0 0 100 100">
          <defs>
            <linearGradient id="channel-brand-grok" gradientUnits="userSpaceOnUse" x1="5.75" y1="68" x2="94.25" y2="68"><stop offset="0%" class="channel-brand-grok-1"/><stop offset="50%" class="channel-brand-grok-1"/><stop offset="50%" class="channel-brand-grok-2"/><stop offset="100%" class="channel-brand-grok-2"/></linearGradient>
            <linearGradient id="channel-brand-gemini" gradientUnits="userSpaceOnUse" x1="7.75" y1="33" x2="92.25" y2="33"><stop offset="0%" stop-color="#3186ff"/><stop offset="25%" stop-color="#3186ff"/><stop offset="25%" stop-color="#fc413d"/><stop offset="50%" stop-color="#fc413d"/><stop offset="50%" stop-color="#fbbc04"/><stop offset="75%" stop-color="#fbbc04"/><stop offset="75%" stop-color="#00b95c"/><stop offset="100%" stop-color="#00b95c"/></linearGradient>
            <linearGradient id="channel-brand-claude" gradientUnits="userSpaceOnUse" x1="24.92" y1="93.16" x2="40.08" y2="6.84"><stop offset="0%" class="channel-brand-claude-1"/><stop offset="50%" class="channel-brand-claude-1"/><stop offset="50%" class="channel-brand-claude-2"/><stop offset="100%" class="channel-brand-claude-2"/></linearGradient>
            <linearGradient id="channel-brand-codex" gradientUnits="userSpaceOnUse" x1="75.08" y1="93.16" x2="59.92" y2="6.84"><stop offset="0%" class="channel-brand-codex-1"/><stop offset="50%" class="channel-brand-codex-1"/><stop offset="50%" class="channel-brand-codex-2"/><stop offset="100%" class="channel-brand-codex-2"/></linearGradient>
          </defs>
          <line class="channel-brand-gap" x1="12" y1="68" x2="88" y2="68"/>
          <line x1="12" y1="68" x2="88" y2="68" stroke="url(#channel-brand-grok)" stroke-width="12.5" stroke-linecap="round"/>
          <line class="channel-brand-gap" x1="14" y1="33" x2="86" y2="33"/>
          <line x1="14" y1="33" x2="86" y2="33" stroke="url(#channel-brand-gemini)" stroke-width="12.5" stroke-linecap="round"/>
          <line class="channel-brand-gap" x1="26" y1="87" x2="39" y2="13"/>
          <line x1="26" y1="87" x2="39" y2="13" stroke="url(#channel-brand-claude)" stroke-width="12.5" stroke-linecap="round"/>
          <line class="channel-brand-gap" x1="74" y1="87" x2="61" y2="13"/>
          <line x1="74" y1="87" x2="61" y2="13" stroke="url(#channel-brand-codex)" stroke-width="12.5" stroke-linecap="round"/>
        </svg></span>
        <span class="channel-brand-text"><strong>共议</strong><span>AI CoDiscuss</span></span>
      </header>
      <div class="channel-sidebar-content">
        <ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" />
        <div class="channel-directory-heading channel-tools-heading"><button type="button" class="channel-section-toggle" :aria-expanded="tools_open" @click="tools_open = !tools_open"><UIcon :name="tools_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />频道工具</button></div>
        <UNavigationMenu v-if="tools_open" :items="view_links" orientation="vertical" color="neutral" variant="pill" class="channel-directory channel-view-links" aria-label="频道视图" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkLeadingIcon: 'channel-link-icon' }" />
      </div>
      <footer class="channel-sidebar-footer">
        <UAvatar :src="bridge.identities[author]?.icon" :text="bridge.identities[author]?.initials" :alt="bridge.display_name(author)" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
        <div class="channel-self"><strong>{{ bridge.display_name(author) }}</strong><div class="channel-connection"><span :class="{ connected: view.connected }"></span>{{ view.connected ? '网站已连接' : '网站未连接' }}</div></div>
        <UTooltip text="外观设置"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="外观设置" @click="modal = 'settings'" /></UTooltip>
      </footer>
    </aside>
    <div v-if="!nav_collapsed" class="channel-nav-resizer" role="separator" tabindex="0" aria-label="调整频道栏宽度" aria-orientation="vertical" aria-controls="channel-sidebar" :aria-valuemin="NAV_MIN" :aria-valuemax="nav_max" :aria-valuenow="effective_nav_width" :aria-valuetext="`${effective_nav_width} 像素`" title="拖动调整频道栏宽度，也可使用方向键" @pointerdown="start_nav_resize" @pointermove="resize_nav" @pointerup="finish_nav_resize" @pointercancel="finish_nav_resize" @lostpointercapture="finish_nav_resize" @keydown="resize_nav_by_key"></div>

    <main class="channel-main">
      <div ref="topbar" class="channel-topbar" :class="{ 'is-overlay': room && view.tab === 'discussion' }">
        <header class="channel-header">
          <UTooltip :text="nav_collapsed ? '展开频道栏' : '收起频道栏'"><UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-desktop-nav channel-icon-button channel-panel-toggle" :aria-label="nav_collapsed ? '展开频道栏' : '收起频道栏'" :aria-expanded="!nav_collapsed" aria-controls="channel-sidebar" @click="nav_collapsed = !nav_collapsed" /></UTooltip>
          <UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-mobile-nav channel-icon-button channel-panel-toggle" aria-label="打开频道导航" :aria-expanded="nav_open" @click="nav_open = true" />
          <span class="channel-title-icon"><UIcon name="i-lucide-hash" /></span>
          <div class="channel-title"><div class="channel-title-copy"><h1 :title="room?.title">{{ room?.title || '共议' }}</h1><div v-if="room?.floor && !free_room" class="channel-floor-status" :class="{ 'is-held': room.floor.holder }" role="status" :title="`发言权：${bridge.floor_status(room)}`"><UIcon name="i-lucide-mic" /><span>发言权：{{ bridge.floor_status(room) }}</span></div></div><UBadge v-if="room?.archived" color="neutral" variant="subtle" size="sm">已存档</UBadge></div>
          <span v-if="room" class="channel-header-context">{{ tabs.find((item) => item.value === view.tab)?.label }}<span>·</span>{{ room.message_count }} 条记录</span>
          <div class="channel-header-actions">
            <form v-if="view.tab === 'discussion'" class="channel-search" @submit.prevent="act('filter', { query: search })">
              <UInput v-model="search" icon="i-lucide-search" variant="none" size="sm" placeholder="搜索消息" aria-label="搜索讨论记录" :disabled="!room" class="channel-search-input">
                <template #trailing><UButton v-if="search || view.query" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="清除搜索" @click="search = ''; act('filter', { query: '' })" /><UButton type="submit" icon="i-lucide-corner-down-left" color="neutral" variant="ghost" size="xs" aria-label="搜索" :disabled="!room" /></template>
              </UInput>
            </form>
            <UTooltip v-if="view.tab === 'discussion'" text="只看提到当前身份的消息"><UButton icon="i-lucide-at-sign" :variant="view.mention_only ? 'soft' : 'ghost'" color="neutral" size="sm" class="channel-icon-button channel-mention-filter" :aria-pressed="view.mention_only" aria-label="提到我" :disabled="!room" @click="act('filter', { mention: !view.mention_only })" /></UTooltip>
            <ProgressPanel v-if="room && !(show_rail && rail_inline)" />
          </div>
          <UTooltip :text="info_label"><UButton icon="i-lucide-panel-right" color="neutral" variant="ghost" size="sm" class="channel-icon-button channel-panel-toggle channel-info-button" :aria-label="info_label" :disabled="!room && !(rail_inline && view.tab === 'discussion')" :aria-expanded="rail_inline && view.tab === 'discussion' ? show_rail : info_open" @click="toggle_info" /></UTooltip>
        </header>
        <section v-if="view.launch.recoveries.length" class="channel-launch-recovery" aria-label="未完成的创建或启动请求">
          <h2>继续未完成的请求</h2>
          <article v-for="item in view.launch.recoveries" :key="item.id">
            <strong>{{ item.title }}</strong><p role="status">{{ item.error || '启动结果尚未确认；原请求已保存在此浏览器中。' }}</p>
            <div class="button-row"><UButton :label="item.direct ? '继续创建房间' : '继续本次启动'" size="sm" :loading="pending === 'resume_launch'" :disabled="Boolean(pending)" @click="act('resume_launch', item.id)" /><UButton v-if="item.room_id" label="查看原房间" color="neutral" variant="outline" size="sm" @click="act('room', item.room_id)" /><UButton label="移除待办" color="neutral" variant="ghost" size="sm" :disabled="Boolean(pending)" @click="act('discard_launch', item.id)" /></div>
          </article>
          <small>移除待办不会删除房间或停止讨论。</small>
        </section>
        <div v-if="room" class="channel-tabbar">
          <UTabs v-model="selected_tab" :items="tabs" :content="false" variant="pill" color="neutral" size="sm" class="channel-tabs" aria-label="频道视图" />
        </div>
        <section v-if="room && !free_room" class="channel-host-brief" :class="{ 'is-collapsed': brief_collapsed }" aria-label="主持简报">
          <div class="channel-brief-inner">
            <div class="channel-brief-heading">
              <button type="button" class="channel-brief-toggle" :aria-label="brief_collapsed ? '展开主持简报' : '收起主持简报'" :aria-expanded="!brief_collapsed" aria-controls="channel-brief-content" @click="toggle_brief"><UIcon :name="brief_collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><strong>主持简报{{ brief_collapsed ? '：' : '' }}</strong><span v-if="brief_collapsed" class="channel-brief-preview">{{ brief_preview }}</span></button>
              <template v-if="!brief_collapsed"><UButton label="更新简报" color="neutral" variant="link" size="xs" class="channel-brief-update" @click="act('tab', 'context')" /></template>
            </div>
            <div v-show="!brief_collapsed" id="channel-brief-content" class="channel-brief-content">
              <div class="channel-brief-text markdown-body" v-html="room.rendered_brief"></div>
              <div class="channel-brief-footer"><span class="channel-brief-status">{{ bridge.progress_speaker(room) }}</span><small>{{ bridge.brief_meta(room) }}</small></div>
            </div>
          </div>
        </section>
      </div>
      <div v-if="room" class="channel-body" :class="{ 'channel-body-discussion': view.tab === 'discussion' }">
        <div class="channel-content">
        <ChannelDiscussion v-show="view.tab === 'discussion'" @detail="open_detail" @edit="modal = 'edit'" />
        <section v-if="view.tab === 'context'" class="content-page channel-summary" role="tabpanel" aria-label="共识">
          <div class="page-heading"><div><h2>共识与分歧</h2><p>整理讨论进展，用 #消息编号 保留依据。</p></div><UBadge color="neutral" variant="outline">截止 #{{ room.state_until }}</UBadge></div>
          <section v-if="Array.isArray(room.latest_receipts) && room.latest_receipts.length" class="info-section"><h3>最新运行回执</h3><p class="fine-print">以下回执独立于摘要更新；晚于摘要的回执可能尚未整理，实际运行结果请查看原文。</p><div class="button-row"><UButton v-for="receipt in room.latest_receipts" :key="receipt.id" :label="`${bridge.display_name(receipt.author)} #${receipt.id} · ${new Date(receipt.created_at).toLocaleString('zh-CN')}${receipt.id > room.state_until ? ' · 晚于摘要' : ''}`" variant="link" color="neutral" @click="open_detail(receipt.id)" /></div></section>
          <form class="summary-form" @submit.prevent="act('save_context')">
            <UFormField label="主持简报" description="简述结论、共识、歧义，以及接下来要追问或调整什么、为什么。" class="channel-brief-editor"><UTextarea v-model="brief" aria-label="主持简报正文" :rows="4" class="w-full summary-brief-editor" placeholder="让返回房间的人快速理解讨论进展和主持意图。" /></UFormField>
            <UFormField label="详细共识与进度" description="已达成的共识、尚未解决的问题与下一步，用 #消息编号 标注依据。" class="channel-state-field"><UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="12" :maxlength="4000" class="summary-editor" placeholder="已达成的共识、尚未解决的问题与下一步…" /></UFormField>
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
      <section class="channel-rail-board"><div v-if="room && free_room" class="progress-board is-docked">
          <header class="pb-header"><strong>自由协作</strong><span class="pb-mode">{{ free_host ? `${bridge.display_name(free_host.name)} 协助主持` : '你来主持' }}</span></header>
          <section class="pb-section" aria-label="成员">
            <h4>成员</h4>
            <ul class="pb-members">
              <li v-for="member in room.free?.members || []" :key="member.id" class="pb-member">
                <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
                <div class="pb-member-body">
                  <div class="pb-member-name">{{ bridge.display_name(member.name) }}<UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /><small>{{ { manual: '手动接入', online: '在线只读' }[member.access] || '本机自动' }}</small></div>
                  <div class="pb-member-status" :class="`is-${free_member_tone(member)}`"><span class="pb-dot"></span>{{ free_member_status(member) }}</div>
                  <p v-if="member.session_mode === 'borrowed'" class="pb-member-model" title="它工作时请不要在原窗口继续操作">借用你正在使用的会话</p>
                </div>
                <UDropdownMenu :items="free_member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
              </li>
            </ul>
          </section>
          <section v-if="room.free?.conflicts?.length || room.free?.halted_chains?.length || view.free_error || view.free_notice || view.access?.error || view.access?.notice" class="pb-section" aria-label="提示">
            <h4>提示</h4>
            <p v-for="item in room.free?.conflicts || []" :key="item.executions.join('-')" class="pb-free-note is-warning">可能冲突：{{ item.members.map((name) => bridge.display_name(name)).join(' 与 ') }} 都改动了 {{ item.files.join('、') }}</p>
            <p v-for="item in (room.free?.halted_chains || []).slice(0, 3)" :key="item.chain_id" class="pb-free-note">#{{ item.chain_id }} 的任务链已停：{{ item.reason === 'budget' ? `达到 ${room.free.max_auto_hops} 次上限` : '派出的成员都失败了' }}；发新消息即重新开始</p>
            <p v-if="view.free_error" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
            <p v-else-if="view.free_notice" role="status" class="pb-free-note">{{ view.free_notice }}</p>
            <p v-if="view.access?.error" role="alert" class="pb-free-note is-error">{{ view.access.error }}</p>
            <p v-else-if="view.access?.notice" role="status" class="pb-free-note">{{ view.access.notice }}</p>
          </section>
          <section class="pb-section" aria-label="邀请">
            <h4>邀请 AI</h4>
            <form class="pb-free-invite" @submit.prevent="act('invite_member', { name: invite_name, access: invite_access })">
              <USelect v-model="invite_name" :items="invite_choices" placeholder="选择 AI" size="sm" class="min-w-0 flex-1" />
              <USelect v-model="invite_access" :items="[{ label: '本机自动', value: 'runner' }, { label: '手动接入', value: 'manual' }, { label: '在线只读', value: 'online' }]" size="sm" class="w-26" />
            </form>
            <p v-if="invite_access === 'runner' && !view.launch.available" class="pb-free-note">程序唤醒需要本机服务，请在运行 AI 的电脑打开本机网站。</p>
          </section>
          <section v-if="room.linked_rooms?.length" class="pb-section" aria-label="头脑风暴">
            <h4>头脑风暴</h4>
            <button v-for="item in room.linked_rooms" :key="item.id" type="button" class="pb-link pb-free-linked" @click="act('room', item.id)">{{ item.title }}<small>{{ bridge.phases[item.phase] || item.phase }}</small></button>
          </section>
          <section class="pb-actions" aria-label="操作">
            <UButton icon="i-lucide-user-plus" label="邀请" size="sm" color="neutral" variant="outline" class="pb-action" :disabled="!invite_name || (invite_access === 'runner' && !view.launch.available)" @click="act('invite_member', { name: invite_name, access: invite_access })" />
            <UButton icon="i-lucide-messages-square" label="发起头脑风暴" size="sm" color="neutral" variant="outline" class="pb-action" title="用当前成员新建一场讨论房间，收束后可把结论发回这里" @click="start_brainstorm" />
          </section>
        </div>
        <ProgressBoard v-else-if="room" docked /><div v-else class="progress-board is-docked"><header class="pb-header"><strong>讨论进度</strong></header><p class="channel-rail-empty">暂无频道，新建讨论后在这里查看进度与参与者。</p></div></section>
    </aside>

    <USlideover v-model:open="nav_open" side="left" title="讨论频道" description="共议 · AI CoDiscuss" :ui="{ content: 'channel-navigation-drawer', body: 'channel-drawer-body' }">
      <template #body>
        <ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" />
        <UButton block icon="i-lucide-settings-2" color="neutral" variant="ghost" label="外观设置" @click="nav_open = false; modal = 'settings'" />
      </template>
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
    <WorkspaceDialogs v-model="modal" v-model:reading-width="reading_width" v-model:effects="effects" :reading-options="width_options" :effect-options="EFFECT_OPTIONS" :detail-id="detail_id" :target-room="managed_room" :target-folder="target_folder" />
  </div>
</template>

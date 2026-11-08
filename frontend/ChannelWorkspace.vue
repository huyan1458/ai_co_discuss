<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChannelDiscussion from "./ChannelDiscussion.vue";
import TopicPanel from "./TopicPanel.vue";
import WorkspaceDialogs from "./WorkspaceDialogs.vue";
import ChannelSidebar from "./ChannelSidebar.vue";
import FreeBoard from "./FreeBoard.vue";
import DiscussionHistory from "./DiscussionHistory.vue";
import RoomOverview from "./RoomOverview.vue";
import ExecutionTimeline from "./ExecutionTimeline.vue";
import EventLog from "./EventLog.vue";
import ProjectFiles from "./ProjectFiles.vue";
import PrivateChat from "./PrivateChat.vue";
import FilePreview from "./FilePreview.vue";
import { busy } from "./member-actions.js";

const { view, bridge, field, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
const created_label = computed(() => {
  const date = new Date(room.value?.created_at || "");
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}年`;
  return `创建于 ${year}${date.getMonth() + 1}月${date.getDate()}日`;
});
// The 执行 channel shows the execution waterfall or the room event log.
const TIMELINE_VIEWS = [{ value: "waterfall", label: "瀑布" }, { value: "events", label: "事件" }];
const timeline_view = ref("waterfall");
const modal = ref("");
const managed_room = ref(null);
const target_folder = ref(null);
const detail_id = ref(null);
const nav_open = ref(false);
const info_open = ref(false);
const summary = field("state-input");
const brief = field("brief-input");
const search = field("search-input");
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
// Below the rail breakpoint the room sidebar opens as a drawer too, instead of squeezing the transcript.
const nav_docked = computed(() => rail_inline.value && !nav_collapsed.value);
// The rail and channel tools stay in place without a room so the layout never jumps; room-only controls are disabled.
const show_rail = computed(() => view.value.tab === "discussion" && !rail_collapsed.value);
const info_label = computed(() => rail_inline.value && view.value.tab === "discussion" ? (rail_collapsed.value ? "展开房间概览" : "收起房间概览") : "讨论进度");
const LIVE_EXECUTION = ["dispatched", "started"];
const STATUS_AVATARS = 4;
/** Who is working right now, for the title bar whenever the rail is out of sight; same rule as the rail's 处理中. */
const work_status = computed(() => {
  const working = (room.value?.free?.members || []).filter(busy);
  const state = (member) => member.execution?.stale ? "执行失联" : LIVE_EXECUTION.includes(member.execution?.status) ? "执行中" : "待投递";
  if (!working.length) return { tone: "success", text: "空闲", members: [], title: "空闲" };
  const tone = working.some((member) => member.execution?.stale) ? "error" : "primary";
  const text = working.length === 1 ? `${bridge.display_name(working[0].name)} ${state(working[0])}` : `${working.length} 位执行中`;
  return { tone, text, members: working.slice(0, STATUS_AVATARS), title: working.map((member) => `${bridge.display_name(member.name)} ${state(member)}`).join("\n") };
});
const show_work_status = computed(() => Boolean(room.value) && !room.value.archived && !(rail_inline.value && show_rail.value));
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
  "--channel-main-columns": !nav_docked.value ? "minmax(0, 1fr)" : `${effective_nav_width.value}px ${DIVIDER_WIDTH}px minmax(0, 1fr)`,
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
onMounted(() => { for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, close_drawer_on_touch); });
onBeforeUnmount(() => { for (const type of ["pointerup", "pointercancel"]) document.removeEventListener(type, close_drawer_on_touch); });
onMounted(() => {
  topbar_observer = new ResizeObserver(([entry]) => { if (brief_collapsed.value) topbar_height.value = Math.round(entry.target.offsetHeight); });
  topbar_observer.observe(topbar.value);
});
onBeforeUnmount(() => topbar_observer?.disconnect());
onBeforeUnmount(() => document.removeEventListener("pointerdown", collapse_brief_outside));
const selected_tab = computed({ get: () => view.value.tab, set: (value) => act("tab", value) });
const project_directory = computed(() => view.value.launch.room_models?.room_id === room.value?.id
  ? view.value.launch.room_models?.project_directory || "" : "");
// The main project directory first, then the room's other ones.
// Every publish rebuilds the list; keeping the previous array while its entries match spares ProjectFiles an update.
const project_directories = computed((previous) => {
  const next = project_directory.value ? [project_directory.value, ...(view.value.launch.room_models?.extra_directories || [])] : [];
  return previous?.length === next.length && next.every((directory, index) => Object.is(directory, previous[index])) ? previous : next;
});
/** Room tools keep their positions; files shows a hint until a project directory is saved. */
const tabs = computed(() => [
  { value: "discussion", label: "消息", icon: "i-lucide-hash" },
  { value: "timeline", label: "执行", icon: "i-lucide-chart-gantt" },
  { value: "private", label: "私聊", icon: "i-lucide-message-circle" },
  { value: "overview", label: "房间", icon: "i-lucide-sliders-horizontal" },
  { value: "files", label: "文件", icon: "i-lucide-files", title: project_directory.value || "" },
]);
// Retired pages: consensus and discussion history open from the host brief, access moved into the room page.
const MERGED_TABS = { context: "discussion", history: "discussion", access: "overview" };
const free_room = computed(() => !["active", "paused"].includes(room.value?.session?.status));
watch(() => MERGED_TABS[view.value.tab], (merged) => { if (merged) act("tab", merged); }, { immediate: true });
// A free room shows the brief bar only once it has something to read; starting a discussion stays on the rail.
const show_brief = computed(() => !!room.value && (!free_room.value || !!room.value.host_brief?.text || !!room.value.state_text || !!room.value.discussions?.length));
const consensus_open = ref(false);
const editing_context = ref(false);
const rendered_state = computed(() => room.value?.state_text ? bridge.render_room_markdown(room.value.state_text) : "");
watch(() => room.value?.id, () => { consensus_open.value = false; editing_context.value = false; });

/** Open consensus and discussion history from the brief, optionally straight into editing. */
function open_consensus(edit = false) { brief_collapsed.value = true; editing_context.value = edit; consensus_open.value = true; }

/** Leave the consensus dialog for another workspace dialog. */
function open_from_consensus(name) { consensus_open.value = false; modal.value = name; }

/** Show an original message above the consensus dialog's evidence links. */
function detail_from_consensus(id) { consensus_open.value = false; open_detail(id); }

/** Save the edited consensus and go back to reading it. */
async function save_consensus() {
  if (await act("save_context")) editing_context.value = false;
}

/** Open management for the exact sidebar item while leaving its draft untouched. */
function manage_room({ room, action }) { managed_room.value = room; nav_open.value = false; modal.value = action; }

/** Open archive management without selecting a channel or changing its draft. */
function open_archives() { nav_open.value = false; modal.value = "archives"; }

/** Switch the room view and close the mobile navigation. */
function choose_tab(value) { nav_open.value = false; act("tab", value); }

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

/** Confirm archiving every active room filed in one folder. */
function archive_folder(folder) { target_folder.value = folder; nav_open.value = false; modal.value = "archive-folder"; }

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

/** A touch on a drawer's overlay closes it, even when a slight slide stops the browser from firing the click the drawer waits for. */
function close_drawer_on_touch(event) {
  if (event.pointerType !== "touch" || !event.target.closest?.(".channel-drawer-overlay")) return;
  nav_open.value = false;
  info_open.value = false;
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
  <div class="channel-shell" :class="{ 'channel-resizing': rail_drag || nav_drag, 'channel-nav-collapsed': !nav_docked, 'channel-has-rail': show_rail }" :style="layout_style">
    <ChannelSidebar v-if="nav_docked" :tabs="tabs" @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archive-folder="archive_folder" @archives="open_archives" @tab="choose_tab" @settings="modal = 'settings'" />
    <div v-if="nav_docked" class="channel-nav-resizer" role="separator" tabindex="0" aria-label="调整房间栏宽度" aria-orientation="vertical" aria-controls="channel-sidebar" :aria-valuemin="NAV_MIN" :aria-valuemax="nav_max" :aria-valuenow="effective_nav_width" :aria-valuetext="`${effective_nav_width} 像素`" title="拖动调整房间栏宽度，也可使用方向键" @pointerdown="start_nav_resize" @pointermove="resize_nav" @pointerup="finish_nav_resize" @pointercancel="finish_nav_resize" @lostpointercapture="finish_nav_resize" @keydown="resize_nav_by_key"></div>

    <main class="channel-main">
      <div ref="topbar" class="channel-topbar" :class="{ 'is-overlay': room && view.tab === 'discussion' }">
        <header class="channel-header">
          <UTooltip v-if="rail_inline" :text="nav_collapsed ? '展开房间栏' : '收起房间栏'"><UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-desktop-nav channel-icon-button channel-panel-toggle" :aria-label="nav_collapsed ? '展开房间栏' : '收起房间栏'" :aria-expanded="!nav_collapsed" aria-controls="channel-sidebar" @click="nav_collapsed = !nav_collapsed" /></UTooltip>
          <UButton v-else icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-mobile-nav channel-icon-button channel-panel-toggle" aria-label="打开房间导航" :aria-expanded="nav_open" @click="nav_open = true" />
          <span class="channel-title-icon"><UIcon name="i-lucide-hash" /></span>
          <div class="channel-title"><div class="channel-title-copy"><h1 :title="room?.title">{{ room?.title || '共议' }}</h1></div><UBadge v-if="room?.archived" color="neutral" variant="subtle" size="sm">已存档</UBadge></div>
          <span v-if="room" class="channel-header-context">{{ tabs.find((item) => item.value === view.tab)?.label }}<span>·</span>{{ room.message_count }} 条记录<template v-if="created_label"><span>·</span><time :datetime="room.created_at" :title="new Date(room.created_at).toLocaleString('zh-CN', { hour12: false })">{{ created_label }}</time></template></span>
          <div class="channel-header-actions">
            <button v-if="show_work_status" type="button" class="channel-work-status" :class="`is-${work_status.tone}`" :title="work_status.title" :aria-label="`执行状态：${work_status.title.replaceAll('\n', '，')}；打开房间概览`" @click="toggle_info">
              <span v-if="work_status.members.length" class="channel-work-avatars"><UAvatar v-for="member in work_status.members" :key="member.id" :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="2xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" /></span>
              <span class="pb-dot"></span><span class="channel-work-text" role="status">{{ work_status.text }}</span>
            </button>
            <form v-if="view.tab === 'discussion'" class="channel-search" @submit.prevent="act('filter', { query: search })">
              <UInput v-model="search" icon="i-lucide-search" variant="none" size="sm" placeholder="搜索消息" aria-label="搜索讨论记录" :disabled="!room" class="channel-search-input">
                <template #trailing><UButton v-if="search || view.query" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="清除搜索" @click="search = ''; act('filter', { query: '' })" /><UButton type="submit" icon="i-lucide-corner-down-left" color="neutral" variant="ghost" size="xs" aria-label="搜索" :disabled="!room" /></template>
              </UInput>
            </form>
            <UTooltip v-if="view.tab === 'discussion'" text="只看主持：主持人的发言与主持说明（含讨论总结）"><UButton icon="i-lucide-crown" :variant="view.host_only ? 'soft' : 'ghost'" color="neutral" size="sm" class="channel-icon-button channel-host-filter" :aria-pressed="view.host_only" aria-label="只看主持" :disabled="!room" @click="act('filter', { host: !view.host_only })" /></UTooltip>
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
          <UTabs v-model="selected_tab" :items="tabs" :content="false" variant="pill" color="neutral" size="sm" class="channel-tabs" aria-label="房间视图" />
        </div>
        <section v-if="show_brief" class="channel-host-brief" :class="{ 'is-collapsed': brief_collapsed }" aria-label="主持简报">
          <div class="channel-brief-inner">
            <div class="channel-brief-heading">
              <button type="button" class="channel-brief-toggle" :aria-label="brief_collapsed ? '展开主持简报' : '收起主持简报'" :aria-expanded="!brief_collapsed" aria-controls="channel-brief-content" @click="toggle_brief"><UIcon :name="brief_collapsed ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" /><strong>主持简报{{ brief_collapsed ? '：' : '' }}</strong><span v-if="brief_collapsed" class="channel-brief-preview">{{ brief_preview }}</span></button>
              <template v-if="!brief_collapsed"><UButton label="详细共识与讨论记录" color="neutral" variant="link" size="xs" class="channel-brief-update" @click="open_consensus()" /><UButton label="编辑" color="neutral" variant="link" size="xs" class="channel-brief-update" @click="open_consensus(true)" /></template>
            </div>
            <div v-show="!brief_collapsed" id="channel-brief-content" class="channel-brief-content">
              <div class="channel-brief-text markdown-body" v-html="room.rendered_brief"></div>
              <div class="channel-brief-footer"><span v-if="!free_room" class="channel-brief-status">{{ bridge.progress_speaker(room) }}</span><small>{{ bridge.brief_meta(room) }}</small></div>
            </div>
          </div>
        </section>
      </div>
      <div v-if="room" class="channel-body" :class="{ 'channel-body-discussion': view.tab === 'discussion' }">
        <div class="channel-content">
        <ChannelDiscussion v-show="view.tab === 'discussion'" @detail="open_detail" @edit="modal = 'edit'" />
        <div v-if="view.tab === 'overview'" v-keep-reading class="content-page merged-page" role="tabpanel" aria-label="房间">
          <RoomOverview />
          <TopicPanel v-if="!free_room" section="access" @open="modal = $event" @detail="open_detail" />
        </div>
        <div v-if="view.tab === 'timeline'" v-keep-reading class="content-page merged-page" role="tabpanel" aria-label="执行">
          <div class="timeline-switch" role="group" aria-label="执行视图">
            <UButton v-for="option in TIMELINE_VIEWS" :key="option.value" :label="option.label" size="xs" color="neutral"
              :variant="timeline_view === option.value ? 'soft' : 'ghost'" :aria-pressed="timeline_view === option.value" @click="timeline_view = option.value" />
          </div>
          <ExecutionTimeline v-if="timeline_view === 'waterfall'" @detail="open_detail" />
          <EventLog v-else @detail="open_detail" />
        </div>
        <div v-if="view.tab === 'files'" v-keep-reading class="content-page" role="tabpanel" aria-label="文件">
          <ProjectFiles v-if="project_directory" :key="room.id" :directories="project_directories" />
          <p v-else class="channel-files-unset" role="status">当前未设置项目目录</p>
        </div>
        <div v-if="view.tab === 'private'" v-keep-reading class="content-page private-page">
          <PrivateChat :key="room.id" />
        </div>
        <FilePreview />
        </div>
      </div>
      <div v-else class="channel-empty"><UIcon name="i-lucide-hash" /><h2>新建一个协作房间</h2><p>邀请 AI 一起协作，随时 @ 提问；需要时开启讨论，保留所有人的观点。</p><UButton icon="i-lucide-plus" label="新建房间" color="neutral" @click="create_channel()" /></div>
    </main>
    <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-if="room" v-model:open="consensus_open" title="共识与讨论记录" description="主持人整理的结论、共识与分歧，以及每场讨论结束时的结论。" :ui="{ content: 'glass-panel studio-modal channel-consensus-modal', body: 'dialog-body' }">
      <template #body>
        <div class="merged-page channel-consensus-body">
          <TopicPanel v-if="!free_room" section="host" @open="open_from_consensus" @detail="detail_from_consensus" />
          <section class="merged-section channel-summary" aria-label="当前共识">
            <div class="page-heading"><div><h2>当前共识</h2><p>主持人整理的结论、共识与分歧，用 #消息编号 保留依据；讨论结束时保存进下方记录。</p></div><UButton v-if="!editing_context" icon="i-lucide-pencil" label="编辑" variant="outline" color="neutral" class="channel-surface-button" @click="editing_context = true" /></div>
            <form v-if="editing_context" class="summary-form" @submit.prevent="save_consensus">
              <UFormField label="主持简报" description="简述结论、共识、歧义，以及接下来要追问或调整什么、为什么。" class="channel-brief-editor"><UTextarea v-model="brief" aria-label="主持简报正文" :rows="4" class="w-full summary-brief-editor" placeholder="让返回房间的人快速理解讨论进展和主持意图。" /></UFormField>
              <UFormField label="详细共识与进度" description="已达成的共识、尚未解决的问题与下一步，用 #消息编号 标注依据。" class="channel-state-field"><UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="12" :maxlength="4000" class="summary-editor" placeholder="已达成的共识、尚未解决的问题与下一步…" /></UFormField>
              <div class="form-footer"><span>依据消息截止 #{{ view.snapshot_id }}</span><div class="button-row"><UButton label="取消" color="neutral" variant="ghost" @click="editing_context = false" /><UButton type="submit" color="neutral" icon="i-lucide-check" label="保存共识" class="channel-primary-button" :loading="pending === 'save_context'" /></div></div>
            </form>
            <template v-else-if="room.host_brief?.text || room.state_text">
              <div class="consensus-card is-brief"><h3>主持简报<button v-if="room.state_until" type="button" class="subtle-link" @click="detail_from_consensus(room.state_until)">整理至 #{{ room.state_until }}</button></h3><div class="markdown-body" v-html="room.rendered_brief"></div></div>
              <details v-if="rendered_state" class="consensus-card"><summary><h3>详细共识与进度</h3><span>依据、已处理内容、未决问题与下一步</span><UIcon name="i-lucide-chevron-down" class="disclosure-icon" /></summary><div class="markdown-body consensus-state" v-html="rendered_state"></div></details>
            </template>
            <p v-else class="fine-print">还没有共识。主持人会在讨论中整理，也可以点“编辑”自己写。</p>
          </section>
          <DiscussionHistory @detail="detail_from_consensus" />
        </div>
      </template>
    </UModal>
    <div v-if="show_rail" class="channel-rail-resizer" role="separator" tabindex="0" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-controls="channel-member-rail" :aria-valuemin="RAIL_MIN" :aria-valuemax="RAIL_MAX" :aria-valuenow="rail_width" :aria-valuetext="`${rail_width} 像素`" title="拖动调整右侧栏宽度，也可使用左右方向键" @pointerdown="start_rail_resize" @pointermove="resize_rail" @pointerup="finish_rail_resize" @pointercancel="finish_rail_resize" @lostpointercapture="finish_rail_resize" @keydown="resize_rail_by_key"></div>
    <aside v-if="show_rail" id="channel-member-rail" v-keep-reading class="channel-member-rail" aria-label="当前焦点与讨论进度">
      <section class="channel-rail-board"><FreeBoard v-if="room" />
        <div v-else class="progress-board is-docked"><header class="pb-header"><strong>讨论进度</strong></header><p class="channel-rail-empty">暂无房间，新建讨论后在这里查看进度与参与者。</p></div></section>
    </aside>

    <USlideover v-model:open="nav_open" side="left" title="房间导航" :ui="{ overlay: 'channel-drawer-overlay', content: 'channel-navigation-drawer' }">
      <template #content><ChannelSidebar :tabs="tabs" @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archive-folder="archive_folder" @archives="open_archives" @tab="choose_tab" @settings="nav_open = false; modal = 'settings'" /></template>
    </USlideover>
    <USlideover v-if="room" v-model:open="info_open" side="right" title="讨论进度" :description="room.title" :ui="{ overlay: 'channel-drawer-overlay', content: 'progress-drawer', body: 'progress-drawer-body' }">
      <template #body><FreeBoard /></template>
    </USlideover>
    <WorkspaceDialogs v-model="modal" v-model:reading-width="reading_width" v-model:effects="effects" :reading-options="width_options" :effect-options="EFFECT_OPTIONS" :detail-id="detail_id" :target-room="managed_room" :target-folder="target_folder" />
  </div>
</template>

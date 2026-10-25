<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from "vue";
import ChannelDiscussion from "./ChannelDiscussion.vue";
import TopicPanel from "./TopicPanel.vue";
import WorkspaceDialogs from "./WorkspaceDialogs.vue";
import ChannelDirectory from "./ChannelDirectory.vue";
import ProgressPanel from "./ProgressPanel.vue";
import ProgressBoard from "./ProgressBoard.vue";
import FreeBoard from "./FreeBoard.vue";

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
const info_label = computed(() => rail_inline.value && view.value.tab === "discussion" ? (rail_collapsed.value ? "展开房间概览" : "收起房间概览") : "房间资料与参与者");
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
watch(() => free_room.value && view.value.tab !== "discussion", (leave) => { if (leave) act("tab", "discussion"); }, { immediate: true });
const view_links = computed(() => tabs.value.map((item) => ({
  ...item, active: !!room.value && view.value.tab === item.value, disabled: !room.value, onSelect: () => { nav_open.value = false; act("tab", item.value); },
})));
/** The footer's second line: the account call to action until signed in, then the site connection. */
const account_status = computed(() => {
  const admin = view.value.admin;
  if (!admin?.loaded) return "";
  if (!admin.registered) return "设置管理员账号";
  return admin.logged_in ? "" : "未登录 · 点击登录";
});
const participants = computed(() => [
  { name: "用户", mode: "发起与协助" },
  ...Object.entries(room.value?.experts || {}).map(([name, mode]) => ({ name, mode: mode === "cli" ? "本地 AI · 自行发言" : "在线 AI · 由人代发" })),
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
    <aside id="channel-sidebar" class="channel-sidebar" aria-label="房间导航">
      <header class="channel-workspace-heading">
        <span class="channel-brand-icon" aria-hidden="true">
          <svg class="channel-brand-dark" viewBox="0 0 100 100"><defs><linearGradient id="brand-d0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#e9ebed"/><stop offset="6.3%" stop-color="#e2e5e7"/><stop offset="12.5%" stop-color="#dcdee1"/><stop offset="18.8%" stop-color="#d5d8db"/><stop offset="25.0%" stop-color="#ced2d5"/><stop offset="31.3%" stop-color="#c8cbcf"/><stop offset="37.5%" stop-color="#c1c5ca"/><stop offset="43.8%" stop-color="#babfc4"/><stop offset="50.0%" stop-color="#b4b9be"/><stop offset="56.3%" stop-color="#a9aeb3"/><stop offset="62.5%" stop-color="#9ea3a9"/><stop offset="68.8%" stop-color="#93999f"/><stop offset="75.0%" stop-color="#888e95"/><stop offset="81.3%" stop-color="#7e848a"/><stop offset="87.5%" stop-color="#737a80"/><stop offset="93.8%" stop-color="#697077"/><stop offset="100.0%" stop-color="#5f666d"/></linearGradient><linearGradient id="brand-d1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#3f86ff"/><stop offset="6.3%" stop-color="#5588ff"/><stop offset="12.5%" stop-color="#6889ff"/><stop offset="18.8%" stop-color="#788aff"/><stop offset="25.0%" stop-color="#878bff"/><stop offset="31.3%" stop-color="#958cff"/><stop offset="37.5%" stop-color="#a78aef"/><stop offset="43.8%" stop-color="#b986d7"/><stop offset="50.0%" stop-color="#ca80bf"/><stop offset="56.3%" stop-color="#da78a6"/><stop offset="62.5%" stop-color="#ea6e8c"/><stop offset="68.8%" stop-color="#f56d78"/><stop offset="75.0%" stop-color="#f77f72"/><stop offset="81.3%" stop-color="#f8906b"/><stop offset="87.5%" stop-color="#f9a163"/><stop offset="93.8%" stop-color="#fab058"/><stop offset="100.0%" stop-color="#fac04a"/></linearGradient><linearGradient id="brand-d2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#d06a49"/><stop offset="6.3%" stop-color="#d36f4f"/><stop offset="12.5%" stop-color="#d67456"/><stop offset="18.8%" stop-color="#d97a5c"/><stop offset="25.0%" stop-color="#dc7f62"/><stop offset="31.3%" stop-color="#df8468"/><stop offset="37.5%" stop-color="#e2896e"/><stop offset="43.8%" stop-color="#e58e74"/><stop offset="50.0%" stop-color="#e8937a"/><stop offset="56.3%" stop-color="#eb9d85"/><stop offset="62.5%" stop-color="#eea68f"/><stop offset="68.8%" stop-color="#f1b09a"/><stop offset="75.0%" stop-color="#f4baa4"/><stop offset="81.3%" stop-color="#f6c3af"/><stop offset="87.5%" stop-color="#f9cdb9"/><stop offset="93.8%" stop-color="#fbd6c4"/><stop offset="100.0%" stop-color="#fde0cf"/></linearGradient><linearGradient id="brand-d3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#4a5cff"/><stop offset="6.3%" stop-color="#5062ff"/><stop offset="12.5%" stop-color="#5768ff"/><stop offset="18.8%" stop-color="#5d6dff"/><stop offset="25.0%" stop-color="#6472ff"/><stop offset="31.3%" stop-color="#6b77ff"/><stop offset="37.5%" stop-color="#717cff"/><stop offset="43.8%" stop-color="#7881ff"/><stop offset="50.0%" stop-color="#7f86ff"/><stop offset="56.3%" stop-color="#8990ff"/><stop offset="62.5%" stop-color="#9399ff"/><stop offset="68.8%" stop-color="#9da2ff"/><stop offset="75.0%" stop-color="#a8abff"/><stop offset="81.3%" stop-color="#b3b4ff"/><stop offset="87.5%" stop-color="#bebdff"/><stop offset="93.8%" stop-color="#c9c5ff"/><stop offset="100.0%" stop-color="#d4ceff"/></linearGradient><clipPath id="brand-d4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-d5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-d6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-d7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-d8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-d9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-d10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-d11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-d4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/></g></svg>
          <svg class="channel-brand-light" viewBox="0 0 100 100"><defs><linearGradient id="brand-l0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#0b0d0f"/><stop offset="6.3%" stop-color="#101315"/><stop offset="12.5%" stop-color="#16191b"/><stop offset="18.8%" stop-color="#1c1f22"/><stop offset="25.0%" stop-color="#222529"/><stop offset="31.3%" stop-color="#282c2f"/><stop offset="37.5%" stop-color="#2e3237"/><stop offset="43.8%" stop-color="#34393e"/><stop offset="50.0%" stop-color="#3b4045"/><stop offset="56.3%" stop-color="#484d52"/><stop offset="62.5%" stop-color="#555a5f"/><stop offset="68.8%" stop-color="#62676d"/><stop offset="75.0%" stop-color="#70757b"/><stop offset="81.3%" stop-color="#7e8389"/><stop offset="87.5%" stop-color="#8c9297"/><stop offset="93.8%" stop-color="#9aa0a6"/><stop offset="100.0%" stop-color="#a9afb5"/></linearGradient><linearGradient id="brand-l1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#2f7bff"/><stop offset="6.3%" stop-color="#487cff"/><stop offset="12.5%" stop-color="#5a7cff"/><stop offset="18.8%" stop-color="#6a7dff"/><stop offset="25.0%" stop-color="#797dff"/><stop offset="31.3%" stop-color="#877dff"/><stop offset="37.5%" stop-color="#997cee"/><stop offset="43.8%" stop-color="#ae79d3"/><stop offset="50.0%" stop-color="#c174b8"/><stop offset="56.3%" stop-color="#d36b9d"/><stop offset="62.5%" stop-color="#e56080"/><stop offset="68.8%" stop-color="#f15d69"/><stop offset="75.0%" stop-color="#f37162"/><stop offset="81.3%" stop-color="#f5835a"/><stop offset="87.5%" stop-color="#f79550"/><stop offset="93.8%" stop-color="#f8a542"/><stop offset="100.0%" stop-color="#f8b52c"/></linearGradient><linearGradient id="brand-l2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#b9502f"/><stop offset="6.3%" stop-color="#bd5534"/><stop offset="12.5%" stop-color="#c15a39"/><stop offset="18.8%" stop-color="#c55f3e"/><stop offset="25.0%" stop-color="#c96443"/><stop offset="31.3%" stop-color="#cd6848"/><stop offset="37.5%" stop-color="#d16d4d"/><stop offset="43.8%" stop-color="#d57252"/><stop offset="50.0%" stop-color="#d97757"/><stop offset="56.3%" stop-color="#dd8060"/><stop offset="62.5%" stop-color="#e08a69"/><stop offset="68.8%" stop-color="#e49372"/><stop offset="75.0%" stop-color="#e79c7b"/><stop offset="81.3%" stop-color="#eaa584"/><stop offset="87.5%" stop-color="#edae8d"/><stop offset="93.8%" stop-color="#f0b796"/><stop offset="100.0%" stop-color="#f3c09f"/></linearGradient><linearGradient id="brand-l3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#2b33e6"/><stop offset="6.3%" stop-color="#3139e9"/><stop offset="12.5%" stop-color="#363fec"/><stop offset="18.8%" stop-color="#3c44ef"/><stop offset="25.0%" stop-color="#4249f3"/><stop offset="31.3%" stop-color="#484ef6"/><stop offset="37.5%" stop-color="#4e53f9"/><stop offset="43.8%" stop-color="#5457fc"/><stop offset="50.0%" stop-color="#5a5cff"/><stop offset="56.3%" stop-color="#6569ff"/><stop offset="62.5%" stop-color="#7075ff"/><stop offset="68.8%" stop-color="#7c80ff"/><stop offset="75.0%" stop-color="#888bff"/><stop offset="81.3%" stop-color="#9595ff"/><stop offset="87.5%" stop-color="#a29fff"/><stop offset="93.8%" stop-color="#afa9ff"/><stop offset="100.0%" stop-color="#bdb3ff"/></linearGradient><clipPath id="brand-l4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-l5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-l6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-l7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-l8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-l9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-l10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-l11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-l4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/></g></svg>
        </span>
        <span class="channel-brand-text"><strong>共议</strong><span>AI CoDiscuss</span></span>
      </header>
      <div class="channel-sidebar-content">
        <ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" />
        <div class="channel-directory-heading channel-tools-heading"><button type="button" class="channel-section-toggle" :aria-expanded="tools_open" @click="tools_open = !tools_open"><UIcon :name="tools_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />频道工具</button></div>
        <UNavigationMenu v-if="tools_open" :items="view_links" orientation="vertical" color="neutral" variant="pill" class="channel-directory channel-view-links" aria-label="房间视图" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkLeadingIcon: 'channel-link-icon' }" />
      </div>
      <footer class="channel-sidebar-footer">
        <button type="button" class="channel-self-button" :aria-label="`账号与设置：${bridge.display_name(author)}${account_status ? '，' + account_status : ''}`" @click="modal = 'settings'">
          <UAvatar :src="bridge.identities[author]?.icon" :text="bridge.identities[author]?.initials" :alt="bridge.display_name(author)" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
          <span class="channel-self"><strong>{{ bridge.display_name(author) }}</strong><span class="channel-connection" :class="{ 'is-action': account_status }"><span :class="{ connected: view.connected }" :title="view.connected ? '网站已连接' : '网站未连接'"></span>{{ account_status || (view.connected ? '网站已连接' : '网站未连接') }}</span></span>
        </button>
        <UTooltip text="设置"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="设置" @click="modal = 'settings'" /></UTooltip>
      </footer>
    </aside>
    <div v-if="!nav_collapsed" class="channel-nav-resizer" role="separator" tabindex="0" aria-label="调整房间栏宽度" aria-orientation="vertical" aria-controls="channel-sidebar" :aria-valuemin="NAV_MIN" :aria-valuemax="nav_max" :aria-valuenow="effective_nav_width" :aria-valuetext="`${effective_nav_width} 像素`" title="拖动调整房间栏宽度，也可使用方向键" @pointerdown="start_nav_resize" @pointermove="resize_nav" @pointerup="finish_nav_resize" @pointercancel="finish_nav_resize" @lostpointercapture="finish_nav_resize" @keydown="resize_nav_by_key"></div>

    <main class="channel-main">
      <div ref="topbar" class="channel-topbar" :class="{ 'is-overlay': room && view.tab === 'discussion' }">
        <header class="channel-header">
          <UTooltip :text="nav_collapsed ? '展开房间栏' : '收起房间栏'"><UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-desktop-nav channel-icon-button channel-panel-toggle" :aria-label="nav_collapsed ? '展开房间栏' : '收起房间栏'" :aria-expanded="!nav_collapsed" aria-controls="channel-sidebar" @click="nav_collapsed = !nav_collapsed" /></UTooltip>
          <UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-mobile-nav channel-icon-button channel-panel-toggle" aria-label="打开房间导航" :aria-expanded="nav_open" @click="nav_open = true" />
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
          <UTabs v-model="selected_tab" :items="tabs" :content="false" variant="pill" color="neutral" size="sm" class="channel-tabs" aria-label="房间视图" />
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
          
          <form class="summary-form" @submit.prevent="act('save_context')">
            <UFormField label="主持简报" description="简述结论、共识、歧义，以及接下来要追问或调整什么、为什么。" class="channel-brief-editor"><UTextarea v-model="brief" aria-label="主持简报正文" :rows="4" class="w-full summary-brief-editor" placeholder="让返回房间的人快速理解讨论进展和主持意图。" /></UFormField>
            <UFormField label="详细共识与进度" description="已达成的共识、尚未解决的问题与下一步，用 #消息编号 标注依据。" class="channel-state-field"><UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="12" :maxlength="4000" class="summary-editor" placeholder="已达成的共识、尚未解决的问题与下一步…" /></UFormField>
            <div class="form-footer"><span>依据消息截止 #{{ view.snapshot_id }}</span><UButton type="submit" color="neutral" icon="i-lucide-check" label="保存共识" class="channel-primary-button" :loading="pending === 'save_context'" /></div>
          </form>
        </section>
        <TopicPanel v-if="view.tab === 'topic' || view.tab === 'access'" :key="view.tab" @open="modal = $event" @detail="open_detail" />
        </div>
      </div>
      <div v-else class="channel-empty"><UIcon name="i-lucide-hash" /><h2>新建一个协作房间</h2><p>邀请 AI 一起协作，随时 @ 提问；需要时开启讨论，保留所有人的观点。</p><UButton icon="i-lucide-plus" label="新建房间" color="neutral" @click="create_channel()" /></div>
    </main>
    <div v-if="show_rail" class="channel-rail-resizer" role="separator" tabindex="0" aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-controls="channel-member-rail" :aria-valuemin="RAIL_MIN" :aria-valuemax="RAIL_MAX" :aria-valuenow="rail_width" :aria-valuetext="`${rail_width} 像素`" title="拖动调整右侧栏宽度，也可使用左右方向键" @pointerdown="start_rail_resize" @pointermove="resize_rail" @pointerup="finish_rail_resize" @pointercancel="finish_rail_resize" @lostpointercapture="finish_rail_resize" @keydown="resize_rail_by_key"></div>
    <aside v-if="show_rail" id="channel-member-rail" class="channel-member-rail" aria-label="当前焦点与讨论进度">
      <section class="channel-rail-board"><FreeBoard v-if="room && free_room" />
        <ProgressBoard v-else-if="room" docked /><div v-else class="progress-board is-docked"><header class="pb-header"><strong>讨论进度</strong></header><p class="channel-rail-empty">暂无房间，新建讨论后在这里查看进度与参与者。</p></div></section>
    </aside>

    <USlideover v-model:open="nav_open" side="left" title="协作房间" description="共议 · AI CoDiscuss" :ui="{ content: 'channel-navigation-drawer', body: 'channel-drawer-body' }">
      <template #body>
        <ChannelDirectory @select="choose_room" @manage="manage_room" @create="create_channel" @create-folder="create_folder" @manage-folder="edit_folder" @delete-folder="remove_folder" @archives="open_archives" />
        <UButton block icon="i-lucide-settings-2" color="neutral" variant="ghost" label="设置" @click="nav_open = false; modal = 'settings'" />
      </template>
    </USlideover>
    <USlideover v-model:open="info_open" title="房间资料" description="目标、背景与参与方式" :ui="{ content: 'channel-details', body: 'space-y-6' }">
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

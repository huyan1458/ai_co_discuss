<script setup>
/**
 * The 工作流 page, shown in the middle in place of the room: the workflow chosen in the sidebar's 工作流 list as an
 * infinite canvas, edited in place (cards, arrows), and its SKILL.md docked on the right, the text the host dispatches by.
 * 保存 writes it all at once. The list, new, import, rename, disable and delete live in the sidebar (`workflow-library.js`).
 * Works with or without a room open; enabling a workflow in a room stays with the message box's "/" and the side panel.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import { use_workflow_library } from "./workflow-library.js";

const library = use_workflow_library();
const { available, workflows, draft, saved_id, canvas_key, commands_allowed, busy, dirty, add_items, skill_request } = library;
// The SKILL.md panel's width, dragged at its left edge and remembered in this browser, and whether the panel is open
// (it is unless the user folded it away).
const SKILL_WIDTH = { min: 280, max: 760, initial: 340, step: 16, key: "codiscuss.workflow_skill_width" };
const SKILL_OPEN_KEY = "codiscuss.workflow_skill_open";
const skill_width = ref(stored_width(SKILL_WIDTH));
const skill_open = ref(remembered(SKILL_OPEN_KEY) !== "0");
// A phone, and a tablet held upright, show one of the canvas and SKILL.md at a time ("画布" first, then "工作流" for
// SKILL.md, as the user ordered them). (A tablet lays the site out 1440px wide, so width alone cannot tell an upright tablet.)
const STACKED_QUERY = "(max-width: 760px), (pointer: coarse) and (orientation: portrait)";
const stacked_media = window.matchMedia(STACKED_QUERY);
const stacked = ref(stacked_media.matches), pane = ref("canvas");
const follow_stacked = (event) => { stacked.value = event.matches; };
stacked_media.addEventListener("change", follow_stacked);
onBeforeUnmount(() => stacked_media.removeEventListener("change", follow_stacked));
const canvas = ref(null);
// The canvas was laid out hidden; place its view once it shows.
watch(pane, (value) => { if (value === "canvas") nextTick(() => requestAnimationFrame(() => canvas.value?.fit())); });
watch(skill_request, () => show_skill_text());
const show_skill = computed(() => Boolean(draft.value) && (stacked.value ? pane.value === "skill" : skill_open.value));
const broken = computed(() => workflows.value.find((item) => item.id === saved_id.value)?.error || "");

/** Show SKILL.md: the panel on a wide page, the 工作流 pane when stacked. */
function show_skill_text() {
  if (stacked.value) pane.value = "skill";
  else set_skill_open(true);
}

/** Ctrl+S (⌘S) saves the open workflow while this page is shown. */
function save_key(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || !draft.value) return;
  event.preventDefault();
  if (dirty.value && !busy.value) library.save();
}
onMounted(() => window.addEventListener("keydown", save_key));
onBeforeUnmount(() => window.removeEventListener("keydown", save_key));

/** A value this browser remembers, or null (storage may be blocked). */
function remembered(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function remember(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: it lasts this visit */ }
}

/** A remembered width within its bounds. */
function stored_width(bounds) {
  return Math.min(bounds.max, Math.max(bounds.min, Number(remembered(bounds.key)) || bounds.initial));
}

/** Set the panel's width. */
function set_width(value) {
  const width = Math.round(Math.min(SKILL_WIDTH.max, Math.max(SKILL_WIDTH.min, value)));
  skill_width.value = width;
  remember(SKILL_WIDTH.key, String(width));
}

/** Open or fold away the SKILL.md panel, remembered in this browser. */
function set_skill_open(open) {
  skill_open.value = open;
  remember(SKILL_OPEN_KEY, open ? "1" : "0");
}

/** Drag the panel's left edge to resize it; it grows leftwards. */
function start_resize(event) {
  const start = event.clientX, width = skill_width.value, handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const move = (moved) => set_width(width - (moved.clientX - start));
  const end = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", end); handle.removeEventListener("pointercancel", end); };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}
</script>

<template>
  <section class="workflow-library" :class="{ 'has-skill': show_skill, 'is-stacked': stacked }" aria-label="工作流"
    :style="{ '--workflow-skill-width': `${skill_width}px` }">
    <div v-if="stacked && draft" class="workflow-tabs-view" role="tablist" aria-label="画布或工作流说明">
      <button type="button" role="tab" :aria-selected="pane === 'canvas'" title="画布：成员卡片与示意连线" @click="pane = 'canvas'"><UIcon name="i-lucide-network" class="workflow-library-icon" />画布</button>
      <button type="button" role="tab" :aria-selected="pane === 'skill'" title="工作流：主持人照着派活的 SKILL.md" @click="pane = 'skill'"><UIcon name="i-lucide-file-text" class="workflow-library-icon" />工作流</button>
      <i v-if="dirty" class="workflow-library-dirty" title="有未保存的修改" />
    </div>
    <div v-show="!stacked || pane === 'canvas' || !draft" class="workflow-library-stage">
      <WorkflowCanvas v-if="draft" ref="canvas" :key="canvas_key" v-model:flow="draft.flow" v-model:agents="draft.agents" :compact="stacked" @open-skill="show_skill_text">
        <template #actions>
          <input v-if="!stacked" v-model="draft.label" class="workflow-library-name" :maxlength="32" placeholder="未命名工作流" aria-label="工作流名称" title="点击改名"
            :style="{ width: `calc(${Math.max(5, Math.min(16, (draft.label || '').length + 1))}em + 18px)` }" @keydown.enter="$event.target.blur()" />
          <i v-if="dirty && !stacked" class="workflow-library-dirty" title="有未保存的修改（Ctrl+S 保存）" />
          <UTooltip v-if="!skill_open && !stacked" text="展开 SKILL.md：主持人照它派活"><UButton icon="i-lucide-panel-right-open" label="SKILL.md" size="sm" color="neutral" variant="ghost" @click="set_skill_open(true)" /></UTooltip>
          <UTooltip text="保存（Ctrl+S）"><UButton icon="i-lucide-save" :label="stacked ? undefined : '保存'" aria-label="保存" size="sm" class="channel-primary-button" :disabled="!dirty" :loading="busy" @click="library.save()" /></UTooltip>
        </template>
      </WorkflowCanvas>
      <div v-else class="workflow-library-empty">
        <template v-if="!available"><UIcon name="i-lucide-monitor-off" /><p>连接本机服务后管理工作流</p></template>
        <template v-else-if="broken"><UIcon name="i-lucide-triangle-alert" /><p>{{ broken }}</p></template>
        <template v-else-if="busy"><UIcon name="i-lucide-loader-circle" class="animate-spin" /></template>
        <template v-else>
          <UIcon name="i-lucide-workflow" />
          <UDropdownMenu :items="add_items" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-plus" label="新建工作流" color="neutral" variant="soft" /></UDropdownMenu>
        </template>
      </div>
    </div>
    <template v-if="show_skill">
      <div v-if="!stacked" class="workflow-library-resize" role="separator" aria-orientation="vertical" aria-label="调整 SKILL.md 面板宽度" tabindex="0" title="拖动调整宽度，双击还原"
        :aria-valuenow="skill_width" :aria-valuemin="SKILL_WIDTH.min" :aria-valuemax="SKILL_WIDTH.max" @pointerdown.prevent="start_resize"
        @dblclick="set_width(SKILL_WIDTH.initial)" @keydown.left.prevent="set_width(skill_width + SKILL_WIDTH.step)"
        @keydown.right.prevent="set_width(skill_width - SKILL_WIDTH.step)" />
      <WorkflowEditor :key="canvas_key" v-model:workflow="draft" v-model:commands-allowed="commands_allowed" :saved="Boolean(saved_id)"
        :compact="stacked" @collapse="set_skill_open(false)" />
    </template>
  </section>
</template>

<style scoped>
.workflow-library { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); height: 100%; min-height: 0; }
.workflow-library.has-skill { grid-template-columns: minmax(0, 1fr) var(--workflow-skill-width, 340px); }
.workflow-library-resize { position: absolute; top: 0; bottom: 0; right: calc(var(--workflow-skill-width, 340px) - 3px); z-index: 7; width: 6px; cursor: col-resize; touch-action: none; }
/* Touch: a wider grip for the edge (a tablet shows the desktop layout scaled down). */
@media (pointer: coarse) { .workflow-library-resize { width: 20px; margin-right: -7px; } }
.workflow-library-resize:hover, .workflow-library-resize:focus-visible { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 45%, transparent); outline: none; }
.workflow-library-icon { flex-shrink: 0; width: 15px; height: 15px; }
.workflow-library-stage { position: relative; min-width: 0; min-height: 0; }
.workflow-library-empty { display: grid; place-content: center; justify-items: center; gap: 12px; height: 100%; color: var(--ui-text-muted); font-size: 13px; }
.workflow-library-empty > span:first-child { width: 36px; height: 36px; color: var(--ui-text-dimmed); }
.workflow-library-empty p { margin: 0; }
.workflow-library-name { min-width: 0; height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: var(--ui-text-highlighted);
  font-size: 13px; font-weight: 600; outline: none; }
.workflow-library-name:hover { border-color: var(--ui-border-muted); }
.workflow-library-name:focus { border-color: var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); }
.workflow-library-dirty { flex-shrink: 0; width: 7px; height: 7px; margin-right: 4px; border-radius: 50%; background: var(--ui-warning, #e0a33a); }
/* Stacked (phone, upright tablet): a "画布 | 工作流" switch on top; the rest is the canvas or SKILL.md. */
.workflow-library.is-stacked, .workflow-library.is-stacked.has-skill { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.workflow-library.is-stacked :deep(.workflow-skill) { min-height: 0; border-left: 0; }
.workflow-tabs-view { display: flex; align-items: center; gap: 2px; height: 38px; padding: 0 8px; border-bottom: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); }
.workflow-tabs-view button { display: flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 7px; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; }
.workflow-tabs-view button[aria-selected="true"] { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-tabs-view .workflow-library-dirty { margin-left: auto; }
</style>

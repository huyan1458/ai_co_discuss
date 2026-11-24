<script setup>
/**
 * The 工作流 page, shown in the middle in place of the room: the workflow chosen in the sidebar's 工作流 list as an
 * infinite canvas, edited in place (cards, arrows), and its SKILL.md docked on the right, the text the host dispatches by.
 * 保存 writes it all at once. The list, new, import, rename, disable and delete live in the sidebar (`workflow-library.js`).
 * Works with or without a room open; enabling a workflow in a room stays with the message box's "/" and the side panel.
 * A workflow may hold sub-workflows: the list under the toolbar switches the canvas and SKILL.md to one of them.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import WorkflowCanvas from "./WorkflowCanvas.vue";
import WorkflowEditor from "./WorkflowEditor.vue";
import WorkflowParts from "./WorkflowParts.vue";
import WorkflowExperts from "./WorkflowExperts.vue";
import { use_workflow_library, workflow_key } from "./workflow-library.js";
import { t } from "./i18n.js";

const library = use_workflow_library();
const {
  available, workflows, writable_roots, draft, saved_id, saved_key,
  active_scope, active_project_id, active_project_name, draft_readonly,
  canvas_key, commands_allowed, busy, loading, failure, dirty, add_items, skill_request,
  skill_open, set_skill_open, stacked, scope, current, reserved, subs, conflict,
} = library;
// The SKILL.md panel's width, dragged at its left edge and remembered in this browser; its open state lives in
// workflow-library.js so the top header bar and this page share the same toggle.
const SKILL_WIDTH = { min: 280, max: 760, initial: 340, step: 16, key: "codiscuss.workflow_skill_width" };
const skill_width = ref(stored_width(SKILL_WIDTH));
// A phone, and a tablet held upright, show one of the canvas and SKILL.md at a time ("画布" first, then "工作流" for
// SKILL.md, as the user ordered them). (A tablet lays the site out 1440px wide, so width alone cannot tell an upright tablet.)
const pane = ref("canvas");
const canvas = ref(null);
// 专家配置: one table for every card's software, model, strength and access; marked when a card's software is not set up here.
const { view } = inject("discussion");
const experts_open = ref(false);
// The card the panel opens at: the one whose settings key (or double click) opened it; the toolbar opens at the first.
const experts_focus = ref("");
const experts_missing = computed(() => {
  const ready = view.value.launch.card_platforms || [];
  const cards = draft.value ? [draft.value, ...subs.value].flatMap((part) => part.agents) : [];
  return ready.length > 0 && cards.some((agent) => !ready.includes(agent.name.slice(0, agent.name.length - agent.card.length - 1)));
});
// Target scope menu for an unsaved draft when the open room has writable project directories.
const target_scope_items = computed(() => [[
  ...writable_roots.value.map((root) => ({
    label: t("项目 · {name}", { name: root.name }),
    icon: "i-lucide-folder",
    trailingIcon: active_scope.value === "project" && active_project_id.value === root.id ? "i-lucide-check" : undefined,
    onSelect: () => library.set_draft_target("project", root.id),
  })),
  {
    label: t("全局"),
    icon: "i-lucide-globe",
    trailingIcon: active_scope.value === "global" ? "i-lucide-check" : undefined,
    onSelect: () => library.set_draft_target("global"),
  },
]]);
const scope_badge_label = computed(() => active_scope.value === "project"
  ? (active_project_name.value ? t("项目 · {name}", { name: active_project_name.value }) : t("项目"))
  : t("全局"));

// The canvas was laid out hidden; place its view once it shows.
watch(pane, (value) => { if (value === "canvas") nextTick(() => requestAnimationFrame(() => canvas.value?.fit())); });
watch(skill_request, () => show_skill_text());
const show_skill = computed(() => Boolean(draft.value || loading.value) && (stacked.value ? pane.value === "skill" : skill_open.value));
const broken = computed(() => workflows.value.find((item) => workflow_key(item) === saved_key.value)?.error || "");
// While a saved workflow is fetched (slow through the relay), an empty, inert canvas with its controls shows at once.
const placeholder = ref({ flow: null, agents: [] });

/** Show SKILL.md: the panel on a wide page, the 工作流 pane when stacked. */
function show_skill_text() {
  if (stacked.value) pane.value = "skill";
  else set_skill_open(true);
}

/** Copy the currently open read-only project workflow into global so the user can edit it. */
function copy_readonly_to_global() {
  if (!saved_id.value) return;
  library.copy_workflow({
    id: saved_id.value,
    label: draft.value?.label || saved_id.value,
    scope: active_scope.value,
    project_id: active_project_id.value,
  }, "global");
}

/** Ctrl+S (⌘S) saves the open workflow while this page is shown. */
function save_key(event) {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s" || !draft.value) return;
  event.preventDefault();
  if (dirty.value && !busy.value && !draft_readonly.value) library.save();
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
  <section class="workflow-library" :class="{ 'has-skill': show_skill, 'is-stacked': stacked }" :aria-label="t('工作流')"
    :style="{ '--workflow-skill-width': `${skill_width}px` }">
    <div v-if="stacked && (draft || loading)" class="workflow-tabs-view"><div class="workflow-tabs-segment" role="tablist" :aria-label="t('画布或工作流说明')">
      <button type="button" role="tab" :aria-selected="pane === 'canvas'" :title="t('画布：成员卡片与示意连线')" @click="pane = 'canvas'"><UIcon name="i-lucide-network" class="workflow-library-icon" />{{ t('画布') }}</button>
      <button type="button" role="tab" :aria-selected="pane === 'skill'" :title="t('工作流：主持人照着派活的 SKILL.md')" @click="pane = 'skill'"><UIcon :name="scope ? 'i-lucide-git-branch' : 'i-lucide-file-text'" class="workflow-library-icon" />{{ scope ? t('子工作流') : t('工作流') }}</button>
    </div></div>
    <div v-show="!stacked || pane === 'canvas' || (!draft && !loading)" class="workflow-library-stage">
      <WorkflowCanvas v-if="draft" ref="canvas" :key="canvas_key" v-model:flow="current.flow" v-model:agents="current.agents" :reserved="reserved" :compact="stacked"
        :shared="scope ? draft.agents : null" :subs="scope ? null : subs" :readonly="draft_readonly"
        @update:shared="(value) => { draft.agents = value; }" @open-sub="library.enter_sub" @open-skill="show_skill_text" @configure="(card) => { experts_focus = card; experts_open = true; }">
        <template #actions="{ iconsOnly, arrange }">
          <!-- Unsaved drafts in a project room can switch target scope; saved workflows display their scope badge. -->
          <UDropdownMenu v-if="!saved_id && writable_roots.length" :items="target_scope_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
            <UButton :icon="active_scope === 'project' ? 'i-lucide-folder' : 'i-lucide-globe'" trailing-icon="i-lucide-chevron-down" :label="iconsOnly ? undefined : scope_badge_label" :aria-label="t('保存归属：{scope}', { scope: scope_badge_label })" :title="t('选择保存位置：当前项目或全局')" :size="stacked ? 'xs' : 'sm'" color="neutral" variant="soft" class="workflow-scope-picker" />
          </UDropdownMenu>
          <span v-else-if="!stacked || draft_readonly" class="workflow-scope-badges">
            <span v-if="!stacked" class="workflow-scope-badge" :class="active_scope === 'project' ? 'is-project' : 'is-global'" :title="active_scope === 'project' ? t('项目工作流：{name}', { name: active_project_name || t('当前项目') }) : t('全局工作流：所有房间可用')">
              <UIcon :name="active_scope === 'project' ? 'i-lucide-folder' : 'i-lucide-globe'" />
              <span>{{ scope_badge_label }}</span>
            </span>
            <span v-if="draft_readonly" class="workflow-scope-badge is-readonly" :title="t('只读项目目录，不可修改')">
              <UIcon name="i-lucide-lock" />
              <span>{{ t('只读') }}</span>
            </span>
          </span>
          <UTooltip v-if="!draft_readonly" :text="experts_missing ? t('专家配置：有卡片的软件本机未配置') : t('专家配置：每张卡片的软件、模型、强度与项目权限')"><span class="workflow-library-save">
            <UButton :icon="experts_missing ? 'i-lucide-triangle-alert' : 'i-lucide-sliders-horizontal'" :label="iconsOnly ? undefined : t('专家配置')" :aria-label="t('专家配置')" :size="stacked ? 'xs' : 'sm'" :color="experts_missing ? 'warning' : 'neutral'" variant="ghost" @click="experts_focus = ''; experts_open = true" /></span></UTooltip>
          <UTooltip v-if="arrange" :text="t('自动整理')"><UButton icon="i-lucide-wand-sparkles" size="xs" color="neutral" variant="ghost" :aria-label="t('自动整理')" @click="arrange" /></UTooltip>
          <UTooltip :text="draft_readonly ? t('只读项目目录中的工作流不能修改') : dirty ? t('保存（Ctrl+S）：有未保存的修改') : t('没有未保存的修改')"><span class="workflow-library-save">
            <!-- Unsaved changes show on the button itself: worded and filled, even where the toolbar is icons only. -->
            <UButton icon="i-lucide-save" :label="iconsOnly && !dirty ? undefined : t('保存')" :aria-label="t('保存')" :size="stacked ? 'xs' : 'sm'" :class="{ 'channel-primary-button': !stacked || dirty }" :color="stacked && !dirty ? 'primary' : undefined" :variant="stacked && !dirty ? 'ghost' : undefined" :disabled="!dirty || draft_readonly" :loading="busy" @click="library.save()" />
            <i v-if="dirty && !draft_readonly" class="workflow-library-dirty" /></span></UTooltip>
        </template>
      </WorkflowCanvas>
      <!-- Read-only project workflow notice with one-click copy to global. -->
      <div v-if="draft && draft_readonly && !conflict" class="workflow-library-conflict is-readonly" role="status">
        <UIcon name="i-lucide-lock" />
        <span>{{ t('来自只读项目目录，不能直接修改；可复制到全局工作流后编辑') }}</span>
        <UButton :label="t('复制到全局')" icon="i-lucide-copy" size="xs" color="neutral" variant="soft" @click="copy_readonly_to_global" />
      </div>
      <!-- The library holds a newer version than this page, or the ID is taken: saving would replace it, so the user chooses. -->
      <div v-if="draft && conflict" class="workflow-library-conflict" role="alert">
        <UIcon name="i-lucide-triangle-alert" />
        <span>{{ conflict === 'exists' ? t('工作流库里已有同 ID 的工作流，保存会整份覆盖它') : t('工作流已被修改，请重新载入') }}</span>
        <UButton v-if="conflict === 'exists'" :label="t('覆盖保存')" size="xs" color="error" variant="soft" :loading="busy" @click="library.save({ overwrite: true })" />
        <UButton v-else :label="t('重新载入')" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="soft" @click="library.reload()" />
      </div>
      <WorkflowParts v-if="draft" :compact="stacked" :readonly="draft_readonly" @place="(id) => canvas?.show_sub_node(id)" />
      <template v-if="draft">
        <WorkflowExperts v-if="!draft_readonly" v-model:open="experts_open" v-model:focus="experts_focus" />
      </template>
      <template v-else-if="loading">
        <WorkflowCanvas v-model:flow="placeholder.flow" v-model:agents="placeholder.agents" :compact="stacked" class="workflow-library-placeholder" inert />
        <div class="workflow-library-loading" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" /><span>{{ loading }}</span></div>
      </template>
      <div v-else class="workflow-library-empty">
        <template v-if="!available"><UIcon name="i-lucide-monitor-off" /><p>{{ t('连接本机服务后管理工作流') }}</p></template>
        <template v-else-if="broken"><UIcon name="i-lucide-triangle-alert" /><p>{{ broken }}</p></template>
        <template v-else-if="failure"><UIcon name="i-lucide-triangle-alert" /><p>{{ failure }}</p><UButton :label="t('重试')" icon="i-lucide-refresh-cw" color="neutral" variant="soft" @click="library.retry()" /></template>
        <template v-else>
          <UIcon name="i-lucide-network" />
          <UDropdownMenu :items="add_items" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-plus" :label="t('新建工作流')" color="neutral" variant="soft" /></UDropdownMenu>
        </template>
      </div>
    </div>
    <template v-if="show_skill">
      <div v-if="!stacked" class="workflow-library-resize" role="separator" aria-orientation="vertical" :aria-label="t('调整 SKILL.md 面板宽度')" tabindex="0" :title="t('拖动调整宽度，双击还原')"
        :aria-valuenow="skill_width" :aria-valuemin="SKILL_WIDTH.min" :aria-valuemax="SKILL_WIDTH.max" @pointerdown.prevent="start_resize"
        @dblclick="set_width(SKILL_WIDTH.initial)" @keydown.left.prevent="set_width(skill_width + SKILL_WIDTH.step)"
        @keydown.right.prevent="set_width(skill_width - SKILL_WIDTH.step)" />
      <div v-if="loading" id="workflow-skill-panel" class="workflow-skill-loading" role="status" :aria-label="loading"><USkeleton class="h-6 w-36" /><USkeleton v-for="line in 8" :key="line" class="h-4" :class="line % 3 ? 'w-full' : 'w-2/3'" /></div>
      <WorkflowEditor v-else id="workflow-skill-panel" :key="canvas_key" :workflow="current" v-model:commands-allowed="commands_allowed" :saved="Boolean(saved_id)"
        :sub="Boolean(scope)" :compact="stacked" :readonly="draft_readonly" />
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
/* The loading placeholder keeps the grid and toolbar only; its default start node would sit under the spinner. Not
   `visibility`: Vue Flow makes each node visible again. */
.workflow-library-placeholder :deep(.vue-flow__nodes), .workflow-library-placeholder :deep(.vue-flow__edges) { display: none; }
.workflow-library-conflict { position: absolute; top: 56px; left: 50%; transform: translateX(-50%); z-index: 5; display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; border-radius: 10px; border: 1px solid var(--ui-warning); background: var(--ui-bg-elevated); color: var(--ui-text); font-size: 13px; max-width: calc(100% - 32px); }
.workflow-library-conflict.is-readonly { border-color: var(--ui-border-accented); color: var(--ui-text-muted); }
.workflow-library-loading { position: absolute; inset: 0; display: grid; place-content: center; justify-items: center; gap: 12px; color: var(--ui-text-dimmed); pointer-events: none; font-size: 13px; }
.workflow-library-loading > span { width: 28px; height: 28px; }
.workflow-library-loading > span:last-child { width: auto; height: auto; }
.workflow-skill-loading { display: flex; flex-direction: column; gap: 18px; padding: 24px; border-left: 1px solid var(--ui-border-muted); }
/* Scope badges in the toolbar. */
.workflow-scope-badges { display: inline-flex; align-items: center; gap: 4px; max-width: 200px; }
.workflow-scope-badge { display: inline-flex; align-items: center; gap: 4px; max-width: 150px; height: 24px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 500; white-space: nowrap; }
.workflow-scope-badge > span { overflow: hidden; text-overflow: ellipsis; }
.workflow-scope-badge.is-global { background: var(--ui-bg-accented); color: var(--ui-text-muted); }
.workflow-scope-badge.is-project { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 14%, transparent); color: var(--channel-accent, var(--ui-primary)); }
.workflow-scope-badge.is-readonly { background: color-mix(in srgb, var(--ui-warning, #e0a33a) 16%, transparent); color: var(--ui-warning, #e0a33a); }
.workflow-scope-picker { max-width: 170px; }
/* Unsaved changes: a dot on the save button's corner. */
.workflow-library-save { position: relative; display: inline-flex; }
.workflow-library-dirty { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border: 2px solid var(--ui-bg-elevated); border-radius: 50%; background: var(--ui-warning, #e0a33a);
  pointer-events: none; }
/* Stacked (phone, upright tablet): a centred "画布 | 工作流" segmented switch on top; the rest is the canvas or SKILL.md. */
.workflow-library.is-stacked, .workflow-library.is-stacked.has-skill { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
.workflow-library.is-stacked :deep(.workflow-skill) { min-height: 0; border-left: 0; }
.workflow-tabs-view { display: flex; justify-content: center; padding: 6px 12px; border-bottom: 1px solid var(--ui-border-muted); background: var(--ui-bg); }
.workflow-tabs-segment { display: flex; gap: 2px; width: min(260px, 100%); padding: 2px; border-radius: 9px; background: var(--ui-bg-accented); }
.workflow-tabs-segment > button { display: flex; flex: 1; align-items: center; justify-content: center; gap: 5px; height: 30px; border-radius: 7px; color: var(--ui-text-muted);
  font-size: 13px; white-space: nowrap; }
.workflow-tabs-segment > button[aria-selected="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); box-shadow: 0 1px 3px rgb(0 0 0 / .2); }
</style>

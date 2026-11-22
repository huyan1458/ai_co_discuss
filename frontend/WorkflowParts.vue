<script setup>
/**
 * The open workflow's parts, floating on its canvas under the toolbar (on a phone, in its bottom-left corner): the main flow and its sub-workflows (each a
 * workflow of its own, used on demand beside the main flow, with its own SKILL.md, cards and canvas). Picking one shows
 * its canvas and SKILL.md; all of them save together. Folded, it names where you are; on a phone it starts folded.
 * A row's tools (place on / find on the main canvas, delete) show over its member count on hover; touch shows them always.
 */
import { computed, ref, watch } from "vue";
import { sub_member_count, use_workflow_library } from "./workflow-library.js";

const props = defineProps({ compact: Boolean });
const emit = defineEmits(["place"]);
const library = use_workflow_library();
const { draft, scope, subs } = library;
const open = ref(!props.compact);
// The sub-workflow whose removal awaits a second tap, so one slip does not drop it.
const confirming = ref("");
watch(scope, () => { confirming.value = ""; if (props.compact) open.value = false; });
// Sub-workflows already on the main canvas: their place button finds the node instead of adding another.
const placed = computed(() => new Set((draft.value.flow?.nodes || []).filter((node) => node.type === "sub").map((node) => node.sub)));

/** Show a part of the workflow. */
function pick(id) {
  confirming.value = "";
  library.open_scope(id);
}

/** Put a sub-workflow on the main canvas, or find it there; a phone folds the list so the node shows. */
function place(id) {
  emit("place", id);
  if (props.compact) open.value = false;
}

function remove(id) {
  confirming.value = "";
  library.remove_sub(id);
}
</script>

<template>
  <nav class="workflow-parts" :class="{ 'is-compact': compact, 'is-open': open }" :aria-label="t('主线与子工作流')">
    <div class="workflow-parts-head">
      <button v-if="scope && !open" type="button" class="workflow-parts-back" :aria-label="t('回到主线')" :title="t('回到主线')" @click="pick('')">
        <UIcon name="i-lucide-arrow-left" class="workflow-parts-icon" />
      </button>
      <button type="button" class="workflow-parts-toggle" :aria-expanded="open" @click="open = !open">
        <UIcon :name="scope && !open ? 'i-lucide-git-branch' : 'i-lucide-network'" class="workflow-parts-icon" />
        <span class="workflow-parts-where">{{ open ? t('主线与子工作流') : scope ? (subs.find((sub) => sub.id === scope)?.label || scope) : t('主线') }}</span>
        <small v-if="!open && !scope && subs.length">{{ t('{value1} 个子工作流', { value1: subs.length }) }}</small>
        <UIcon name="i-lucide-chevron-down" class="workflow-parts-icon workflow-parts-chevron" />
      </button>
    </div>
    <ul v-if="open" class="workflow-parts-list">
      <li class="workflow-parts-row">
        <button type="button" class="workflow-parts-item" :aria-current="!scope ? 'page' : undefined" @click="pick('')">
          <UIcon name="i-lucide-network" class="workflow-parts-icon" /><span>{{ t('主线') }}</span><small>{{ t('{value1} 位', { value1: draft.agents.length }) }}</small>
        </button>
      </li>
      <li v-for="sub in subs" :key="sub.id" class="workflow-parts-row" :class="{ 'is-confirming': confirming === sub.id }">
        <template v-if="confirming === sub.id">
          <span class="workflow-parts-confirm">{{ t('删除「{value1}」？保存后生效', { value1: sub.label || sub.id }) }}</span>
          <UButton :label="t('删除')" size="xs" color="error" variant="soft" @click="remove(sub.id)" />
          <UButton :label="t('取消')" size="xs" color="neutral" variant="ghost" @click="confirming = ''" />
        </template>
        <template v-else>
          <button type="button" class="workflow-parts-item is-sub" :aria-current="scope === sub.id ? 'page' : undefined" :title="sub.description || sub.label" @click="pick(sub.id)">
            <UIcon name="i-lucide-git-branch" class="workflow-parts-icon" /><span>{{ sub.label || sub.id }}</span><small>{{ t('{value1} 位', { value1: sub_member_count(sub, draft.agents) }) }}</small>
          </button>
          <span class="workflow-parts-actions">
            <button v-if="!scope && placed.has(sub.id)" type="button" class="workflow-parts-action" :aria-label="t('在画布上定位 {value1}', { value1: sub.label || sub.id })" :title="t('已在画布上：点一下定位到它')" @click="place(sub.id)">
              <UIcon name="i-lucide-locate-fixed" class="workflow-parts-icon" />
            </button>
            <button v-else-if="!scope" type="button" class="workflow-parts-action" :aria-label="t('把 {value1} 放到画布', { value1: sub.label || sub.id })" :title="t('放到画布：示意流程走到这里转去这个子工作流')" @click="place(sub.id)">
              <UIcon name="i-lucide-square-plus" class="workflow-parts-icon" />
            </button>
            <button type="button" class="workflow-parts-action is-danger" :aria-label="t('删除子工作流 {value1}', { value1: sub.label || sub.id })" :title="t('删除子工作流')" @click="confirming = sub.id">
              <UIcon name="i-lucide-trash-2" class="workflow-parts-icon" />
            </button>
          </span>
        </template>
      </li>
      <li>
        <button type="button" class="workflow-parts-item is-add" :title="t('主线之外按需用的一套做法：自己的 SKILL.md、成员卡片和画布')" @click="library.add_sub()">
          <UIcon name="i-lucide-plus" class="workflow-parts-icon" /><span>{{ t('新建子工作流') }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
/* Under the canvas toolbar (Vue Flow panels sit 15px in); above the canvas, below popovers. */
.workflow-parts { position: absolute; top: 60px; left: 15px; z-index: 6; display: grid; grid-template-columns: minmax(0, 1fr); width: 260px; max-width: calc(100% - 30px); padding: 4px;
  border: 1px solid var(--ui-border-muted); border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: 0 6px 20px rgb(0 0 0 / .14); font-size: 13px; }
.workflow-parts:not(.is-open) { width: auto; }
.workflow-parts-icon { flex-shrink: 0; width: 14px; height: 14px; }
.workflow-parts-head { display: flex; align-items: center; gap: 2px; }
.workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-action { display: flex; align-items: center; gap: 8px; min-height: 30px; border-radius: 7px; color: var(--ui-text-muted); }
.workflow-parts-toggle { flex: 1; min-width: 0; padding: 0 8px; color: var(--ui-text-highlighted); font-weight: 500; }
.workflow-parts-back { justify-content: center; width: 30px; }
.workflow-parts-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-parts-toggle small, .workflow-parts-item small { margin-left: auto; padding-left: 8px; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
.workflow-parts-chevron { margin-left: auto; transition: transform .15s; }
.workflow-parts-toggle small + .workflow-parts-chevron { margin-left: 2px; }
.workflow-parts.is-open .workflow-parts-chevron { transform: rotate(180deg); }
.workflow-parts-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1px; margin: 4px 0 0; padding: 4px 0 0; border-top: 1px solid var(--ui-border-muted); list-style: none; }
/* Every row is as wide as the list, so the counts line up and the current row's highlight spans it all. */
.workflow-parts-row { position: relative; display: flex; align-items: center; gap: 4px; }
.workflow-parts-row.is-confirming { min-height: 30px; padding: 0 2px 0 0; border-radius: 7px; background: color-mix(in srgb, var(--ui-error, #e5484d) 10%, transparent); }
.workflow-parts-item { width: 100%; min-width: 0; padding: 0 8px; text-align: left; }
.workflow-parts-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Sub-workflows hang under the main flow: indented, with a guide line down to the last one. */
.workflow-parts-item.is-sub { padding-left: 24px; }
.workflow-parts-row:has(.is-sub)::before { content: ""; position: absolute; top: 0; bottom: 0; left: 14px; width: 1px; background: var(--ui-border-muted); pointer-events: none; }
.workflow-parts-item.is-add { color: var(--channel-accent, var(--ui-primary)); }
.workflow-parts-item[aria-current="page"] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--ui-text-highlighted); font-weight: 500; }
.workflow-parts-item[aria-current="page"] > .workflow-parts-icon { color: var(--channel-accent, var(--ui-primary)); }
.workflow-parts-toggle:hover, .workflow-parts-back:hover, .workflow-parts-item:hover, .workflow-parts-row:hover > .workflow-parts-item { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
/* A row's tools sit over its count and show on hover or keyboard focus; the count gives way to them. */
.workflow-parts-actions { position: absolute; top: 2px; right: 2px; bottom: 2px; display: flex; align-items: center; gap: 1px; padding-left: 6px; border-radius: 6px;
  background: var(--ui-bg-accented); opacity: 0; pointer-events: none; transition: opacity .12s; }
.workflow-parts-row:hover .workflow-parts-actions, .workflow-parts-row:focus-within .workflow-parts-actions { opacity: 1; pointer-events: auto; }
@media (pointer: fine) { .workflow-parts-row:is(:hover, :focus-within):has(.workflow-parts-actions) .workflow-parts-item small { visibility: hidden; } }
.workflow-parts-action { justify-content: center; flex-shrink: 0; width: 26px; min-height: 26px; color: var(--ui-text-muted); }
.workflow-parts-action:hover { background: color-mix(in srgb, var(--ui-text) 10%, transparent); color: var(--ui-text-highlighted); }
.workflow-parts-action.is-danger:hover { color: var(--ui-error, #e5484d); }
.workflow-parts-confirm { flex: 1; min-width: 0; padding: 0 8px; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
/* Touch (tablet, phone): larger targets, and a row's tools always show beside it since there is no hover. */
@media (pointer: coarse) {
  .workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-action { min-height: 40px; }
  .workflow-parts-back, .workflow-parts-action { width: 40px; }
  .workflow-parts-actions { position: static; padding: 0; background: none; opacity: 1; pointer-events: auto; }
  .workflow-parts { top: 66px; }
}
/* Phone and upright tablet: the top row holds the toolbar and zoom buttons, so the parts sit in the bottom-left corner,
   10px in like the canvas panels, and open upwards. */
.workflow-parts.is-compact { top: auto; bottom: 10px; left: 10px; display: flex; flex-direction: column-reverse; max-width: calc(100% - 20px); font-size: 12px; }
.workflow-parts.is-compact .workflow-parts-list { margin: 0 0 4px; padding: 0 0 4px; border-top: 0; border-bottom: 1px solid var(--ui-border-muted); }
.workflow-parts.is-compact :is(.workflow-parts-toggle, .workflow-parts-back) { min-height: 28px; }
.workflow-parts.is-compact .workflow-parts-back { width: 28px; }
@media (max-width: 480px) {
  /* Closed on a narrow phone: stop short of the zoom buttons in the bottom-right corner; opening expands full width. */
  .workflow-parts.is-compact:not(.is-open) { max-width: calc(100% - 76px); }
}
</style>

<script setup>
/**
 * The open workflow's parts, floating on its canvas under the toolbar (on a phone, in its bottom-left corner): the main flow and its sub-workflows (each a
 * workflow of its own, used on demand beside the main flow, with its own SKILL.md, cards and canvas). Picking one shows
 * its canvas and SKILL.md; all of them save together. Folded, it names where you are; on a phone it starts folded.
 */
import { ref, watch } from "vue";
import { use_workflow_library } from "./workflow-library.js";

const props = defineProps({ compact: Boolean });
const emit = defineEmits(["place"]);
const library = use_workflow_library();
const { draft, scope, subs } = library;
const open = ref(!props.compact);
// The sub-workflow whose removal awaits a second tap, so one slip does not drop it.
const confirming = ref("");
watch(scope, () => { confirming.value = ""; if (props.compact) open.value = false; });

/** Show a part of the workflow. */
function pick(id) {
  confirming.value = "";
  library.open_scope(id);
}

/** How many members a sub-workflow uses: its own cards and the main flow's cards placed on its canvas, each once. */
function member_count(sub) {
  const known = new Set([...draft.value.agents, ...sub.agents].map((agent) => agent.card));
  const placed = (sub.flow?.nodes || []).filter((node) => node.type === "card" && known.has(node.card)).map((node) => node.card);
  return new Set([...sub.agents.map((agent) => agent.card), ...placed]).size;
}

/** Put a sub-workflow on the main canvas; a phone folds the list so the new node shows. */
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
        <UIcon :name="scope ? 'i-lucide-git-branch' : 'i-lucide-network'" class="workflow-parts-icon" />
        <span class="workflow-parts-where">{{ open ? t('主线与子工作流') : scope ? (subs.find((sub) => sub.id === scope)?.label || scope) : t('主线') }}</span>
        <small v-if="!open && !scope && subs.length">{{ t('{value1} 个子工作流', { value1: subs.length }) }}</small>
        <UIcon name="i-lucide-chevron-down" class="workflow-parts-icon workflow-parts-chevron" />
      </button>
    </div>
    <ul v-if="open" class="workflow-parts-list">
      <li>
        <button type="button" class="workflow-parts-item" :aria-current="!scope ? 'page' : undefined" @click="pick('')">
          <UIcon name="i-lucide-network" class="workflow-parts-icon" /><span>{{ t('主线') }}</span><small>{{ t('{value1} 位', { value1: draft.agents.length }) }}</small>
        </button>
      </li>
      <li v-for="sub in subs" :key="sub.id" class="workflow-parts-row">
        <template v-if="confirming === sub.id">
          <span class="workflow-parts-confirm">{{ t('删除「{value1}」？保存后生效', { value1: sub.label || sub.id }) }}</span>
          <UButton :label="t('删除')" size="xs" color="error" variant="soft" @click="remove(sub.id)" />
          <UButton :label="t('取消')" size="xs" color="neutral" variant="ghost" @click="confirming = ''" />
        </template>
        <template v-else>
          <button type="button" class="workflow-parts-item is-sub" :aria-current="scope === sub.id ? 'page' : undefined" :title="sub.description || sub.label" @click="pick(sub.id)">
            <UIcon name="i-lucide-git-branch" class="workflow-parts-icon" /><span>{{ sub.label || sub.id }}</span><small>{{ t('{value1} 位', { value1: member_count(sub) }) }}</small>
          </button>
          <button v-if="!scope" type="button" class="workflow-parts-place" :aria-label="t('把 {value1} 放到画布', { value1: sub.label || sub.id })" :title="t('放到画布：示意流程走到这里转去这个子工作流')" @click="place(sub.id)">
            <UIcon name="i-lucide-square-plus" class="workflow-parts-icon" />
          </button>
          <button type="button" class="workflow-parts-remove" :aria-label="t('删除子工作流 {value1}', { value1: sub.label || sub.id })" :title="t('删除子工作流')" @click="confirming = sub.id">
            <UIcon name="i-lucide-trash-2" class="workflow-parts-icon" />
          </button>
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
.workflow-parts { position: absolute; top: 60px; left: 15px; z-index: 6; display: grid; width: 232px; max-width: calc(100% - 30px); padding: 3px;
  border: 1px solid var(--ui-border-muted); border-radius: 10px; background: var(--ui-bg-elevated); box-shadow: 0 6px 20px rgb(0 0 0 / .14); font-size: 13px; }
.workflow-parts:not(.is-open) { width: auto; }
.workflow-parts-icon { flex-shrink: 0; width: 14px; height: 14px; }
.workflow-parts-head { display: flex; align-items: center; gap: 2px; }
.workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-place, .workflow-parts-remove { display: flex; align-items: center; gap: 7px; min-height: 30px; border-radius: 7px; color: var(--ui-text-muted); }
.workflow-parts-toggle { flex: 1; min-width: 0; padding: 0 8px; color: var(--ui-text-highlighted); font-weight: 500; }
.workflow-parts-back { justify-content: center; width: 30px; }
.workflow-parts-where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-parts-toggle small, .workflow-parts-item small { margin-left: auto; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; white-space: nowrap; }
.workflow-parts-chevron { margin-left: auto; transition: transform .15s; }
.workflow-parts-toggle small + .workflow-parts-chevron { margin-left: 2px; }
.workflow-parts.is-open .workflow-parts-chevron { transform: rotate(180deg); }
.workflow-parts-list { display: grid; gap: 1px; margin: 3px 0 0; padding: 3px 0 0; border-top: 1px solid var(--ui-border-muted); list-style: none; }
.workflow-parts-row { display: flex; align-items: center; gap: 2px; }
.workflow-parts-item { width: 100%; min-width: 0; padding: 0 8px; text-align: left; }
.workflow-parts-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-parts-item.is-sub { padding-left: 20px; }
.workflow-parts-item.is-add { color: var(--channel-accent, var(--ui-primary)); }
.workflow-parts-item[aria-current="page"] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 14%, transparent); color: var(--ui-text-highlighted); }
.workflow-parts-toggle:hover, .workflow-parts-back:hover, .workflow-parts-item:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-parts-place { justify-content: center; flex-shrink: 0; width: 28px; }
.workflow-parts-place:hover { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.workflow-parts-remove { justify-content: center; flex-shrink: 0; width: 28px; color: var(--ui-text-dimmed); opacity: 0; transition: opacity .15s; }
.workflow-parts-row:hover .workflow-parts-remove, .workflow-parts-remove:focus-visible { opacity: 1; }
.workflow-parts-remove:hover { color: var(--ui-error, #e5484d); background: var(--ui-bg-accented); }
.workflow-parts-confirm { flex: 1; min-width: 0; padding: 0 6px; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
/* Touch (tablet, phone): larger targets, and the delete button always shows since there is no hover. */
@media (pointer: coarse) {
  .workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-place, .workflow-parts-remove { min-height: 40px; }
  .workflow-parts-back, .workflow-parts-place, .workflow-parts-remove { width: 40px; }
  .workflow-parts-remove { opacity: 1; }
  .workflow-parts { top: 66px; }
}
/* Phone and upright tablet: the top row holds the toolbar and zoom buttons, so the parts sit in the bottom-left corner,
   10px in like the canvas panels, and open upwards. */
.workflow-parts.is-compact { top: auto; bottom: 10px; left: 10px; display: flex; flex-direction: column-reverse; max-width: calc(100% - 20px); font-size: 12px; }
.workflow-parts.is-compact .workflow-parts-list { margin: 0 0 3px; padding: 0 0 3px; border-top: 0; border-bottom: 1px solid var(--ui-border-muted); }
.workflow-parts.is-compact :is(.workflow-parts-toggle, .workflow-parts-back) { min-height: 28px; }
.workflow-parts.is-compact .workflow-parts-back { width: 28px; }
</style>

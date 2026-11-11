<script setup>
/**
 * The open workflow's parts, floating on its canvas under the toolbar: the main flow and its sub-workflows (each a
 * workflow of its own, used on demand beside the main flow, with its own SKILL.md, cards and canvas). Picking one shows
 * its canvas and SKILL.md; all of them save together. Folded, it names where you are; on a phone it starts folded.
 */
import { ref, watch } from "vue";
import { use_workflow_library } from "./workflow-library.js";

const props = defineProps({ compact: Boolean });
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

function remove(id) {
  confirming.value = "";
  library.remove_sub(id);
}
</script>

<template>
  <nav class="workflow-parts" :class="{ 'is-compact': compact, 'is-open': open }" aria-label="主线与子工作流">
    <div class="workflow-parts-head">
      <button v-if="scope && !open" type="button" class="workflow-parts-back" aria-label="回到主线" title="回到主线" @click="pick('')">
        <UIcon name="i-lucide-arrow-left" class="workflow-parts-icon" />
      </button>
      <button type="button" class="workflow-parts-toggle" :aria-expanded="open" @click="open = !open">
        <UIcon :name="scope ? 'i-lucide-git-branch' : 'i-lucide-network'" class="workflow-parts-icon" />
        <span class="workflow-parts-where">{{ open ? '主线与子工作流' : scope ? (subs.find((sub) => sub.id === scope)?.label || scope) : '主线' }}</span>
        <small v-if="!open && !scope && subs.length">{{ subs.length }} 个子工作流</small>
        <UIcon name="i-lucide-chevron-down" class="workflow-parts-icon workflow-parts-chevron" />
      </button>
    </div>
    <ul v-if="open" class="workflow-parts-list">
      <li>
        <button type="button" class="workflow-parts-item" :aria-current="!scope ? 'page' : undefined" @click="pick('')">
          <UIcon name="i-lucide-network" class="workflow-parts-icon" /><span>主线</span><small>{{ draft.agents.length }} 位</small>
        </button>
      </li>
      <li v-for="sub in subs" :key="sub.id" class="workflow-parts-row">
        <template v-if="confirming === sub.id">
          <span class="workflow-parts-confirm">删除「{{ sub.label || sub.id }}」？保存后生效</span>
          <UButton label="删除" size="xs" color="error" variant="soft" @click="remove(sub.id)" />
          <UButton label="取消" size="xs" color="neutral" variant="ghost" @click="confirming = ''" />
        </template>
        <template v-else>
          <button type="button" class="workflow-parts-item is-sub" :aria-current="scope === sub.id ? 'page' : undefined" :title="sub.description || sub.label" @click="pick(sub.id)">
            <UIcon name="i-lucide-git-branch" class="workflow-parts-icon" /><span>{{ sub.label || sub.id }}</span><small>{{ sub.agents.length }} 位</small>
          </button>
          <button type="button" class="workflow-parts-remove" :aria-label="`删除子工作流 ${sub.label || sub.id}`" title="删除子工作流" @click="confirming = sub.id">
            <UIcon name="i-lucide-trash-2" class="workflow-parts-icon" />
          </button>
        </template>
      </li>
      <li>
        <button type="button" class="workflow-parts-item is-add" title="主线之外按需用的一套做法：自己的 SKILL.md、成员卡片和画布" @click="library.add_sub()">
          <UIcon name="i-lucide-plus" class="workflow-parts-icon" /><span>新建子工作流</span>
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
.workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-remove { display: flex; align-items: center; gap: 7px; min-height: 30px; border-radius: 7px; color: var(--ui-text-muted); }
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
.workflow-parts-remove { justify-content: center; flex-shrink: 0; width: 28px; color: var(--ui-text-dimmed); opacity: 0; transition: opacity .15s; }
.workflow-parts-row:hover .workflow-parts-remove, .workflow-parts-remove:focus-visible { opacity: 1; }
.workflow-parts-remove:hover { color: var(--ui-error, #e5484d); background: var(--ui-bg-accented); }
.workflow-parts-confirm { flex: 1; min-width: 0; padding: 0 6px; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
/* Touch (tablet, phone): larger targets, and the delete button always shows since there is no hover. */
@media (pointer: coarse) {
  .workflow-parts-toggle, .workflow-parts-back, .workflow-parts-item, .workflow-parts-remove { min-height: 40px; }
  .workflow-parts-back, .workflow-parts-remove { width: 40px; }
  .workflow-parts-remove { opacity: 1; }
  .workflow-parts { top: 66px; }
}
/* Phone and upright tablet: the toolbar shows icons only; the list keeps clear of the canvas's right-hand zoom buttons. */
.workflow-parts.is-compact { top: 58px; left: 10px; max-width: calc(100% - 64px); }
@media (pointer: coarse) { .workflow-parts.is-compact { top: 64px; } }
</style>

<script setup>
/**
 * The workflow's SKILL.md beside its canvas, as a docked panel: the host dispatches by this text alone, so it stays in
 * view. It reads as rendered Markdown and switches to editing the source; the one-line description and (folded) the
 * commands an import registers sit with it. The name, the folder and deletion are in the workflow list's "…" menu.
 */
import { computed, inject, nextTick, ref } from "vue";

const workflow = defineModel("workflow", { type: Object, required: true });
// An import's commands run on this computer when an API member calls them, so they are kept only once the user allows them.
const commands_allowed = defineModel("commandsAllowed", { type: Boolean, default: false });
// `compact`: the stacked page (phone, upright tablet), where the panel is one of two views and cannot fold away.
const props = defineProps({ saved: Boolean, compact: Boolean });
const emit = defineEmits(["collapse"]);
const { view } = inject("discussion");
const MAX_SKILL = 20000;
// A workflow with no SKILL.md text yet opens in editing; otherwise the rendered text comes first.
const editing = ref(!workflow.value.skill?.trim());
const source = ref(null);
const commands = computed(() => workflow.value.commands || []);
// An import carrying an ID already in the library replaces that workflow when saved.
const replaced = computed(() => !props.saved && (view.value.launch.workflows || []).find((item) => item.id === workflow.value.id));
const rendered = computed(() => editing.value ? "" : window.discuss_markdown.render_markdown(workflow.value.skill || ""));

/** Switch to editing the source, with the cursor in it. */
function edit() {
  editing.value = true;
  nextTick(() => source.value?.focus());
}

</script>

<template>
  <aside class="workflow-skill" :class="{ 'is-compact': compact }" aria-label="做法说明（SKILL.md）">
    <header class="workflow-skill-head">
      <h3><UIcon name="i-lucide-file-text" class="workflow-skill-icon" />做法说明<small>SKILL.md · 主持人照它派活</small></h3>
      <UButton :icon="editing ? 'i-lucide-eye' : 'i-lucide-pencil'" :label="editing ? '预览' : '编辑'" size="xs" color="neutral" variant="soft"
        @click="editing ? (editing = false) : edit()" />
      <UTooltip v-if="!compact" text="收起做法说明"><UButton icon="i-lucide-panel-right-close" size="xs" color="neutral" variant="ghost" aria-label="收起做法说明" @click="emit('collapse')" /></UTooltip>
    </header>
    <label class="workflow-skill-description">
      <span>一句话描述 <small>主持人凭它判断何时使用</small></span>
      <input v-model="workflow.description" :maxlength="500" placeholder="做什么、什么时候用" />
    </label>
    <div class="workflow-skill-body">
      <textarea v-if="editing" ref="source" v-model="workflow.skill" :maxlength="MAX_SKILL" class="workflow-skill-source" spellcheck="false" aria-label="SKILL.md 正文" />
      <div v-else-if="workflow.skill?.trim()" class="workflow-skill-preview markdown-body" v-html="rendered" @dblclick="edit"></div>
      <button v-else type="button" class="workflow-skill-empty" @click="edit"><UIcon name="i-lucide-pencil" class="workflow-skill-icon" />写下主持人怎么组织这个工作流</button>
    </div>
    <p v-if="editing" class="workflow-skill-count">{{ (workflow.skill || '').length }} / {{ MAX_SKILL }}</p>
    <details v-if="commands.length" class="workflow-skill-commands" :open="!saved">
      <summary><UIcon name="i-lucide-terminal" class="workflow-skill-icon" />API 成员可运行的命令（{{ commands.length }}）</summary>
      <ul>
        <li v-for="command in commands" :key="command.id" :title="command.description"><strong>{{ command.id }}</strong>
          <UBadge :label="command.access === 'read' ? '只读' : '会改文件'" size="sm" variant="soft" :color="command.access === 'read' ? 'neutral' : 'warning'" />
          <code>{{ command.run.join(' ') }}</code></li>
      </ul>
      <label v-if="!saved" class="workflow-skill-grant"><input v-model="commands_allowed" type="checkbox" />允许这些命令在本机运行</label>
    </details>
    <p v-if="replaced" class="workflow-skill-warn"><UIcon name="i-lucide-triangle-alert" class="workflow-skill-icon" />保存会覆盖库里的「{{ replaced.label }}」</p>
  </aside>
</template>

<style scoped>
.workflow-skill { display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 12px 14px; border-left: 1px solid var(--ui-border-muted); background: var(--ui-bg); }
.workflow-skill-icon { flex-shrink: 0; width: 14px; height: 14px; }
.workflow-skill-head { display: flex; align-items: center; gap: 6px; }
.workflow-skill-head h3 { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; margin: 0; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; white-space: nowrap; }
.workflow-skill-head small { overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; text-overflow: ellipsis; }
.workflow-skill-description { display: grid; gap: 4px; font-size: 12px; color: var(--ui-text-muted); }
.workflow-skill-description small { color: var(--ui-text-dimmed); }
.workflow-skill-description input { height: 30px; padding: 0 8px; border: 1px solid var(--ui-border-muted); border-radius: 7px; background: var(--ui-bg-elevated); color: var(--ui-text);
  font-size: 13px; outline: none; }
.workflow-skill-description input:focus { border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-skill-body { display: flex; flex: 1; min-height: 0; }
.workflow-skill-source { flex: 1; min-height: 0; padding: 10px 12px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 8px; background: var(--ui-bg-elevated);
  color: var(--ui-text); font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; resize: none; outline: none; }
.workflow-skill-preview { flex: 1; min-height: 0; overflow: auto; padding: 4px 4px 12px; font-size: 13px; line-height: 1.7; }
.workflow-skill-empty { display: flex; flex: 1; align-items: center; justify-content: center; gap: 6px; border: 1px dashed var(--ui-border-accented); border-radius: 8px;
  color: var(--ui-text-muted); font-size: 13px; }
.workflow-skill-empty:hover { color: var(--ui-text-highlighted); border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-skill-count { margin: -4px 0 0; color: var(--ui-text-dimmed); font-size: 11px; text-align: right; }
.workflow-skill-commands { display: grid; gap: 6px; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); }
.workflow-skill-commands summary { display: flex; align-items: center; gap: 6px; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; list-style: none; }
.workflow-skill-commands summary::-webkit-details-marker { display: none; }
.workflow-skill-commands summary::after { content: "›"; margin-left: auto; transition: transform .15s; }
.workflow-skill-commands[open] summary::after { transform: rotate(90deg); }
.workflow-skill-commands[open] summary { color: var(--ui-text-highlighted); }
.workflow-skill-commands ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 12px; }
.workflow-skill-commands li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.workflow-skill-commands code { flex-basis: 100%; overflow-wrap: anywhere; color: var(--ui-text-muted); }
.workflow-skill-grant, .workflow-skill-warn { display: flex; gap: 6px; align-items: center; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
/* Stacked page: tighter, the subtitle gives way to the text. */
.workflow-skill.is-compact { gap: 8px; padding: 8px 12px; }
.workflow-skill.is-compact .workflow-skill-head small, .workflow-skill.is-compact .workflow-skill-description small { display: none; }
</style>

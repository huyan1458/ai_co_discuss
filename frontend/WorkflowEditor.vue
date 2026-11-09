<script setup>
/**
 * A workflow's text settings in a side drawer beside its canvas: name, one-line description, the host's SKILL.md, the
 * commands an import registers, the folder and deletion. The cards and the relay are edited on the canvas itself.
 */
import { computed, inject, ref } from "vue";

const open = defineModel("open", { type: Boolean, default: false });
const workflow = defineModel("workflow", { type: Object, required: true });
// An import's commands run on this computer when an API member calls them, so they are kept only once the user allows them.
const commands_allowed = defineModel("commandsAllowed", { type: Boolean, default: false });
const props = defineProps({ saved: Boolean });
const emit = defineEmits(["delete"]);
const { view, act } = inject("discussion");
const MAX_SKILL = 20000;
const previewing = ref(false);
const commands = computed(() => workflow.value.commands || []);
// An import carrying an ID already in the library replaces that workflow when saved.
const replaced = computed(() => !props.saved && (view.value.launch.workflows || []).find((item) => item.id === workflow.value.id));
const rendered = computed(() => previewing.value ? window.discuss_markdown.render_markdown(workflow.value.skill || "") : "");
</script>

<template>
  <USlideover v-model:open="open" side="right" title="工作流说明" :ui="{ content: 'workflow-details', body: 'workflow-details-body' }">
    <template #body>
      <div class="workflow-details-form">
        <UFormField label="名称" required><UInput v-model="workflow.label" :maxlength="32" class="w-full" /></UFormField>
        <UFormField label="一句话描述" hint="主持人凭它判断何时使用">
          <UInput v-model="workflow.description" :maxlength="500" class="w-full" />
        </UFormField>
        <UFormField label="做法说明" required :hint="`${workflow.skill.length} / ${MAX_SKILL}`">
          <template #description>
            <button type="button" class="workflow-details-toggle" :aria-pressed="previewing" @click="previewing = !previewing">
              <UIcon :name="previewing ? 'i-lucide-pencil' : 'i-lucide-eye'" class="workflow-details-icon" />{{ previewing ? '编辑' : '预览' }}</button>
          </template>
          <div v-if="previewing" class="workflow-details-preview markdown-body" v-html="rendered"></div>
          <UTextarea v-else v-model="workflow.skill" :rows="16" :maxlength="MAX_SKILL" class="w-full" />
        </UFormField>
        <section v-if="commands.length" class="workflow-details-commands" aria-label="登记的命令">
          <h4><UIcon name="i-lucide-terminal" class="workflow-details-icon" />API 成员可运行的命令</h4>
          <ul>
            <li v-for="command in commands" :key="command.id" :title="command.description"><strong>{{ command.id }}</strong>
              <UBadge :label="command.access === 'read' ? '只读' : '会改文件'" size="sm" variant="soft" :color="command.access === 'read' ? 'neutral' : 'warning'" />
              <code>{{ command.run.join(' ') }}</code></li>
          </ul>
          <label v-if="!saved" class="workflow-details-grant"><input v-model="commands_allowed" type="checkbox" />允许这些命令在本机运行</label>
        </section>
        <p v-if="replaced" class="workflow-details-warn"><UIcon name="i-lucide-triangle-alert" class="workflow-details-icon" />保存会覆盖库里的「{{ replaced.label }}」</p>
        <div v-if="saved" class="workflow-details-footer">
          <UButton icon="i-lucide-folder" label="复制文件夹路径" size="xs" color="neutral" variant="ghost" :title="workflow.directory" @click="act('copy', workflow.directory)" />
          <UButton icon="i-lucide-trash-2" label="删除工作流" size="xs" color="error" variant="ghost" @click="emit('delete')" />
        </div>
      </div>
    </template>
  </USlideover>
</template>

<style scoped>
.workflow-details-form { display: grid; gap: 16px; }
.workflow-details-icon { flex-shrink: 0; width: 13px; height: 13px; }
.workflow-details-toggle { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 12px; }
.workflow-details-toggle:hover { color: var(--ui-text-highlighted); }
.workflow-details-preview { max-height: 60vh; overflow: auto; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.workflow-details-commands { display: grid; gap: 6px; }
.workflow-details-commands h4 { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; }
.workflow-details-commands ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; font-size: 12px; }
.workflow-details-commands li { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.workflow-details-commands code { flex-basis: 100%; overflow-wrap: anywhere; color: var(--ui-text-muted); }
.workflow-details-grant { display: flex; gap: 6px; align-items: center; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-details-warn { display: flex; gap: 6px; align-items: center; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-details-footer { display: flex; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); }
</style>

<style>
html[data-theme^="channel"] .workflow-details { max-width: min(560px, 100vw); }
</style>

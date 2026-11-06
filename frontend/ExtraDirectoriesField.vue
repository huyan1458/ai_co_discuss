<script setup>
/** The room's other project directories besides the main one: one path row each, added or removed. Shared by the new-room
 * form and the room settings, which saves the list as a whole. Members work with them at their own project access; a
 * member working outside the room's project only reads them. A device reaching its computer only through the queued
 * relay picks saved projects by name and cannot name folders, so it cannot edit them. */
import { computed, inject } from "vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";

// Matches MAX_EXTRA_DIRECTORIES in runner/discussion_runner.mjs.
const MAX_DIRECTORIES = 8;
const props = defineProps({ modelValue: { type: Array, default: () => [] }, disabled: { type: Boolean, default: false } });
const emit = defineEmits(["update:modelValue"]);
const { view } = inject("discussion");
const editable = computed(() => view.value.launch.available);

function write(index, path) {
  emit("update:modelValue", props.modelValue.map((item, at) => at === index ? path : item));
}
const remove = (index) => emit("update:modelValue", props.modelValue.filter((_, at) => at !== index));
const add = () => emit("update:modelValue", [...props.modelValue, ""]);
</script>

<template>
  <div class="extra-directories">
    <template v-if="editable">
      <div v-for="(path, index) in props.modelValue" :key="index" class="extra-directory">
        <ProjectDirectoryField :model-value="path" compact placeholder="另一个项目目录的完整路径" :disabled="props.disabled" @update:model-value="write(index, $event)" />
        <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="`移除项目目录 ${path}`" :disabled="props.disabled" @click="remove(index)" />
      </div>
    </template>
    <code v-for="path in editable ? [] : props.modelValue" :key="path" class="extra-directory-path">{{ path }}</code>
    <button v-if="editable && props.modelValue.length < MAX_DIRECTORIES" type="button" class="extra-directory-add" :disabled="props.disabled" @click="add">
      <UIcon name="i-lucide-plus" />添加其他项目目录
    </button>
    <p v-if="!editable" class="extra-directory-note">其他项目目录须在电脑上或已连接电脑的网页中设置。</p>
  </div>
</template>

<style scoped>
.extra-directories { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.extra-directory { display: flex; align-items: center; gap: 4px; }
.extra-directory > :first-child { flex: 1; min-width: 0; }
.extra-directory-add { display: inline-flex; align-self: flex-start; align-items: center; gap: 5px; padding: 3px 2px; color: var(--ui-text-muted); font-size: 12px; }
.extra-directory-add:hover:not(:disabled) { color: var(--ui-text-highlighted); }
.extra-directory-add:disabled { cursor: not-allowed; opacity: .6; }
.extra-directory-add > [class*="icon"] { width: 13px; height: 13px; }
.extra-directory-path { overflow-wrap: anywhere; font-size: 12px; }
.extra-directory-note { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
</style>

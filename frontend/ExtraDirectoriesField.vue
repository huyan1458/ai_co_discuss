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

const path_of = (item) => typeof item === "string" ? item : item.path;
function write(index, path) {
  emit("update:modelValue", props.modelValue.map((item, at) => {
    if (at !== index) return item;
    return typeof item === "string" ? path : { ...item, path };
  }));
}
const remove = (index) => emit("update:modelValue", props.modelValue.filter((_, at) => at !== index));
const add = () => emit("update:modelValue", [...props.modelValue, ""]);
</script>

<template>
  <div class="extra-directories">
    <template v-if="editable">
      <ProjectDirectoryField v-for="(item, index) in props.modelValue" :key="index" :model-value="path_of(item)" compact :placeholder="t('另一个项目目录的完整路径')" :disabled="props.disabled" @update:model-value="write(index, $event)">
        <template #actions><span v-if="item.access === 'read'" class="extra-directory-note">{{ t('只读') }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="self-center" :aria-label="t('移除项目目录 {value1}', { value1: path_of(item) })" :disabled="props.disabled" @click="remove(index)" /></template>
      </ProjectDirectoryField>
    </template>
    <code v-for="item in editable ? [] : props.modelValue" :key="path_of(item)" class="extra-directory-path">{{ path_of(item) }}<template v-if="item.access === 'read'"> · {{ t('只读') }}</template></code>
    <button v-if="editable && props.modelValue.length < MAX_DIRECTORIES" type="button" class="extra-directory-add" :disabled="props.disabled" @click="add">
      <UIcon name="i-lucide-plus" />{{ t('添加其他项目目录') }} </button>
    <p v-if="!editable" class="extra-directory-note">{{ t('其他项目目录须在电脑上或已连接电脑的网页中设置。') }}</p>
  </div>
</template>

<style scoped>
.extra-directories { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.extra-directory-add { display: inline-flex; align-self: flex-start; align-items: center; gap: 5px; padding: 3px 2px; color: var(--ui-text-muted); font-size: 12px; }
.extra-directory-add:hover:not(:disabled) { color: var(--ui-text-highlighted); }
.extra-directory-add:disabled { cursor: not-allowed; opacity: .6; }
.extra-directory-add > [class*="icon"] { width: 13px; height: 13px; }
.extra-directory-path { overflow-wrap: anywhere; font-size: 12px; }
.extra-directory-note { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
</style>

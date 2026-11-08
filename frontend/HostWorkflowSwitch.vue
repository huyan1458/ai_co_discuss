<script setup>
/** The per-room grant shared by the new-room form and the room settings page: full host control, workflows included. */
defineProps({ modelValue: Boolean, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <UCheckbox :model-value="modelValue" :disabled="disabled" label="主持人完整权限" aria-label="主持人完整权限"
    description="主持人可自行处理问题、持续推进：打断、插话、重试成员，换模型，邀请、移除成员，调整发言顺序，开启讨论与 Goal，保存并启用工作流；成员项目权限最高可写。"
    @update:model-value="emit('update:modelValue', $event)" />
</template>

<script setup>
/** The per-room grant shared by the new-room form and the right rail: the host may save and enable workflows itself. */
defineProps({ modelValue: Boolean, disabled: Boolean });
const emit = defineEmits(["update:modelValue"]);
</script>

<template>
  <UCheckbox :model-value="modelValue" :disabled="disabled" label="允许主持人自建工作流"
    description="主持人可直接保存并启用工作流，自动邀请其中的成员（项目权限最高可写），不必等你导入。"
    @update:model-value="emit('update:modelValue', $event)" />
</template>

<script setup>
/** The page's own confirmation: the same look on every device, unlike the browser's confirm(). */
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  // What the action changes, one line each, so the user knows before confirming.
  items: { type: Array, default: () => [] },
  confirmLabel: { type: String, default: "确认" },
  danger: Boolean,
});
const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["confirm"]);

// Confirm before closing: a parent may clear what the dialog was about once it closes.
function confirm() {
  emit("confirm");
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal', body: 'dialog-body' }">
    <template #body>
      <ul v-if="items.length" class="confirm-dialog-items">
        <li v-for="item in items" :key="item">{{ item }}</li>
      </ul>
      <div class="dialog-actions">
        <UButton label="取消" color="neutral" variant="ghost" @click="open = false" />
        <UButton :label="confirmLabel" :color="danger ? 'error' : 'primary'" @click="confirm" />
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.confirm-dialog-items { display: grid; gap: 6px; margin: 0 0 16px; padding-left: 18px; color: var(--ui-text-toned); font-size: 13px; line-height: 1.6; list-style: disc; }
</style>

<script setup>
import { onMounted, ref } from "vue";

// Re-edits one excerpt beside its passage, opened from its number mark: change the comment, remove the excerpt, or
// leave it as it was. Placed by the parent (a fixed or absolute `style`).
const props = defineProps({ comment: { type: String, default: "" } });
const emit = defineEmits(["save", "cancel", "remove"]);
const draft = ref(props.comment);
const input = ref(null);
onMounted(() => { input.value?.focus(); input.value?.select(); });

function keydown(event) {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); emit("cancel"); }
  else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); emit("save", draft.value.trim()); }
}
</script>

<template>
  <form class="excerpt-edit-card" @submit.prevent="emit('save', draft.trim())">
    <textarea ref="input" v-model="draft" rows="2" placeholder="添加批注（可选）" aria-label="摘录的批注" @keydown="keydown"></textarea>
    <div class="excerpt-edit-actions">
      <button type="button" class="excerpt-edit-remove" aria-label="移除这条摘录" title="移除摘录" @click="emit('remove')"><UIcon name="i-lucide-trash-2" /></button>
      <button type="button" class="excerpt-edit-cancel" @click="emit('cancel')">取消</button>
      <button type="submit" class="excerpt-edit-save">保存</button>
    </div>
  </form>
</template>

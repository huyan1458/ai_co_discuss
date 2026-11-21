<script setup>
import { onMounted, ref } from "vue";

// Re-edits one note's comment in the same pill as adding one (the selection comment box): Enter or ↑ saves, Esc or ×
// leaves it as it was. Beside a passage it floats where the parent places it (a fixed `style`) and offers removal;
// `inline` puts it in the flow, as in the notes list, whose rows have their own remove button.
// `context`: which note this is, shown above the box when it is docked away from its passage (user 2026-11-17: editing
// from the list on a phone hid the quoted text).
const props = defineProps({ comment: { type: String, default: "" }, inline: Boolean, removable: { type: Boolean, default: true }, context: { type: String, default: "" } });
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
  <form v-float-box="!inline" class="selection-comment excerpt-edit" :class="{ 'is-inline': inline, 'has-context': context }" @submit.prevent="emit('save', draft.trim())">
    <small v-if="context" class="excerpt-edit-context">{{ context }}</small>
    <textarea ref="input" v-model="draft" rows="1" :placeholder="t('添加批注（可选）')" :aria-label="t('注释的批注')" enterkeyhint="done" @keydown="keydown"></textarea>
    <div class="selection-comment-actions">
      <button v-if="removable" type="button" class="selection-comment-remove" :aria-label="t('移除这条注释')" :title="t('移除注释')" @click="emit('remove')"><UIcon name="i-lucide-trash-2" /></button>
      <button type="button" class="selection-comment-cancel" :aria-label="t('取消')" :title="t('取消')" @click="emit('cancel')"><UIcon name="i-lucide-x" /></button>
      <button type="submit" class="selection-comment-send" :aria-label="t('保存')" :title="t('保存（Enter）')"><UIcon name="i-lucide-check" /></button>
    </div>
  </form>
</template>

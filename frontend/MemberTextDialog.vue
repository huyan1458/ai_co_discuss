<script setup>
/**
 * One dialog shape for a member's long text (its description, its expert prompt): an optional saved source to start from,
 * the text, a live note on what saving it will mean, and the actions. Callers own the meaning; this owns the layout.
 */
import { computed } from "vue";

const props = defineProps({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  label: { type: String, required: true },
  placeholder: { type: String, default: "" },
  max: { type: Number, required: true },
  rows: { type: Number, default: 5 },
  /** What saving the current text will mean, updated as the user types. */
  note: { type: String, default: "" },
  /** A saved text the draft may start from, such as a platform default or a software preset: { tag, text, action }. */
  source: { type: Object, default: null },
  changed: Boolean,
  saving: Boolean,
});
const open = defineModel("open", { type: Boolean, default: false });
const draft = defineModel("draft", { type: String, default: "" });
const emit = defineEmits(["save"]);
// The counter only draws attention once the limit is close.
const near_limit = computed(() => draft.value.length >= props.max * 0.9);

/** Saving an unchanged text would only close the dialog, so the button and the shortcut both wait for a change. */
function save() {
  if (props.changed && !props.saving) emit("save");
}
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="description" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="member-text" @submit.prevent="save">
        <div v-if="source" class="member-text-source">
          <UIcon name="i-lucide-bookmark" />
          <p><b>{{ source.tag }}</b>{{ source.text }}</p>
          <button type="button" @click="draft = source.text">{{ source.action }}</button>
        </div>
        <UTextarea v-model="draft" :rows="rows" :maxlength="max" autoresize :maxrows="rows * 2" autofocus class="w-full" :aria-label="label" :placeholder="placeholder"
          @keydown.enter.ctrl.prevent="save" @keydown.enter.meta.prevent="save" />
        <div class="member-text-meta">
          <span>{{ note }}</span>
          <span :class="{ 'is-near': near_limit }">{{ draft.length }} / {{ max }}</span>
        </div>
        <div class="member-text-footer">
          <div><slot name="extra" /></div>
          <UButton label="取消" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" label="保存" class="channel-primary-button" :loading="saving" :disabled="!changed" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.member-text { display: grid; gap: 8px; }
.member-text-source { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 8px; padding: 8px 10px; border: 1px dashed var(--ui-border-accented); border-radius: 6px; color: var(--ui-text-muted); font-size: 12px; }
.member-text-source > span { width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
.member-text-source > p { display: -webkit-box; overflow: hidden; margin: 0; line-height: 1.6; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: pre-line; }
.member-text-source b { margin-right: 6px; color: var(--ui-text-toned); font-weight: 500; }
.member-text-source > button { padding: 0 6px; border-radius: 4px; color: var(--channel-accent); font-size: 12px; line-height: 20px; white-space: nowrap; }
.member-text-source > button:hover { background: var(--ui-bg-accented); }
.member-text-meta { display: flex; justify-content: space-between; gap: 12px; margin-top: -2px; color: var(--ui-text-dimmed); font-size: 11px; }
.member-text-meta > span:last-child { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.member-text-meta > .is-near { color: var(--ui-warning, #e0a33a); }
.member-text-footer { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.member-text-footer > div { flex: 1; min-width: 0; }
</style>

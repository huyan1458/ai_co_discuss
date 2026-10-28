<script setup>
/** The "添加" row of brand chips shared by members and the decision model; each chip emits its value. */
import { ref } from "vue";

defineProps({
  label: { type: String, required: true },
  // Each item: { value, name, icon, initials, style, title, aria_label, disabled, separated }; separated starts a second group.
  items: { type: Array, required: true },
});
const emit = defineEmits(["add"]);
const row = ref(null);
/** Return keyboard focus to the first chip that can still be added. */
function focus_first() {
  row.value?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}
defineExpose({ focus_first });
</script>

<template>
  <div ref="row" class="roster-add" role="group" :aria-label="label">
    <span class="roster-add-label">添加</span>
    <button v-for="item in items" :key="item.value" type="button" :class="{ 'is-separated': item.separated }" :disabled="item.disabled" :title="item.title" :aria-label="item.aria_label" @click="emit('add', item.value)">
      <UAvatar :src="item.icon" :text="item.initials" :alt="item.name" size="3xs" class="channel-avatar" :class="item.style" />{{ item.name }}<UIcon name="i-lucide-plus" />
    </button>
  </div>
</template>

<style scoped>
.roster-add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.roster-add-label { margin-right: 2px; color: var(--ui-text-toned); font-size: 12px; }
.roster-add > button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 8px 2px 4px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.roster-add > button:hover:not(:disabled) { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.roster-add > button:disabled { opacity: .45; }
/* A divider before the first item of the second group (the presets after the platforms). */
.roster-add > button.is-separated { position: relative; margin-left: 13px; }
.roster-add > button.is-separated::before { position: absolute; left: -10px; top: 6px; bottom: 6px; width: 1px; background: var(--ui-border); content: ""; }
.roster-add .channel-avatar { flex-shrink: 0; width: 20px; height: 20px; font-size: 9px; }
.roster-add > button > span:last-child { width: 12px; height: 12px; color: var(--ui-text-muted); }
@media (pointer: coarse) { .roster-add > button { min-height: 44px; } }
</style>

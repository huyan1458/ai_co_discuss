<script setup>
/** The "添加" row of brand chips shared by members and the decision model; each chip emits its value. */
import { computed, ref } from "vue";

const props = defineProps({
  label: { type: String, required: true },
  // Each item: { value, name, icon, initials, style, title, aria_label, disabled, selected, separated, removable }; separated starts a second row (the presets); selected marks the chip filling a single slot; removable lets the row's 管理 mode show a delete button that emits remove.
  items: { type: Array, required: true },
});
const emit = defineEmits(["add", "remove"]);
const row = ref(null);
// Delete buttons show only while the user manages the row, so a stray click cannot delete a preset.
const managing = ref(false);
/** Platforms and presets each get a labelled row, so wrapped chips line up under the first chip instead of the label. */
const groups = computed(() => {
  const split = props.items.findIndex((item) => item.separated);
  if (split < 0) return [{ label: "添加", items: props.items }];
  return [{ label: "添加", items: props.items.slice(0, split) }, { label: "预设", items: props.items.slice(split) }].filter((group) => group.items.length);
});
/** Return keyboard focus to the first chip that can still be added. */
function focus_first() {
  row.value?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
}
defineExpose({ focus_first });
</script>

<template>
  <div ref="row" class="roster-add" role="group" :aria-label="label">
    <template v-for="group in groups" :key="group.label">
      <span class="roster-add-label">{{ group.label }}</span>
      <div class="roster-add-chips">
        <span v-for="item in group.items" :key="item.value" class="roster-add-chip" :class="{ 'is-selected': item.selected, 'is-disabled': item.disabled, 'is-removable': managing && item.removable }">
          <button type="button" class="roster-add-main" :disabled="item.disabled" :title="item.title" :aria-label="item.aria_label" :aria-pressed="item.selected === undefined ? undefined : item.selected" @click="emit('add', item.value)">
            <UAvatar :src="item.icon" :text="item.initials" :alt="item.name" size="3xs" class="channel-avatar" :class="item.style" /><span class="roster-add-name">{{ item.name }}</span><UIcon v-if="!(managing && item.removable)" :name="item.selected ? 'i-lucide-check' : 'i-lucide-plus'" class="roster-add-mark" />
          </button>
          <button v-if="managing && item.removable" type="button" class="roster-add-remove" :title="`删除预设「${item.name}」`" :aria-label="`删除预设 ${item.name}`" @click="emit('remove', item.value)"><UIcon name="i-lucide-x" /></button>
        </span>
        <button v-if="group.items.some((item) => item.removable)" type="button" class="roster-add-manage" :aria-pressed="managing" @click="managing = !managing">{{ managing ? '完成' : '管理' }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Labels share one narrow column; each row's chips wrap inside the second column. */
.roster-add { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 8px 10px; }
.roster-add-label { color: var(--ui-text-toned); font-size: 12px; line-height: 30px; white-space: nowrap; }
.roster-add-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.roster-add-chip { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; height: 30px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); }
.roster-add-chip:hover:not(.is-disabled) { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.roster-add-chip.is-disabled { opacity: .45; }
.roster-add-chip.is-selected { border-color: var(--channel-accent); color: var(--ui-text-highlighted); }
.roster-add-main { display: inline-flex; align-items: center; gap: 6px; min-width: 0; height: 100%; padding: 0 9px 0 4px; border-radius: inherit; font-size: 12px; }
.roster-add-chip.is-removable .roster-add-main { padding-right: 4px; }
.roster-add-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.roster-add .channel-avatar { flex-shrink: 0; width: 22px; height: 22px; font-size: 9px; }
/* A platform without a logo shows its initials on the same round plate as the logos. */
.roster-add .channel-avatar:not(:has(img)) { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.roster-add-mark { flex-shrink: 0; width: 12px; height: 12px; color: var(--ui-text-muted); }
.roster-add-chip.is-selected .roster-add-mark { color: var(--channel-accent); }
/* While managing, each preset is deleted from inside its chip. */
.roster-add-remove { display: grid; place-items: center; flex-shrink: 0; width: 22px; height: 22px; margin-right: 4px; border-left: 1px solid var(--ui-border-muted); border-radius: 0 999px 999px 0; color: var(--ui-text-dimmed); }
.roster-add-remove:hover { color: var(--ui-error, #e5484d); }
.roster-add-remove > span { width: 12px; height: 12px; }
.roster-add-manage { height: 30px; padding: 0 8px; color: var(--ui-text-muted); font-size: 12px; }
.roster-add-manage:hover, .roster-add-manage[aria-pressed="true"] { color: var(--ui-text-highlighted); }
/* Touch screens: chips, delete buttons and 管理 get finger-sized targets. */
@media (pointer: coarse) {
  .roster-add-label { line-height: 36px; }
  .roster-add-chip, .roster-add-manage { height: 36px; }
  .roster-add-remove { width: 32px; height: 32px; margin-right: 2px; }
}
</style>

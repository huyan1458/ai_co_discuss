<script setup>
import { t } from './i18n.js';
/**
 * A member's display name that the owner renames in place: double-click it, type, then Enter or click away to save;
 * Escape leaves it as it was. Saving only changes what screens show, the member ID stays. The rail and the room
 * overview both show names through this, and the "名称与描述" dialog edits the same value.
 */
import { computed, inject, nextTick, ref } from "vue";
import { MAX_LABEL } from "./member-actions.js";

const props = defineProps({
  /** The member ID. */
  name: { type: String, required: true },
  editable: Boolean,
});
const { view, bridge } = inject("discussion");
const editing = ref(false), draft = ref(""), field = ref(null);
// The name just sent, shown until the room reports it, so the old name never flashes back.
const sent = ref(null);
const shown = computed(() => sent.value ?? bridge.display_name(props.name));

async function start() {
  if (!props.editable || sent.value !== null) return;
  draft.value = shown.value;
  editing.value = true;
  await nextTick();
  field.value?.focus();
  field.value?.select();
}

/** Save the typed name; an empty one or the member's default name removes the display name. */
async function commit() {
  if (!editing.value) return;
  editing.value = false;
  const typed = draft.value.trim();
  if (typed === shown.value) return;
  const room = view.value.room;
  const label = typed === bridge.default_name(props.name) ? "" : typed;
  sent.value = typed || bridge.default_name(props.name);
  try { await bridge.describe_member(props.name, room.descriptions?.[props.name] || "", label); }
  catch { /* The controller shows the error as a toast. */ }
  finally { sent.value = null; }
}

/** Enter saves, except the Enter that confirms an input-method candidate. */
function enter(event) {
  if (event.isComposing) return;
  event.preventDefault();
  commit();
}

function cancel() {
  editing.value = false;
}
</script>

<template>
  <input v-if="editing" ref="field" v-model="draft" class="member-name-input" :maxlength="MAX_LABEL" :aria-label="t('{value1} 的显示名称', { value1: name })"
    :placeholder="bridge.default_name(name)" @keydown.enter="enter" @keydown.esc.prevent.stop="cancel" @blur="commit" @dblclick.stop />
  <span v-else class="member-name-text" :class="{ 'is-editable': editable }" :title="editable ? t('双击重命名') : undefined" @dblclick="start">{{ shown }}</span>
</template>

<style scoped>
.member-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.member-name-text.is-editable { cursor: text; }
.member-name-input { flex: 1; min-width: 60px; width: 100%; margin: -2px -5px; padding: 1px 4px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 4px; outline: none; background: var(--ui-bg); color: var(--ui-text-highlighted); font: inherit; }
</style>

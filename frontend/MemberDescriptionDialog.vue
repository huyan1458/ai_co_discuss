<script setup>
/**
 * Edit one member's display name and description: what it is good at and what work suits it. The smart scheduler and
 * the AI host read the description when dividing work; the display name only changes what screens show, the member ID
 * stays. Shared by the expert card (before a room exists) and the board's member menu (in a room).
 */
import { computed, ref, watch } from "vue";
import MemberTextDialog from "./MemberTextDialog.vue";

const MAX_DESCRIPTION = 500;
const MAX_LABEL = 32;
const props = defineProps({
  name: { type: String, required: true },
  platform: { type: String, default: "" },
  text: { type: String, default: "" },
  /** The display name the room or card shows for this member; empty shows its member ID's default name. */
  label: { type: String, default: "" },
  /** The name shown when no display name is set: the platform's nickname for its ID, else the ID. */
  default_label: { type: String, default: "" },
  /** The platform's saved default, offered when the draft differs from it. */
  template: { type: String, default: "" },
  saving: Boolean,
});
const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["save"]);
const draft = ref(""), label_draft = ref(""), as_template = ref(false);
// Boards clear the member as soon as the dialog closes, so the closing animation keeps what it opened with.
const shown = ref({ name: "", platform: "", text: "", template: "", label: "", default: "" });
watch(open, (value) => {
  if (!value) return;
  shown.value = { name: props.name, platform: props.platform, text: props.text.trim(), template: props.template.trim(), label: props.label.trim(), default: props.default_label || props.name };
  draft.value = props.text;
  label_draft.value = props.label;
  as_template.value = false;
}, { immediate: true });
const trimmed = computed(() => draft.value.trim());
const source = computed(() => shown.value.template && trimmed.value !== shown.value.template
  ? { tag: `${shown.value.platform} 的默认描述`, text: shown.value.template, action: "填入" } : null);
// Saving an empty or already-default text as the default changes nothing.
const can_template = computed(() => Boolean(shown.value.platform && trimmed.value && trimmed.value !== shown.value.template));
const label_changed = computed(() => label_draft.value.trim() !== shown.value.label);
const changed = computed(() => trimmed.value !== shown.value.text || label_changed.value || as_template.value && can_template.value);
const note = computed(() => as_template.value && can_template.value ? `之后添加 ${shown.value.platform} 时自动填入这段描述`
  : trimmed.value ? "标签或一段话都行，Ctrl + Enter 保存" : "留空表示不提供描述");
watch(can_template, (value) => { if (!value) as_template.value = false; });

function save() {
  emit("save", { text: trimmed.value, label: label_changed.value ? label_draft.value.trim() : undefined, as_template: as_template.value && can_template.value });
}
</script>

<template>
  <MemberTextDialog v-model:open="open" v-model:draft="draft" :title="`${shown.label || shown.default} 的名称与描述`"
    description="名称只改显示的名字，成员 ID 不变。描述写擅长什么、适合分到什么工作，智能调度和 AI 主持人分派时参考，房间所有成员都能看到。"
    :label="`${shown.name} 的描述`" placeholder="例如：擅长前端和交互细节，适合出方案、做评审；大段重构交给别人" :max="MAX_DESCRIPTION"
    :note="note" :source="source" :changed="changed" :saving="saving" @save="save">
    <template #lead>
      <label class="member-label-field"><span>显示名称</span>
        <UInput v-model="label_draft" :maxlength="MAX_LABEL" :placeholder="`留空显示 ${shown.default}`" :aria-label="`${shown.name} 的显示名称`" class="w-full" />
      </label>
    </template>
    <template #extra>
      <UCheckbox v-if="can_template" v-model="as_template" :label="`存为 ${shown.platform} 的默认描述`" />
    </template>
  </MemberTextDialog>
</template>

<style scoped>
.member-label-field { display: grid; gap: 6px; color: var(--ui-text-muted); font-size: 12px; }
</style>

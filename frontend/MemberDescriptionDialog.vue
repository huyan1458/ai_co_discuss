<script setup>
/**
 * Edit one member's description: what it is good at and what work suits it. The smart scheduler and the AI host
 * read it when dividing work. Shared by the expert card (before a room exists) and the board's member menu (in a room).
 */
import { computed, ref, watch } from "vue";
import MemberTextDialog from "./MemberTextDialog.vue";

const MAX_DESCRIPTION = 500;
const props = defineProps({
  name: { type: String, required: true },
  platform: { type: String, default: "" },
  text: { type: String, default: "" },
  /** The platform's saved default, offered when the draft differs from it. */
  template: { type: String, default: "" },
  saving: Boolean,
});
const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["save"]);
const draft = ref(""), as_template = ref(false);
// Boards clear the member as soon as the dialog closes, so the closing animation keeps what it opened with.
const shown = ref({ name: "", platform: "", text: "", template: "" });
watch(open, (value) => {
  if (!value) return;
  shown.value = { name: props.name, platform: props.platform, text: props.text.trim(), template: props.template.trim() };
  draft.value = props.text;
  as_template.value = false;
}, { immediate: true });
const trimmed = computed(() => draft.value.trim());
const source = computed(() => shown.value.template && trimmed.value !== shown.value.template
  ? { tag: `${shown.value.platform} 的默认描述`, text: shown.value.template, action: "填入" } : null);
// Saving an empty or already-default text as the default changes nothing.
const can_template = computed(() => Boolean(shown.value.platform && trimmed.value && trimmed.value !== shown.value.template));
const changed = computed(() => trimmed.value !== shown.value.text || as_template.value && can_template.value);
const note = computed(() => as_template.value && can_template.value ? `之后添加 ${shown.value.platform} 时自动填入这段描述`
  : trimmed.value ? "标签或一段话都行，Ctrl + Enter 保存" : "留空表示不提供描述");
watch(can_template, (value) => { if (!value) as_template.value = false; });

function save() {
  emit("save", { text: trimmed.value, as_template: as_template.value && can_template.value });
}
</script>

<template>
  <MemberTextDialog v-model:open="open" v-model:draft="draft" :title="`${shown.name} 的描述`"
    description="擅长什么、适合分到什么工作。智能调度和 AI 主持人分派时参考，房间所有成员都能看到。"
    :label="`${shown.name} 的描述`" placeholder="例如：审美好，UI 写得好，制定的计划完善" :max="MAX_DESCRIPTION"
    :note="note" :source="source" :changed="changed" :saving="saving" @save="save">
    <template #extra>
      <UCheckbox v-if="can_template" v-model="as_template" :label="`存为 ${shown.platform} 的默认描述`" />
    </template>
  </MemberTextDialog>
</template>

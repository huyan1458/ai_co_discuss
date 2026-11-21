<script setup>
import { t } from './i18n.js';
/**
 * Edit one member's display name and description: what it is good at and what work suits it. The smart scheduler and
 * the AI host read the description when dividing work; the display name only changes what screens show, the member ID
 * stays. Shared by the expert card (before a room exists) and the board's member menu (in a room).
 */
import { computed, ref, watch } from "vue";
import MemberTextDialog from "./MemberTextDialog.vue";
import { MAX_LABEL } from "./member-actions.js";

const MAX_DESCRIPTION = 500;
// Common kinds of work, added to the description with one click so it need not start from a blank box.
const SNIPPETS = [t('出方案'), t('做评审'), t('写代码'), t('查资料'), t('写文档'), t('测试验收')];
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
  /** Float beside what opened it: { top, right, width }; see MemberTextDialog. */
  anchor: { type: Object, default: null },
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
  ? { tag: t('{value1} 的默认描述', { value1: shown.value.platform }), text: shown.value.template, action: t('填入') } : null);
// Saving an empty or already-default text as the default changes nothing.
const can_template = computed(() => Boolean(shown.value.platform && trimmed.value && trimmed.value !== shown.value.template));
const label_changed = computed(() => label_draft.value.trim() !== shown.value.label);
const changed = computed(() => trimmed.value !== shown.value.text || label_changed.value || as_template.value && can_template.value);
const note = computed(() => as_template.value && can_template.value ? t('之后添加 {value1} 时自动填入这段描述', { value1: shown.value.platform })
  : trimmed.value ? t('标签或一段话都行，Ctrl + Enter 保存') : t('留空表示不提供描述'));
watch(can_template, (value) => { if (!value) as_template.value = false; });
const snippets = computed(() => SNIPPETS.filter((snippet) => !draft.value.includes(snippet) && draft.value.length + snippet.length < MAX_DESCRIPTION));

/** Append one kind of work to the description, separated from what is already there. */
function add_snippet(snippet) {
  const text = draft.value.trimEnd();
  draft.value = text && !/[、，,；;。.：:]$/.test(text) ? text + t('、') + snippet : text + snippet;
}

function save() {
  emit("save", { text: trimmed.value, label: label_changed.value ? label_draft.value.trim() : undefined, as_template: as_template.value && can_template.value });
}
</script>

<template>
  <MemberTextDialog v-model:open="open" v-model:draft="draft" :title="t('{value1} 的名称与描述', { value1: shown.label || shown.default })"
    :caption="t('描述')" :hint="t('智能调度和 AI 主持人分派时参考，房间所有成员都能看到')" :anchor="anchor"
    :label="t('{value1} 的描述', { value1: shown.name })" :placeholder="t('例如：擅长前端和交互细节，适合出方案、做评审；大段重构交给别人')" :max="MAX_DESCRIPTION"
    :note="note" :source="source" :changed="changed" :saving="saving" @save="save">
    <template #lead>
      <label class="member-label-field"><span>{{ t('显示名称') }}</span>
        <UInput v-model="label_draft" :maxlength="MAX_LABEL" :placeholder="t('留空显示 {value1}', { value1: shown.default })" :aria-label="t('{value1} 的显示名称', { value1: shown.name })" class="w-full" />
        <small>{{ t('只改显示的名字，成员 ID {value1} 不变', { value1: shown.name }) }}</small>
      </label>
    </template>
    <template #below>
      <div v-if="snippets.length" class="member-snippets" :aria-label="t('常见分工')">
        <button v-for="snippet in snippets" :key="snippet" type="button" @click="add_snippet(snippet)"><UIcon name="i-lucide-plus" />{{ snippet }}</button>
      </div>
    </template>
    <template #extra>
      <UCheckbox v-if="can_template" v-model="as_template" :label="t('存为 {value1} 的默认描述', { value1: shown.platform })" />
    </template>
  </MemberTextDialog>
</template>

<style scoped>
.member-label-field { display: grid; gap: 6px; color: var(--ui-text-muted); font-size: 12px; }
.member-label-field > small { color: var(--ui-text-dimmed); font-size: 11px; }
.member-snippets { display: flex; flex-wrap: wrap; gap: 6px; }
.member-snippets > button { display: inline-flex; align-items: center; gap: 3px; padding: 0 8px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-muted); font-size: 11px; line-height: 20px; }
.member-snippets > button:hover { border-color: var(--channel-accent); color: var(--channel-accent); }
.member-snippets > button > span { width: 11px; height: 11px; }
</style>

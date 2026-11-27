<script setup>
import { computed, inject, nextTick, reactive, ref, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { access_options } from "../runner/expert_prompts.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import { locale, t } from "./i18n.js";

const { view, bridge } = inject("discussion");
const props = defineProps({ openRequest: { type: Number, default: 0 } });
const section = ref(null);
const open = ref(false);
const saved = ref(null);
const draft = ref({});
const skills = ref([]);
const saving = ref(false);
const history = ref(null);
const history_target = ref(null);
const deleting_history = reactive(new Set());
const deleted_history = new Set();
let history_read = 0;
const visible_history = computed(() => history.value?.filter(room => !deleting_history.has(room.room_id)));
const adapters = computed(() => {
  const ids = new Set(Object.values(view.value.launch.saved_profiles || {}).map(profile => profile.adapter));
  if (draft.value.adapter) ids.add(draft.value.adapter);
  return [...ids].filter(id => id && adapter_profile(id)).map(id => ({ value: id, label: t(adapter_profile(id).label) }));
});
const efforts = computed(() => [{ value: "default", label: t("CLI 默认") },
  ...(adapter_profile(draft.value.adapter)?.efforts || []).map(value => ({ value, label: value }))]);
const access_items = computed(() => access_options(draft.value.adapter, bridge.full_only_hint(draft.value.adapter))
  .map(item => ({ ...item, label: t(item.label) })));
const changed = computed(() => saved.value ? Object.fromEntries(Object.entries(draft.value)
  .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved.value[key]))) : {});
const skill_labels = {
  "dispatch-analysis": t("派活分析"),
  "share-card": t("AI 制作分享卡"),
  "local-tts-setup": t("安装本机朗读"),
  "local-stt-setup": t("安装本机语音输入"),
  "notify-setup": t("配置通知渠道"),
  "discuss-report": t("整理讨论报告"),
  "codiscuss-draft-cleanup": t("共议占用盘点与清理"),
  "cloudflare-deploy": t("部署线上站点"),
};

/** Load this computer's archived steward conversations without blocking settings. */
async function load_history() {
  const reading = ++history_read;
  try {
    const { rooms } = await bridge.local_request("steward-history", {});
    if (reading === history_read) history.value = rooms.filter(room => !deleted_history.has(room.room_id));
  } catch (error) { if (reading === history_read) bridge.notify("error", error.message); }
}

function history_label(room) {
  const adapter = adapter_profile(room.adapter);
  const date = room.archived_at ? new Date(room.archived_at).toLocaleString(locale) : "";
  return [adapter ? t(adapter.label) : room.adapter, date, room.room_id].filter(Boolean).join(" · ");
}

async function open_history_room(room_id) {
  try { await bridge.show_steward_room(room_id); }
  catch (error) { bridge.notify("error", error.message); }
}

/** Hide only the chosen room until the computer confirms deletion, then remove it from the snapshot. */
async function delete_history_room() {
  const room_id = history_target.value?.room_id;
  if (!room_id || deleting_history.has(room_id)) return;
  deleting_history.add(room_id);
  try {
    await bridge.local_request("steward-delete", { room_id });
    deleted_history.add(room_id);
    history.value = history.value?.filter(room => room.room_id !== room_id) ?? null;
  } catch (error) { bridge.notify("error", error.message); }
  finally { deleting_history.delete(room_id); }
}

/** Show server defaults until the user changes a field. Only edited fields are saved. */
async function load() {
  try {
    const status = await bridge.local_request("steward", {});
    saved.value = { ...status.settings, ...(status.configured === false ? { adapter: "" } : {}) };
    draft.value = { ...saved.value };
    skills.value = status.skills;
  } catch (error) { bridge.notify("error", error.message); }
}
watch(open, (shown) => {
  if (!shown) return;
  if (!saved.value) load();
  load_history();
});
watch(() => props.openRequest, async (request) => {
  if (!request) return;
  open.value = true;
  await nextTick();
  section.value?.scrollIntoView({ block: "start" });
}, { immediate: true });

function choose_adapter(adapter) {
  draft.value = { ...draft.value, adapter, model: "", effort: "" };
  const supported = access_items.value.filter(item => !item.disabled);
  if (!supported.some(item => item.value === draft.value.project_access)) draft.value.project_access = supported[0]?.value || "auto";
}

function allow_skill(id, allowed) {
  const selected = new Set(draft.value.skills);
  if (allowed) selected.add(id); else selected.delete(id);
  draft.value.skills = skills.value.map(skill => skill.id).filter(id => selected.has(id));
}

/** Apply the submitted snapshot without losing edits typed while the write was in flight. */
async function save() {
  if (saving.value || !Object.keys(changed.value).length) return;
  const patch = changed.value;
  saving.value = true;
  try {
    const status = await bridge.local_request("steward-settings", patch);
    for (const key of Object.keys(status.settings)) {
      if (JSON.stringify(draft.value[key]) === JSON.stringify(patch[key] ?? saved.value[key])) draft.value[key] = status.settings[key];
    }
    saved.value = status.settings;
    skills.value = status.skills;
    if (Object.hasOwn(patch, "skills")) document.dispatchEvent(new Event("discuss:steward-skills-changed"));
    if (Object.hasOwn(patch, "adapter")) load_history();
    bridge.notify("info", t("已保存"));
  } catch (error) { bridge.notify("error", error.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <section ref="section" class="channel-reading-setting">
    <UCollapsible v-model:open="open">
      <button type="button" class="flex w-full items-center justify-between" :aria-expanded="open">
        <h3 class="!mb-0">{{ t("平台主理人") }}</h3>
        <UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <form v-if="saved" class="grid gap-3 pt-3" @submit.prevent="save">
          <UFormField :label="t('软件')"><USelect :model-value="draft.adapter || undefined" :items="adapters" :placeholder="t('选择软件')" class="w-full" @update:model-value="choose_adapter" /></UFormField>
          <UFormField :label="t('模型')"><UInput v-model="draft.model" :placeholder="t('软件默认模型')" class="w-full" /></UFormField>
          <UFormField :label="t('强度')"><USelect :model-value="draft.effort || 'default'" :items="efforts" class="w-full" @update:model-value="draft.effort = $event === 'default' ? '' : $event" /></UFormField>
          <UFormField :label="t('项目权限')"><USelect v-model="draft.project_access" :items="access_items" class="w-full" /></UFormField>
          <UFormField :label="t('工作目录')"><UInput v-model.trim="draft.cwd" :placeholder="t('已有目录的完整路径')" class="w-full" /></UFormField>
          <fieldset class="grid gap-2">
            <legend class="mb-2 text-sm">{{ t("允许的技能") }}</legend>
            <UCheckbox v-for="skill in skills" :key="skill.id" :label="skill_labels[skill.id] || skill.id" :disabled="!skill.available"
              :model-value="draft.skills?.includes(skill.id)" @update:model-value="allow_skill(skill.id, $event)" />
          </fieldset>
          <UButton type="submit" class="justify-self-start" :label="t('保存')" :loading="saving" :disabled="!Object.keys(changed).length" />
        </form>
        <div class="mt-4">
          <h4>{{ t("旧对话") }}</h4>
          <p v-if="visible_history && !visible_history.length" class="fine-print">{{ t("没有存档的主理人对话") }}</p>
          <ul v-else-if="visible_history" class="grid gap-2 mt-2">
            <li v-for="room in visible_history" :key="room.room_id" class="flex flex-wrap items-center gap-2">
              <span class="grow">{{ history_label(room) }}</span>
              <UButton :label="t('打开')" color="neutral" variant="soft" size="xs" @click="open_history_room(room.room_id)" />
              <UButton :label="t('删除')" color="error" variant="ghost" size="xs" @click="history_target = room" />
            </li>
          </ul>
        </div>
      </template>
    </UCollapsible>
    <ConfirmDialog :open="Boolean(history_target)" :title="t('删除主理人旧对话')" :description="t('这会永久删除该对话的历史记录，不能撤销。')"
      :confirm-label="t('删除')" danger @update:open="!$event && (history_target = null)" @confirm="delete_history_room" />
  </section>
</template>

<script setup>
/**
 * 专家配置: every card of the open workflow (main flow and sub-workflows) in a large dialog, a list on the left and the
 * chosen card on the right in three tabs: 基础 (role name, description, software, model, strength, project access),
 * 提示词 (its expert prompt, full height) and 技能 (user 2026-11-23: the old single column could not hold an advisor's
 * skills). On a phone the list and the card show one at a time. The canvas cards only say who each one is (user
 * 2026-11-17). Edits go into the open draft and are written by the dialog's own 保存 bar (the same save as the page's).
 * A card naming software this computer has not set up is marked. Experts with skills (folder cards, user 2026-11-22)
 * are listed together as 顾问 wherever they sit; their skills are edited straight on disk (ExpertSkills), while a
 * first skill on another card changes the workflow's shape and waits for 保存.
 * With `preset` set it is a panel preset's 高级配置 instead: only that advisor's skills, no list and no save bar.
 */
import { computed, inject, ref, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { EXPERT_PROMPT_PRESETS, MAX_EXPERT_PROMPT, access_options } from "../runner/expert_prompts.mjs";
import { use_workflow_library } from "./workflow-library.js";
import { download_expert, expert_files_from_folder, expert_files_from_md, expert_files_from_zip } from "./workflow-files.js";
import ExpertSkills from "./ExpertSkills.vue";
import { t } from './i18n.js';

const open = defineModel("open", { type: Boolean, default: false });
// The card shown on the right; empty opens at the first card.
const focus = defineModel("focus", { type: String, default: "" });
// A panel preset's 高级配置 (`{ name, label }`): its skills only; empty for the workflow's 专家配置.
const props = defineProps({ preset: { type: Object, default: null } });
const { view, bridge } = inject("discussion");
const { draft, subs, saved_id, dirty, scope, reload, save, busy } = use_workflow_library();
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const DEFAULT_MODEL = "__default__";
// A select option cannot have an empty value; the card stores the default strength as "".
const DEFAULT_EFFORT = "__default__";
// A description is one or two sentences: what this role answers for, shown on the canvas card when pointed at.
const MAX_DESCRIPTION = 200;
// A role name fits a card's title line.
const MAX_LABEL = 32;

// The platforms cards may name on this computer; none listed means the list is not known (no local service).
const ready = computed(() => view.value.launch.card_platforms || []);
// A card with skills is a folder card: an expert keeping its own knowledge.
const has_skills = (agent) => Array.isArray(agent.skills);
const all_parts = computed(() => !draft.value ? [] : [{ key: "", label: t('主线'), part: draft.value },
  ...subs.value.map((sub) => ({ key: sub.id, label: sub.label || sub.id, part: sub }))]);
// The list's groups: the main flow and each sub-workflow with their other cards, then every expert with skills as 顾问.
const parts = computed(() => {
  const groups = all_parts.value.map((item) => ({ key: item.key, label: item.label, entries: item.part.agents.filter((agent) => !has_skills(agent))
    .map((agent) => ({ part: item.part, agent })) })).filter((item) => item.entries.length);
  const advisors = all_parts.value.flatMap((item) => item.part.agents.filter(has_skills).map((agent) => ({ part: item.part, agent, where: item.label })));
  return [...groups, ...(advisors.length ? [{ key: "@advisors", label: t('顾问'), entries: advisors }] : [])];
});
const entries = computed(() => parts.value.flatMap((item) => item.entries));
const current = computed(() => entries.value.find((entry) => entry.agent.card === focus.value) || entries.value[0] || null);
const tab = ref("basic");
const tabs = computed(() => [{ label: t('基础'), value: "basic" }, { label: t('提示词'), value: "prompt" }, { label: t('技能'), value: "skills" }]);
// Phone: whether the chosen card shows instead of the list. Opening on a given card (from the canvas) goes straight to it.
const picked = ref(false);
watch(open, (shown) => { if (shown) picked.value = Boolean(focus.value); });
function pick_card(card) { focus.value = card; picked.value = true; }
// 存为面板预设 copies the card as saved; "taken" holds the card whose preset name is in use until the user chooses to replace it.
const preset_saving = ref(false), preset_taken = ref("");
// The card whose preset was saved while this computer's skills for it were kept, until the user decides.
const preset_kept = ref("");
watch(() => current.value?.agent.card, () => { preset_taken.value = ""; preset_kept.value = ""; });
/** Download the chosen card as an expert: its md, or with knowledge a zip of its definition and skills. */
async function export_card() {
  const card = current.value?.agent.card;
  if (!card || !saved_id.value) return;
  try { download_expert(await bridge.local_request("workflows", { action: "export-expert", workflow: saved_id.value, card })); }
  catch (error) { bridge.notify("error", error.message); }
}
async function save_as_preset(overwrite = false, replace_knowledge = false) {
  const card = current.value?.agent.card;
  if (!card || preset_saving.value) return;
  preset_saving.value = true;
  try {
    const { preset, knowledge } = await bridge.save_card_preset({ id: saved_id.value, card, ...(overwrite ? { overwrite: true } : {}),
      ...(replace_knowledge ? { replace_knowledge: true } : {}) });
    preset_taken.value = "";
    preset_kept.value = knowledge === "kept" ? card : "";
    if (knowledge === "kept") bridge.notify("warning", t('已存为面板预设「{value1}」；本机已有这位专家的技能，已保留本机的', { value1: preset.label || preset.name }));
    else bridge.notify("info", t('已存为面板预设「{value1}」', { value1: preset.label || preset.name }) + (knowledge === "replaced" ? t('；本机原来的技能已备份') : ""));
  } catch (error) {
    if (error.code === "preset_exists") preset_taken.value = card;
    bridge.notify(error.code === "preset_exists" ? "warning" : "error", error.message);
  } finally { preset_saving.value = false; }
}

/** 添加技能: a card's first skill makes it a folder card; it is written by the workflow's 保存, checked against its revision. */
const skill_name = ref(""), skill_description = ref("");
const SKILL_NAME = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
function add_first_skill(part, agent) {
  const name = skill_name.value.trim(), description = skill_description.value.trim().replace(/\s*\n\s*/g, " ");
  if (!SKILL_NAME.test(name)) return bridge.notify("warning", t("技能名只能用小写英文和数字，可用单个连字符连接，1—40 位"));
  if (!description) return bridge.notify("warning", t("请写一句描述：这条技能管什么"));
  update(part, agent.card, { skills: [name], knowledge: { [`${name}/SKILL.md`]: `---\nname: ${name}\ndescription: ${description}\n---\n` } });
  skill_name.value = ""; skill_description.value = "";
  bridge.notify("info", t("已添加技能；保存工作流后生效，这张卡片会变成带技能的文件夹"));
}
/** Why a card's skills cannot be edited here yet. */
function skills_blocked(agent) {
  if (!saved_id.value) return t("先保存工作流");
  return agent.knowledge !== undefined ? t("保存工作流后才能编辑技能") : "";
}

/** 导入专家包: an expert package goes into the saved workflow's part on the canvas now (main flow or a sub-workflow). */
const package_inputs = { md: ref(null), zip: ref(null), folder: ref(null) };
const package_target = computed(() => subs.value.find((sub) => sub.id === scope.value) || null);
const package_items = computed(() => [[
  { label: t('专家包（.md）'), icon: "i-lucide-file-text", onSelect: () => package_inputs.md.value?.click() },
  { label: t('专家包（压缩包）'), icon: "i-lucide-file-archive", onSelect: () => package_inputs.zip.value?.click() },
  { label: t('专家包（文件夹）'), icon: "i-lucide-folder-input", onSelect: () => package_inputs.folder.value?.click() },
]]);
async function import_package(kind, event) {
  const list = [...event.target.files || []];
  event.target.value = "";
  if (!list.length || !saved_id.value) return;
  try {
    const files = kind === "md" ? await expert_files_from_md(list[0]) : kind === "zip" ? await expert_files_from_zip(list[0]) : await expert_files_from_folder(list);
    const result = await bridge.local_request("workflows", { action: "import-expert-workflow", files, workflow: saved_id.value, sub: package_target.value?.id || "" });
    const notes = [t('已导入专家「{value1}」', { value1: result.card })];
    if (result.requested_access) notes.push(t('它要求的项目权限“{value1}”已降为只读，需要时在这里改', { value1: result.requested_access }));
    if (result.ignored?.length) notes.push(t('已忽略：{value1}', { value1: result.ignored.join("、") }));
    notes.push(...readiness_notes(result));
    bridge.notify(result.ignored?.length || result.requested_access || result.needs_platform || result.unknown_model ? "warning" : "info", notes.join("；"));
    reload();
    focus.value = result.card;
  } catch (error) { bridge.notify("error", error.message); }
}

/** What an import says about whether the expert can run here; it is imported either way. */
function readiness_notes(result) {
  if (result.needs_platform) return [t('本机未配置它的软件，配置好或在这里换成本机已配置的软件之前不能调用')];
  if (result.unknown_model) return [t('本机这个软件没有模型 {value1}，改成列表里的模型之前不能调用', { value1: result.unknown_model })];
  return [];
}

/** The card's platform, from its member name `platform-card`. */
function platform(agent) { return agent.name.slice(0, agent.name.length - agent.card.length - 1); }
const identity = (agent) => bridge.identities[platform(agent)] || {};
const title_of = (agent) => agent.label || agent.card;
/** The software settings the card would start from here, with the card's own choices on top. */
function profile(agent) {
  return { ...view.value.launch.profiles[platform(agent)], model: "", effort: "", project_access: "read", ...agent };
}

function missing(agent) { return ready.value.length > 0 && !ready.value.includes(platform(agent)); }
/** The card's model is known not to run here: its software's list was read and lacks it (see launch_model_state). */
function model_missing(agent) { return !missing(agent) && Boolean(models(agent).unknown); }

function platform_items(agent) {
  const names = [...new Set([...ready.value, platform(agent)])];
  return names.map((name) => ({ label: `${bridge.default_name(name)}${ready.value.includes(name) ? "" : t('（本机未配置）')}`, value: name, disabled: !ready.value.includes(name) }));
}

/** A software without a model list (a model API) takes a typed model ID. */
function typed_model(agent) { return !adapter_profile(profile(agent).adapter)?.models; }

function models(agent) { return bridge.launch_model_state(agent.name, view.value.launch, profile(agent)); }

function effort_items(agent) {
  const levels = models(agent).efforts || adapter_profile(profile(agent).adapter)?.efforts;
  return levels?.length ? [{ label: t('默认'), value: DEFAULT_EFFORT }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
}

function access_items(agent) {
  return access_options(profile(agent).adapter, bridge.full_only_hint(profile(agent).adapter)).map((option) => ({ label: { read: t('只读'), write: t('可写'), auto: t('自动'), full: t('全放开') }[option.value] || option.label, value: option.value, disabled: option.disabled }));
}

/** The software's preset prompt, sent when the card has none of its own. */
const preset_prompt = (agent) => EXPERT_PROMPT_PRESETS[profile(agent).adapter] || "";

/** Replace the card in its part, so the canvas and the unsaved-changes check see the change. */
function update(part, card, patch) {
  part.agents = part.agents.map((agent) => agent.card === card ? { ...agent, ...patch } : agent);
}

/** Another platform keeps the card's role; the old model and strength belong to the old software, so they reset. */
function change_platform(part, agent, name) {
  const adapter = view.value.launch.profiles[name]?.adapter;
  const allowed = access_options(adapter, bridge.full_only_hint(adapter)).filter((option) => !option.disabled).map((option) => option.value);
  update(part, agent.card, { name: `${name}-${agent.card}`, model: "", effort: "",
    project_access: allowed.includes(agent.project_access) ? agent.project_access : allowed.includes("read") ? "read" : allowed[0] });
}

function change_model(part, agent, value) {
  update(part, agent.card, { model: value === DEFAULT_MODEL ? "" : value, effort: "" });
}

// Model lists are read when the dialog opens, as a card's back did when it turned over.
watch([open, () => entries.value.map((entry) => entry.agent.name).join()], ([shown]) => {
  if (!shown || !view.value.launch.available) return;
  for (const { agent } of entries.value) bridge.load_launch_models(agent.name, false, profile(agent));
}, { immediate: true });
</script>

<template>
  <UModal v-model:open="open" :title="preset ? t('{value1} 的高级配置', { value1: preset.label }) : t('专家配置')"
    :description="preset ? t('预设「{value1}」的技能，存在本机服务目录，和工作流里的同名专家互不共用。', { value1: preset.name }) : t('每张卡片的角色、软件、模型、提示词与技能；基础与提示词改完点下方“保存”写入工作流，技能文件逐个保存。')"
    :content="{ onInteractOutside: (event) => event.preventDefault() }"
    :ui="{ content: 'glass-panel studio-modal workflow-experts-modal', body: 'dialog-body workflow-experts-body', footer: 'workflow-experts-footer' }">
    <template #body>
      <!-- 高级配置 of a panel preset: only its skills; its software, model and prompt stay on the card's back. -->
      <ExpertSkills v-if="preset" :source="{ preset: preset.name }" />
      <template v-else>
        <p v-if="!view.launch.available" class="workflow-experts-note">{{ t('连接本机服务后才能读取模型列表与本机已配置的软件。') }}</p>
        <p v-if="!entries.length" class="workflow-experts-note">{{ t('这个工作流还没有成员卡片。') }}</p>
        <div v-else class="workflow-experts" :class="{ 'is-picked': picked }">
          <nav class="workflow-experts-list" :aria-label="t('工作流里的卡片')">
            <section v-for="item in parts" :key="item.key">
              <h4 v-if="parts.length > 1"><UIcon :name="item.key === '@advisors' ? 'i-lucide-book-open' : item.key ? 'i-lucide-git-branch' : 'i-lucide-network'" />{{ item.label }}</h4>
              <button v-for="{ agent, where } in item.entries" :key="agent.card" type="button" class="workflow-experts-item"
                :aria-current="current?.agent.card === agent.card ? 'true' : undefined" @click="pick_card(agent.card)">
                <UAvatar :src="identity(agent).icon" :text="identity(agent).initials || '?'" size="sm" class="channel-avatar" :class="identity(agent).style" />
                <span class="workflow-experts-item-text"><strong>{{ title_of(agent) }}</strong><small>{{ [bridge.default_name(platform(agent)), agent.model, where].filter(Boolean).join(' · ') }}</small></span>
                <UIcon v-if="missing(agent)" name="i-lucide-triangle-alert" class="workflow-experts-warn" :aria-label="t('本机未配置 {value1}', { value1: bridge.default_name(platform(agent)) })" />
                <UIcon v-else-if="model_missing(agent)" name="i-lucide-triangle-alert" class="workflow-experts-warn" :aria-label="t('本机没有模型 {value1}', { value1: agent.model })" />
                <UIcon name="i-lucide-chevron-right" class="workflow-experts-more" />
              </button>
            </section>
            <UTooltip :text="!saved_id ? t('先保存工作流') : dirty ? t('先保存这页的修改') : t('放进「{value1}」', { value1: package_target ? package_target.label || package_target.id : t('主线') })">
              <UDropdownMenu :items="package_items" :disabled="!saved_id || dirty">
                <UButton :label="t('导入专家包')" icon="i-lucide-package-plus" size="xs" color="neutral" variant="ghost" :disabled="!saved_id || dirty" />
              </UDropdownMenu>
            </UTooltip>
            <input :ref="(element) => package_inputs.md.value = element" type="file" accept=".md" hidden @change="import_package('md', $event)">
            <input :ref="(element) => package_inputs.zip.value = element" type="file" accept=".zip" hidden @change="import_package('zip', $event)">
            <input :ref="(element) => package_inputs.folder.value = element" type="file" webkitdirectory hidden @change="import_package('folder', $event)">
          </nav>
          <div v-if="current" :key="current.agent.card" class="workflow-experts-detail">
            <header class="workflow-experts-head">
              <UButton icon="i-lucide-arrow-left" size="sm" color="neutral" variant="ghost" class="workflow-experts-back" :aria-label="t('返回专家列表')" @click="picked = false" />
              <UAvatar :src="identity(current.agent).icon" :text="identity(current.agent).initials || '?'" size="md" class="channel-avatar" :class="identity(current.agent).style" />
              <span class="workflow-experts-title">
                <UInput :model-value="current.agent.label || ''" :placeholder="current.agent.card" :maxlength="MAX_LABEL" variant="none" class="workflow-experts-name" :aria-label="t('角色名')"
                  @update:model-value="update(current.part, current.agent.card, { label: $event })" />
                <small>{{ current.agent.name }}</small>
              </span>
              <span class="workflow-experts-actions">
                <UTooltip :text="!saved_id ? t('先保存工作流') : dirty ? t('存的是已保存的版本；先保存这页的修改') : t('存为新建房间面板上的预设专家；带技能时把技能复制到本机，之后两边各管各的')">
                  <UButton v-if="preset_kept === current.agent.card" :label="t('用工作流里的技能替换本机的（原来的会备份）')" size="xs" color="warning" variant="soft" :loading="preset_saving" @click="save_as_preset(true, true)" />
                  <UButton v-else-if="preset_taken === current.agent.card" :label="t('覆盖同名预设')" size="xs" color="error" variant="soft" :loading="preset_saving" @click="save_as_preset(true)" />
                  <UButton v-else :label="t('存为面板预设')" icon="i-lucide-bookmark-plus" size="xs" color="neutral" variant="soft" :loading="preset_saving" :disabled="!saved_id || dirty" @click="save_as_preset()" />
                </UTooltip>
                <UButton :label="t('导出')" icon="i-lucide-download" size="xs" color="neutral" variant="ghost" :disabled="!saved_id || dirty"
                  :title="t('导出这位专家：没有技能是一个 md，有技能是一个压缩包（取工作流里的技能）')" @click="export_card" />
              </span>
            </header>
            <p v-if="missing(current.agent)" class="workflow-experts-missing"><UIcon name="i-lucide-triangle-alert" />{{ t('本机未配置 {value1}，换一个本机已配置的软件才能运行', { value1: bridge.default_name(platform(current.agent)) }) }}</p>
            <p v-else-if="model_missing(current.agent)" class="workflow-experts-missing"><UIcon name="i-lucide-triangle-alert" />{{ t('本机的 {value1} 没有模型 {value2}，不能调用：在下面“模型”里改成列表里的（或用软件默认），改完保存', { value1: bridge.default_name(platform(current.agent)), value2: current.agent.model }) }}</p>
            <UTabs v-model="tab" :items="tabs" :content="false" variant="link" size="sm" class="workflow-experts-tabs" :aria-label="t('专家配置分区')" />
            <div v-if="tab === 'basic'" class="workflow-experts-pane">
              <label class="workflow-experts-field">
                <span>{{ t('描述') }}</span>
                <UTextarea :model-value="current.agent.description || ''" :rows="3" autoresize :maxlength="MAX_DESCRIPTION" :placeholder="t('一两句：这个角色负责什么')"
                  @update:model-value="update(current.part, current.agent.card, { description: $event.replace(/\s*\n\s*/g, ' ') })" />
              </label>
              <div class="workflow-experts-grid">
                <label class="workflow-experts-field"><span>{{ t('软件') }}</span>
                  <USelect :model-value="platform(current.agent)" :items="platform_items(current.agent)" class="w-full" @update:model-value="change_platform(current.part, current.agent, $event)" /></label>
                <label class="workflow-experts-field"><span>{{ t('模型') }}</span>
                  <UInput v-if="typed_model(current.agent)" :model-value="current.agent.model || ''" :placeholder="t('默认模型')" class="w-full" @update:model-value="change_model(current.part, current.agent, $event)" />
                  <USelect v-else :model-value="current.agent.model || DEFAULT_MODEL" :items="models(current.agent).items" :loading="models(current.agent).loading"
                    :title="models(current.agent).error || models(current.agent).source" class="w-full" @update:model-value="change_model(current.part, current.agent, $event)" /></label>
                <label class="workflow-experts-field"><span>{{ t('强度') }}</span>
                  <USelect v-if="effort_items(current.agent)" :model-value="current.agent.effort || DEFAULT_EFFORT" :items="effort_items(current.agent)" class="w-full"
                    @update:model-value="update(current.part, current.agent.card, { effort: $event === DEFAULT_EFFORT ? '' : $event })" />
                  <span v-else class="workflow-experts-none">{{ t('这个软件不分强度') }}</span></label>
                <label class="workflow-experts-field"><span>{{ t('项目权限') }}</span>
                  <USelect :model-value="current.agent.project_access || 'read'" :items="access_items(current.agent)" class="w-full"
                    :disabled="Boolean(current.agent.requested_access && current.agent.project_access === 'read')" :title="current.agent.requested_access ? t('导入的卡片先在画布上授予它要求的权限') : undefined"
                    @update:model-value="update(current.part, current.agent.card, { project_access: $event })" /></label>
              </div>
            </div>
            <label v-else-if="tab === 'prompt'" class="workflow-experts-field workflow-experts-prompt">
              <span>{{ current.agent.system_prompt?.trim() ? t('自定义') : preset_prompt(current.agent) ? t('留空时使用软件预设') : t('留空表示不使用') }}</span>
              <UTextarea :model-value="current.agent.system_prompt || ''" :maxlength="MAX_EXPERT_PROMPT" :aria-label="t('专属提示词')"
                :placeholder="preset_prompt(current.agent) || t('只发给这张卡片的成员，每次唤醒随任务发送')"
                @update:model-value="update(current.part, current.agent.card, { system_prompt: $event })" />
            </label>
            <div v-else class="workflow-experts-skills">
              <ExpertSkills v-if="has_skills(current.agent)" :source="{ workflow: saved_id, card: current.agent.card }" :blocked="skills_blocked(current.agent)" />
              <div v-else class="workflow-experts-skill-add">
                <p class="workflow-experts-note">{{ t('给这位专家一组自己读写的技能；保存工作流后它变成带技能的文件夹，归到“顾问”。') }}</p>
                <form class="workflow-experts-skill-form" @submit.prevent="add_first_skill(current.part, current.agent)">
                  <UInput v-model="skill_name" size="sm" :placeholder="t('技能名，如 cold-survival')" :aria-label="t('技能名')" />
                  <UInput v-model="skill_description" size="sm" class="workflow-experts-skill-grow" :placeholder="t('一句描述：这条技能管什么')" :aria-label="t('技能描述')" />
                  <UButton type="submit" :label="t('添加技能')" icon="i-lucide-book-plus" size="sm" />
                </form>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
    <!-- One save for what waits on the workflow (basic settings, prompts, a first skill); skill files save one by one. -->
    <template v-if="!preset" #footer>
      <span class="workflow-experts-status" :class="{ 'is-dirty': dirty }">{{ dirty ? t('有未保存的修改') : t('没有未保存的修改') }}</span>
      <UButton :label="t('保存')" icon="i-lucide-save" size="sm" class="channel-primary-button" :disabled="!dirty" :loading="busy" @click="save()" />
    </template>
  </UModal>
</template>

<style scoped>
/* The card list beside the chosen card; on a phone one at a time, the card with a way back to the list. */
.workflow-experts { display: grid; flex: 1; grid-template-columns: 240px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 20px; min-height: 0; }
.workflow-experts-list { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding-right: 12px; border-right: 1px solid var(--ui-border-muted); overflow-y: auto; }
.workflow-experts-list section { display: flex; flex-direction: column; gap: 2px; }
.workflow-experts-list h4 { display: flex; align-items: center; gap: 6px; margin: 0 0 2px; padding: 0 8px; font-size: 11px; font-weight: 500; color: var(--ui-text-dimmed); }
.workflow-experts-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; cursor: pointer; }
.workflow-experts-item:hover { background: var(--ui-bg-elevated); }
.workflow-experts-item[aria-current] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); }
.workflow-experts-item-text { display: flex; flex: 1; flex-direction: column; min-width: 0; line-height: 1.3; }
.workflow-experts-item-text > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-experts-item-text strong { font-size: 13px; font-weight: 500; }
.workflow-experts-item-text small { font-size: 11px; color: var(--ui-text-dimmed); }
.workflow-experts-warn { flex-shrink: 0; color: var(--ui-warning, #e0a33a); }
.workflow-experts-more, .workflow-experts-back { display: none; }
.workflow-experts-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0; }
.workflow-experts-head { display: flex; align-items: center; gap: 10px; }
.workflow-experts-title { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.workflow-experts-name :deep(input) { padding-inline: 0; font-size: 17px; font-weight: 600; }
.workflow-experts-title small { overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workflow-experts-actions { display: flex; flex-shrink: 0; align-items: center; gap: 6px; }
.workflow-experts-missing { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
/* Each tab fills what is left under the head and scrolls on its own; the prompt and the skills use the full height. */
.workflow-experts-pane { display: flex; flex-direction: column; gap: 14px; min-height: 0; overflow-y: auto; }
.workflow-experts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
.workflow-experts-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.workflow-experts-field > span:first-child { font-size: 12px; color: var(--ui-text-muted); }
.workflow-experts-prompt, .workflow-experts-skills { flex: 1; min-height: 0; }
.workflow-experts-prompt > span:first-child { color: var(--ui-text-dimmed); }
.workflow-experts-prompt :deep(> div) { flex: 1; min-height: 0; }
.workflow-experts-prompt :deep(textarea) { height: 100%; resize: none; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.6; }
.workflow-experts-none { display: flex; align-items: center; min-height: 32px; color: var(--ui-text-dimmed); font-size: 12px; }
.workflow-experts-note { margin: 0 0 8px; color: var(--ui-text-muted); font-size: 12px; }
.workflow-experts-skill-form { display: flex; align-items: center; gap: 6px; }
.workflow-experts-skill-grow { flex: 1; min-width: 0; }
.workflow-experts-status { flex: 1; color: var(--ui-text-dimmed); font-size: 12px; }
.workflow-experts-status.is-dirty { color: var(--ui-warning, #e0a33a); }
/* Phone and upright tablet: the list and the chosen card one at a time. */
@media (max-width: 900px) {
  .workflow-experts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .workflow-experts-list { padding-right: 0; border-right: 0; }
  .workflow-experts.is-picked .workflow-experts-list, .workflow-experts:not(.is-picked) .workflow-experts-detail { display: none; }
  .workflow-experts-more, .workflow-experts-back { display: inline-flex; flex-shrink: 0; color: var(--ui-text-dimmed); }
  .workflow-experts-item { padding: 10px 8px; }
  /* The name and id take the first row beside the back button and avatar; the preset and export buttons wrap below. */
  .workflow-experts-head { flex-wrap: wrap; gap: 8px; }
  .workflow-experts-actions { width: 100%; }
  .workflow-experts-skill-form { flex-wrap: wrap; }
}
</style>

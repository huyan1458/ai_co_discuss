<script setup>
/**
 * 专家配置: every card of the open workflow (main flow and sub-workflows), a list on the left and the chosen card's
 * settings on the right: role name, description, software, model, strength, project access and its expert prompt.
 * The canvas cards only say who each one is (user 2026-11-17); everything that configures a card is edited here.
 * Edits go into the open draft and are written by the page's 保存. A card naming software this computer has not set
 * up is marked, so it can be moved to one that is.
 */
import { computed, inject, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { EXPERT_PROMPT_PRESETS, MAX_EXPERT_PROMPT, access_options } from "../runner/expert_prompts.mjs";
import { use_workflow_library } from "./workflow-library.js";
import { t } from './i18n.js';

const open = defineModel("open", { type: Boolean, default: false });
// The card shown on the right; empty opens at the first card.
const focus = defineModel("focus", { type: String, default: "" });
const { view, bridge } = inject("discussion");
const { draft, subs } = use_workflow_library();
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
const parts = computed(() => !draft.value ? [] : [{ key: "", label: t('主线'), part: draft.value },
  ...subs.value.map((sub) => ({ key: sub.id, label: sub.label || sub.id, part: sub }))].filter((item) => item.part.agents.length));
const entries = computed(() => parts.value.flatMap((item) => item.part.agents.map((agent) => ({ part: item.part, agent }))));
const current = computed(() => entries.value.find((entry) => entry.agent.card === focus.value) || entries.value[0] || null);

/** The card's platform, from its member name `platform-card`. */
function platform(agent) { return agent.name.slice(0, agent.name.length - agent.card.length - 1); }
const identity = (agent) => bridge.identities[platform(agent)] || {};
const title_of = (agent) => agent.label || agent.card;

/** The software settings the card would start from here, with the card's own choices on top. */
function profile(agent) {
  return { ...view.value.launch.profiles[platform(agent)], model: "", effort: "", project_access: "read", ...agent };
}

function missing(agent) { return ready.value.length > 0 && !ready.value.includes(platform(agent)); }

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
  <UModal v-model:open="open" :title="t('专家配置')" :description="t('每张卡片的角色、软件、模型与专属提示词；改完点工作流页的“保存”写入。')"
    :content="{ onInteractOutside: (event) => event.preventDefault() }"
    :ui="{ content: 'glass-panel studio-modal workflow-experts-modal', body: 'dialog-body workflow-experts-body' }">
    <template #body>
      <p v-if="!view.launch.available" class="workflow-experts-note">{{ t('连接本机服务后才能读取模型列表与本机已配置的软件。') }}</p>
      <p v-if="!entries.length" class="workflow-experts-note">{{ t('这个工作流还没有成员卡片。') }}</p>
      <div v-else class="workflow-experts">
        <nav class="workflow-experts-list" :aria-label="t('工作流里的卡片')">
          <section v-for="item in parts" :key="item.key">
            <h4 v-if="parts.length > 1"><UIcon :name="item.key ? 'i-lucide-git-branch' : 'i-lucide-network'" />{{ item.label }}</h4>
            <button v-for="agent in item.part.agents" :key="agent.card" type="button" class="workflow-experts-item"
              :aria-current="current?.agent.card === agent.card ? 'true' : undefined" @click="focus = agent.card">
              <UAvatar :src="identity(agent).icon" :text="identity(agent).initials || '?'" size="xs" class="channel-avatar" :class="identity(agent).style" />
              <span class="workflow-experts-item-text"><strong>{{ title_of(agent) }}</strong><small>{{ bridge.default_name(platform(agent)) }}</small></span>
              <UIcon v-if="missing(agent)" name="i-lucide-triangle-alert" class="workflow-experts-warn" :aria-label="t('本机未配置 {value1}', { value1: bridge.default_name(platform(agent)) })" />
            </button>
          </section>
        </nav>
        <div v-if="current" :key="current.agent.card" class="workflow-experts-detail">
          <header class="workflow-experts-head">
            <UAvatar :src="identity(current.agent).icon" :text="identity(current.agent).initials || '?'" size="md" class="channel-avatar" :class="identity(current.agent).style" />
            <UInput :model-value="current.agent.label || ''" :placeholder="current.agent.card" :maxlength="MAX_LABEL" size="lg" variant="none" class="workflow-experts-name" :aria-label="t('角色名')"
              @update:model-value="update(current.part, current.agent.card, { label: $event })" />
            <small>{{ current.agent.name }}</small>
          </header>
          <p v-if="missing(current.agent)" class="workflow-experts-missing"><UIcon name="i-lucide-triangle-alert" />{{ t('本机未配置 {value1}，换一个本机已配置的软件才能运行', { value1: bridge.default_name(platform(current.agent)) }) }}</p>
          <label class="workflow-experts-field">
            <span>{{ t('描述') }}</span>
            <UTextarea :model-value="current.agent.description || ''" :rows="4" :maxlength="MAX_DESCRIPTION" :placeholder="t('一两句：这个角色负责什么')"
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
          <label class="workflow-experts-field workflow-experts-prompt">
            <span>{{ t('专属提示词') }}<small>{{ current.agent.system_prompt?.trim() ? t('自定义') : preset_prompt(current.agent) ? t('留空时使用软件预设') : t('留空表示不使用') }}</small></span>
            <UTextarea :model-value="current.agent.system_prompt || ''" :rows="18" :maxlength="MAX_EXPERT_PROMPT"
              :placeholder="preset_prompt(current.agent) || t('只发给这张卡片的成员，每次唤醒随任务发送')"
              @update:model-value="update(current.part, current.agent.card, { system_prompt: $event })" />
          </label>
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
/* A list of every card beside the chosen card's settings; on a phone the list becomes one scrolling row above it. */
.workflow-experts { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 20px; min-height: 420px; }
.workflow-experts-list { display: flex; flex-direction: column; gap: 10px; padding-right: 12px; border-right: 1px solid var(--ui-border-muted); overflow-y: auto; }
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
.workflow-experts-detail { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.workflow-experts-head { display: flex; align-items: center; gap: 10px; }
.workflow-experts-name { flex: 1; min-width: 0; }
.workflow-experts-name :deep(input) { padding-inline: 4px; font-size: 17px; font-weight: 600; }
.workflow-experts-head small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-experts-missing { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-experts-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 14px; }
.workflow-experts-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.workflow-experts-field > span:first-child { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--ui-text-muted); }
.workflow-experts-field > span:first-child small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-experts-prompt :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.6; }
.workflow-experts-none { display: flex; align-items: center; min-height: 32px; color: var(--ui-text-dimmed); font-size: 12px; }
.workflow-experts-note { margin: 0 0 8px; color: var(--ui-text-muted); font-size: 12px; }
/* The dialog keeps one height for every card; the prompt box takes what the window leaves, and only a very short window scrolls. */
@media (min-width: 641px) {
  .workflow-experts { flex: 1; grid-template-rows: minmax(0, 1fr); min-height: 0; }
  .workflow-experts-detail { min-height: 0; overflow-y: auto; }
  .workflow-experts-prompt { flex: 1; min-height: 160px; }
  .workflow-experts-prompt :deep(> div) { flex: 1; min-height: 0; }
  .workflow-experts-prompt :deep(textarea) { height: 100%; }
}
@media (max-width: 640px) {
  .workflow-experts { grid-template-columns: minmax(0, 1fr); gap: 14px; min-height: 0; }
  .workflow-experts-list { flex-direction: row; gap: 4px; padding: 0 0 8px; border-right: 0; border-bottom: 1px solid var(--ui-border-muted); overflow-x: auto; overflow-y: hidden; }
  .workflow-experts-list section { flex-direction: row; flex-shrink: 0; }
  .workflow-experts-list h4 { display: none; }
  .workflow-experts-item { width: auto; flex-shrink: 0; }
  .workflow-experts-item-text small { display: none; }
  .workflow-experts-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>

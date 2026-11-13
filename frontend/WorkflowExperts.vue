<script setup>
/**
 * 专家配置: every card of the open workflow (main flow and sub-workflows) in one table, to set which software, model,
 * strength and project access each runs with. Edits go into the open draft and are written by the page's 保存.
 * A card naming software this computer has not set up is marked, so it can be moved to one that is.
 */
import { computed, inject, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { access_options } from "../runner/expert_prompts.mjs";
import { use_workflow_library } from "./workflow-library.js";

const open = defineModel("open", { type: Boolean, default: false });
const { view, bridge } = inject("discussion");
const { draft, subs } = use_workflow_library();
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const DEFAULT_MODEL = "__default__";

// The platforms cards may name on this computer; none listed means the list is not known (no local service).
const ready = computed(() => view.value.launch.card_platforms || []);
const parts = computed(() => !draft.value ? [] : [{ key: "", label: "主线", part: draft.value },
  ...subs.value.map((sub) => ({ key: sub.id, label: sub.label || sub.id, part: sub }))].filter((item) => item.part.agents.length));

/** The card's platform, from its member name `platform-card`. */
function platform(agent) { return agent.name.slice(0, agent.name.length - agent.card.length - 1); }

/** The software settings the card would start from here, with the card's own choices on top. */
function profile(agent) {
  return { ...view.value.launch.profiles[platform(agent)], model: "", effort: "", project_access: "read", ...agent };
}

function missing(agent) { return ready.value.length > 0 && !ready.value.includes(platform(agent)); }

function platform_items(agent) {
  const names = [...new Set([...ready.value, platform(agent)])];
  return names.map((name) => ({ label: `${bridge.default_name(name)}${ready.value.includes(name) ? "" : "（本机未配置）"}`, value: name, disabled: !ready.value.includes(name) }));
}

/** A software without a model list (a model API) takes a typed model ID. */
function typed_model(agent) { return !adapter_profile(profile(agent).adapter)?.models; }

function models(agent) { return bridge.launch_model_state(agent.name, view.value.launch, profile(agent)); }

function effort_items(agent) {
  const levels = models(agent).efforts || adapter_profile(profile(agent).adapter)?.efforts;
  return levels?.length ? [{ label: "默认", value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
}

function access_items(agent) {
  return access_options(profile(agent).adapter).map((option) => ({ label: option.label, value: option.value, disabled: option.disabled }));
}

/** Replace the card in its part, so the canvas and the unsaved-changes check see the change. */
function update(part, card, patch) {
  part.agents = part.agents.map((agent) => agent.card === card ? { ...agent, ...patch } : agent);
}

/** Another platform keeps the card's role; the old model and strength belong to the old software, so they reset. */
function change_platform(part, agent, name) {
  const adapter = view.value.launch.profiles[name]?.adapter;
  const allowed = access_options(adapter).filter((option) => !option.disabled).map((option) => option.value);
  update(part, agent.card, { name: `${name}-${agent.card}`, model: "", effort: "",
    project_access: allowed.includes(agent.project_access) ? agent.project_access : "read" });
}

function change_model(part, agent, value) {
  update(part, agent.card, { model: value === DEFAULT_MODEL ? "" : value, effort: "" });
}

// Model lists are read when the dialog opens, as a card's back did when it turned over.
watch([open, () => parts.value.flatMap((item) => item.part.agents.map((agent) => agent.name))], ([shown]) => {
  if (!shown || !view.value.launch.available) return;
  for (const { part } of parts.value) for (const agent of part.agents) bridge.load_launch_models(agent.name, false, profile(agent));
}, { immediate: true });
</script>

<template>
  <UModal v-model:open="open" title="专家配置" description="每张卡片用哪个软件、模型、强度与项目权限；改完点工作流页的“保存”写入。"
    :ui="{ content: 'glass-panel studio-modal sm:max-w-4xl', body: 'dialog-body' }">
    <template #body>
      <p v-if="!view.launch.available" class="workflow-experts-note">连接本机服务后才能读取模型列表与本机已配置的软件。</p>
      <section v-for="item in parts" :key="item.key" class="workflow-experts-part">
        <h4><UIcon :name="item.key ? 'i-lucide-git-branch' : 'i-lucide-network'" />{{ item.label }}</h4>
        <div class="workflow-experts-table" role="table" :aria-label="`${item.label}的专家配置`">
          <div class="workflow-experts-row is-head" role="row"><span role="columnheader">卡片</span><span role="columnheader">软件</span><span role="columnheader">模型</span><span role="columnheader">强度</span><span role="columnheader">项目</span></div>
          <div v-for="agent in item.part.agents" :key="agent.card" class="workflow-experts-row" :class="{ 'is-missing': missing(agent) }" role="row">
            <span role="cell" class="workflow-experts-card"><strong>{{ agent.label || agent.card }}</strong><small>{{ agent.name }}</small>
              <em v-if="missing(agent)"><UIcon name="i-lucide-triangle-alert" />本机未配置 {{ bridge.default_name(platform(agent)) }}</em></span>
            <span role="cell"><USelect :model-value="platform(agent)" :items="platform_items(agent)" size="xs" class="w-full" :aria-label="`${agent.label || agent.card} 的软件`"
              @update:model-value="change_platform(item.part, agent, $event)" /></span>
            <span role="cell">
              <UInput v-if="typed_model(agent)" :model-value="agent.model || ''" placeholder="默认模型" size="xs" class="w-full" :aria-label="`${agent.label || agent.card} 的模型`"
                @update:model-value="change_model(item.part, agent, $event)" />
              <USelect v-else :model-value="agent.model || DEFAULT_MODEL" :items="models(agent).items" :loading="models(agent).loading" :title="models(agent).error || models(agent).source"
                size="xs" class="w-full" :aria-label="`${agent.label || agent.card} 的模型`" @update:model-value="change_model(item.part, agent, $event)" />
            </span>
            <span role="cell">
              <USelect v-if="effort_items(agent)" :model-value="agent.effort || ''" :items="effort_items(agent)" size="xs" class="w-full" :aria-label="`${agent.label || agent.card} 的强度`"
                @update:model-value="update(item.part, agent.card, { effort: $event })" />
              <small v-else class="workflow-experts-none">—</small>
            </span>
            <span role="cell"><USelect :model-value="agent.project_access || 'read'" :items="access_items(agent)" size="xs" class="w-full" :aria-label="`${agent.label || agent.card} 的项目权限`"
              :disabled="Boolean(agent.requested_access && agent.project_access === 'read')" :title="agent.requested_access ? '导入的卡片先在画布上授予它要求的权限' : undefined"
              @update:model-value="update(item.part, agent.card, { project_access: $event })" /></span>
          </div>
        </div>
      </section>
      <p v-if="!parts.length" class="workflow-experts-note">这个工作流还没有成员卡片。</p>
    </template>
  </UModal>
</template>

<style scoped>
.workflow-experts-part { display: flex; flex-direction: column; gap: 6px; }
.workflow-experts-part + .workflow-experts-part { margin-top: 14px; }
.workflow-experts-part h4 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; color: var(--ui-text-muted); }
.workflow-experts-row { display: grid; grid-template-columns: minmax(150px, 1.3fr) 1fr 1.3fr 0.8fr 0.8fr; gap: 8px; align-items: center; padding: 6px 4px; border-top: 1px solid var(--ui-border-muted); }
.workflow-experts-row.is-head { border-top: 0; padding-top: 0; font-size: 11px; color: var(--ui-text-dimmed); }
.workflow-experts-card { display: flex; flex-direction: column; min-width: 0; }
.workflow-experts-card strong { font-size: 13px; }
.workflow-experts-card small { overflow: hidden; color: var(--ui-text-dimmed); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.workflow-experts-card em { display: inline-flex; align-items: center; gap: 4px; color: var(--ui-warning, #e0a33a); font-size: 11px; font-style: normal; }
.workflow-experts-none { color: var(--ui-text-dimmed); }
.workflow-experts-note { margin: 0 0 8px; color: var(--ui-text-muted); font-size: 12px; }
</style>

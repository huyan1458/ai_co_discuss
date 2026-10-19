<script setup>
/** New-discussion form: the user states the topic in their own words; the AI host drafts goal, background and boundaries. */
import { computed, inject, onMounted, ref, watch } from "vue";
import LaunchSettings from "./LaunchSettings.vue";

const props = defineProps({ targetFolder: { type: Object, default: null } });
const emit = defineEmits(["submit", "cancel"]);
const { view, bridge, pending } = inject("discussion");
const EXPERT_CONTAINER = "new-expert-modes";
const LIMIT_PRESETS = [
  { label: "快速", rounds: "2", minutes: "30" },
  { label: "标准", rounds: "3", minutes: "60", hint: "推荐" },
  { label: "深入", rounds: "6", minutes: "120" },
  { label: "不限", rounds: "", minutes: "" },
];
const ACCESS_ITEMS = [{ label: "只读", value: "read" }, { label: "可写", value: "write" }];
const LIMIT_FIELDS = [{ key: "max_rounds", label: "讨论轮次上限", min: 0, max: 100 }, { key: "max_minutes", label: "总时长（分钟）", min: 0, max: 1440 }, { key: "execution_minutes", label: "单次 AI 执行（分钟）", min: 1, max: 60 }];
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const field_id = (key) => `new-room-${key}`;
const value = (key) => view.value.fields[field_id(key)] ?? "";
const write = (key, next) => bridge.write_field(field_id(key), next);

const automatic = computed(() => value("mode") === "automatic");
const selected = computed(() => view.value.experts[EXPERT_CONTAINER] || {});
const host = computed(() => value("host"));
const host_options = computed(() => experts.filter((name) => selected.value[name] === "cli"));
const custom_limits = ref(false);
const active_preset = computed(() => custom_limits.value ? null
  : LIMIT_PRESETS.find((preset) => String(value("limit-max_rounds")) === preset.rounds && String(value("limit-max_minutes")) === preset.minutes) || null);
const visible_limits = computed(() => LIMIT_FIELDS.filter((item) => item.key !== "execution_minutes" || automatic.value));
const launch_names = computed(() => [...new Set([host.value, ...Object.keys(selected.value)])].filter((name) => bridge.launch_clients[name]));
const launch_ready = (name) => {
  const profile = view.value.launch.profiles[name] || {};
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
};
const launching = computed(() => automatic.value && view.value.launch.available && view.value.launch.create);
const launch_open = ref(false);
watch(() => [launching.value, launch_names.value.every(launch_ready), view.value.launch.error], ([on, ready, error]) => {
  if (on && (!ready || error)) launch_open.value = true;
}, { immediate: true });

/** Keep an AI host chosen among selected local experts; the web form never assigns the user as host.
 * Called from event handlers only: writing a draft from inside a watcher stalls the shared view. */
function ensure_host() {
  if (!host_options.value.includes(host.value)) write("host", host_options.value[0] || "");
}
onMounted(ensure_host);

/** Switch the advancement mode, then repair a host the mode's draft no longer allows. */
function choose_mode(mode) {
  write("mode", mode);
  ensure_host();
}

/** Change one selected expert's participation mode and keep the host valid. */
function set_expert_mode(name, mode) {
  bridge.write_expert(EXPERT_CONTAINER, name, mode);
  ensure_host();
}

/** Explain each participant card from the current mode and local launch configuration. */
function expert_status(name) {
  const mode = selected.value[name];
  if (automatic.value && !bridge.launch_clients[name]) return { text: "仅在线只读", tone: "muted" };
  if (automatic.value && view.value.launch.available) {
    return launch_ready(name) ? { text: `本机 ${bridge.launch_summary(name).client}`, tone: "ready" } : { text: "尚未配置本机软件", tone: "warn" };
  }
  if (!mode) return { text: bridge.launch_clients[name] ? "可本地读写" : "在线只读", tone: "muted" };
  return { text: mode === "cli" ? "本地读写，可担任主持" : "只读，回答由你代发", tone: "muted" };
}

/** Toggle one expert; automatic mode only admits software the local service can wake. */
function toggle_expert(name) {
  if (!selected.value[name] && automatic.value && !bridge.launch_clients[name]) return;
  set_expert_mode(name, selected.value[name] ? "" : automatic.value || bridge.launch_clients[name] ? "cli" : "online");
}

/** Apply a limit preset while keeping the per-execution and closing settings. */
function apply_preset(preset) {
  custom_limits.value = false;
  write("limit-max_rounds", preset.rounds);
  write("limit-max_minutes", preset.minutes);
}

const summary = computed(() => {
  const names = Object.keys(selected.value);
  const rounds = value("limit-max_rounds"), minutes = value("limit-max_minutes");
  const limits = [rounds && Number(rounds) ? `${rounds} 轮` : "不限轮次", minutes && Number(minutes) ? `${minutes} 分钟` : "不限时长"].join(" / ");
  return [host.value ? `${bridge.display_name(host.value)} 主持` : "尚未选择主持人", names.length ? `${names.join("、")} 参与` : "尚未选择专家",
    automatic.value ? "全自动" : "手动推进", limits].join(" · ");
});
</script>

<template>
  <div class="create-discussion">
    <form id="create-discussion-form" class="create-scroll dialog-form" @submit.prevent="emit('submit')">
      <p v-if="targetFolder?.id" class="channel-create-location"><UIcon name="i-lucide-folder" />{{ targetFolder.name }}</p>
      <section class="create-section">
        <h3><span>1</span>讨论什么</h3>
        <UFormField label="话题名称" required><UInput :model-value="value('title')" :maxlength="80" required autofocus size="lg" placeholder="这次想讨论什么？" class="w-full" @update:model-value="write('title', $event)" /></UFormField>
        <UFormField label="用户原文" required description="把你的问题、背景和顾虑原样写下来。讨论目标、背景与边界由 AI 主持人据此补全，之后可在「主持 → 编辑议题」修改。"><UTextarea :model-value="value('user_request')" :maxlength="4000" :rows="5" autoresize :maxrows="12" required placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" @update:model-value="write('user_request', $event)" /></UFormField>
      </section>

      <section class="create-section">
        <h3><span>2</span>谁来参与</h3>
        <div class="create-modes" role="radiogroup" aria-label="讨论推进方式">
          <button v-for="option in [{ value: 'automatic', icon: 'i-lucide-zap', title: '全自动讨论', text: '本机服务按安排唤醒本地 AI' }, { value: 'manual', icon: 'i-lucide-copy', title: '手动复制冷启动', text: '支持在线 AI，由你或定时任务触发' }]" :key="option.value" type="button" role="radio" class="create-mode" :class="{ 'is-selected': (automatic ? 'automatic' : 'manual') === option.value }" :aria-checked="(automatic ? 'automatic' : 'manual') === option.value" @click="choose_mode(option.value)">
            <UIcon :name="option.icon" /><span><strong>{{ option.title }}</strong><small>{{ option.text }}</small></span>
          </button>
        </div>
        <div class="create-experts" role="group" aria-label="参与专家">
          <div v-for="name in experts" :key="name" class="create-expert" :class="{ 'is-selected': selected[name], 'is-disabled': automatic && !bridge.launch_clients[name] && !selected[name] }">
            <button type="button" class="create-expert-toggle" :aria-pressed="Boolean(selected[name])" :disabled="automatic && !bridge.launch_clients[name] && !selected[name]" @click="toggle_expert(name)">
              <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar" :class="bridge.identities[name]?.style" />
              <span class="create-expert-text"><strong>{{ name }}</strong><small :class="`is-${expert_status(name).tone}`">{{ expert_status(name).text }}</small></span>
              <UIcon :name="selected[name] ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="create-expert-check" />
            </button>
            <div v-if="selected[name] && !automatic" class="create-expert-modes" role="radiogroup" :aria-label="`${name} 参与方式`">
              <button v-for="mode in [{ value: 'cli', label: '本地读写' }, { value: 'online', label: '在线只读' }]" :key="mode.value" type="button" role="radio" :aria-checked="selected[name] === mode.value" :class="{ 'is-selected': selected[name] === mode.value }" @click="set_expert_mode(name, mode.value)">{{ mode.label }}</button>
            </div>
          </div>
        </div>
        <div class="create-host">
          <span class="create-label">AI 主持人</span>
          <span v-if="!host_options.length" class="fine-print create-host-empty">先选择一位本地读写的专家</span>
          <div v-else class="create-chips" role="radiogroup" aria-label="主持人">
            <button v-for="name in host_options" :key="name" type="button" role="radio" :aria-checked="host === name" :class="{ 'is-selected': host === name }" @click="write('host', name)"><UIcon v-if="host === name" name="i-lucide-crown" />{{ bridge.display_name(name) }}</button>
          </div>
        </div>
        <p class="fine-print create-hint">{{ automatic ? '全自动要求主持人与专家都是本机 AI；在线 AI 请改用手动推进。' : '主持人须为本地读写的专家；' }}主持人会先补全议题资料，也可同时作为专家发言。</p>
      </section>

      <section class="create-section">
        <h3><span>3</span>讨论多久</h3>
        <div class="create-chips" role="radiogroup" aria-label="讨论上限">
          <button v-for="preset in LIMIT_PRESETS" :key="preset.label" type="button" role="radio" :aria-checked="active_preset === preset" :class="{ 'is-selected': active_preset === preset }" @click="apply_preset(preset)">{{ preset.label }}<small>{{ preset.rounds ? `${preset.rounds} 轮 · ${preset.minutes} 分钟` : '不设上限' }}</small><em v-if="preset.hint">{{ preset.hint }}</em></button>
          <button type="button" role="radio" :aria-checked="!active_preset" :class="{ 'is-selected': !active_preset }" @click="custom_limits = true">自定义</button>
        </div>
        <div v-if="!active_preset || automatic" class="form-two-columns">
          <template v-for="item in visible_limits" :key="item.key"><UFormField v-if="!active_preset || item.key === 'execution_minutes'" :label="item.label"><UInput :model-value="value(`limit-${item.key}`)" type="number" :min="item.min" :max="item.max" :step="1" :required="item.min > 0" :placeholder="item.min === 0 ? '留空不限' : '1–60'" class="w-full" @update:model-value="write(`limit-${item.key}`, $event)" /></UFormField></template>
        </div>
        <div class="create-host">
          <span class="create-label">到达上限后</span>
          <div class="create-chips" role="radiogroup" aria-label="达到上限后">
            <button v-for="option in [{ value: 'pause', label: '暂停保留现场' }, { value: 'summarize', label: '由主持人总结' }]" :key="option.value" type="button" role="radio" :aria-checked="(value('limit-on_limit') || 'pause') === option.value" :class="{ 'is-selected': (value('limit-on_limit') || 'pause') === option.value }" @click="write('limit-on_limit', option.value)">{{ option.label }}</button>
          </div>
          <UInput v-if="value('limit-on_limit') === 'summarize'" :model-value="value('limit-summary_minutes')" type="number" :min="1" :max="60" :step="1" aria-label="收束预留（分钟）" class="create-summary-minutes" @update:model-value="write('limit-summary_minutes', $event)"><template #trailing><span class="fine-print">分钟收束</span></template></UInput>
        </div>
        <p class="fine-print create-hint">一轮指每位专家各完成一次观点；首次进入讨论或创建安排后计时，暂停期间不计时。</p>
      </section>

      <section v-if="automatic" class="create-section">
        <h3><span>4</span>启动</h3>
        <template v-if="view.launch.available">
          <UCheckbox :model-value="view.launch.create" label="创建后立即启动 AI" description="由本机服务创建会话并交付首个主持任务；不勾选则只建房，稍后在「接入」页启动。" @update:model-value="bridge.write_launch('create', '', $event)" />
          <template v-if="view.launch.create">
            <div class="form-two-columns">
              <UFormField label="项目目录（可选）" help="要一起查看的项目；留空时 AI 只在讨论私有目录工作"><UInput :model-value="view.launch.workspace.cwd || ''" placeholder="已有目录的完整路径" class="w-full" @update:model-value="bridge.write_launch('workspace', 'cwd', $event)" /></UFormField>
              <UFormField label="项目文件" help="默认只读；可写允许 CLI 专家按议题修改项目文件，仅本次有效"><USelect :model-value="view.launch.workspace.project_access || 'read'" :items="ACCESS_ITEMS" class="w-full" @update:model-value="bridge.write_launch('workspace', 'project_access', $event)" /></UFormField>
            </div>
            <ul class="create-launch-list">
              <li v-for="name in launch_names" :key="name"><UIcon :name="launch_ready(name) ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'" :class="launch_ready(name) ? 'is-ready' : 'is-warn'" /><strong>{{ name }}</strong><span>{{ bridge.launch_summary(name).client }} · {{ bridge.launch_summary(name).session }} · {{ bridge.launch_summary(name).access }} · {{ bridge.launch_summary(name).cwd }}</span></li>
            </ul>
            <UCollapsible v-model:open="launch_open">
              <UButton :icon="launch_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" label="调整启动配置" color="neutral" variant="link" size="sm" class="create-more" />
              <template #content><LaunchSettings :participants="launch_names" :workspace="false" /></template>
            </UCollapsible>
          </template>
        </template>
        <LaunchSettings v-else :participants="launch_names" :workspace="false" />
      </section>
    </form>
    <footer class="create-footer">
      <p v-if="launching && view.launch.error" role="alert" class="create-error">{{ view.launch.error }}</p>
      <div class="create-footer-row">
        <span class="create-summary" :title="summary">{{ summary }}</span>
        <UButton label="取消" color="neutral" variant="ghost" @click="emit('cancel')" />
        <UButton type="submit" form="create-discussion-form" class="channel-primary-button" :icon="launching ? 'i-lucide-play' : 'i-lucide-plus'" :label="launching ? '创建并启动讨论' : '创建讨论'" :disabled="!host" :loading="pending === 'create'" />
      </div>
    </footer>
  </div>
</template>

<style scoped>
.create-discussion { display: flex; flex-direction: column; max-height: min(78dvh, 820px); }
.create-scroll { overflow-y: auto; padding: 20px 26px 24px; gap: 26px !important; }
.create-section { display: flex; flex-direction: column; gap: 14px; }
.create-section + .create-section { padding-top: 22px; border-top: 1px solid var(--ui-border-muted); }
.create-section h3 { display: flex; align-items: center; gap: 9px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-section h3 > span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, var(--channel-accent) 18%, transparent); color: var(--channel-accent); font-size: 11px; }
.create-more { align-self: flex-start; padding-inline: 0; color: var(--ui-text-muted); }
.create-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.create-mode { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border: 1px solid var(--ui-border); border-radius: 10px; text-align: left; color: var(--ui-text-muted); transition: border-color .12s, background .12s; }
.create-mode:hover { border-color: var(--ui-border-accented); }
.create-mode > span { display: flex; flex-direction: column; gap: 2px; }
.create-mode strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-mode small { font-size: 11px; }
.create-mode > [class*="icon"] { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; }
.create-mode.is-selected { border-color: var(--channel-accent); background: color-mix(in srgb, var(--channel-accent) 9%, transparent); }
.create-mode.is-selected > [class*="icon"] { color: var(--channel-accent); }
.create-experts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
.create-expert { border: 1px solid var(--ui-border); border-radius: 10px; transition: border-color .12s, background .12s; }
.create-expert.is-selected { border-color: color-mix(in srgb, var(--channel-accent) 70%, transparent); background: color-mix(in srgb, var(--channel-accent) 7%, transparent); }
.create-expert.is-disabled { opacity: .55; }
.create-expert-toggle { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; text-align: left; border-radius: inherit; }
.create-expert-toggle:disabled { cursor: not-allowed; }
.create-expert-text { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.create-expert-toggle strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-expert-toggle small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.create-expert-toggle small.is-ready { color: #3fb27f; }
.create-expert-toggle small.is-warn { color: #e0a33a; }
.create-expert-check { flex-shrink: 0; width: 17px; height: 17px; color: var(--ui-text-dimmed); }
.is-selected .create-expert-check { color: var(--channel-accent); }
.create-expert-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin: 0 10px 10px; padding: 3px; border-radius: 7px; background: var(--ui-bg-muted); }
.create-expert-modes button { padding: 4px 0; border-radius: 5px; color: var(--ui-text-muted); font-size: 11px; }
.create-expert-modes button.is-selected { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.create-host { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.create-host-empty { margin: 0 !important; }
.create-label { min-width: 64px; color: var(--ui-text-toned); font-size: 12px; }
.create-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.create-chips button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; transition: border-color .12s, background .12s; }
.create-chips button:hover { border-color: var(--ui-border-accented); }
.create-chips button.is-selected { border-color: var(--channel-accent); background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
.create-chips button [class*="icon"] { width: 13px; height: 13px; color: #e0b44a; }
.create-chips small { color: var(--ui-text-muted); font-size: 11px; }
.create-chips em { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--channel-accent) 20%, transparent); color: var(--channel-accent); font-size: 10px; font-style: normal; }
.create-summary-minutes { width: 150px; }
.create-hint { margin-top: -4px !important; }
.create-launch-list { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 9px; background: var(--ui-bg-muted); font-size: 12px; }
.create-launch-list li { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.create-launch-list strong { flex-shrink: 0; color: var(--ui-text-highlighted); }
.create-launch-list span { overflow: hidden; color: var(--ui-text-muted); white-space: nowrap; text-overflow: ellipsis; }
.create-launch-list [class*="icon"] { flex-shrink: 0; align-self: center; width: 14px; height: 14px; }
.is-ready { color: #3fb27f; }
.is-warn { color: #e0a33a; }
.create-footer { flex-shrink: 0; padding: 14px 26px 16px; border-top: 1px solid var(--ui-border-muted); }
.create-footer-row { display: flex; align-items: center; gap: 8px; }
.create-summary { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.create-error { margin-bottom: 10px; color: #f0716b; font-size: 12px; }
@media (max-width: 600px) {
  .create-discussion { max-height: calc(100dvh - 130px); }
  .create-scroll { padding: 18px 18px 20px; }
  .create-modes { grid-template-columns: 1fr; }
  .create-footer { padding: 12px 18px 14px; }
  .create-summary { display: none; }
  .create-footer-row { justify-content: flex-end; }
}
</style>

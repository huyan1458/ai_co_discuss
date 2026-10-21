<script setup>
/** New-discussion form: the user states the topic in their own words; the AI host drafts goal, background and boundaries. */
import { computed, inject, nextTick, onMounted, ref, watch } from "vue";
import LaunchSettings from "./LaunchSettings.vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";
import ExpertCard from "./ExpertCard.vue";

const props = defineProps({ targetFolder: { type: Object, default: null } });
const emit = defineEmits(["submit", "cancel"]);
const { view, bridge, pending } = inject("discussion");
const EXPERT_CONTAINER = "new-expert-modes";
const ACCESS_ITEMS = [{ label: "只读", value: "read" }, { label: "可写", value: "write" }];
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const field_id = (key) => `new-room-${key}`;
const value = (key) => view.value.fields[field_id(key)] ?? "";
const write = (key, next) => bridge.write_field(field_id(key), next);

const automatic = computed(() => value("mode") === "automatic");
const free = computed(() => value("kind") === "free");
const KINDS = [{ value: "brainstorm", icon: "i-lucide-messages-square", title: "讨论", text: "围绕议题轮流发言，形成结论" },
  { value: "free", icon: "i-lucide-message-circle", title: "自由协作", text: "按需点名 AI，在各自会话中工作" }];
const MODES = [{ value: "automatic", icon: "i-lucide-zap", title: "程序唤醒", text: "本机服务交付任务，自动接续会话" },
  { value: "manual", icon: "i-lucide-copy", title: "手动接入", text: "首次复制指令，之后人工或定时触发" }];
const selected = computed(() => view.value.experts[EXPERT_CONTAINER] || {});
// Cards in the library are types; each selected name is one instance, e.g. Claude and Claude-2.
const selected_names = computed(() => Object.keys(selected.value).filter((name) => selected.value[name])
  .sort((left, right) => experts.indexOf(bridge.platform_of(left)) - experts.indexOf(bridge.platform_of(right)) || left.localeCompare(right, "en", { numeric: true })));
/** Instances already taken from one library card. */
const instance_count = (platform) => selected_names.value.filter((name) => bridge.platform_of(name) === platform).length;
const library = ref(null);
const host = computed(() => value("host"));
const host_options = computed(() => [...(free.value ? ["用户"] : []), ...selected_names.value.filter((name) => selected.value[name] === "cli")]);
const limit_picker = ref(null);
const launch_names = computed(() => [...new Set([host.value, ...Object.keys(selected.value)])].filter((name) => bridge.launch_clients[name]));
const launch_ready = (name) => {
  const profile = view.value.launch.profiles[name] || {};
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
};
const launching = computed(() => automatic.value && view.value.launch.available && (free.value || view.value.launch.create));
const free_ready = computed(() => selected_names.value.length > 0 && (!automatic.value || selected_names.value.every(launch_ready) && view.value.launch.available));
const launch_open = ref(false);
watch(() => [launching.value, launch_names.value.every(launch_ready), view.value.launch.error], ([on, ready, error]) => {
  if (on && (!ready || error)) launch_open.value = true;
}, { immediate: true });

/** Keep the host inside the selected local members; free rooms also allow the user. */
function ensure_host() {
  if (!host_options.value.includes(host.value)) write("host", host_options.value[0] || "");
}
onMounted(ensure_host);

/** Change the room use independently of its delivery method. */
function choose_kind(kind) {
  write("kind", kind);
  ensure_host();
}

/** Change delivery without changing the room use. */
function choose_mode(mode) {
  write("mode", mode);
  ensure_host();
}

/** Arrow keys move and select within a radio group; Tab enters only its current choice. */
function navigate_choices(event) {
  const controls = [...event.currentTarget.querySelectorAll('[role="radio"]')];
  const current = controls.indexOf(event.target);
  const destinations = { ArrowRight: (current + 1) % controls.length, ArrowDown: (current + 1) % controls.length,
    ArrowLeft: (current + controls.length - 1) % controls.length, ArrowUp: (current + controls.length - 1) % controls.length,
    Home: 0, End: controls.length - 1 };
  if (!(event.key in destinations)) return;
  event.preventDefault();
  const target = controls[destinations[event.key]];
  target.focus();
  target.click();
}

/** Change one selected expert's participation mode and keep the host valid. */
function set_expert_mode(name, mode) {
  bridge.write_expert(EXPERT_CONTAINER, name, mode);
  ensure_host();
}

/** Explain capability separately from whether the launcher has software configured. */
function expert_status(name) {
  if (selected.value[name] === "online") return { text: "在线只读，回答由人代发", tone: "muted" };
  if (!automatic.value) return { text: "本地读写，可自行提交", tone: "muted" };
  return launch_ready(name) ? { text: "已配置本机软件", tone: "ready" } : { text: "待补齐软件连接", tone: "warn" };
}

/** Describe a platform before adding an independent instance. */
function library_description(name) {
  if (instance_count(name)) return `已加入 ${instance_count(name)} 位 · 可继续添加`;
  return bridge.launch_clients[name] ? "本地 App / CLI" : "网页 AI · 手动接入";
}

/** Admit one library role without toggling an existing participant. */
function add_expert(name) {
  if (automatic.value && !bridge.launch_clients[name]) return;
  const mode = bridge.launch_clients[name] ? "cli" : "online";
  // A card already in use adds another instance with its own session, model and effort.
  if (instance_count(name)) bridge.add_instance(EXPERT_CONTAINER, name, mode);
  else set_expert_mode(name, mode);
  ensure_host();
}

/** Remove a role, repair the host and return keyboard focus to the library entry. */
function remove_expert(name) {
  set_expert_mode(name, "");
  nextTick(() => library.value?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true }));
}

/** Submit the currently visible wheel values, including during an unfinished gesture. */
function submit() {
  limit_picker.value?.settle();
  emit("submit");
}

const limit_rule = computed(() => {
  const rounds = Number(value("limit-max_rounds")), minutes = Number(value("limit-max_minutes"));
  const limits = [rounds && `${rounds} 轮`, minutes && format_duration(minutes)].filter(Boolean);
  if (!limits.length) return "不设轮次和时长上限。";
  const action = value("limit-on_limit") === "summarize" ? "由主持人总结" : "暂停";
  return `最多 ${limits.join(" 或 ")}，${limits.length === 2 ? "先到则" : "到限后"}${action}。`;
});

const summary = computed(() => {
  const names = Object.keys(selected.value);
  if (free.value) return ["自由协作", `${names.length} 位 AI`, host.value === "用户" ? "你来主持" : `${host.value} 协助主持`, automatic.value ? "程序唤醒" : "手动接入"].join(" · ");
  const rounds = value("limit-max_rounds"), minutes = value("limit-max_minutes");
  const limits = [rounds && Number(rounds) ? `${rounds} 轮` : "不限轮次", minutes && Number(minutes) ? format_duration(Number(minutes)) : "不限时长"].join(" / ");
  return [host.value ? `${bridge.display_name(host.value)} 主持` : "尚未选择主持人", names.length ? `${names.join("、")} 参与` : "尚未选择专家",
    automatic.value ? "程序唤醒" : "手动接入", limits].join(" · ");
});
</script>

<template>
  <div class="create-discussion">
    <form id="create-discussion-form" class="create-scroll dialog-form" @submit.prevent="submit">
      <p v-if="targetFolder?.id" class="channel-create-location"><UIcon name="i-lucide-folder" />{{ targetFolder.name }}</p>
      <section class="create-section">
        <h3><span>1</span>这次做什么</h3>
        <div class="create-modes" role="radiogroup" aria-label="房间用法" @keydown="navigate_choices">
          <button v-for="option in KINDS" :key="option.value" type="button" role="radio" class="create-mode" :class="{ 'is-selected': (value('kind') || 'brainstorm') === option.value }" :aria-checked="(value('kind') || 'brainstorm') === option.value" :tabindex="(value('kind') || 'brainstorm') === option.value ? 0 : -1" @click="choose_kind(option.value)">
            <UIcon :name="option.icon" /><span class="create-mode-copy"><strong>{{ option.title }}</strong><small>{{ option.text }}</small></span>
          </button>
        </div>
        <UFormField label="话题名称" required><UInput :model-value="value('title')" :maxlength="80" required autofocus size="lg" :placeholder="free ? '这次要一起做什么？' : '这次想讨论什么？'" class="w-full" @update:model-value="write('title', $event)" /></UFormField>
        <UFormField label="用户原文" required :description="free ? '写下任务、背景和协作范围，成员按需阅读。' : '写下问题、背景和顾虑，AI 主持人据此补全讨论资料。'"><UTextarea :model-value="value('user_request')" :maxlength="4000" :rows="5" autoresize :maxrows="12" required placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" @update:model-value="write('user_request', $event)" /></UFormField>
      </section>

      <section class="create-section">
        <h3><span>2</span>谁来参与</h3>
        <div class="create-choice-group">
        <h4>接入方式</h4>
        <div class="create-modes" role="radiogroup" aria-label="接入方式" @keydown="navigate_choices">
          <button v-for="option in MODES" :key="option.value" type="button" role="radio" class="create-mode" :class="{ 'is-selected': value('mode') === option.value }" :aria-checked="value('mode') === option.value" :tabindex="value('mode') === option.value ? 0 : -1" @click="choose_mode(option.value)">
            <UIcon :name="option.icon" /><span class="create-mode-copy"><strong>{{ option.title }}</strong><small>{{ option.text }}</small></span>
          </button>
        </div>
        </div>
        <div class="create-choice-group">
        <div class="create-expert-heading"><h4>AI 角色库</h4><span class="fine-print">每次添加一个独立实例</span></div>
        <div ref="library" class="create-role-library" role="group" aria-label="AI 角色库">
          <button v-for="name in experts" :key="name" type="button" :disabled="automatic && !bridge.launch_clients[name]" :aria-label="`添加 ${name} 实例`" @click="add_expert(name)">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar" :class="bridge.identities[name]?.style" />
            <span><strong>{{ name }}</strong><small>{{ library_description(name) }}</small></span><UIcon name="i-lucide-plus" />
          </button>
        </div>
        <p class="fine-print create-hint">{{ automatic ? '程序唤醒支持已适配的本地软件；网页 AI 请使用手动接入。' : '手动接入本地 AI 后，它可自行提交回答；网页 AI 只读，由你或授权主持人代发。' }}</p>
        <div class="create-expert-heading create-joined-heading"><h4>已加入 <span>{{ selected_names.length }}</span></h4><span class="fine-print">本地软件可翻面设置</span></div>
        <div v-if="selected_names.length" class="create-experts" role="group" aria-label="参与的 AI">
          <ExpertCard v-for="name in selected_names" :key="name" :name="name" :mode="selected[name]" :automatic="automatic"
            :status="expert_status(name)" @remove="remove_expert(name)" @mode="set_expert_mode(name, $event)" />
        </div>
        <p v-else class="create-experts-empty">从上方角色库添加 AI；同一平台可以添加多位。</p>
        <div class="create-host-setting">
          <div class="create-host">
            <span class="create-label">{{ free ? '谁来主持' : 'AI 主持人' }}</span>
            <span v-if="!host_options.length" class="fine-print create-host-empty">先添加一位本地读写的 AI</span>
            <div v-else class="create-host-choices" role="radiogroup" aria-label="主持人" @keydown="navigate_choices">
              <button v-for="name in host_options" :key="name" type="button" role="radio" :aria-checked="host === name" :tabindex="host === name ? 0 : -1" @click="write('host', name)"><span aria-hidden="true" />{{ name === '用户' ? '我来主持' : bridge.display_name(name) }}</button>
            </div>
          </div>
          <p class="fine-print create-hint">{{ free ? '默认由你点名和分配任务，也可指定一位本地 AI 协助主持。' : '主持人须为本地读写 AI，负责补全议题、安排发言与收束，也可同时作为专家。' }}</p>
        </div>
        </div>
      </section>

      <section v-if="!free" class="create-section">
        <h3><span>3</span>讨论多久</h3>
        <LimitPicker ref="limit_picker" :rounds="Number(value('limit-max_rounds'))" :minutes="Number(value('limit-max_minutes'))"
          @update:rounds="write('limit-max_rounds', String($event))" @update:minutes="write('limit-max_minutes', String($event))" />
        <p class="fine-print create-hint">一轮指每位专家各完成一次观点；首次进入讨论或创建安排后计时，暂停期间不计时。</p>
        <div v-if="automatic" class="form-two-columns">
          <UFormField label="单次 AI 执行（分钟）" description="留空或 0 表示不限"><UInput :model-value="Number(value('limit-execution_minutes')) ? value('limit-execution_minutes') : ''" type="number" :min="0" :max="60" :step="1" placeholder="不限时长" class="w-full" @update:model-value="write('limit-execution_minutes', $event)" /></UFormField>
        </div>
        <div class="create-host">
          <span class="create-label">达到任一上限后</span>
          <div class="create-chips" role="radiogroup" aria-label="达到上限后">
            <button v-for="option in [{ value: 'pause', label: '暂停保留现场' }, { value: 'summarize', label: '由主持人总结' }]" :key="option.value" type="button" role="radio" :aria-checked="(value('limit-on_limit') || 'pause') === option.value" :class="{ 'is-selected': (value('limit-on_limit') || 'pause') === option.value }" @click="write('limit-on_limit', option.value)">{{ option.label }}</button>
          </div>
          <UInput v-if="value('limit-on_limit') === 'summarize'" :model-value="value('limit-summary_minutes')" type="number" :min="1" :max="60" :step="1" aria-label="收束预留（分钟）" class="create-summary-minutes" @update:model-value="write('limit-summary_minutes', $event)"><template #trailing><span class="fine-print">分钟收束</span></template></UInput>
        </div>
        <p class="create-limit-rule" aria-live="polite"><UIcon name="i-lucide-flag" />{{ limit_rule }}</p>
      </section>

      <section v-if="automatic" class="create-section">
        <h3><span>{{ free ? 3 : 4 }}</span>启动本机软件</h3>
        <p v-if="free && !view.launch.available" role="alert" class="fine-print create-hint">程序唤醒需要本机服务：请在运行 AI 的电脑打开本机网站，或先运行连接命令。</p>
        <template v-if="view.launch.available">
          <UCheckbox v-if="!free" :model-value="view.launch.create" label="创建后立即启动 AI" description="由本机服务创建会话并交付首个主持任务；不勾选则只建房，稍后在「接入」页启动。" @update:model-value="bridge.write_launch('create', '', $event)" />
          <template v-if="free || view.launch.create">
            <div class="form-two-columns">
              <UFormField label="项目目录（可选）" help="要一起查看的项目；留空时 AI 只在讨论私有目录工作"><UInput :model-value="view.launch.workspace.cwd || ''" placeholder="已有目录的完整路径" class="w-full" @update:model-value="bridge.write_launch('workspace', 'cwd', $event)" /></UFormField>
              <UFormField label="项目文件" :help="free ? '默认只读；要让 AI 改代码请选可写，仅本房间有效' : '默认只读；可写允许 CLI 专家按议题修改项目文件，仅本次有效'"><USelect :model-value="view.launch.workspace.project_access || 'read'" :items="ACCESS_ITEMS" class="w-full" @update:model-value="bridge.write_launch('workspace', 'project_access', $event)" /></UFormField>
            </div>
            <ul class="create-launch-list">
              <li v-for="name in launch_names" :key="name"><UIcon :name="launch_ready(name) ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'" :class="launch_ready(name) ? 'is-ready' : 'is-warn'" /><strong>{{ name }}</strong><span>{{ bridge.launch_summary(name).client }} · {{ bridge.launch_summary(name).session }} · {{ bridge.launch_summary(name).access }} · {{ bridge.launch_summary(name).cwd }}</span></li>
            </ul>
            <UCollapsible v-model:open="launch_open">
              <UButton :icon="launch_open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" label="调整启动配置" color="neutral" variant="link" size="sm" class="create-more" />
              <template #content><LaunchSettings :participants="launch_names" :workspace="false" :model-selection="false" /></template>
            </UCollapsible>
          </template>
        </template>
        <LaunchSettings v-else :participants="launch_names" :workspace="false" :model-selection="false" />
      </section>
    </form>
    <footer class="create-footer">
      <p v-if="launching && view.launch.error" role="alert" class="create-error">{{ view.launch.error }}</p>
      <div class="create-footer-row">
        <span class="create-summary" :title="summary">{{ summary }}</span>
        <UButton label="取消" color="neutral" variant="ghost" @click="emit('cancel')" />
        <UButton type="submit" form="create-discussion-form" class="channel-primary-button" :icon="launching ? 'i-lucide-play' : 'i-lucide-plus'" :label="free ? automatic ? '创建并连接' : '创建协作房间' : launching ? '创建并启动讨论' : '创建讨论'" :disabled="free ? !free_ready : !host" :loading="pending === 'create'" />
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
.create-choice-group { display: flex; flex-direction: column; gap: 12px; }
.create-choice-group + .create-choice-group { margin-top: 8px; }
.create-choice-group h4 { margin: 0; color: var(--ui-text-toned); font-size: 12px; font-weight: 500; }
.create-modes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.create-mode { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; text-align: left; background: color-mix(in srgb, var(--ui-bg-elevated) 35%, transparent); color: var(--ui-text-muted); }
.create-mode:hover { border-color: var(--ui-border-accented); }
.create-mode-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.create-mode strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-mode small { font-size: 11px; line-height: 1.6; }
.create-mode > [class*="icon"] { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; }
.create-mode::after { content: ""; flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px; border: 1px solid var(--ui-border-accented); border-radius: 50%; }
.create-mode.is-selected { background: color-mix(in srgb, var(--channel-accent) 7%, var(--ui-bg)); }
.create-mode.is-selected > [class*="icon"] { color: var(--channel-accent); }
.create-mode.is-selected::after { border-color: var(--channel-accent); background: radial-gradient(circle, var(--channel-accent) 3px, transparent 3.5px); }
.create-experts { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); align-items: start; gap: 10px; }
.create-expert-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.create-expert-heading h4 { display: flex; align-items: center; gap: 7px; }
.create-expert-heading h4 > span { min-width: 19px; padding: 1px 5px; border-radius: 4px; background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
.create-joined-heading { margin-top: 8px; }
.create-experts-empty { margin: 0; padding: 24px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.create-role-library { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.create-role-library > button { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 66px; padding: 10px; border: 1px solid var(--ui-border-muted); border-radius: 6px; text-align: left; }
.create-role-library > button:hover:not(:disabled) { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); }
.create-role-library > button:disabled { opacity: .5; }
.create-role-library .channel-avatar { flex-shrink: 0; width: 28px; height: 28px; }
.create-role-library button > span:nth-child(2) { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 0; }
.create-role-library strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 500; }
.create-role-library small { color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; }
.create-role-library button > span:last-child { width: 13px; height: 13px; flex-shrink: 0; color: var(--ui-text-muted); }
@media (pointer: coarse) { .create-host-setting .create-host-choices button { min-height: 44px; } }
.create-host-setting { display: grid; gap: 10px; margin-top: 4px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.create-host-choices { display: flex; flex-wrap: wrap; gap: 4px; }
.create-host-choices button { display: inline-flex; align-items: center; gap: 7px; min-height: 30px; padding: 4px 9px; border: 1px solid transparent; border-radius: 5px; color: var(--ui-text-muted); font-size: 12px; }
.create-host-choices button:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.create-host-choices button > span { width: 12px; height: 12px; border: 1px solid var(--ui-border-accented); border-radius: 50%; }
.create-host-choices button[aria-checked="true"] { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); border-color: var(--channel-edge-control, var(--ui-border)); }
.create-host-choices button[aria-checked="true"] > span { border-color: var(--channel-accent); background: radial-gradient(circle, var(--channel-accent) 2.5px, transparent 3px); }
.create-host { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.create-host-empty { margin: 0 !important; }
.create-label { min-width: 64px; color: var(--ui-text-toned); font-size: 12px; }
.create-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.create-chips button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.create-chips button:hover { border-color: var(--ui-border-accented); }
.create-chips button.is-selected { background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
.create-chips button [class*="icon"] { width: 13px; height: 13px; color: #e0b44a; }
.create-summary-minutes { width: 150px; }
.create-hint { margin-top: -4px !important; }
.create-limit-rule { display: flex; align-items: flex-start; gap: 8px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); color: var(--ui-text-muted); font-size: 12px; }
.create-limit-rule > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; margin-top: 2px; color: var(--channel-accent); }
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
  .create-modes, .create-experts { grid-template-columns: 1fr; }
  .create-role-library { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .create-footer { padding: 12px 18px 14px; }
  .create-summary { display: none; }
  .create-footer-row { justify-content: flex-end; }
}
</style>

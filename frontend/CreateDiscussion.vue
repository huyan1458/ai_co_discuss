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
/** Free collaboration: the user remote-controls one local AI; no host, rounds or limits. */
const free = computed(() => value("mode") === "free");
/** Both automatic discussions and free rooms run only local software through the launcher. */
const local = computed(() => automatic.value || free.value);
const MODES = [{ value: "automatic", icon: "i-lucide-zap", title: "全自动讨论", text: "本机服务按安排唤醒本地 AI" },
  { value: "manual", icon: "i-lucide-copy", title: "手动复制冷启动", text: "支持在线 AI，由你或定时任务触发" },
  { value: "free", icon: "i-lucide-message-circle", title: "自由协作", text: "在网页遥控一个本地 AI 干活" }];
const current_mode = computed(() => free.value ? "free" : automatic.value ? "automatic" : "manual");
const selected = computed(() => view.value.experts[EXPERT_CONTAINER] || {});
// Cards in the library are types; each selected name is one instance, e.g. Claude and Claude-2.
const selected_names = computed(() => Object.keys(selected.value).filter((name) => selected.value[name])
  .sort((left, right) => experts.indexOf(bridge.platform_of(left)) - experts.indexOf(bridge.platform_of(right)) || left.localeCompare(right, "en", { numeric: true })));
/** Instances already taken from one library card. */
const instance_count = (platform) => selected_names.value.filter((name) => bridge.platform_of(name) === platform).length;
const library_open = ref(false), library_trigger = ref(null);
const host = computed(() => value("host"));
const host_options = computed(() => selected_names.value.filter((name) => selected.value[name] === "cli"));
const limit_picker = ref(null);
const launch_names = computed(() => [...new Set([host.value, ...Object.keys(selected.value)])].filter((name) => bridge.launch_clients[name]));
const launch_ready = (name) => {
  const profile = view.value.launch.profiles[name] || {};
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
};
const launching = computed(() => free.value ? view.value.launch.available : automatic.value && view.value.launch.available && view.value.launch.create);
const free_ready = computed(() => selected_names.value.length > 0 && selected_names.value.every(launch_ready) && view.value.launch.available);
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
  if (local.value && !bridge.launch_clients[name]) return { text: "仅在线只读", tone: "muted" };
  if (local.value && view.value.launch.available) {
    const client = bridge.launch_clients[name]?.find((item) => item.value === view.value.launch.profiles[name]?.adapter);
    return launch_ready(name) ? { text: `本机 ${client?.label || 'AI'}`, tone: "ready" } : { text: "尚未配置本机软件", tone: "warn" };
  }
  if (!mode) return { text: bridge.launch_clients[name] ? "可本地读写" : "在线只读", tone: "muted" };
  return { text: mode === "cli" ? "本地读写，可担任主持" : "只读，回答由你代发", tone: "muted" };
}

/** Admit one library role without toggling an existing participant. */
function add_expert(name) {
  if (local.value && !bridge.launch_clients[name]) return;
  const mode = local.value || bridge.launch_clients[name] ? "cli" : "online";
  // A card already in use adds another instance with its own session, model and effort.
  if (instance_count(name)) bridge.add_instance(EXPERT_CONTAINER, name, mode);
  else set_expert_mode(name, mode);
  ensure_host();
  library_open.value = false;
}

/** Remove a role, repair the host and return keyboard focus to the library entry. */
function remove_expert(name) {
  set_expert_mode(name, "");
  nextTick(() => library_trigger.value?.focus({ preventScroll: true }));
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
  if (free.value) return [names.length ? `遥控 ${names.join("、")}` : "尚未选择 AI", "自由协作", "无主持人与轮次"].join(" · ");
  const rounds = value("limit-max_rounds"), minutes = value("limit-max_minutes");
  const limits = [rounds && Number(rounds) ? `${rounds} 轮` : "不限轮次", minutes && Number(minutes) ? format_duration(Number(minutes)) : "不限时长"].join(" / ");
  return [host.value ? `${bridge.display_name(host.value)} 主持` : "尚未选择主持人", names.length ? `${names.join("、")} 参与` : "尚未选择专家",
    automatic.value ? "全自动" : "手动推进", limits].join(" · ");
});
</script>

<template>
  <div class="create-discussion">
    <form id="create-discussion-form" class="create-scroll dialog-form" @submit.prevent="submit">
      <p v-if="targetFolder?.id" class="channel-create-location"><UIcon name="i-lucide-folder" />{{ targetFolder.name }}</p>
      <section class="create-section">
        <h3><span>1</span>讨论什么</h3>
        <UFormField label="话题名称" required><UInput :model-value="value('title')" :maxlength="80" required autofocus size="lg" placeholder="这次想讨论什么？" class="w-full" @update:model-value="write('title', $event)" /></UFormField>
        <UFormField label="用户原文" required description="把你的问题、背景和顾虑原样写下来。讨论目标、背景与边界由 AI 主持人据此补全，之后可在「主持 → 编辑议题」修改。"><UTextarea :model-value="value('user_request')" :maxlength="4000" :rows="5" autoresize :maxrows="12" required placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" @update:model-value="write('user_request', $event)" /></UFormField>
      </section>

      <section class="create-section">
        <h3><span>2</span>谁来参与</h3>
        <div class="create-choice-group">
        <h4>推进方式</h4>
        <div class="create-modes" role="radiogroup" aria-label="讨论推进方式">
          <button v-for="option in MODES" :key="option.value" type="button" role="radio" class="create-mode" :class="{ 'is-selected': current_mode === option.value }" :aria-checked="current_mode === option.value" @click="choose_mode(option.value)">
            <UIcon :name="option.icon" /><span class="create-mode-copy"><strong>{{ option.title }}</strong><small>{{ option.text }}</small></span>
          </button>
        </div>
        </div>
        <div class="create-choice-group">
        <div class="create-expert-heading">
          <h4>{{ free ? '要遥控的 AI' : '参与的 AI' }} <span>{{ selected_names.length }}</span></h4>
          <UPopover v-model:open="library_open" :content="{ align: 'end', sideOffset: 8, collisionPadding: 12 }"
            :ui="{ content: 'create-role-library-popover' }">
            <button ref="library_trigger" type="button" class="create-library-trigger"><UIcon name="i-lucide-plus" />邀请 AI</button>
            <template #content>
              <div class="create-role-library">
                <div class="create-library-heading"><strong>选择参与的 AI</strong><button type="button" aria-label="关闭 AI 选择" @click="library_open = false"><UIcon name="i-lucide-x" /></button></div>
                <ul>
                  <li v-for="name in experts" :key="name">
                    <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar" :class="bridge.identities[name]?.style" />
                    <span class="create-library-description"><strong>{{ name }}</strong><small>{{ expert_status(name).text }}</small></span>
                    <button type="button" :disabled="local && !bridge.launch_clients[name]"
                      :aria-label="`将 ${name} 加入`" @click="add_expert(name)">{{ local && !bridge.launch_clients[name] ? '仅手动接入' : free ? '选择' : '加入讨论' }}</button>
                  </li>
                </ul>
              </div>
            </template>
          </UPopover>
        </div>
        <div v-if="selected_names.length" class="create-experts" role="group" aria-label="参与的 AI">
          <ExpertCard v-for="name in selected_names" :key="name" :name="name" :mode="selected[name]" :automatic="local"
            :status="expert_status(name)" @remove="remove_expert(name)" @mode="set_expert_mode(name, $event)" />
        </div>
        <p v-else class="create-experts-empty">{{ free ? '点击“邀请 AI”，选择要遥控的本地 AI；之后也可随时邀请或请离' : '点击“邀请 AI”，选择本场讨论的参与者' }}</p>
        <p v-if="free" class="fine-print create-hint">无需主持人：只有一位 AI 时每条消息都交给它；多位时由你点名或在正文中 @，被点名的 AI 各自在自己的会话里工作并回到频道回复，随时可以停止。</p>
        <div v-else class="create-host-setting">
          <div class="create-host">
            <span class="create-label">AI 主持人</span>
            <span v-if="!host_options.length" class="fine-print create-host-empty">先选择一位本地读写的专家</span>
            <div v-else class="create-host-choices" role="radiogroup" aria-label="主持人">
              <button v-for="name in host_options" :key="name" type="button" role="radio" :aria-checked="host === name" @click="write('host', name)"><span aria-hidden="true" />{{ bridge.display_name(name) }}</button>
            </div>
          </div>
          <p class="fine-print create-hint">{{ automatic ? '全自动要求主持人与专家都是本机 AI；在线 AI 请改用手动推进。' : '主持人须为本地读写的专家；' }}主持人会先补全议题资料，也可同时作为专家发言。</p>
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

      <section v-if="local" class="create-section">
        <h3><span>{{ free ? 3 : 4 }}</span>{{ free ? '连接本机' : '启动' }}</h3>
        <p v-if="free && !view.launch.available" role="alert" class="fine-print create-hint">自由协作需要本机服务：请在运行 AI 的电脑打开本机网站，或先运行连接命令。</p>
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
        <LaunchSettings v-else-if="!free" :participants="launch_names" :workspace="false" :model-selection="false" />
      </section>
    </form>
    <footer class="create-footer">
      <p v-if="launching && view.launch.error" role="alert" class="create-error">{{ view.launch.error }}</p>
      <div class="create-footer-row">
        <span class="create-summary" :title="summary">{{ summary }}</span>
        <UButton label="取消" color="neutral" variant="ghost" @click="emit('cancel')" />
        <UButton type="submit" form="create-discussion-form" class="channel-primary-button" :icon="launching ? 'i-lucide-play' : 'i-lucide-plus'" :label="free ? '创建并连接' : launching ? '创建并启动讨论' : '创建讨论'" :disabled="free ? !free_ready : !host" :loading="pending === 'create'" />
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
.create-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.create-mode { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; text-align: left; background: color-mix(in srgb, var(--ui-bg-elevated) 35%, transparent); color: var(--ui-text-muted); transition: border-color .12s, background .12s; }
.create-mode:hover { border-color: var(--ui-border-accented); }
.create-mode-copy { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.create-mode strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-mode small { font-size: 11px; line-height: 1.6; }
.create-mode > [class*="icon"] { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; }
.create-mode::after { content: ""; flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px; border: 1px solid var(--ui-border-accented); border-radius: 50%; }
.create-mode.is-selected { border-color: color-mix(in srgb, var(--channel-accent) 60%, var(--ui-border)); background: color-mix(in srgb, var(--channel-accent) 7%, var(--ui-bg)); }
.create-mode.is-selected > [class*="icon"] { color: var(--channel-accent); }
.create-mode.is-selected::after { border-color: var(--channel-accent); background: radial-gradient(circle, var(--channel-accent) 3px, transparent 3.5px); }
.create-experts { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); align-items: start; gap: 10px; }
.create-expert-heading, .create-library-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.create-expert-heading h4 { display: flex; align-items: center; gap: 7px; }
.create-expert-heading h4 > span { min-width: 19px; padding: 1px 5px; border-radius: 4px; background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 11px; text-align: center; font-variant-numeric: tabular-nums; }
.create-library-trigger { display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 4px 9px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 6px; background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); color: var(--ui-text-toned); font-size: 12px; }
.create-library-trigger:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.create-library-trigger > [class*="icon"] { width: 13px; height: 13px; }
.create-experts-empty { margin: 0; padding: 24px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
:global(.create-role-library-popover) { z-index: 60; width: 352px; max-width: calc(100vw - 24px); border: 1px solid var(--channel-edge-float, var(--ui-border)); border-radius: 8px; background: var(--ui-bg); box-shadow: var(--channel-shadow-float); animation: none !important; }
.create-role-library { padding: 6px; }
.create-library-heading { margin: 0 6px 4px; padding: 6px 0 10px; border-bottom: 1px solid var(--ui-border-muted); }
.create-library-heading > strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-library-heading > button { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 5px; color: var(--ui-text-muted); }
.create-library-heading > button:hover { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.create-library-heading > button > [class*="icon"] { width: 15px; height: 15px; }
.create-role-library ul { display: grid; gap: 2px; }
.create-role-library li { display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 9px 8px; border-radius: 5px; }
.create-role-library li:has(button:not(:disabled)):hover { background: var(--ui-bg-elevated); }
.create-role-library li > .channel-avatar { width: 30px; height: 30px; }
.create-library-description { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.create-role-library li strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.create-role-library li small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.create-role-library li > button { flex-shrink: 0; min-height: 30px; padding: 5px 8px; border-radius: 5px; background: color-mix(in srgb, var(--channel-accent) 9%, transparent); color: var(--channel-accent); font-size: 11px; }
.create-role-library li > button:hover:not(:disabled) { background: color-mix(in srgb, var(--channel-accent) 16%, transparent); }
.create-role-library li > button:disabled { background: transparent; color: var(--ui-text-dimmed); }
.create-library-trigger:focus-visible, .create-role-library button:focus-visible, .create-host-choices button:focus-visible { outline: 2px solid var(--channel-accent); outline-offset: 2px; }
@media (pointer: coarse) {
  .create-library-trigger, .create-library-heading > button, .create-role-library li > button, .create-host-setting .create-host-choices button { min-height: 44px; }
  .create-library-heading > button { width: 44px; }
}
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
.create-chips button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; transition: border-color .12s, background .12s; }
.create-chips button:hover { border-color: var(--ui-border-accented); }
.create-chips button.is-selected { border-color: var(--channel-accent); background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
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
  .create-modes { grid-template-columns: 1fr; }
  .create-footer { padding: 12px 18px 14px; }
  .create-summary { display: none; }
  .create-footer-row { justify-content: flex-end; }
}
</style>

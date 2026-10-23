<script setup>
/** New-discussion form: the user states the topic in their own words; the AI host drafts goal, background and boundaries. */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import LimitPicker, { format_duration } from "./LimitPicker.vue";
import ExpertCard from "./ExpertCard.vue";
import SchedulerSettings from "./SchedulerSettings.vue";

const props = defineProps({ targetFolder: { type: Object, default: null } });
const emit = defineEmits(["submit", "cancel"]);
const { view, bridge, pending, act } = inject("discussion");
const EXPERT_CONTAINER = "new-expert-modes";
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const field_id = (key) => `new-room-${key}`;
const value = (key) => view.value.fields[field_id(key)] ?? "";
const write = (key, next) => bridge.write_field(field_id(key), next);

const free = computed(() => value("kind") === "free");
const KINDS = [{ value: "brainstorm", icon: "i-lucide-messages-square", title: "讨论", text: "围绕议题轮流发言，形成结论" },
  { value: "free", icon: "i-lucide-message-circle", title: "自由协作", text: "按需点名 AI，在各自会话中工作" }];
const selected = computed(() => view.value.experts[EXPERT_CONTAINER] || {});
// Cards in the library are types; each selected name is one instance, e.g. Claude and Claude-2.
// The view lists members in platform order; remember the order they were added in so a new card lands at the end.
const added_order = ref([]);
const chosen_names = computed(() => Object.keys(selected.value).filter((name) => selected.value[name]));
watch(chosen_names, (names) => {
  added_order.value = [...added_order.value.filter((name) => names.includes(name)), ...names.filter((name) => !added_order.value.includes(name))];
}, { immediate: true });
const selected_names = computed(() => [...chosen_names.value].sort((left, right) => added_order.value.indexOf(left) - added_order.value.indexOf(right)));
/** Instances already taken from one library card. */
const instance_count = (platform) => selected_names.value.filter((name) => bridge.platform_of(name) === platform).length;
const library = ref(null);
const host = computed(() => value("host"));
// Members that submit their own answers can host; web members only read. The user is the client, never the host.
// A discussion's host is continued by the local service, so it cannot be a manual member.
const host_options = computed(() => selected_names.value.filter((name) => selected.value[name] !== "online" && (free.value || selected.value[name] !== "manual")));
const limit_picker = ref(null);
// Discussions run automatically; a free room needs the local service only for the members it wakes.
const woken_names = computed(() => selected_names.value.filter((name) => selected.value[name] === "cli"));
const automatic = computed(() => !free.value || woken_names.value.length > 0);
const launch_ready = (name) => {
  const profile = view.value.launch.profiles[name] || {};
  if (profile.adapter === "api") return Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model);
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
};
const launching = computed(() => automatic.value && view.value.launch.available && (free.value || view.value.launch.create));
const free_ready = computed(() => selected_names.value.length > 0 && woken_names.value.every(launch_ready) && (!woken_names.value.length || view.value.launch.available));
// Smart scheduling runs in the local service, so it is offered only when this room will be launched there.
const scheduling = computed(() => view.value.launch.available && (free.value ? woken_names.value.length > 0 : view.value.launch.create));
// Always shown; when it cannot run yet, say what is missing instead of hiding it.
const scheduling_blocker = computed(() => !view.value.launch.available ? "连接本机服务后可开启"
  : free.value && !woken_names.value.length ? "添加一位本机唤醒的成员后可开启"
  : !free.value && !view.value.launch.create ? "勾选「创建后立即启动 AI」后可开启" : "");
const scheduler_unready = computed(() => {
  const scheduler = view.value.launch.scheduler || {};
  return scheduling.value && scheduler.enabled && !(scheduler.provider && scheduler.model && scheduler.api_key_ref);
});
const CONNECTION_POLL_MS = 3000;
const needs_connection = computed(() => automatic.value && !view.value.launch.available);
let connection_timer = 0;
/** Why the create button is disabled, in the order the user can fix it. */
const blocker = computed(() => {
  if (free.value) {
    if (!selected_names.value.length) return "先添加 AI";
    if (needs_connection.value) return "先连接本机服务";
    const unready = woken_names.value.filter((name) => !launch_ready(name));
    return unready.length ? `补齐 ${unready.join("、")} 的接入配置` : scheduler_unready.value ? "补齐智能调度配置，或取消勾选" : "";
  }
  if (!host.value) return "先添加 AI 并选定主持人";
  return scheduler_unready.value ? "补齐智能调度配置，或取消勾选" : "";
});

/** Keep the host inside the selected members that answer by themselves. */
function ensure_host() {
  if (!host_options.value.includes(host.value)) write("host", host_options.value[0] || "");
}
onMounted(() => {
  ensure_host();
  // The user connects in another window, so detect it here instead of asking them to recheck.
  connection_timer = window.setInterval(() => { if (needs_connection.value && !document.hidden) act("check_launch_connection"); }, CONNECTION_POLL_MS);
});
onBeforeUnmount(() => window.clearInterval(connection_timer));

/** Change the room use independently of its delivery method. */
function choose_kind(kind) {
  write("kind", kind);
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

/** A platform with local software can also join by hand; an API-only platform cannot. */
const has_local = (name) => bridge.launch_clients[name]?.some((item) => item.value !== "api");
/** Free rooms choose delivery per member; a discussion's experts are woken or manual, its host always woken. */
// Manual needs no local software, so any platform can be pasted into whichever AI the user runs by hand.
const access_choices = (name) => free.value ? ["cli", "manual", "online"] : name !== host.value ? ["cli", "manual"] : [];

/** Change one selected expert's delivery, defaulting a woken API-only platform to its API, and keep the host valid. */
function set_expert_mode(name, mode) {
  if (mode === "cli" && !has_local(name) && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api");
  bridge.write_expert(EXPERT_CONTAINER, name, mode);
  ensure_host();
}

/** Explain delivery separately from whether the launcher has software configured. */
function expert_status(name) {
  if (selected.value[name] === "online") return { text: "网页代发，由你转发回答", tone: "muted" };
  if (selected.value[name] === "manual") return { text: "手动接入，自行提交", tone: "muted" };
  const api = view.value.launch.profiles[name]?.adapter === "api";
  return launch_ready(name) ? { text: api ? "已配置 API" : "已配置本机软件", tone: "ready" } : { text: api ? "待补齐 API 配置" : "待补齐接入配置", tone: "warn" };
}

/** Describe a platform before adding an independent instance. */
function library_description(name) {
  if (instance_count(name)) return `已加入 ${instance_count(name)} 位 · 可继续添加`;
  return has_local(name) ? "API / 本地 App / CLI / 手动接入" : free.value ? "API / 手动接入 / 网页代发" : "API / 手动接入";
}

/** Admit one library role, woken by the local service until its card says otherwise. */
function add_expert(name) {
  if (!bridge.launch_clients[name]) return;
  if (!has_local(name) && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api");
  // A card already in use adds another instance with its own session, model and effort.
  if (instance_count(name)) bridge.add_instance(EXPERT_CONTAINER, name, "cli");
  else set_expert_mode(name, "cli");
  ensure_host();
}

/** Remove a role, repair the host and return keyboard focus to the library entry. */
function remove_expert(name) {
  set_expert_mode(name, "");
  nextTick(() => library.value?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true }));
}

const picking = ref(false);

/** Open the computer's folder dialog through the local service; typing a path remains available. */
async function pick_directory() {
  picking.value = true;
  try { await bridge.pick_launch_directory(); } finally { picking.value = false; }
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
  if (free.value) return ["自由协作", `${names.length} 位 AI`, host.value ? `${host.value} 主持` : "无主持人"].join(" · ");
  const rounds = value("limit-max_rounds"), minutes = value("limit-max_minutes");
  const limits = [rounds && Number(rounds) ? `${rounds} 轮` : "不限轮次", minutes && Number(minutes) ? format_duration(Number(minutes)) : "不限时长"].join(" / ");
  return [host.value ? `${bridge.display_name(host.value)} 主持` : "尚未选择主持人", names.length ? `${names.join("、")} 参与` : "尚未选择专家", limits].join(" · ");
});
</script>

<template>
  <div class="create-discussion">
    <form id="create-discussion-form" class="create-scroll dialog-form" @submit.prevent="submit">
      <div v-if="needs_connection" class="create-connect" role="status">
        <p><UIcon name="i-lucide-plug-zap" />本机服务未连接，连接后才能唤醒本机 AI。在运行 AI 的电脑上执行下面的命令并完成网页授权，连上后自动检测。</p>
        <div class="create-connect-command"><code>{{ view.launch.connect_command }}</code><UButton icon="i-lucide-copy" aria-label="复制本机连接命令" variant="ghost" color="neutral" @click="act('copy', view.launch.connect_command)" /></div>
      </div>
      <p v-if="targetFolder?.id" class="channel-create-location"><UIcon name="i-lucide-folder" />{{ targetFolder.name }}</p>
      <section class="create-section">
        <h3><span>1</span>这次做什么</h3>
        <div class="create-modes" role="radiogroup" aria-label="房间用法" @keydown="navigate_choices">
          <button v-for="option in KINDS" :key="option.value" type="button" role="radio" class="create-mode" :class="{ 'is-selected': (value('kind') || 'brainstorm') === option.value }" :aria-checked="(value('kind') || 'brainstorm') === option.value" :tabindex="(value('kind') || 'brainstorm') === option.value ? 0 : -1" @click="choose_kind(option.value)">
            <UIcon :name="option.icon" /><span class="create-mode-copy"><strong>{{ option.title }}</strong><small>{{ option.text }}</small></span>
          </button>
        </div>
        <UFormField label="话题名称" required><UInput :model-value="value('title')" :maxlength="80" required autofocus size="lg" :placeholder="free ? '这次要一起做什么？' : '这次想讨论什么？'" class="w-full" @update:model-value="write('title', $event)" /></UFormField>
        <!-- A free room's task evolves in the conversation itself, so only the discussion form asks for an opening brief. -->
        <UFormField v-if="!free" label="用户原文" required description="写下问题、背景和顾虑，AI 主持人据此补全讨论资料。"><UTextarea :model-value="value('user_request')" :maxlength="4000" :rows="5" autoresize :maxrows="12" required placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" @update:model-value="write('user_request', $event)" /></UFormField>
      </section>

      <section class="create-section">
        <h3><span>2</span>谁来参与</h3>
        <p class="fine-print create-hint">{{ free ? '每位成员单独选：自动（本机唤醒）、手动（你来启动）或网页（由你转发回答）。' : '主持人由本机自动启动，专家可选自动或手动。网页 AI 请用自由协作。' }}</p>
        <div v-if="selected_names.length" class="create-experts" role="group" aria-label="参与的 AI">
          <ExpertCard v-for="name in selected_names" :key="name" :name="name" :mode="selected[name]" :choices="access_choices(name)"
            :status="expert_status(name)" :host="host === name" :hostable="host_options.includes(name)" hosting
            @host="write('host', name)" @remove="remove_expert(name)" @mode="set_expert_mode(name, $event)" />
        </div>
        <p v-else class="create-experts-empty">从下方添加 AI；同一平台可添加多位，各自独立会话。</p>
        <div ref="library" class="create-roster-add" role="group" aria-label="添加 AI">
          <span class="create-label">添加</span>
          <button v-for="name in experts" :key="name" type="button" :disabled="!bridge.launch_clients[name]" :title="library_description(name)" :aria-label="`添加 ${name} 实例`" @click="add_expert(name)">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="3xs" class="channel-avatar" :class="bridge.identities[name]?.style" />{{ name }}<UIcon name="i-lucide-plus" />
          </button>
        </div>
        <div class="fine-print create-hint create-host-hint">
          <UIcon name="i-lucide-crown" />
          <span>{{ free ? host_options.length ? '点卡片上的皇冠指定主持人：没 @ 任何人的消息由它分配；其他成员只在被你或主持人点名时发言。' : '网页 AI 不能主持；添加一位本地 AI 后，没 @ 的消息才有人接。' : host_options.length ? '点卡片上的皇冠指定主持人，负责补全议题、安排发言与收束，也可同时作为专家。' : '先添加一位 AI 担任主持人。' }}</span>
        </div>
        <SchedulerSettings :free="free" :blocker="scheduling_blocker" />
      </section>

      <section v-if="!free" class="create-section">
        <h3><span>3</span>讨论多久</h3>
        <LimitPicker ref="limit_picker" :rounds="Number(value('limit-max_rounds'))" :minutes="Number(value('limit-max_minutes'))"
          @update:rounds="write('limit-max_rounds', String($event))" @update:minutes="write('limit-max_minutes', String($event))" />
        <p class="fine-print create-hint">一轮指每位专家各完成一次观点；首次进入讨论或创建安排后计时，暂停期间不计时。</p>
        <UCheckbox :model-value="Boolean(view.named_followup)" label="点名追问" description="开启后，主持人每轮读完回答再逐位点名追问；关闭时专家之间互相回应、互相提问，主持人只开场和收尾。" @update:model-value="bridge.write_named_followup($event)" />
        <div class="form-two-columns">
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

      <section class="create-section">
        <h3><span>{{ free ? 3 : 4 }}</span>启动 AI</h3>
        <p v-if="!view.launch.available" class="fine-print create-hint">连接本机服务后，可在此设置项目目录和启动方式。</p>
        <template v-else>
          <UCheckbox v-if="!free" :model-value="view.launch.create" label="创建后立即启动 AI" description="由本机服务创建会话并交付首个主持任务；不勾选则只建房，稍后在「接入」页启动。" @update:model-value="bridge.write_launch('create', '', $event)" />
          <template v-if="free || view.launch.create">
            <UFormField label="项目目录（可选）">
              <UInput :model-value="view.launch.workspace.cwd || ''" placeholder="输入完整路径，或点右侧图标选择" class="w-full" :ui="{ trailing: 'pe-1' }" @update:model-value="bridge.write_launch('workspace', 'cwd', $event)">
                <template #trailing><UButton icon="i-lucide-folder-open" color="neutral" variant="ghost" size="xs" aria-label="在本机选择项目目录" :title="picking ? '目录选择窗口已打开，请在本机窗口中选择' : '在本机选择文件夹'" :disabled="picking" @click="pick_directory" /></template>
              </UInput>
            </UFormField>
            <p class="fine-print create-hint">供本地软件查看的项目，读写权限在专家卡片上设置。API 仅使用房间上下文。</p>
          </template>
        </template>
      </section>
    </form>
    <footer class="create-footer">
      <p v-if="launching && view.launch.error" role="alert" class="create-error">{{ view.launch.error }}</p>
      <div class="create-footer-row">
        <span class="create-summary" :class="{ 'is-blocked': blocker }" :title="summary">{{ blocker ? `还差：${blocker}` : summary }}</span>
        <UButton label="取消" color="neutral" variant="ghost" @click="emit('cancel')" />
        <UButton type="submit" form="create-discussion-form" class="channel-primary-button" :icon="launching ? 'i-lucide-play' : 'i-lucide-plus'" :label="free ? automatic ? '创建并连接' : '创建协作房间' : launching ? '创建并启动讨论' : '创建讨论'" :disabled="(free ? !free_ready : !host) || scheduler_unready" :loading="pending === 'create'" />
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* A fixed height keeps the dialog still when switching room use or delivery adds or removes sections. */
.create-discussion { display: flex; flex-direction: column; height: min(78dvh, 820px); }
.create-scroll { flex: 1; min-height: 0; }
.create-scroll { overflow-y: auto; padding: 20px 26px 24px; gap: 26px !important; }
.create-section { display: flex; flex-direction: column; gap: 14px; }
.create-section + .create-section { padding-top: 22px; border-top: 1px solid var(--ui-border-muted); }
.create-section h3 { display: flex; align-items: center; gap: 9px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-section h3 > span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, var(--channel-accent) 18%, transparent); color: var(--channel-accent); font-size: 11px; }
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
.create-experts { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); align-items: start; gap: 8px; }
.create-experts-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.create-roster-add { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.create-roster-add .create-label { min-width: 0; margin-right: 2px; }
.create-roster-add > button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 8px 2px 4px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.create-roster-add > button:hover:not(:disabled) { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.create-roster-add > button:disabled { opacity: .45; }
.create-roster-add .channel-avatar { flex-shrink: 0; width: 20px; height: 20px; font-size: 9px; }
.create-roster-add > button > span:last-child { width: 12px; height: 12px; color: var(--ui-text-muted); }
.create-host-hint { display: flex; align-items: center; gap: 5px; }
.create-host-hint > [class*="icon"] { flex-shrink: 0; width: 12px; height: 12px; color: #e0b44a; }
@media (pointer: coarse) { .create-roster-add > button { min-height: 44px; } }
.create-host { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
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
.create-footer { flex-shrink: 0; padding: 14px 26px 16px; border-top: 1px solid var(--ui-border-muted); }
.create-footer-row { display: flex; align-items: center; gap: 8px; }
.create-summary { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.create-connect { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid color-mix(in srgb, #e0b44a 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #e0b44a 8%, transparent); font-size: 12px; }
.create-connect p { display: flex; align-items: flex-start; gap: 8px; margin: 0; color: var(--ui-text-toned); line-height: 1.6; }
.create-connect p > [class*="icon"] { flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px; color: #e0b44a; }
.create-connect-command { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--ui-bg-elevated); }
.create-connect-command code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.create-summary.is-blocked { color: #e0b44a; }
.create-error { margin-bottom: 10px; color: #f0716b; font-size: 12px; }
@media (max-width: 600px) {
  .create-discussion { height: calc(100dvh - 130px); }
  .create-scroll { padding: 18px 18px 20px; }
  .create-modes, .create-experts { grid-template-columns: 1fr; }
  .create-footer { padding: 12px 18px 14px; }
  .create-summary:not(.is-blocked) { display: none; }
  .create-footer-row { justify-content: flex-end; }
}
</style>

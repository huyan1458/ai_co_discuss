<script setup>
/** New-discussion form: the user states the topic in their own words; the AI host drafts goal, background and boundaries. */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { format_duration } from "./LimitPicker.vue";
import ChainRoundsField from "./ChainRoundsField.vue";
import DiscussionLimits from "./DiscussionLimits.vue";
import ExpertCard from "./ExpertCard.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import RosterAdd from "./RosterAdd.vue";
import SchedulerSettings from "./SchedulerSettings.vue";

const props = defineProps({ targetFolder: { type: Object, default: null } });
const emit = defineEmits(["submit", "cancel"]);
const { view, bridge, pending, act } = inject("discussion");
const EXPERT_CONTAINER = "new-expert-modes";
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const field_id = (key) => `new-room-${key}`;
const value = (key) => view.value.fields[field_id(key)] ?? "";
const write = (key, next) => bridge.write_field(field_id(key), next);

// Every new room is a collaboration room; a discussion is only an optional way to push it forward, opened right away or later.
const discussing = computed(() => Boolean(view.value.create_discussion));
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
const host_options = computed(() => selected_names.value.filter((name) => selected.value[name] !== "online" && (!discussing.value || selected.value[name] !== "manual")));
const limit_picker = ref(null);
// A room needs the local service only for the members it wakes, smart scheduling or a discussion.
const woken_names = computed(() => selected_names.value.filter((name) => selected.value[name] === "cli"));
// Smart scheduling alone also registers a room with the local service, even when every member is manual or online.
const automatic = computed(() => woken_names.value.length > 0 || scheduler_active.value || cwd_preset.value);
// Without the local service in this browser, the paired computer wakes members through the website.
const relay = computed(() => view.value.launch.available ? null : view.value.launch.relay);
const launchable = computed(() => view.value.launch.available || Boolean(relay.value));
// A project directory set before any member joins is remembered by the local service for members added later.
const cwd_preset = computed(() => view.value.launch.available ? Boolean(view.value.launch.workspace.cwd) : Boolean(relay.value && view.value.launch.workspace.local_project));
const launch_ready = (name) => {
  if (relay.value) return Boolean(relay.value.clients[bridge.platform_of(name)]);
  const profile = view.value.launch.profiles[name] || {};
  if (profile.adapter === "api") return Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model);
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
};
const launching = computed(() => automatic.value && launchable.value);
const room_ready = computed(() => selected_names.value.length > 0 && woken_names.value.every(launch_ready) && (!woken_names.value.length || launchable.value));
// Smart scheduling runs in the local service, so it is offered whenever the service is connected.
const scheduling = computed(() => view.value.launch.available);
const scheduler_active = computed(() => scheduling.value && Boolean(view.value.launch.scheduler?.enabled));
// Always shown; when it cannot run yet, say what is missing instead of hiding it.
const scheduling_blocker = computed(() => !view.value.launch.available ? "连接本机服务后可开启" : "");
const scheduler_unready = computed(() => {
  const scheduler = view.value.launch.scheduler || {};
  return scheduling.value && scheduler.enabled && !(scheduler.provider && scheduler.model && scheduler.api_key_ref);
});
const CONNECTION_POLL_MS = 3000;
const needs_connection = computed(() => automatic.value && !launchable.value);
let connection_timer = 0;
/** Why the create button is disabled, in the order the user can fix it. */
const blocker = computed(() => {
  if (discussing.value && selected.value[host.value] !== "cli") return "开启讨论需要先添加一位由本机唤醒的主持人";
  if (needs_connection.value) return "先连接本机服务，或把成员改为手动启动";
  if (discussing.value && !launchable.value) return "先连接本机服务";
  const unready = woken_names.value.filter((name) => !launch_ready(name));
  if (unready.length && relay.value) return `在电脑「${relay.value.name}」上配置 ${unready.join("、")}`;
  return unready.length ? `补齐 ${unready.join("、")} 的接入配置` : scheduler_unready.value ? "补齐决策模型配置，或移出决策模型" : "";
});
const submit_disabled = computed(() => !room_ready.value || Boolean(blocker.value) || scheduler_unready.value || pending.value === "create");

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

/** Opening a discussion needs a host the local service wakes, so the host moves off a manual member. */
function toggle_discussion(enabled) {
  bridge.write_create_discussion(enabled);
  nextTick(ensure_host);
}

/** A platform with local software can also join by hand; an API-only platform cannot. */
const has_local = (name) => bridge.launch_clients[name]?.some((item) => item.value !== "api");
/** Each member chooses its delivery: woken by the local service, or started by hand. A web AI joins as a manual member. */
// Manual needs no local software, so any platform can be pasted into whichever AI the user runs by hand.
const access_choices = (name) => discussing.value && name === host.value ? [] : ["cli", "manual"];

/** Change one selected expert's delivery, defaulting a woken API-only platform to its API, and keep the host valid. */
function set_expert_mode(name, mode) {
  if (mode === "cli" && !has_local(name) && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api");
  bridge.write_expert(EXPERT_CONTAINER, name, mode);
  ensure_host();
}

/** Explain delivery separately from whether the launcher has software configured. */
function expert_status(name) {
  if (selected.value[name] === "online") return { text: "网页代发，由你转发回答", tone: "muted" };
  if (selected.value[name] === "manual") return { text: "手动启动，自行提交", tone: "muted" };
  if (relay.value) return launch_ready(name) ? { text: `由电脑「${relay.value.name}」唤醒`, tone: "ready" } : { text: "电脑上尚未配置此软件", tone: "warn" };
  const api = view.value.launch.profiles[name]?.adapter === "api";
  return launch_ready(name) ? { text: api ? "已配置 API" : "已配置本机软件", tone: "ready" } : { text: api ? "待补齐 API 配置" : "待补齐接入配置", tone: "warn" };
}

/** Describe a platform before adding an independent instance. */
function library_description(name) {
  if (instance_count(name)) return `已加入 ${instance_count(name)} 位 · 可继续添加`;
  return has_local(name) ? "API / 本地 App / CLI / 手动启动" : "API / 手动启动";
}

// Presets follow the platforms, after a divider; each adds a named instance already set up for its job.
const PRESET_PREFIX = "preset:";
const library_items = computed(() => [...experts.map((name) => ({ value: name, name, ...bridge.identities[name],
  disabled: !bridge.launch_clients[name], title: library_description(name), aria_label: `添加 ${name} 实例` })),
  ...view.value && bridge.expert_presets().map((preset, index) => ({ value: PRESET_PREFIX + preset.name, name: preset.name, ...bridge.identities[bridge.platform_of(preset.name)],
    separated: index === 0, title: preset.description || "专家预设", aria_label: `添加预设 ${preset.name}` }))]);

/** Admit one library role, woken by the local service until its card says otherwise; a preset adds its own named instance. */
function add_expert(name) {
  if (name.startsWith(PRESET_PREFIX)) {
    const preset = bridge.expert_presets().find((item) => item.name === name.slice(PRESET_PREFIX.length));
    if (preset) bridge.add_preset(EXPERT_CONTAINER, preset, "cli");
    return ensure_host();
  }
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
  nextTick(() => library.value?.focus_first());
}

/** Apply the button's readiness checks to every submission, then settle any unfinished wheel gesture. */
function submit() {
  if (submit_disabled.value) return;
  limit_picker.value?.settle();
  emit("submit");
}

const summary = computed(() => {
  const names = Object.keys(selected.value);
  const parts = ["协作房间", names.length ? `${names.length} 位 AI` : "暂无成员", host.value ? `${host.value} 主持` : "暂无主持人"];
  if (discussing.value) {
    const rounds = value("limit-max_rounds"), minutes = value("limit-max_minutes");
    parts.push("开启讨论", [rounds && Number(rounds) ? `${rounds} 轮` : "不限轮次", minutes && Number(minutes) ? format_duration(Number(minutes)) : "不限时长"].join(" / "));
  }
  return parts.join(" · ");
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
        <UFormField label="话题名称" required><UInput :model-value="value('title')" :maxlength="80" required autofocus size="lg" placeholder="这次要一起做什么？" class="w-full" @update:model-value="write('title', $event)" /></UFormField>
        <UFormField label="项目目录（可选）" :description="view.launch.available ? '本机唤醒的成员在此目录读写文件；不填则各用软件默认目录。' : relay ? `由电脑「${relay.name}」唤醒的成员在所选项目中读写文件；不选则各用软件默认目录。` : '连接本机服务后可指定：本机唤醒的成员将在此目录读写文件。'">
          <ProjectDirectoryField :disabled="!launchable" />
        </UFormField>
      </section>

      <section class="create-section">
        <h3><span>2</span>谁来参与</h3>
        <RosterAdd ref="library" label="添加 AI" :items="library_items" @add="add_expert" />
        <div v-if="selected_names.length" class="create-experts" role="group" aria-label="参与的 AI">
          <ExpertCard v-for="name in selected_names" :key="name" :name="name" :mode="selected[name]" :choices="access_choices(name)"
            :status="expert_status(name)" :host="host === name" :hostable="host_options.includes(name)" hosting
            @host="write('host', name)" @remove="remove_expert(name)" @mode="set_expert_mode(name, $event)" />
        </div>
        <p v-else class="create-experts-empty">请至少添加一位成员。同一平台可添加多位，各自独立会话。</p>
        <div v-if="selected_names.length" class="fine-print create-hint create-host-hint">
          <UIcon name="i-lucide-crown" />
          <span>{{ host_options.length ? '点卡片上的皇冠指定主持人：没 @ 任何人的消息由它分配；其他成员只在被你或主持人点名时发言。' : '需要一位本地 AI 做主持人，没 @ 的消息才有人接。' }}</span>
        </div>
        <SchedulerSettings :free="true" :blocker="scheduling_blocker" />
      </section>

      <section class="create-section">
        <h3><span>3</span>讨论（可选）</h3>
        <UCheckbox :model-value="discussing" label="创建后开启讨论" description="主持人安排成员轮流发言，到上限或结束后回到自由协作。也可以建房后再开启。" @update:model-value="toggle_discussion($event)" />
        <template v-if="discussing">
          <UFormField label="讨论目标" description="写下问题、背景和顾虑，主持人据此推进。"><UTextarea :model-value="value('goal')" :maxlength="1000" :rows="4" autoresize :maxrows="10" placeholder="例如：我们在 A、B 两个方案之间犹豫，主要顾虑是成本和上线时间……" class="w-full" @update:model-value="write('goal', $event)" /></UFormField>
          <DiscussionLimits ref="limit_picker" :rounds="Number(value('limit-max_rounds'))" :minutes="Number(value('limit-max_minutes'))" :execution_minutes="value('limit-execution_minutes')"
            @update:rounds="write('limit-max_rounds', String($event))" @update:minutes="write('limit-max_minutes', String($event))" @update:execution_minutes="write('limit-execution_minutes', $event)">
            <UCheckbox :model-value="Boolean(view.named_followup)" label="点名追问" description="开启后，主持人每轮读完回答再逐位点名追问；关闭时专家之间互相回应、互相提问，主持人只开场和收尾。" @update:model-value="bridge.write_named_followup($event)" />
          </DiscussionLimits>
        </template>
      </section>

      <details class="create-advanced">
        <summary><UIcon name="i-lucide-chevron-right" class="create-advanced-icon" />高级设置<small>连续派活 {{ view.create_chain_rounds }} 轮</small></summary>
        <ChainRoundsField :model-value="view.create_chain_rounds" @update:model-value="bridge.write_create_chain_rounds($event)" />
        <p class="fine-print">建房后可在房间页修改。</p>
      </details>
    </form>
    <footer class="create-footer">
      <p v-if="launching && view.launch.error" role="alert" class="create-error">{{ view.launch.error }}</p>
      <div class="create-footer-row">
        <span class="create-summary" :class="{ 'is-blocked': blocker }" :title="blocker || summary" role="status"><UIcon v-if="blocker" name="i-lucide-circle-alert" />{{ blocker ? `还差：${blocker}` : selected_names.length || discussing ? summary : "" }}</span>
        <UButton label="取消" color="neutral" variant="ghost" @click="emit('cancel')" />
        <UButton type="submit" form="create-discussion-form" class="channel-primary-button" :icon="launching ? 'i-lucide-play' : 'i-lucide-plus'" :label="discussing ? '创建并开启讨论' : automatic ? '创建并连接' : '创建协作房间'" :disabled="submit_disabled" :loading="pending === 'create'" />
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* A fixed height keeps the dialog still when switching room use or delivery adds or removes sections. */
.create-discussion { display: flex; flex-direction: column; height: min(78dvh, 820px); }
.create-scroll { flex: 1; min-height: 0; }
.create-scroll { overflow-y: auto; scrollbar-gutter: stable; padding: 20px 26px 24px; gap: 26px !important; }
/* The folder label is a caption for the form, so it hugs the header and the first section. */
.create-scroll > .channel-create-location { margin: -8px 0 -14px; }
.create-section { display: flex; flex-direction: column; gap: 14px; }
.create-section + .create-section { padding-top: 22px; border-top: 1px solid var(--ui-border-muted); }
.create-section h3 { display: flex; align-items: center; gap: 9px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.create-section h3 > span { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: color-mix(in srgb, var(--channel-accent) 18%, transparent); color: var(--channel-accent); font-size: 11px; }
/* Rarely changed settings fold away; the summary still shows the current value. */
.create-advanced { padding-top: 16px; border-top: 1px solid var(--ui-border-muted); }
.create-advanced > summary { display: flex; align-items: center; gap: 6px; min-height: 28px; list-style: none; color: var(--ui-text-muted); font-size: 12px; cursor: pointer; }
.create-advanced > summary::-webkit-details-marker { display: none; }
.create-advanced > summary:hover { color: var(--ui-text-highlighted); }
.create-advanced > summary small { color: var(--ui-text-dimmed); font-size: 11px; }
.create-advanced-icon { width: 14px; height: 14px; transition: transform .15s; }
.create-advanced[open] > summary { margin-bottom: 10px; }
.create-advanced[open] .create-advanced-icon { transform: rotate(90deg); }
.create-advanced > .fine-print { margin: 6px 0 0; }
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
.create-host-hint { display: flex; align-items: center; gap: 5px; }
.create-host-hint > [class*="icon"] { flex-shrink: 0; width: 12px; height: 12px; color: #e0b44a; }
.create-host { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.create-label { min-width: 64px; color: var(--ui-text-toned); font-size: 12px; }
.create-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.create-chips button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 12px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.create-chips button:hover { border-color: var(--ui-border-accented); }
.create-chips button.is-selected { background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
.create-chips button [class*="icon"] { width: 13px; height: 13px; color: #e0b44a; }
.create-summary-minutes { width: 150px; }
.create-hint { margin-top: -4px !important; }
.create-footer { flex-shrink: 0; padding: 14px 26px 16px; border-top: 1px solid var(--ui-border-muted); }
.create-footer-row { display: flex; align-items: center; gap: 8px; }
.create-summary { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.create-connect { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid color-mix(in srgb, #e0b44a 45%, transparent); border-radius: 8px; background: color-mix(in srgb, #e0b44a 8%, transparent); font-size: 12px; }
.create-connect p { display: flex; align-items: flex-start; gap: 8px; margin: 0; color: var(--ui-text-toned); line-height: 1.6; }
.create-connect p > [class*="icon"] { flex-shrink: 0; width: 14px; height: 14px; margin-top: 3px; color: #e0b44a; }
.create-connect-command { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 6px; background: var(--ui-bg-elevated); }
.create-connect-command code { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.create-summary.is-blocked { display: flex; align-items: center; gap: 6px; color: #e0b44a; font-weight: 600; }
.create-summary.is-blocked > [class*="icon"] { flex-shrink: 0; width: 14px; height: 14px; }

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

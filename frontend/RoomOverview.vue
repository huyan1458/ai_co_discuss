<script setup>
import { LEVELS, LEVEL_SHORT, awaiting_member, copy_seat_link, external_ai, external_of, remaining_label, revoke_member, room_operations } from "./external-members.js";
/**
 * Everything about who is in the room and how it is set up, laid out in full: the rail's member menu is only the quick
 * entry to the same actions, so nothing here hides behind a menu.
 */
import { computed, inject, ref, watch } from "vue";
import ApiRequestsField from "./ApiRequestsField.vue";
import AutoDestroyField from "./AutoDestroyField.vue";
import ImageService from "./ImageService.vue";
import SchedulerSettings from "./SchedulerSettings.vue";
import WebSearchSettings from "./WebSearchSettings.vue";
import ChainRoundsField from "./ChainRoundsField.vue";
import EffortSlider from "./EffortSlider.vue";
import ModelRefresh from "./ModelRefresh.vue";
import ExtraDirectoriesField from "./ExtraDirectoriesField.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import HostWorkflowSwitch from "./HostWorkflowSwitch.vue";
import InviteDialog from "./InviteDialog.vue";
import WorkflowControl from "./WorkflowControl.vue";
import { active_workflow } from "./workflow-state.js";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import MemberNameEdit from "./MemberNameEdit.vue";
import ExternalMemberDialog from "./ExternalMemberDialog.vue";
import MemoBlock from "./memo-block.js";
import { member_actions } from "./member-actions.js";
import { access_label, access_options } from "../runner/expert_prompts.mjs";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { t } from "./i18n.js";

const { view, bridge, act } = inject("discussion");
const ACCESS_LABELS = { manual: t("手动接入") };
const STATUS_LABELS = { active: t("在场"), away: t("暂离") };
const unregistered = awaiting_member;
// CLIs and API members this tool grants project access per run; App members are left to their own settings.
const ACCESS_CLIENTS = ["codex_cli", "claude", "antigravity_cli", "api"];
const CODEX_OPTIONS = [{ value: "codex_cli", label: "CLI" }, { value: "codex", label: "App" }];
const ADAPTER_LABELS = { api: "API", codex: "App", antigravity: "App" };
const room = computed(() => view.value.room);
const free = computed(() => !["active", "paused"].includes(room.value.session?.status));
const saved = computed(() => view.value.launch.room_models?.room_id === room.value.id ? view.value.launch.room_models : null);
/**
 * One line, above the members, for why this computer's saved choices are not shown; cells then stay empty instead of
 * repeating it. agy's slower model read is not part of it: only that member waits, greyed out.
 */
const local_state = computed(() => {
  if (!view.value.launch.available) return { text: t("未连接本机服务，模型与权限暂不可见。") };
  // A re-read keeps showing the last answer, so only the first read says it is reading.
  if (!saved.value || (saved.value.loading && !saved.value.participants)) return { text: t("正在读取本机配置…") };
  if (saved.value.error) return { text: t("读取本机配置失败：{error}", { error: saved.value.error }), retry: true };
  return saved.value.registered === false ? { text: t("本机没有登记此房间，模型与权限不可见。") } : null;
});
/** An agy member waits for its default model to be read, so its switches stay greyed out until then. */
const waiting = (name) => Boolean(saved.value?.participants?.[name]?.defaults_pending);
// Members whose switch is being saved: the new choice already shows, and only that member's switches wait.
const switching = ref(new Set());
const set_switching = (name, on) => { const names = new Set(switching.value); if (on) names.add(name); else names.delete(name); switching.value = names; };
// The round limit the field shows: the saved one, or the value being saved until the room refreshes.
const saving_rounds = ref(false), rounds_shown = ref(0);
watch(() => room.value.free?.max_rounds, (value) => { rounds_shown.value = value || 0; }, { immediate: true });

/** Save a new round limit and say so; on failure the field goes back to the saved value and the error shows under the members. */
async function save_rounds(value) {
  rounds_shown.value = value;
  saving_rounds.value = true;
  try {
    await bridge.set_chain_rounds(value);
    bridge.notify("info", t("推进轮数已保存，进行中的任务链也按新值"));
  } catch { rounds_shown.value = room.value.free?.max_rounds || 0; }
  finally { saving_rounds.value = false; }
}
// The API request limit the field shows: the saved one, or the value being saved until the room models are read again.
const saving_requests = ref(false), requests_shown = ref(0);
watch(() => saved.value?.api_max_requests, (value) => { requests_shown.value = value ?? 0; }, { immediate: true });

// The project directories being edited: the main one only while the room has none (it is set once), and the extra
// ones, saved as a whole; blank rows are dropped when saving.
const saving_directories = ref(false), directories_draft = ref([]), main_draft = ref("");
watch(() => saved.value?.extra_directories, (value) => { directories_draft.value = [...(value || [])]; }, { immediate: true });
watch(() => saved.value?.project_directory, () => { main_draft.value = ""; });
const directories_changed = computed(() => Boolean(main_draft.value.trim())
  || JSON.stringify(directories_draft.value) !== JSON.stringify(saved.value?.extra_directories || []));
const directories_editable = computed(() => view.value.access?.can_manage && !room.value.archived && view.value.launch.available);

/** Save the room's main project directory (once) or its extra ones; members work with them from their next execution. */
async function save_directories() {
  saving_directories.value = true;
  try {
    if (main_draft.value.trim()) await bridge.set_room_project_directory(main_draft.value.trim());
    else await bridge.set_room_extra_directories(directories_draft.value.map((path) => path.trim()).filter(Boolean));
    bridge.notify("info", t("项目目录已保存，从各成员下一次执行起生效"));
  } catch { /* The error is shown; the draft stays for another try. */ } finally { saving_directories.value = false; }
}

/** Put the directories back as saved. */
function reset_directories() {
  main_draft.value = "";
  directories_draft.value = [...(saved.value?.extra_directories || [])];
}

/** Save a new API request limit for this room; it applies from each API member's next execution. */
async function save_requests(value) {
  requests_shown.value = value;
  saving_requests.value = true;
  try {
    await bridge.set_room_api_max_requests(value);
    bridge.notify("info", t("API 请求上限已保存，从下一次执行起生效"));
  } catch { requests_shown.value = saved.value?.api_max_requests ?? 0; }
  finally { saving_requests.value = false; }
}
// Cards follow the room's default speaking order (the host first until the owner reorders); away members come last.
const order = computed(() => room.value.speaking_order || { kind: "default", movable: [], default: [] });
const members = computed(() => {
  const rank = order.value.default || [];
  const place = (name) => rank.includes(name) ? rank.indexOf(name) : rank.length;
  return [...(room.value.members || [])].sort((left, right) => place(left.name) - place(right.name));
});
// Dragging a card sets the same default order as the rail; while members answer in turn or a discussion runs, the rail arranges them.
const reorderable = computed(() => Boolean(view.value.access?.can_manage) && !room.value.archived
  && order.value.kind === "default" && order.value.movable.length > 1);
const dragged = ref(""), drop_target = ref(""), grabbed = ref("");

function drag_start(member, event) {
  dragged.value = member.name;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", member.name);
}

function drag_over(member, event) {
  if (!dragged.value || dragged.value === member.name || !order.value.movable.includes(member.name)) return;
  event.preventDefault();
  drop_target.value = member.name;
}

/** Move the dragged member to the dropped card's place and send the whole order with the revision shown; a stale one is refused. */
function drop(member) {
  const names = [...order.value.movable];
  const from = names.indexOf(dragged.value), to = names.indexOf(member.name);
  drag_end();
  if (from < 0 || to < 0 || from === to) return;
  names.splice(to, 0, names.splice(from, 1)[0]);
  act("reorder_speakers", { revision: order.value.revision, order: names });
}

function drag_end() {
  dragged.value = drop_target.value = grabbed.value = "";
}
// The room's workflow as this computer registered it; its members carry a mark while it is enabled.
const workflow = computed(() => active_workflow(saved.value?.workflow, room.value.free?.members));
const in_workflow = (name) => Boolean(workflow.value?.enabled && Object.values(workflow.value.members || {}).includes(name));


/**
 * Being woken here is the usual case, so a woken member only names its kind (CLI / API / App), read from this
 * computer's registration when known since a Codex member may have switched. An idle Codex member in free
 * collaboration can switch between its App and CLI here.
 */
function access(member) {
  if (member.access === "external") return { text: "" };
  if (ACCESS_LABELS[member.access]) return { text: ACCESS_LABELS[member.access] };
  const adapter = saved.value?.participants?.[member.name]?.adapter;
  if (!["codex", "codex_cli"].includes(adapter)) return { text: adapter ? ADAPTER_LABELS[adapter] || "CLI" : bridge.participant_access(member.name, room.value) };
  const idle = !(member.pending > 0 || ["dispatched", "started"].includes(member.execution?.status));
  return { value: adapter, editable: free.value && idle && view.value.access?.can_manage && view.value.launch.available,
    hint: !free.value ? t("讨论进行中不能切换") : idle ? t("切换后沿用原会话；切回 CLI 前须让 App 释放原聊天") : t("正在处理请求，完成后再切换") };
}

/** Whether this member continues a session taken over from this computer, which keeps its own context and permissions. */
function adopted(member) {
  return member.access === "runner" && saved.value?.participants?.[member.name]?.project_access === "own";
}

/** Free-room members carry their live execution and pending count; older rooms list members without them. */
function live(member) {
  return (room.value.free?.members || []).find((item) => item.name === member.name) || member;
}

/** Switch a Codex member between App and CLI; its conversation stays. */
async function switch_adapter(member, adapter) {
  if (switching.value.has(member.name) || access(live(member)).value === adapter) return;
  set_switching(member.name, true);
  try {
    await bridge.set_member_adapter({ name: member.name, adapter });
    bridge.notify("info", t("{name} 已改为 {adapter} 接入，下次处理请求起生效。", { name: bridge.display_name(member.name), adapter: adapter === "codex" ? "App" : "CLI" }));
  } catch (error) { bridge.notify("error", error.message); }
  finally { set_switching(member.name, false); }
}

/** Project file access, and whether it can be switched here; anything that cannot says why on hover. */
function files(member) {
  if (member.access === "manual") return { text: t("自行决定"), hint: t("手动成员的权限由它自己的会话决定") };
  const profile = saved.value?.participants?.[member.name];
  if (!profile) return { text: "—" };
  if (profile.project_access === "own") return { text: t("自行决定"), hint: t("手动接入的成员，由本机服务投递时仍沿用它自己会话的软件权限") };
  if (!ACCESS_CLIENTS.includes(profile.adapter)) return { text: t("App 内设置"), hint: t("App 成员的权限在 App 里设置") };
  if (profile.own_project) return { text: t("agy 内设置"), hint: t("续接它自己的 agy 对话，权限沿用该对话所在项目") };
  if (waiting(member.name)) return { value: profile.project_access || "read", hint: t("正在读取 agy 的配置") };
  return { value: profile.project_access || "read", editable: view.value.access?.can_manage && view.value.launch.available };
}

/** Switch one member's project files; the change applies from its next request and keeps its session. */
async function switch_access(member, project_access) {
  if (switching.value.has(member.name) || files(member).value === project_access) return;
  set_switching(member.name, true);
  try {
    await bridge.set_member_access({ name: member.name, project_access });
    bridge.notify("info", t("{name} 已改为{access}，下次处理请求起生效。", { name: bridge.display_name(member.name), access: access_label(project_access) }));
  } catch (error) { bridge.notify("error", error.message); }
  finally { set_switching(member.name, false); }
}

const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };

/** Whether this member's model and effort can be changed here: a CLI or API member starts each run with them, an App chooses its own. */
function model_editable(member) {
  const profile = saved.value?.participants?.[member.name];
  const kind = adapter_profile(profile?.adapter)?.kind;
  return member.access === "runner" && Boolean(kind) && kind !== "app"
    && !waiting(member.name) && view.value.access?.can_manage && view.value.launch.available;
}

// The member whose model is being changed, with the draft the dialog edits.
const model_edit = ref(null);
const model_state = computed(() => model_edit.value && bridge.launch_model_state(model_edit.value.name, view.value.launch, model_edit.value.draft));
// A software that lists no models (a model API) takes a typed model ID and offers its declared effort levels.
const model_typed = computed(() => model_edit.value && !adapter_profile(model_edit.value.draft.adapter)?.models);
const model_efforts = computed(() => {
  const levels = model_state.value?.efforts || (model_typed.value ? adapter_profile(model_edit.value.draft.adapter)?.efforts : null);
  return levels?.length ? [{ label: t("默认强度"), value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
});

/** Open the dialog on the member's saved choices and read its software's model list. */
function edit_model(member) {
  const { adapter, model, effort } = saved.value.participants[member.name];
  model_edit.value = { name: member.name, draft: { adapter, model: model || "", effort: effort || "" } };
  if (!model_typed.value) bridge.load_launch_models(member.name, false, model_edit.value.draft);
}

/** Pick a model; an effort the new model does not offer goes back to the default. */
function pick_model(value) {
  const draft = model_edit.value.draft;
  draft.model = value === "__default__" ? "" : value;
  // agy reads its effort levels per model.
  if (draft.adapter === "antigravity_cli") bridge.load_launch_models(model_edit.value.name, false, draft);
  if (!model_state.value?.efforts?.includes(draft.effort)) draft.effort = "";
}

/**
 * Save the model and effort; they apply from the member's next request and keep its session. The dialog closes and the
 * card shows the choice at once; a refused save puts the old one back and says why.
 */
async function save_model() {
  const { name, draft } = model_edit.value;
  model_edit.value = null;
  try {
    await bridge.set_member_model({ name, model: draft.model, effort: draft.effort });
    // A member working in its own open window runs with that window's model until the window is closed.
    const in_window = saved.value?.participants?.[name]?.model_pending === "window";
    bridge.notify(in_window ? "warning" : "info", in_window
      ? t("{name} 的模型与强度已保存，但它正在自己打开的窗口里工作，任务会用那个窗口的模型；关闭该窗口后按此设置运行，或在窗口里自行切换。", { name: bridge.display_name(name) })
      : t("{name} 的模型与强度已更新，下次处理请求起生效，保留原会话。", { name: bridge.display_name(name) }));
  } catch (error) { bridge.notify("error", error.message); }
}

/** The smart scheduler lives in the local registration, so a page without the local service cannot tell. */
const scheduler = computed(() => {
  if (local_state.value) return "—";
  if (!saved.value.scheduler) return t("未开启");
  const provider = view.value.launch.scheduler_providers?.[saved.value.scheduler.provider]?.label || saved.value.scheduler.provider;
  return [provider, saved.value.scheduler.model].filter(Boolean).join(" · ");
});
const HOST_LABEL = t("设为主持人");
/**
 * Every action of a member as a button; 设为主持人 sits apart at the card's top right. A discussion arranges its members
 * from the progress board, so there only the taking-part actions (instructions, credentials, description) apply.
 */
function actions(member) {
  const [taking_part, place = [], removal = []] = member_actions(live(member), { view: view.value, act, describe: (name) => { describing.value = name; },
    external: open_external,
    revoke: (target) => revoke_member(bridge, act, view.value.room.id, target),
    copy_link: async (target) => { if (await copy_seat_link(bridge, view.value.room.id, target.id)) bridge.notify("info", t("已复制邀请链接")); } });
  if (!free.value) return { taking_part, host: null, place: [] };
  return { taking_part, host: place.find((item) => item.label === HOST_LABEL) || null, place: [...place.filter((item) => item.label !== HOST_LABEL), ...removal] };
}

/**
 * Everything one member card shows or offers, as one string, so a card re-renders only when it changes rather than on
 * every view publish (each of which rebuilds its action buttons and their handlers).
 */
function card_key(member) {
  const identity = bridge.identities[member.name];
  return JSON.stringify([member, live(member), saved.value?.participants?.[member.name], view.value.access, view.value.launch.available, free.value,
    reorderable.value && order.value.movable.includes(member.name), dragged.value === member.name, drop_target.value === member.name,
    grabbed.value === member.name, switching.value.has(member.name), in_workflow(member.name) && workflow.value.label, room.value.descriptions?.[member.name],
    identity?.icon, identity?.initials, identity?.style, bridge.display_name(member.name), bridge.participant_model(member.name, room.value, saved.value),
    bridge.participant_access(member.name, room.value), room.value.session?.status]);
}

// An external member's reading record and protections open in the same dialog as from the rail; an ended one opens on
// its invitation back.
const external_open = ref(false), external_member = ref(null), external_reinvite = ref(false);
function open_external(member, reinvite = false) { external_member.value = member; external_reinvite.value = reinvite; external_open.value = true; }
const ended_externals = computed(() => room.value.free?.ended_externals || []);
const END_REASONS = { revoked: t("已撤销"), expired: t("已到期"), left: t("对方已退出") };
/**
 * What an external member may see on this computer, as a switch: it can be narrowed to room messages here; opening the
 * project again takes a new invitation, as widening access stays with an invitation the owner issues.
 */
async function narrow_external(member, level) {
  const info = external_of(live(member));
  if (!info || level === info.level || level !== "discuss") return;
  set_switching(member.name, true);
  try {
    await room_operations(bridge).update(room.value.id, member.id, { scope: "discuss" });
    bridge.notify("info", t("已降为只讨论，之后不能再读项目文件"));
    await act("refresh");
  } catch (error) { bridge.notify("error", error.message); }
  finally { set_switching(member.name, false); }
}

const inviting = ref(false);
const invite_workflow_id = ref("");
const describing = ref(""), describing_saving = ref(false);
watch(() => room.value.id, () => { inviting.value = false; describing.value = ""; });

/** Save one member's description in this room, and optionally as its platform's default for later rooms. */
async function save_description({ text, label, as_template }) {
  describing_saving.value = true;
  try {
    await bridge.describe_member(describing.value, text, label);
    if (as_template) bridge.save_description_template(describing.value, text);
    describing.value = "";
  } catch { /* The controller shows the error as a toast. */ }
  finally { describing_saving.value = false; }
}

const reading = computed(() => `${view.value.room_site}/r/${room.value.id}`);
// The room's directory entry carries its auto-destroy setting and when its count started (last activity or the setting).
const listed = computed(() => view.value.rooms.find((item) => item.id === room.value.id) || null);
const HOUR_MS = 3_600_000;
/** How long the room has left before it destroys itself, counted from its latest message; '' when it is kept. */
const destroy_left = computed(() => {
  const days = listed.value?.destroy_after_days;
  if (!days) return "";
  if (listed.value.destroy_blocked) return t("暂不计时：房间里还有未完成的工作、待你回答的提问或分享网页");
  const hours = Math.max(0, Math.ceil((Date.parse(listed.value.destroy_from || listed.value.created_at) + days * 24 * HOUR_MS - Date.now()) / HOUR_MS));
  return hours >= 24 ? t("还剩 {count} 天", { count: Math.ceil(hours / 24) }) : t("还剩 {count} 小时", { count: hours });
});
const created = computed(() => room.value.created_at ? new Date(room.value.created_at).toLocaleString("zh-CN", { hour12: false }) : "");
</script>

<template>
  <section class="merged-section room-overview" :aria-label="t('成员与设置')">
    <!-- The room's project directories lead the page: every member works in them. One row each, the main one locked once set. -->
    <section v-if="saved?.registered" class="overview-section overview-project" :aria-label="t('项目目录')">
      <header class="overview-project-head"><UIcon name="i-lucide-folder-tree" /><h3>{{ t("项目目录") }}</h3>
        <span class="overview-muted" :class="{ 'overview-phone-hidden': saved.project_directory }">{{ saved.project_directory
          ? t('成员按自己的项目权限读写其他目录，在别处工作的成员只读。改动从各成员下一次执行起生效，会话保留。')
          : t('主目录只能设置一次，之后不能更改。已在房间的成员保留原会话，按自己的项目权限读写它；之后邀请的成员在其中工作。') }}</span></header>
      <div class="overview-directories">
        <template v-if="saved.project_directory">
          <!-- Shaped like the extra directory rows below, but locked: the lock replaces the project picker, copy replaces removal. -->
          <div class="overview-main-box" :title="t('主目录，设置后不能更改')"><span class="overview-main-prefix"><UIcon name="i-lucide-lock" /></span>
            <span class="overview-main-path">{{ bridge.display_path(saved.project_directory) }}</span><span class="overview-main-tag">{{ t("主目录") }}</span>
            <UButton v-if="!view.launch.projects_restricted" icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" class="self-center" :aria-label="t('复制项目目录')" :title="t('复制路径')" @click="act('copy', saved.project_directory)" /></div>
          <ExtraDirectoriesField v-model="directories_draft" :disabled="!directories_editable || saving_directories" />
        </template>
        <ProjectDirectoryField v-else-if="directories_editable" v-model="main_draft" compact :placeholder="t('为本房间设置项目目录的完整路径')" :disabled="saving_directories" />
        <span v-else class="overview-muted">{{ t("未指定") }}</span>
        <div v-if="directories_changed" class="overview-directories-actions">
          <UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" :disabled="saving_directories" @click="reset_directories" />
          <UButton :label="t('保存')" size="xs" class="channel-primary-button" :loading="saving_directories" @click="save_directories" />
        </div>
      </div>
    </section>
    <div class="page-heading overview-heading"><div><h2>{{ t("成员与设置") }}</h2><p class="overview-phone-hidden">{{ t("成员的接入、权限与全部操作，以及房间的协作设置；右栏成员菜单是同样操作的快捷入口。") }}</p></div><UButton v-if="!room.archived" icon="i-lucide-plus" :label="t('邀请 AI 加入')" variant="outline" color="neutral" class="channel-surface-button" :disabled="!view.access?.can_manage" @click="inviting = true" /></div>
    <section class="overview-section">
      <h3 class="overview-phone-hidden">{{ t("成员") }}</h3>
      <p v-if="local_state" class="overview-local" role="status">{{ local_state.text }}<button v-if="local_state.retry" type="button" class="subtle-link" @click="bridge.reload_room_models()">{{ t("重试") }}</button></p>
      <ul class="member-cards" :aria-label="t('成员')">
        <MemoBlock v-for="member in members" :key="member.name" :deps="[card_key(member)]">
        <li class="member-card" :class="{ 'is-dimmed': dragged === member.name, 'is-drop-target': drop_target === member.name }"
          :draggable="grabbed === member.name" @dragstart="drag_start(member, $event)" @dragover="drag_over(member, $event)" @dragleave="drop_target === member.name && (drop_target = '')" @drop.prevent="drop(member)" @dragend="drag_end">
          <header class="member-card-head">
            <span v-if="reorderable && order.movable.includes(member.name)" class="member-card-grip" :title="t('拖动调整成员顺序，右栏发言顺序与 @全体依次 同步')" @pointerdown="grabbed = member.name" @pointerup="grabbed = ''"><UIcon name="i-lucide-grip-vertical" /></span>
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="md" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="member-card-name"><strong><MemberNameEdit :name="member.name" :editable="Boolean(view.access?.can_manage)" /><span v-if="bridge.display_name(member.name) !== member.name" class="member-id">{{ member.name }}</span></strong><small v-if="room.descriptions?.[member.name]" :title="room.descriptions[member.name]">{{ room.descriptions[member.name] }}</small></div>
            <!-- The host's crown sits where the other cards offer 设为主持人, so every card shows it in one place. -->
            <span v-if="member.role === 'host'" class="member-card-host is-current" :title="t('主持人')"><UIcon name="i-lucide-crown" /><span data-slot="label">{{ t('主持人') }}</span></span>
            <UButton v-else-if="actions(member).host" class="member-card-host" :title="actions(member).host.label" :icon="actions(member).host.icon" :label="actions(member).host.label" size="xs" variant="ghost" color="neutral" :disabled="actions(member).host.disabled" @click="actions(member).host.onSelect()" />
            <UBadge v-if="in_workflow(member.name)" color="neutral" variant="outline" size="sm" :title="t('来自工作流「{name}」，提示词按工作流卡片发送', { name: workflow.label })">{{ t("工作流") }}</UBadge>
            <UBadge :color="unregistered(member) ? 'warning' : member.status === 'active' ? 'success' : 'neutral'" variant="subtle" size="sm">{{ unregistered(member) ? (member.access === 'external' ? t('待签到') : t('待注册')) : STATUS_LABELS[member.status] || member.status }}</UBadge>
          </header>
          <dl class="member-card-facts">
            <template v-if="external_of(live(member))">
              <div><dt>{{ t("接入") }}</dt><dd>{{ [t("外部"), external_of(live(member)).computer].filter(Boolean).join(" · ") }}</dd></div>
              <div><dt>{{ t("模型") }}</dt><dd class="overview-model"><span>{{ external_ai(live(member)) || t("对方未说明") }}</span></dd></div>
              <div><dt>{{ t("对方能看到") }}</dt><dd>
                <div class="expert-card-modes overview-switch" :class="{ 'is-locked': !view.access?.can_manage || external_of(live(member)).level !== 'read' }" role="radiogroup"
                  :aria-label="t('{name} 能看到的内容', { name: member.name })" :aria-busy="switching.has(member.name)" :title="external_of(live(member)).level === 'read' ? t('可改为只看消息；再开放项目须重新邀请') : t('再开放项目须重新邀请')">
                  <button v-for="option in LEVELS" :key="option.value" type="button" role="radio" :aria-checked="external_of(live(member)).level === option.value" :title="option.description"
                    :disabled="!view.access?.can_manage || external_of(live(member)).level !== 'read' || switching.has(member.name)" @click="narrow_external(member, option.value)">{{ option.label }}</button>
                </div>
              </dd></div>
              <div class="overview-span"><dt>{{ t("剩余时间") }}</dt><dd :title="t('借出多久由对方决定，你可随时撤销')">{{ external_of(live(member)).pending ? t("由对方加入时决定") : [remaining_label(external_of(live(member)).expires_at) || "—", t("对方设定")].join(" · ") }}</dd></div>
              <div v-if="external_of(live(member)).level === 'read' && external_of(live(member)).directories.length"><dt>{{ t("开放目录") }}</dt><dd>{{ external_of(live(member)).directories.join("、") }}</dd></div>
            </template>
            <template v-else>
            <div><dt>{{ t("接入") }}</dt><dd>
              <div v-if="access(live(member)).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !access(live(member)).editable }" role="radiogroup" :aria-label="t('{name} 的接入方式', { name: member.name })" :title="access(live(member)).hint">
                <button v-for="option in CODEX_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="access(live(member)).value === option.value"
                  :disabled="!access(live(member)).editable || switching.has(member.name)" @click="switch_adapter(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else>{{ access(member).text }}</span>
              <span v-if="adopted(member)" class="overview-muted" :title="t('从这台电脑上已有的会话接入，续接时沿用该会话的上下文与软件权限')"> · {{ t("接管已有会话") }}</span>
            </dd></div>
            <div><dt>{{ t("模型") }}</dt><dd class="overview-model" :class="{ 'overview-muted': waiting(member.name) }" :title="bridge.participant_model(member.name, room, saved) || undefined"><span>{{ member.access === 'runner' ? bridge.participant_model(member.name, room, saved) || '—' : t('在它自己的会话里设置') }}</span>
              <UButton v-if="model_editable(member)" icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" :aria-label="t('更改 {name} 的模型与强度', { name: member.name })" :title="t('更改模型与思考强度')" @click="edit_model(member)" /></dd></div>
            <div><dt>{{ t("项目文件") }}</dt><dd>
              <div v-if="files(member).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !files(member).editable }" role="radiogroup" :aria-label="t('{name} 的项目文件权限', { name: member.name })" :aria-busy="switching.has(member.name)" :title="files(member).hint || undefined">
                <button v-for="option in access_options(saved?.participants?.[member.name]?.adapter, bridge.full_only_hint?.(saved?.participants?.[member.name]?.adapter))" :key="option.value" type="button" role="radio" :aria-checked="files(member).value === option.value" :title="option.hint"
                  :disabled="option.disabled || !files(member).editable || switching.has(member.name)" @click="switch_access(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else class="overview-muted" :title="files(member).hint">{{ files(member).text }}</span>
            </dd></div>
            </template>
            <div v-if="saved?.participants?.[member.name]?.outside_directory" class="overview-outside" :title="bridge.display_path(saved.participants[member.name].outside_directory)">
              <UIcon name="i-lucide-triangle-alert" /><span>{{ t('在 {path} 工作，房间目录{access}', { path: bridge.display_path(saved.participants[member.name].outside_directory), access: saved.participants[member.name].outside_enforced ? t('只读') : t('只读（仅任务要求，程序拦不住）') }) }}</span></div>
            <!-- A host that keeps failing stalls the room; the owner is told how to hand the role to someone else (应 18). -->
            <div v-if="free && member.role === 'host' && live(member).execution?.status === 'failed'" class="overview-outside" role="status">
              <UIcon name="i-lucide-triangle-alert" /><span>{{ t('主持人最近一次执行失败：{reason}。若它长期不可用（如额度用尽），在另一位成员卡片右上角点“设为主持人”换人。', { reason: live(member).execution.result || t('原因未知') }) }}</span></div>
          </dl>
          <footer class="member-card-actions" :aria-label="t('{name} 的操作', { name: member.name })">
            <div><UButton v-for="item in actions(member).taking_part" :key="item.label" class="member-card-tool" :icon="item.icon" :label="item.label" size="xs" variant="ghost" color="neutral" :disabled="item.disabled" @click="item.onSelect()" />
              <!-- A phone folds these into one menu, so a card's actions fit on a single line. -->
              <UDropdownMenu v-if="actions(member).taking_part.length" :items="[actions(member).taking_part]" :content="{ align: 'start' }" :ui="{ content: 'channel-menu' }"><UButton class="member-card-more" icon="i-lucide-ellipsis" size="xs" variant="ghost" color="neutral" :aria-label="t('更多操作')" /></UDropdownMenu></div>
            <div v-if="actions(member).place.length"><UButton v-for="item in actions(member).place" :key="item.label" :icon="item.icon" :label="item.label" size="xs" variant="ghost" :color="item.color || 'neutral'" :disabled="item.disabled" @click="item.onSelect()" /></div>
          </footer>
        </li>
        </MemoBlock>
      </ul>
      <ul v-if="ended_externals.length" class="overview-ended" :aria-label="t('已离开的外部专家')">
        <li v-for="member in ended_externals" :key="member.id">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <span class="overview-ended-name">{{ bridge.display_name(member.name) }}</span>
          <span class="overview-muted">{{ [t("外部"), END_REASONS[member.external?.end_reason] || t("已结束")].join(" · ") }}</span>
          <UButton v-if="!room.archived && view.access?.can_manage" :label="t('重新邀请')" icon="i-lucide-user-round-plus" size="xs" variant="ghost" color="neutral" @click="open_external(member, true)" />
        </li>
      </ul>
      <p class="overview-result">{{ t("复制说明或下载配置不代表 AI 已接入，以实际回答和运行记录为准。") }}</p>
    </section>
    <section class="overview-section">
      <h3>{{ t("协作设置") }}</h3>
      <dl class="overview-settings">
        <div><dt>{{ t("主持人") }}</dt><dd>{{ room.host ? bridge.display_name(room.host) : t('未指定') }}</dd></div>
        <div><dt>{{ t("智能调度") }}</dt><dd>
          <SchedulerSettings v-if="saved?.registered" room compact :free="free" :disabled="!view.access?.can_manage || room.archived" />
          <template v-else>{{ scheduler }}</template></dd></div>
        <div v-if="saved?.registered"><dt>{{ t("生图") }}</dt><dd>
          <ImageService compact :enabled="Boolean(saved.image_generation)" :disabled="!view.access?.can_manage || room.archived" @update:enabled="bridge.set_room_image_generation($event).catch(() => {})" /></dd></div>
        <div><dt>{{ t("工作流") }}</dt><dd class="overview-workflow">
          <WorkflowControl v-if="workflow" :workflow="workflow" />
          <span v-else class="overview-muted">{{ t("没有进行中的工作流；在输入框打 / 或邀请成员时选择") }}</span>
        </dd></div>
        <div v-if="saved?.registered"><dt>{{ t("主持人权限") }}</dt><dd>
          <HostWorkflowSwitch :key="room.id" :room-id="room.id" :save="payload => bridge.execute('set_room_host_workflows', payload)" :model-value="Boolean(saved.host_workflows)" :permissions="saved.host_permissions" :disabled="!view.access?.can_manage || room.archived" />
        </dd></div>
        <div v-if="room.free?.max_rounds != null"><dt>{{ t("连续派活上限") }}</dt><dd>
          <template v-if="view.access?.can_manage"><ChainRoundsField :model-value="rounds_shown" :disabled="saving_rounds" @update:model-value="save_rounds" />
</template>
          <span v-else-if="room.free.max_rounds">{{ t("{count} 轮后停下等你", { count: room.free.max_rounds }) }}</span>
          <span v-else>{{ t("不限轮数") }}</span></dd></div>
        <div v-if="saved?.registered"><dt>{{ t("联网搜索") }}</dt><dd>
          <WebSearchSettings compact :disabled="!view.access?.can_manage || room.archived || !(view.launch.available || view.launch.remote)" /></dd></div>
        <div v-if="saved?.registered"><dt>{{ t("API 请求上限") }}</dt><dd>
          <ApiRequestsField :model-value="requests_shown" :disabled="!view.access?.can_manage || room.archived || saving_requests" @update:model-value="save_requests" /></dd></div>
        <div v-if="!free"><dt>{{ t("逐人追问") }}</dt><dd>{{ room.named_followup ? t('开启：主持人每轮给每位专家写针对性追问') : t('关闭：首轮后请专家回应上一轮观点') }}</dd></div>
        <div><dt>{{ t("自动销毁") }}</dt><dd class="overview-destroy">
          <AutoDestroyField :model-value="listed?.destroy_after_days || 0" :disabled="!view.access?.can_manage || room.archived" @update:model-value="act('manage_channel', { id: room.id, action: 'auto-destroy', days: $event })" />
          <span class="overview-muted">{{ destroy_left || t("可随时在左侧房间菜单中销毁") }}</span></dd></div>
        <div><dt>{{ t("阅读地址") }}</dt><dd class="overview-address"><code>{{ reading }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" :aria-label="t('复制阅读地址')" @click="act('copy', reading)" /></dd></div>
        <div v-if="created"><dt>{{ t("创建时间") }}</dt><dd>{{ created }}</dd></div>
      </dl>
    </section>
    <InviteDialog v-model:open="inviting" :workflow-id="invite_workflow_id" @update:open="(value) => { if (!value) invite_workflow_id = ''; }" :description="free ? t('新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。') : t('新专家由程序按本机软件配置启动，或由你手动启动，加入本轮发言队列。')" />
    <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" :open="Boolean(model_edit)" :title="model_edit ? t('{name} 的模型与强度', { name: bridge.display_name(model_edit.name) }) : ''" :description="t('下次处理请求起生效，保留原会话。')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }" @update:open="(open) => { if (!open) model_edit = null; }">
      <template #body>
        <form v-if="model_edit" class="overview-model-form" @submit.prevent="save_model">
          <label v-if="model_typed"><span>{{ t("模型 ID") }}</span><UInput v-model.trim="model_edit.draft.model" :aria-label="t('{name} 使用的模型 ID', { name: model_edit.name })" class="w-full" /></label>
          <label v-else><span>{{ t("模型") }}</span><div class="model-picker"><USelect :model-value="model_edit.draft.model || '__default__'" :items="model_state.items" :title="model_state.source" size="sm" :ui="{ base: 'model-select', content: 'model-select-menu' }" :aria-label="t('{name} 使用的模型', { name: model_edit.name })" class="w-full" @update:model-value="pick_model" /><ModelRefresh :loading="model_state.refreshing" :disabled="!view.launch.available" @refresh="bridge.load_launch_models(model_edit.name, true, model_edit.draft)" /></div></label>
          <p v-if="!model_typed && (model_state.loading || model_state.error)" class="overview-muted">{{ model_state.loading ? t('正在读取软件模型列表…') : model_state.error }}</p>
          <EffortSlider v-if="model_efforts" :caption="t('强度')" :items="model_efforts" :model-value="model_edit.draft.effort" :label="t('{name} 的思考强度', { name: model_edit.name })" @update:model-value="model_edit.draft.effort = $event" />
          <p v-else class="overview-muted">{{ model_state.effort_note }}</p>
          <div class="overview-model-actions">
            <UButton :label="t('取消')" color="neutral" variant="ghost" @click="model_edit = null" />
            <UButton type="submit" :label="t('保存')" class="channel-primary-button" />
          </div>
        </form>
      </template>
    </UModal>
    <ExternalMemberDialog v-model:open="external_open" :member="external_member" :reinvite="external_reinvite" />
    <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.default_name(bridge.platform_of(describing)) : ''" :default_label="describing ? bridge.default_name(describing) : ''"
      :text="room.descriptions?.[describing] || ''" :label="room.labels?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
      @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </section>
</template>

<style scoped>
/* Nothing on this page may widen it past the screen: every grid and flex item can shrink (a long name, model or path
   is cut with an ellipsis inside its own box), and anything still too wide is clipped instead of scrolling sideways. */
.room-overview { min-width: 0; overflow-x: clip; }
.room-overview :is(.member-card, .member-card-facts > div, .member-card-facts dd, .overview-settings > div) { min-width: 0; }
.overview-section { margin-bottom: 28px; }
.overview-section h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
/* One card per member: who it is, three aligned facts, then its actions in a footer. */
.member-cards { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.member-card { position: relative; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); }
.member-card-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 0; }
.member-card { transition: opacity .18s; }
.member-card.is-dimmed { opacity: .5; }
.member-card.is-drop-target { box-shadow: inset 0 2px 0 var(--channel-accent, var(--ui-primary)); }
/* The grip fills the card's left padding from top to bottom, so it is easy to grab. */
.member-card-grip { position: absolute; top: 0; bottom: 0; left: 0; display: grid; place-items: center; width: 16px; border-radius: 9px 0 0 9px;
  color: var(--ui-text-dimmed); cursor: grab; opacity: 0; transition: opacity .12s, background-color .12s; }
.member-card-grip > * { width: 16px; height: 16px; }
.member-card:hover .member-card-grip { opacity: 1; }
.member-card-grip:hover { color: var(--ui-text-highlighted); background: color-mix(in srgb, currentColor 10%, transparent); }
.member-card-name { display: grid; flex: 1; min-width: 0; }
.member-card-name strong { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.member-card-host.is-current { display: inline-flex; flex-shrink: 0; align-items: center; gap: 6px; padding: 0 8px; color: var(--ui-warning, #e5b54a); font-size: 12px; }
.member-card-host.is-current > [class*="icon"] { width: 16px; height: 16px; }
.member-card-name small { overflow: hidden; color: var(--ui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.member-card-facts { display: grid; grid-template-columns: 120px minmax(0, 1fr) 210px; gap: 16px; margin: 0; padding: 12px 16px 14px 60px; font-size: 13px; }
.member-card-facts dt { margin-bottom: 4px; color: var(--ui-text-muted); font-size: 12px; }
.member-card-facts dd { display: flex; align-items: center; min-height: 28px; margin: 0; color: var(--ui-text); }
.overview-model { gap: 2px; min-width: 0; }
/* An external member's second row: how long it is lent takes the first two columns, its open directories the third. */
.member-card-facts > .overview-span { grid-column: 1 / span 2; }
/* External members that ended, under the cards: one quiet line each, with a way to invite them back. */
.overview-ended { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 0; padding: 0; list-style: none; }
.overview-ended li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 8px; border: 1px dashed var(--ui-border); border-radius: 8px; opacity: .8; font-size: 12px; }
.overview-ended-name { overflow: hidden; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.overview-ended li > :last-child { margin-left: auto; }
.overview-workflow { display: flex; align-items: center; gap: 6px; }
.overview-destroy { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.overview-model > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-model > button { padding: 2px; color: var(--ui-text-muted); }
.overview-model > button :deep(svg), .overview-model > button :deep(.iconify) { width: 12px; height: 12px; }
.overview-model-form { display: flex; flex-direction: column; gap: 12px; }
/* minmax(0, 1fr): a long saved model name is cut inside the select instead of widening the dialog past the screen. */
.overview-model-form label { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; color: var(--ui-text-muted); font-size: 12px; }
.overview-model-form p { margin: 0; font-size: 12px; }
.overview-model-actions { display: flex; justify-content: flex-end; gap: 8px; }
.overview-muted { color: var(--ui-text-muted); }
.overview-switch { width: max-content; max-width: 100%; }
.overview-switch button { padding: 0 10px; white-space: nowrap; }
.overview-switch button:disabled { cursor: default; }
.overview-switch button:disabled:not([aria-checked="true"]) { opacity: 0.55; }
/* A switch that cannot change here (API, web members, a discussion in progress) stays visible but greyed out. */
.overview-switch.is-locked { opacity: 0.5; }
/* Taking-part actions on the left, the member's place in the room (ending with removal) on the right. */
.member-card-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 6px 10px; border-top: 1px solid var(--ui-border-muted); }
.member-card-actions > div { display: flex; flex-wrap: wrap; gap: 2px; }
.member-card-more { display: none; }
.overview-address { display: flex; align-items: center; gap: 4px; min-width: 0; }
/* Spans the whole facts row so a long directory path is not squeezed into the narrow 项目文件 column. */
.overview-outside { grid-column: 1 / -1; display: flex; align-items: center; gap: 4px; min-width: 0; margin-top: -8px; color: var(--ui-warning, #d9a441); font-size: 12px; }
.overview-outside > span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.overview-outside > [class*="icon"] { flex-shrink: 0; width: 12px; height: 12px; }
.overview-lock { flex-shrink: 0; width: 12px; height: 12px; color: var(--ui-text-dimmed); }
/* Project directories: a card at the top of the page, shaped like the member cards below. */
.overview-project { padding: 14px 16px 16px; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); }
.overview-project-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-bottom: 12px; }
.overview-project-head > [class*="icon"] { align-self: center; width: 15px; height: 15px; color: var(--channel-accent); }
.overview-project-head h3 { margin: 0; }
.overview-project-head > span { flex-basis: 100%; font-size: 12px; line-height: 1.5; }
.overview-directories { display: flex; flex-direction: column; gap: 8px; }
/* Matches ProjectDirectoryField's box so the locked main directory reads as the same kind of row, only dimmer. */
.overview-main-box { display: flex; flex: 1; align-items: stretch; min-width: 0; min-height: 32px; border: 1px solid var(--ui-border-muted);
  border-radius: 6px; background: color-mix(in srgb, var(--ui-bg) 55%, transparent); cursor: default; }
.overview-main-prefix { display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 49px; border-right: 1px solid var(--ui-border-muted); color: var(--ui-text-dimmed); }
.overview-main-prefix > [class*="icon"] { width: 13px; height: 13px; }
.overview-main-path { flex: 1; min-width: 0; align-self: center; padding-inline: 10px; overflow: hidden; color: var(--ui-text); font-size: 14px; white-space: nowrap; text-overflow: ellipsis; }
.overview-main-tag { flex-shrink: 0; align-self: center; margin-right: 8px; padding: 1px 6px; border-radius: 4px; background: var(--ui-bg-accented, rgba(255,255,255,.06)); color: var(--ui-text-muted); font-size: 11px; }
.overview-directories-actions { display: flex; justify-content: flex-end; gap: 6px; }
.overview-address code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.overview-local { display: flex; gap: 10px; margin: 0 0 8px; color: var(--ui-text-muted); font-size: 12px; }
.overview-result { margin: 8px 0 0; color: var(--ui-text-muted); font-size: 12px; }
/* Same card as the members above, one setting per row. */
.overview-settings { margin: 0; border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); font-size: 13px; }
.overview-settings > div { display: flex; align-items: baseline; gap: 16px; padding: 12px 16px; }
.overview-settings > div + div { border-top: 1px solid var(--ui-border-muted); }
.overview-settings dt { flex: none; width: 112px; color: var(--ui-text-muted); font-size: 12px; }
.overview-settings dd { flex: 1; min-width: 0; margin: 0; color: var(--ui-text); overflow-wrap: anywhere; }
@media (max-width: 720px) {
  /* A phone shows as much as it can at once (user 2026-11-18, #4568): explanations that repeat the page give way, labels sit
     beside their values, and each card's actions share one line. */
  .overview-phone-hidden { display: none; }
  .overview-section { margin-bottom: 14px; }
  .overview-section h3 { margin-bottom: 6px; }
  .overview-heading { flex-wrap: nowrap; align-items: center; margin-bottom: 8px; }
  .overview-heading h2 { margin-bottom: 0; }
  .overview-heading > button { flex-shrink: 0; }
  .member-cards { gap: 8px; }
  /* The name needs the head row's width on a phone, so 设为主持人 keeps only its crown. */
  .member-card-head { gap: 8px; padding: 8px 10px 0; }
  .member-card-head :deep(.channel-avatar) { width: 26px; height: 26px; }
  /* The card's left padding is too narrow for the grip here, and a phone has no hover: it takes its own place at the row's end. */
  .member-card-grip { position: static; order: 1; flex-shrink: 0; width: 20px; height: 20px; margin-right: -4px; border-radius: 4px; opacity: 1; }
  .member-card-host :deep([data-slot="label"]) { display: none; }
  /* 接入 keeps its width and the model takes the rest of the line; a long model name is cut with an ellipsis. */
  .member-card-facts { grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; padding: 6px 10px; }
  .member-card-facts > div { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .member-card-facts > div:nth-child(n + 3) { grid-column: 1 / -1; }
  .member-card-facts dt { flex: none; margin-bottom: 0; }
  .member-card-facts dd { flex: 1; }
  /* The permission switch drops under its label only when the two do not fit on one line (a very narrow phone in English). */
  .member-card-facts > div:nth-child(3) { flex-wrap: wrap; }
  .member-card-facts > div:nth-child(3) dd { flex: 1 1 auto; }
  .overview-switch button { padding: 0 8px; }
  .overview-outside { margin-top: 0; }
  .member-card-actions { flex-wrap: nowrap; align-items: center; gap: 4px; padding: 2px 6px; }
  .member-card-actions > div { flex-wrap: nowrap; }
  .member-card-tool { display: none; }
  .member-card-more { display: inline-flex; }
  .overview-project { padding: 10px; }
  .overview-project-head { margin-bottom: 8px; }
  .overview-directories { gap: 6px; }
  .overview-main-prefix { width: 30px; }
  .overview-main-path { padding-inline: 8px; font-size: 13px; }
  /* A phone gives each setting the full width: its name sits above the value instead of a 112px column beside it. */
  .overview-settings > div { flex-direction: column; align-items: stretch; gap: 2px; padding: 7px 10px; }
  .overview-settings dt { width: auto; }
}
/* A member with a nickname also shows its ID, which AI messages, @ and records use. */
.member-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; font-weight: 400; }
</style>

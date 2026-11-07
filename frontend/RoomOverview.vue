<script setup>
/**
 * Everything about who is in the room and how it is set up, laid out in full: the rail's member menu is only the quick
 * entry to the same actions, so nothing here hides behind a menu.
 */
import { computed, inject, ref, watch } from "vue";
import ApiRequestsField from "./ApiRequestsField.vue";
import ChainRoundsField from "./ChainRoundsField.vue";
import EffortSlider from "./EffortSlider.vue";
import ExtraDirectoriesField from "./ExtraDirectoriesField.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import HostWorkflowSwitch from "./HostWorkflowSwitch.vue";
import InviteDialog from "./InviteDialog.vue";
import WorkflowControl from "./WorkflowControl.vue";
import { active_workflow } from "./workflow-state.js";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import MemoBlock from "./memo-block.js";
import { member_actions } from "./member-actions.js";
import { access_label, access_options } from "../runner/expert_prompts.mjs";

const { view, bridge, act } = inject("discussion");
const ACCESS_LABELS = { manual: "手动接入" };
const STATUS_LABELS = { active: "在场", away: "暂离" };
const unregistered = (member) => member.access === "manual" && !member.registered_at;
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
  if (!view.value.launch.available) return { text: "未连接本机服务，模型与权限暂不可见。" };
  if (!saved.value || saved.value.loading) return { text: "正在读取本机配置…" };
  if (saved.value.error) return { text: `读取本机配置失败：${saved.value.error}`, retry: true };
  return saved.value.registered === false ? { text: "本机没有登记此房间，模型与权限不可见。" } : null;
});
/** An agy member waits for its default model to be read, so its switches stay greyed out until then. */
const waiting = (name) => Boolean(saved.value?.participants?.[name]?.defaults_pending);
const switching = ref("");
// The round limit the field shows: the saved one, or the value being saved until the room refreshes.
const saving_rounds = ref(false), rounds_shown = ref(0);
watch(() => room.value.free?.max_rounds, (value) => { rounds_shown.value = value || 0; }, { immediate: true });

/** Save a new round limit and say so; on failure the field goes back to the saved value and the error shows under the members. */
async function save_rounds(value) {
  rounds_shown.value = value;
  saving_rounds.value = true;
  try {
    await bridge.set_chain_rounds(value);
    bridge.notify("info", "推进轮数已保存，进行中的任务链也按新值");
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
    bridge.notify("info", "项目目录已保存，从各成员下一次执行起生效");
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
    bridge.notify("info", "API 请求上限已保存，从下一次执行起生效");
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
  if (ACCESS_LABELS[member.access]) return { text: ACCESS_LABELS[member.access] };
  const adapter = saved.value?.participants?.[member.name]?.adapter;
  if (!["codex", "codex_cli"].includes(adapter)) return { text: adapter ? ADAPTER_LABELS[adapter] || "CLI" : bridge.participant_access(member.name, room.value) };
  const idle = !(member.pending > 0 || ["dispatched", "started"].includes(member.execution?.status));
  return { value: adapter, editable: free.value && idle && view.value.access?.can_manage && view.value.launch.available,
    hint: !free.value ? "讨论进行中不能切换" : idle ? "切换后沿用原会话；切回 CLI 前须让 App 释放原聊天" : "正在处理请求，完成后再切换" };
}

/** Free-room members carry their live execution and pending count; older rooms list members without them. */
function live(member) {
  return (room.value.free?.members || []).find((item) => item.name === member.name) || member;
}

/** Switch a Codex member between App and CLI; its conversation stays. */
async function switch_adapter(member, adapter) {
  if (switching.value || access(live(member)).value === adapter) return;
  switching.value = member.name;
  try {
    await bridge.set_member_adapter({ name: member.name, adapter });
    bridge.notify("info", `${bridge.display_name(member.name)} 已改为 ${adapter === "codex" ? "App" : "CLI"} 接入，下次处理请求起生效。`);
  } catch (error) { bridge.notify("error", error.message); }
  finally { switching.value = ""; }
}

/** Project file access, and whether it can be switched here; anything that cannot says why on hover. */
function files(member) {
  if (member.access === "manual") return { text: "自行决定", hint: "手动成员的权限由它自己的会话决定" };
  const profile = saved.value?.participants?.[member.name];
  if (!profile) return { text: "—" };
  if (profile.project_access === "own") return { text: "自行决定", hint: "手动接入的成员，由本机服务投递时仍沿用它自己会话的软件权限" };
  if (!ACCESS_CLIENTS.includes(profile.adapter)) return { text: "App 内设置", hint: "App 成员的权限在 App 里设置" };
  if (profile.own_project) return { text: "agy 内设置", hint: "续接它自己的 agy 对话，权限沿用该对话所在项目" };
  if (waiting(member.name)) return { value: profile.project_access || "read", hint: "正在读取 agy 的配置" };
  return { value: profile.project_access || "read", editable: view.value.access?.can_manage && view.value.launch.available };
}

/** Switch one member's project files; the change applies from its next request and keeps its session. */
async function switch_access(member, project_access) {
  if (switching.value || files(member).value === project_access) return;
  switching.value = member.name;
  try {
    await bridge.set_member_access({ name: member.name, project_access });
    bridge.notify("info", `${bridge.display_name(member.name)} 已改为${access_label(project_access)}，下次处理请求起生效。`);
  } catch (error) { bridge.notify("error", error.message); }
  finally { switching.value = ""; }
}

// CLIs whose model and effort this tool passes on each run; Apps choose their own and API members keep the model set at invitation.
const MODEL_CLIENTS = ["codex_cli", "claude", "antigravity_cli"];
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };

/** Whether this member's model and effort can be changed here. */
function model_editable(member) {
  const profile = saved.value?.participants?.[member.name];
  return member.access === "runner" && MODEL_CLIENTS.includes(profile?.adapter) && profile.project_access !== "own"
    && !waiting(member.name) && view.value.access?.can_manage && view.value.launch.available;
}

// The member whose model is being changed, with the draft the dialog edits.
const model_edit = ref(null), model_saving = ref(false);
const model_state = computed(() => model_edit.value && bridge.launch_model_state(model_edit.value.name, view.value.launch, model_edit.value.draft));
const model_efforts = computed(() => {
  const levels = model_state.value?.efforts;
  return levels?.length ? [{ label: "默认强度", value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
});

/** Open the dialog on the member's saved choices and read its software's model list. */
function edit_model(member) {
  const { adapter, model, effort } = saved.value.participants[member.name];
  model_edit.value = { name: member.name, draft: { adapter, model: model || "", effort: effort || "" } };
  bridge.load_launch_models(member.name, false, model_edit.value.draft);
}

/** Pick a model; an effort the new model does not offer goes back to the default. */
function pick_model(value) {
  const draft = model_edit.value.draft;
  draft.model = value === "__default__" ? "" : value;
  // agy reads its effort levels per model.
  if (draft.adapter === "antigravity_cli") bridge.load_launch_models(model_edit.value.name, false, draft);
  if (!model_state.value?.efforts?.includes(draft.effort)) draft.effort = "";
}

/** Save the model and effort; they apply from the member's next request and keep its session. */
async function save_model() {
  const { name, draft } = model_edit.value;
  model_saving.value = true;
  try {
    await bridge.set_member_model({ name, model: draft.model, effort: draft.effort });
    bridge.notify("info", `${bridge.display_name(name)} 的模型与强度已更新，下次处理请求起生效，保留原会话。`);
    model_edit.value = null;
  } catch (error) { bridge.notify("error", error.message); }
  finally { model_saving.value = false; }
}

/** The smart scheduler lives in the local registration, so a page without the local service cannot tell. */
const scheduler = computed(() => {
  if (local_state.value) return "—";
  if (!saved.value.scheduler) return "未开启";
  const provider = view.value.launch.scheduler_providers?.[saved.value.scheduler.provider]?.label || saved.value.scheduler.provider;
  const mode = view.value.launch.scheduler_modes?.[saved.value.scheduler.mode];
  return [provider, saved.value.scheduler.model, mode].filter(Boolean).join(" · ");
});
const HOST_LABEL = "设为主持人";
/**
 * Every action of a member as a button; 设为主持人 sits apart at the card's top right. A discussion arranges its members
 * from the progress board, so there only the taking-part actions (instructions, credentials, description) apply.
 */
function actions(member) {
  const [taking_part, place, removal] = member_actions(live(member), { view: view.value, act, describe: (name) => { describing.value = name; } });
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
    grabbed.value === member.name, switching.value, in_workflow(member.name) && workflow.value.label, room.value.descriptions?.[member.name],
    identity?.icon, identity?.initials, identity?.style, bridge.display_name(member.name), bridge.participant_model(member.name, room.value, saved.value),
    bridge.participant_access(member.name, room.value), room.value.session?.status]);
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
const created = computed(() => room.value.created_at ? new Date(room.value.created_at).toLocaleString("zh-CN", { hour12: false }) : "");
</script>

<template>
  <section class="merged-section room-overview" aria-label="成员与设置">
    <div class="page-heading"><div><h2>成员与设置</h2><p>成员的接入、权限与全部操作，以及房间的协作设置；右栏成员菜单是同样操作的快捷入口。</p></div><UButton v-if="!room.archived" icon="i-lucide-plus" label="邀请 AI 加入" variant="outline" color="neutral" class="channel-surface-button" :disabled="!view.access?.can_manage" @click="inviting = true" /></div>
    <section class="overview-section">
      <h3>成员</h3>
      <p v-if="local_state" class="overview-local" role="status">{{ local_state.text }}<button v-if="local_state.retry" type="button" class="subtle-link" @click="bridge.reload_room_models()">重试</button></p>
      <ul class="member-cards" aria-label="成员">
        <MemoBlock v-for="member in members" :key="member.name" :deps="[card_key(member)]">
        <li class="member-card" :class="{ 'is-dimmed': dragged === member.name, 'is-drop-target': drop_target === member.name }"
          :draggable="grabbed === member.name" @dragstart="drag_start(member, $event)" @dragover="drag_over(member, $event)" @dragleave="drop_target === member.name && (drop_target = '')" @drop.prevent="drop(member)" @dragend="drag_end">
          <header class="member-card-head">
            <UIcon v-if="reorderable && order.movable.includes(member.name)" name="i-lucide-grip-vertical" class="member-card-grip" title="拖动调整成员顺序，右栏发言顺序与 @全体依次 同步" @pointerdown="grabbed = member.name" @pointerup="grabbed = ''" />
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="md" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="member-card-name"><strong>{{ bridge.display_name(member.name) }}<span v-if="bridge.display_name(member.name) !== member.name" class="member-id">{{ member.name }}</span><UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /></strong><small v-if="room.descriptions?.[member.name]" :title="room.descriptions[member.name]">{{ room.descriptions[member.name] }}</small></div>
            <UButton v-if="actions(member).host" :icon="actions(member).host.icon" :label="actions(member).host.label" size="xs" variant="ghost" color="neutral" :disabled="actions(member).host.disabled" @click="actions(member).host.onSelect()" />
            <UBadge v-if="in_workflow(member.name)" color="neutral" variant="outline" size="sm" :title="`来自工作流「${workflow.label}」，提示词按工作流卡片发送`">工作流</UBadge>
            <UBadge :color="unregistered(member) ? 'warning' : member.status === 'active' ? 'success' : 'neutral'" variant="subtle" size="sm">{{ unregistered(member) ? '待注册' : STATUS_LABELS[member.status] || member.status }}</UBadge>
          </header>
          <dl class="member-card-facts">
            <div><dt>接入</dt><dd>
              <div v-if="access(live(member)).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !access(live(member)).editable }" role="radiogroup" :aria-label="`${member.name} 的接入方式`" :title="access(live(member)).hint">
                <button v-for="option in CODEX_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="access(live(member)).value === option.value"
                  :disabled="!access(live(member)).editable || Boolean(switching)" @click="switch_adapter(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else>{{ access(member).text }}</span>
            </dd></div>
            <div><dt>模型</dt><dd class="overview-model" :class="{ 'overview-muted': waiting(member.name) }" :title="bridge.participant_model(member.name, room, saved) || undefined"><span>{{ member.access === 'runner' ? bridge.participant_model(member.name, room, saved) || '—' : '在它自己的会话里设置' }}</span>
              <UButton v-if="model_editable(member)" icon="i-lucide-pencil" size="xs" variant="ghost" color="neutral" :aria-label="`更改 ${member.name} 的模型与强度`" title="更改模型与思考强度" @click="edit_model(member)" /></dd></div>
            <div><dt>项目文件</dt><dd>
              <div v-if="files(member).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !files(member).editable }" role="radiogroup" :aria-label="`${member.name} 的项目文件权限`" :aria-busy="switching === member.name" :title="files(member).hint || undefined">
                <button v-for="option in access_options(saved?.participants?.[member.name]?.adapter)" :key="option.value" type="button" role="radio" :aria-checked="files(member).value === option.value" :title="option.hint"
                  :disabled="option.disabled || !files(member).editable || Boolean(switching)" @click="switch_access(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else class="overview-muted" :title="files(member).hint">{{ files(member).text }}</span>
              <p v-if="saved?.participants?.[member.name]?.outside_directory" class="overview-outside" :title="saved.participants[member.name].outside_directory">
                <UIcon name="i-lucide-triangle-alert" />在 {{ saved.participants[member.name].outside_directory }} 工作，房间目录{{ saved.participants[member.name].outside_enforced ? '只读' : '只读（仅任务要求，程序拦不住）' }}</p>
            </dd></div>
          </dl>
          <footer class="member-card-actions" :aria-label="`${member.name} 的操作`">
            <div><UButton v-for="item in actions(member).taking_part" :key="item.label" :icon="item.icon" :label="item.label" size="xs" variant="ghost" color="neutral" :disabled="item.disabled" @click="item.onSelect()" /></div>
            <div v-if="actions(member).place.length"><UButton v-for="item in actions(member).place" :key="item.label" :icon="item.icon" :label="item.label" size="xs" variant="ghost" :color="item.color || 'neutral'" :disabled="item.disabled" @click="item.onSelect()" /></div>
          </footer>
        </li>
        </MemoBlock>
      </ul>
      <p class="overview-result">复制说明或下载配置不代表 AI 已接入，以实际回答和运行记录为准。</p>
    </section>
    <section class="overview-section">
      <h3>协作设置</h3>
      <dl class="overview-settings">
        <div><dt>主持人</dt><dd>{{ room.host ? bridge.display_name(room.host) : '未指定' }}</dd></div>
        <div><dt>智能调度</dt><dd>{{ scheduler }}</dd></div>
        <div><dt>工作流</dt><dd class="overview-workflow">
          <WorkflowControl v-if="workflow" :workflow="workflow" />
          <span v-else class="overview-muted">没有进行中的工作流；在输入框打 / 或邀请成员时选择</span>
        </dd></div>
        <div v-if="saved?.registered"><dt>主持人自建工作流</dt><dd>
          <HostWorkflowSwitch :model-value="Boolean(saved.host_workflows)" :disabled="!view.access?.can_manage || room.archived" @update:model-value="act('set_room_host_workflows', $event)" />
        </dd></div>
        <div v-if="room.free?.max_rounds != null"><dt>连续派活上限</dt><dd>
          <template v-if="view.access?.can_manage"><ChainRoundsField :model-value="rounds_shown" :disabled="saving_rounds" @update:model-value="save_rounds" />
</template>
          <span v-else-if="room.free.max_rounds">主持人收到你的一条消息后，最多连续派活 {{ room.free.max_rounds }} 轮（派活 → 成员回答 → 交回汇总为一轮），然后停下等你</span>
          <span v-else>主持人收到你的一条消息后，可一直连续派活，不限轮数</span></dd></div>
        <div v-if="saved?.registered"><dt>API 请求上限</dt><dd>
          <ApiRequestsField :model-value="requests_shown" :disabled="!view.access?.can_manage || room.archived || saving_requests" @update:model-value="save_requests" /></dd></div>
        <div v-if="!free"><dt>逐人追问</dt><dd>{{ room.named_followup ? '开启：主持人每轮给每位专家写针对性追问' : '关闭：首轮后请专家回应上一轮观点' }}</dd></div>
        <!-- One row for every project directory: the main one locked once set, the extra ones edited below it. -->
        <div v-if="saved?.registered"><dt>项目目录</dt><dd class="overview-directories">
          <template v-if="saved.project_directory">
            <div class="overview-address" title="主目录，设置后不能更改"><UIcon name="i-lucide-lock" class="overview-lock" /><code>{{ saved.project_directory }}</code>
              <UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" aria-label="复制项目目录" @click="act('copy', saved.project_directory)" /></div>
            <ExtraDirectoriesField v-model="directories_draft" :disabled="!directories_editable || saving_directories" />
          </template>
          <ProjectDirectoryField v-else-if="directories_editable" v-model="main_draft" compact placeholder="为本房间设置项目目录的完整路径" :disabled="saving_directories" />
          <span v-else class="overview-muted">未指定</span>
          <div v-if="directories_changed" class="overview-directories-actions">
            <UButton label="取消" color="neutral" variant="ghost" size="xs" :disabled="saving_directories" @click="reset_directories" />
            <UButton label="保存" size="xs" class="channel-primary-button" :loading="saving_directories" @click="save_directories" />
          </div>
          <span class="overview-muted">{{ saved.project_directory
            ? '成员按自己的项目权限读写其他目录，在别处工作的成员只读。改动从各成员下一次执行起生效，会话保留。'
            : '主目录只能设置一次，之后不能更改。已在房间的成员保留原会话，按自己的项目权限读写它；之后邀请的成员在其中工作。' }}</span></dd></div>
        <div><dt>阅读地址</dt><dd class="overview-address"><code>{{ reading }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" aria-label="复制阅读地址" @click="act('copy', reading)" /></dd></div>
        <div v-if="created"><dt>创建时间</dt><dd>{{ created }}</dd></div>
      </dl>
    </section>
    <InviteDialog v-model:open="inviting" :workflow-id="invite_workflow_id" @update:open="(value) => { if (!value) invite_workflow_id = ''; }" :description="free ? '新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。' : '新专家由程序按本机软件配置启动，或由你手动启动，加入本轮发言队列。'" />
    <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" :open="Boolean(model_edit)" :title="model_edit ? `${bridge.display_name(model_edit.name)} 的模型与强度` : ''" description="下次处理请求起生效，保留原会话。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }" @update:open="(open) => { if (!open) model_edit = null; }">
      <template #body>
        <form v-if="model_edit" class="overview-model-form" @submit.prevent="save_model">
          <label><span>模型</span><USelect :model-value="model_edit.draft.model || '__default__'" :items="model_state.items" :title="model_state.source" :aria-label="`${model_edit.name} 使用的模型`" class="w-full" @update:model-value="pick_model" /></label>
          <p v-if="model_state.loading || model_state.error" class="overview-muted">{{ model_state.loading ? '正在读取软件模型列表…' : model_state.error }}</p>
          <EffortSlider v-if="model_efforts" caption="强度" :items="model_efforts" :model-value="model_edit.draft.effort" :label="`${model_edit.name} 的思考强度`" @update:model-value="model_edit.draft.effort = $event" />
          <p v-else class="overview-muted">{{ model_state.effort_note }}</p>
          <div class="overview-model-actions">
            <UButton label="取消" color="neutral" variant="ghost" @click="model_edit = null" />
            <UButton type="submit" label="保存" class="channel-primary-button" :loading="model_saving" />
          </div>
        </form>
      </template>
    </UModal>
    <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.default_name(bridge.platform_of(describing)) : ''" :default_label="describing ? bridge.default_name(describing) : ''"
      :text="room.descriptions?.[describing] || ''" :label="room.labels?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
      @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </section>
</template>

<style scoped>
.overview-section { margin-bottom: 28px; }
.overview-section h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
/* One card per member: who it is, three aligned facts, then its actions in a footer. */
.member-cards { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.member-card { border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); }
.member-card-head { position: relative; display: flex; align-items: center; gap: 12px; padding: 14px 16px 0; }
.member-card { transition: opacity .18s; }
.member-card.is-dimmed { opacity: .5; }
.member-card.is-drop-target { box-shadow: inset 0 2px 0 var(--channel-accent, var(--ui-primary)); }
.member-card-grip { position: absolute; left: 2px; top: 22px; width: 14px; color: var(--ui-text-dimmed); cursor: grab; opacity: 0; transition: opacity .12s; }
.member-card:hover .member-card-grip { opacity: 1; }
.member-card-name { display: grid; flex: 1; min-width: 0; }
.member-card-name strong { display: flex; align-items: center; gap: 5px; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.member-card-name strong .iconify { color: var(--ui-warning, #e5b54a); }
.member-card-name small { overflow: hidden; color: var(--ui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.member-card-facts { display: grid; grid-template-columns: 120px minmax(0, 1fr) 210px; gap: 16px; margin: 0; padding: 12px 16px 14px 60px; font-size: 13px; }
.member-card-facts dt { margin-bottom: 4px; color: var(--ui-text-muted); font-size: 12px; }
.member-card-facts dd { display: flex; align-items: center; min-height: 28px; margin: 0; color: var(--ui-text); }
.overview-model { gap: 2px; min-width: 0; }
.overview-workflow { display: flex; align-items: center; gap: 6px; }
.overview-model > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-model-form { display: flex; flex-direction: column; gap: 12px; }
.overview-model-form label { display: grid; gap: 6px; color: var(--ui-text-muted); font-size: 12px; }
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
.overview-address { display: flex; align-items: center; gap: 4px; min-width: 0; }
.overview-outside { display: flex; align-items: center; gap: 4px; margin: 4px 0 0; overflow: hidden; color: var(--ui-warning, #d9a441); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.overview-outside > [class*="icon"] { flex-shrink: 0; width: 12px; height: 12px; }
.overview-lock { flex-shrink: 0; width: 12px; height: 12px; color: var(--ui-text-dimmed); }
.overview-directories { display: flex; flex-direction: column; gap: 6px; max-width: 560px; }
.overview-directories-actions { display: flex; justify-content: flex-end; gap: 6px; }
.overview-directories > .overview-muted { font-size: 12px; }
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
  .member-card-facts { grid-template-columns: 1fr 1fr; padding-left: 16px; }
  .member-card-facts > div:last-child { grid-column: 1 / -1; }
}
/* A member with a nickname also shows its ID, which AI messages, @ and records use. */
.member-id { margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; font-weight: 400; }
</style>

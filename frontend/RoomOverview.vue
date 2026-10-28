<script setup>
/**
 * Everything about who is in the room and how it is set up, laid out in full: the rail's member menu is only the quick
 * entry to the same actions, so nothing here hides behind a menu.
 */
import { computed, inject, ref, watch } from "vue";
import AutoHopsField from "./AutoHopsField.vue";
import InviteDialog from "./InviteDialog.vue";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import { member_actions } from "./member-actions.js";

const { view, bridge, act } = inject("discussion");
const ACCESS_LABELS = { manual: "手动接入", online: "网页代发" };
const STATUS_LABELS = { active: "在场", away: "暂离" };
// CLIs this tool grants project access per run; App and API members are left to their own settings.
const ACCESS_CLIENTS = ["codex_cli", "claude", "antigravity_cli"];
const ACCESS_OPTIONS = [{ value: "read", label: "只读" }, { value: "write", label: "可写" }];
const CODEX_OPTIONS = [{ value: "codex_cli", label: "CLI" }, { value: "codex", label: "App" }];
const ADAPTER_LABELS = { api: "API", codex: "App", antigravity: "App" };
const room = computed(() => view.value.room);
const free = computed(() => room.value.mode === "free");
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
// The budget the field shows: the saved one, or the value being saved until the room refreshes.
const saving_hops = ref(false), hops_shown = ref(0);
watch(() => room.value.free?.max_auto_hops, (value) => { hops_shown.value = value || 0; }, { immediate: true });

/** Save a new chain budget; on failure the field goes back to the saved value and the error shows under the members. */
async function save_hops(value) {
  hops_shown.value = value;
  saving_hops.value = true;
  try { await bridge.set_auto_hops(value); } catch { hops_shown.value = room.value.free?.max_auto_hops || 0; }
  finally { saving_hops.value = false; }
}
const result = ref({ tone: "", text: "" });
// Rooms from before members were recorded only list their experts.
const members = computed(() => room.value.members?.length ? room.value.members
  : Object.entries(room.value.experts || {}).map(([name, mode]) => ({ name, access: mode === "online" ? "online" : "runner", status: "active", role: name === room.value.host ? "host" : "member" })));

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
  result.value = { tone: "", text: "" };
  try {
    await bridge.set_member_adapter({ name: member.name, adapter });
    result.value = { tone: "", text: `${bridge.display_name(member.name)} 已改为 ${adapter === "codex" ? "App" : "CLI"} 接入，下次处理请求起生效。` };
  } catch (error) { result.value = { tone: "error", text: error.message }; }
  finally { switching.value = ""; }
}

/** Project file access, and whether it can be switched here; anything that cannot says why on hover. */
function files(member) {
  if (member.access === "online") return { value: "read", hint: "网页成员只能阅读" };
  if (member.access === "manual") return { text: "自行决定", hint: "手动成员的权限由它自己的会话决定" };
  const profile = saved.value?.participants?.[member.name];
  if (!profile) return { text: "—" };
  if (profile.adapter === "api") return { value: "read", hint: "API 成员没有本机文件工具，固定只读" };
  if (!ACCESS_CLIENTS.includes(profile.adapter)) return { text: "App 内设置", hint: "App 成员的权限在 App 里设置" };
  if (profile.own_project) return { text: "agy 内设置", hint: "续接它自己的 agy 对话，权限沿用该对话所在项目" };
  if (waiting(member.name)) return { value: profile.project_access || "read", hint: "正在读取 agy 的配置" };
  return { value: profile.project_access || "read", editable: view.value.access?.can_manage && view.value.launch.available };
}

/** Switch one member's project files; the change applies from its next request and keeps its session. */
async function switch_access(member, project_access) {
  if (switching.value || files(member).value === project_access) return;
  switching.value = member.name;
  result.value = { tone: "", text: "" };
  try {
    await bridge.set_member_access({ name: member.name, project_access });
    result.value = { tone: "", text: `${bridge.display_name(member.name)} 已改为${project_access === "write" ? "可写" : "只读"}，下次处理请求起生效。` };
  } catch (error) { result.value = { tone: "error", text: error.message }; }
  finally { switching.value = ""; }
}

/** The smart scheduler lives in the local registration, so a page without the local service cannot tell. */
const scheduler = computed(() => {
  if (local_state.value) return "—";
  if (!saved.value.scheduler) return "未开启";
  const provider = view.value.launch.scheduler_providers?.[saved.value.scheduler.provider]?.label || saved.value.scheduler.provider;
  return `${provider} · ${saved.value.scheduler.model}`;
});
/**
 * Every action of a member as a button. A discussion arranges its members from the progress board, so there only the
 * taking-part actions (instructions, credentials, description) apply.
 */
function actions(member) {
  const [taking_part, place, removal] = member_actions(live(member), { view: view.value, act, describe: (name) => { describing.value = name; } });
  return { taking_part, place: free.value ? [...place, ...removal] : [] };
}

const inviting = ref(false);
const describing = ref(""), describing_saving = ref(false);
watch(() => room.value.id, () => { inviting.value = false; describing.value = ""; });

/** Save one member's description in this room, and optionally as its platform's default for later rooms. */
async function save_description({ text, as_template }) {
  describing_saving.value = true;
  try {
    await bridge.describe_member(describing.value, text);
    if (as_template) bridge.save_description_template(describing.value, text);
    describing.value = "";
  } catch (error) { result.value = { tone: "error", text: error.message }; }
  finally { describing_saving.value = false; }
}

const reading = computed(() => `${location.origin}/r/${room.value.id}`);
const created = computed(() => room.value.created_at ? new Date(room.value.created_at).toLocaleString("zh-CN", { hour12: false }) : "");
</script>

<template>
  <section class="merged-section room-overview" aria-label="成员与设置">
    <div class="page-heading"><div><h2>成员与设置</h2><p>成员的接入、权限与全部操作，以及房间的协作设置；右栏成员菜单是同样操作的快捷入口。</p></div><UButton v-if="!room.archived" icon="i-lucide-plus" label="邀请 AI 加入" variant="outline" color="neutral" class="channel-surface-button" :disabled="!view.access?.can_manage" @click="inviting = true" /></div>
    <section class="overview-section">
      <h3>成员</h3>
      <p v-if="local_state" class="overview-local" role="status">{{ local_state.text }}<button v-if="local_state.retry" type="button" class="subtle-link" @click="bridge.reload_room_models()">重试</button></p>
      <ul class="member-cards" aria-label="成员">
        <li v-for="member in members" :key="member.name" class="member-card">
          <header class="member-card-head">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="md" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="member-card-name"><strong>{{ bridge.display_name(member.name) }}<UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /></strong><small v-if="room.descriptions?.[member.name]" :title="room.descriptions[member.name]">{{ room.descriptions[member.name] }}</small></div>
            <UBadge :color="member.access === 'manual' && !member.registered_at ? 'warning' : member.status === 'active' ? 'success' : 'neutral'" variant="subtle" size="sm">{{ member.access === 'manual' && !member.registered_at ? '待注册' : STATUS_LABELS[member.status] || member.status }}</UBadge>
          </header>
          <dl class="member-card-facts">
            <div><dt>接入</dt><dd>
              <div v-if="access(live(member)).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !access(live(member)).editable }" role="radiogroup" :aria-label="`${member.name} 的接入方式`" :title="access(live(member)).hint">
                <button v-for="option in CODEX_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="access(live(member)).value === option.value"
                  :disabled="!access(live(member)).editable || Boolean(switching)" @click="switch_adapter(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else>{{ access(member).text }}</span>
            </dd></div>
            <div><dt>模型</dt><dd class="overview-model" :class="{ 'overview-muted': waiting(member.name) }" :title="bridge.participant_model(member.name, room, saved) || undefined">{{ member.access === 'runner' ? bridge.participant_model(member.name, room, saved) || '—' : '在它自己的会话里设置' }}</dd></div>
            <div><dt>项目文件</dt><dd>
              <div v-if="files(member).value" class="expert-card-modes overview-switch" :class="{ 'is-locked': !files(member).editable }" role="radiogroup" :aria-label="`${member.name} 的项目文件权限`" :aria-busy="switching === member.name" :title="files(member).hint || undefined">
                <button v-for="option in ACCESS_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="files(member).value === option.value"
                  :disabled="!files(member).editable || Boolean(switching)" @click="switch_access(member, option.value)">{{ option.label }}</button>
              </div>
              <span v-else class="overview-muted" :title="files(member).hint">{{ files(member).text }}</span>
            </dd></div>
          </dl>
          <footer class="member-card-actions" :aria-label="`${member.name} 的操作`">
            <div><UButton v-for="item in actions(member).taking_part" :key="item.label" :icon="item.icon" :label="item.label" size="xs" variant="ghost" color="neutral" :disabled="item.disabled" @click="item.onSelect()" /></div>
            <div v-if="actions(member).place.length"><UButton v-for="item in actions(member).place" :key="item.label" :icon="item.icon" :label="item.label" size="xs" variant="ghost" :color="item.color || 'neutral'" :disabled="item.disabled" @click="item.onSelect()" /></div>
          </footer>
        </li>
      </ul>
      <p v-if="view.access?.error || view.free_error" class="overview-result is-error" role="alert">{{ view.access?.error || view.free_error }}</p>
      <p v-else-if="view.access?.notice || view.free_notice" class="overview-result" role="status">{{ view.access?.notice || view.free_notice }}</p>
      <p class="overview-result">复制说明或下载配置不代表 AI 已接入，以实际回答和运行记录为准。</p>
      <p v-if="result.text" class="overview-result" :class="{ 'is-error': result.tone === 'error' }" :role="result.tone === 'error' ? 'alert' : 'status'">{{ result.text }}</p>
    </section>
    <section class="overview-section">
      <h3>协作设置</h3>
      <dl class="overview-settings">
        <div><dt>主持人</dt><dd>{{ room.host ? bridge.display_name(room.host) : '未指定' }}</dd></div>
        <div><dt>智能调度</dt><dd>{{ scheduler }}</dd></div>
        <div v-if="free && room.free?.max_auto_hops"><dt>AI 之间派活上限</dt><dd>
          <AutoHopsField v-if="view.access?.can_manage" :model-value="hops_shown" :disabled="saving_hops" @update:model-value="save_hops" />
          <span v-else>{{ room.free.max_auto_hops }} 次，你的一条消息引出的派活与回交达到此数即停下等你</span></dd></div>
        <div v-if="!free"><dt>逐人追问</dt><dd>{{ room.named_followup ? '开启：主持人每轮给每位专家写针对性追问' : '关闭：首轮后请专家回应上一轮观点' }}</dd></div>
        <div><dt>阅读地址</dt><dd class="overview-address"><code>{{ reading }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" aria-label="复制阅读地址" @click="act('copy', reading)" /></dd></div>
        <div v-if="created"><dt>创建时间</dt><dd>{{ created }}</dd></div>
      </dl>
    </section>
    <InviteDialog v-model:open="inviting" :description="free ? '新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。' : '新专家由程序按本机软件配置启动，或由你手动启动，加入本轮发言队列。'" />
    <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.platform_of(describing) : ''"
      :text="room.descriptions?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
      @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </section>
</template>

<style scoped>
.overview-section { margin-bottom: 28px; }
.overview-section h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
/* One card per member: who it is, three aligned facts, then its actions in a footer. */
.member-cards { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.member-card { border: 1px solid var(--ui-border); border-radius: 10px; background: var(--ui-bg-elevated); }
.member-card-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px 0; }
.member-card-name { display: grid; flex: 1; min-width: 0; }
.member-card-name strong { display: flex; align-items: center; gap: 5px; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.member-card-name strong .iconify { color: var(--ui-warning, #e5b54a); }
.member-card-name small { overflow: hidden; color: var(--ui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.member-card-facts { display: grid; grid-template-columns: 120px minmax(0, 1fr) 120px; gap: 16px; margin: 0; padding: 12px 16px 14px 60px; font-size: 13px; }
.member-card-facts dt { margin-bottom: 4px; color: var(--ui-text-muted); font-size: 12px; }
.member-card-facts dd { display: flex; align-items: center; min-height: 28px; margin: 0; color: var(--ui-text); }
.overview-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-muted { color: var(--ui-text-muted); }
.overview-switch { width: 100px; }
.overview-switch button:disabled { cursor: default; }
.overview-switch button:disabled:not([aria-checked="true"]) { opacity: 0.55; }
/* A switch that cannot change here (API, web members, a discussion in progress) stays visible but greyed out. */
.overview-switch.is-locked { opacity: 0.5; }
/* Taking-part actions on the left, the member's place in the room (ending with removal) on the right. */
.member-card-actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 16px; padding: 6px 10px; border-top: 1px solid var(--ui-border-muted); }
.member-card-actions > div { display: flex; flex-wrap: wrap; gap: 2px; }
.overview-address { display: flex; align-items: center; gap: 4px; min-width: 0; }
.overview-address code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.overview-local { display: flex; gap: 10px; margin: 0 0 8px; color: var(--ui-text-muted); font-size: 12px; }
.overview-result { margin: 8px 0 0; color: var(--ui-text-muted); font-size: 12px; }
.overview-result.is-error { color: var(--ui-error); }
.overview-settings { display: grid; gap: 10px; margin: 0; font-size: 13px; }
.overview-settings div { display: flex; gap: 8px; }
.overview-settings dt { flex: none; width: 112px; color: var(--ui-text-muted); }
.overview-settings dd { margin: 0; color: var(--ui-text); }
@media (max-width: 720px) {
  .member-card-facts { grid-template-columns: 1fr 1fr; padding-left: 16px; }
}
</style>

<script setup>
/** Invite dialog shared by the discussion board and the free-room board: pick AIs, set up each card, then invite them one by one. */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import ExpertCard from "./ExpertCard.vue";
import ExternalExpertCard from "./ExternalExpertCard.vue";
import ExternalGuestCard from "./ExternalGuestCard.vue";
import PlatformConfigDialog from "./PlatformConfigDialog.vue";
import RosterAdd from "./RosterAdd.vue";
import { copy_seat_link, external_of, room_operations, runner_text, seat_options } from "./external-members.js";
import { t } from "./i18n.js";

const props = defineProps({ description: { type: String, default: () => t("新成员由程序按本机软件配置启动，或由你手动启动。") }, workflowId: { type: String, default: "" } });
const inviting = defineModel("open", { type: Boolean, default: false });
const { view, bridge, act, is_running } = inject("discussion");
const room = computed(() => view.value.room);
const record = (name) => (room.value.members || []).find((member) => member.name === name);
const COPY_FEEDBACK_MS = 2000;
const launch_copied = ref("");
let launch_copy_timer;
/** Show "已复制" on the member's copy button only after the clipboard write succeeds. */
async function copy_launch(name) {
  clearTimeout(launch_copy_timer);
  launch_copied.value = "";
  if (!await act("copy_member_launch", name)) return;
  launch_copied.value = name;
  launch_copy_timer = setTimeout(() => { launch_copied.value = ""; }, COPY_FEEDBACK_MS);
}
/** Copy a just-added external seat's invitation link, with the same feedback as a launch instruction. */
async function copy_seat(member_id) {
  clearTimeout(launch_copy_timer);
  launch_copied.value = "";
  if (!await copy_seat_link(bridge, room.value.id, member_id)) return;
  launch_copied.value = `seat:${member_id}`;
  launch_copy_timer = setTimeout(() => { launch_copied.value = ""; }, COPY_FEEDBACK_MS);
}
// Everyone picked for one invitation, one card per platform: [{ name, mode }].
const invite_picks = ref([]);
let invite_pick_seq = 0;
// External expert cards among the picks, each `{ id, draft }`; 邀请 adds their seats awaiting check-in, and the dialog
// then offers each seat's invitation link as it offers a manual member's launch instruction (user 2026-11-19, #5450).
const external_drafts = ref([]);
let external_seq = 0;
const room_directories = computed(() => {
  const models = view.value.launch.room_models;
  return models?.room_id === room.value?.id ? [models.project_directory, ...(models.extra_directories || [])].filter(Boolean) : [];
});
const EXTERNAL_CHIP = "external:computer";
// An external user is one person in a browser, one per room: the chip shows a single card that makes its own link.
const GUEST_CHIP = "external:guest";
const guest_card = ref(false);
// Once the card made its link the dialog's work is done: its dismiss button reads "完成" instead of "取消".
const guest_generated = ref(false);
// Instance names of just-invited manual members; the dialog then shows their start step.
const invited_manual = ref([]);
// Member ids of just-added external seats, listed beside the manual members in that step.
const invited_external = ref([]);
// External cards whose seats are being added: the dialog moves to that step at once, as for manual members, and each
// row turns into its seat when it exists (user 2026-11-19); a failure puts the unadded cards back.
const adding_seats = ref([]);
const seat_record = (id) => (room.value.members || []).find((member) => member.id === id);
const invited_any_seat = computed(() => (invited_manual.value.length || invited_external.value.length || adding_seats.value.length) && !invite_picks.value.length && !external_drafts.value.length);
const launch_lead = computed(() => {
  const manual = invited_manual.value.length, external = invited_external.value.length + adding_seats.value.length;
  if (manual && external) return t("成员已加入：手动成员把启动指令交给各自的 AI 会话，外部专家把邀请链接发给对方；注册或签到后才算到场。");
  if (external) return external > 1 ? t("{count} 个外部专家席位已加好，把邀请链接分别发给对方，对方签到后才算到场。", { count: external })
    : t("外部专家席位已加好，把邀请链接发给对方，对方签到后才算到场。");
  return manual > 1 ? t("{count} 位手动成员已加入，把启动指令交给各自的 AI 会话，注册后才算到场。", { count: manual })
    : t("手动成员已加入，把启动指令交给各自的 AI 会话，注册后才算到场。");
});
// Board errors from earlier actions stay out of the dialog until this invite is submitted.
const invite_tried = ref(false);
const invite_choices = computed(() => Object.keys(bridge.launch_clients));
const invite_presets = computed(() => view.value && bridge.expert_presets());
const project_presets = computed(() => {
  const models = view.value.launch.room_models;
  return models?.room_id === room.value?.id ? models.project_experts || [] : [];
});
const taken_names = computed(() => (room.value.members || []).map((member) => member.name));
const invite_count = (platform) => taken_names.value.filter((name) => bridge.platform_of(name) === platform).length;
// Woken members join first so a manual member that has not registered yet never holds them up.
const ordered_picks = computed(() => [...invite_picks.value.filter((pick) => pick.mode !== "manual"), ...invite_picks.value.filter((pick) => pick.mode === "manual")]);
// Mirrors the instance names the invite assigns in join order, so each card says which seat it will take.
// A preset pick already holds a free name of its own.
const pick_instances = computed(() => {
  const taken = new Set([...taken_names.value, ...invite_picks.value.filter((pick) => pick.preset).map((pick) => pick.name)]);
  return new Map(ordered_picks.value.map((pick) => {
    const instance = pick.preset ? pick.name : bridge.unique_instance(pick.name, taken);
    taken.add(instance);
    return [pick, instance];
  }));
});
/** Same readiness rule as the create form: the card's back must name a runnable entry. */
function invite_status(name) {
  const profile = view.value.launch.profiles[name] || {};
  const api = profile.adapter === "api";
  const ready = api ? Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model)
    : Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
  return ready ? { text: api ? t("已配置 API") : t("已配置本机软件"), tone: "ready" } : { text: api ? t("待补齐 API 配置") : t("待补齐接入配置"), tone: "warn" };
}
// Woken picks need the local service and a runnable entry; manual ones need neither.
const invite_blocked = computed(() => submitting.value || (!invite_picks.value.length && !external_drafts.value.length && !invite_workflow.value?.existing.length && !Object.keys(invite_workflow.value?.members || {}).length)
  || invite_picks.value.some((pick) => pick.mode === "cli" && (!view.value.launch.available || invite_status(pick.name).tone === "warn")));
// A fresh dialog starts with a clean choice; earlier notices belong to the board.
// The workflow whose cards this invitation adds: { id, label }; enabled once all its cards have joined.
const invite_workflow = ref(null);
const submitting = ref(false);
const loading = ref(false), failure = ref("");
let workflow_request = 0;
onBeforeUnmount(() => { workflow_request++; });
watch(inviting, async (open) => {
  workflow_request++;
  loading.value = false;
  failure.value = "";
  if (!open) return;
  invite_workflow.value = null;
  invite_picks.value = [];
  external_drafts.value = [];
  guest_card.value = false;
  guest_generated.value = false;
  invite_tried.value = false;
  invited_manual.value = [];
  invited_external.value = [];
  adding_seats.value = [];
  if (props.workflowId) await choose_workflow(props.workflowId);
});
watch(() => room.value.id, () => { inviting.value = false; invite_picks.value = []; });

/** Add a card for a platform, again for a second instance; one without local software starts on its API, as in the create form. */
function add_invite(name) {
  bridge.default_launch_entry(name);
  if (!invite_picks.value.some((pick) => pick.name === name)) bridge.clear_card_drafts(name);
  invite_picks.value = [...invite_picks.value, { id: ++invite_pick_seq, name, mode: "cli" }];
}

// The same add row as the create form: platforms first, presets and the other computer on their own rows.
const PRESET_PREFIX = "preset:";
const PROJECT_PRESET_PREFIX = "project-preset:";
const project_preset = (value) => project_presets.value.find((item) => bridge.preset_key(item) === value.slice(PROJECT_PRESET_PREFIX.length));
// A platform not set up yet stays grey at the end of its row; its chip opens the setup instead of adding a member.
const configuring = ref("");
const unconfigured_chip = (name) => bridge.platform_configured(name) ? {} : { unconfigured: true, title: t("未配置，点击配置"), aria_label: t("配置 {value1}", { value1: bridge.default_name(bridge.platform_of(name)) }) };
function configure_platform(value) {
  const name = value.startsWith(PROJECT_PRESET_PREFIX) ? project_preset(value)?.name
    : value.startsWith(PRESET_PREFIX) ? value.slice(PRESET_PREFIX.length) : value;
  if (name) configuring.value = bridge.platform_of(name);
}
const library_items = computed(() => [...invite_choices.value.map((name) => ({ value: name, name: bridge.default_name(name), ...bridge.identities[name],
  title: invite_count(name) ? t("已在场 {count} 位 · 将添加新实例", { count: invite_count(name) }) : "", aria_label: t("添加 {name} 实例", { name }), ...unconfigured_chip(name) })),
  ...invite_presets.value.map((preset, index) => ({ value: PRESET_PREFIX + preset.name, name: preset.label || preset.name, ...bridge.identities[bridge.platform_of(preset.name)],
    separated: index === 0, title: preset.description || t("专家预设"), aria_label: t("添加预设 {name}", { name: preset.label || preset.name }), removable: true, ...unconfigured_chip(preset.name) })),
  ...project_presets.value.map((preset) => ({
    value: PROJECT_PRESET_PREFIX + bridge.preset_key(preset),
    name: preset.label || preset.name,
    ...bridge.identities[bridge.platform_of(preset.name)],
    row: t("项目预设"),
    tag: preset.project_name || (preset.readonly ? t("只读") : ""),
    title: [
      preset.readonly ? t("只读目录") : "",
      preset.requested_access && !preset.trusted ? t("未信任目录的高权限预设，加入后默认只读，可在卡片背面确认放开") : "",
      preset.description || t("项目专家预设"),
    ].filter(Boolean).join(" · "),
    aria_label: t("添加项目预设 {name}", { name: preset.label || preset.name }),
    removable: !preset.readonly,
    ...unconfigured_chip(preset.name),
  })),
  // Its own row: it opens the invitation panel instead of adding a card.
  { value: EXTERNAL_CHIP, name: t("外部专家"), icon: "/icons/external-expert.svg", style: "external", row: t("外部"),
    title: t("对方电脑上的 AI，只读本房间开放的内容"), aria_label: t("邀请外部专家") },
  { value: GUEST_CHIP, name: t("外部用户"), icon: "/icons/external-user.svg", style: "external", row: t("外部"),
    title: t("对方用浏览器打开链接，限时进入本房间直接和 AI 对话"), aria_label: t("邀请外部用户") },
]);

/** Add the platform or preset a chip names. */
function add_library_item(value) {
  if (value === GUEST_CHIP) { guest_card.value = true; return; }
  if (value === EXTERNAL_CHIP) { external_drafts.value = [...external_drafts.value, { id: ++external_seq, draft: {} }]; return; }
  if (value.startsWith(PROJECT_PRESET_PREFIX)) {
    const preset = project_preset(value);
    if (preset) add_invite_preset(preset);
    return;
  }
  if (!value.startsWith(PRESET_PREFIX)) return add_invite(value);
  const preset = invite_presets.value.find((item) => item.name === value.slice(PRESET_PREFIX.length));
  if (preset) add_invite_preset(preset);
}
function remove_library_preset(value) {
  if (!value.startsWith(PROJECT_PRESET_PREFIX)) return bridge.delete_expert_preset(value.slice(PRESET_PREFIX.length));
  const preset = project_preset(value);
  if (preset && !preset.readonly) return bridge.delete_expert_preset({
    name: preset.name, scope: "project", project_id: preset.project_id, room_id: room.value.id,
  });
}

/** Add a preset's card under a name no member or other pick holds, set up from the preset. */
function add_invite_preset(preset) {
  const name = bridge.unique_instance(preset.name, new Set([...taken_names.value, ...invite_picks.value.map((pick) => pick_instances.value.get(pick) || pick.name)]));
  bridge.apply_expert_preset(name, preset);
  invite_picks.value = [...invite_picks.value, { id: ++invite_pick_seq, name, mode: "cli", preset: true }];
}

/** Replace the workflow picks; reuse its still-present members and ask before recalling anyone who left. */
async function choose_workflow(id) {
  if (submitting.value) return;
  if (!id) { invite_picks.value = invite_picks.value.filter(pick => !pick.card); invite_workflow.value = null; return; }
  const request = ++workflow_request;
  loading.value = true;
  failure.value = "";
  let workflow;
  try { workflow = await bridge.local_request("workflows", { action: "get", id }); }
  catch (error) { if (request === workflow_request) failure.value = error.message; return; }
  finally { if (request === workflow_request) loading.value = false; }
  if (request !== workflow_request) return;
  invite_picks.value = invite_picks.value.filter(pick => !pick.card);
  const binding = view.value.launch.room_models?.workflow;
  const existing = workflow.agents.map(agent => ({ ...record(binding?.id === id ? binding.members?.[agent.card] : ""), card: agent.card }))
    .filter(member => ["active", "away"].includes(member.status));
  invite_workflow.value = { id, label: workflow.label || id, existing, members: {} };
  for (const agent of workflow.agents) {
    if (existing.some(member => member.card === agent.card)) continue;
    add_invite_preset(bridge.workflow_preset(agent));
    invite_picks.value.at(-1).card = agent.card;
  }
}

/** Invite one by one through the local service, which configures each expert from its card before the room admits it; stop at the first failure and keep the rest picked. */
async function invite() {
  if (invite_blocked.value) return;
  submitting.value = true;
  try { await submit_invitation(); }
  finally { submitting.value = false; }
}

/** Keep admitted card names only in this dialog's draft, so a partial retry cannot leak into another invitation. */
async function submit_invitation() {
  invite_tried.value = true;
  const manual_names = [];
  const workflow = invite_workflow.value;
  for (const member of workflow?.existing || []) {
    if (record(member.name)?.status === "away" && !await act("change_member", { member_id: member.id, name: member.name, action: "rejoin" })) return;
    workflow.members[member.card] = member.name;
  }
  // Snapshot before the loop: removing invited picks would otherwise shift the names of the rest.
  const instances = new Map(pick_instances.value);
  let invited_any = invite_picks.value.length > 0;
  for (const pick of [...ordered_picks.value]) {
    const profile = view.value.launch.profiles[pick.name] || {};
    const manual = pick.mode === "manual";
    const instance = instances.get(pick);
    const invited = await act("invite_member", { name: pick.name, access: manual ? "manual" : "runner",
      project_access: profile.project_access || view.value.launch.workspace?.project_access || "read",
      ...(!manual && profile.session_id ? { session_id: profile.session_id } : {}),
      ...(pick.card && !manual ? { card: pick.card, workflow_members: workflow.members } : {}), refresh: false });
    // Admission may already be durable when a later label/description update fails. Do not invite it twice on retry.
    if (!invited) {
      if (pick.card && workflow.members[pick.card]) invite_picks.value = invite_picks.value.filter((item) => item !== pick);
      break;
    }
    // A manual member only starts when its launch instruction reaches the user's own AI session, so the dialog stays for that step.
    if (manual) manual_names.push(instance);
    // A resumed conversation now belongs to this member; the platform's next card starts a new one.
    if (profile.session_id) bridge.write_launch(pick.name, "session_id", null);
    invite_picks.value = invite_picks.value.filter((item) => item !== pick);
  }
  invited_manual.value = [...invited_manual.value, ...manual_names];
  if (external_drafts.value.length && !invite_picks.value.length) invited_any = await add_external_seats() || invited_any;
  // The workflow is bound once all its cards joined; a failure leaves the rest picked for a retry.
  if (workflow && Object.keys(workflow.members).length && !invite_picks.value.some((pick) => pick.card)) {
    if (!await act("enable_room_workflow", { id: workflow.id, members: workflow.members })) return await refresh_after(invited_any);
    invite_workflow.value = null;
  }
  // A seat that failed keeps its card here for a retry instead of closing the dialog on it.
  if (!invite_picks.value.length && !invited_manual.value.length && !invited_external.value.length && !external_drafts.value.length) inviting.value = false;
  await refresh_after(invited_any);
}

/** Add each external expert's seat in turn; stop at the first failure and keep the rest. True once any was added. */
async function add_external_seats() {
  const queue = [...external_drafts.value];
  let added = false;
  external_drafts.value = [];
  adding_seats.value = queue;
  for (const [index, item] of queue.entries()) {
    try {
      const seat = await room_operations(bridge).create_invite(room.value.id, seat_options(item.draft, room_directories.value));
      invited_external.value = [...invited_external.value, seat.member_id];
      adding_seats.value = queue.slice(index + 1);
      added = true;
    } catch (error) {
      bridge.notify("error", runner_text(error.message));
      external_drafts.value = queue.slice(index);
      break;
    }
  }
  adding_seats.value = [];
  return added;
}

/** Invitations skip the per-member reload; the room is read once after the batch, also when it stopped part way. */
async function refresh_after(invited_any) {
  if (invited_any) await act("refresh");
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="inviting" :title="t('邀请成员')" :description="description" :ui="{ content: 'glass-panel studio-modal pb-invite-modal', body: 'dialog-body' }">
    <template #body>
      <div v-if="loading" class="pb-invite-cards" role="status" :aria-label="t('正在读取工作流成员')"><USkeleton v-for="card in 2" :key="card" class="pb-invite-skeleton w-full" /></div>
      <div v-else-if="failure" class="pb-invite" role="status"><p>{{ failure }}</p><UButton :label="t('重试')" icon="i-lucide-refresh-cw" color="neutral" variant="soft" @click="choose_workflow(workflowId)" /></div>
      <div v-else-if="invited_any_seat" class="pb-invite" :aria-label="t('启动新成员')">
        <p class="pb-invite-lead">{{ launch_lead }}</p>
        <ul class="pb-invite-launches">
          <li v-for="name in invited_manual" :key="name">
            <UAvatar :src="bridge.identities[bridge.platform_of(name)]?.icon" :text="bridge.identities[bridge.platform_of(name)]?.initials" :alt="name" size="xs" class="channel-avatar" :class="bridge.identities[bridge.platform_of(name)]?.style" />
            <strong>{{ bridge.display_name(name) }}</strong>
            <small :class="{ 'is-registered': record(name)?.registered_at }">{{ record(name)?.registered_at ? t('已注册') : t('待注册') }}</small>
            <UButton :icon="launch_copied === name ? 'i-lucide-check' : 'i-lucide-rocket'" :label="launch_copied === name ? t('已复制') : t('复制启动指令')" size="sm" :color="launch_copied === name ? 'success' : 'primary'" variant="soft" class="pb-launch-button" :loading="is_running('copy_member_launch')" @click="copy_launch(name)" />
          </li>
          <li v-for="id in invited_external" :key="`seat-${id}`">
            <UAvatar src="/icons/external-expert.svg" :alt="t('外部专家')" size="xs" class="channel-avatar external" />
            <strong>{{ seat_record(id) ? bridge.display_name(seat_record(id).name) : t('外部专家') }}</strong>
            <small :class="{ 'is-registered': seat_record(id) && !external_of(seat_record(id)).pending }">{{ seat_record(id) && !external_of(seat_record(id)).pending ? t('已签到') : t('待签到') }}</small>
            <UButton :icon="launch_copied === `seat:${id}` ? 'i-lucide-check' : 'i-lucide-link'" :label="launch_copied === `seat:${id}` ? t('已复制') : t('复制邀请链接')" size="sm" :color="launch_copied === `seat:${id}` ? 'success' : 'primary'" variant="soft" class="pb-launch-button" @click="copy_seat(id)" />
          </li>
          <li v-for="item in adding_seats" :key="`adding-${item.id}`" role="status">
            <UAvatar src="/icons/external-expert.svg" :alt="t('外部专家')" size="xs" class="channel-avatar external" />
            <strong>{{ t('外部专家') }}</strong>
            <small>{{ t('正在添加席位…') }}</small>
            <UButton icon="i-lucide-link" :label="t('复制邀请链接')" size="sm" color="primary" variant="soft" class="pb-launch-button" loading disabled />
          </li>
        </ul>
        <p v-if="invited_manual.length" class="fine-print">{{ t("指令含该成员的凭证，只交给对应的会话；关闭后仍可在参与者列表中复制。") }}</p>
        <p v-if="invited_external.length || adding_seats.length" class="fine-print">{{ t("邀请链接只发给要邀请的人；关闭后仍可在输入框上方或成员菜单的“邀请详情”里复制。") }}</p>
        <div class="pb-invite-footer"><UButton :label="t('完成')" class="channel-primary-button" @click="inviting = false" /></div>
      </div>
      <form v-else class="pb-invite" :aria-label="t('邀请专家')" @submit.prevent="invite">
        <!-- A workflow invitation only confirms the workflow's own cards; the platform and preset rows belong to ordinary invitations. -->
        <template v-if="!invite_workflow">
          <PlatformConfigDialog v-model="configuring" />
          <RosterAdd :label="t('选择 AI（可多选）')" :items="library_items" @add="add_library_item" @configure="configure_platform" @remove="remove_library_preset" />
        </template>
        <p v-for="member in invite_workflow?.existing || []" :key="member.card" class="fine-print">{{ bridge.display_name(member.name) }}{{ t('：') }}{{ record(member.name)?.status === 'away' ? t('确认后请回，保留原会话') : t('已在场，沿用原成员') }}</p>
        <div v-if="invite_picks.length || external_drafts.length && !invite_workflow" class="pb-invite-cards">
          <div v-for="pick in invite_picks" :key="pick.id" class="pb-invite-pick">
            <ExpertCard :name="pick.name" :mode="pick.mode" :choices="pick.card ? ['cli'] : ['cli', 'manual']" :status="invite_status(pick.name)" :directory="view.launch.room_models?.project_directory || ''" :workflow="pick.card ? invite_workflow?.label || '' : ''" @mode="pick.mode = $event" @remove="invite_picks = invite_picks.filter((item) => item !== pick)" />
            <p v-if="pick_instances.get(pick) !== pick.name" class="fine-print">{{ t("同一 AI 已有实例，将以 {name} 加入，使用独立会话。", { name: pick_instances.get(pick) }) }}</p>
          </div>
          <template v-if="!invite_workflow"><ExternalExpertCard v-for="item in external_drafts" :key="`external-${item.id}`" v-model:draft="item.draft" :paths="room_directories" @remove="external_drafts = external_drafts.filter((entry) => entry !== item)" /></template>
        </div>
        <ExternalGuestCard v-if="guest_card && !invite_workflow" @remove="guest_card = false; guest_generated = false" @generated="guest_generated = true" />
        <!-- Always rendered once cards exist, so switching a card's mode never changes the dialog height. -->
        <p v-if="invite_picks.length" class="fine-print" :class="{ 'pb-invite-reserved': !(invite_picks.some((pick) => pick.mode === 'manual') && invite_picks.some((pick) => pick.mode !== 'manual')) }" :aria-hidden="!(invite_picks.some((pick) => pick.mode === 'manual') && invite_picks.some((pick) => pick.mode !== 'manual'))">{{ t("手动启动的成员排在程序启动的成员之后加入队列。") }}</p>
        <p v-else-if="submitting" class="pb-invite-empty">{{ t("正在加入成员…") }}</p>
        <p v-else-if="!invite_workflow && !external_drafts.length && !guest_card" class="pb-invite-empty">{{ t("选择一位或多位 AI（同一 AI 可重复添加），点卡片翻面设置软件、模型与项目权限。") }}</p>
        <p v-if="invite_picks.some((pick) => pick.mode === 'cli') && !view.launch.available" role="alert" class="fine-print">{{ t("邀请需要本机服务，请在运行 AI 的电脑打开本机网站。") }}</p>
        <div class="pb-invite-footer">
          <UButton :label="guest_generated && !invite_picks.length && !external_drafts.length ? t('完成') : t('取消')" color="neutral" variant="ghost" :disabled="submitting" @click="inviting = false" />
          <!-- The external user card makes its own link; with nothing else picked there is nothing to invite here. -->
          <UButton v-if="!(guest_card && !invite_picks.length && !external_drafts.length && !invite_workflow)" type="submit" icon="i-lucide-user-plus" :label="invite_workflow ? t('确认成员并启用工作流') : invite_picks.length > 1 ? t('邀请 {count} 位', { count: invite_picks.length }) : t('邀请')" class="channel-primary-button" :disabled="invite_blocked" :loading="submitting" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.pb-invite { display: flex; flex-direction: column; gap: 14px; }
.pb-invite-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(248px, 100%), 272px)); align-items: start; gap: 8px; }
.pb-invite-skeleton { aspect-ratio: 1; }
.pb-invite-pick { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pb-invite-pick .fine-print { margin: 0; }
.pb-invite-lead { margin: 0; color: var(--ui-text-toned); font-size: 13px; }
.pb-invite-launches { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pb-invite-launches li { display: flex; align-items: center; gap: 8px; padding: 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); }
.pb-invite-launches strong { min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.pb-invite-launches small { padding: 1px 8px; border-radius: 999px; color: var(--ui-warning, #e0a33a); background: color-mix(in srgb, var(--ui-warning, #e0a33a) 14%, transparent); font-size: 11px; }
.pb-invite-launches small.is-registered { color: var(--ui-success, #3fb27f); background: color-mix(in srgb, var(--ui-success, #3fb27f) 14%, transparent); }
.pb-invite-launches li > .pb-launch-button { margin-left: auto; min-width: 112px; justify-content: center; }
.pb-invite-launches .channel-avatar { flex-shrink: 0; width: 22px; height: 22px; font-size: 9px; }
.pb-invite-mode { display: flex; align-items: center; gap: 12px; color: var(--ui-text-muted); font-size: 12px; }
.pb-invite-options { display: flex; gap: 3px; padding: 3px; border-radius: 6px; background: var(--ui-bg-muted); }
.pb-invite-options label { position: relative; display: grid; place-items: center; min-width: 56px; min-height: 28px; border-radius: 4px; cursor: pointer; }
.pb-invite-options label.is-selected { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); }
.pb-invite-options input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.pb-invite .fine-print { margin: -6px 0 0; }
.pb-invite-reserved { visibility: hidden; }
.pb-invite-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.pb-invite-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>

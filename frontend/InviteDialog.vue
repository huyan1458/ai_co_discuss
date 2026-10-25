<script setup>
/** Invite dialog shared by the discussion board and the free-room board: pick AIs, set up each card, then invite them one by one. */
import { computed, inject, ref, watch } from "vue";
import ExpertCard from "./ExpertCard.vue";

const props = defineProps({ description: { type: String, default: "新成员由程序按本机软件配置启动，或由你手动启动。" } });
const inviting = defineModel("open", { type: Boolean, default: false });
const { view, bridge, act, pending } = inject("discussion");
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
// Everyone picked for one invitation, one card per platform: [{ name, mode, session }].
const invite_picks = ref([]);
let invite_pick_seq = 0;
// Instance names of just-invited manual members; the dialog then shows their start step.
const invited_manual = ref([]);
// Board errors from earlier actions stay out of the dialog until this invite is submitted.
const invite_tried = ref(false);
const invite_choices = computed(() => Object.keys(bridge.launch_clients));
const taken_names = computed(() => (room.value.members || []).map((member) => member.name));
const invite_count = (platform) => taken_names.value.filter((name) => bridge.platform_of(name) === platform).length;
// Woken members join first so a manual member that has not registered yet never holds them up.
const ordered_picks = computed(() => [...invite_picks.value.filter((pick) => pick.mode !== "manual"), ...invite_picks.value.filter((pick) => pick.mode === "manual")]);
// Mirrors the instance names the invite assigns in join order, so each card says which seat it will take.
const pick_instances = computed(() => {
  const taken = [...taken_names.value];
  return new Map(ordered_picks.value.map((pick) => {
    let instance = pick.name;
    for (let number = 2; taken.includes(instance); number++) instance = `${pick.name}-${number}`;
    taken.push(instance);
    return [pick, instance];
  }));
});
/** Same readiness rule as the create form: the card's back must name a runnable entry. */
function invite_status(name) {
  const profile = view.value.launch.profiles[name] || {};
  const api = profile.adapter === "api";
  const ready = api ? Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model)
    : Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
  return ready ? { text: api ? "已配置 API" : "已配置本机软件", tone: "ready" } : { text: api ? "待补齐 API 配置" : "待补齐接入配置", tone: "warn" };
}
const invite_card_status = (pick) => pick.mode === "manual" ? { text: "手动启动，自行提交", tone: "muted" } : invite_status(pick.name);
// Woken picks need the local service and a runnable entry; manual ones need neither.
const invite_blocked = computed(() => !invite_picks.value.length
  || invite_picks.value.some((pick) => pick.mode === "cli" && (!view.value.launch.available || invite_status(pick.name).tone === "warn")));
// A fresh dialog starts with a clean choice; earlier notices belong to the board.
watch(inviting, (open) => {
  if (!open) return;
  invite_picks.value = [];
  invite_tried.value = false;
  invited_manual.value = [];
});
watch(() => room.value.id, () => { inviting.value = false; invite_picks.value = []; });

/** Add a card for a platform, again for a second instance; one without local software starts on its API, as in the create form. */
function add_invite(name) {
  if (!bridge.launch_clients[name]?.some((item) => item.value !== "api") && !view.value.launch.profiles[name]?.adapter) bridge.write_launch(name, "adapter", "api");
  invite_picks.value = [...invite_picks.value, { id: ++invite_pick_seq, name, mode: "cli", session: "" }];
}

/** Invite one by one through the local service, which configures each expert from its card before the room admits it; stop at the first failure and keep the rest picked. */
async function invite() {
  invite_tried.value = true;
  const manual_names = [];
  // Snapshot before the loop: removing invited picks would otherwise shift the names of the rest.
  const instances = new Map(pick_instances.value);
  for (const pick of [...ordered_picks.value]) {
    const profile = view.value.launch.profiles[pick.name] || {};
    const manual = pick.mode === "manual";
    const instance = instances.get(pick);
    await act("invite_member", { name: pick.name, access: manual ? "manual" : "runner",
      project_access: profile.project_access || view.value.launch.workspace?.project_access || "read",
      session_id: bridge.launch_can_bind_session(pick.name, view.value.launch) ? pick.session : "" });
    if (view.value.free_error) break;
    // A manual member only starts when its launch instruction reaches the user's own AI session, so the dialog stays for that step.
    if (manual) manual_names.push(instance);
    invite_picks.value = invite_picks.value.filter((item) => item !== pick);
  }
  invited_manual.value = [...invited_manual.value, ...manual_names];
  if (!invite_picks.value.length && !invited_manual.value.length) inviting.value = false;
}
</script>

<template>
  <UModal v-model:open="inviting" title="邀请成员" :description="description" :ui="{ content: 'glass-panel studio-modal pb-invite-modal', body: 'dialog-body' }">
    <template #body>
      <div v-if="invited_manual.length && !invite_picks.length" class="pb-invite" aria-label="启动手动成员">
        <p class="pb-invite-lead">{{ invited_manual.length > 1 ? `${invited_manual.length} 位手动成员已加入` : '手动成员已加入' }}，把启动指令交给各自的 AI 会话，注册后才算到场。</p>
        <p v-if="view.access?.error" role="alert" class="pb-free-note is-error">{{ view.access.error }}</p>
        <ul class="pb-invite-launches">
          <li v-for="name in invited_manual" :key="name">
            <UAvatar :src="bridge.identities[bridge.platform_of(name)]?.icon" :text="bridge.identities[bridge.platform_of(name)]?.initials" :alt="name" size="xs" class="channel-avatar" :class="bridge.identities[bridge.platform_of(name)]?.style" />
            <strong>{{ bridge.display_name(name) }}</strong>
            <small :class="{ 'is-registered': record(name)?.registered_at }">{{ record(name)?.registered_at ? '已注册' : '待注册' }}</small>
            <UButton :icon="launch_copied === name ? 'i-lucide-check' : 'i-lucide-rocket'" :label="launch_copied === name ? '已复制' : '复制启动指令'" size="sm" :color="launch_copied === name ? 'success' : 'primary'" variant="soft" class="pb-launch-button" :loading="pending === 'copy_member_launch'" :disabled="Boolean(pending)" @click="copy_launch(name)" />
          </li>
        </ul>
        <p class="fine-print">指令含该成员的凭证，只交给对应的会话；关闭后仍可在参与者列表中复制。</p>
        <div class="pb-invite-footer"><UButton label="完成" class="channel-primary-button" @click="inviting = false" /></div>
      </div>
      <form v-else class="pb-invite" aria-label="邀请专家" @submit.prevent="invite">
        <div class="pb-invite-library" role="group" aria-label="选择 AI（可多选）">
          <button v-for="name in invite_choices" :key="name" type="button" :aria-pressed="invite_picks.some((pick) => pick.name === name)" :title="invite_count(name) ? `已在场 ${invite_count(name)} 位 · 将添加新实例` : ''" @click="add_invite(name)">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="3xs" class="channel-avatar" :class="bridge.identities[name]?.style" />{{ name }}
          </button>
        </div>
        <div v-if="invite_picks.length" class="pb-invite-cards">
          <div v-for="pick in invite_picks" :key="pick.id" class="pb-invite-pick">
            <ExpertCard :name="pick.name" :mode="pick.mode" :choices="['cli', 'manual']" :status="invite_card_status(pick)" :session="pick.session" @mode="pick.mode = $event" @session="pick.session = $event" @remove="invite_picks = invite_picks.filter((item) => item !== pick)" />
            <p v-if="pick_instances.get(pick) !== pick.name" class="fine-print">同一 AI 已有实例，将以 {{ pick_instances.get(pick) }} 加入，使用独立会话。</p>
          </div>
        </div>
        <!-- Always rendered once cards exist, so switching a card's mode never changes the dialog height. -->
        <p v-if="invite_picks.length" class="fine-print" :class="{ 'pb-invite-reserved': !(invite_picks.some((pick) => pick.mode === 'manual') && invite_picks.some((pick) => pick.mode !== 'manual')) }" :aria-hidden="!(invite_picks.some((pick) => pick.mode === 'manual') && invite_picks.some((pick) => pick.mode !== 'manual'))">手动启动的成员排在程序启动的成员之后加入队列。</p>
        <p v-else class="pb-invite-empty">选择一位或多位 AI（同一 AI 可重复添加），点卡片翻面设置软件、模型与项目权限。</p>
        <p v-if="invite_picks.some((pick) => pick.mode === 'cli') && !view.launch.available" role="alert" class="fine-print">邀请需要本机服务，请在运行 AI 的电脑打开本机网站。</p>
        <p v-if="invite_tried && view.free_error" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
        <div class="pb-invite-footer">
          <UButton label="取消" color="neutral" variant="ghost" @click="inviting = false" />
          <UButton type="submit" icon="i-lucide-user-plus" :label="invite_picks.length > 1 ? `邀请 ${invite_picks.length} 位` : '邀请'" class="channel-primary-button" :disabled="invite_blocked" :loading="pending === 'invite_member'" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.pb-invite { display: flex; flex-direction: column; gap: 14px; }
.pb-invite-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(248px, 1fr)); align-items: start; gap: 8px; }
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
.pb-invite-options label:focus-within { outline: 1px solid var(--channel-accent); }
.pb-invite .fine-print { margin: -6px 0 0; }
.pb-invite-library { display: flex; flex-wrap: wrap; gap: 6px; }
.pb-invite-library > button { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 2px 10px 2px 4px; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.pb-invite-library > button:hover { border-color: var(--ui-border-accented); background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.pb-invite-library > button[aria-pressed="true"] { border-color: color-mix(in srgb, var(--channel-accent) 55%, transparent); background: color-mix(in srgb, var(--channel-accent) 12%, transparent); color: var(--ui-text-highlighted); }
.pb-invite-library .channel-avatar { flex-shrink: 0; width: 20px; height: 20px; font-size: 9px; }
.pb-invite-reserved { visibility: hidden; }
.pb-invite-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.pb-invite-footer { display: flex; justify-content: flex-end; gap: 8px; }
@media (pointer: coarse) { .pb-invite-library > button, .pb-invite-options label { min-height: 44px; } }
</style>

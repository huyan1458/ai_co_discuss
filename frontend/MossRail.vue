<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { access_label } from "../runner/expert_prompts.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import ContextMeter from "./ContextMeter.vue";
import StewardSettings from "./StewardSettings.vue";
import { delegation_state, report_state_label, report_tone } from "./moss.js";
import { member_quota, member_usage } from "./quota.js";
import { t } from "./i18n.js";

/**
 * MOSS's rail: which software it runs on, the two ways to give it a fresh session, and the work it has sent out with
 * where each piece stands. Settings open in a dialog from here (#15598).
 * Emits `open-room` with a room id when a row is chosen.
 */
const { view, bridge, act } = inject("discussion");
const emit = defineEmits(["open-room"]);
const settings = ref(null);
const settings_open = ref(false);
const change_software = ref(false);

// MOSS's own member in its room: its context in use shows beside 换个新脑子, the same meter as any member's card (#15623).
const moss_member = computed(() => (view.value.room?.free?.members || []).find((member) => member.status !== "removed"));
const moss_usage = computed(() => moss_member.value ? member_usage(view.value, moss_member.value.name) : null);
const moss_quota = computed(() => moss_member.value ? member_quota(view.value, moss_member.value.name) : null);

async function load() {
  try { settings.value = (await bridge.local_request("steward", {})).settings; }
  catch (error) { bridge.notify("error", error.message); }
}
onMounted(load);

const software = computed(() => {
  const value = settings.value;
  if (!value?.adapter) return null;
  const profile = adapter_profile(value.adapter);
  const platform = profile?.platform || bridge.platform_of(value.adapter);
  return { name: profile ? t(profile.label) : value.adapter, identity: bridge.identities[platform] || {},
    model: value.model || t("软件默认模型"), access: t(access_label(value.project_access)), raised: value.project_access && value.project_access !== "read" };
});

function open_settings(software_change = false) {
  change_software.value = software_change;
  settings_open.value = true;
}
function settings_done(saved) {
  settings_open.value = false;
  if (saved) settings.value = saved;
}

// Above read-only MOSS can run commands on this computer while it reads outside content; the rail says so and offers
// the way back (#15640). Raising it is done where it is needed: the install, deploy and inventory confirmations.
const lower_confirm = ref(false);
const lowering = ref(false);
async function lower_access() {
  if (lowering.value) return;
  lowering.value = true;
  try {
    const status = await bridge.local_request("steward-settings", { project_access: "read" });
    settings.value = status.settings || { ...settings.value, project_access: "read" };
    bridge.notify("info", t("MOSS 已改回只读"));
  } catch (error) { bridge.notify("error", error.message); }
  finally { lowering.value = false; }
}

// A fresh session for the same software and model, by the user's hand only (#15576): the room, its record and settings stay.
const renew_confirm = ref(false);
const renewing = ref(false);
async function renew() {
  if (renewing.value) return;
  renewing.value = true;
  try {
    const status = await bridge.local_request("steward-renew", {});
    if (status?.busy) bridge.notify("warning", t("MOSS 正在工作，空闲后再换"));
    else bridge.notify("info", t("MOSS 已开始新会话"));
  } catch (error) { bridge.notify("error", error.message); }
  finally { renewing.value = false; }
}

// The work MOSS sent out: rooms it created and rooms it delegated to, one row each, waiting on the user first.
// The site lists them with each room's latest delegation (`steward-work`, #15610); a site without that list leaves the
// page to read the send cards it has loaded, and the room list's attention for the rest.
const ORDER = { waiting_user: 0, unreported: 1, failed: 1, waiting: 2, running: 3, cancelled: 4, completed: 5 };
const ATTENTION_STATE = { waiting_user: "waiting_user", failed: "failed", running: "running" };
const by_order = (left, right) => (ORDER[left.state] ?? 4) - (ORDER[right.state] ?? 4);
const listed = ref(null);
// Rooms archived from here leave the list at once; one the site refuses comes back (the directory says why).
const archiving = reactive(new Set());
const archive_target = ref(null);
async function archive_room() {
  const item = archive_target.value;
  archive_target.value = null;
  if (!item || archiving.has(item.id)) return;
  archiving.add(item.id);
  try { await act("manage_channel", { id: item.id, action: "archive" }); } catch { /* Reported by the directory's own rollback. */ }
  if (!view.value.rooms.find((room) => room.id === item.id)?.archived) archiving.delete(item.id);
  else load_work();
}
const show_archived = ref(false);
let work_read = 0;
// An older site answers this path with an error: the rail falls back and stops asking while this room is shown.
let work_unsupported = false;
async function load_work() {
  const room_id = view.value.room?.id;
  if (!room_id || work_unsupported) return;
  const reading = ++work_read;
  try {
    const { items } = await bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/steward-work`);
    if (reading === work_read && Array.isArray(items)) listed.value = items;
  } catch { if (reading === work_read) { listed.value = null; work_unsupported = true; } }
}
// Read again whenever the room moves on (a new message, a report written back) or a room is archived or restored.
watch(() => [view.value.room?.id, view.value.room?.latest_id, view.value.rooms.filter((room) => room.parent_room_id === view.value.room?.id && room.archived).length],
  load_work, { immediate: true });
const listed_rows = computed(() => (listed.value || []).map((item) => ({ id: item.room_id, title: item.title, state: item.state || "running",
  task: item.preset === "task", archived: Boolean(item.archived) || archiving.has(item.room_id) })).sort(by_order));
const archived_count = computed(() => listed_rows.value.filter((item) => item.archived).length);
const work = computed(() => listed.value ? listed_rows.value.filter((item) => show_archived.value || !item.archived) : loaded_work.value);
const loaded_work = computed(() => {
  const moss_id = view.value.room?.id;
  const rooms = new Map(view.value.rooms.map((room) => [room.id, room]));
  const latest = new Map();
  for (const message of view.value.messages || []) {
    if (message.source !== "room_relay_sent" || !message.relay_sent_room) continue;
    if ((latest.get(message.relay_sent_room)?.id || 0) < message.id) latest.set(message.relay_sent_room, message);
  }
  const ids = new Set([...latest.keys(), ...view.value.rooms.filter((room) => room.parent_room_id === moss_id && !room.archived).map((room) => room.id)]);
  return [...ids].map((id) => {
    const room = rooms.get(id), sent = latest.get(id);
    if (room?.archived || archiving.has(id) || (!room && !sent?.relay_sent_title)) return null;
    const state = sent ? delegation_state(sent) : ATTENTION_STATE[room?.attention] || "";
    return { id, title: room?.title || sent.relay_sent_title, state, task: room?.preset === "task" };
  }).filter(Boolean).sort(by_order);
});
</script>

<template>
  <section class="moss-rail" :aria-label="t('MOSS')">
    <div class="moss-software">
      <template v-if="software">
        <div class="moss-software-name">
          <UAvatar :src="software.identity.icon" :text="software.identity.initials" size="sm" class="channel-avatar" :class="software.identity.style" />
          <strong>{{ software.name }}</strong>
        </div>
        <dl>
          <div><dt>{{ t("模型") }}</dt><dd>{{ software.model }}</dd></div>
          <div><dt>{{ t("项目") }}</dt><dd :class="{ 'moss-access-raised': software.raised }">{{ software.access }}<UButton v-if="software.raised" size="xs" variant="link" color="warning" class="moss-access-lower" :label="t('改回只读')" :loading="lowering" @click="lower_confirm = true" /></dd></div>
        </dl>
      </template>
      <p v-else class="fine-print">{{ settings ? t("还没有选择软件") : t("正在读取…") }}</p>
      <div class="moss-software-actions">
        <UButton icon="i-lucide-settings-2" :label="t('设置')" size="sm" color="neutral" variant="soft" @click="open_settings()" />
        <UButton icon="i-lucide-brain" :label="t('换个新脑子')" size="sm" color="neutral" variant="soft" :loading="renewing" :disabled="!software" @click="renew_confirm = true" />
        <span v-if="moss_usage?.context_used" class="moss-context"><ContextMeter :usage="moss_usage" :quota="moss_quota" mode="full" labelled /></span>
        <UButton icon="i-lucide-arrow-left-right" :label="t('更换软件')" size="sm" color="neutral" variant="soft" @click="open_settings(true)" />
      </div>
    </div>
    <section class="moss-work" :aria-label="t('派出的工作')">
      <h4>{{ t("派出的工作") }}</h4>
      <ul v-if="work.length">
        <li v-for="item in work" :key="item.id">
          <button type="button" :class="{ 'is-archived': item.archived }" :title="item.archived ? t('已存档') : t('打开房间')" @click="emit('open-room', item.id)">
            <UIcon :name="item.task ? 'i-lucide-clipboard-check' : 'i-lucide-hash'" class="moss-work-icon" :title="item.task ? t('任务房间') : t('项目房间')" />
            <span class="moss-work-title">{{ item.title }}</span>
            <span v-if="report_state_label(item.state)" class="channel-relay-report" :data-state="report_tone(item.state)">{{ report_state_label(item.state) }}</span>
          </button>
          <UButton v-if="!item.archived" icon="i-lucide-archive" size="xs" color="neutral" variant="ghost" class="moss-work-archive" :title="t('存档房间')" :aria-label="t('存档 {name}', { name: item.title })" @click="archive_target = item" />
        </li>
      </ul>
      <p v-else class="fine-print">{{ t("MOSS 还没有派出工作。它把事情交给其他房间时，会列在这里。") }}</p>
      <USwitch v-if="archived_count" v-model="show_archived" size="xs" class="moss-work-archived" :label="t('显示已存档（{count}）', { count: archived_count })" />
    </section>
    <UModal v-model:open="settings_open" :title="t('MOSS 配置')" :ui="{ content: 'glass-panel studio-modal moss-settings-modal', body: 'dialog-body' }">
      <template #body><StewardSettings :change-software="change_software" @done="settings_done" /></template>
    </UModal>
    <ConfirmDialog :open="Boolean(archive_target)" :title="t('存档「{name}」', { name: archive_target?.title || '' })" :description="t('存档后房间移入已存档列表，记录保留，可随时恢复。')"
      :confirm-label="t('存档')" @update:open="!$event && (archive_target = null)" @confirm="archive_room" />
    <ConfirmDialog v-model:open="lower_confirm" :title="t('改回只读')" :description="t('MOSS 将只能读取，不能运行命令或改本机文件；之后安装、部署、占用盘点时会先问你是否调高。')" :confirm-label="t('改回只读')" @confirm="lower_access" />
    <ConfirmDialog v-model:open="renew_confirm" :title="t('换个新脑子')" :description="t('MOSS 会用同一个软件和模型开始新的会话，当前会话的上下文会清掉；房间记录、职责和配置都保留。')" :confirm-label="t('换新会话')" @confirm="renew" />
  </section>
</template>

<style scoped>
.moss-rail { display: grid; gap: 18px; align-content: start; padding: 16px; }
/* Grid rows shrink to the rail, so a long room name gives way to its state instead of pushing it out. */
.moss-rail > *, .moss-work ul, .moss-work li { min-width: 0; }
.moss-software { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; background: color-mix(in srgb, var(--ui-text) 3%, transparent); }
.moss-software-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.moss-software-name > strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.moss-software dl { display: grid; gap: 4px; margin: 0; font-size: 12px; }
.moss-software dl > div { display: grid; grid-template-columns: 4.5em minmax(0, 1fr); gap: 8px; }
.moss-software dt { color: var(--ui-text-dimmed); }
.moss-software dd { margin: 0; overflow: hidden; color: var(--ui-text-toned); text-overflow: ellipsis; white-space: nowrap; }
.moss-software-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.moss-work { display: grid; gap: 6px; }
.moss-work > h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.moss-work ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
/* Each row's archive button sits at its end; with a mouse it shows on hover, on touch it stays. */
.moss-work li { display: flex; align-items: center; gap: 2px; }
@media (hover: hover) and (pointer: fine) { .moss-work-archive { opacity: 0; } .moss-work li:is(:hover, :focus-within) .moss-work-archive { opacity: 1; } }
.moss-access-raised { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; white-space: normal !important; color: var(--ui-warning) !important; font-weight: 600; }
.moss-access-lower { padding: 0 !important; font-weight: 400; }
.moss-context { display: inline-flex; align-items: center; color: var(--ui-text-muted); font-size: 12px; }
.moss-work li > button:first-child { flex: 1; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; padding: 6px 8px; border-radius: 8px; text-align: left; font-size: 13px; }
@media (hover: hover) { .moss-work li > button:first-child:hover { background: var(--channel-ghost-hover); } }
.moss-work li > button.is-archived { opacity: .6; }
.moss-work-archived { margin-top: 4px; }
.moss-work-icon { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.moss-work-title { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); text-overflow: ellipsis; white-space: nowrap; }
</style>

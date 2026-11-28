<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import ContextMeter from "./ContextMeter.vue";
import StewardSettings from "./StewardSettings.vue";
import { delegation_state, moss_running, moss_window_key, report_state_label, report_tone, room_attention } from "./moss.js";
import { member_usage } from "./quota.js";
import { t } from "./i18n.js";

/**
 * MOSS's rail, laid out as a room's rail is (#15890): the software it runs on as one member row (state light, context
 * ring, the menu for a fresh session), then the work it has sent out with where each piece stands. Settings open in a
 * dialog from here (#15598). MOSS has no project access to show: it always runs with full access (#15951).
 * Emits `open-room` with a room id when a row is chosen.
 */
const { view, bridge, act } = inject("discussion");
const emit = defineEmits(["open-room"]);
const settings = ref(null);
const settings_open = ref(false);
const change_software = ref(false);

// MOSS's own member in its room: its context in use is the same ring as on any member's row (#15623).
const moss_member = computed(() => (view.value.room?.free?.members || []).find((member) => member.status !== "removed"));
const moss_usage = computed(() => moss_member.value ? member_usage(view.value, moss_member.value.name) : null);
// The same light and words as the room's row in the sidebar (#15888), grey 空闲 when nothing is going on.
const STATUS_TONES = { awaiting: "warning", waiting_user: "warning", failed: "error", running: "primary" };
const status = computed(() => {
  const room = view.value.room;
  const listed_room = view.value.rooms.find((item) => item.id === room?.id) || room;
  const attention = listed_room ? room_attention(listed_room, moss_running(room)) : null;
  return { label: attention?.label || t("空闲"), tone: STATUS_TONES[attention?.kind] || "neutral" };
});
// Which of MOSS's windows this rail belongs to (§12.1): its settings are that window's own.
const kind = computed(() => view.value.room?.system_kind);
const settings_window = computed(() => kind.value === "steward_private" ? "private" : kind.value === "steward_group" ? moss_window_key(view.value.room) : "");
const settings_title = computed(() => kind.value === "steward_private" ? t("私聊设置")
  : kind.value === "steward_group" ? t("「{name}」的设置", { name: view.value.room?.title || "" }) : t("MOSS 配置"));
// 换个新脑子 and 更换软件 are rare and weighty, so they wait in the row's menu. Both act on 主理人's session and
// software, so in another window they stay in the menu, greyed, saying where to do it.
const elsewhere = computed(() => kind.value !== "steward");
const more_items = computed(() => [[
  { label: t("换个新脑子"), icon: "i-lucide-brain", disabled: elsewhere.value || !software.value || renewing.value, description: elsewhere.value ? t("在主理人窗口里操作") : undefined, onSelect: () => { renew_confirm.value = true; } },
  { label: t("更换软件"), icon: "i-lucide-arrow-left-right", disabled: elsewhere.value, description: elsewhere.value ? t("在主理人窗口里操作") : undefined, onSelect: () => open_settings(true) },
]]);

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
    setup: [value.model || t("软件默认模型"), value.effort].filter(Boolean).join(" · ") };
});

function open_settings(software_change = false) {
  change_software.value = software_change;
  settings_open.value = true;
}
function settings_done(saved) {
  settings_open.value = false;
  if (saved) settings.value = saved;
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
  <!-- A room's rail in structure and classes: title bar level with the page header, flat sections, a member row. -->
  <div class="moss-rail progress-board is-docked">
    <header class="pb-header"><strong>MOSS</strong></header>
    <section class="pb-section" :aria-label="t('软件')">
      <h4 class="moss-heading">{{ t("软件") }}<button type="button" class="pb-link" @click="open_settings()">{{ t("设置") }}</button></h4>
      <!-- The same three lines whether loading or loaded, so nothing below moves when the settings arrive. -->
      <div class="pb-member moss-member">
        <UAvatar v-if="software" :src="software.identity.icon" :text="software.identity.initials" size="xs" class="channel-avatar" :class="software.identity.style" />
        <USkeleton v-else class="size-6 shrink-0 rounded-full" />
        <div class="pb-member-body">
          <div class="pb-member-name">
            <template v-if="settings"><span class="moss-member-label">{{ software?.name || t("还没有选择软件") }}</span></template>
            <USkeleton v-else class="h-3 w-28" :aria-label="t('正在读取…')" />
          </div>
          <div class="moss-setup" translate="no" :title="software?.setup">
            <span v-if="settings" class="notranslate">{{ software?.setup || "—" }}</span>
            <USkeleton v-else class="h-2.5 w-20" />
          </div>
          <div class="pb-member-status" :class="`is-${status.tone}`"><span class="pb-dot"></span><span class="pb-member-status-text" role="status">{{ status.label }}</span><ContextMeter :usage="moss_usage" mode="row" class="pb-member-usage" /></div>
        </div>
        <UDropdownMenu :items="more_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :title="t('更多')" :aria-label="t('更多')" :loading="renewing" />
        </UDropdownMenu>
      </div>
    </section>
    <section class="pb-section moss-work" :aria-label="t('派出的工作')">
      <h4 class="moss-heading">{{ t("派出的工作") }}<span v-if="work.length">{{ work.length }}</span></h4>
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
      <p v-else class="moss-work-empty">{{ t("这个窗口还没有派出工作。MOSS 把事情交给其他房间时，会列在这里。") }}</p>
      <USwitch v-if="archived_count" v-model="show_archived" size="xs" class="moss-work-archived" :label="t('显示已存档（{count}）', { count: archived_count })" />
    </section>
    <UModal v-model:open="settings_open" :title="settings_title" :ui="{ content: 'glass-panel studio-modal moss-settings-modal', body: 'dialog-body' }">
      <template #body><StewardSettings :key="settings_window" :window="settings_window" :change-software="change_software" @done="settings_done" /></template>
    </UModal>
    <ConfirmDialog :open="Boolean(archive_target)" :title="t('存档「{name}」', { name: archive_target?.title || '' })" :description="t('存档后房间移入已存档列表，记录保留，可随时恢复。')"
      :confirm-label="t('存档')" @update:open="!$event && (archive_target = null)" @confirm="archive_room" />
    <ConfirmDialog v-model:open="renew_confirm" :title="t('换个新脑子')" :description="t('MOSS 会用同一个软件和模型开始新的会话，当前会话的上下文会清掉；房间记录、职责和配置都保留。')" :confirm-label="t('换新会话')" @confirm="renew" />
  </div>
</template>

<style scoped>
/* Section spacing, heading type, the member row, lights and the title bar all come from the room rail (`pb-*`). */
.moss-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.moss-heading > span { font-weight: 400; font-variant-numeric: tabular-nums; }
.moss-heading > .pb-link { margin: 0; font-weight: 400; letter-spacing: 0; }
/* The one row is not something to press, so it has no hover fill and starts flush with the heading. */
.moss-member { align-items: start; padding: 4px 0; }
.moss-member:hover { background: none; }
.moss-member > :first-child { margin-top: 1px; }
.moss-member .pb-member-body { display: grid; gap: 2px; }
.moss-member .pb-member-body > div { display: flex; align-items: center; height: 18px; }
.moss-member .pb-member-body > .pb-member-name { height: 20px; }
.moss-member-label { flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.moss-setup { min-width: 0; color: var(--ui-text-dimmed); font-size: 12px; }
.moss-setup > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.moss-work ul { display: grid; gap: 2px; min-width: 0; margin: 0 -8px; padding: 0; list-style: none; }
/* Each row's archive button sits at its end; with a mouse it shows on hover, on touch it stays. */
.moss-work li { display: flex; align-items: center; gap: 2px; min-width: 0; }
@media (hover: hover) and (pointer: fine) { .moss-work-archive { opacity: 0; } .moss-work li:is(:hover, :focus-within) .moss-work-archive { opacity: 1; } }
/* A long room name gives way to its state instead of pushing it out. */
.moss-work li > button:first-child { flex: 1; display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 32px; padding: 0 8px; border-radius: 6px; text-align: left; font-size: 13px; }
@media (hover: hover) { .moss-work li > button:first-child:hover { background: color-mix(in srgb, var(--ui-bg-accented) 60%, transparent); } }
.moss-work li > button.is-archived { opacity: .6; }
.moss-work-icon { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.moss-work-title { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); text-overflow: ellipsis; white-space: nowrap; }
.moss-work-empty { margin: 0; color: var(--ui-text-dimmed); font-size: 12px; line-height: 1.7; }
.moss-work-archived { margin-top: 8px; }
</style>

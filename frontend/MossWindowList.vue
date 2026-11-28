<script setup>
/**
 * MOSS's windows (`.dev/plans/MOSS对外窗口/` §12.2): 主理人 and 私聊 always first, then the groups turned on (one waiting
 * on the owner first, the rest by last activity), and 加入群 always last. Each card is one window's room, the same height
 * whatever it has: name and time, the last message in one line, its state, and for a group today's use and whether it
 * waits on the owner. Docked as a column left of the conversation on a wide screen; in a drawer on a phone (`drawer`).
 * Emits `open-room` with a room id and `notify-settings` when the owner should bind a chat channel first.
 */
import { computed, inject, onMounted, reactive, ref, watch } from "vue";
import MossJoinGroup from "./MossJoinGroup.vue";
import { moss_avatar, moss_running, moss_window_key, room_attention } from "./moss.js";
import { locale, t } from "./i18n.js";

const props = defineProps({ drawer: Boolean });
const emit = defineEmits(["open-room", "notify-settings"]);
const { view, bridge } = inject("discussion");

const EXCERPT_CHARS = 80;
const DEFAULT_DAILY_LIMIT = 30;
const live = (kind) => view.value.rooms.filter((room) => room.system_kind === kind && !room.archived);
const main_room = computed(() => live("steward")[0] || null);
const private_room = computed(() => live("steward_private")[0] || null);
const activity = (room) => Date.parse(room?.latest_speech_at || room?.latest_at || room?.created_at || 0) || 0;

// What the computer knows that the room list does not: whether a chat channel is bound (for 私聊) and each group's
// counts and waiting question (for its card). Read once when the list appears; the cards show placeholders until then.
const channels = ref(null);
const group_state = reactive({});
async function load_local() {
  try { channels.value = (await bridge.local_request("notify", {})).channels || []; }
  catch { channels.value = []; return; }
  for (const channel of channels.value.filter((item) => item.capabilities?.groups && item.ready)) {
    try {
      const { groups } = await bridge.local_request("notify", { channel: channel.id, action: "groups" });
      for (const group of groups || []) group_state[`${channel.id}:${group.id}`] = group;
    } catch { /* The group cards keep their placeholders. */ }
  }
}
onMounted(load_local);
const channel_bound = computed(() => channels.value === null ? null : channels.value.some((item) => item.enabled !== false && item.ready));

const groups = computed(() => live("steward_group").map((room) => ({ room, state: group_state[moss_window_key(room)] || null }))
  .sort((left, right) => Number(Boolean(right.state?.pending_owner)) - Number(Boolean(left.state?.pending_owner)) || activity(right.room) - activity(left.room)));

// The last message of each window in one line, read by its id when it changes (the room list carries only the id).
const excerpts = reactive({});
async function load_excerpt(room) {
  const latest = room.latest_id;
  if (!latest || excerpts[room.id]?.id === latest) return;
  excerpts[room.id] = { id: latest, text: excerpts[room.id]?.text || "" };
  try {
    const message = await bridge.request(`/api/rooms/${encodeURIComponent(room.id)}/messages/${latest}?limit=${EXCERPT_CHARS}`);
    if (excerpts[room.id]?.id === latest) excerpts[room.id] = { id: latest, text: String(message.text || "").replace(/[#>*_`~[\]]+/g, "").replace(/\s+/g, " ").trim() };
  } catch { /* An unreadable message leaves the line empty. */ }
}
watch(() => [main_room.value, private_room.value, ...groups.value.map((item) => item.room)].filter(Boolean).map((room) => `${room.id}:${room.latest_id}`).join(","),
  () => { for (const room of [main_room.value, private_room.value, ...groups.value.map((item) => item.room)]) if (room) load_excerpt(room); }, { immediate: true });

const STATES = { running: () => t("工作中"), awaiting: () => t("等你回答"), waiting_user: () => t("等你回答"), failed: () => t("执行失败") };
function state_of(room) {
  if (!room) return { kind: "idle", label: t("空闲") };
  const running = room.id === view.value.room?.id && moss_running(view.value.room);
  const attention = room_attention(room, running);
  return { kind: attention?.kind || "idle", label: STATES[attention?.kind]?.() || t("空闲") };
}
function time_of(room) {
  if (!room) return "";
  const at = activity(room);
  if (!at) return "";
  const date = new Date(at), now = new Date();
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

const cards = computed(() => [
  { key: "main", kind: "main", room: main_room.value, name: t("主理人"), icon: moss_avatar(main_room.value).src },
  { key: "private", kind: "private", room: private_room.value, name: t("私聊"), icon: "i-lucide-message-circle",
    muted: channel_bound.value === false, note: channel_bound.value === false ? t("还没有绑定聊天渠道") : !private_room.value ? t("还没有消息") : "" },
  // A group being turned on shows at once, ahead of the others, until its window's room arrives (UI first, #16110).
  ...[...joining.entries()].filter(([key]) => !groups.value.some(({ room }) => moss_window_key(room) === key))
    .map(([key, item]) => ({ key: `joining:${key}`, kind: "group", room: null, name: item.title, icon: "i-lucide-users", note: t("正在开启…"),
      usage: t("今天 {used}/{limit}", { used: 0, limit: item.limit }) })),
  ...groups.value.map(({ room, state }) => ({ key: room.id, kind: "group", room, name: room.title || room.window?.chat_id || room.id, icon: "i-lucide-users",
    usage: t("今天 {used}/{limit}", { used: state?.used_today ?? 0, limit: state?.daily_limit ?? DEFAULT_DAILY_LIMIT }), waiting: Boolean(state?.pending_owner) })),
]);

// 私聊 without a room yet: say why and, with no channel bound, where to bind one.
const private_help = ref(false);
function choose(card) {
  if (card.room) { if (card.room.id !== view.value.room?.id) emit("open-room", card.room.id); }
  else if (card.kind === "main") bridge.open_steward();
  else if (card.kind === "private") private_help.value = true;
}
// "加入群" (#16110): pick a group and its settings in a dialog, then turn it on here. The card shows at once; once the
// computer has made the group's window, it opens; a refusal takes the card away and says why.
const add_open = ref(false);
const joining = reactive(new Map());
async function join({ channel, group, settings, introduce }) {
  const key = `${channel}:${group.id}`;
  if (joining.has(key)) return;
  joining.set(key, { title: group.title || group.id, limit: settings.daily_limit ?? DEFAULT_DAILY_LIMIT });
  try {
    const result = await bridge.local_request("notify", { action: "group-enable", channel, chat_id: group.id,
      ...(Object.keys(settings).length ? { settings } : {}), ...(introduce ? { introduce: true } : {}) });
    const room_id = result?.room_id || result?.group?.room;
    await load_local();
    if (room_id) await bridge.show_steward_room(room_id);
  } catch (error) { bridge.notify("error", t("没能让 MOSS 进入「{name}」：{error}", { name: group.title || group.id, error: error.message })); }
  finally { joining.delete(key); }
}
</script>

<template>
  <nav class="moss-windows" :class="{ 'is-drawer': drawer }" :aria-label="t('MOSS 的窗口')">
    <header v-if="!drawer" class="moss-windows-head"><strong>{{ t("窗口") }}</strong></header>
    <ul class="moss-windows-list">
      <li v-for="card in cards" :key="card.key">
        <button type="button" class="moss-window-card" :class="{ 'is-current': card.room && card.room.id === view.room?.id, 'is-muted': card.muted }"
          :aria-current="card.room && card.room.id === view.room?.id ? 'page' : undefined" @click="choose(card)">
          <span class="moss-window-card-icon"><img v-if="card.kind === 'main'" :src="card.icon" alt="" /><UIcon v-else :name="card.icon" /></span>
          <span class="moss-window-card-body">
            <span class="moss-window-card-top"><strong :title="card.name">{{ card.name }}</strong><time>{{ time_of(card.room) }}</time></span>
            <span class="moss-window-card-excerpt" :title="excerpts[card.room?.id]?.text">{{ card.note || excerpts[card.room?.id]?.text || "" }}</span>
            <span class="moss-window-card-foot">
              <span class="moss-window-card-state" :data-kind="state_of(card.room).kind"><span class="pb-dot"></span>{{ state_of(card.room).label }}</span>
              <span v-if="card.waiting" class="moss-window-card-waiting">{{ t("在等你答复") }}</span>
              <span v-if="card.kind === 'group'" class="moss-window-card-usage">{{ card.usage }}</span>
            </span>
          </span>
        </button>
      </li>
      <li class="moss-windows-add"><button type="button" class="moss-window-add" @click="add_open = true"><UIcon name="i-lucide-plus" />{{ t("加入群") }}</button></li>
    </ul>
    <MossJoinGroup v-model:open="add_open" @confirm="join" @notify-settings="emit('notify-settings')" />
    <UModal v-model:open="private_help" :title="t('私聊')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <div class="moss-private-help">
          <p>{{ t("你在微信、QQ 等聊天渠道里私聊 MOSS 的消息，都汇到这个窗口；它和主理人的对话、记忆互不相通。") }}</p>
          <p v-if="channel_bound === false">{{ t("还没有绑定聊天渠道。在“设置 → 通知”里绑定后，就能在手机上私聊 MOSS。") }}</p>
          <p v-else>{{ t("在已绑定的聊天渠道里给 MOSS 发一条消息，私聊记录就会出现在这里。") }}</p>
          <UButton v-if="channel_bound === false" :label="t('去绑定聊天渠道')" icon="i-lucide-settings" @click="private_help = false; emit('notify-settings')" />
        </div>
      </template>
    </UModal>
  </nav>
</template>

<style scoped>
.moss-windows { display: flex; flex-direction: column; min-height: 0; height: 100%; }
/* As tall as the page's top bar, the heading on the same line as the page title. */
.moss-windows-head { display: flex; align-items: flex-start; flex-shrink: 0; height: var(--channel-topbar-height, 56px); padding: 17px 16px 0; border-bottom: 1px solid var(--channel-edge-panel, var(--ui-border-muted)); }
.moss-windows-head > strong { color: var(--ui-text-highlighted); font-size: 14px; }
.moss-windows-list { display: grid; align-content: start; gap: 4px; flex: 1; min-height: 0; margin: 0; padding: 8px; overflow-y: auto; list-style: none; }
.moss-windows.is-drawer .moss-windows-list { padding: 4px 0 8px; overflow: visible; }
/* Every card the same height whatever it carries: three fixed lines, the missing ones left blank (§12.2). */
.moss-window-card { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; width: 100%; height: 74px; padding: 9px 10px; border-radius: 10px; text-align: left; transition: background .12s; }
@media (hover: hover) { .moss-window-card:hover { background: color-mix(in srgb, var(--ui-bg-accented) 55%, transparent); } }
.moss-window-card.is-current { background: color-mix(in srgb, var(--ui-bg-accented) 85%, transparent); }
.moss-window-card.is-muted { opacity: .55; }
.moss-window-card-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: color-mix(in srgb, var(--ui-text) 7%, transparent); color: var(--ui-text-muted); }
.moss-window-card-icon > img { width: 24px; height: 24px; object-fit: contain; }
.moss-window-card-icon > :deep(svg) { width: 15px; height: 15px; }
.moss-window-card-body { display: grid; grid-template-rows: 20px 18px 18px; min-width: 0; }
.moss-window-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.moss-window-card-top > strong { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.moss-window-card-top > time { flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.moss-window-card-excerpt { min-width: 0; overflow: hidden; color: var(--ui-text-muted); font-size: 12px; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.moss-window-card-foot { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-dimmed); font-size: 11px; white-space: nowrap; }
.moss-window-card-state { display: inline-flex; align-items: center; gap: 5px; }
.moss-window-card-state[data-kind="running"] { color: var(--channel-accent, var(--ui-primary)); }
.moss-window-card-state:is([data-kind="awaiting"], [data-kind="waiting_user"]) { color: var(--ui-warning); }
.moss-window-card-state[data-kind="failed"] { color: var(--ui-error); }
.moss-window-card-state > .pb-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
/* Only while a question waits (#16043); the usage keeps its place at the end of the line either way. */
.moss-window-card-waiting { min-width: 0; overflow: hidden; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--ui-warning) 16%, transparent); color: var(--ui-warning); text-overflow: ellipsis; }
.moss-window-card-usage { flex-shrink: 0; margin-left: auto; font-variant-numeric: tabular-nums; }
.moss-window-add { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; height: 40px; border: 1px dashed var(--ui-border); border-radius: 10px; color: var(--ui-text-muted); font-size: 13px; }
@media (hover: hover) { .moss-window-add:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); } }
.moss-private-help { display: grid; gap: 10px; color: var(--ui-text-toned); font-size: 14px; line-height: 1.6; }
.moss-private-help > p { margin: 0; }
.moss-private-help > button { justify-self: start; }
</style>

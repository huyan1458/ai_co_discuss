<script setup>
/**
 * The room event log: a simplified trajectory. The website writes every room state change (messages, requests and the
 * message each hangs under, executions, batches, queue, scheduler choices) to an append-only log; this page lists it in
 * order, split into turns at each user message. Selecting a row opens an inspector with the raw record, what was open at
 * that moment (replayed from the log) and the other records about the same request, execution or message. It does not
 * look inside the AI software: the execution waterfall shows phases. Owner only.
 */
import { computed, inject, ref, watch } from "vue";
import { EVENT_GROUPS, EXECUTION_STATUS, PURPOSES, REQUEST_STATUS, event_entities, event_text, state_at } from "./timeline-model.js";

const emit = defineEmits(["detail"]);
const { view, bridge } = inject("discussion");
const room_id = computed(() => view.value.room?.id);
const events = ref([]);
const members = ref({});
const more = ref(false);
const error = ref("");
const selected = ref(null);
const filter = ref("");
let reading = false;

// Paging cursors are event ids; rows are shown by arrival time (`at`), since a write is stored after its effects.
const cursor = { first: 0, last: 0 };
const by_time = (left, right) => left.at - right.at || left.id - right.id;

/** Read the newest page, or older (`before`) or newer (`after`) records, and merge them in time order. */
async function load(mode = "reset") {
  const id = room_id.value;
  if (!id || reading) return;
  const list = events.value;
  const query = mode === "older" && list.length ? `?before=${cursor.first}` : mode === "newer" && list.length ? `?after=${cursor.last}` : "";
  reading = true;
  try {
    const result = await bridge.request(`/api/rooms/${id}/events${query}`);
    if (id !== room_id.value) return;
    // Every room change asks for newer records; when there are none, keep the lists so the rows are not rebuilt.
    if (mode === "newer" && !result.events.length) { error.value = ""; return; }
    members.value = result.members;
    if (mode === "reset" || !list.length) Object.assign(cursor, { first: result.first_id, last: result.last_id });
    else if (mode === "older") cursor.first = result.first_id || cursor.first;
    else cursor.last = Math.max(cursor.last, result.last_id);
    if (mode !== "newer") more.value = result.more;
    events.value = mode === "reset" ? result.events : [...list, ...result.events].sort(by_time);
    error.value = "";
  } catch (failure) {
    error.value = `读取事件记录失败：${failure.message}`;
  } finally {
    reading = false;
  }
}
watch(room_id, () => { events.value = []; selected.value = null; filter.value = ""; load(); }, { immediate: true });
// Every room change shows in the room view, so read what is new then instead of polling.
watch(() => view.value.room, (room, previous) => { if (room?.id && room.id === previous?.id && events.value.length) load("newer"); });

const name = (id) => (id && members.value[String(id)] ? bridge.display_name(members.value[String(id)]) : id ? `成员 ${id}` : "");
const clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false }) + `.${String(ms % 1000).padStart(3, "0")}`;
const entity_label = (key) => {
  const [kind, id] = key.split(":");
  return kind === "request" ? `请求 R${id}` : kind === "execution" ? `执行 E${id}` : `#${id}`;
};

const user_message = (event) => event?.kind === "message.posted" && event.data.source === "user";
const message_write = (event) => event?.kind === "api.write" && event.data.path === "/messages";

/**
 * Rows to show: each with its index into `events` (for replay) and a turn boundary before every user message — before
 * the write that sent it when that write is logged, so a turn starts with the user's input.
 */
const rows = computed(() => {
  let turn = 0;
  const list = events.value;
  return list.flatMap((event, index) => {
    const boundary = (message_write(event) && user_message(list[index + 1])) || (user_message(event) && !message_write(list[index - 1]));
    if (boundary) turn += 1;
    if (filter.value && !event_entities(event).includes(filter.value)) return [];
    const group = event.kind.split(".")[0];
    return [{ event, index, boundary: boundary && !filter.value, turn, group, label: EVENT_GROUPS[group] || group, text: event_text(event, name) }];
  });
});
const selected_index = computed(() => events.value.findIndex((event) => event.id === selected.value));
const selected_event = computed(() => events.value[selected_index.value]);
const snapshot = computed(() => (selected_event.value ? state_at(events.value, selected_index.value) : null));
const related = computed(() => {
  if (!selected_event.value) return [];
  const keys = new Set(event_entities(selected_event.value));
  return keys.size ? rows.value.filter((row) => row.event.id !== selected.value && event_entities(row.event).some((key) => keys.has(key))) : [];
});

function select(row) { selected.value = selected.value === row.event.id ? null : row.event.id; }
/** Step the inspector to the previous or next shown row, so a moment can be replayed record by record. */
function step(offset) {
  const position = rows.value.findIndex((row) => row.event.id === selected.value) + offset;
  if (rows.value[position]) selected.value = rows.value[position].event.id;
}
function on_key(event) {
  if (!selected.value || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  step(event.key === "ArrowUp" ? -1 : 1);
}
</script>

<template>
  <section class="merged-section event-log" aria-label="事件记录" @keydown="on_key">
    <div class="page-heading"><div><h2>事件记录</h2><p>网站如实记下的用户与程序的每次写入（含被拒的）及其引起的状态变化，按发生顺序排列；点一行看原始记录、此刻仍未结束的请求与执行，以及同一对象的其他记录。AI 可用 <code>codiscuss room events</code> 读取同一份记录。</p></div></div>
    <p v-if="error" role="alert" class="fine-print ev-error">{{ error }}</p>
    <p v-else-if="!events.length" class="fine-print">还没有事件记录。此功能上线前的历史没有记录。</p>
    <div v-if="events.length" class="ev" :class="{ 'has-inspector': selected_event }">
      <div class="ev-ledger">
        <header class="ev-head">
          <span class="ev-title">{{ rows.length }} 条记录</span>
          <button v-if="filter" type="button" class="ev-chip is-active" @click="filter = ''">只看 {{ entity_label(filter) }} ✕</button>
          <button v-if="more && !filter" type="button" class="subtle-link" @click="load('older')">加载更早</button>
        </header>
        <ol class="ev-rows" role="listbox" aria-label="事件">
          <template v-for="row in rows" :key="row.event.id">
            <li v-if="row.boundary" class="ev-turn" aria-hidden="true">第 {{ row.turn }} 轮</li>
            <li role="option" tabindex="0" class="ev-row" :class="[`is-${row.group}`, { 'is-rejected': row.event.kind === 'api.rejected', 'is-selected': row.event.id === selected, 'is-after': selected_event && row.index > selected_index }]"
              :aria-selected="row.event.id === selected" @click="select(row)" @keydown.enter="select(row)">
              <time class="ev-time">{{ clock(row.event.at) }}</time>
              <span class="ev-tag">{{ row.label }}</span>
              <span class="ev-text">{{ row.text }}</span>
            </li>
          </template>
        </ol>
      </div>
      <aside v-if="selected_event" class="ev-inspector" aria-label="记录详情">
        <header class="ev-head">
          <span class="ev-title">{{ clock(selected_event.at) }} · {{ selected_event.kind }}</span>
          <span class="ev-actions">
            <button type="button" class="ev-icon" aria-label="上一条" @click="step(-1)">↑</button>
            <button type="button" class="ev-icon" aria-label="下一条" @click="step(1)">↓</button>
            <button type="button" class="ev-icon" aria-label="关闭" @click="selected = null">✕</button>
          </span>
        </header>
        <div v-keep-reading class="ev-body">
          <p class="ev-line">{{ event_text(selected_event, name) }}</p>
          <div class="ev-chips">
            <template v-for="key in event_entities(selected_event)" :key="key">
              <button type="button" class="ev-chip" :class="{ 'is-active': filter === key }" @click="filter = filter === key ? '' : key">只看 {{ entity_label(key) }}</button>
              <button v-if="key.startsWith('message:')" type="button" class="subtle-link" @click="emit('detail', Number(key.split(':')[1]))">查看 {{ entity_label(key) }}</button>
            </template>
          </div>
          <h3>此刻未结束的</h3>
          <ul class="ev-state">
            <li v-for="item in snapshot.requests" :key="`r${item.request_id}`">请求 R{{ item.request_id }} → {{ name(item.member_id) }} · {{ PURPOSES[item.purpose] || item.purpose }} · 挂在 #{{ item.message_id }} · {{ REQUEST_STATUS[item.status] || item.status }}<template v-if="item.execution_id"> · 执行 E{{ item.execution_id }}</template></li>
            <li v-for="item in snapshot.executions" :key="`e${item.execution_id}`">执行 E{{ item.execution_id }} · {{ name(item.member_id) }} · {{ EXECUTION_STATUS[item.status] || item.status }} · 已过 {{ Math.round((selected_event.at - item.at) / 1000) }} 秒</li>
            <li v-for="item in snapshot.queue" :key="`q${item.queue_id}`">{{ name(item.member_id) }} 排队等候 #{{ item.message_id }}</li>
            <li v-for="item in snapshot.chains" :key="`c${item.chain_id}`">任务链 #{{ item.chain_id }} 到限暂停</li>
            <li v-if="!snapshot.requests.length && !snapshot.executions.length && !snapshot.queue.length && !snapshot.chains.length" class="fine-print">无（只计已加载的记录）</li>
          </ul>
          <template v-if="related.length">
            <h3>同一对象的其他记录</h3>
            <ul class="ev-related">
              <li v-for="row in related" :key="row.event.id"><button type="button" class="ev-link" @click="selected = row.event.id"><time class="ev-time">{{ clock(row.event.at) }}</time> {{ row.text }}</button></li>
            </ul>
          </template>
          <h3>原始记录</h3>
          <pre class="ev-raw">{{ JSON.stringify({ id: selected_event.id, kind: selected_event.kind, at: selected_event.at, data: selected_event.data }, null, 2) }}</pre>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
:global(html[data-theme^="channel"] .content-page > .event-log) { max-width: 1280px; }
.ev {
  --ev-border: var(--ui-border-muted);
  --ev-muted: var(--ui-text-muted);
  --ev-mono: ui-monospace, SFMono-Regular, Consolas, monospace;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin-top: 4px; font-size: 13px; line-height: 20px;
}
.ev.has-inspector { grid-template-columns: minmax(0, 1fr) minmax(280px, 420px); }
.ev-ledger, .ev-inspector { min-width: 0; border: 1px solid var(--ev-border); border-radius: 10px; background: var(--ui-bg-muted); }
.ev-inspector { position: sticky; top: 8px; align-self: start; max-height: calc(100vh - 160px); display: flex; flex-direction: column; }
.ev-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px; border-bottom: 1px solid var(--ev-border); }
.ev-title { font-weight: 600; font-family: var(--ev-mono); font-size: 12px; }
.ev-actions { display: inline-flex; gap: 4px; margin-left: auto; }
.ev-icon { width: 24px; height: 24px; border-radius: 6px; color: var(--ev-muted); }
.ev-icon:hover { background: var(--channel-ghost-hover, color-mix(in oklab, var(--ui-text) 6%, transparent)); color: var(--ui-text); }
.ev-error { color: var(--ui-error); }
.ev-rows { margin: 0; padding: 4px 0; list-style: none; }
.ev-turn { margin: 6px 14px 2px; padding-top: 6px; border-top: 2px solid var(--ev-border); color: var(--ev-muted); font-size: 11px; font-family: var(--ev-mono); }
.ev-row { display: grid; grid-template-columns: 92px 40px minmax(0, 1fr); align-items: baseline; gap: 8px; padding: 2px 14px; cursor: pointer; }
.ev-row:hover { background: var(--channel-ghost-hover, color-mix(in oklab, var(--ui-text) 4%, transparent)); }
.ev-row:focus-visible { outline: 2px solid var(--channel-accent); outline-offset: -2px; }
.ev-row.is-selected { background: color-mix(in oklab, var(--channel-accent) 16%, transparent); }
.ev-row.is-after { opacity: .45; }
.ev-time { color: var(--ev-muted); font-family: var(--ev-mono); font-size: 11px; }
.ev-tag { justify-self: start; padding: 0 5px; border-radius: 4px; background: color-mix(in oklab, var(--ev-hue) 18%, transparent); color: var(--ev-hue); font-size: 11px; white-space: nowrap; }
.ev-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Group hues share one lightness and avoid green, amber and red, which stay for done, warning and failure. */
.ev-row { --ev-hue: var(--ev-muted); }
.ev-row.is-message { --ev-hue: light-dark(oklch(0.55 0.11 255), oklch(0.72 0.11 255)); }
.ev-row.is-api { --ev-hue: light-dark(oklch(0.50 0.02 255), oklch(0.78 0.02 255)); }
.ev-row.is-rejected { --ev-hue: var(--ui-error); }
.ev-row.is-rejected .ev-text { color: var(--ui-error); }
.ev-row.is-request { --ev-hue: light-dark(oklch(0.55 0.11 300), oklch(0.72 0.11 300)); }
.ev-row.is-execution { --ev-hue: light-dark(oklch(0.55 0.11 215), oklch(0.72 0.11 215)); }
.ev-row.is-batch, .ev-row.is-queue, .ev-row.is-chain { --ev-hue: light-dark(oklch(0.55 0.11 335), oklch(0.72 0.11 335)); }
.ev-body { overflow: auto; padding: 10px 14px 14px; }
.ev-body h3 { margin: 14px 0 4px; color: var(--ev-muted); font-size: 12px; font-weight: 600; }
.ev-line { margin: 0; word-break: break-word; }
.ev-chips { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; }
.ev-chip { padding: 0 8px; border: 1px solid var(--ev-border); border-radius: 999px; font-size: 12px; }
.ev-chip.is-active { border-color: var(--channel-accent); color: var(--channel-accent); }
.ev-state, .ev-related { margin: 0; padding-left: 16px; }
.ev-related { padding-left: 0; list-style: none; }
.ev-link { text-align: left; }
.ev-link:hover { text-decoration: underline; }
.ev-raw { margin: 0; padding: 8px; overflow: auto; border-radius: 6px; background: color-mix(in oklab, var(--ui-text) 5%, transparent); font-family: var(--ev-mono); font-size: 11px; line-height: 16px; }
@media (hover: none) { .ev-row { padding-block: 6px; } }
@media (max-width: 640px) { .ev-row { grid-template-columns: max-content 32px minmax(0, 1fr); } .ev.has-inspector { grid-template-columns: minmax(0, 1fr); } }
</style>

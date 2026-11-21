<script setup>
/**
 * The middle of an invited room: the other room's chat, read only, as far as this member may read it there, laid out
 * like a room's own transcript (day dividers, avatar and byline, Markdown text): it opens on the latest messages and
 * reads earlier pages as the reader scrolls up. A request to this AI carries what became of it on this computer
 * (`invited_items`: woken, refused, timed out, failed…); a run or wait whose texts are not among the messages (cannot be
 * read, or the room is out of reach) is a card at its time. An ended record keeps all of this readable.
 */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { PENDING_JOIN_ID, invited_items, runner_message, use_invited_rooms, time_ms } from "./external-members.js";
import { locale, t } from "./i18n.js";

const { bridge } = inject("discussion");
const invited = use_invited_rooms();
const record = invited.selected;
const messages = ref([]), roster = ref([]), error = ref(""), loading = ref(false), failure = ref("");
// Whether the other room has messages before the first one shown, and whether they are being read.
const earlier = ref(false), loading_older = ref(false);
const REFRESH_MS = 5000;
const AI_ICON = "/icons/external-expert.svg";
// A single missed read is retried on the next pass; the notice appears only when the next one misses too.
const OFFLINE_AFTER_MISSES = 2;
// Within this distance of the top the next earlier page is read; within this distance of the end new messages follow.
const LOAD_OLDER_PX = 240, NEAR_BOTTOM_PX = 80;
const misses = ref(0), reached = ref(false);
const OUTCOMES = {
  waiting: [t("等你同意"), "warning"], running: [t("处理中"), "info"], answered: [t("已回答"), "success"],
  finished: [t("已结束，未回答"), "neutral"], failed: [t("失败"), "error"], refused: [t("你未同意"), "neutral"],
  timeout: [t("超时未确认"), "neutral"], limit: [t("已达借用上限，改为等你同意"), "warning"],
  lockdown_unsupported: [t("这个软件不能限制为只用共议命令，未启动"), "error"], ai_unavailable: [t("这台电脑没有可用的 AI 程序，未启动"), "error"],
  ended: [t("成员资格已结束"), "neutral"],
};
// The record being read: a read crosses the relay and can outlast the refresh, so the next one waits for it to finish.
let reading = "";
let record_serial = 0;
/**
 * Several records of this computer can sit in the same room (one per AI it lent), so what was read of the room is kept by
 * the room, not the record: switching between them shows the same latest messages; only each AI's own outcomes differ.
 */
function room_key(id) {
  const found = invited.records.value.find((item) => item.id === id);
  return found ? `${found.site}|${found.room}` : id;
}
function show_messages(id, list) {
  messages.value = list;
  invited.room_messages.set(room_key(id), list);
}
/** The latest page replaces what it covers; earlier pages the reader already scrolled to stay above it. */
function merge_latest(list) {
  const first = list[0]?.id;
  if (first === undefined) return messages.value;
  return [...messages.value.filter((message) => !message.kept && message.id < first), ...list];
}
async function load() {
  const id = invited.selected_id.value;
  // Opened on a join still under way: the skeleton stays until the record arrives and the page moves on to it.
  if (!id || id === PENDING_JOIN_ID || reading === id) return;
  reading = id;
  try {
    const result = await invited.read_room(id);
    if (invited.selected_id.value !== id) return;
    const older_shown = messages.value.some((message) => !message.kept && result.messages?.length && message.id < result.messages[0].id);
    // The top-level `messages`: the other room's, or the texts this computer kept when it cannot be reached. During an
    // outage what is already shown stays rather than giving way to the kept texts.
    if (!result.error) {
      show_messages(id, merge_latest(result.messages || []));
      if (!older_shown) earlier.value = Boolean(result.earlier);
    } else if (!messages.value.length && result.messages?.length) show_messages(id, result.messages);
    if (result.room?.me) invited.room_me.value = { ...invited.room_me.value, [id]: result.room.me };
    if (Array.isArray(result.room?.members)) { roster.value = result.room.members; invited.room_roster.set(room_key(id), result.room.members); }
    error.value = runner_message(result.error_text, result.error || "");
    misses.value = result.error ? misses.value + 1 : 0;
    if (!result.error) reached.value = true;
    failure.value = "";
  } catch (problem) { if (invited.selected_id.value === id) failure.value = runner_message(null, problem.message); }
  finally {
    if (reading === id) reading = "";
    if (invited.selected_id.value === id) loading.value = false;
  }
}
/** Read the page before the first message shown and put it above, keeping what the reader looks at in place. */
async function load_older() {
  const id = invited.selected_id.value, first = messages.value[0];
  if (!earlier.value || loading_older.value || !first || first.kept) return;
  const serial = record_serial;
  loading_older.value = true;
  try {
    const result = await invited.read_room(id, { before: first.id });
    if (serial !== record_serial || invited.selected_id.value !== id || result.error) return;
    const known = new Set(messages.value.map((message) => message.id));
    const element = page.value, from_bottom = element ? element.scrollHeight - element.scrollTop : 0;
    show_messages(id, [...(result.messages || []).filter((message) => !known.has(message.id)), ...messages.value]);
    earlier.value = Boolean(result.earlier);
    await nextTick();
    if (serial === record_serial && element) element.scrollTop = element.scrollHeight - from_bottom;
  } catch { /* The next scroll to the top tries again. */ }
  finally { if (serial === record_serial) loading_older.value = false; }
}
/** Open a record: what is already known shows at once, and the other room is read behind it. */
function open_record(id) {
  record_serial++;
  loading_older.value = false;
  messages.value = invited.room_messages.get(room_key(id)) || [];
  roster.value = invited.room_roster.get(room_key(id)) || [];
  error.value = failure.value = "";
  misses.value = 0;
  reached.value = false;
  earlier.value = false;
  loading.value = Boolean(id) && !messages.value.length;
  if (id && id !== PENDING_JOIN_ID && !messages.value.length) {
    invited.read_room(id, { cached: true }).then((kept) => {
      if (invited.selected_id.value === id && !messages.value.length && kept.messages?.length) messages.value = kept.messages;
    }).catch(() => {});
  }
  load();
}
watch(() => invited.selected_id.value, open_record, { immediate: true });
const timer = setInterval(() => { if (!record.value?.status || record.value.status === "active") load(); }, REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

// An ended record shows the room as it was when it ended: later messages, read for another record of this computer in
// the same room (they share what was read), are not its own (user 2026-11-20, #5826).
const ended_at = computed(() => {
  if (!record.value?.status || record.value.status === "active") return 0;
  const noted = time_ms((record.value.history || []).findLast((entry) => ["ended", "left"].includes(entry.outcome))?.at || 0);
  // This computer may learn of an expiry only later; the lending had ended at its own end.
  const lapsed = record.value.end_reason === "expired" ? time_ms(record.value.expires_at) : 0;
  return lapsed && noted ? Math.min(lapsed, noted) : lapsed || noted;
});
const shown_messages = computed(() => ended_at.value
  ? messages.value.filter((message) => !message.created_at || time_ms(message.created_at) <= ended_at.value) : messages.value);
const items = computed(() => invited_items(record.value, shown_messages.value));
/**
 * The chat, oldest first: each message once, the latest shown request of each item carrying it (next to the answer),
 * every request to this AI marked, and each item none of whose messages is shown placed by its time (one older than
 * the first message shown waits until the reader scrolls up to its place).
 */
const timeline = computed(() => {
  const shown = new Set(shown_messages.value.map((message) => message.id));
  const owner = new Map(), asked = new Set(), loose = [];
  for (const item of [...items.value].reverse()) {
    const ids = item.message_ids.filter((id) => shown.has(id));
    ids.forEach((id) => asked.add(id));
    const last = ids.at(-1);
    if (last !== undefined && !owner.has(last)) owner.set(last, item);
    else if (last === undefined && !item.answers.some((answer) => shown.has(answer.id))) loose.push({ key: item.key, at: time_ms(item.at), item });
  }
  const entries = shown_messages.value.map((message) => ({ key: `m${message.id}`, at: message.created_at ? time_ms(message.created_at) : 0, message,
    item: owner.get(message.id) || null, asked: asked.has(message.id) }));
  const start = entries.find((entry) => entry.at)?.at || 0;
  for (const entry of loose.sort((a, b) => a.at - b.at)) {
    if (earlier.value && entry.at < start) continue;
    const index = entries.findIndex((other) => other.message && other.at > entry.at);
    entries.splice(index < 0 ? entries.length : index, 0, entry);
  }
  return entries;
});
const day_formatter = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", weekday: "long" });
/** Split the chat at local calendar days, as a room's transcript does; an entry without a time stays in the day above it. */
const days = computed(() => {
  const groups = [];
  for (const entry of timeline.value) {
    if (!entry.at && groups.length) { groups.at(-1).entries.push(entry); continue; }
    const date = new Date(entry.at), key = date.toLocaleDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, label: entry.at ? day_formatter.format(date) : "", entries: [] });
    groups.at(-1).entries.push(entry);
  }
  return groups;
});
// A chat reads from the bottom: opening a record lands on the latest, and new messages follow while the reader is there.
const page = ref(null);
let landed = "";
watch(() => timeline.value.at(-1)?.key, async () => {
  const element = page.value;
  if (!element || loading_older.value) return;
  const id = invited.selected_id.value;
  const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
  if (landed === id && !near) return;
  await nextTick();
  element.scrollTop = element.scrollHeight;
  if (timeline.value.length) landed = id;
}, { flush: "pre" });
function on_scroll() {
  if (page.value && page.value.scrollTop < LOAD_OLDER_PX && landed === invited.selected_id.value) load_older();
}
const ai_name = computed(() => record.value?.member_label || record.value?.member || t("你的 AI"));
const active = computed(() => !record.value?.status || record.value.status === "active");
const offline = computed(() => active.value && Boolean(error.value) && misses.value >= OFFLINE_AFTER_MISSES);
// Until a read has answered, a text not shown yet is still on its way rather than gone.
const read_settled = computed(() => reached.value || misses.value >= OFFLINE_AFTER_MISSES || !active.value);
const full_date = (value) => value ? new Date(time_ms(value)).toLocaleString(locale, { hour12: false }) : "";
const short_date = (value) => value ? new Date(time_ms(value)).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const outcome_of = (item) => OUTCOMES[item.outcome] || [item.outcome || "", "neutral"];
const BY = { user: t("对方房主"), host: t("对方主持人") };
// The other room's owner writes as "用户" there; here that reads as its owner, in the page language.
const OWNER_AUTHOR = "用户";
const author = (message) => message.author === OWNER_AUTHOR ? BY.user : message.author_label || message.author;
const mine = (message) => message.author === record.value?.member;
/**
 * Avatar and accent as the other room shows that author: this AI with the external mark, another external member by the
 * vendor its computer reported, the other room's own members by their software. Never this computer's identities by name:
 * a room here may have a member of the same name (Custom-ext) that runs other software.
 */
function identity(message) {
  if (mine(message)) return { icon: AI_ICON, style: "external" };
  if (message.author === OWNER_AUTHOR) return bridge.identities[OWNER_AUTHOR] || {};
  const member = roster.value.find((item) => item.name === message.author);
  if (member?.external) return (member.platform && member.platform !== "Custom" && bridge.platform_identity(member.platform)) || { icon: AI_ICON, style: "external" };
  return bridge.platform_identity(bridge.platform_of(message.author)) || {};
}
// This AI is called by the label the other room gave it, as everyone there reads it.
const speaker = (message) => mine(message) ? message.author_label || ai_name.value : author(message);
/**
 * Who a card speaks for: the people who asked when their messages are known, who named the AI while it waits, else
 * the AI itself, since what is left (a run that failed, a refusal by the software) is this computer's own result.
 */
function heading(item) {
  if (item.requests.length) return [...new Set(item.requests.map(author))].join(t("、"));
  if (item.by) return BY[item.by] || t("对方");
  return item.message_ids.length ? item.message_ids.map((id) => `#${id}`).join(" ") : ai_name.value;
}
const from_person = (item) => Boolean(item.requests.length || item.by || item.message_ids.length);
/** The room's own reason styles: a coloured rule for what went wrong, a quiet one for everything else. */
function reason_class(item) {
  const tone = outcome_of(item)[1];
  if (tone === "error") return "channel-failure-reason";
  return tone === "warning" ? "channel-failure-reason is-warning" : "channel-stop-reason";
}
</script>

<template>
  <div ref="page" v-keep-reading class="content-page invited-page" role="region" :aria-label="t('外部房间')" @scroll.passive="on_scroll">
    <div v-if="offline" class="invited-lead">
      <div class="invited-notice" role="status" :title="error">
        <UIcon name="i-lucide-cloud-off" />
        <div>
          <strong>{{ t("暂时读不到对方房间") }}</strong>
          <p>{{ timeline.length ? t("正在自动重试，下面是这台电脑记下的处理结果。") : t("正在自动重试。") }}</p>
        </div>
      </div>
    </div>
    <div v-if="loading && !timeline.length" class="invited-lead" role="status"><USkeleton v-for="row in 3" :key="row" class="invited-skeleton" /></div>
    <div v-else-if="failure" class="invited-lead">
      <div class="invited-notice is-error" role="alert">
        <UIcon name="i-lucide-circle-alert" />
        <div><p>{{ failure }}</p></div>
        <UButton :label="t('重试')" size="xs" color="neutral" variant="outline" @click="load" />
      </div>
    </div>
    <div v-else-if="!timeline.length" class="invited-empty">
      <span class="invited-empty-icon"><UIcon name="i-lucide-message-square" /></span>
      <h2>{{ t("对方房间还没有消息。") }}</h2>
      <p>{{ t("有人发言或点名你的 AI 后，会显示在这里。") }}</p>
    </div>
    <template v-else>
      <div class="invited-lead">
        <p v-if="loading_older" class="invited-scope" role="status">{{ t("正在读取更早的消息…") }}</p>
        <p v-else-if="!earlier" class="invited-scope">{{ t("对方房间的聊天记录，只读；你只能管理自己的 AI") }}</p>
      </div>
      <div v-for="day in days" :key="day.key" class="channel-message-group">
        <USeparator v-if="day.label" :label="day.label" class="channel-date-divider" />
        <template v-for="entry in day.entries" :key="entry.key">
          <UChatMessage v-if="entry.message" :id="`invited-message-${entry.message.id}`" :data-author="identity(entry.message).style" :role="entry.message.author === OWNER_AUTHOR ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :class="{ 'is-asked': entry.asked || mine(entry.message) }" :ui="{ header: 'channel-message-header', container: 'channel-message-container', body: 'channel-message-body' }">
            <template #body>
              <div class="channel-message-byline">
                <UAvatar :src="identity(entry.message).icon" :text="identity(entry.message).initials || '?'" :alt="speaker(entry.message)" size="md" class="channel-avatar" :class="identity(entry.message).style" />
                <div class="channel-message-meta">
                  <div class="channel-message-author"><strong>{{ speaker(entry.message) }}</strong><UBadge v-if="entry.item" size="xs" :color="outcome_of(entry.item)[1]" variant="soft" class="channel-source">{{ outcome_of(entry.item)[0] }}</UBadge></div>
                  <div class="channel-message-provenance"><time v-if="entry.message.created_at" :title="full_date(entry.message.created_at)">{{ bridge.format_time(entry.message.created_at) }}</time><span>#{{ entry.message.id }}</span></div>
                </div>
              </div>
              <div class="channel-answer"><div class="channel-message-text markdown-body" v-html="bridge.render_room_markdown(entry.message.text)"></div></div>
              <template v-if="entry.item">
                <p v-if="entry.item.reason" class="channel-message-text invited-reason" :class="reason_class(entry.item)">{{ runner_message(entry.item.reason_text, entry.item.reason) }}</p>
                <!-- Kept only on this computer: the end of what the software printed, to see why it stopped without answering. -->
                <details v-if="entry.item.output && entry.item.outcome !== 'answered'" class="invited-output">
                  <summary>{{ t("这台电脑上的运行输出（末尾）") }}</summary>
                  <pre>{{ entry.item.output }}</pre>
                </details>
              </template>
            </template>
          </UChatMessage>
          <p v-else-if="entry.item.outcome === 'ended'" class="invited-ended" role="status"><UIcon name="i-lucide-circle-slash" />{{ entry.item.reason }}<small v-if="entry.item.at" :title="full_date(entry.item.at)">{{ short_date(entry.item.at) }}</small></p>
          <!-- A run or wait whose texts are not among the messages: what this computer knows of it, at its time. -->
          <div v-else class="invited-item">
            <template v-for="item in [entry.item]" :key="item.key">
              <article class="invited-turn">
                <header class="invited-byline">
                  <UAvatar v-if="from_person(item)" icon="i-lucide-user" :alt="heading(item)" size="sm" class="channel-avatar user invited-avatar" />
                  <span v-else class="channel-avatar external invited-avatar" aria-hidden="true"><img :src="AI_ICON" alt="" /></span>
                  <div class="invited-who">
                    <strong>{{ heading(item) }}</strong>
                    <small><time :title="full_date(item.at)">{{ short_date(item.at) }}</time></small>
                  </div>
                  <UBadge :color="outcome_of(item)[1]" variant="subtle" size="sm" class="invited-outcome">{{ outcome_of(item)[0] }}</UBadge>
                </header>
                <p v-if="item.missing_text && read_settled" class="channel-message-text channel-stop-reason invited-reason">{{ t("正文在对方房间，已无法读取") }}</p>
                <p v-else-if="item.reason" class="channel-message-text invited-reason" :class="reason_class(item)">{{ runner_message(item.reason_text, item.reason) }}</p>
                <details v-if="item.output && item.outcome !== 'answered'" class="invited-output">
                  <summary>{{ t("这台电脑上的运行输出（末尾）") }}</summary>
                  <pre>{{ item.output }}</pre>
                </details>
              </article>
            </template>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The room's own transcript: full-width scroll pane, messages in the reading column (`channel-message-group`). */
.invited-page { display: flex; flex-direction: column; }
:global(html[data-theme^="channel"] .content-page.invited-page) { padding: 16px 0 28px; }
.invited-lead { width: 100%; max-width: var(--channel-reading-width); margin: 0 auto; padding: 0 24px; }
.invited-lead:empty { display: none; }
.invited-scope { margin: 0 0 4px; color: var(--ui-text-dimmed); font-size: 12px; text-align: center; }
.invited-skeleton { height: 112px; margin-bottom: 14px; border-radius: 10px; }
/* A request to this AI, or its own message: a rule in the accent colour at the card's start. */
.channel-message.is-asked { box-shadow: inset 2px 0 0 color-mix(in srgb, var(--ui-primary) 55%, transparent); }

.invited-notice { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 12px; padding: 11px 14px; border: 1px solid color-mix(in srgb, var(--ui-warning) 28%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--ui-warning) 8%, transparent); font-size: 13px; line-height: 1.5; }
.invited-notice > [class*="icon"] { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; color: var(--ui-warning); }
.invited-notice > div { flex: 1; min-width: 0; }
.invited-notice strong { color: var(--ui-text-highlighted); font-weight: 600; }
.invited-notice p { margin: 1px 0 0; color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.invited-notice.is-error { border-color: color-mix(in srgb, var(--ui-error) 28%, transparent); background: color-mix(in srgb, var(--ui-error) 8%, transparent); }
.invited-notice.is-error > [class*="icon"] { color: var(--ui-error); }

.invited-empty { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; padding: 40px 16px 72px; text-align: center; }
.invited-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-bottom: 14px; border: 1px solid var(--ui-border-muted); border-radius: 50%; background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.invited-empty-icon > [class*="icon"] { width: 20px; height: 20px; }
.invited-empty h2 { margin: 0; color: var(--ui-text-highlighted); font-size: 15px; font-weight: 600; }
.invited-empty p { margin: 6px 0 0; color: var(--ui-text-muted); font-size: 13px; }

.invited-item { margin: 8px 24px; overflow: hidden; border: 1px solid #ffffff0d; border-radius: 10px; background: #313338; }
:global(:root[data-theme="channel-light"] .invited-item) { border-color: #d6d6d6; border-radius: 8px; background: #fff; }
.invited-turn { padding: 14px 18px; }
.invited-byline { display: flex; align-items: center; gap: 10px; min-height: 28px; margin-bottom: 8px; }
.invited-byline:last-child { margin-bottom: 0; }
.invited-avatar { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; overflow: hidden; }
.invited-who { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.invited-who strong { color: var(--ui-text-highlighted); font-size: 14px; font-weight: 650; overflow-wrap: anywhere; }
.invited-who small { color: var(--ui-text-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.invited-outcome { flex-shrink: 0; }
.invited-reason { margin-top: 8px; font-size: 13px; }
.invited-output { margin-top: 8px; color: var(--ui-text-muted); font-size: 12px; }
.invited-output summary { cursor: pointer; color: var(--ui-text-dimmed); }
.invited-output pre { max-height: 280px; margin: 6px 0 0; padding: 10px 12px; overflow: auto; border-radius: 6px; background: var(--ui-bg-muted); color: var(--ui-text-toned);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.invited-ended { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 24px; padding: 10px 16px; border: 1px dashed var(--ui-border); border-radius: 10px; color: var(--ui-text-toned); font-size: 13px; }
.invited-ended small { margin-left: auto; color: var(--ui-text-dimmed); font-size: 11px; }
@media (max-width: 480px) { .invited-turn { padding: 12px; } .invited-item, .invited-ended { margin-inline: 16px; } }
</style>

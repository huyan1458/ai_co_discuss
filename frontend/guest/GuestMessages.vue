<script setup>
/**
 * The guest's message tab: the room's messages (API.md §3 G/messages), earlier pages on demand, new ones by polling,
 * and the one thing a guest may write: a message naming members, which the guest may withdraw until it is handled.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { render_markdown } from "../markdown.mjs";
import { ENTER_SENDS } from "../enter-sends.js";
import { t } from "../i18n.js";

const props = defineProps({ visit: { type: Object, required: true } });
const POLL_MS = 3000, PAGE = 50, WORKING_LIMIT = 20;
const LIVE = ["dispatched", "started"];
// Members working now (from the executions route), shown under the messages so a guest sees their call was taken.
const working = shallowRef([]);
const items = shallowRef([]);
const has_more = ref(false), loading_earlier = ref(false);
const members = shallowRef([]);
const text = ref("");
// Messages being sent or that failed, shown at the end at once (`{ key, text, mentions, submission_id, failed }`).
const outgoing = ref([]);
const list = ref(null);
const KIND_LABELS = { owner: t("房主"), member: t("成员"), guest: t("外部用户"), system: t("系统") };
let timer = 0, alive = true;

const last_id = () => items.value.at(-1)?.id || 0;
function merge(incoming) {
  const by_id = new Map(items.value.map((item) => [item.id, item]));
  for (const item of incoming) by_id.set(item.id, item);
  items.value = [...by_id.values()].sort((left, right) => left.id - right.id);
}
const near_bottom = () => !list.value || list.value.scrollHeight - list.value.scrollTop - list.value.clientHeight < 80;
async function to_bottom() { await nextTick(); if (list.value) list.value.scrollTop = list.value.scrollHeight; }

async function poll() {
  clearTimeout(timer);
  if (!alive || props.visit.ended()) return;
  try {
    const follow = near_bottom();
    const data = await props.visit.request("GET", "/messages", { query: last_id() ? { after: last_id(), limit: PAGE } : { limit: PAGE } });
    if (!alive || props.visit.ended()) return;
    if (!last_id()) has_more.value = data.has_more;
    merge(data.items || []);
    if (follow && data.items?.length) to_bottom();
    // The guest's own messages that could still be withdrawn are read again, so the button goes once one is taken up.
    const open = items.value.find((item) => item.can_withdraw && !item.withdrawn);
    if (open) {
      const fresh = await props.visit.request("GET", "/messages", { query: { after: open.id - 1, limit: PAGE } });
      if (!alive || props.visit.ended()) return;
      merge(fresh.items || []);
    }
    const runs = await props.visit.request("GET", "/executions", { query: { limit: WORKING_LIMIT } });
    if (alive && !props.visit.ended()) working.value = [...new Set((runs.items || []).filter((item) => LIVE.includes(item.status)).map((item) => item.member_label))];
  } catch { /* Offline is shown by the page; the next poll retries. */ }
  if (alive) timer = setTimeout(poll, POLL_MS);
}
async function load_earlier() {
  if (loading_earlier.value || !items.value.length) return;
  loading_earlier.value = true;
  try {
    const data = await props.visit.request("GET", "/messages", { query: { before: items.value[0].id, limit: PAGE } });
    if (props.visit.ended()) return;
    has_more.value = data.has_more;
    merge(data.items || []);
  } catch { /* Shown by the page. */ } finally { loading_earlier.value = false; }
}
async function read_members() {
  try { const room = await props.visit.request("GET", "/room"); if (alive) members.value = (room.members || []).filter((member) => member.status === "active"); }
  catch { /* The picker stays empty; typing @name still works for the backend's own matching. */ }
}
onMounted(async () => { await Promise.all([poll(), read_members()]); to_bottom(); });
onBeforeUnmount(() => { alive = false; clearTimeout(timer); });

/** Insert "@名称 " at the end of the draft. */
function mention(member) {
  text.value = `${text.value.replace(/\s*$/, text.value ? " " : "")}@${member.label} `;
}
// "@名称" counts at the start or after a space or punctuation, with no further name letters after it, so
// "@Claude，帮我看下" and "@Claude你好" both name Claude (the boundary the page's markdown highlights with).
const mentions_in = (value) => members.value.filter((member) => new RegExp(`(^|[\\s(（，,。；;：:、])@${member.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "u").test(value)).map((member) => member.id);

/** Send one message; a retry of the same entry reuses its submission id, so the computer keeps one copy. */
async function send(entry) {
  entry.failed = false;
  try {
    const data = await props.visit.request("POST", "/messages", { body: { text: entry.text, mentions: entry.mentions, submission_id: entry.submission_id } });
    if (props.visit.ended()) return;
    outgoing.value = outgoing.value.filter((item) => item !== entry);
    if (data?.message) merge([data.message]);
    to_bottom();
  } catch (error) {
    entry.failed = true;
    entry.error = error.code === "invalid_input" ? t("内容不符合要求，未发送") : t("发送失败，可重试");
  }
}
function submit() {
  const value = text.value.trim();
  if (!value) return;
  const entry = { key: crypto.randomUUID(), text: value, mentions: mentions_in(value), submission_id: crypto.randomUUID(), failed: false };
  outgoing.value = [...outgoing.value, entry];
  text.value = "";
  to_bottom();
  send(outgoing.value.at(-1));
}
function on_key(event) {
  // Phones and tablets have no Shift+Enter: there the return key adds a line and only the send button sends.
  if (ENTER_SENDS && event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
}
async function withdraw(message) {
  try {
    const data = await props.visit.request("POST", `/messages/${message.id}/withdraw`, { body: {} });
    if (data?.message) merge([data.message]);
  } catch (error) {
    if (error.code === "guest_not_withdrawable") merge([{ ...message, can_withdraw: false, withdraw_note: t("已开始处理，不能撤回") }]);
  }
}
const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
const handles = computed(() => members.value.map((member) => member.label));
const html = (message) => render_markdown(message.text || "", handles.value);
</script>

<template>
  <div class="guest-messages">
    <div ref="list" class="guest-message-list">
      <button v-if="has_more" type="button" class="guest-earlier" :disabled="loading_earlier" @click="load_earlier">{{ loading_earlier ? t("正在读取…") : t("读取更早的消息") }}</button>
      <p v-if="!items.length && !outgoing.length" class="guest-empty">{{ t("还没有消息。") }}</p>
      <article v-for="message in items" :key="message.id" class="guest-message" :class="`is-${message.author_kind}`">
        <header>
          <strong>{{ message.author_label }}</strong>
          <small>{{ KIND_LABELS[message.author_kind] || "" }} · #{{ message.id }} · {{ time(message.created_at) }}</small>
          <UButton v-if="message.can_withdraw && !message.withdrawn" :label="t('撤回')" size="xs" color="neutral" variant="ghost" @click="withdraw(message)" />
        </header>
        <p v-if="message.withdraw_note && !message.withdrawn" class="guest-withdrawn">{{ message.withdraw_note }}</p>
        <p v-if="message.withdrawn" class="guest-withdrawn">{{ t("已撤回") }}</p>
        <!-- eslint-disable-next-line vue/no-v-html -- markdown rendered with raw HTML disabled (markdown.mjs) -->
        <div v-else class="markdown-body guest-message-body" v-html="html(message)" />
      </article>
      <article v-for="entry in outgoing" :key="entry.key" class="guest-message is-guest is-sending">
        <header><strong>{{ t("我") }}</strong><small>{{ entry.failed ? entry.error : t("发送中…") }}</small>
          <UButton v-if="entry.failed" :label="t('重试')" size="xs" color="neutral" variant="ghost" @click="send(entry)" />
          <UButton v-if="entry.failed" :label="t('放弃')" size="xs" color="neutral" variant="ghost" @click="outgoing = outgoing.filter((item) => item !== entry)" />
        </header>
        <p class="guest-message-plain">{{ entry.text }}</p>
      </article>
      <p v-if="working.length" class="guest-working" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t("{names} 正在处理…", { names: working.join("、") }) }}</p>
    </div>
    <form class="guest-composer" @submit.prevent="submit">
      <div class="guest-mentions" :aria-label="t('点名成员')">
        <button v-for="member in members" :key="member.id" type="button" @click="mention(member)">@{{ member.label }}</button>
      </div>
      <div class="guest-compose-row">
        <UTextarea v-model="text" :rows="2" autoresize :maxrows="8" class="flex-1" :placeholder="t('发消息；@ 成员可直接叫它回答，不点名交给主持人')" @keydown="on_key" />
        <UButton type="submit" icon="i-lucide-send" :aria-label="t('发送')" :disabled="!text.trim()" />
      </div>
    </form>
  </div>
</template>

<style scoped>
.guest-messages { display: flex; flex-direction: column; height: 100%; }
.guest-message-list { display: flex; flex: 1; flex-direction: column; gap: 12px; min-height: 0; padding: 12px 16px; overflow-y: auto; }
.guest-earlier { align-self: center; padding: 4px 10px; border-radius: 6px; color: var(--ui-text-muted); font-size: 12px; }
.guest-earlier:hover { background: var(--ui-bg-elevated); }
.guest-empty { margin: auto; color: var(--ui-text-muted); }
.guest-message { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.guest-message header { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.guest-message header strong { color: var(--ui-text-highlighted); font-size: 13px; }
.guest-message header small { color: var(--ui-text-dimmed); font-size: 11px; }
.guest-message.is-guest { padding: 8px 10px; border-radius: 8px; background: var(--ui-bg-elevated); }
.guest-message.is-sending { opacity: .75; }
.guest-message-body { font-size: 14px; overflow-wrap: anywhere; }
.guest-message-plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.guest-withdrawn { margin: 0; color: var(--ui-text-dimmed); font-style: italic; }
.guest-composer { display: flex; flex-direction: column; gap: 6px; padding: 8px 16px 12px; border-top: 1px solid var(--ui-border); }
.guest-mentions { display: flex; align-items: flex-start; gap: 4px; height: 30px; overflow-x: auto; scrollbar-width: thin; }
.guest-mentions button { flex: none; padding: 2px 8px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.guest-mentions button:hover { background: var(--ui-bg-elevated); }
.guest-working { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.guest-working > span { width: 13px; height: 13px; }
.guest-message-list > *, .guest-composer > * { width: 100%; max-width: 960px; margin-inline: auto; }
.guest-compose-row { display: flex; align-items: flex-end; gap: 8px; }
</style>

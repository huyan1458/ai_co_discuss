<script setup>
/**
 * The middle of an invited room: only what this computer's AI was asked there and what it answered, never the rest of
 * the other room. Built from `invited-room`: the record's own history (woken, refused, timed out, failed…), the requests
 * waiting for you, and, when the other computer is reachable, the texts of those requests and of this AI's answers,
 * each answer under the request it answers (`invited_items`). An ended record keeps all of this readable.
 */
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import { invited_items, runner_message, use_invited_rooms, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const { bridge } = inject("discussion");
const invited = use_invited_rooms();
const record = invited.selected;
const messages = ref([]), error = ref(""), loading = ref(false), failure = ref("");
const REFRESH_MS = 5000;
const AI_ICON = "/icons/external-expert.svg";
// A single missed read is retried on the next pass; the notice appears only when the next one misses too.
const OFFLINE_AFTER_MISSES = 2;
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
function show_messages(id, list) {
  messages.value = list;
  invited.room_messages.set(id, list);
}
async function load() {
  const id = invited.selected_id.value;
  if (!id || reading === id) return;
  reading = id;
  try {
    const result = await invited.read_room(id);
    if (invited.selected_id.value !== id) return;
    // The top-level `messages`: the other room's, or the texts this computer kept when it cannot be reached. An empty
    // answer during an outage keeps what was last shown rather than blanking the page.
    if (!result.error || result.messages?.length) show_messages(id, result.messages || []);
    if (result.room?.me) invited.room_me.value = { ...invited.room_me.value, [id]: result.room.me };
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
/** Open a record: what is already known shows at once, and the other room is read behind it. */
function open_record(id) {
  messages.value = invited.room_messages.get(id) || [];
  error.value = failure.value = "";
  misses.value = 0;
  reached.value = false;
  loading.value = Boolean(id) && !messages.value.length;
  if (id && !messages.value.length) {
    invited.read_room(id, { cached: true }).then((kept) => {
      if (invited.selected_id.value === id && !messages.value.length && kept.messages?.length) messages.value = kept.messages;
    }).catch(() => {});
  }
  load();
}
watch(() => invited.selected_id.value, open_record, { immediate: true });
const timer = setInterval(() => { if (!record.value?.status || record.value.status === "active") load(); }, REFRESH_MS);
onBeforeUnmount(() => clearInterval(timer));

const items = computed(() => invited_items(record.value, messages.value));
const ai_name = computed(() => record.value?.member_label || record.value?.member || t("你的 AI"));
const active = computed(() => !record.value?.status || record.value.status === "active");
const offline = computed(() => active.value && Boolean(error.value) && misses.value >= OFFLINE_AFTER_MISSES);
// Until a read has answered, a text not shown yet is still on its way rather than gone.
const read_settled = computed(() => reached.value || misses.value >= OFFLINE_AFTER_MISSES || !active.value);
const full_date = (value) => value ? new Date(time_ms(value)).toLocaleString([], { hour12: false }) : "";
const short_date = (value) => value ? new Date(time_ms(value)).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
const outcome_of = (item) => OUTCOMES[item.outcome] || [item.outcome || "", "neutral"];
const BY = { user: t("对方房主"), host: t("对方主持人") };
// The other room's owner writes as "用户" there; here that reads as its owner, in the page language.
const OWNER_AUTHOR = "用户";
const author = (message) => message.author === OWNER_AUTHOR ? BY.user : message.author_label || message.author;
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
  <div v-keep-reading class="content-page invited-page" role="region" :aria-label="t('被邀请的房间')">
    <div class="invited-column" :class="{ 'is-empty': !items.length && !loading && !failure }">
      <div v-if="offline" class="invited-notice" role="status" :title="error">
        <UIcon name="i-lucide-cloud-off" />
        <div>
          <strong>{{ t("暂时读不到对方房间") }}</strong>
          <p>{{ items.length ? t("正在自动重试，下面是这台电脑记下的处理结果。") : t("正在自动重试。") }}</p>
        </div>
      </div>
      <div v-if="loading && !items.length" role="status"><USkeleton v-for="row in 3" :key="row" class="invited-skeleton" /></div>
      <div v-else-if="failure" class="invited-notice is-error" role="alert">
        <UIcon name="i-lucide-circle-alert" />
        <div><p>{{ failure }}</p></div>
        <UButton :label="t('重试')" size="xs" color="neutral" variant="outline" @click="load" />
      </div>
      <div v-else-if="!items.length" class="invited-empty">
        <span class="invited-empty-icon"><UIcon name="i-lucide-at-sign" /></span>
        <h2>{{ t("还没有人点名你的 AI。") }}</h2>
        <p>{{ t("对方点名它后，请求和回答会显示在这里。") }}</p>
      </div>
      <template v-else>
        <p class="invited-scope">{{ t("只显示点名给你的 AI 的请求和它的回答") }}</p>
        <ol class="invited-items">
          <li v-for="item in items" :key="item.key" class="invited-item" :class="{ 'is-ended': item.outcome === 'ended' }">
            <p v-if="item.outcome === 'ended'" class="invited-ended" role="status"><UIcon name="i-lucide-circle-slash" />{{ item.reason }}<small v-if="item.at" :title="full_date(item.at)">{{ short_date(item.at) }}</small></p>
            <template v-else>
              <article class="invited-turn">
                <header class="invited-byline">
                  <UAvatar v-if="from_person(item)" icon="i-lucide-user" :alt="heading(item)" size="sm" class="channel-avatar user invited-avatar" />
                  <span v-else class="channel-avatar external invited-avatar" aria-hidden="true"><img :src="AI_ICON" alt="" /></span>
                  <div class="invited-who">
                    <strong>{{ heading(item) }}</strong>
                    <small><template v-if="item.requests.length">{{ item.message_ids.map((id) => `#${id}`).join(" ") }} · </template><time :title="full_date(item.at)">{{ short_date(item.at) }}</time></small>
                  </div>
                  <UBadge :color="outcome_of(item)[1]" variant="subtle" size="sm" class="invited-outcome">{{ outcome_of(item)[0] }}</UBadge>
                </header>
                <div v-for="message in item.requests" :key="message.id" class="channel-message-text markdown-body invited-text" v-html="bridge.render_room_markdown(message.text)"></div>
                <p v-if="item.missing_text && read_settled" class="channel-message-text channel-stop-reason invited-reason">{{ t("正文在对方房间，已无法读取") }}</p>
                <p v-else-if="item.reason" class="channel-message-text invited-reason" :class="reason_class(item)">{{ runner_message(item.reason_text, item.reason) }}</p>
              </article>
              <article v-for="answer in item.answers" :key="answer.id" class="invited-turn is-answer">
                <header class="invited-byline">
                  <span class="channel-avatar external invited-avatar" aria-hidden="true"><img :src="AI_ICON" alt="" /></span>
                  <div class="invited-who">
                    <strong>{{ ai_name }}</strong>
                    <small>#{{ answer.id }}<template v-if="answer.created_at"> · <time :title="full_date(answer.created_at)">{{ short_date(answer.created_at) }}</time></template></small>
                  </div>
                </header>
                <div class="channel-message-text markdown-body invited-text" v-html="bridge.render_room_markdown(answer.text)"></div>
              </article>
            </template>
          </li>
        </ol>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* The same reading column and card language as a room's messages. */
.invited-page { display: flex; flex-direction: column; }
:global(html[data-theme^="channel"] .content-page > .invited-column) { max-width: 928px; }
.invited-column { display: flex; flex: 1 0 auto; flex-direction: column; gap: 14px; width: 100%; margin-inline: auto; }
.invited-column.is-empty { justify-content: center; }
.invited-scope { margin: 0; color: var(--ui-text-dimmed); font-size: 12px; }
.invited-skeleton { height: 112px; margin-bottom: 14px; border-radius: 10px; }

.invited-notice { display: flex; align-items: flex-start; gap: 10px; padding: 11px 14px; border: 1px solid color-mix(in srgb, var(--ui-warning) 28%, transparent); border-radius: 10px; background: color-mix(in srgb, var(--ui-warning) 8%, transparent); font-size: 13px; line-height: 1.5; }
.invited-notice > [class*="icon"] { flex-shrink: 0; width: 16px; height: 16px; margin-top: 2px; color: var(--ui-warning); }
.invited-notice > div { flex: 1; min-width: 0; }
.invited-notice strong { color: var(--ui-text-highlighted); font-weight: 600; }
.invited-notice p { margin: 1px 0 0; color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.invited-notice.is-error { border-color: color-mix(in srgb, var(--ui-error) 28%, transparent); background: color-mix(in srgb, var(--ui-error) 8%, transparent); }
.invited-notice.is-error > [class*="icon"] { color: var(--ui-error); }

.invited-empty { display: flex; flex-direction: column; align-items: center; padding: 40px 16px 72px; text-align: center; }
.invited-empty-icon { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-bottom: 14px; border: 1px solid var(--ui-border-muted); border-radius: 50%; background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.invited-empty-icon > [class*="icon"] { width: 20px; height: 20px; }
.invited-empty h2 { margin: 0; color: var(--ui-text-highlighted); font-size: 15px; font-weight: 600; }
.invited-empty p { margin: 6px 0 0; color: var(--ui-text-muted); font-size: 13px; }

.invited-items { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; }
.invited-item { overflow: hidden; border: 1px solid #ffffff0d; border-radius: 10px; background: #313338; transition: border-color .12s; }
.invited-item:hover { border-color: #ffffff1d; }
.invited-item.is-ended { border-style: dashed; border-color: var(--ui-border); background: transparent; }
.invited-turn { padding: 18px 22px; }
.invited-turn.is-answer { border-top: 1px solid #ffffff0d; background: #ffffff05; }
.invited-byline { display: flex; align-items: center; gap: 10px; min-height: 28px; margin-bottom: 12px; }
.invited-byline:last-child { margin-bottom: 0; }
.invited-avatar { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; overflow: hidden; }
.invited-who { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; min-width: 0; }
.invited-who strong { color: var(--ui-text-highlighted); font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
.invited-who small { color: var(--ui-text-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.invited-outcome { flex-shrink: 0; }
.invited-text { margin-top: 0; font-size: 15px; }
.invited-text + .invited-text { margin-top: 10px; }
.invited-reason { margin-top: 10px; font-size: 13px; }
.invited-ended { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; padding: 10px 16px; color: var(--ui-text-toned); font-size: 13px; }
.invited-ended small { margin-left: auto; color: var(--ui-text-dimmed); font-size: 11px; }
@media (max-width: 480px) { .invited-turn { padding: 14px; } }
</style>

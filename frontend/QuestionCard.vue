<script setup>
import { t } from './i18n.js';
import { computed, inject, nextTick, ref, watch } from "vue";

/**
 * The owner's answer card for questions members asked (backend/questions.py), above the composer. Its interaction
 * follows DeepSeek Harness's question composer (MIT; design followed, code not copied, see
 * .dev/plans/Agent参与体验整改/DSH提问工具对照.md): one question per page with a pager, numbered rows for a single
 * choice and checkboxes for several, the recommended option marked and chosen in advance (choosing in advance is not
 * answering: nothing is sent until the owner submits), a free-answer row under the options, skip, collapse and close.
 * Clicking a single-choice option confirms it: the card goes on to the next question, or submits on the last. Enter
 * goes on the same way, Shift+Enter breaks a line. Beyond it, the room's own actions: ask the host to recommend first,
 * or leave the decision to it. One card at a time, in the site's order; the others wait as one-line rows. Every write
 * sends the version the card shows. A write leaves the card at once and runs behind it; a refused one brings the card
 * back as the owner left it, with the error in the notice bar.
 */
const props = defineProps({ questions: { type: Array, required: true } });
const { bridge, act, pending } = inject("discussion");
const card_key = (question) => `${question.id}:${question.version}`;
// Cards the owner has already acted on: a snapshot read before the write landed must not bring them back.
const sent = ref(new Set());
const visible = computed(() => props.questions.filter((item) => item.status !== "waiting_user" || !sent.value.has(card_key(item))));
const current = computed(() => visible.value.find((item) => item.status === "waiting_user") || null);
const waiting = computed(() => visible.value.filter((item) => item !== current.value));
const items = computed(() => current.value?.questions || []);
// One draft per question {selected: option ids, custom: free answer}; a new card or a new version starts again.
const drafts = ref([]);
const page = ref(0);
const minimized = ref(false);
const body = ref(null);
let submission = "";
// What each card held when it left the screen, so a refused write returns it unchanged and retries with the same id.
const kept = new Map();
watch(() => current.value && card_key(current.value), (key, previous) => {
  if (previous) kept.set(previous, { drafts: drafts.value, page: page.value, submission });
  const back = kept.get(key);
  drafts.value = back?.drafts || items.value.map((item) => ({ selected: item.options.filter((option) => option.recommended).map((option) => option.id), custom: "" }));
  page.value = back?.page || 0;
  submission = back?.submission || "";
}, { immediate: true });

const item = computed(() => items.value[page.value]);
const draft = computed(() => drafts.value[page.value] || { selected: [], custom: "" });
const last = computed(() => page.value === items.value.length - 1);
const answered = (entry) => entry.selected.length > 0 || entry.custom.trim() !== "";
const STATUS = { waiting_recommendation: () => t('等主持人推荐'), delegated: () => t('已交主持人决定'), waiting_user: () => t('待你回答') };
const route_text = computed(() => {
  const gate = current.value?.gate;
  if (!gate) return t('答案交回 {value1}', { value1: bridge.display_name(current.value.asker) });
  return gate.route === "repeat" ? t('答后接力再来一圈') : t('答后接力交下一棒');
});

function update(change) {
  drafts.value = drafts.value.map((entry, index) => index === page.value ? { ...entry, ...change } : entry);
}

/**
 * A single choice replaces the free answer and confirms the question; several choices keep the free answer alongside.
 * The second click of a double click is dropped: it would land on the next question's option under the pointer.
 */
function choose(option, event) {
  const chosen = draft.value.selected;
  if (item.value.multiSelect) {
    update({ selected: chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : [...chosen, option.id] });
    return;
  }
  if (event.detail > 1) return;
  update({ selected: [option.id], custom: "" });
  go_on();
}

function type_custom(value) {
  update({ custom: value, ...(item.value.multiSelect || !value ? {} : { selected: [] }) });
}

async function turn(index) {
  page.value = index;
  await nextTick();
  body.value?.scrollTo?.({ top: 0 });
}

function go_on() {
  if (last.value) send("answer");
  else turn(page.value + 1);
}

function skip() {
  update({ selected: [], custom: "" });
  go_on();
}

function on_enter(event) {
  if (event.isComposing || event.shiftKey) return;
  event.preventDefault();
  if (answered(draft.value) || !last.value) go_on();
}

/** Take the card off the screen and write behind it; a refused write puts it back. */
async function write(question, operation, body) {
  const key = card_key(question);
  sent.value = new Set(sent.value).add(key);
  if (await act("question_answer", { id: question.id, operation, body })) {
    kept.delete(key);
    return;
  }
  const remaining = new Set(sent.value);
  remaining.delete(key);
  sent.value = remaining;
}

/** Send one action for the current card; a retry of the same click keeps its submission id. */
async function send(action) {
  const question = current.value;
  if (!question) return;
  submission ||= crypto.randomUUID();
  const answers = items.value.map((entry, index) => ({ id: entry.id, selected: drafts.value[index].selected,
    ...(drafts.value[index].custom.trim() ? { custom: drafts.value[index].custom } : {}) }));
  const payload = { version: question.version, action, submission_id: submission, ...(action === "answer" ? { answers } : {}) };
  await write(question, "answer", payload);
}

async function cancel() {
  const question = current.value;
  if (question) await write(question, "cancel", { version: question.version });
}
</script>

<template>
  <section v-if="visible.length" class="question-card" :class="{ 'is-minimized': minimized }" :aria-label="t('待你回答的问题')">
    <template v-if="current && item">
      <header class="question-head">
        <div class="question-heading">
          <span class="question-eyebrow">{{ item.header || t('{value1} 在问你', { value1: bridge.display_name(current.asker) }) }}</span>
          <span v-if="minimized" class="question-title">{{ item.question }}</span>
          <span v-else class="question-meta">{{ t('问题 #{value1} · 第 {value2} 版 · 说明见消息 #{value3}', { value1: current.id, value2: current.version, value3: current.message_id }) }}</span>
        </div>
        <UButton :icon="minimized ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" size="xs" color="neutral" variant="ghost"
          :aria-label="minimized ? t('展开答题卡') : t('收起答题卡')" :title="minimized ? t('展开答题卡') : t('收起答题卡')" :aria-expanded="!minimized"
          :disabled="!!pending" @click="minimized = !minimized" />
        <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('取消这个问题')"
          :title="t('取消这个问题；绑定接力的问题取消后接力停止')" :disabled="!!pending" @click="cancel" />
      </header>
      <template v-if="!minimized">
        <div ref="body" class="question-body">
          <p class="question-title">{{ item.question }}</p>
          <p v-if="item.detail" class="question-detail">{{ item.detail }}</p>
          <p v-if="current.recommendation_message_id" class="question-note">{{ t('主持人已给推荐（消息 #{value1}），请确认或另选', { value1: current.recommendation_message_id }) }}</p>
          <div class="question-options" :role="item.multiSelect ? 'group' : 'radiogroup'" :aria-label="item.question">
            <button v-for="(option, index) in item.options" :key="option.id" type="button" class="question-option"
              :class="{ 'is-selected': draft.selected.includes(option.id) }" :role="item.multiSelect ? 'checkbox' : 'radio'"
              :aria-checked="draft.selected.includes(option.id)" :disabled="!!pending" @click="choose(option, $event)" @keydown.enter="item.multiSelect && on_enter($event)">
              <span v-if="item.multiSelect" class="question-check" aria-hidden="true"><UIcon v-if="draft.selected.includes(option.id)" name="i-lucide-check" /></span>
              <span v-else class="question-number" aria-hidden="true">{{ index + 1 }}</span>
              <span class="question-copy">
                <span class="question-line">
                  <span class="question-label">{{ option.label }}</span>
                  <span v-if="option.recommended" class="question-badge">{{ t('推荐') }}</span>
                </span>
                <span v-if="option.description" class="question-description">{{ option.description }}</span>
              </span>
            </button>
            <label v-if="item.free_text" class="question-option question-custom" :class="{ 'is-selected': draft.custom.trim() }">
              <span v-if="item.multiSelect && item.options.length" class="question-check" aria-hidden="true"><UIcon v-if="draft.custom.trim()" name="i-lucide-check" /></span>
              <span v-else class="question-number" aria-hidden="true"><UIcon name="i-lucide-pencil" /></span>
              <UTextarea :model-value="draft.custom" :rows="1" autoresize :maxrows="6" variant="none" class="question-custom-field"
                :placeholder="item.options.length ? t('其他回答或修改意见') : t('填写你的回答')" :disabled="!!pending"
                @update:model-value="type_custom" @keydown.enter="on_enter" />
            </label>
          </div>
          <p class="question-scope">{{ t('{value1}；问题与回答按房间阅读权限公开，不要填写密钥、令牌或密码', { value1: route_text }) }}</p>
        </div>
        <footer class="question-foot">
          <div class="question-pager">
            <UButton icon="i-lucide-chevron-left" size="xs" color="neutral" variant="ghost" :aria-label="t('上一题')" :disabled="page === 0 || !!pending" @click="turn(page - 1)" />
            <span class="question-progress">{{ page + 1 }} / {{ items.length }}</span>
            <UButton icon="i-lucide-chevron-right" size="xs" color="neutral" variant="ghost" :aria-label="t('下一题')" :disabled="last || !!pending" @click="turn(page + 1)" />
          </div>
          <div class="question-room-actions">
            <UButton size="xs" color="neutral" variant="ghost" :label="t('请主持人先讨论并给推荐')" :disabled="!!pending" @click="send('recommend')" />
            <UButton size="xs" color="neutral" variant="ghost" :label="t('交给主持人决定')" :disabled="!!pending" @click="send('delegate')" />
          </div>
          <div class="question-actions">
            <UButton size="sm" color="neutral" variant="outline" :label="t('跳过')" :disabled="!!pending" @click="skip" />
            <UButton size="sm" :label="last ? t('提交回答') : t('下一题')" :disabled="!!pending || (!answered(draft) && last && !drafts.some(answered))" @click="go_on" />
          </div>
        </footer>
      </template>
    </template>
    <ul v-if="waiting.length && !minimized" class="question-queue" :aria-label="t('排队中的问题')">
      <li v-for="entry in waiting" :key="entry.id">
        <UIcon name="i-lucide-clock" />
        <span>{{ t('#{value1} {value2}：{value3}', { value1: entry.id, value2: bridge.display_name(entry.asker), value3: entry.questions[0]?.question || '' }) }}</span>
        <span class="question-status">{{ (STATUS[entry.status] || STATUS.waiting_user)() }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* A card over the composer, at most min(60vh, 520px) tall with its body scrolling, as in DeepSeek Harness. */
/* The title bar's frosted glass: messages scrolling behind the card stay out of the way of its text. */
.question-card { display: flex; flex-direction: column; max-height: min(60vh, 520px); margin: 0 12px 8px; border: 1px solid var(--ui-border-accented); border-radius: 12px; background: var(--channel-topbar-bg); -webkit-backdrop-filter: var(--channel-glass-filter); backdrop-filter: var(--channel-glass-filter); font-size: 13px; overflow: hidden; }
.question-card.is-minimized { max-height: none; }
.question-head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 4px 12px; }
.question-heading { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.question-eyebrow { color: var(--ui-text-muted); font-size: 12px; }
.question-meta, .question-scope, .question-status, .question-progress { color: var(--ui-text-dimmed); font-size: 12px; }
.question-card.is-minimized .question-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.question-body { display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 4px 12px 8px; overflow-y: auto; overscroll-behavior: contain; }
.question-title { color: var(--ui-text-highlighted); font-weight: 600; }
.question-detail, .question-note { color: var(--ui-text-toned); white-space: pre-wrap; }
.question-options { display: flex; flex-direction: column; gap: 2px; }
.question-option { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px; border-radius: 8px; text-align: left; color: var(--ui-text); cursor: pointer; }
.question-option:hover:not(:disabled) { background: var(--ui-bg-accented); }
.question-option.is-selected { background: var(--ui-bg-accented); box-shadow: inset 0 0 0 1px var(--ui-border-accented); }
.question-option:disabled { cursor: default; opacity: .6; }
.question-number, .question-check { display: inline-grid; flex-shrink: 0; place-items: center; width: 20px; height: 20px; margin-top: 1px; border: 1px solid var(--ui-border-accented); border-radius: 6px; color: var(--ui-text-muted); font-size: 12px; }
.question-option.is-selected .question-number, .question-option.is-selected .question-check { border-color: var(--ui-primary); color: var(--ui-primary); }
.question-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.question-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.question-badge { padding: 0 6px; border-radius: 999px; background: var(--ui-primary); color: var(--ui-bg); font-size: 11px; line-height: 18px; }
.question-description { color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; }
.question-custom { cursor: text; }
.question-custom-field { flex: 1; min-width: 0; }
.question-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px 8px; border-top: 1px solid var(--ui-border); }
.question-pager { display: flex; align-items: center; gap: 2px; }
.question-room-actions { display: flex; flex: 1; flex-wrap: wrap; gap: 2px; }
.question-actions { display: flex; gap: 6px; margin-left: auto; }
.question-queue { display: flex; flex-direction: column; gap: 2px; padding: 6px 12px 8px; border-top: 1px solid var(--ui-border); color: var(--ui-text-muted); }
.question-queue li { display: flex; align-items: center; gap: 6px; min-width: 0; }
.question-queue li > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* Phone width: the room's own actions drop under the pager and the main buttons stay at the right. */
@media (max-width: 640px) {
  .question-room-actions { order: 3; flex-basis: 100%; }
  /* A phone keeps most of its height for the conversation: the card takes at most 45% and scrolls inside. */
  .question-card { max-height: 45dvh; margin: 0 8px 6px; }
  .question-option { padding: 6px; }
}
</style>

<script setup>
import { t } from './i18n.js';
import { computed, inject, nextTick, ref, watch } from "vue";

/**
 * The owner's answer card for questions members asked (backend/questions.py), above the composer. Its interaction
 * follows DeepSeek Harness's question composer (MIT; design followed, code not copied, see
 * .dev/plans/Agent参与体验整改/DSH提问工具对照.md): one question per page with a pager, numbered rows for a single
 * choice and checkboxes for several, the recommended option marked and chosen in advance (choosing in advance is not
 * answering: nothing is sent until the owner submits), a free-answer row under the options, skip, collapse and close.
 * Clicking a single-choice option confirms it and goes on to the next question; on the last one it only chooses, and
 * only the submit button or Enter submits. Enter goes on or submits, Shift+Enter breaks a line. Beyond it, the room's own actions: ask the host to recommend first,
 * or leave the decision to it. One card at a time, in the site's order; the others wait as one-line rows. Every write
 * sends the version the card shows. A write leaves the card at once and runs behind it; a refused one brings the card
 * back as the owner left it, with the error in the notice bar.
 */
const props = defineProps({ questions: { type: Array, required: true } });
const { bridge, act } = inject("discussion");
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
 * A single choice replaces the free answer and goes on, except on the last question, which waits for the submit;
 * several choices keep the free answer alongside. The second click of a double click is dropped: it would land on the
 * next question's option under the pointer. The clicked option takes focus (Safari leaves it out) so Enter can submit.
 */
function choose(option, event) {
  const chosen = draft.value.selected;
  if (item.value.multiSelect) {
    update({ selected: chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : [...chosen, option.id] });
    return;
  }
  if (event.detail > 1) return;
  update({ selected: [option.id], custom: "" });
  if (last.value) event.currentTarget.focus();
  else go_on();
}

/** Enter on an option: a single choice takes that option first, then the card goes on or submits. */
function on_option_enter(option, event) {
  if (!item.value.multiSelect && !event.isComposing && !event.shiftKey && !event.repeat) update({ selected: [option.id], custom: "" });
  on_enter(event);
}

function type_custom(value) {
  update({ custom: value, ...(item.value.multiSelect || !value ? {} : { selected: [] }) });
}

async function turn(index) {
  page.value = index;
  await nextTick();
  body.value?.scrollTo?.({ top: 0 });
}

/** Next question, with focus on it so Enter keeps working; the last one submits. */
async function go_on() {
  if (last.value) return send("answer");
  await turn(page.value + 1);
  body.value?.focus({ preventScroll: true });
}

function skip() {
  update({ selected: [], custom: "" });
  go_on();
}

function on_enter(event) {
  if (event.isComposing || event.shiftKey) return;
  event.preventDefault();
  // A held key repeats: one press moves one question, and never runs on into the submit.
  if (!event.repeat && (answered(draft.value) || !last.value)) go_on();
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
          @click="minimized = !minimized" />
        <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('取消这个问题')"
          :title="t('取消这个问题；绑定接力的问题取消后接力停止')" @click="cancel" />
      </header>
      <template v-if="!minimized">
        <div ref="body" class="question-body" tabindex="-1" @keydown.enter.self="on_enter">
          <p class="question-title">{{ item.question }}</p>
          <p v-if="item.detail" class="question-detail">{{ item.detail }}</p>
          <p v-if="current.recommendation_message_id" class="question-note">{{ t('主持人已给推荐（消息 #{value1}），请确认或另选', { value1: current.recommendation_message_id }) }}</p>
          <div class="question-options" :role="item.multiSelect ? 'group' : 'radiogroup'" :aria-label="item.question">
            <button v-for="(option, index) in item.options" :key="option.id" type="button" class="question-option"
              :class="{ 'is-selected': draft.selected.includes(option.id) }" :role="item.multiSelect ? 'checkbox' : 'radio'"
              :aria-checked="draft.selected.includes(option.id)" @click="choose(option, $event)" @keydown.enter="on_option_enter(option, $event)">
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
                :placeholder="item.options.length ? t('其他回答或修改意见') : t('填写你的回答')"
                @update:model-value="type_custom" @keydown.enter="on_enter" />
            </label>
          </div>
          <p class="question-scope">{{ t('{value1}；问题与回答按房间阅读权限公开，不要填写密钥、令牌或密码', { value1: route_text }) }}</p>
        </div>
        <footer class="question-foot">
          <div class="question-pager">
            <UButton icon="i-lucide-chevron-left" size="xs" color="neutral" variant="ghost" :aria-label="t('上一题')" :disabled="page === 0" @click="turn(page - 1)" />
            <span class="question-progress">{{ page + 1 }} / {{ items.length }}</span>
            <UButton icon="i-lucide-chevron-right" size="xs" color="neutral" variant="ghost" :aria-label="t('下一题')" :disabled="last" @click="turn(page + 1)" />
          </div>
          <div class="question-room-actions">
            <UButton size="xs" color="neutral" variant="ghost" :label="t('请主持人先讨论并给推荐')" @click="send('recommend')" />
            <UButton size="xs" color="neutral" variant="ghost" :label="t('交给主持人决定')" @click="send('delegate')" />
          </div>
          <div class="question-actions">
            <UButton size="sm" color="neutral" variant="outline" :label="t('跳过')" @click="skip" />
            <UButton size="sm" :label="last ? t('提交回答') : t('下一题')" :disabled="(!answered(draft) && last && !drafts.some(answered))" @click="go_on" />
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
.question-card { display: flex; flex-direction: column; max-height: min(60vh, 520px); margin: 0 12px 8px; border: 1px solid var(--channel-edge-float, var(--ui-border)); border-radius: 14px; background: var(--channel-glass-bg, var(--channel-topbar-bg)); box-shadow: var(--channel-shadow-panel); -webkit-backdrop-filter: var(--channel-glass-filter); backdrop-filter: var(--channel-glass-filter); font-size: 13px; overflow: hidden; }
.question-card.is-minimized { max-height: none; }
.question-head { display: flex; align-items: center; gap: 2px; padding: 8px 8px 2px 14px; }
.question-heading { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 0 8px; min-width: 0; }
.question-eyebrow { color: var(--ui-primary); font-size: 12px; font-weight: 600; }
.question-meta, .question-scope, .question-status, .question-progress { color: var(--ui-text-dimmed); font-size: 12px; }
.question-progress { min-width: 34px; text-align: center; font-variant-numeric: tabular-nums; }
.question-card.is-minimized .question-head { padding-bottom: 8px; }
.question-card.is-minimized .question-heading { flex-wrap: nowrap; }
.question-card.is-minimized .question-eyebrow { flex-shrink: 0; }
.question-card.is-minimized .question-title { min-width: 0; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.question-body { display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 2px 14px 10px; overflow-y: auto; overscroll-behavior: contain; }
.question-body:focus { outline: none; }
.question-title { color: var(--ui-text-highlighted); font-size: 15px; font-weight: 600; line-height: 1.5; }
.question-detail, .question-note { color: var(--ui-text-toned); line-height: 1.6; white-space: pre-wrap; }
.question-options { display: flex; flex-direction: column; gap: 4px; margin: 2px -4px 0; }
/* Hover is the shared faint ghost fill; the chosen row carries the accent as a tint, a hairline and a filled marker, so the two never read alike. */
.question-option { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 8px 10px; border: 1px solid transparent; border-radius: 10px; text-align: left; color: var(--ui-text); cursor: pointer; transition: background-color .12s, border-color .12s; }
.question-option:hover:not(:disabled) { background: var(--channel-ghost-hover, var(--ui-bg-accented)); }
.question-option:focus-visible { outline: none; border-color: color-mix(in srgb, var(--ui-primary) 60%, transparent); }
.question-option.is-selected, .question-option.is-selected:hover:not(:disabled) { border-color: color-mix(in srgb, var(--ui-primary) 36%, transparent); background: color-mix(in srgb, var(--ui-primary) 10%, transparent); }
.question-option:disabled { cursor: default; opacity: .6; }
.question-number, .question-check { display: inline-grid; flex-shrink: 0; place-items: center; width: 20px; height: 20px; margin-top: 1px; border: 1px solid transparent; border-radius: 6px; background: var(--channel-ghost-active, var(--ui-bg-accented)); color: var(--ui-text-muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; transition: background-color .12s, border-color .12s, color .12s; }
.question-check { border-color: var(--ui-border-accented); background: transparent; }
.question-option.is-selected .question-number, .question-option.is-selected .question-check { border-color: var(--ui-primary); background: var(--ui-primary); color: var(--ui-bg); }
.question-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.question-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.question-label { color: var(--ui-text-highlighted); font-weight: 500; line-height: 22px; }
.question-badge { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-primary) 16%, transparent); color: var(--ui-primary); font-size: 11px; font-weight: 500; line-height: 18px; }
.question-description { color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
/* The free answer reads as a field: a hairline at rest, the accent while typing. */
.question-custom { align-items: center; border-color: var(--channel-edge-control, var(--ui-border)); cursor: text; }
.question-custom:hover:not(:disabled) { background: transparent; }
.question-custom:focus-within { border-color: color-mix(in srgb, var(--ui-primary) 55%, transparent); }
.question-custom .question-number { margin-top: 0; }
.question-custom-field { flex: 1; min-width: 0; }
.question-custom-field :deep(textarea) { min-height: 22px; padding: 0; font-size: 13px; line-height: 22px; }
.question-scope { font-size: 11px; line-height: 1.5; }
.question-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--channel-topbar-divider, var(--ui-border)); }
.question-pager { display: flex; align-items: center; gap: 2px; }
.question-room-actions { display: flex; flex: 1; flex-wrap: wrap; gap: 2px; }
.question-actions { display: flex; gap: 6px; margin-left: auto; }
.question-queue { display: flex; flex-direction: column; gap: 2px; padding: 6px 14px 8px; border-top: 1px solid var(--channel-topbar-divider, var(--ui-border)); color: var(--ui-text-muted); font-size: 12px; }
.question-queue li { display: flex; align-items: center; gap: 6px; min-width: 0; }
.question-queue li > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
/* Phone width: the room's own actions drop under the pager and the main buttons stay at the right. */
@media (max-width: 640px) {
  .question-room-actions { order: 3; flex-basis: 100%; }
  /* A phone keeps most of its height for the conversation: the card takes at most 45% and scrolls inside. */
  .question-card { max-height: 45dvh; margin: 0 8px 6px; }
  .question-option { padding: 6px 8px; }
}
</style>

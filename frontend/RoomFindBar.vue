<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { clear_matches, find_handoff, paint_matches, search_params, search_pattern } from "./search.js";
import { t } from "./i18n.js";

/**
 * The room's find bar, in VSCode's shape (Ctrl+F): case, whole word and regex switches inside the box, a match count,
 * previous and next, show only matches, the same search over every room, and clear. Every match on screen is marked,
 * the current one more strongly; moving to a match scrolls the transcript to the row it belongs to.
 */
const props = defineProps({ roomId: { type: String, default: "" }, disabled: Boolean });
const emit = defineEmits(["locate", "global"]);
const { view, bridge, act } = inject("discussion");
const SEARCH_DELAY_MS = 250;

const query = ref("");
const options = reactive({ case: false, word: false, regex: false });
const result = reactive({ matches: [], truncated: false, loading: false, error: "", searched: "" });
const index = ref(-1);
// On phones the bar folds behind one search button and opens over the tabs.
const phone_open = ref(false);
const input = ref(null);
let timer = null, serial = 0, wanted_anchor = null;

const filtering = computed(() => Boolean(view.value.query));
const has_query = computed(() => Boolean(query.value));
const current = computed(() => result.matches[index.value] || null);
const count_text = computed(() => {
  if (!has_query.value) return "";
  if (result.error) return t("正则有误");
  if (result.loading && result.searched !== key()) return "…";
  if (!result.matches.length) return t("无结果");
  return `${index.value + 1}/${result.matches.length}${result.truncated ? "+" : ""}`;
});

/** What the current search asks, to tell a stale answer from the latest one. */
function key() { return `${props.roomId}\n${query.value}\n${options.case}${options.word}${options.regex}`; }

/** Ask the site for this room's matches; only the latest answer is kept. */
async function run_search() {
  clearTimeout(timer);
  const asked = key(), mine = ++serial;
  if (!props.roomId || !query.value) {
    Object.assign(result, { matches: [], truncated: false, loading: false, error: "", searched: asked });
    index.value = -1;
    if (filtering.value) apply_filter(false);
    return;
  }
  result.loading = true;
  try {
    const data = await bridge.request(`/api/rooms/${props.roomId}/search?${search_params(query.value, options)}`);
    if (mine !== serial) return;
    const matches = data.matches || [];
    Object.assign(result, { matches, truncated: Boolean(data.truncated), loading: false, error: "", searched: asked });
    // A result picked on the search page lands on that row; otherwise the newest match, nearest where reading usually is.
    const picked = wanted_anchor == null ? -1 : matches.findIndex((match) => match.anchor_message_id === wanted_anchor || match.message_id === wanted_anchor);
    const anchor = wanted_anchor;
    wanted_anchor = null;
    go(picked >= 0 ? picked : matches.length - 1, anchor);
  } catch (error) {
    if (mine !== serial) return;
    Object.assign(result, { matches: [], truncated: false, loading: false, error: error.message, searched: asked });
    index.value = -1;
  }
  // A pattern the site rejected leaves the shown matches as they were.
  if (filtering.value && !result.error) apply_filter(true);
}

function schedule_search() {
  clearTimeout(timer);
  result.loading = Boolean(query.value);
  timer = setTimeout(run_search, SEARCH_DELAY_MS);
}

/** Make match `at` the current one and bring its row on screen. */
function go(at, fallback_anchor = null) {
  index.value = result.matches.length ? at : -1;
  const anchor = current.value?.anchor_message_id ?? fallback_anchor;
  if (anchor != null) emit("locate", anchor);
}

function step(delta) {
  if (!result.matches.length) return;
  const count = result.matches.length;
  go(((index.value < 0 ? (delta > 0 ? -1 : 0) : index.value) + delta + count) % count);
}

/** Show only the rows that match, the site matching as this search does (with its switches), or everything again. */
function apply_filter(on) {
  act("filter", on ? { query: query.value, options: { ...options } } : { query: "", options: null });
}

function clear() {
  query.value = "";
  if (filtering.value) apply_filter(false);
  run_search();
}

function on_keydown(event) {
  if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
  else if (event.key === "Escape") { event.preventDefault(); clear(); }
}

function toggle(name) {
  options[name] = !options[name];
  schedule_search();
}

watch(query, schedule_search);
// Another room starts with an empty bar, unless the search page is handing a result over to it.
watch(() => props.roomId, () => { if (!take_handoff()) { query.value = ""; run_search(); } });

/** A result chosen on the search page: take its words and switches, and land on its row. */
function take_handoff() {
  const handoff = find_handoff.value;
  if (!handoff || handoff.room_id !== props.roomId) return false;
  find_handoff.value = null;
  query.value = handoff.query;
  Object.assign(options, handoff.options);
  wanted_anchor = handoff.anchor_message_id;
  phone_open.value = true;
  schedule_search();
  return true;
}
watch(find_handoff, take_handoff, { immediate: true });

// Marks follow the matches, the current row and every change to what the transcript has on screen.
const pattern = computed(() => search_pattern(result.searched === key() ? query.value : "", options));
let observer = null, frame = 0;
function repaint() {
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    const root = document.querySelector(".channel-transcript");
    if (observer && root && observer.root !== root) { observer.disconnect(); observer.root = root; observer.observe(root, { childList: true, subtree: true, characterData: true }); }
    paint_matches(root, props.disabled ? null : pattern.value, current.value?.anchor_message_id);
  });
}
watch([pattern, current, () => props.disabled], repaint);

/** Ctrl+F opens the find bar instead of the browser's find while the messages are shown. */
function on_global_key(event) {
  if (props.disabled || !(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== "f") return;
  event.preventDefault();
  phone_open.value = true;
  nextTick(() => { input.value?.inputRef?.focus(); input.value?.inputRef?.select(); });
}

onMounted(() => {
  observer = Object.assign(new MutationObserver(repaint), { root: null });
  repaint();
  document.addEventListener("keydown", on_global_key);
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  cancelAnimationFrame(frame);
  observer?.disconnect();
  clear_matches();
  document.removeEventListener("keydown", on_global_key);
});
</script>

<template>
  <UButton icon="i-lucide-search" color="neutral" :variant="phone_open || has_query ? 'soft' : 'ghost'" size="sm" class="channel-icon-button channel-find-toggle" :aria-label="t('在房间内查找')" :aria-expanded="phone_open" :disabled="disabled" @click="phone_open = !phone_open; phone_open && nextTick(() => input?.inputRef?.focus())" />
  <div class="channel-search channel-find" :class="{ 'is-open': phone_open }" role="search" :title="disabled ? t('请在消息标签使用搜索和筛选') : undefined">
    <UInput ref="input" v-model="query" icon="i-lucide-search" variant="none" size="sm" :placeholder="t('查找')" :aria-label="t('在房间内查找')" :disabled="disabled" class="channel-search-input channel-find-input" @keydown="on_keydown">
      <template #trailing>
        <UButton icon="i-lucide-case-sensitive" color="neutral" :variant="options.case ? 'soft' : 'ghost'" size="xs" class="channel-find-switch" :class="{ 'is-on': options.case }" :aria-label="t('区分大小写')" :title="t('区分大小写')" :aria-pressed="options.case" :disabled="disabled" @click="toggle('case')" />
        <UButton icon="i-lucide-whole-word" color="neutral" :variant="options.word ? 'soft' : 'ghost'" size="xs" class="channel-find-switch" :class="{ 'is-on': options.word }" :aria-label="t('全字匹配')" :title="t('全字匹配')" :aria-pressed="options.word" :disabled="disabled" @click="toggle('word')" />
        <UButton icon="i-lucide-regex" color="neutral" :variant="options.regex ? 'soft' : 'ghost'" size="xs" class="channel-find-switch" :class="{ 'is-on': options.regex }" :aria-label="t('使用正则表达式')" :title="t('使用正则表达式')" :aria-pressed="options.regex" :disabled="disabled" @click="toggle('regex')" />
      </template>
    </UInput>
    <span class="channel-find-count" :class="{ 'is-empty': has_query && !result.matches.length && count_text !== '…' }" role="status" :title="result.error || undefined">{{ count_text }}</span>
    <UButton icon="i-lucide-arrow-up" color="neutral" variant="ghost" size="xs" class="channel-find-button" :aria-label="t('上一处（Shift+Enter）')" :title="t('上一处（Shift+Enter）')" :disabled="disabled || !result.matches.length" @click="step(-1)" />
    <UButton icon="i-lucide-arrow-down" color="neutral" variant="ghost" size="xs" class="channel-find-button" :aria-label="t('下一处（Enter）')" :title="t('下一处（Enter）')" :disabled="disabled || !result.matches.length" @click="step(1)" />
    <UButton icon="i-lucide-text-search" color="neutral" :variant="filtering ? 'soft' : 'ghost'" size="xs" class="channel-find-button" :aria-label="t('只显示命中')" :title="t('只显示命中')" :aria-pressed="filtering" :disabled="disabled || (!has_query && !filtering)" @click="apply_filter(!filtering)" />
    <UButton icon="i-lucide-globe" color="neutral" variant="ghost" size="xs" class="channel-find-button" :aria-label="t('在全部房间中搜索')" :title="t('在全部房间中搜索')" :disabled="disabled" @click="emit('global', { query, options: { ...options } })" />
    <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="channel-find-button" :aria-label="t('清除查找')" :title="t('清除查找（Esc）')" :disabled="disabled || (!has_query && !filtering)" @click="clear(); phone_open = false" />
  </div>
</template>

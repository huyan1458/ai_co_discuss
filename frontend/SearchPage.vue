<script setup>
import { computed, inject, nextTick, onMounted, reactive, ref, watch } from "vue";
import { search_params, snippet_parts, use_search_page } from "./search.js";
import { locale, t } from "./i18n.js";

/**
 * Search over every room on this computer, in the shape of VSCode's search view (Ctrl+Shift+F): the same box and
 * switches as the room's find bar, results grouped by room (collapsible), each with who, when and the words around the
 * match. Choosing one opens its room on that row with the find bar carrying the same search.
 */
const emit = defineEmits(["open-match"]);
const { bridge } = inject("discussion");
const page = use_search_page();
const SEARCH_DELAY_MS = 400;
const KIND_LABELS = { message: t("消息"), execution: t("执行"), attachment: t("附件") };

const query = ref("");
const options = reactive({ case: false, word: false, regex: false });
const result = reactive({ rooms: [], total: 0, truncated: false, loading: false, error: "", searched: false });
const collapsed = ref(new Set());
const input = ref(null);
let timer = null, serial = 0;

const room_count = computed(() => result.rooms.length);
const shown = computed(() => result.rooms.reduce((sum, room) => sum + (room.matches?.length || 0), 0));

let asked = "";
const key = () => `${query.value}\n${options.case}${options.word}${options.regex}`;

async function run_search() {
  clearTimeout(timer);
  const mine = ++serial;
  asked = key();
  if (!query.value) { Object.assign(result, { rooms: [], total: 0, truncated: false, loading: false, error: "", searched: false }); return; }
  result.loading = true;
  try {
    const data = await bridge.request(`/api/search?${search_params(query.value, options, { archived: "1" })}`);
    if (mine !== serial) return;
    Object.assign(result, { rooms: data.rooms || [], total: data.total || 0, truncated: Boolean(data.truncated), loading: false, error: "", searched: true });
    collapsed.value = new Set();
  } catch (error) {
    if (mine !== serial) return;
    Object.assign(result, { rooms: [], total: 0, truncated: false, loading: false, error: error.message, searched: true });
  }
}

function schedule_search() {
  clearTimeout(timer);
  if (key() === asked) return;
  result.loading = Boolean(query.value);
  timer = setTimeout(run_search, SEARCH_DELAY_MS);
}

function toggle(name) { options[name] = !options[name]; schedule_search(); }

function toggle_room(id) {
  const next = new Set(collapsed.value);
  if (!next.delete(id)) next.add(id);
  collapsed.value = next;
}

/** Opened again from a room's find bar: take its words and switches. */
function take_request() {
  query.value = page.request.query;
  Object.assign(options, page.request.options);
  run_search();
  nextTick(() => input.value?.inputRef?.focus());
}
watch(() => page.request.serial, take_request);
watch(query, schedule_search);
onMounted(take_request);

function when(value) {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function open(room, match) {
  emit("open-match", { room_id: room.room_id, anchor_message_id: match.anchor_message_id ?? match.message_id, query: query.value, options: { ...options } });
}
</script>

<template>
  <div class="content-page search-page" role="search">
    <div class="search-page-box">
      <UInput ref="input" v-model="query" icon="i-lucide-search" size="md" :placeholder="t('在全部房间中搜索')" :aria-label="t('在全部房间中搜索')" class="search-page-input" @keydown.enter.prevent="run_search">
        <template #trailing>
          <UButton icon="i-lucide-case-sensitive" color="neutral" :variant="options.case ? 'soft' : 'ghost'" size="xs" :aria-label="t('区分大小写')" :title="t('区分大小写')" :aria-pressed="options.case" @click="toggle('case')" />
          <UButton icon="i-lucide-whole-word" color="neutral" :variant="options.word ? 'soft' : 'ghost'" size="xs" :aria-label="t('全字匹配')" :title="t('全字匹配')" :aria-pressed="options.word" @click="toggle('word')" />
          <UButton icon="i-lucide-regex" color="neutral" :variant="options.regex ? 'soft' : 'ghost'" size="xs" :aria-label="t('使用正则表达式')" :title="t('使用正则表达式')" :aria-pressed="options.regex" @click="toggle('regex')" />
        </template>
      </UInput>
      <p class="search-page-summary" role="status">
        <template v-if="!query">{{ t("搜索协作房间和 MOSS 的消息、执行进展与失败原因、附件文件名，含已存档房间；不含私聊和已撤回的消息。") }}</template>
        <template v-else-if="result.loading"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t("正在搜索…") }}</template>
        <template v-else-if="result.error"><span class="search-page-error">{{ result.error }}</span></template>
        <template v-else-if="result.searched">{{ result.total ? t("{count} 个结果，分布在 {rooms} 个房间", { count: result.total, rooms: room_count }) : t("没有找到结果") }}<template v-if="result.truncated">{{ t("（结果过多，只列出前 {count} 条，可以换更具体的关键词）", { count: shown }) }}</template></template>
      </p>
    </div>
    <div v-if="result.loading && !result.rooms.length && query" class="search-page-skeleton" aria-hidden="true"><USkeleton v-for="row in 6" :key="row" class="h-5 w-full" /></div>
    <section v-for="room in result.rooms" :key="room.room_id" class="search-page-room" :aria-label="room.title">
      <button type="button" class="search-page-room-head" :aria-expanded="!collapsed.has(room.room_id)" @click="toggle_room(room.room_id)">
        <UIcon :name="collapsed.has(room.room_id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" />
        <bdi dir="auto" class="search-page-room-title">{{ room.title || t("未命名房间") }}</bdi>
        <UBadge v-if="room.archived" color="neutral" variant="subtle" size="sm">{{ t("已存档") }}</UBadge>
        <span class="search-page-room-count">{{ room.total }}</span>
      </button>
      <ul v-show="!collapsed.has(room.room_id)" class="search-page-matches">
        <li v-for="match in room.matches" :key="`${match.kind}-${match.message_id}-${match.execution_id || ''}-${match.ranges?.[0]?.[0] ?? ''}`">
          <button type="button" class="search-page-match" @click="open(room, match)">
            <span class="search-page-match-meta">
              <strong v-if="match.author">{{ bridge.display_name(match.author) }}</strong>
              <span v-if="match.kind !== 'message'" class="search-page-kind">{{ KIND_LABELS[match.kind] || match.kind }}</span>
              <time v-if="match.created_at" :datetime="match.created_at">{{ when(match.created_at) }}</time>
              <span class="search-page-id">#{{ match.anchor_message_id ?? match.message_id }}</span>
            </span>
            <span class="search-page-snippet"><template v-for="(part, at) in snippet_parts(match.snippet, match.ranges)" :key="at"><mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
          </button>
        </li>
        <li v-if="room.total > (room.matches?.length || 0)" class="search-page-more">{{ t("这个房间还有 {count} 条，打开房间后用查找条逐条查看", { count: room.total - (room.matches?.length || 0) }) }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.search-page { display: grid; align-content: start; gap: 12px; }
/* .content-page centres each child with auto margins, which would shrink a grid item to its content. */
.search-page > * { width: 100%; }
.search-page-box { display: grid; gap: 8px; }
.search-page-input { width: 100%; }
.search-page-input :deep([data-slot="trailing"]) { gap: 2px; }
/* One line high in every state, so the results never move as the summary changes. */
.search-page-summary { display: flex; align-items: center; gap: 6px; min-height: 20px; margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 20px; }
.search-page-error { color: var(--ui-error); }
.search-page-skeleton { display: grid; gap: 10px; }
.search-page-room { display: grid; gap: 2px; }
.search-page-room-head { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 4px 6px; border-radius: 6px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; text-align: left; }
.search-page-room-head:hover { background: var(--ui-bg-elevated); }
.search-page-room-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search-page-room-count { margin-left: auto; padding: 0 7px; border-radius: 999px; background: var(--ui-bg-accented); color: var(--ui-text-muted); font-size: 11px; font-weight: 500; line-height: 18px; }
.search-page-matches { display: grid; margin: 0; padding: 0 0 0 20px; list-style: none; }
.search-page-match { display: grid; gap: 2px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; }
.search-page-match:hover, .search-page-match:focus-visible { background: var(--ui-bg-elevated); }
.search-page-match-meta { display: flex; align-items: baseline; gap: 8px; color: var(--ui-text-muted); font-size: 11px; }
.search-page-match-meta strong { color: var(--ui-text-toned); font-weight: 600; }
.search-page-kind { padding: 0 5px; border: 1px solid var(--ui-border); border-radius: 4px; }
.search-page-id { margin-left: auto; font-variant-numeric: tabular-nums; }
.search-page-snippet { overflow: hidden; color: var(--ui-text); font-size: 13px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.search-page-snippet mark { border-radius: 2px; background: color-mix(in srgb, var(--ui-warning) 35%, transparent); color: inherit; }
.search-page-more { padding: 4px 8px 6px; color: var(--ui-text-dimmed); font-size: 12px; }
</style>

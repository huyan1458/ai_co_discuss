<script setup>
/**
 * Browse the conversations one AI software keeps on the computer and pick the one a new member resumes, as the
 * software's own resume list does: the list (newest first, searchable, one directory or all) beside a preview of the
 * selected conversation's last messages. Reads through the local service; picking only reports the choice.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import { t } from "./i18n.js";

const props = defineProps({
  /** The member the conversation is picked for, shown in the title. */
  name: { type: String, required: true },
  /** The software entry whose conversations are listed. */
  adapter: { type: String, required: true },
  /** The room's or the form's project directory: the list starts on its conversations when there is one. */
  directory: { type: String, default: "" },
  /** The conversation already picked, selected when the window opens. */
  selected: { type: String, default: "" },
});
const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["pick"]);
const { bridge } = inject("discussion");

const SEARCH_DELAY_MS = 250;
const scope = ref("directory");
const query = ref("");
const sessions = ref([]), next_offset = ref(null);
const loading = ref(false), failure = ref(""), unavailable = ref(false);
const current = ref("");
const preview = ref(null), preview_loading = ref(false), preview_failure = ref("");
const list = ref(null), messages = ref(null);
// A newer request (typing, switching scope, selecting another row) makes an older answer stale.
let list_request = 0, preview_request = 0, search_timer;
const scoped = computed(() => Boolean(props.directory));
const chosen = computed(() => sessions.value.find((session) => session.id === current.value) || (preview.value?.id === current.value ? preview.value : null));

/**
 * Read the first page, or the next one (`more`), of the list as the search box and scope now stand. A selection missing
 * from a new first page moves to its first row, except the one the window opened with (`keep`), which may be further down.
 */
async function load(more = false, keep = false) {
  const request = ++list_request;
  loading.value = true;
  failure.value = "";
  if (!more) { sessions.value = []; next_offset.value = null; }
  try {
    const result = await bridge.local_request("sessions", { adapter: props.adapter, query: query.value.trim(),
      ...(scoped.value && scope.value === "directory" ? { cwd: props.directory } : {}), ...(more ? { offset: next_offset.value } : {}) });
    if (request !== list_request) return;
    unavailable.value = result.available === false;
    sessions.value = more ? [...sessions.value, ...result.sessions] : result.sessions;
    next_offset.value = result.next_offset;
    if (!more && !(keep && current.value) && !sessions.value.some((session) => session.id === current.value)) select(sessions.value[0]?.id || "");
  } catch (error) { if (request === list_request) failure.value = error.message; }
  finally { if (request === list_request) loading.value = false; }
}

/** Show one conversation's last messages, scrolled to the latest. */
async function select(id) {
  current.value = id;
  const request = ++preview_request;
  preview.value = null;
  preview_failure.value = "";
  if (!id) { preview_loading.value = false; return; }
  preview_loading.value = true;
  try {
    const result = await bridge.local_request("sessions", { adapter: props.adapter, action: "preview", session_id: id });
    if (request !== preview_request) return;
    preview.value = result;
    await nextTick();
    if (messages.value) messages.value.scrollTop = messages.value.scrollHeight;
  } catch (error) { if (request === preview_request) preview_failure.value = error.message; }
  finally { if (request === preview_request) preview_loading.value = false; }
}

/** Arrow keys move through the list as in a terminal resume list; Enter picks. */
function move(event) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step || !sessions.value.length) return;
  event.preventDefault();
  const index = sessions.value.findIndex((session) => session.id === current.value);
  const next = sessions.value[Math.min(sessions.value.length - 1, Math.max(0, index + step))];
  if (next.id === current.value) return;
  select(next.id);
  nextTick(() => list.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }));
}

function pick() {
  if (!chosen.value) return;
  emit("pick", { id: chosen.value.id, title: chosen.value.title, cwd: chosen.value.cwd });
  open.value = false;
}

/** Short relative time of a conversation's last change. */
function updated(session) {
  const time = new Date(session.updated_at || "").getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  const days = Math.floor(minutes / 1440);
  if (minutes < 1) return t("刚刚");
  if (minutes < 60) return t("{count}分钟前", { count: minutes });
  if (minutes < 1440) return t("{count}小时前", { count: Math.floor(minutes / 60) });
  if (days < 7) return t("{count}天前", { count: days });
  if (days < 30) return t("{count}周前", { count: Math.floor(days / 7) });
  if (days < 365) return t("{count}个月前", { count: Math.floor(days / 30) });
  return t("{count}年前", { count: Math.floor(days / 365) });
}

const size = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const folder = (path) => String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
const clock = (at) => { const time = new Date(at || ""); return Number.isNaN(time.getTime()) ? "" : time.toLocaleString(); };

watch(open, (value) => {
  list_request++; preview_request++;
  if (!value) return;
  scope.value = "directory";
  query.value = "";
  current.value = props.selected;
  preview.value = null;
  load(false, true);
  if (current.value) select(current.value);
});
watch(scope, () => { if (open.value) load(); });
watch(query, () => { clearTimeout(search_timer); if (open.value) search_timer = setTimeout(() => load(), SEARCH_DELAY_MS); });
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="t('为 {name} 选择历史会话', { name: bridge.display_name(name) })"
    :description="t('选中的会话由程序在后台续接，带着它已有的上下文加入房间；它工作时请不要在原窗口继续操作。')" :ui="{ content: 'glass-panel studio-modal session-browser-modal', body: 'dialog-body' }">
    <template #body>
      <div class="session-browser">
        <div class="session-browser-list">
          <div class="session-browser-tools">
            <UInput v-model="query" icon="i-lucide-search" size="sm" autofocus class="w-full" :placeholder="t('搜索标题、目录或会话 ID')" :aria-label="t('搜索历史会话')" @keydown="move" @keydown.enter.prevent="pick" />
            <div v-if="scoped" class="expert-card-modes" role="radiogroup" :aria-label="t('会话范围')">
              <button type="button" role="radio" :aria-checked="scope === 'directory'" :title="directory" @click="scope = 'directory'">{{ t('本项目') }}</button>
              <button type="button" role="radio" :aria-checked="scope === 'all'" @click="scope = 'all'">{{ t('全部') }}</button>
            </div>
          </div>
          <ul ref="list" class="session-browser-rows" role="listbox" tabindex="0" :aria-label="t('历史会话')" :aria-busy="loading" @keydown="move" @keydown.enter.prevent="pick">
            <li v-for="session in sessions" :key="session.id" role="option" :aria-selected="session.id === current" @click="select(session.id)" @dblclick="pick">
              <strong :title="session.title">{{ session.title || session.id }}</strong>
              <small><span>{{ updated(session) }}</span><span :title="session.cwd">{{ folder(session.cwd) }}</span><span>{{ size(session.size) }}</span></small>
            </li>
            <li v-if="loading" class="session-browser-note" role="status">{{ t('正在读取历史会话…') }}</li>
            <li v-else-if="failure" class="session-browser-note" role="alert">{{ failure }}<button type="button" @click="load()">{{ t('重试') }}</button></li>
            <li v-else-if="unavailable" class="session-browser-note">{{ t('这个软件的历史会话不能在这里浏览。') }}</li>
            <li v-else-if="next_offset !== null" class="session-browser-note"><button type="button" @click="load(true)">{{ sessions.length ? t('加载更多') : t('继续查找更早的会话') }}</button></li>
            <li v-else-if="!sessions.length" class="session-browser-note">{{ query.trim() ? t('没有匹配的会话。') : scoped && scope === 'directory' ? t('这个项目目录里还没有会话，可切换到“全部”。') : t('这台电脑上还没有这个软件的会话。') }}</li>
          </ul>
        </div>
        <section class="session-browser-preview" :aria-label="t('会话预览')" :aria-busy="preview_loading">
          <template v-if="preview">
            <header>
              <strong>{{ preview.title || preview.id }}</strong>
              <small :title="preview.cwd">{{ preview.cwd }}</small>
              <small>{{ t('会话 ID：{id}', { id: preview.id }) }}</small>
            </header>
            <div ref="messages" class="session-browser-messages">
              <p v-if="preview.truncated" class="session-browser-note">{{ t('只显示最近的对话。') }}</p>
              <p v-if="!preview.messages.length" class="session-browser-note">{{ t('这个会话的末尾没有可显示的对话。') }}</p>
              <article v-for="(message, index) in preview.messages" :key="index" :class="`is-${message.role}`">
                <h4>{{ message.role === 'user' ? t('用户') : 'AI' }}<time v-if="clock(message.at)">{{ clock(message.at) }}</time></h4>
                <p>{{ message.text }}<span v-if="message.cut">…</span></p>
              </article>
            </div>
          </template>
          <p v-else class="session-browser-note" :role="preview_failure ? 'alert' : 'status'">{{ preview_loading ? t('正在读取会话预览…') : preview_failure || t('在左侧选择一个会话查看预览。') }}</p>
        </section>
        <div class="session-browser-footer">
          <UButton :label="t('取消')" color="neutral" variant="ghost" @click="open = false" />
          <UButton icon="i-lucide-history" :label="t('接入此会话')" class="channel-primary-button" :disabled="!chosen" @click="pick" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.session-browser { display: grid; grid-template-columns: minmax(0, 320px) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; gap: 12px 14px; height: min(560px, calc(100dvh - 220px)); min-height: 280px; }
.session-browser-list { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.session-browser-tools { display: flex; align-items: center; gap: 8px; }
.session-browser-tools .expert-card-modes { flex-shrink: 0; }
.session-browser-tools .expert-card-modes button { flex: none; padding: 0 8px; white-space: nowrap; }
.session-browser-rows { flex: 1; min-height: 0; margin: 0; padding: 4px; overflow-y: auto; list-style: none; border: 1px solid var(--ui-border-muted); border-radius: 8px; scrollbar-width: thin; }
.session-browser-rows:focus-visible { outline: 1px solid var(--channel-accent); }
.session-browser-rows li[role="option"] { display: grid; gap: 2px; padding: 7px 9px; border-radius: 6px; cursor: pointer; }
.session-browser-rows li[role="option"]:hover { background: var(--ui-bg-elevated); }
.session-browser-rows li[aria-selected="true"] { background: var(--ui-bg-accented); }
.session-browser-rows strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.session-browser-rows small { display: flex; gap: 8px; min-width: 0; color: var(--ui-text-dimmed); font-size: 11px; white-space: nowrap; }
.session-browser-rows small span:nth-child(2) { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.session-browser-note { margin: 0; padding: 10px; color: var(--ui-text-muted); font-size: 12px; text-align: center; }
.session-browser-note button { margin-left: 6px; color: var(--channel-accent); }
.session-browser-preview { display: flex; flex-direction: column; min-width: 0; min-height: 0; border: 1px solid var(--ui-border-muted); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); }
.session-browser-preview > header { display: grid; gap: 2px; padding: 10px 12px; border-bottom: 1px solid var(--ui-border-muted); }
.session-browser-preview > header strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.session-browser-preview > header small { overflow: hidden; color: var(--ui-text-dimmed); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.session-browser-preview > .session-browser-note { margin: auto; }
.session-browser-messages { flex: 1; min-height: 0; padding: 10px 12px; overflow-y: auto; scrollbar-width: thin; }
.session-browser-messages article { margin-bottom: 12px; }
.session-browser-messages h4 { display: flex; gap: 8px; margin: 0 0 2px; color: var(--ui-text-muted); font-size: 11px; font-weight: 500; }
.session-browser-messages article.is-user h4 { color: var(--channel-accent); }
.session-browser-messages time { color: var(--ui-text-dimmed); font-weight: 400; }
.session-browser-messages article p { margin: 0; color: var(--ui-text-toned); font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.session-browser-footer { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 720px) {
  .session-browser { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 2fr) minmax(0, 3fr) auto; height: calc(100dvh - 200px); }
}
</style>

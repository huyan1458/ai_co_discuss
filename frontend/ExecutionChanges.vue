<script setup>
/**
 * The files one execution changed, as "edited N files +a -b": a row per file with its added and removed lines. With a
 * mouse, pointing at a row previews its patch in a floating panel and a click keeps that panel open; on touch screens a
 * tap opens the patch inside the list (user 2026-11-17). Patches are read from the site on first use, owner only. Files the member's own edit tools did not
 * write (another window or member working in the same folder) stand apart in one muted line.
 */
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { t } from "./i18n.js";

// More files than this and the list starts folded.
const FOLDED_ABOVE = 5;
// Mouse preview: how long the pointer rests before it opens and may wander before it closes; its widest width, the room
// it wants below the row before it opens above instead, and its distance from the row and the window edges.
const PREVIEW_OPEN_MS = 250;
const PREVIEW_CLOSE_MS = 200;
const PREVIEW_MAX_WIDTH = 720;
const PREVIEW_MIN_BELOW = 260;
const PREVIEW_GAP = 4;
const PREVIEW_MARGIN = 16;

const props = defineProps({
  /** The execution report: `changes`, `edited` (null when the software could not tell), `diff_stats`, `id`. */
  report: { type: Object, required: true },
  roomId: { type: String, required: true },
});
const { bridge } = inject("discussion");

const stats = computed(() => new Map((props.report.diff_stats || []).map((item) => [item.path, item])));
// With the member's own edits known, files it did not write are someone else's work in the same folder.
const edited = computed(() => props.report.edited ? new Set(props.report.edited) : null);
const others = computed(() => edited.value ? (props.report.changes || []).filter((path) => !edited.value.has(path)) : []);
const files = computed(() => (props.report.changes || []).filter((path) => !edited.value || edited.value.has(path))
  .map((path) => ({ path, stat: stats.value.get(path) })));
const totals = computed(() => files.value.reduce((sum, file) => ({ added: sum.added + (file.stat?.added || 0), removed: sum.removed + (file.stat?.removed || 0) }), { added: 0, removed: 0 }));
const counted = computed(() => files.value.some((file) => Number.isInteger(file.stat?.added)));

const open = ref(new Set());
// A long list starts folded to its header row; the header opens and closes it (user 2026-11-17: 14 files filled the
// screen with no way to fold them). Files others changed meanwhile stay folded to one row inside the same box.
const list_open = ref(files.value.length <= FOLDED_ABOVE);
const others_open = ref(false);
const patches = ref(null), loading = ref(false), failure = ref("");
/** The patches of the whole execution, read once on first use. */
async function load_patches() {
  if (patches.value || loading.value) return;
  loading.value = true;
  failure.value = "";
  try {
    const result = await bridge.request(`/api/rooms/${encodeURIComponent(props.roomId)}/executions/${props.report.id}/diff`);
    patches.value = new Map((result.diffs || []).map((item) => [item.path, item]));
  } catch (error) { failure.value = error.message; }
  finally { loading.value = false; }
}

const mouse = window.matchMedia("(hover: hover) and (pointer: fine)");
// The floating preview: which file, whether a click pinned it, and where it sits (fixed, beside its row).
const floating = ref(""), pinned = ref(false), place = ref({});
let panel = null, anchor = null, open_timer = 0, close_timer = 0;
/** Place the preview under its row, or above it when the window has too little room below. */
function position() {
  if (!anchor?.isConnected) return close_preview();
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(PREVIEW_MAX_WIDTH, window.innerWidth - PREVIEW_MARGIN * 2);
  const left = Math.max(PREVIEW_MARGIN, Math.min(rect.left, window.innerWidth - PREVIEW_MARGIN - width));
  const edge = window.innerHeight - rect.bottom >= PREVIEW_MIN_BELOW
    ? { top: `${rect.bottom + PREVIEW_GAP}px` } : { bottom: `${window.innerHeight - rect.top + PREVIEW_GAP}px` };
  place.value = { left: `${left}px`, width: `${width}px`, ...edge };
}
function show_preview(path, row) {
  window.clearTimeout(close_timer);
  anchor = row;
  floating.value = path;
  position();
  load_patches();
  window.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  document.addEventListener("pointerdown", outside_press, true);
  document.addEventListener("keydown", escape_key);
}
function close_preview() {
  window.clearTimeout(open_timer);
  window.clearTimeout(close_timer);
  floating.value = "";
  pinned.value = false;
  anchor = null;
  window.removeEventListener("scroll", position, true);
  window.removeEventListener("resize", position);
  document.removeEventListener("pointerdown", outside_press, true);
  document.removeEventListener("keydown", escape_key);
}
/** Resting on a row opens its preview after a moment (at once when another preview is showing). */
function enter_row(path, event) {
  if (!mouse.matches || pinned.value) return;
  window.clearTimeout(close_timer);
  window.clearTimeout(open_timer);
  const row = event.currentTarget;
  open_timer = window.setTimeout(() => show_preview(path, row), floating.value ? 0 : PREVIEW_OPEN_MS);
}
/** Leaving the row and the panel closes an unpinned preview. */
function leave() {
  window.clearTimeout(open_timer);
  if (!pinned.value && floating.value) close_timer = window.setTimeout(close_preview, PREVIEW_CLOSE_MS);
}
const enter_panel = () => window.clearTimeout(close_timer);
function outside_press(event) {
  if (panel?.contains(event.target) || anchor?.contains(event.target)) return;
  close_preview();
}
function escape_key(event) { if (event.key === "Escape") close_preview(); }
/** A click pins (or unpins) the preview with a mouse; on touch screens it opens the patch inside the list. */
function press(path, event) {
  if (mouse.matches) {
    if (floating.value === path && pinned.value) return close_preview();
    show_preview(path, event.currentTarget);
    pinned.value = true;
    return;
  }
  const next = new Set(open.value);
  if (next.has(path)) next.delete(path); else next.add(path);
  open.value = next;
  load_patches();
}
const keep_panel = (element) => { if (element) panel = element; };
onBeforeUnmount(close_preview);
const folder = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
const name = (path) => path.slice(path.lastIndexOf("/") + 1);
/**
 * A patch's lines with their kind (hunk header, added, removed or context) and line number, as Codex shows a diff: the
 * new file's number for added and context lines, the old file's for removed ones, counted from each hunk header.
 */
function patch_lines(patch) {
  let old_line = 0, new_line = 0;
  return String(patch || "").replace(/\n$/, "").split("\n").map((line) => {
    if (line.startsWith("@@")) {
      const [, from, to] = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/) || [];
      old_line = Number(from) || 0; new_line = Number(to) || 0;
      return { text: line, kind: "hunk", number: "" };
    }
    if (line.startsWith("+")) return { text: line, kind: "add", number: new_line++ };
    if (line.startsWith("-")) return { text: line, kind: "del", number: old_line++ };
    old_line += 1;
    return { text: line, kind: "ctx", number: new_line++ };
  });
}
</script>

<template>
  <div class="execution-changes">
    <div class="execution-changes-box">
    <button v-if="files.length" type="button" class="execution-changes-head" :aria-expanded="list_open" @click="list_open = !list_open">
      <span class="execution-changes-title">{{ t('已修改 {count} 个文件', { count: files.length }) }}</span>
      <span v-if="counted" class="execution-changes-count"><b class="is-add">+{{ totals.added }}</b> <b class="is-del">-{{ totals.removed }}</b></span>
      <UIcon name="i-lucide-chevron-down" class="execution-changes-chevron" />
    </button>
    <ul v-if="files.length && list_open" class="execution-changes-list">
      <li v-for="file in files" :key="file.path">
        <button type="button" class="execution-changes-row" :aria-expanded="open.has(file.path) || (pinned && floating === file.path)" :title="file.path"
          @click="file.stat && !file.stat.skipped && press(file.path, $event)" @pointerenter="file.stat && !file.stat.skipped && enter_row(file.path, $event)" @pointerleave="leave">
          <span class="execution-changes-path"><span class="execution-changes-folder">{{ folder(file.path) }}</span>{{ name(file.path) }}</span>
          <span v-if="file.stat?.skipped" class="execution-changes-note" :title="file.stat.skipped === 'binary' ? '' : t('文件超过 1 MB，只记录了改动，没有保存逐行差异')">{{ file.stat.skipped === 'binary' ? t('二进制文件') : t('未记录差异') }}</span>
          <span v-else-if="Number.isInteger(file.stat?.added)" class="execution-changes-count"><b class="is-add">+{{ file.stat.added }}</b> <b class="is-del">-{{ file.stat.removed }}</b></span>
          <UIcon v-if="file.stat && !file.stat.skipped" name="i-lucide-chevron-down" class="execution-changes-chevron" />
        </button>
        <Teleport to="body" :disabled="floating !== file.path">
        <div v-if="(open.has(file.path) || floating === file.path) && file.stat && !file.stat.skipped" :ref="floating === file.path ? keep_panel : undefined"
          class="execution-changes-patch" :class="{ 'is-floating': floating === file.path }" :style="floating === file.path ? place : null"
          @pointerenter="enter_panel" @pointerleave="leave">
          <div v-if="floating === file.path" class="execution-changes-preview-head">
            <span class="execution-changes-path"><span class="execution-changes-folder">{{ folder(file.path) }}</span>{{ name(file.path) }}</span>
            <button v-if="pinned" type="button" class="execution-changes-close" :aria-label="t('关闭预览')" @click="close_preview"><UIcon name="i-lucide-x" /></button>
          </div>
          <p v-if="loading && !patches" class="execution-changes-note">{{ t('正在读取改动…') }}</p>
          <p v-else-if="failure" class="execution-changes-note">{{ t('读取改动失败：{value1}', { value1: failure }) }}</p>
          <template v-else-if="patches?.get(file.path)">
            <pre><code><span v-for="(line, index) in patch_lines(patches.get(file.path).patch)" :key="index" :class="`is-${line.kind}`"><span class="execution-changes-number" aria-hidden="true">{{ line.number }}</span><span class="execution-changes-text">{{ line.text }}</span>
</span></code></pre>
            <p v-if="patches.get(file.path).truncated" class="execution-changes-note">{{ t('改动较长，只显示前面一部分') }}</p>
          </template>
        </div>
        </Teleport>
      </li>
    </ul>
    <template v-if="others.length">
      <button type="button" class="execution-changes-head execution-changes-others" :aria-expanded="others_open" :title="t('同一时间被改动、但不是这位成员的编辑工具写的文件，可能来自其他窗口、成员或构建')" @click="others_open = !others_open">
        <span class="execution-changes-title">{{ t('其他来源 {count} 个文件', { count: others.length }) }}</span>
        <UIcon name="i-lucide-chevron-down" class="execution-changes-chevron" />
      </button>
      <ul v-if="others_open" class="execution-changes-list execution-changes-others-list">
        <li v-for="path in others" :key="path" class="execution-changes-path" :title="path"><span class="execution-changes-folder">{{ folder(path) }}</span>{{ name(path) }}</li>
      </ul>
    </template>
    </div>
  </div>
</template>

<style scoped>
/* As Codex shows a turn's changes: the list always fills the card, a file's diff opens inside that same width and
   scrolls sideways on its own, so opening or closing a file never changes the card's width (user 2026-11-16: on phones
   the list was narrower closed than open). */
.execution-changes { width: 100%; min-width: 0; margin-top: 4px; line-height: 1.4; }
/* Inside the execution report's own frame the list draws no lines of its own (user 2026-11-17: "too many frame
   lines"): the summary row, a row per file and the other-sources row are told apart by weight and colour, a row shows a
   hover tint, and an opened patch sits on a tinted panel. */
.execution-changes-box { width: 100%; margin: 0 -6px; width: calc(100% + 12px); }
.execution-changes-head { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 28px; padding: 3px 6px; border-radius: 4px; color: var(--ui-text-toned); text-align: left; cursor: pointer; }
.execution-changes-head:hover { background: var(--ui-bg-elevated); }
.execution-changes-title { flex: 1; min-width: 0; }
.execution-changes-head[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
.execution-changes-others { background: none; color: var(--ui-text-dimmed); }
.execution-changes-others-list > li { padding: 1px 6px; direction: ltr; }
.execution-changes-list { width: 100%; margin: 0; padding: 0; list-style: none; }
.execution-changes-list > li { min-width: 0; }
.execution-changes-row { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; min-height: 28px; padding: 3px 6px; border-radius: 4px; text-align: left; cursor: pointer; }
.execution-changes-row:hover, .execution-changes-row[aria-expanded="true"] { background: var(--ui-bg-elevated); }
.execution-changes-path { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.execution-changes-folder { color: var(--ui-text-dimmed); }
.execution-changes-count { flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.execution-changes-count .is-add { color: var(--ui-success, #3fb27f); font-weight: 500; }
.execution-changes-count .is-del { color: var(--ui-error, #e5534b); font-weight: 500; }
.execution-changes-note { flex-shrink: 0; margin: 0; color: var(--ui-text-dimmed); font-size: 11px; }
.execution-changes-chevron { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); transition: transform .15s; }
.execution-changes-row[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
.execution-changes-patch { min-width: 0; margin: 2px 0 6px; border-radius: 6px; --patch-bg: color-mix(in srgb, var(--ui-bg-elevated) 70%, var(--ui-bg)); background: var(--patch-bg); overflow: hidden; }
.execution-changes-patch pre { max-width: 100%; max-height: 360px; margin: 0; overflow: auto; font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overscroll-behavior: contain; scrollbar-width: thin; }
.execution-changes-patch code { display: block; min-width: max-content; }
.execution-changes-patch code > span { display: flex; white-space: pre; }
/* The line number stays put while a long line scrolls sideways. */
.execution-changes-number { position: sticky; left: 0; flex-shrink: 0; width: 5ch; padding: 0 8px 0 4px; background: var(--patch-bg, var(--ui-bg)); color: var(--ui-text-dimmed); text-align: right; user-select: none; }
.execution-changes-text { padding: 0 12px 0 6px; }
.execution-changes-patch .is-add { background: color-mix(in srgb, var(--ui-success, #3fb27f) 14%, transparent); color: var(--ui-text-highlighted); }
.execution-changes-patch .is-add .execution-changes-number { background: color-mix(in srgb, var(--ui-success, #3fb27f) 22%, var(--patch-bg, var(--ui-bg))); }
.execution-changes-patch .is-del { background: color-mix(in srgb, var(--ui-error, #e5534b) 14%, transparent); color: var(--ui-text-highlighted); }
.execution-changes-patch .is-del .execution-changes-number { background: color-mix(in srgb, var(--ui-error, #e5534b) 22%, var(--patch-bg, var(--ui-bg))); }
.execution-changes-patch .is-hunk { color: var(--ui-text-dimmed); font-size: 10.5px; background: color-mix(in srgb, var(--ui-primary) 8%, transparent); }
.execution-changes-patch .is-hunk .execution-changes-number { background: color-mix(in srgb, var(--ui-primary) 8%, var(--patch-bg, var(--ui-bg))); }
.execution-changes-patch .is-ctx { color: var(--ui-text-muted); }
.execution-changes-patch > p { padding: 6px 10px; }
/* The mouse preview floats over the page beside its row; once a click pins it, its header has a close key. */
.execution-changes-patch.is-floating { --patch-bg: var(--ui-bg); position: fixed; z-index: 60; margin: 0; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg); box-shadow: 0 12px 32px rgb(0 0 0 / .35); overflow: hidden; font-size: 12px; line-height: 1.4; }
.execution-changes-preview-head { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 3px 6px 3px 10px; border-bottom: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); }
.execution-changes-preview-head .execution-changes-path { direction: ltr; }
.execution-changes-close { display: inline-flex; padding: 3px; border-radius: 4px; color: var(--ui-text-dimmed); cursor: pointer; }
.execution-changes-close:hover { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
.execution-changes-others { margin-top: 6px; color: var(--ui-text-dimmed); font-size: 11px; }
.execution-changes-others button { display: inline-flex; align-items: center; gap: 4px; padding: 0; color: inherit; cursor: pointer; }
.execution-changes-others button[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
.execution-changes-others p { margin: 2px 0 0; }
@media (pointer: coarse) { .execution-changes-row, .execution-changes-head { min-height: 30px; } }
</style>

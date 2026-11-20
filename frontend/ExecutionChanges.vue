<script setup>
/**
 * The files one execution changed, as "edited N files +a -b": a row per file with its added and removed lines. With a
 * mouse, pointing at a row previews its patch in a floating panel and a click keeps that panel open; on touch screens a
 * tap opens the patch inside the list (user 2026-11-17). Patches are read from the site on first use, owner only. Files
 * the member's own edit tools wrote are listed as its edits. When it also ran commands, the other files that changed
 * meanwhile follow in a folded list of their own, marked as possibly its doing: a script names no files, and another
 * window may have changed them instead (user 2026-11-18, #4881).
 */
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { t } from "./i18n.js";

// More files than this and the list starts folded.
const FOLDED_ABOVE = 5;
// Mouse preview: how long the pointer rests before it opens and may wander before it closes; its narrowest and widest
// width, the room it wants beside the file list before it sits beside the row instead, and its distance from the list
// and the window edges.
const PREVIEW_OPEN_MS = 250;
const PREVIEW_CLOSE_MS = 200;
// With a preview open, a row must hold the pointer this long to take over, so crossing rows on the way to the panel
// keeps the file being read.
const PREVIEW_SWITCH_MS = 150;
const PREVIEW_MIN_WIDTH = 720;
const PREVIEW_MAX_WIDTH = 1000;
const PREVIEW_MIN_HEIGHT = 240;
const PREVIEW_GAP = 4;
const PREVIEW_MARGIN = 16;

const props = defineProps({
  /** The execution report: `changes`, `edited` (null when the software could not tell), `commands` run, `diff_stats`, `id`. */
  report: { type: Object, required: true },
  roomId: { type: String, required: true },
});
const { bridge } = inject("discussion");

const stats = computed(() => new Map((props.report.diff_stats || []).map((item) => [item.path, item])));
const edited = computed(() => new Set(props.report.edited || []));
const file_rows = (paths) => paths.map((path) => ({ path, stat: stats.value.get(path) }));
const totals_of = (files) => files.reduce((sum, file) => ({ added: sum.added + (file.stat?.added || 0), removed: sum.removed + (file.stat?.removed || 0) }), { added: 0, removed: 0 });
// The member's own edits, then what may be its doing; each list has its own header, counts and fold.
const sections = computed(() => {
  const changes = props.report.changes || [];
  const own = file_rows(changes.filter((path) => edited.value.has(path)));
  const possible = props.report.commands > 0 ? file_rows(changes.filter((path) => !edited.value.has(path))) : [];
  return [
    { key: "own", files: own, title: t('已修改 {count} 个文件', { count: own.length }), hint: "" },
    { key: "possible", files: possible, title: t('其他改动 {count} 个文件', { count: possible.length }),
      hint: t('这次执行运行过命令，这些文件在执行期间有变化，但无法确认是它改的，也可能来自其他窗口或成员。') },
  ].filter((section) => section.files.length).map((section) => ({ ...section, totals: totals_of(section.files),
    counted: section.files.some((file) => Number.isInteger(file.stat?.added)) }));
});

const open = ref(new Set());
// A long list starts folded to its header row; the header opens and closes it (user 2026-11-17: 14 files filled the
// screen with no way to fold them). What may be someone else's work always starts folded.
const open_sections = ref(new Set(sections.value.filter((section) => section.key === "own" && section.files.length <= FOLDED_ABOVE).map((section) => section.key)));
function toggle_section(key) {
  const next = new Set(open_sections.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  open_sections.value = next;
}
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
/**
 * Place the preview below or above the whole file list, on the side with more room, so the other rows stay in reach
 * while it is open; it is at least as wide as the list and as tall as that side allows (user 2026-11-20, #5931). A list
 * too tall to leave room on either side falls back to the row itself.
 */
function position() {
  if (!anchor?.isConnected) return close_preview();
  const list = anchor.closest("ul")?.getBoundingClientRect();
  const row = anchor.getBoundingClientRect();
  const room_of = (rect) => ({ below: window.innerHeight - rect.bottom - PREVIEW_GAP - PREVIEW_MARGIN, above: rect.top - PREVIEW_GAP - PREVIEW_MARGIN });
  const fits = (space) => Math.max(space.below, space.above) >= PREVIEW_MIN_HEIGHT;
  const rect = list && fits(room_of(list)) ? list : row;
  const space = room_of(rect);
  const width = Math.min(Math.max(PREVIEW_MIN_WIDTH, (list || row).width), PREVIEW_MAX_WIDTH, window.innerWidth - PREVIEW_MARGIN * 2);
  const left = Math.max(PREVIEW_MARGIN, Math.min((list || row).left, window.innerWidth - PREVIEW_MARGIN - width));
  const edge = space.below >= space.above
    ? { top: `${rect.bottom + PREVIEW_GAP}px`, maxHeight: `${Math.max(space.below, 0)}px` }
    : { bottom: `${window.innerHeight - rect.top + PREVIEW_GAP}px`, maxHeight: `${Math.max(space.above, 0)}px` };
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
/** Resting on a row opens its preview after a moment (sooner when another preview is showing). */
function enter_row(path, event) {
  if (!mouse.matches || pinned.value) return;
  window.clearTimeout(close_timer);
  window.clearTimeout(open_timer);
  const row = event.currentTarget;
  open_timer = window.setTimeout(() => show_preview(path, row), floating.value ? PREVIEW_SWITCH_MS : PREVIEW_OPEN_MS);
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
  <div v-if="sections.length" class="execution-changes">
    <div v-for="section in sections" :key="section.key" class="execution-changes-box" :class="`is-${section.key}`">
    <button type="button" class="execution-changes-head" :aria-expanded="open_sections.has(section.key)" :title="section.hint" @click="toggle_section(section.key)">
      <span class="execution-changes-title">{{ section.title }}</span>
      <span v-if="section.counted" class="execution-changes-count"><b class="is-add">+{{ section.totals.added }}</b> <b class="is-del">-{{ section.totals.removed }}</b></span>
      <UIcon name="i-lucide-chevron-down" class="execution-changes-chevron" />
    </button>
    <p v-if="section.hint && open_sections.has(section.key)" class="execution-changes-hint">{{ section.hint }}</p>
    <ul v-if="open_sections.has(section.key)" class="execution-changes-list">
      <li v-for="file in section.files" :key="file.path">
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
            <!-- A patch too long to keep is stored empty (a minified file is one huge line), so there are no lines to draw. -->
            <p v-if="!patches.get(file.path).patch" class="execution-changes-note">{{ patches.get(file.path).truncated ? t('改动太长，无法显示差异') : t('没有逐行内容变化') }}</p>
            <pre v-else><code><span v-for="(line, index) in patch_lines(patches.get(file.path).patch)" :key="index" :class="`is-${line.kind}`"><span class="execution-changes-number" aria-hidden="true">{{ line.number }}</span><span class="execution-changes-text">{{ line.text }}</span>
</span></code></pre>
            <p v-if="patches.get(file.path).patch && patches.get(file.path).truncated" class="execution-changes-note">{{ t('改动较长，只显示前面一部分') }}</p>
          </template>
        </div>
        </Teleport>
      </li>
    </ul>
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
.execution-changes-box.is-possible .execution-changes-title { color: var(--ui-text-dimmed); }
.execution-changes-hint { margin: 0; padding: 0 6px 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.execution-changes-head[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
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
.execution-changes-patch.is-floating { --patch-bg: var(--ui-bg); position: fixed; z-index: 60; display: flex; flex-direction: column; margin: 0; border: 1px solid var(--ui-border); border-radius: 8px; background: var(--ui-bg); box-shadow: 0 12px 32px rgb(0 0 0 / .35); overflow: hidden; font-size: 12px; line-height: 1.4; }
/* Floating, the patch takes whatever height the panel was given instead of the inline 360px. */
.execution-changes-patch.is-floating pre { flex: 1 1 auto; min-height: 0; max-height: none; font-size: 12px; }
.execution-changes-patch.is-floating .execution-changes-preview-head { flex-shrink: 0; }
.execution-changes-preview-head { display: flex; align-items: center; gap: 8px; min-height: 28px; padding: 3px 6px 3px 10px; border-bottom: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); }
.execution-changes-preview-head .execution-changes-path { direction: ltr; }
.execution-changes-close { display: inline-flex; padding: 3px; border-radius: 4px; color: var(--ui-text-dimmed); cursor: pointer; }
.execution-changes-close:hover { color: var(--ui-text-highlighted); background: var(--ui-bg-accented); }
@media (pointer: coarse) { .execution-changes-row, .execution-changes-head { min-height: 30px; } }
</style>

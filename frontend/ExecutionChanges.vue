<script setup>
/**
 * The files one execution changed, as "edited N files +a -b": a row per file with its added and removed lines, opened
 * by a click to its patch (read from the site on first open, owner only). Files the member's own edit tools did not
 * write (another window or member working in the same folder) stand apart in one muted line.
 */
import { computed, inject, ref } from "vue";
import { t } from "./i18n.js";

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
// Files others changed meanwhile stay folded to one count line; the names are there for whoever asks.
const others_open = ref(false);
const patches = ref(null), loading = ref(false), failure = ref("");
/** Open or close one file; the patches of the whole execution are read once, on the first open. */
async function toggle(path) {
  const next = new Set(open.value);
  if (next.has(path)) next.delete(path); else next.add(path);
  open.value = next;
  if (patches.value || loading.value) return;
  loading.value = true;
  failure.value = "";
  try {
    const result = await bridge.request(`/api/rooms/${encodeURIComponent(props.roomId)}/executions/${props.report.id}/diff`);
    patches.value = new Map((result.diffs || []).map((item) => [item.path, item]));
  } catch (error) { failure.value = error.message; }
  finally { loading.value = false; }
}
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
    <div v-if="files.length" class="execution-changes-box">
    <div class="execution-changes-head">
      <span>{{ t('已修改 {count} 个文件', { count: files.length }) }}</span>
      <span v-if="counted" class="execution-changes-count"><b class="is-add">+{{ totals.added }}</b> <b class="is-del">-{{ totals.removed }}</b></span>
    </div>
    <ul class="execution-changes-list">
      <li v-for="file in files" :key="file.path">
        <button type="button" class="execution-changes-row" :aria-expanded="open.has(file.path)" :title="file.path" @click="toggle(file.path)">
          <span class="execution-changes-path"><span class="execution-changes-folder">{{ folder(file.path) }}</span>{{ name(file.path) }}</span>
          <span v-if="file.stat?.skipped" class="execution-changes-note">{{ file.stat.skipped === 'binary' ? t('二进制文件') : t('文件过大') }}</span>
          <span v-else-if="Number.isInteger(file.stat?.added)" class="execution-changes-count"><b class="is-add">+{{ file.stat.added }}</b> <b class="is-del">-{{ file.stat.removed }}</b></span>
          <UIcon v-if="file.stat && !file.stat.skipped" name="i-lucide-chevron-down" class="execution-changes-chevron" />
        </button>
        <div v-if="open.has(file.path) && file.stat && !file.stat.skipped" class="execution-changes-patch">
          <p v-if="loading && !patches" class="execution-changes-note">{{ t('正在读取改动…') }}</p>
          <p v-else-if="failure" class="execution-changes-note">{{ t('读取改动失败：{value1}', { value1: failure }) }}</p>
          <template v-else-if="patches?.get(file.path)">
            <pre><code><span v-for="(line, index) in patch_lines(patches.get(file.path).patch)" :key="index" :class="`is-${line.kind}`"><span class="execution-changes-number" aria-hidden="true">{{ line.number }}</span><span class="execution-changes-text">{{ line.text }}</span>
</span></code></pre>
            <p v-if="patches.get(file.path).truncated" class="execution-changes-note">{{ t('改动较长，只显示前面一部分') }}</p>
          </template>
        </div>
      </li>
    </ul>
    </div>
    <div v-if="others.length" class="execution-changes-others">
      <button type="button" :aria-expanded="others_open" :title="t('这些文件在同一时间被改动，但不是这位成员的编辑工具写的，可能来自其他窗口或成员')" @click="others_open = !others_open">{{ t('另有 {count} 个文件同期被改动，不是它写的', { count: others.length }) }}<UIcon name="i-lucide-chevron-down" class="execution-changes-chevron" /></button>
      <p v-if="others_open">{{ others.join('、') }}</p>
    </div>
  </div>
</template>

<style scoped>
/* As Codex shows a turn's changes: the list always fills the card, a file's diff opens inside that same width and
   scrolls sideways on its own, so opening or closing a file never changes the card's width (user 2026-11-16: on phones
   the list was narrower closed than open). */
.execution-changes { width: 100%; min-width: 0; margin-top: 4px; }
/* One box like Codex's: the summary is its header row, each file a row below it, no box nested in a box. */
.execution-changes-box { width: 100%; border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; }
.execution-changes-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 32px; padding: 4px 10px; background: var(--ui-bg-elevated); color: var(--ui-text-toned); }
.execution-changes-list { width: 100%; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--ui-border-muted); }
.execution-changes-list > li { min-width: 0; }
.execution-changes-list > li + li { border-top: 1px solid var(--ui-border-muted); }
.execution-changes-row { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; min-height: 32px; padding: 4px 10px; text-align: left; cursor: pointer; }
.execution-changes-row:hover, .execution-changes-row[aria-expanded="true"] { background: var(--ui-bg-elevated); }
.execution-changes-path { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.execution-changes-folder { color: var(--ui-text-dimmed); }
.execution-changes-count { flex-shrink: 0; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.execution-changes-count .is-add { color: var(--ui-success, #3fb27f); font-weight: 500; }
.execution-changes-count .is-del { color: var(--ui-error, #e5534b); font-weight: 500; }
.execution-changes-note { flex-shrink: 0; margin: 0; color: var(--ui-text-dimmed); font-size: 11px; }
.execution-changes-chevron { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); transition: transform .15s; }
.execution-changes-row[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
.execution-changes-patch { min-width: 0; border-top: 1px solid var(--ui-border-muted); }
.execution-changes-patch pre { max-width: 100%; max-height: 360px; margin: 0; overflow: auto; font: 11.5px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; overscroll-behavior: contain; scrollbar-width: thin; }
.execution-changes-patch code { display: block; min-width: max-content; }
.execution-changes-patch code > span { display: flex; white-space: pre; }
/* The line number stays put while a long line scrolls sideways. */
.execution-changes-number { position: sticky; left: 0; flex-shrink: 0; width: 5ch; padding: 0 8px 0 4px; background: var(--ui-bg); color: var(--ui-text-dimmed); text-align: right; user-select: none; }
.execution-changes-text { padding: 0 12px 0 6px; }
.execution-changes-patch .is-add { background: color-mix(in srgb, var(--ui-success, #3fb27f) 14%, transparent); color: var(--ui-text-highlighted); }
.execution-changes-patch .is-add .execution-changes-number { background: color-mix(in srgb, var(--ui-success, #3fb27f) 22%, var(--ui-bg)); }
.execution-changes-patch .is-del { background: color-mix(in srgb, var(--ui-error, #e5534b) 14%, transparent); color: var(--ui-text-highlighted); }
.execution-changes-patch .is-del .execution-changes-number { background: color-mix(in srgb, var(--ui-error, #e5534b) 22%, var(--ui-bg)); }
.execution-changes-patch .is-hunk { color: var(--ui-text-dimmed); font-size: 10.5px; background: color-mix(in srgb, var(--ui-primary) 8%, transparent); }
.execution-changes-patch .is-hunk .execution-changes-number { background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-bg)); }
.execution-changes-patch .is-ctx { color: var(--ui-text-muted); }
.execution-changes-patch > p { padding: 6px 10px; }
.execution-changes-others { margin-top: 6px; color: var(--ui-text-dimmed); font-size: 11px; }
.execution-changes-others button { display: inline-flex; align-items: center; gap: 4px; padding: 0; color: inherit; cursor: pointer; }
.execution-changes-others button[aria-expanded="true"] .execution-changes-chevron { transform: rotate(180deg); }
.execution-changes-others p { margin: 2px 0 0; }
@media (pointer: coarse) { .execution-changes-row { min-height: 40px; } }
</style>

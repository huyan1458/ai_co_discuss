<script setup>
import { computed, inject, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps({ directory: { type: String, required: true } });
const { view, bridge } = inject("discussion");
const room_id = view.value.room.id;
const listing = ref(null);
const loading = ref(false);
const preview_open = ref(false);
const preview_path = ref("");
const preview = ref(null);
const preview_loading = ref(false);
const preview_error = ref("");
const source = ref(false);
// Like VS Code's word wrap toggle; narrow screens start wrapped so code is readable without sideways scrolling.
const wrap = ref(window.matchMedia("(max-width: 640px)").matches);
let directory_request = 0;
let preview_request = 0;

// Extension → [language label shown in the status bar, icon, icon tint]; unknown files fall back to plain text.
const FILE_TYPES = {
  md: ["Markdown", "i-lucide-file-text", "is-blue"], markdown: ["Markdown", "i-lucide-file-text", "is-blue"],
  html: ["HTML", "i-lucide-file-code", "is-orange"], htm: ["HTML", "i-lucide-file-code", "is-orange"],
  css: ["CSS", "i-lucide-file-code", "is-blue"], vue: ["Vue", "i-lucide-file-code", "is-green"],
  js: ["JavaScript", "i-lucide-file-code", "is-yellow"], mjs: ["JavaScript", "i-lucide-file-code", "is-yellow"], cjs: ["JavaScript", "i-lucide-file-code", "is-yellow"],
  ts: ["TypeScript", "i-lucide-file-code", "is-blue"], tsx: ["TypeScript", "i-lucide-file-code", "is-blue"], jsx: ["JavaScript", "i-lucide-file-code", "is-yellow"],
  py: ["Python", "i-lucide-file-code", "is-blue"], sql: ["SQL", "i-lucide-database", "is-orange"],
  sh: ["Shell", "i-lucide-file-terminal", "is-green"], ps1: ["PowerShell", "i-lucide-file-terminal", "is-blue"], bat: ["Batch", "i-lucide-file-terminal", "is-green"],
  json: ["JSON", "i-lucide-file-json", "is-yellow"], jsonc: ["JSON", "i-lucide-file-json", "is-yellow"],
  yaml: ["YAML", "i-lucide-file-cog", "is-purple"], yml: ["YAML", "i-lucide-file-cog", "is-purple"], toml: ["TOML", "i-lucide-file-cog", "is-purple"],
  png: ["图片", "i-lucide-file-image", "is-purple"], jpg: ["图片", "i-lucide-file-image", "is-purple"], jpeg: ["图片", "i-lucide-file-image", "is-purple"],
  gif: ["图片", "i-lucide-file-image", "is-purple"], webp: ["图片", "i-lucide-file-image", "is-purple"], svg: ["SVG", "i-lucide-file-image", "is-orange"],
  zip: ["压缩包", "i-lucide-file-archive", "is-muted"], pdf: ["PDF", "i-lucide-file-text", "is-red"], txt: ["纯文本", "i-lucide-file-text", "is-muted"],
};

/** Look up the display type of a file by its extension. */
function file_type(name) {
  const extension = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase();
  return FILE_TYPES[extension] || ["纯文本", "i-lucide-file", "is-muted"];
}

/** Pick the row icon and tint for one listing entry. */
function entry_icon(entry) {
  if (entry.kind === "directory") return ["i-lucide-folder", "is-folder"];
  if (entry.kind === "unavailable") return ["i-lucide-file-lock-2", "is-muted"];
  return file_type(entry.name).slice(1);
}

/** Split a project-relative path into clickable crumbs, rooted at the project folder's own name. */
function crumbs_of(path) {
  const root = props.directory.split(/[\\/]/).filter(Boolean).pop() || "项目目录";
  const parts = path.split("/").filter(Boolean);
  return [{ name: root, path: "" }, ...parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join("/") }))];
}

const breadcrumbs = computed(() => crumbs_of(listing.value?.path || ""));
const preview_crumbs = computed(() => crumbs_of(preview_path.value));
const preview_name = computed(() => preview_path.value.split("/").pop() || "文件预览");
const preview_type = computed(() => file_type(preview_name.value));
const format = computed(() => /\.(md|markdown)$/i.test(preview_path.value) ? "markdown" : /\.html?$/i.test(preview_path.value) ? "html" : "text");
const rendered = computed(() => format.value === "markdown" && preview.value?.text ? window.discuss_markdown.render_markdown(preview.value.text) : "");
// The iframe has an opaque origin, no scripts or forms, and loads only inline styles and embedded images/fonts.
const html_preview = computed(() => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><meta charset="utf-8">${preview.value?.text || ""}`);
const can_render = computed(() => preview.value?.text != null && format.value !== "text" && !(format.value === "html" && preview.value.truncated));
const showing_source = computed(() => preview.value?.text != null && (!can_render.value || source.value));
// One gutter string keeps line numbers to a single DOM node even for the largest previews.
const lines = computed(() => preview.value?.text == null ? [] : preview.value.text.split("\n"));
const line_count = computed(() => lines.value.length);
const gutter = computed(() => Array.from({ length: line_count.value }, (_, index) => index + 1).join("\n"));
const encoding_label = computed(() => (preview.value?.encoding || "utf-8").toUpperCase());
onMounted(() => read_directory());
onBeforeUnmount(() => { directory_request++; preview_request++; });

/** Read one folder, retaining the previous listing when a refresh fails. */
async function read_directory(path = "", append = false) {
  const request = ++directory_request;
  loading.value = true;
  try {
    const result = await bridge.read_room_files(room_id, path, append ? listing.value.next_offset : 0);
    if (request !== directory_request) return;
    listing.value = { ...result, entries: append ? [...listing.value.entries, ...result.entries] : result.entries };
  } catch (error) {
    if (request === directory_request) bridge.notify("error", `读取目录失败，${error.message}`);
  } finally { if (request === directory_request) loading.value = false; }
}

/** Open a floating preview for the selected file and discard replies for previous selections. */
async function open_file(path) {
  const request = ++preview_request;
  preview_path.value = path;
  preview.value = null;
  preview_error.value = "";
  preview_loading.value = true;
  source.value = false;
  preview_open.value = true;
  try {
    const result = await bridge.read_room_files(room_id, path);
    if (request === preview_request) preview.value = result;
  } catch (error) {
    if (request === preview_request) preview_error.value = error.message;
  } finally { if (request === preview_request) preview_loading.value = false; }
}

/** Jump the listing to a folder named in the preview's breadcrumb and close the preview. */
function reveal_folder(path) {
  preview_open.value = false;
  read_directory(path);
}

/** Format file sizes without filling directory rows with a placeholder. */
function file_size(size) {
  if (size == null) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format the file's local modification time for the directory and preview status bar. */
function modified_time(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
}
</script>

<template>
  <section class="project-files">
    <header class="project-files-heading">
      <div><h2>项目文件</h2><p :title="directory">{{ directory }}</p></div>
      <UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" size="sm" aria-label="刷新" title="刷新" :loading="loading" @click="read_directory(listing?.path || '')" />
    </header>

    <div class="project-explorer" :aria-busy="loading">
      <nav class="project-explorer-path" aria-label="文件路径">
        <template v-for="(part, index) in breadcrumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button type="button" :disabled="loading || index === breadcrumbs.length - 1" :aria-current="index === breadcrumbs.length - 1 ? 'location' : undefined" @click="read_directory(part.path)">
            <UIcon v-if="!index" name="i-lucide-folder-root" />{{ part.name }}
          </button>
        </template>
      </nav>
      <div class="project-files-columns" aria-hidden="true"><span>名称</span><span>大小</span><span>修改时间</span></div>
      <div class="project-files-rows">
        <button v-for="entry in listing?.entries || []" :key="entry.path" type="button" class="project-file-row" :class="{ 'is-hidden': entry.name.startsWith('.') }"
          :disabled="loading || entry.kind === 'unavailable'" :title="entry.kind === 'unavailable' ? `${entry.name}（无法读取或指向项目外）` : entry.name"
          @click="entry.kind === 'directory' ? read_directory(entry.path) : open_file(entry.path)">
          <span class="project-file-name"><UIcon :name="entry_icon(entry)[0]" class="project-file-icon" :class="entry_icon(entry)[1]" /><span>{{ entry.name }}</span></span>
          <span class="project-file-size">{{ file_size(entry.size) }}</span><time :datetime="entry.modified_at">{{ modified_time(entry.modified_at) }}</time>
        </button>
        <p v-if="!listing" class="project-files-empty" role="status">{{ loading ? '正在读取项目目录…' : '点击刷新重新读取目录' }}</p>
        <p v-else-if="!listing.entries.length" class="project-files-empty"><UIcon name="i-lucide-folder-open" />此文件夹为空</p>
      </div>
      <footer v-if="listing" class="project-files-footer">
        <span>{{ listing.total }} 项<template v-if="listing.next_offset !== null">，已显示 {{ listing.entries.length }} 项</template></span>
        <UButton v-if="listing.next_offset !== null" label="加载更多" color="neutral" variant="ghost" size="xs" :loading="loading" @click="read_directory(listing.path, true)" />
      </footer>
    </div>
  </section>

  <UModal v-model:open="preview_open" :title="preview_name" :description="preview_path" :content="{ onInteractOutside: event => event.preventDefault() }"
    :ui="{ content: 'project-editor' }">
    <template #content>
      <div class="project-editor-tabs">
        <div class="project-editor-tab"><UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" /><span>{{ preview_name }}</span></div>
        <div class="project-editor-actions">
          <UButton v-if="showing_source" icon="i-lucide-wrap-text" color="neutral" :variant="wrap ? 'soft' : 'ghost'" size="sm" :aria-pressed="wrap"
            :title="wrap ? '关闭自动换行' : '自动换行'" aria-label="自动换行" @click="wrap = !wrap" />
          <div v-if="can_render" class="project-editor-modes" role="group" aria-label="显示方式">
            <button type="button" :aria-pressed="!source" title="预览" @click="source = false"><UIcon name="i-lucide-eye" class="project-mode-icon" /><span>预览</span></button>
            <button type="button" :aria-pressed="source" title="源码" @click="source = true"><UIcon name="i-lucide-code-xml" class="project-mode-icon" /><span>源码</span></button>
          </div>
          <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="sm" aria-label="关闭预览" @click="preview_open = false" />
        </div>
      </div>
      <nav class="project-editor-breadcrumbs" aria-label="文件位置">
        <template v-for="(part, index) in preview_crumbs" :key="part.path">
          <UIcon v-if="index" name="i-lucide-chevron-right" class="project-crumb-separator" />
          <button v-if="index < preview_crumbs.length - 1" type="button" title="在列表中打开此文件夹" @click="reveal_folder(part.path)">{{ part.name }}</button>
          <span v-else><UIcon :name="preview_type[1]" class="project-file-icon" :class="preview_type[2]" />{{ part.name }}</span>
        </template>
      </nav>
      <p v-if="preview?.truncated" class="project-editor-banner"><UIcon name="i-lucide-info" />文件较大，仅显示前 {{ file_size(preview.limit) }}（共 {{ file_size(preview.size) }}）<template v-if="format === 'html'">，HTML 不渲染不完整的内容</template></p>
      <p v-else-if="can_render && !source && format === 'html'" class="project-editor-banner"><UIcon name="i-lucide-shield" />静态预览：脚本、外部样式与外部图片不加载</p>

      <div class="project-editor-body">
        <div v-if="preview_loading" class="project-editor-state" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />正在读取文件…</div>
        <div v-else-if="preview_error" class="project-editor-state"><UIcon name="i-lucide-circle-alert" /><p>{{ preview_error }}</p><UButton label="重试" color="neutral" variant="outline" size="sm" @click="open_file(preview_path)" /></div>
        <div v-else-if="preview?.text === null" class="project-editor-state"><UIcon :name="preview_type[1]" /><p>{{ preview.reason }}</p></div>
        <div v-else-if="showing_source && wrap" class="project-code is-wrapped" tabindex="0" aria-label="文件内容" :style="{ '--digits': String(line_count).length }">
          <div v-for="(line, index) in lines" :key="index" class="project-code-row"><span class="project-code-number" aria-hidden="true">{{ index + 1 }}</span><span class="project-code-line">{{ line }}</span></div>
        </div>
        <div v-else-if="showing_source" class="project-code" tabindex="0" aria-label="文件内容">
          <pre class="project-code-gutter" aria-hidden="true">{{ gutter }}</pre>
          <pre class="project-code-text"><code>{{ preview.text }}</code></pre>
        </div>
        <iframe v-else-if="preview && format === 'html'" class="project-html-preview" sandbox="" referrerpolicy="no-referrer" :srcdoc="html_preview" title="HTML 文件预览"></iframe>
        <div v-else-if="preview" class="project-markdown-scroll" tabindex="0"><div class="markdown-body project-markdown-preview" v-html="rendered"></div></div>
      </div>

      <footer class="project-editor-status">
        <span v-if="preview" class="project-editor-modified" :title="preview.modified_at">修改于 {{ modified_time(preview.modified_at) }}</span>
        <span class="project-editor-status-spacer"></span>
        <template v-if="preview?.text != null">
          <span>{{ line_count }} 行</span><span class="project-editor-encoding">{{ encoding_label }}</span>
        </template>
        <span v-if="preview">{{ file_size(preview.size) }}</span>
        <span>{{ preview_type[0] }}</span>
      </footer>
    </template>
  </UModal>
</template>

<style scoped>
.project-files { --row-height: 34px; }
.project-files-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.project-files-heading > div { min-width: 0; }
.project-files-heading h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.project-files-heading p { margin: 0; color: var(--ui-text-muted); font: 12px ui-monospace, Consolas, monospace; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

.project-explorer { overflow: hidden; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.project-explorer-path { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; min-height: 42px; padding: 6px 10px; border-bottom: 1px solid var(--ui-border); font-size: 13px; }
.project-explorer-path button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 5px; color: var(--ui-text-muted); cursor: pointer; overflow-wrap: anywhere; }
.project-explorer-path button:hover:not(:disabled) { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-explorer-path button[aria-current] { color: var(--ui-text-highlighted); font-weight: 600; cursor: default; }
.project-explorer-path button:disabled:not([aria-current]) { cursor: default; }
.project-explorer-path button > span { width: 15px; height: 15px; color: var(--ui-primary); }
.project-crumb-separator { flex-shrink: 0; width: 13px; height: 13px; color: var(--ui-text-dimmed); }

.project-files-columns, .project-file-row { display: grid; grid-template-columns: minmax(0, 1fr) 84px 136px; align-items: center; gap: 16px; padding: 0 14px; }
.project-files-columns { height: 30px; color: var(--ui-text-dimmed); font-size: 11px; letter-spacing: .02em; border-bottom: 1px solid var(--ui-border); }
.project-files-columns > :nth-child(2), .project-file-size { text-align: right; }
.project-files-rows { padding: 4px; }
.project-file-row { width: 100%; height: var(--row-height); text-align: left; font-size: 13px; cursor: pointer; border-radius: 6px; padding-inline: 10px; }
.project-file-row:hover:not(:disabled) { background: var(--ui-bg-accented); }
.project-file-row:focus-visible { outline: 1px solid var(--ui-primary); outline-offset: -1px; }
.project-file-row:disabled { opacity: .45; cursor: default; }
.project-file-row.is-hidden .project-file-name > span:last-child { color: var(--ui-text-muted); }
.project-file-name { display: flex; align-items: center; gap: 9px; min-width: 0; }
.project-file-name > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-file-icon { flex-shrink: 0; width: 16px; height: 16px; }
.project-file-row time, .project-file-size { color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.is-folder { color: #dcb67a; }
.is-blue { color: #519aba; }
.is-orange { color: #e37933; }
.is-yellow { color: #cbcb41; }
.is-green { color: #8dc149; }
.is-purple { color: #a074c4; }
.is-red { color: #cc3e44; }
.is-muted { color: var(--ui-text-muted); }
.project-files-footer { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 14px; border-top: 1px solid var(--ui-border); color: var(--ui-text-dimmed); font-size: 12px; }
.project-files-empty { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 40px 12px; font-size: 13px; color: var(--ui-text-muted); }

/* Preview: a VS Code editor group — tab strip, breadcrumbs, gutter + text, status bar. */
:global(.project-editor) { display: flex; flex-direction: column; width: min(1120px, calc(100vw - 48px)); max-width: none; height: calc(100dvh - 64px); max-height: none; overflow: hidden;
  padding: 0; border: 1px solid var(--ui-border-accented); border-radius: 10px; background: var(--ui-bg); box-shadow: 0 24px 80px #0000008c; }
.project-editor-tabs { display: flex; align-items: stretch; justify-content: space-between; flex-shrink: 0; height: 38px; background: var(--ui-bg-elevated); border-bottom: 1px solid var(--ui-border); }
.project-editor-tab { position: relative; display: flex; align-items: center; gap: 8px; max-width: 60%; padding: 0 16px; background: var(--ui-bg); font-size: 13px; color: var(--ui-text-highlighted); border-right: 1px solid var(--ui-border); }
.project-editor-tab::before { content: ""; position: absolute; inset: 0 0 auto; height: 2px; background: var(--ui-primary); }
.project-editor-tab::after { content: ""; position: absolute; inset: auto 0 -1px; height: 1px; background: var(--ui-bg); }
.project-editor-tab > span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-editor-actions { display: flex; align-items: center; gap: 6px; padding: 0 6px; }
.project-editor-modes { display: flex; padding: 2px; border-radius: 6px; background: var(--ui-bg-accented); }
.project-editor-modes button { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); cursor: pointer; }
.project-mode-icon { flex-shrink: 0; width: 14px; height: 14px; }
.project-editor-modes button:hover { color: var(--ui-text); }
.project-editor-modes button[aria-pressed="true"] { background: var(--ui-bg); color: var(--ui-text-highlighted); box-shadow: 0 1px 2px #0000003d; }
.project-editor-breadcrumbs { display: flex; flex-wrap: nowrap; align-items: center; gap: 2px; flex-shrink: 0; height: 26px; padding: 0 14px; overflow-x: auto; scrollbar-width: none; font-size: 12px; color: var(--ui-text-muted); }
.project-editor-breadcrumbs > * { flex-shrink: 0; }
.project-editor-breadcrumbs button { padding: 1px 4px; border-radius: 4px; white-space: nowrap; cursor: pointer; }
.project-editor-breadcrumbs button:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.project-editor-breadcrumbs > span:not(.project-crumb-separator) { display: inline-flex; align-items: center; gap: 5px; padding: 1px 4px; white-space: nowrap; color: var(--ui-text); }
.project-editor-breadcrumbs .project-file-icon { width: 14px; height: 14px; }
.project-editor-banner { display: flex; align-items: center; gap: 8px; flex-shrink: 0; margin: 0; padding: 6px 14px; font-size: 12px; color: var(--ui-text-muted);
  background: color-mix(in srgb, var(--ui-primary) 9%, transparent); border-block: 1px solid color-mix(in srgb, var(--ui-primary) 22%, transparent); }
.project-editor-banner > span { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-primary); }
.project-editor-body { position: relative; flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--ui-border); }
.project-editor-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; font-size: 13px; color: var(--ui-text-muted); }
.project-editor-state > span:first-child { width: 28px; height: 28px; color: var(--ui-text-dimmed); }
.project-editor-state p { margin: 0; max-width: 480px; }
.project-code { display: flex; flex: 1; align-items: flex-start; min-width: 0; overflow: auto; font: 13px/20px ui-monospace, "Cascadia Code", Consolas, monospace; tab-size: 4; }
.project-code:focus-visible, .project-markdown-scroll:focus-visible { outline: none; }
.project-code pre { margin: 0; padding: 10px 0 24px; white-space: pre; font: inherit; }
.project-code-gutter { position: sticky; left: 0; z-index: 1; flex-shrink: 0; min-width: 52px; padding-inline: 16px 14px !important; text-align: right; color: var(--ui-text-dimmed); background: var(--ui-bg); user-select: none; }
.project-code-text { flex: 1; padding-right: 32px !important; color: var(--ui-text); }
/* Wrapped: one row per source line keeps each number level with the first visual row of its line. */
.project-code.is-wrapped { display: block; padding: 10px 0 24px; }
.project-code-row { display: flex; }
.project-code-number { flex-shrink: 0; box-sizing: content-box; width: calc(var(--digits) * 1ch); min-width: 2ch; padding: 0 14px 0 16px; text-align: right; color: var(--ui-text-dimmed); user-select: none; }
.project-code-line { flex: 1; min-width: 0; padding-right: 20px; color: var(--ui-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.project-markdown-scroll { flex: 1; min-width: 0; overflow: auto; }
.project-markdown-preview { max-width: 860px; margin: 0 auto; padding: 28px 40px 48px; overflow-wrap: anywhere; }
.project-html-preview { display: block; flex: 1; width: 100%; border: 0; background: white; }
.project-editor-status { display: flex; align-items: center; gap: 16px; flex-shrink: 0; height: 26px; padding: 0 14px; font-size: 11.5px; color: var(--ui-text-muted);
  background: var(--ui-bg-elevated); border-top: 1px solid var(--ui-border); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; }
.project-editor-status-spacer { flex: 1; }

@media (max-width: 640px) {
  .project-files-columns, .project-file-row { grid-template-columns: minmax(0, 1fr) 64px; gap: 8px; }
  .project-files-columns > :last-child, .project-file-row > time { display: none; }
  :global(.project-editor) { width: 100vw; height: 100dvh; border: 0; border-radius: 0; }
  .project-editor-tab { max-width: 46%; padding: 0 12px; }
  .project-editor-actions { gap: 4px; padding: 0 4px; }
  .project-editor-modes button { padding: 0 8px; }
  .project-editor-modes button > span:not(.project-mode-icon) { display: none; }
  .project-markdown-preview { padding: 18px 16px 32px; }
  .project-code { font-size: 12px; line-height: 18px; }
  .project-code-gutter { min-width: 40px; padding-inline: 10px !important; }
  .project-code-number { padding: 0 10px; }
  .project-editor-modified, .project-editor-encoding { display: none; }
}
</style>

<script setup>
/**
 * Free a room's attachment space, as chat apps' storage managers do: the room's sent files, filtered by kind and age and
 * sorted by size, picked and cleared at once. A cleared file keeps its message card, number and thumbnail; only the
 * original bytes go. Shared by the room page and the management panel, each passing its own way to reach the site.
 *
 * Props:
 *   load: async () => { attachments: [...], bytes } — the room's sent files (owner view).
 *   clear: async (ids) => { cleared: [...], freed_bytes } — clears the chosen files.
 * Emits `cleared(result)` after a successful clear, `failed(message)` when loading or clearing fails.
 */
import { computed, onMounted, ref } from "vue";
import { t } from "./i18n.js";
import { format_storage_bytes } from "./storage-format.js";

const props = defineProps({ load: { type: Function, required: true }, clear: { type: Function, required: true } });
const emit = defineEmits(["cleared", "failed"]);
const DAY_MS = 86400000;
const KINDS = [["all", t("全部")], ["image", t("图片")], ["video", t("音视频")], ["archive", t("压缩包")], ["document", t("文档")], ["other", t("其他")]];
const AGES = [[0, t("全部时间")], [7, t("7 天前")], [30, t("30 天前")]];
const ARCHIVE = /\.(zip|7z|rar|tar|gz|tgz|xz|bz2|\d{3})$/i;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|md|txt|csv|json|html?)$/i;

const files = ref([]);
const loading = ref(true);
const clearing = ref(false);
const confirming = ref(false);
const kind = ref("all");
const age = ref(0);
const chosen = ref(new Set());

/** Which filter group a file falls in, from its type and then its name. */
function kind_of(file) {
  if (file.content_type.startsWith("image/")) return "image";
  if (/^(video|audio)\//.test(file.content_type)) return "video";
  if (ARCHIVE.test(file.file_name)) return "archive";
  if (file.content_type === "application/pdf" || DOCUMENT.test(file.file_name)) return "document";
  return "other";
}

const kept = computed(() => files.value.filter(file => !file.cleared_at));
const shown = computed(() => {
  const cutoff = age.value ? Date.now() - age.value * DAY_MS : Infinity;
  return kept.value.filter(file => (kind.value === "all" || kind_of(file) === kind.value) && Date.parse(file.created_at) < cutoff)
    .sort((a, b) => b.size - a.size);
});
const kind_bytes = computed(() => Object.fromEntries(KINDS.map(([key]) => [key,
  kept.value.filter(file => key === "all" || kind_of(file) === key).reduce((sum, file) => sum + file.size, 0)])));
const chosen_bytes = computed(() => kept.value.filter(file => chosen.value.has(file.id)).reduce((sum, file) => sum + file.size, 0));
const all_shown_chosen = computed(() => shown.value.length > 0 && shown.value.every(file => chosen.value.has(file.id)));
const cleared_count = computed(() => files.value.length - kept.value.length);

function toggle(id) {
  const next = new Set(chosen.value);
  next.has(id) ? next.delete(id) : next.add(id);
  chosen.value = next;
  confirming.value = false;
}

function toggle_shown() {
  const next = new Set(chosen.value);
  for (const file of shown.value) all_shown_chosen.value ? next.delete(file.id) : next.add(file.id);
  chosen.value = next;
  confirming.value = false;
}

async function reload() {
  loading.value = true;
  try { files.value = (await props.load()).attachments || []; }
  catch (failure) { emit("failed", failure.message); }
  finally { loading.value = false; }
}

async function clear_chosen() {
  if (!confirming.value) { confirming.value = true; return; }
  const ids = [...chosen.value];
  clearing.value = true;
  try {
    const result = await props.clear(ids);
    const done = new Set(result.cleared || []);
    const now = new Date().toISOString();
    // Show the outcome at once; the next room read brings the same state from the site.
    files.value = files.value.map(file => done.has(file.id) ? { ...file, cleared_at: file.cleared_at || now } : file);
    chosen.value = new Set();
    emit("cleared", result);
  } catch (failure) { emit("failed", failure.message); }
  finally { clearing.value = false; confirming.value = false; }
}

function date_label(value) {
  return new Date(value).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

onMounted(reload);
defineExpose({ reload });
</script>

<template>
  <div class="attachment-cleaner">
    <p class="cleaner-note">{{ t("清理后消息仍在，附件卡片保留文件名、大小和图片缩略图并标“已清理”，原文件无法再打开或下载，成员也读不到；此操作无法撤销。") }}</p>
    <div class="cleaner-filters" role="group" :aria-label="t('按类型筛选')">
      <button v-for="[key, label] in KINDS" :key="key" type="button" class="cleaner-chip" :aria-pressed="kind === key" @click="kind = key">
        {{ label }}<small>{{ format_storage_bytes(kind_bytes[key]) }}</small>
      </button>
    </div>
    <div class="cleaner-filters" role="group" :aria-label="t('按时间筛选')">
      <button v-for="[days, label] in AGES" :key="days" type="button" class="cleaner-chip" :aria-pressed="age === days" @click="age = days">{{ label }}</button>
    </div>
    <p v-if="loading" class="cleaner-empty">{{ t("正在读取附件…") }}</p>
    <p v-else-if="!shown.length" class="cleaner-empty">{{ kept.length ? t("没有符合条件的附件") : t("本房间没有可清理的附件") }}</p>
    <template v-else>
      <label class="cleaner-row cleaner-all">
        <input type="checkbox" :checked="all_shown_chosen" @change="toggle_shown">
        <span>{{ t("全选当前 {count} 项", { count: shown.length }) }}</span>
      </label>
      <ul class="cleaner-list">
        <li v-for="file in shown" :key="file.id">
          <label class="cleaner-row">
            <input type="checkbox" :checked="chosen.has(file.id)" @change="toggle(file.id)">
            <span class="cleaner-name" :title="file.file_name">{{ file.file_name }}</span>
            <small class="cleaner-meta">#{{ file.number }} · {{ date_label(file.created_at) }}</small>
            <span class="cleaner-size">{{ format_storage_bytes(file.size) }}</span>
          </label>
        </li>
      </ul>
    </template>
    <p v-if="cleared_count" class="cleaner-empty">{{ t("已清理 {count} 项", { count: cleared_count }) }}</p>
    <footer class="cleaner-footer">
      <span>{{ t("已选 {count} 项，将释放 {size}", { count: chosen.size, size: format_storage_bytes(chosen_bytes) }) }}</span>
      <button type="button" class="cleaner-clear" :class="{ 'is-confirming': confirming }" :disabled="!chosen.size || clearing" @click="clear_chosen">
        {{ clearing ? t("清理中…") : confirming ? t("确认清理（无法撤销）") : t("清理所选") }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.attachment-cleaner { display: flex; flex-direction: column; gap: 10px; font-size: 13px; }
.cleaner-note, .cleaner-empty { margin: 0; opacity: .7; font-size: 12px; line-height: 1.5; }
.cleaner-filters { display: flex; flex-wrap: wrap; gap: 6px; }
.cleaner-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 3px 10px; color: inherit; font: inherit; font-size: 12px; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 999px; cursor: pointer; }
.cleaner-chip small { opacity: .6; font-variant-numeric: tabular-nums; }
.cleaner-chip[aria-pressed="true"] { color: #3973f9; border-color: #3973f9; background: color-mix(in srgb, #3973f9 10%, transparent); }
.cleaner-list { max-height: min(50vh, 420px); margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.cleaner-row { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 2px 4px; border-radius: 6px; cursor: pointer; }
.cleaner-row:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
.cleaner-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cleaner-meta { flex-shrink: 0; opacity: .55; font-variant-numeric: tabular-nums; }
.cleaner-size { flex-shrink: 0; width: 76px; text-align: right; font-variant-numeric: tabular-nums; }
.cleaner-all { opacity: .8; }
.cleaner-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.cleaner-clear { padding: 5px 14px; color: #f05252; font: inherit; font-size: 12px; background: transparent; border: 1px solid #f05252; border-radius: 6px; cursor: pointer; }
.cleaner-clear.is-confirming { color: #fff; background: #f05252; }
.cleaner-clear:disabled { opacity: .45; cursor: default; }
</style>

<script setup>
/**
 * The guest's file tab, only when the owner opened the project (API.md §3 G/files): the opened roots, a folder's
 * entries, and a text file's content. Paths are relative to a root; the computer decides what may be read.
 */
import { computed, onMounted, ref, shallowRef } from "vue";
import { t } from "../i18n.js";

const props = defineProps({ visit: { type: Object, required: true } });
const roots = shallowRef([]);
const root = ref(null), path = ref("");
const entries = shallowRef([]);
const file = shallowRef(null);
const loading = ref(false), failure = ref("");
const ERRORS = { guest_forbidden: t("房主没有开放项目文件。"), not_found: t("文件不存在或已被移动。") };

async function call(query, apply) {
  loading.value = true;
  failure.value = "";
  try {
    const data = await props.visit.request("GET", query.content ? "/files/content" : "/files", { query: query.params });
    if (!props.visit.ended()) apply(data);
  } catch (error) { failure.value = ERRORS[error.code] || t("读取失败，可以再试一次。"); }
  finally { loading.value = false; }
}
const list_roots = () => call({ params: {} }, (data) => { roots.value = data.roots || []; root.value = null; path.value = ""; file.value = null; });
const open_dir = (root_id, dir = "") => call({ params: { root: root_id, path: dir } }, (data) => { root.value = root_id; path.value = dir; entries.value = data.items || []; file.value = null; });
const open_file = (item) => call({ content: true, params: { root: root.value, path: item.path } }, (data) => { file.value = data; });
onMounted(list_roots);

const root_name = computed(() => roots.value.find((item) => item.id === root.value)?.name || "");
const crumbs = computed(() => path.value ? path.value.split("/").filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join("/") })) : []);
const sorted = computed(() => [...entries.value].sort((left, right) => (left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1)));
const size = (bytes) => bytes == null ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
</script>

<template>
  <div class="guest-files">
    <nav class="guest-crumbs">
      <button type="button" @click="list_roots">{{ t("开放目录") }}</button>
      <template v-if="root !== null"><span>/</span><button type="button" @click="open_dir(root)">{{ root_name }}</button></template>
      <template v-for="crumb in crumbs" :key="crumb.path"><span>/</span><button type="button" @click="open_dir(root, crumb.path)">{{ crumb.name }}</button></template>
      <template v-if="file"><span>/</span><b>{{ file.path.split("/").pop() }}</b></template>
    </nav>
    <p v-if="failure" class="guest-empty" role="alert">{{ failure }}</p>
    <p v-else-if="loading" class="guest-empty">{{ t("正在读取…") }}</p>
    <template v-else-if="file">
      <pre v-if="file.encoding === 'utf-8'" class="guest-file-text">{{ file.content }}</pre>
      <p v-else class="guest-empty">{{ t("二进制文件（{size}），不在页面中预览。", { size: size(file.size_bytes) }) }}</p>
    </template>
    <ul v-else-if="root === null">
      <li v-for="item in roots" :key="item.id"><button type="button" @click="open_dir(item.id)"><UIcon name="i-lucide-folder" />{{ item.name }}</button></li>
    </ul>
    <ul v-else>
      <li v-if="!sorted.length" class="guest-empty">{{ t("空文件夹") }}</li>
      <li v-for="item in sorted" :key="item.path">
        <button type="button" @click="item.kind === 'directory' ? open_dir(root, item.path) : open_file(item)">
          <UIcon :name="item.kind === 'directory' ? 'i-lucide-folder' : 'i-lucide-file-text'" />{{ item.name }}<small>{{ size(item.size_bytes) }}</small>
        </button>
      </li>
    </ul>
    <p class="guest-fine">{{ t("只读：已跟踪与未忽略的文件，固定排除 .env、密钥、凭据、data/ 与 .git。") }}</p>
  </div>
</template>

<style scoped>
.guest-files { box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 12px max(16px, calc((100% - 960px) / 2)); overflow-y: auto; scrollbar-gutter: stable both-edges; }
.guest-crumbs { display: flex; flex: none; align-items: center; gap: 4px; color: var(--ui-text-muted); font-size: 13px; white-space: nowrap; overflow: auto hidden; scrollbar-width: none; }
.guest-crumbs button { color: var(--ui-primary); }
.guest-crumbs b { color: var(--ui-text-highlighted); }
.guest-files ul { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.guest-files li button { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 4px 8px; border-radius: 6px; color: var(--ui-text); font-size: 13px; text-align: left; }
.guest-files li button:hover { background: var(--ui-bg-elevated); }
.guest-files li button > span { flex: none; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.guest-files li button small { margin-left: auto; color: var(--ui-text-dimmed); font-size: 11px; }
.guest-file-text { margin: 0; padding: 10px; border: 1px solid var(--ui-border-muted); border-radius: 6px; background: var(--ui-bg-elevated); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.guest-empty { color: var(--ui-text-muted); text-align: center; }
.guest-fine { margin: auto 0 0; color: var(--ui-text-dimmed); font-size: 11px; }
</style>

<script setup>
import { computed, inject, ref, watch } from "vue";
import CreateDiscussion from "./CreateDiscussion.vue";
import DiscussionLimits from "./DiscussionLimits.vue";
import ExtraDirectoriesField from "./ExtraDirectoriesField.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import AccountSettings from "./AccountSettings.vue";
import ChainRoundsField from "./ChainRoundsField.vue";
import SpeechSettings from "./SpeechSettings.vue";
import SystemPrompts from "./SystemPrompts.vue";
import WeixinSettings from "./WeixinSettings.vue";
import LanguagePicker from "./LanguagePicker.vue";
import { t } from "./i18n.js";
import { adapter_profile } from "../runner/adapters/profiles.mjs";

const props = defineProps({ targetRoom: { type: Object, default: null }, targetFolder: { type: Object, default: null }, readingOptions: { type: Array, default: () => [] }, effectOptions: { type: Array, default: () => [] }, foldOptions: { type: Array, default: () => [] }, foldKeepOptions: { type: Array, default: () => [] }, cardTextOptions: { type: Array, default: () => [] } });
const mode = defineModel({ type: String, default: "" });
const reading_width = defineModel("readingWidth", { type: String, default: "default" });
const effects = defineModel("effects", { type: String, default: "full" });
const fold_level = defineModel("foldLevel", { type: String, default: "loose" });
const fold_keep = defineModel("foldKeep", { type: String, default: "medium" });
const card_text = defineModel("cardText", { type: String, default: "medium" });
const rendered_mode = ref(mode.value);
watch(mode, (value) => { if (value) rendered_mode.value = value; });
const { view, bridge, act, is_running } = inject("discussion");
const open = computed({ get: () => Boolean(mode.value), set: (value) => { if (!value) mode.value = ""; } });
const titles = { settings: t("设置"), create: t("新建房间"), folder: t("新建文件夹"), "rename-folder": t("编辑文件夹"), "delete-folder": t("移除文件夹"), "archive-folder": t("存档文件夹"), edit: t("编辑议题") };
Object.assign(titles, { restore: t("恢复房间"), delete: t("销毁房间") });
const descriptions = { create: t("邀请 AI 一起协作；需要深入讨论时，可在创建时或之后随时开启。"), edit: t("维护话题目标、背景与讨论默认上限。") };
Object.assign(descriptions, { restore: t("移回讨论列表，保持当前讨论阶段。"), delete: t("销毁后无法恢复。") });
titles.archives = t("已存档房间");
titles.destructions = t("销毁记录");
descriptions.destructions = t("查看销毁回执：删除了什么、保留了什么；未完成的可以重试。");
descriptions.archives = t("查看记录、恢复房间或销毁。");
const archived_rooms = computed(() => view.value.rooms.filter((room) => room.archived && !room.system_kind));
const archive_query = ref("");
const archive_content = ref("all");
const archive_content_options = [{ label: t("全部房间"), value: "all" }, { label: t("有消息"), value: "messages" }, { label: t("无消息"), value: "empty" }];
const archive_results = computed(() => filter_archived_channels(archived_rooms.value,
  { query: archive_query.value, content: archive_content.value }));
const archive_delete_id = ref(null);
const archive_destroy_open = ref(false);
const archive_destroy_final = ref(false);
const archive_export_started = ref(false);
const archives_deleting = ref(false);
const archive_filtered = computed(() => Boolean(archive_query.value.trim()) || archive_content.value !== "all");
const archive_destroy_targets = computed(() => archive_results.value.filter((room) => !archive_busy(room)));
const archive_destroy_messages = computed(() => archive_destroy_targets.value.reduce((total, room) => total + (room.message_count || 0), 0));
const archive_destroy_shared = computed(() => archive_destroy_targets.value.some((room) => Boolean(view.value.share_links?.[room.id])));
const archive_delete_room = computed(() => archived_rooms.value.find((room) => room.id === archive_delete_id.value));
watch(mode, value => {
  archive_delete_id.value = null;
  archive_destroy_open.value = false;
  if (value === "archives") { archive_query.value = ""; archive_content.value = "all"; }
});
watch(archive_destroy_open, (is_open) => {
  if (!is_open) { archive_destroy_final.value = false; archive_export_started.value = false; }
});
watch(() => archive_destroy_targets.value.length, (count) => {
  if (!count && archive_destroy_open.value) archive_destroy_open.value = false;
});

/** Filter archived channels in one newest-first list, regardless of their folder. */
function filter_archived_channels(rooms, filters) {
  const query = filters.query.trim().toLocaleLowerCase();
  return rooms.filter(room => room.archived && room.title.toLocaleLowerCase().includes(query)
    && (filters.content === "all" || (filters.content === "messages" ? room.message_count > 0 : room.message_count === 0)))
    .sort((left, right) => (right.created_at || "").localeCompare(left.created_at || ""));
}

/** Format the available creation time without presenting it as an archive date. */
function archive_created(value) {
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Prevent conflicting archive actions only for the affected channel. */
function archive_busy(room) {
  return view.value.archive_pending.includes(room.id)
    || ["rename", "delete"].some((action) => view.value.directory_pending.includes(`${action}:${room.id}`));
}

/** Open an archived transcript only when its title is explicitly selected. */
function read_archive(room) { mode.value = ""; return act("room", room.id); }

/** Delete one archived channel after a single confirmation click. */
async function delete_archive() {
  const room = archive_delete_room.value;
  if (!room || archive_busy(room)) return;
  archive_delete_id.value = null;
  announce_destroying(1);
  await act("manage_channel", { id: room.id, action: "delete" });
}

/** Say at once that the rooms are being destroyed and how it will end; each then dissolves with its own receipt. */
function announce_destroying(count) {
  bridge.notify("info", t('正在销毁 {count} 个房间，可在“销毁记录”查看进度。', { count }));
}


/** Open the standalone destroy dialog for the current archived list, matching single-room destruction. */
function open_archive_destroy() {
  if (archives_deleting.value || !archive_destroy_targets.value.length) return;
  archive_delete_id.value = null;
  archive_destroy_final.value = false;
  archive_export_started.value = false;
  archive_destroy_open.value = true;
}

/** Export the current archived list (messages, private chats and attachments; no drafts) before destroying them. */
async function export_archives_before_destroy() {
  const ids = archive_destroy_targets.value.map((room) => room.id);
  if (!ids.length) return;
  if (await act("backup_rooms", { ids, name: t("已存档房间") })) archive_export_started.value = true;
}

/** Delete every archived channel in the current list, one request at a time. */
async function delete_all_archives() {
  if (archives_deleting.value) return;
  const rooms = archive_destroy_targets.value;
  archive_destroy_open.value = false;
  archive_destroy_final.value = false;
  archive_export_started.value = false;
  if (!rooms.length) return;
  archives_deleting.value = true;
  announce_destroying(rooms.length);
  try {
    for (const room of rooms) await act("manage_channel", { id: room.id, action: "delete" });
  } finally { archives_deleting.value = false; }
}

const folder_name = ref("");
// The folder's project paths, edited as the new-room form does: a main directory, then other directories.
const folder_main = ref("");
const folder_extras = ref([]);
watch(() => [mode.value, props.targetFolder?.id], () => {
  const editing = mode.value === "rename-folder";
  const [main = "", ...extras] = editing ? props.targetFolder?.directories || [] : [];
  folder_name.value = editing ? props.targetFolder?.name || "" : "";
  folder_main.value = main;
  folder_extras.value = extras;
});
const folder_dialog = computed(() => ["folder", "rename-folder", "delete-folder", "archive-folder"].includes(rendered_mode.value));

/** Close directory confirmations immediately; background completion never closes a later dialog. */
async function save_management() {
  const request = { id: props.targetRoom.id, action: mode.value };
  if (mode.value === "delete") return ask_final(1, () => destroy_room(request));
  mode.value = "";
  await act("manage_channel", request);
}

// Every destroy is confirmed twice (2026-11-22 user decision): its own confirmation, then this one saying the data is lost.
// The second confirmation takes the place of the dialog's content, in the same window, until answered or the dialog changes.
const final_confirm = ref(null);
watch(mode, () => { final_confirm.value = null; });

/** Ask once more before destroying `count` rooms; `run` destroys them only after this second confirmation. */
function ask_final(count, run) {
  final_confirm.value = { count, run };
}

/** The second confirmation was given: destroy. */
function confirm_final() {
  const pending = final_confirm.value;
  final_confirm.value = null;
  pending?.run();
}

const export_started = ref(false);
watch(() => [mode.value, props.targetRoom?.id], () => { if (mode.value !== "delete") export_started.value = false; });

/** Start destroying the room; the dialog then shows what has been removed and checked. */
async function destroy_room(request) {
  mode.value = "";
  await act("manage_channel", request);
}

/** Download the room's records before destroying it; the browser, not this page, knows when the file is saved. */
async function export_before_destroy() {
  if (await act("backup", props.targetRoom.id)) export_started.value = true;
}

const DESTROY_STATES = { deleted: t("已删除并复查"), pending: t("进行中"), failed: t("未完成，可重试"), kept: t("保留"), elsewhere: t("不在本机") };
const software_label = (adapter) => adapter_profile(adapter)?.label || adapter || t("AI 软件");

/** One receipt item as a line of the progress list. */
function destruction_label(item) {
  const count = item.count ?? 0;
  const labels = { messages: () => t("消息 {count} 条", { count }), private_chats: () => t("私聊 {count} 条", { count }),
    attachments: () => t("附件 {count} 个", { count }), database: () => t("数据库中的删除残留"),
    sessions: () => t("{software} 的 AI 会话记录 {count} 个", { software: software_label(item.adapter), count }),
    runtime_files: () => t("运行文件与草稿"), kept_sessions: () => t("沿用你原有的会话，或与其他房间共用的会话 {count} 个", { count }),
    software_stores: () => t("{software} 自身共用的索引与数据库（未改动）", { software: software_label(item.adapter) }),
    feedback_cases: () => t("你评过的调度记录 {count} 条", { count }),
    draft_space: () => item.state === "kept" ? t("草稿文件夹（其他房间还在用）") : t("草稿文件夹"),
    project_files: () => t("项目文件"), providers: () => t("已发给模型服务商的内容") };
  return (labels[item.kind] || (() => item.kind))();
}

const destroy_all_open = ref(false);
const destroy_all_word = ref("");
const project_room_count = computed(() => view.value.rooms.filter(room => !room.system_kind).length);
const has_system_rooms = computed(() => view.value.rooms.some(room => room.system_kind));
const DESTROY_ALL_WORD = t("销毁全部");
watch(mode, () => { destroy_all_open.value = false; destroy_all_word.value = ""; });

/** Destroy project rooms, archived ones too, one after another. */
async function destroy_all_rooms() {
  destroy_all_open.value = false;
  await act("destroy_all_rooms");
}

/** Removing the main directory promotes the first other directory, as other directories need a main one. */
function remove_folder_main() {
  const [next = "", ...rest] = folder_extras.value;
  folder_main.value = next;
  folder_extras.value = rest;
}

/** Capture the folder edit and release the dialog before saving. */
async function save_folder() {
  const name = folder_name.value.trim();
  if (!name) return;
  const renaming = mode.value === "rename-folder";
  const main = folder_main.value.trim();
  const directories = main ? [main, ...folder_extras.value.map(path => path.trim()).filter(Boolean)] : [];
  const request = renaming ? { id: props.targetFolder.id, name, directories } : { name, directories };
  mode.value = "";
  await act(renaming ? "rename_folder" : "create_folder", request);
}

/** Active rooms in the target folder; archived ones keep their folder only for restoring and are left out of folder actions. */
const folder_rooms = computed(() => view.value.rooms.filter(room => !room.archived && props.targetFolder?.id && room.folder_id === props.targetFolder.id));

/** Release the confirmation immediately; optionally delete the folder's rooms first, keeping the folder if any deletion fails. */
async function remove_folder(with_rooms) {
  const id = props.targetFolder.id;
  const rooms = with_rooms ? folder_rooms.value : [];
  mode.value = "";
  if (rooms.length) announce_destroying(rooms.length);
  let deleted = true;
  for (const room of rooms) deleted = await act("manage_channel", { id: room.id, action: "delete" }) && deleted;
  if (deleted) await act("delete_folder", id);
}

/** Archive the folder's active unpinned rooms one request at a time; the folder and pinned rooms stay. */
async function archive_folder() {
  const rooms = folder_rooms.value.filter(room => !room.pinned);
  mode.value = "";
  for (const room of rooms) await act("manage_channel", { id: room.id, action: "archive" });
}
const details_open = ref(false);
const topic_limits = ref(null);
const limits_locked = computed(() => ["active", "paused"].includes(view.value.room?.session?.status));
const pending_theme = ref(null);
// The project access the first member of a new room (its host by default) starts with; kept in the local service's create preferences.
const HOST_ACCESS_OPTIONS = [{ value: "read", label: t("只读") }, { value: "write", label: t("可写") }, { value: "auto", label: t("自动") }, { value: "full", label: t("全放开") }];
const host_access = computed(() => view.value.launch.create_preferences?.host_project_access || "read");
const themes = [{ value: "channel", title: t("协作频道"), description: t("深灰界面 · 房间导航 · 成员侧栏") }, { value: "channel-light", title: t("协作频道 · 浅色"), description: t("纯白界面 · 中性灰阶 · 清晰阅读") }];

/** Map the topic form onto the existing controller's draft fields. */
function form_id(key) {
  return `topic-${key}-${key === "host" ? "select" : "input"}`;
}

/** Close the create panel as soon as its form is accepted; other write dialogs close once the save is confirmed. */
async function save_form() {
  topic_limits.value?.settle();
  if (mode.value !== "create") {
    if (await act("save_topic")) mode.value = "";
    return;
  }
  await act("create", { folder_id: props.targetFolder?.id ?? null, accepted: () => { mode.value = ""; },
    rejected: () => { if (!mode.value) mode.value = "create"; } });
}

/** Close the overlay before switching its underlying renderer. */
function choose_theme(theme) { pending_theme.value = theme; mode.value = ""; }

/** Disable theme styles only after the outgoing modal has left the page. */
function finish_theme_change() {
  if (!pending_theme.value) return;
  bridge.theme(pending_theme.value);
  pending_theme.value = null;
}

/** A half-filled create form closes only through its own Cancel, close button or Escape. */
const keep_open = (event) => event.preventDefault();
</script>

<template>
  <UModal v-model:open="open" :title="final_confirm ? t('再次确认销毁') : titles[rendered_mode] || t('讨论')" :description="final_confirm ? undefined : descriptions[rendered_mode]" :ui="{ content: ['glass-panel studio-modal', folder_dialog && 'channel-folder-modal', ['restore', 'delete'].includes(rendered_mode) && 'channel-folder-modal channel-manage-modal', rendered_mode === 'archives' && 'channel-archive-modal', rendered_mode === 'settings' && 'channel-settings-modal', rendered_mode === 'create' && 'channel-create-modal'], body: 'dialog-body' }" :content="{ onInteractOutside: keep_open }" @after:leave="finish_theme_change">
    <template #body>
      <section v-if="final_confirm" class="dialog-form">
        <p class="channel-destroy-final">{{ final_confirm.count === 1 ? t("确定销毁此房间？记录、附件、AI 会话与草稿将永久删除，无法恢复。") : t("确定销毁这 {count} 个房间？记录、附件、AI 会话与草稿将永久删除，无法恢复。", { count: final_confirm.count }) }}</p>
        <div class="dialog-actions"><UButton :label="t('返回')" color="neutral" variant="ghost" @click="final_confirm = null" /><UButton :label="t('确认销毁')" color="error" @click="confirm_final" /></div>
      </section>
      <section v-else-if="rendered_mode === 'archives'" class="channel-archive-manager">
        <div class="channel-archive-toolbar">
          <UInput v-model="archive_query" icon="i-lucide-search" :placeholder="t('搜索已存档房间')" :aria-label="t('搜索已存档房间')" class="channel-archive-search" />
          <USelect v-model="archive_content" :items="archive_content_options" icon="i-lucide-list-filter" :aria-label="t('筛选房间内容')" />
          <UButton :label="t('全部销毁（{count}）', { count: archive_results.length })" icon="i-lucide-trash-2" color="error" variant="soft" size="sm" class="channel-archive-delete-all" :loading="archives_deleting" :disabled="archives_deleting || !archive_destroy_targets.length" @click="open_archive_destroy" />
        </div>
        <div v-keep-reading class="channel-archive-results">
          <ul v-if="archive_results.length" class="channel-archive-list" :aria-label="t('已存档房间列表')">
          <li v-for="room in archive_results" :key="room.id" class="channel-archive-item">
            <div class="channel-archive-row">
              <div class="channel-archive-info"><button class="channel-archive-title" :title="room.title" @click="read_archive(room)">{{ room.title }}</button><small><span v-if="room.created_at">{{ t("创建于") }} <time :datetime="room.created_at">{{ archive_created(room.created_at) }}</time> · </span>{{ t("{count} 条消息", { count: room.message_count }) }}</small></div>
              <div class="channel-archive-actions">
                <UButton :aria-label="t('销毁 {name}', { name: room.title })" :title="t('销毁房间')" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" class="channel-archive-delete" :disabled="archive_busy(room)" @click="archive_delete_id = room.id" />
                <UButton :label="t('恢复')" :aria-label="t('恢复 {name}', { name: room.title })" color="neutral" variant="soft" size="xs" class="channel-archive-restore" :disabled="archive_busy(room)" @click="act('manage_channel', { id: room.id, action: 'restore' })" />
              </div>
            </div>
            <div v-if="archive_delete_id === room.id" class="channel-archive-confirm channel-archive-bulk" role="alert"><span>{{ t("销毁「{name}」的记录、附件、AI 会话与草稿（项目文件保留），无法恢复。", { name: room.title }) }}</span><UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="archive_delete_id = null" /><UButton :label="t('销毁')" color="error" size="xs" :disabled="archive_busy(room)" @click="ask_final(1, delete_archive)" /></div>
          </li>
          </ul>
        <p v-else class="channel-archive-empty">{{ archived_rooms.length ? t('没有匹配的存档房间') : t('暂无已存档房间') }}</p>
        </div>
      </section>
      <section v-else-if="rendered_mode === 'destructions'" class="channel-destruction-records">
        <p v-if="!view.destructions.length" class="fine-print">{{ t("还没有销毁过房间。") }}</p>
        <article v-for="record in view.destructions" :key="record.room_id" class="channel-destruction-record">
          <header><b>{{ record.title || t("（名称已随销毁清除）") }}</b><small>{{ archive_created(record.created_at) }}{{ record.automatic ? ` · ${t("自动销毁")}` : "" }} · {{ record.status === "done" ? t("已完成") : t("清理中") }}</small></header>
          <ul class="channel-destroy-progress"><li v-for="item in record.items" :key="`${item.kind}-${item.adapter || ''}`" :data-state="item.state"><span>{{ destruction_label(item) }}</span><small>{{ DESTROY_STATES[item.state] }}</small></li></ul>
          <UButton v-if="record.status !== 'done'" :label="t('重试')" color="neutral" variant="soft" size="xs" @click="act('retry_destruction', record.room_id)" />
        </article>
        <div v-if="destroy_all_open" class="channel-destroy-all" role="alert">
          <p>{{ t("将逐个销毁全部 {count} 个项目房间（含已存档）：记录、附件、成员的 AI 会话与草稿都会删除，发布过的分享网页会先撤销，项目文件保留。需要留底请先在房间目录“…”里“导出全部房间”；它不含草稿，需要草稿请逐个房间导出。", { count: project_room_count }) }}</p>
          <p v-if="!has_system_rooms">{{ t("以独立 Windows 用户运行的托管账号，还会删除各 AI 软件里的全部会话记录与 AI 记住的偏好（登录信息保留）。") }}</p>
          <UInput v-model="destroy_all_word" :placeholder="t('输入“{word}”确认', { word: DESTROY_ALL_WORD })" size="sm" autocomplete="off" />
          <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="destroy_all_open = false" /><UButton :label="t('全部销毁')" color="error" size="xs" :disabled="destroy_all_word.trim() !== DESTROY_ALL_WORD" @click="destroy_all_rooms" /></div>
        </div>
        <div class="dialog-actions"><UButton :label="t('销毁全部房间')" icon="i-lucide-flame" color="error" variant="soft" :disabled="Boolean(view.destroying.length)" @click="destroy_all_open = true" /></div>
      </section>
      <form v-else-if="rendered_mode === 'delete-folder'" class="dialog-form" @submit.prevent="remove_folder(false)">
        <p class="fine-print">{{ t("仅移除「{name}」时，房间变为未分组，所有消息和存档状态都会保留。", { name: targetFolder?.name }) }}</p>
        <p v-if="folder_rooms.length" class="fine-print">{{ t("也可以连同其中的 {count} 个房间一起销毁（项目文件保留），无法恢复。", { count: folder_rooms.length }) }}</p>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton v-if="folder_rooms.length" :label="t('连同 {count} 个房间销毁', { count: folder_rooms.length })" color="error" variant="soft" @click="ask_final(folder_rooms.length, () => remove_folder(true))" /><UButton type="submit" :label="t('仅移除文件夹')" color="neutral" variant="solid" /></div>
      </form>
      <form v-else-if="rendered_mode === 'archive-folder'" class="dialog-form" @submit.prevent="archive_folder">
        <p class="fine-print">{{ t("存档「{name}」中的 {count} 个房间，文件夹保留。存档后可在侧栏「已存档」中查阅与恢复；尚未收束的讨论会暂停。", { name: targetFolder?.name, count: folder_rooms.length }) }}</p>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="t('存档全部房间')" color="primary" /></div>
      </form>
      <form v-else-if="folder_dialog" class="dialog-form" @submit.prevent="save_folder">
        <UInput v-model="folder_name" icon="i-lucide-folder" :aria-label="rendered_mode === 'folder' ? t('新文件夹名称') : t('文件夹名称')" :placeholder="t('文件夹名称')" autofocus required :maxlength="40" class="w-full" autocomplete="off" @keydown.enter.prevent="!$event.isComposing && save_folder()" />
        <UFormField v-if="['folder', 'rename-folder'].includes(rendered_mode)" :label="t('项目路径（可选）')" :description="t('在此文件夹中新建房间时自动带入，已有房间不受影响。')">
          <div v-if="view.launch.available" class="channel-folder-directories">
            <ProjectDirectoryField v-model="folder_main" compact :placeholder="view.launch.remote ? t('从常用项目中选择') : t('粘贴或输入临时路径')">
              <template v-if="folder_main.trim()" #badge><span class="channel-folder-primary">{{ t("主目录") }}</span></template>
              <template v-if="folder_main.trim()" #actions><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="self-center" :aria-label="t('移除主目录 {path}', { path: folder_main })" @click="remove_folder_main" /></template>
            </ProjectDirectoryField>
            <ExtraDirectoriesField v-if="folder_main.trim()" v-model="folder_extras" />
          </div>
          <div v-else class="channel-folder-directories">
            <code v-for="path in [folder_main, ...folder_extras].filter(Boolean)" :key="path" class="channel-folder-path">{{ path }}</code>
            <p class="fine-print">{{ t("项目路径须在电脑上或已连接电脑的网页中设置。") }}</p>
          </div>
        </UFormField>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'folder' ? t('创建文件夹') : t('保存')" class="channel-primary-button" :loading="is_running('create_folder') || is_running('rename_folder')" :disabled="!folder_name.trim()" /></div>
      </form>
      <form v-else-if="['restore', 'delete'].includes(rendered_mode)" class="dialog-form" @submit.prevent="save_management">
        <p class="channel-management-target">{{ targetRoom?.title }} <span>· {{ t("{count} 条消息", { count: targetRoom?.message_count }) }}</span></p>
        <p v-if="rendered_mode === 'restore'" class="fine-print">{{ t("恢复不会自动继续讨论；需要继续时，在主持设置中调整阶段。") }}</p>
        <template v-if="rendered_mode === 'delete'">
          <ul class="channel-destroy-scope">
            <li>{{ t("删除：消息、私聊、附件、本房间新建的 AI 会话与草稿。") }}</li>
            <li>{{ t("保留：项目目录、沿用或共用的会话、AI 软件共用索引。") }}</li>
            <li>{{ t("已发给模型服务商的内容按其政策保留，无法删除。") }}</li>
            <li v-if="view.share_links?.[targetRoom?.id]">{{ t("已发布的分享网页会先撤销。") }}</li>
          </ul>
          <div class="channel-destroy-export"><span>{{ export_started ? t("已开始下载，请确认浏览器已保存。") : t("销毁前导出消息、私聊与附件？（不含草稿文件）") }}</span><UButton :label="t('导出资料包')" icon="i-lucide-download" color="neutral" variant="soft" size="xs" :disabled="view.backup_pending" @click="export_before_destroy" /></div>
        </template>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'delete' ? t('立即销毁') : titles[rendered_mode]" :color="rendered_mode === 'delete' ? 'error' : 'primary'" :loading="is_running('manage_channel') || view.directory_pending.includes(`delete:${targetRoom?.id}`)" /></div>
      </form>
      <div v-else-if="rendered_mode === 'settings'">
        <AccountSettings />
        <h3 class="account-appearance-heading">{{ t("外观") }}</h3>
        <div class="theme-choices"><button v-for="theme in themes" :key="theme.value" :class="{ chosen: view.theme === theme.value }" :aria-pressed="view.theme === theme.value" @click="choose_theme(theme.value)"><span class="theme-preview" :class="theme.value" aria-hidden="true"><i class="theme-preview-side"></i><i class="theme-preview-main"><b></b><b></b><b></b></i></span><span><strong>{{ theme.title }}</strong><small>{{ theme.description }}</small></span><span class="theme-check"><UIcon v-if="view.theme === theme.value" name="i-lucide-check" /></span></button></div>
        <!-- Each setting is one row: its name on the left, its choices on the right; a note, if any, runs below both. -->
        <div class="channel-settings-group">
          <section class="channel-setting-row">
            <!-- Always bilingual, so someone who cannot read the current language can still find it. -->
            <h3>{{ t("语言 · Language") }}</h3>
            <LanguagePicker />
          </section>
          <section class="channel-setting-row">
            <h3 id="channel-effects-label">{{ t("视觉效果") }}</h3>
            <div class="channel-reading-options channel-effect-options" role="group" aria-labelledby="channel-effects-label"><UButton v-for="option in effectOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: effects === option.value }" :aria-pressed="effects === option.value" @click="effects = option.value" /></div>
          </section>
        </div>
        <h3 class="account-appearance-heading">{{ t("阅读") }}</h3>
        <div class="channel-settings-group">
          <section class="channel-setting-row">
            <h3 id="channel-reading-label">{{ t("对话宽度") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-reading-label"><UButton v-for="option in readingOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: reading_width === option.value }" :aria-pressed="reading_width === option.value" @click="reading_width = option.value" /></div>
          </section>
          <section class="channel-setting-row">
            <h3 id="channel-card-text-label">{{ t("卡片文字大小") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-card-text-label"><UButton v-for="option in cardTextOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: card_text === option.value }" :aria-pressed="card_text === option.value" @click="card_text = option.value" /></div>
          </section>
          <section class="channel-setting-row">
            <h3 id="channel-fold-label">{{ t("回答收起长度") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-fold-label"><UButton v-for="option in foldOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: fold_level === option.value }" :aria-pressed="fold_level === option.value" @click="fold_level = option.value" /></div>
          </section>
          <section class="channel-setting-row">
            <h3 id="channel-fold-keep-label">{{ t("折叠后显示") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-fold-keep-label"><UButton v-for="option in foldKeepOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: fold_keep === option.value }" :aria-pressed="fold_keep === option.value" @click="fold_keep = option.value" /></div>
          </section>
        </div>
        <h3 class="account-appearance-heading">{{ t("房间偏好") }}</h3>
        <div class="channel-settings-group">
          <section class="channel-setting-row channel-setting-wide">
            <h3 id="channel-host-access-label">{{ t("主持人默认权限") }}</h3>
            <div class="channel-reading-options channel-access-options" role="group" aria-labelledby="channel-host-access-label"><UButton v-for="option in HOST_ACCESS_OPTIONS" :key="option.value" :label="option.label" color="neutral" variant="ghost" :disabled="!view.launch.available" :class="{ chosen: host_access === option.value }" :aria-pressed="host_access === option.value" @click="bridge.write_create_preferences({ host_project_access: option.value })" /></div>
            <p class="fine-print">{{ view.launch.available ? t("新建房间时主持人的项目权限；软件不支持时为只读。") : t("连接本机服务后可设置。") }}</p>
          </section>
          <section v-if="view.launch.available || view.launch.remote" class="channel-setting-row">
            <h3>{{ t("关联房间互传上限") }}</h3>
            <ChainRoundsField no-help :name="t('关联房间互传条数')" :unit="t('条')" :model-value="view.create_relay_rounds ?? 0" @update:model-value="bridge.write_create_relay_rounds($event)" />
          </section>
        </div>
        <SystemPrompts />
        <SpeechSettings />
        <WeixinSettings />
      </div>
      <CreateDiscussion v-else-if="rendered_mode === 'create'" @submit="save_form" @cancel="mode = ''" />
      <form v-else-if="rendered_mode === 'edit'" class="dialog-form" @submit.prevent="save_form">
        <UFormField :label="t('话题名称')" required><UInput :model-value="view.fields[form_id('title')]" :maxlength="80" required :placeholder="t('这次想讨论什么？')" class="w-full" @update:model-value="bridge.write_field(form_id('title'), $event)" /></UFormField>
        <UFormField :label="t('讨论目标')"><UTextarea :model-value="view.fields[form_id('goal')]" :maxlength="1000" :rows="2" :placeholder="t('希望通过讨论解决的问题')" class="w-full" @update:model-value="bridge.write_field(form_id('goal'), $event)" /></UFormField>
        <UFormField v-if="rendered_mode === 'edit'" :label="t('当前焦点')"><UInput :model-value="view.fields[form_id('focus')]" :maxlength="1000" :placeholder="t('当前最需要回应的问题')" class="w-full" @update:model-value="bridge.write_field(form_id('focus'), $event)" /></UFormField>
        <section class="advanced-content"><h3>{{ t("讨论上限") }}</h3>
          <DiscussionLimits ref="topic_limits" :rounds="Number(view.fields[form_id('limit-max_rounds')])" :minutes="Number(view.fields[form_id('limit-max_minutes')])"
            :disabled="limits_locked"
            @update:rounds="bridge.write_field(form_id('limit-max_rounds'), String($event))" @update:minutes="bridge.write_field(form_id('limit-max_minutes'), String($event))" />
          <p v-if="limits_locked" class="fine-print">{{ t("讨论未结束时，上限不可在此修改。") }}</p></section>
        <UCollapsible v-model:open="details_open" class="advanced-fields"><UButton :trailing-icon="details_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" :label="t('用户原文、背景与边界')" color="neutral" variant="ghost" block class="advanced-trigger" /><template #content><div class="advanced-content"><UFormField v-for="item in [{ key: 'user_request', label: t('用户原文') }, { key: 'background', label: t('背景') }, { key: 'boundaries', label: t('讨论边界') }]" :key="item.key" :label="item.label"><UTextarea :model-value="view.fields[form_id(item.key)]" :maxlength="4000" :rows="2" class="w-full" @update:model-value="bridge.write_field(form_id(item.key), $event)" /></UFormField></div></template></UCollapsible>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" :label="t('保存议题')" :loading="is_running('create') || is_running('save_topic')" /></div>
      </form>
    </template>
  </UModal>
  <UModal v-model:open="archive_destroy_open" :title="archive_destroy_final ? t('再次确认销毁') : t('销毁已存档房间')" :description="archive_destroy_final ? undefined : t('销毁后无法恢复。')" :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal', body: 'dialog-body' }" :content="{ onInteractOutside: keep_open }">
    <template #body>
      <section v-if="archive_destroy_final" class="dialog-form">
        <p class="channel-destroy-final">{{ archive_destroy_targets.length === 1 ? t("确定销毁此房间？记录、附件、AI 会话与草稿将永久删除，无法恢复。") : t("确定销毁这 {count} 个房间？记录、附件、AI 会话与草稿将永久删除，无法恢复。", { count: archive_destroy_targets.length }) }}</p>
        <div class="dialog-actions"><UButton :label="t('返回')" color="neutral" variant="ghost" @click="archive_destroy_final = false" /><UButton :label="t('确认销毁')" color="error" :loading="archives_deleting" :disabled="archives_deleting || !archive_destroy_targets.length" @click="delete_all_archives" /></div>
      </section>
      <form v-else class="dialog-form" @submit.prevent="archive_destroy_final = true">
        <p class="channel-management-target">{{ archive_filtered ? t("当前筛选的 {count} 个已存档房间", { count: archive_destroy_targets.length }) : t("全部 {count} 个已存档房间", { count: archive_destroy_targets.length }) }} <span>· {{ t("{count} 条消息", { count: archive_destroy_messages }) }}</span></p>
        <ul class="channel-destroy-scope">
          <li>{{ t("删除：消息、私聊、附件、这些房间新建的 AI 会话与草稿。") }}</li>
          <li>{{ t("保留：项目目录、沿用或共用的会话、AI 软件共用索引。") }}</li>
          <li>{{ t("已发给模型服务商的内容按其政策保留，无法删除。") }}</li>
          <li v-if="archive_destroy_shared">{{ t("已发布的分享网页会先撤销。") }}</li>
        </ul>
        <div class="channel-destroy-export"><span>{{ archive_export_started ? t("已开始下载，请确认浏览器已保存。") : t("销毁前导出消息、私聊与附件？（不含草稿文件）") }}</span><UButton :label="t('导出资料包')" icon="i-lucide-download" color="neutral" variant="soft" size="xs" :disabled="view.backup_pending || !archive_destroy_targets.length" @click="export_archives_before_destroy" /></div>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="archive_destroy_open = false" /><UButton type="submit" :label="t('立即销毁')" color="error" :loading="archives_deleting" :disabled="archives_deleting || !archive_destroy_targets.length" /></div>
      </form>
    </template>
  </UModal>
</template>

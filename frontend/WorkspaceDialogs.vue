<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from "vue";
import CreateDiscussion from "./CreateDiscussion.vue";
import DiscussionLimits from "./DiscussionLimits.vue";
import ExtraDirectoriesField from "./ExtraDirectoriesField.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import AccountSettings from "./AccountSettings.vue";
import SpeechSettings from "./SpeechSettings.vue";
import WeixinSettings from "./WeixinSettings.vue";
import LanguagePicker from "./LanguagePicker.vue";
import { t } from "./i18n.js";

const props = defineProps({ detailId: { type: Number, default: null }, targetRoom: { type: Object, default: null }, targetFolder: { type: Object, default: null }, readingOptions: { type: Array, default: () => [] }, effectOptions: { type: Array, default: () => [] }, foldOptions: { type: Array, default: () => [] }, foldKeepOptions: { type: Array, default: () => [] }, cardTextOptions: { type: Array, default: () => [] } });
const mode = defineModel({ type: String, default: "" });
const reading_width = defineModel("readingWidth", { type: String, default: "default" });
const effects = defineModel("effects", { type: String, default: "full" });
const fold_level = defineModel("foldLevel", { type: String, default: "loose" });
const fold_keep = defineModel("foldKeep", { type: String, default: "medium" });
const card_text = defineModel("cardText", { type: String, default: "medium" });
const rendered_mode = ref(mode.value);
watch(mode, (value) => { if (value) rendered_mode.value = value; });
const { view, bridge, act, pending } = inject("discussion");
const open = computed({ get: () => Boolean(mode.value), set: (value) => { if (!value) mode.value = ""; } });
const titles = { settings: t("设置"), create: t("新建房间"), folder: t("新建文件夹"), "rename-folder": t("编辑文件夹"), "delete-folder": t("移除文件夹"), "archive-folder": t("存档文件夹"), edit: t("编辑议题"), message: t("消息原文") };
Object.assign(titles, { rename: t("重命名房间"), restore: t("恢复房间"), delete: t("删除房间") });
const descriptions = { create: t("邀请 AI 一起协作；需要深入讨论时，可在创建时或之后随时开启。"), edit: t("维护话题目标、背景与讨论默认上限。"), message: t("保留作者、来源、提交人和引用关系。") };
Object.assign(descriptions, { rename: t("名称变化不会影响讨论记录和阅读地址。"), restore: t("移回讨论列表，保持当前讨论阶段。"), delete: t("永久删除房间及其所有记录，无法撤销。") });
titles.archives = t("已存档房间");
descriptions.archives = t("查看记录、恢复房间或彻底删除。");
const archived_rooms = computed(() => view.value.rooms.filter((room) => room.archived));
const archive_query = ref("");
const archive_content = ref("all");
const archive_content_options = [{ label: t("全部房间"), value: "all" }, { label: t("有消息"), value: "messages" }, { label: t("无消息"), value: "empty" }];
const archive_results = computed(() => filter_archived_channels(view.value.rooms,
  { query: archive_query.value, content: archive_content.value }));
const archive_delete_id = ref(null);
const archive_delete_all = ref(false);
const archives_deleting = ref(false);
const archive_delete_room = computed(() => archived_rooms.value.find((room) => room.id === archive_delete_id.value));
watch(mode, value => {
  archive_delete_id.value = null;
  archive_delete_all.value = false;
  if (value === "archives") { archive_query.value = ""; archive_content.value = "all"; }
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
  await act("manage_channel", { id: room.id, action: "delete" });
}

/** Delete every archived channel in the current list, one request at a time. */
async function delete_all_archives() {
  if (archives_deleting.value) return;
  const rooms = archive_results.value.filter((room) => !archive_busy(room));
  archive_delete_all.value = false;
  archives_deleting.value = true;
  try {
    for (const room of rooms) await act("manage_channel", { id: room.id, action: "delete" });
  } finally { archives_deleting.value = false; }
}

const management_title = ref("");
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
watch(() => [mode.value, props.targetRoom?.id], () => { management_title.value = mode.value === "rename" ? props.targetRoom?.title || "" : ""; });

/** Close directory confirmations immediately; background completion never closes a later dialog. */
async function save_management() {
  const request = { id: props.targetRoom.id, action: mode.value, title: management_title.value };
  mode.value = "";
  await act("manage_channel", request);
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
  if (!name || pending.value) return;
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
  let deleted = true;
  for (const room of rooms) deleted = await act("manage_channel", { id: room.id, action: "delete" }) && deleted;
  if (deleted) await act("delete_folder", id);
}

/** Archive the folder's active rooms one request at a time; the folder itself stays. */
async function archive_folder() {
  const rooms = folder_rooms.value;
  mode.value = "";
  for (const room of rooms) await act("manage_channel", { id: room.id, action: "archive" });
}
const details_open = ref(false);
const topic_limits = ref(null);
const limits_locked = computed(() => ["active", "paused"].includes(view.value.room?.session?.status));
const pending_theme = ref(null);
const pending_attachment = ref(null);
const detail = ref(null);
const detail_error = ref("");
let detail_request = 0, detail_target = null;
onBeforeUnmount(() => { detail_request++; });
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

/** Release the original-message focus trap before opening the shared preview. */
function open_attachment(event) {
  const button = event.target.closest("[data-preview-attachment]");
  if (!button) return;
  event.stopPropagation();
  pending_attachment.value = { ...button.dataset, room_id: button.dataset.attachmentRoom, id: button.dataset.previewAttachment };
  mode.value = "";
}

/** Apply deferred actions only after the modal removes its accessibility isolation. */
function after_dialog_leave() {
  finish_theme_change();
  if (!pending_attachment.value) return;
  const file = pending_attachment.value;
  pending_attachment.value = null;
  act("preview_attachment", file);
}

/** Fetch an exact message and discard replies from a previously closed dialog. */
watch(() => [mode.value, props.detailId, view.value.room?.id], ([kind, id]) => {
  detail_request++;
  if (kind === "message" && id && view.value.room) load_detail(id);
});

/** Switch the original-message view immediately, then fill it only with the latest requested message. */
async function load_detail(id) {
  const request = ++detail_request, room_id = view.value.room.id;
  detail_target = id;
  detail.value = null;
  detail_error.value = "";
  try {
    const result = await bridge.request(`/api/rooms/${room_id}/messages/${id}`);
    if (request === detail_request) detail.value = result;
  } catch (error) { if (request === detail_request) detail_error.value = error.message; }
}

/** Follow a reply chain inside the same original-message dialog. */
function follow_reply() { load_detail(detail.value.reply_to); }

/** A half-filled create form closes only through its own Cancel, close button or Escape. */
const keep_open = (event) => event.preventDefault();
</script>

<template>
  <UModal v-model:open="open" :title="titles[rendered_mode] || t('讨论')" :description="descriptions[rendered_mode]" :ui="{ content: ['glass-panel studio-modal', folder_dialog && 'channel-folder-modal', ['rename', 'restore', 'delete'].includes(rendered_mode) && 'channel-folder-modal channel-manage-modal', rendered_mode === 'archives' && 'channel-archive-modal', rendered_mode === 'settings' && 'channel-settings-modal', rendered_mode === 'create' && 'channel-create-modal', rendered_mode === 'message' && 'channel-message-modal'], body: 'dialog-body' }" :content="{ onInteractOutside: keep_open }" @after:leave="after_dialog_leave">
    <template #body>
      <section v-if="rendered_mode === 'archives'" class="channel-archive-manager">
        <div class="channel-archive-toolbar">
          <UInput v-model="archive_query" icon="i-lucide-search" :placeholder="t('搜索已存档房间')" :aria-label="t('搜索已存档房间')" class="channel-archive-search" />
          <USelect v-model="archive_content" :items="archive_content_options" icon="i-lucide-list-filter" :aria-label="t('筛选房间内容')" />
          <UButton :label="t('全部删除（{count}）', { count: archive_results.length })" icon="i-lucide-trash-2" color="error" variant="soft" size="sm" class="channel-archive-delete-all" :loading="archives_deleting" :disabled="archives_deleting || !archive_results.length" @click="archive_delete_all = true; archive_delete_id = null" />
        </div>
        <div v-if="archive_delete_all && archive_results.length" class="channel-archive-confirm channel-archive-bulk" role="alert"><span>{{ t("将永久删除当前列表中的 {count} 个房间及其全部记录，无法撤销。", { count: archive_results.length }) }}</span><UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="archive_delete_all = false" /><UButton :label="t('全部删除')" color="error" size="xs" @click="delete_all_archives" /></div>
        <div v-keep-reading class="channel-archive-results">
          <ul v-if="archive_results.length" class="channel-archive-list" :aria-label="t('已存档房间列表')">
          <li v-for="room in archive_results" :key="room.id" class="channel-archive-item">
            <div class="channel-archive-row">
              <div class="channel-archive-info"><button class="channel-archive-title" :title="room.title" :disabled="Boolean(pending)" @click="read_archive(room)">{{ room.title }}</button><small><span v-if="room.created_at">{{ t("创建于") }} <time :datetime="room.created_at">{{ archive_created(room.created_at) }}</time> · </span>{{ t("{count} 条消息", { count: room.message_count }) }}</small></div>
              <div class="channel-archive-actions">
                <UButton :aria-label="t('彻底删除 {name}', { name: room.title })" :title="t('彻底删除')" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" class="channel-archive-delete" :disabled="archive_busy(room)" @click="archive_delete_id = room.id; archive_delete_all = false" />
                <UButton :label="t('恢复')" :aria-label="t('恢复 {name}', { name: room.title })" color="neutral" variant="soft" size="xs" class="channel-archive-restore" :disabled="archive_busy(room)" @click="act('manage_channel', { id: room.id, action: 'restore' })" />
              </div>
            </div>
            <div v-if="archive_delete_id === room.id" class="channel-archive-confirm channel-archive-bulk" role="alert"><span>{{ t("永久删除「{name}」及其全部记录，无法撤销。", { name: room.title }) }}</span><UButton :label="t('取消')" color="neutral" variant="ghost" size="xs" @click="archive_delete_id = null" /><UButton :label="t('删除')" color="error" size="xs" :disabled="archive_busy(room)" @click="delete_archive" /></div>
          </li>
          </ul>
        <p v-else class="channel-archive-empty">{{ archived_rooms.length ? t('没有匹配的存档房间') : t('暂无已存档房间') }}</p>
        </div>
      </section>
      <form v-else-if="rendered_mode === 'delete-folder'" class="dialog-form" @submit.prevent="remove_folder(false)">
        <p class="fine-print">{{ t("仅移除「{name}」时，房间变为未分组，所有消息和存档状态都会保留。", { name: targetFolder?.name }) }}</p>
        <p v-if="folder_rooms.length" class="fine-print">{{ t("也可以连同其中的 {count} 个房间一起永久删除，无法撤销。", { count: folder_rooms.length }) }}</p>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton v-if="folder_rooms.length" :label="t('连同 {count} 个房间删除', { count: folder_rooms.length })" color="error" variant="soft" @click="remove_folder(true)" /><UButton type="submit" :label="t('仅移除文件夹')" color="neutral" variant="solid" /></div>
      </form>
      <form v-else-if="rendered_mode === 'archive-folder'" class="dialog-form" @submit.prevent="archive_folder">
        <p class="fine-print">{{ t("存档「{name}」中的 {count} 个房间，文件夹保留。存档后可在侧栏「已存档」中查阅与恢复；尚未收束的讨论会暂停。", { name: targetFolder?.name, count: folder_rooms.length }) }}</p>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="t('存档全部房间')" color="primary" /></div>
      </form>
      <form v-else-if="folder_dialog" class="dialog-form" @submit.prevent="save_folder">
        <UInput v-model="folder_name" icon="i-lucide-folder" :aria-label="rendered_mode === 'folder' ? t('新文件夹名称') : t('文件夹名称')" :placeholder="t('文件夹名称')" autofocus required :maxlength="40" class="w-full" autocomplete="off" :readonly="Boolean(pending)" @keydown.enter.prevent="!$event.isComposing && save_folder()" />
        <UFormField v-if="['folder', 'rename-folder'].includes(rendered_mode)" :label="t('项目路径（可选）')" :description="t('在此文件夹中新建房间时自动带入，已有房间不受影响。')">
          <div v-if="view.launch.available" class="channel-folder-directories">
            <ProjectDirectoryField v-model="folder_main" compact :placeholder="t('粘贴或输入临时路径')" :disabled="Boolean(pending)">
              <template v-if="folder_main.trim()" #badge><span class="channel-folder-primary">{{ t("主目录") }}</span></template>
              <template v-if="folder_main.trim()" #actions><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="self-center" :aria-label="t('移除主目录 {path}', { path: folder_main })" :disabled="Boolean(pending)" @click="remove_folder_main" /></template>
            </ProjectDirectoryField>
            <ExtraDirectoriesField v-if="folder_main.trim()" v-model="folder_extras" :disabled="Boolean(pending)" />
          </div>
          <div v-else class="channel-folder-directories">
            <code v-for="path in [folder_main, ...folder_extras].filter(Boolean)" :key="path" class="channel-folder-path">{{ path }}</code>
            <p class="fine-print">{{ t("项目路径须在电脑上或已连接电脑的网页中设置。") }}</p>
          </div>
        </UFormField>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'folder' ? t('创建文件夹') : t('保存')" class="channel-primary-button" :loading="pending === 'create_folder' || pending === 'rename_folder'" :disabled="!folder_name.trim() || Boolean(pending)" /></div>
      </form>
      <form v-else-if="['rename', 'restore', 'delete'].includes(rendered_mode)" class="dialog-form" @submit.prevent="save_management">
        <p class="channel-management-target">{{ targetRoom?.title }} <span>· {{ t("{count} 条消息", { count: targetRoom?.message_count }) }}</span></p>
        <p v-if="rendered_mode === 'restore'" class="fine-print">{{ t("恢复不会自动继续讨论；需要继续时，在主持设置中调整阶段。") }}</p>
        <p v-if="rendered_mode === 'delete'" class="fine-print">{{ t("消息、共识和发言安排将一起删除，无法撤销。") }}</p>
        <UFormField v-if="rendered_mode === 'rename'" :label="t('房间名称')" required><UInput v-model="management_title" autofocus :maxlength="80" required class="w-full" autocomplete="off" /></UFormField>
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'delete' ? t('永久删除') : rendered_mode === 'rename' ? t('保存名称') : titles[rendered_mode]" :color="rendered_mode === 'delete' ? 'error' : 'primary'" :loading="pending === 'manage_channel'" :disabled="rendered_mode === 'rename' && !management_title.trim()" /></div>
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
            <p class="fine-print">{{ t("精简模式关闭毛玻璃模糊与多层阴影，适合配置较低或需要更流畅滚动的设备。") }}</p>
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
            <h3 id="channel-fold-label">{{ t("长回答折叠") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-fold-label"><UButton v-for="option in foldOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: fold_level === option.value }" :aria-pressed="fold_level === option.value" @click="fold_level = option.value" /></div>
            <p class="fine-print">{{ t("宽松：超过 1.2 屏才折叠；标准：超过 0.7 屏折叠；紧凑：超过半屏就折叠。按当前屏幕高度计算，只对本设备生效。") }}</p>
          </section>
          <section class="channel-setting-row">
            <h3 id="channel-fold-keep-label">{{ t("折叠后显示") }}</h3>
            <div class="channel-reading-options" role="group" aria-labelledby="channel-fold-keep-label"><UButton v-for="option in foldKeepOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: fold_keep === option.value }" :aria-pressed="fold_keep === option.value" @click="fold_keep = option.value" /></div>
            <p class="fine-print">{{ t("折叠后的回答保留开头一段：少约 0.15 屏、中约 0.3 屏、多约半屏。按当前屏幕高度换算成行数，手机、平板、电脑各自不同，只对本设备生效。") }}</p>
          </section>
        </div>
        <h3 class="account-appearance-heading">{{ t("房间偏好") }}</h3>
        <div class="channel-settings-group">
          <section class="channel-setting-row channel-setting-wide">
            <h3 id="channel-host-access-label">{{ t("主持人项目权限") }}</h3>
            <div class="channel-reading-options channel-access-options" role="group" aria-labelledby="channel-host-access-label"><UButton v-for="option in HOST_ACCESS_OPTIONS" :key="option.value" :label="option.label" color="neutral" variant="ghost" :disabled="!view.launch.available" :class="{ chosen: host_access === option.value }" :aria-pressed="host_access === option.value" @click="bridge.write_create_preferences({ host_project_access: option.value })" /></div>
            <p class="fine-print">{{ view.launch.available ? t("新建房间时，第一位加入的成员（默认主持人）使用的项目权限；该软件不支持所选档位时仍为只读。保存在这台电脑的本机服务里，升级后保留。") : t("连接本机服务后可设置。") }}</p>
          </section>
        </div>
        <SpeechSettings />
        <WeixinSettings />
      </div>
      <CreateDiscussion v-else-if="rendered_mode === 'create'" :target-folder="targetFolder" @submit="save_form" @cancel="mode = ''" />
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
        <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" :label="t('保存议题')" :loading="pending === 'create' || pending === 'save_topic'" /></div>
      </form>
      <div v-else-if="rendered_mode === 'message'" class="original-message"><p v-if="detail_error" role="alert">{{ detail_error }}<UButton :label="t('重试')" color="neutral" variant="link" size="xs" @click="load_detail(detail_target)" /></p><template v-else-if="detail"><div class="original-meta"><strong>{{ bridge.display_name(detail.author) }}</strong><span>#{{ detail.id }}</span><UBadge color="neutral" variant="subtle">{{ bridge.sources[detail.source] }}</UBadge></div><p class="fine-print">{{ bridge.provenance(detail) }} · {{ new Date(detail.created_at).toLocaleString('zh-CN') }}</p><section v-if="detail.summary" class="channel-answer-summary"><small>{{ t("回答摘要 · {name}", { name: bridge.display_name(detail.summary_by) }) }}</small><p class="message-prose">{{ detail.summary }}</p></section><p class="message-prose">{{ detail.text }}</p><div v-if="detail.attachments?.length" @click="open_attachment" v-html="bridge.attachment_markup(detail.attachments)"></div><UButton v-if="detail.reply_to" :label="t('查看被回复的原文 #{id}', { id: detail.reply_to })" icon="i-lucide-corner-up-left" variant="outline" color="neutral" class="channel-surface-button" @click="follow_reply" /></template><div v-else class="grid gap-4 py-2" role="status" :aria-label="t('正在读取原文')"><USkeleton class="h-5 w-36" /><USkeleton v-for="line in 6" :key="line" class="h-4" :class="line % 3 ? 'w-full' : 'w-2/3'" /></div></div>
    </template>
  </UModal>
</template>

<script setup>
import { computed, inject, ref, watch } from "vue";
import CreateDiscussion from "./CreateDiscussion.vue";

const props = defineProps({ detailId: { type: Number, default: null }, targetRoom: { type: Object, default: null }, targetFolder: { type: Object, default: null }, readingOptions: { type: Array, default: () => [] }, effectOptions: { type: Array, default: () => [] } });
const mode = defineModel({ type: String, default: "" });
const reading_width = defineModel("readingWidth", { type: String, default: "default" });
const effects = defineModel("effects", { type: String, default: "full" });
const rendered_mode = ref(mode.value);
watch(mode, (value) => { if (value) rendered_mode.value = value; });
const { view, bridge, field, act, pending } = inject("discussion");
const open = computed({ get: () => Boolean(mode.value), set: (value) => { if (!value) mode.value = ""; } });
const titles = { settings: "外观设置", create: "新建房间", folder: "新建文件夹", "rename-folder": "重命名文件夹", "delete-folder": "移除文件夹", edit: "编辑议题", schedule: "安排专家发言", message: "消息原文" };
Object.assign(titles, { rename: "重命名频道", archive: "存档频道", restore: "恢复频道", delete: "删除频道" });
const descriptions = { settings: "选择适合你的讨论界面。", create: "组织一场讨论，或邀请 AI 一起完成任务。", edit: "维护目标、参与身份与当前进度。", schedule: "只填写本轮问题，专家按需阅读讨论资料。", message: "保留作者、来源、提交人和引用关系。" };
Object.assign(descriptions, { rename: "名称变化不会影响讨论记录和阅读地址。", archive: "保留所有记录，并暂停尚未收束的讨论。", restore: "移回讨论列表，保持当前讨论阶段。", delete: "永久删除频道及其所有记录，无法撤销。" });
titles.archives = "已存档频道";
descriptions.archives = "查看记录、恢复频道或彻底删除。";
const archived_rooms = computed(() => view.value.rooms.filter((room) => room.archived));
const archive_query = ref("");
const archive_content = ref("all");
const archive_content_options = [{ label: "全部频道", value: "all" }, { label: "有消息", value: "messages" }, { label: "无消息", value: "empty" }];
const archive_results = computed(() => filter_archived_channels(view.value.rooms,
  { query: archive_query.value, content: archive_content.value }));
const archive_delete_id = ref(null);
const archive_delete_all = ref(false);
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
  const rooms = archive_results.value.filter((room) => !archive_busy(room));
  archive_delete_all.value = false;
  for (const room of rooms) await act("manage_channel", { id: room.id, action: "delete" });
}

const management_title = ref("");
const folder_name = ref("");
watch(() => [mode.value, props.targetFolder?.id], () => { folder_name.value = mode.value === "rename-folder" ? props.targetFolder?.name || "" : ""; });
const folder_dialog = computed(() => ["folder", "rename-folder", "delete-folder"].includes(rendered_mode.value));
watch(() => [mode.value, props.targetRoom?.id], () => { management_title.value = mode.value === "rename" ? props.targetRoom?.title || "" : ""; });

/** Close directory confirmations immediately; background completion never closes a later dialog. */
async function save_management() {
  const request = { id: props.targetRoom.id, action: mode.value, title: management_title.value };
  mode.value = "";
  await act("manage_channel", request);
}

/** Capture the folder edit and release the dialog before saving. */
async function save_folder() {
  const name = folder_name.value.trim();
  if (!name || pending.value) return;
  const renaming = mode.value === "rename-folder";
  const request = renaming ? { id: props.targetFolder.id, name } : name;
  mode.value = "";
  await act(renaming ? "rename_folder" : "create_folder", request);
}

/** Release the confirmation immediately while only the group is removed. */
async function remove_folder() {
  const id = props.targetFolder.id;
  mode.value = "";
  await act("delete_folder", id);
}
const expert_container = "topic-expert-modes";
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const participants = Object.keys(bridge.identities).map((value) => ({ value, label: bridge.display_name(value) }));
const phases = Object.entries(bridge.phases).map(([value, label]) => ({ value, label }));
const expert_modes = [{ value: "none", label: "不参与" }, { value: "cli", label: "本地 AI · 自行发言" }, { value: "online", label: "在线 AI · 由人代发" }];
const details_open = ref(false);
const limits_locked = computed(() => !["preparing", "paused"].includes(view.value.room?.phase));
const limit_fields = [{ key: 'max_rounds', label: '讨论轮次上限', min: 0, max: 100 }, { key: 'max_minutes', label: '总时长（分钟）', min: 0, max: 1440 }, { key: 'execution_minutes', label: '单次 AI 执行（分钟，仅自动）', min: 0, max: 60 }];
const visible_limits = computed(() => limit_fields.filter(item => item.key !== 'execution_minutes'
  || view.value.room?.runtime?.mode === 'automatic'));
const pending_theme = ref(null);
const pending_attachment = ref(null);
const detail = ref(null);
const detail_error = ref("");
const turn_expert = field("turn-expert-select");
const turn_question = field("turn-question-input");
const themes = [{ value: "channel", title: "协作频道", description: "深灰界面 · 频道导航 · 成员侧栏" }, { value: "channel-light", title: "协作频道 · 浅色", description: "纯白界面 · 中性灰阶 · 清晰阅读" }];

/** Map the topic form onto the existing controller's draft fields. */
function form_id(key) {
  return `topic-${key}-${key === "host" || key === "phase" ? "select" : "input"}`;
}

/** Close a write dialog only after the controller confirms a successful save. */
async function save_form() {
  const action = mode.value === "create" ? "create" : mode.value === "edit" ? "save_topic" : "schedule";
  if (action === "create") {
    const folder_id = props.targetFolder?.id ?? null;
    // Keep the dialog open while the local service starts members, matching submit_room.
    const launching = view.value.fields['new-room-kind'] === 'free'
      ? Object.values(view.value.experts['new-expert-modes'] || {}).includes('cli') : view.value.launch.create && view.value.launch.available;
    if (!launching) mode.value = "";
    if (await act(action, folder_id) && launching) mode.value = "";
  } else if (await act(action)) mode.value = "";
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
  pending_attachment.value = { room_id: button.dataset.attachmentRoom, id: button.dataset.previewAttachment };
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
watch(() => [mode.value, props.detailId], async ([kind, id], previous, on_cleanup) => {
  if (kind !== "message" || !id || !view.value.room) return;
  let cancelled = false;
  on_cleanup(() => { cancelled = true; });
  detail.value = null;
  detail_error.value = "";
  try {
    const result = await bridge.request(`/api/rooms/${view.value.room.id}/messages/${id}`);
    if (!cancelled) detail.value = result;
  } catch (error) { if (!cancelled) detail_error.value = error.message; }
});

/** Follow a reply chain inside the same original-message dialog. */
async function follow_reply() {
  try { detail.value = await bridge.request(`/api/rooms/${view.value.room.id}/messages/${detail.value.reply_to}`); }
  catch (error) { detail_error.value = error.message; }
}
</script>

<template>
  <UModal v-model:open="open" :title="titles[rendered_mode] || '讨论'" :description="descriptions[rendered_mode]" :ui="{ content: ['glass-panel studio-modal', folder_dialog && 'channel-folder-modal', rendered_mode === 'archives' && 'channel-archive-modal', rendered_mode === 'create' && 'channel-create-modal'], body: 'dialog-body' }" @after:leave="after_dialog_leave">
    <template #body>
      <section v-if="rendered_mode === 'archives'" class="channel-archive-manager">
        <div class="channel-archive-toolbar">
          <UInput v-model="archive_query" icon="i-lucide-search" placeholder="搜索已存档频道" aria-label="搜索已存档频道" class="channel-archive-search" />
          <USelect v-model="archive_content" :items="archive_content_options" icon="i-lucide-list-filter" aria-label="筛选频道内容" />
          <UButton :label="`全部删除（${archive_results.length}）`" icon="i-lucide-trash-2" color="error" variant="soft" size="sm" class="channel-archive-delete-all" :disabled="!archive_results.length" @click="archive_delete_all = true; archive_delete_id = null" />
        </div>
        <div v-if="archive_delete_all && archive_results.length" class="channel-archive-confirm channel-archive-bulk" role="alert"><span>将永久删除当前列表中的 {{ archive_results.length }} 个频道及其全部记录，无法撤销。</span><UButton label="取消" color="neutral" variant="ghost" size="xs" @click="archive_delete_all = false" /><UButton label="全部删除" color="error" size="xs" @click="delete_all_archives" /></div>
        <p v-if="view.directory_error" role="alert" class="channel-directory-error">{{ view.directory_error }}</p>
        <div class="channel-archive-results">
          <ul v-if="archive_results.length" class="channel-archive-list" aria-label="已存档频道列表">
          <li v-for="room in archive_results" :key="room.id" class="channel-archive-item">
            <div class="channel-archive-row">
              <div class="channel-archive-info"><button class="channel-archive-title" :title="room.title" :disabled="Boolean(pending)" @click="read_archive(room)">{{ room.title }}</button><small><span v-if="room.created_at">创建于 <time :datetime="room.created_at">{{ archive_created(room.created_at) }}</time> · </span>{{ room.message_count }} 条消息</small></div>
              <div class="channel-archive-actions">
                <UButton :aria-label="`彻底删除 ${room.title}`" title="彻底删除" icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" class="channel-archive-delete" :disabled="archive_busy(room)" @click="archive_delete_id = room.id; archive_delete_all = false" />
                <UButton label="恢复" :aria-label="`恢复 ${room.title}`" color="neutral" variant="soft" size="xs" class="channel-archive-restore" :disabled="archive_busy(room)" @click="act('manage_channel', { id: room.id, action: 'restore' })" />
              </div>
            </div>
            <div v-if="archive_delete_id === room.id" class="channel-archive-confirm channel-archive-bulk" role="alert"><span>永久删除「{{ room.title }}」及其全部记录，无法撤销。</span><UButton label="取消" color="neutral" variant="ghost" size="xs" @click="archive_delete_id = null" /><UButton label="删除" color="error" size="xs" :disabled="archive_busy(room)" @click="delete_archive" /></div>
          </li>
          </ul>
        <p v-else class="channel-archive-empty">{{ archived_rooms.length ? '没有匹配的存档频道' : '暂无已存档频道' }}</p>
        </div>
      </section>
      <form v-else-if="rendered_mode === 'delete-folder'" class="dialog-form" @submit.prevent="remove_folder">
        <p class="fine-print">移除「{{ targetFolder?.name }}」后，频道不再归属文件夹，所有消息和存档状态都会保留。</p>
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" label="移除文件夹" color="neutral" variant="solid" /></div>
      </form>
      <form v-else-if="folder_dialog" class="dialog-form" @submit.prevent="save_folder">
        <UInput v-model="folder_name" icon="i-lucide-folder" :aria-label="rendered_mode === 'folder' ? '新文件夹名称' : '文件夹名称'" placeholder="文件夹名称" autofocus required :maxlength="40" class="w-full" autocomplete="off" :readonly="Boolean(pending)" @keydown.enter.prevent="!$event.isComposing && save_folder()" />
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'folder' ? '创建文件夹' : '保存名称'" class="channel-primary-button" :loading="pending === 'create_folder' || pending === 'rename_folder'" :disabled="!folder_name.trim() || Boolean(pending)" /></div>
      </form>
      <form v-else-if="['rename', 'archive', 'restore', 'delete'].includes(rendered_mode)" class="dialog-form" @submit.prevent="save_management">
        <p class="channel-management-target">{{ targetRoom?.title }} <span>· {{ targetRoom?.message_count }} 条消息</span></p>
        <p v-if="rendered_mode === 'archive'" class="fine-print">存档后可在侧栏「已存档」中查阅与恢复。已有发言安排会保留；专家需在下次检查时停止自己的定时任务。</p>
        <p v-if="rendered_mode === 'restore'" class="fine-print">恢复不会自动继续讨论；需要继续时，在主持设置中调整阶段。</p>
        <p v-if="rendered_mode === 'delete'" class="fine-print">消息、共识和发言安排将一起删除，无法撤销。</p>
        <UFormField v-if="rendered_mode === 'rename'" label="频道名称" required><UInput v-model="management_title" autofocus :maxlength="80" required class="w-full" autocomplete="off" /></UFormField>
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'delete' ? '永久删除' : rendered_mode === 'rename' ? '保存名称' : titles[rendered_mode]" :color="rendered_mode === 'delete' ? 'error' : 'primary'" :loading="pending === 'manage_channel'" :disabled="rendered_mode === 'rename' && !management_title.trim()" /></div>
      </form>
      <div v-else-if="rendered_mode === 'settings'">
        <div class="theme-choices"><button v-for="theme in themes" :key="theme.value" :class="{ chosen: view.theme === theme.value }" :aria-pressed="view.theme === theme.value" @click="choose_theme(theme.value)"><span class="theme-preview" :class="theme.value" aria-hidden="true"><i class="theme-preview-side"></i><i class="theme-preview-main"><b></b><b></b><b></b></i></span><span><strong>{{ theme.title }}</strong><small>{{ theme.description }}</small></span><span class="theme-check"><UIcon v-if="view.theme === theme.value" name="i-lucide-check" /></span></button></div>
        <section class="channel-reading-setting">
          <h3 id="channel-reading-label">对话宽度</h3>
          <div class="channel-reading-options" role="group" aria-labelledby="channel-reading-label"><UButton v-for="option in readingOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: reading_width === option.value }" :aria-pressed="reading_width === option.value" @click="reading_width = option.value" /></div>
        </section>
        <section class="channel-reading-setting">
          <h3 id="channel-effects-label">视觉效果</h3>
          <div class="channel-reading-options channel-effect-options" role="group" aria-labelledby="channel-effects-label"><UButton v-for="option in effectOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: effects === option.value }" :aria-pressed="effects === option.value" @click="effects = option.value" /></div>
          <p class="fine-print">精简模式关闭毛玻璃模糊与多层阴影，适合配置较低或需要更流畅滚动的设备。</p>
        </section>
      </div>
      <CreateDiscussion v-else-if="rendered_mode === 'create'" :target-folder="targetFolder" @submit="save_form" @cancel="mode = ''" />
      <form v-else-if="rendered_mode === 'edit'" class="dialog-form" @submit.prevent="save_form">
        <UFormField label="话题名称" required><UInput :model-value="view.fields[form_id('title')]" :maxlength="80" required placeholder="这次想讨论什么？" class="w-full" @update:model-value="bridge.write_field(form_id('title'), $event)" /></UFormField>
        <UFormField label="讨论目标"><UTextarea :model-value="view.fields[form_id('goal')]" :maxlength="1000" :rows="2" placeholder="希望通过讨论解决的问题" class="w-full" @update:model-value="bridge.write_field(form_id('goal'), $event)" /></UFormField>
        <div class="form-two-columns"><UFormField label="主持人"><USelect :model-value="view.fields[form_id('host')]" :items="participants" placeholder="选择主持人" class="w-full" @update:model-value="bridge.write_field(form_id('host'), $event)" /></UFormField><UFormField v-if="rendered_mode === 'edit'" label="阶段"><USelect :model-value="view.fields[form_id('phase')]" :items="phases" class="w-full" @update:model-value="bridge.write_field(form_id('phase'), $event)" /></UFormField></div>
        <UFormField v-if="rendered_mode === 'edit'" label="当前焦点"><UInput :model-value="view.fields[form_id('focus')]" :maxlength="1000" placeholder="当前最需要回应的问题" class="w-full" @update:model-value="bridge.write_field(form_id('focus'), $event)" /></UFormField>
        <section class="advanced-content"><h3>讨论上限</h3><div class="form-two-columns">
          <UFormField v-for="item in visible_limits" :key="item.key" :label="item.label"><UInput :model-value="view.fields[form_id(`limit-${item.key}`)]" type="number" :min="item.min" :max="item.max" :step="1" :disabled="limits_locked" :required="item.min > 0" :placeholder="item.min === 0 ? '留空不限' : '1–60'" class="w-full" @update:model-value="bridge.write_field(form_id(`limit-${item.key}`), $event)" /></UFormField>
          <UFormField label="达到上限后"><USelect :model-value="view.fields[form_id('limit-on_limit')] || 'pause'" :disabled="limits_locked" :items="[{value:'pause',label:'暂停保留现场'},{value:'summarize',label:'由主持人总结'}]" class="w-full" @update:model-value="bridge.write_field(form_id('limit-on_limit'), $event)" /></UFormField>
          <UFormField v-if="view.fields[form_id('limit-on_limit')] === 'summarize'" label="收束预留（分钟）"><UInput :model-value="view.fields[form_id('limit-summary_minutes')]" type="number" :min="1" :max="60" :step="1" :disabled="limits_locked" class="w-full" @update:model-value="bridge.write_field(form_id('limit-summary_minutes'), $event)" /></UFormField>
        </div><p class="fine-print">轮次、总时长、单次执行留空或 0 表示不限。一轮指每位专家各完成一次观点；首次进入讨论阶段或创建安排后计时，暂停期间不计时。收束预留计入总时长。</p><p v-if="limits_locked" class="fine-print">修改上限前，请先把阶段保存为“已暂停”。</p></section>
        <UCollapsible v-model:open="details_open" class="advanced-fields"><UButton :trailing-icon="details_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" label="用户原文、背景、边界与参与专家" color="neutral" variant="ghost" block class="advanced-trigger" /><template #content><div class="advanced-content"><UFormField v-for="item in [{ key: 'user_request', label: '用户原文' }, { key: 'background', label: '背景' }, { key: 'boundaries', label: '讨论边界' }]" :key="item.key" :label="item.label"><UTextarea :model-value="view.fields[form_id(item.key)]" :maxlength="4000" :rows="2" class="w-full" @update:model-value="bridge.write_field(form_id(item.key), $event)" /></UFormField><div class="expert-fields"><div v-for="name in experts" :key="name"><label>{{ name }}</label><USelect :model-value="view.experts[expert_container]?.[name] || 'none'" :items="expert_modes" :aria-label="`${name} 参与方式`" @update:model-value="bridge.write_expert(expert_container, name, $event === 'none' ? '' : $event)" /></div></div><p class="fine-print">AI 主持人需设为本地 CLI，可同时作为专家参与。</p></div></template></UCollapsible>
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" label="保存议题" :loading="pending === 'create' || pending === 'save_topic'" /></div>
      </form>
      <form v-else-if="rendered_mode === 'schedule'" class="dialog-form" @submit.prevent="save_form"><UFormField label="发言专家" required><USelect v-model="turn_expert" :items="Object.keys(view.room?.experts || {})" class="w-full" /></UFormField><UFormField label="需要回应的问题" required><UTextarea v-model="turn_question" :rows="5" :maxlength="1000" required class="w-full" placeholder="本轮希望这位专家回答什么？" /></UFormField><p class="fine-print">创建后为待通知状态；由主持人实际联系专家。</p><div class="dialog-actions"><UButton label="取消" variant="ghost" color="neutral" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" label="创建发言安排" :loading="pending === 'schedule'" /></div></form>
      <div v-else-if="rendered_mode === 'message'" class="original-message"><p v-if="detail_error" role="alert">{{ detail_error }}</p><template v-else-if="detail"><div class="original-meta"><strong>{{ bridge.display_name(detail.author) }}</strong><span>#{{ detail.id }}</span><UBadge color="neutral" variant="subtle">{{ bridge.sources[detail.source] }}</UBadge></div><p class="fine-print">{{ bridge.provenance(detail) }} · {{ new Date(detail.created_at).toLocaleString('zh-CN') }}</p><section v-if="detail.summary" class="channel-answer-summary"><small>回答摘要 · {{ bridge.display_name(detail.summary_by) }}</small><p class="message-prose">{{ detail.summary }}</p></section><p class="message-prose">{{ detail.text }}</p><div v-if="detail.attachments?.length" @click="open_attachment" v-html="bridge.attachment_markup(detail.attachments)"></div><UButton v-if="detail.reply_to" :label="`查看被回复的原文 #${detail.reply_to}`" icon="i-lucide-corner-up-left" variant="outline" color="neutral" class="channel-surface-button" @click="follow_reply" /></template><p v-else class="fine-print">正在读取原文…</p></div>
    </template>
  </UModal>
</template>

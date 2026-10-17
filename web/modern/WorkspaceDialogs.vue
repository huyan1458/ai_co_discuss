<script setup>
import { computed, inject, ref, watch } from "vue";

const props = defineProps({ detailId: { type: Number, default: null }, targetRoom: { type: Object, default: null }, readingOptions: { type: Array, default: () => [] } });
const mode = defineModel({ type: String, default: "" });
const reading_width = defineModel("readingWidth", { type: String, default: "default" });
const rendered_mode = ref(mode.value);
watch(mode, (value) => { if (value) rendered_mode.value = value; });
const { view, bridge, field, act, pending } = inject("discussion");
const open = computed({ get: () => Boolean(mode.value), set: (value) => { if (!value) mode.value = ""; } });
const titles = { settings: "外观设置", create: "新建讨论", folder: "新建文件夹", edit: "编辑议题", schedule: "安排专家发言", message: "消息原文" };
Object.assign(titles, { rename: "重命名频道", archive: "存档频道", restore: "恢复频道", delete: "删除频道" });
const descriptions = { settings: "选择适合你的讨论界面。", create: "围绕一个明确的问题，开始一场讨论。", edit: "维护目标、参与身份与当前进度。", schedule: "只填写本轮问题，专家按需阅读讨论资料。", message: "保留作者、来源、提交人和引用关系。" };
Object.assign(descriptions, { rename: "名称变化不会影响讨论记录和阅读地址。", archive: "保留所有记录，并暂停尚未收束的讨论。", restore: "移回讨论列表，保持当前讨论阶段。", delete: "永久删除频道及其所有记录，无法撤销。" });
const management_title = ref("");
const folder_name = ref("");
watch(mode, (value) => { if (value === "folder") folder_name.value = ""; });
watch(() => [mode.value, props.targetRoom?.id], () => { management_title.value = mode.value === "rename" ? props.targetRoom?.title || "" : ""; });

/** Close management only after its exact target has been saved successfully. */
async function save_management() {
  if (await act("manage_channel", { id: props.targetRoom.id, action: mode.value, title: management_title.value, confirm_title: management_title.value })) mode.value = "";
}

/** Close folder creation only after the name has been saved successfully. */
async function save_folder() {
  const name = folder_name.value.trim();
  if (!name || pending.value) return;
  if (await act("create_folder", name)) mode.value = "";
}
const form_prefix = computed(() => rendered_mode.value === "create" ? "new-room" : "topic");
const expert_container = computed(() => rendered_mode.value === "create" ? "new-expert-modes" : "topic-expert-modes");
const experts = Object.keys(bridge.identities).filter((name) => name !== "用户");
const participants = Object.keys(bridge.identities).map((value) => ({ value, label: bridge.display_name(value) }));
const phases = Object.entries(bridge.phases).map(([value, label]) => ({ value, label }));
const expert_modes = [{ value: "none", label: "不参与" }, { value: "cli", label: "本地 CLI · 读写" }, { value: "online", label: "在线 AI · 只读" }];
const details_open = ref(false);
const pending_theme = ref(null);
const detail = ref(null);
const detail_error = ref("");
const turn_expert = field("turn-expert-select");
const turn_question = field("turn-question-input");
const themes = [{ value: "channel", title: "协作频道", description: "频道导航 · 连续消息 · 成员侧栏", icon: "i-lucide-panels-top-left" }, { value: "millennium", title: "千禧聊天室", description: "钢蓝窗框 · 经典聊天", icon: "i-lucide-message-square" }];

/** Map both topic forms onto the existing controller's draft fields. */
function form_id(key) {
  if (rendered_mode.value === "create") return `${form_prefix.value}-${key}`;
  return `topic-${key}-${key === "host" || key === "phase" ? "select" : "input"}`;
}

/** Close a write dialog only after the controller confirms a successful save. */
async function save_form() {
  const action = mode.value === "create" ? "create" : mode.value === "edit" ? "save_topic" : "schedule";
  if (await act(action)) mode.value = "";
}

/** Close the overlay before switching its underlying renderer. */
function choose_theme(theme) { pending_theme.value = theme; mode.value = ""; }

/** Disable theme styles only after the outgoing modal has left the page. */
function finish_theme_change() {
  if (!pending_theme.value) return;
  bridge.theme(pending_theme.value);
  pending_theme.value = null;
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
  <UModal v-model:open="open" :title="titles[rendered_mode] || '讨论'" :description="descriptions[rendered_mode]" :ui="{ content: ['glass-panel studio-modal', rendered_mode === 'folder' && 'channel-folder-modal'], body: 'dialog-body' }" @after:leave="finish_theme_change">
    <template #body>
      <form v-if="rendered_mode === 'folder'" class="dialog-form" @submit.prevent="save_folder">
        <UInput v-model="folder_name" icon="i-lucide-folder" aria-label="新文件夹名称" placeholder="文件夹名称" autofocus required :maxlength="40" class="w-full" autocomplete="off" :readonly="Boolean(pending)" @keydown.enter.prevent="!$event.isComposing && save_folder()" />
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" label="创建文件夹" class="channel-primary-button" :loading="pending === 'create_folder'" :disabled="!folder_name.trim() || Boolean(pending)" /></div>
      </form>
      <form v-else-if="['rename', 'archive', 'restore', 'delete'].includes(rendered_mode)" class="dialog-form" @submit.prevent="save_management">
        <p class="channel-management-target">{{ targetRoom?.title }} <span>· {{ targetRoom?.message_count }} 条消息</span></p>
        <p v-if="rendered_mode === 'archive'" class="fine-print">存档后可在侧栏「已存档」中查阅与恢复。已有发言安排会保留；专家需在下次检查时停止自己的定时任务。</p>
        <p v-if="rendered_mode === 'restore'" class="fine-print">恢复不会自动继续讨论；需要继续时，在主持设置中调整阶段。</p>
        <p v-if="rendered_mode === 'delete'" class="fine-print">消息、共识和发言安排将一起删除。请先结束该频道的外部定时任务，再输入完整频道名称确认。</p>
        <UFormField v-if="rendered_mode === 'rename' || rendered_mode === 'delete'" :label="rendered_mode === 'delete' ? '输入完整频道名称' : '频道名称'" required><UInput v-model="management_title" autofocus :maxlength="80" required class="w-full" autocomplete="off" /></UFormField>
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" :label="rendered_mode === 'delete' ? '永久删除' : rendered_mode === 'rename' ? '保存名称' : titles[rendered_mode]" :color="rendered_mode === 'delete' ? 'error' : 'primary'" :loading="pending === 'manage_channel'" :disabled="rendered_mode === 'delete' ? management_title !== targetRoom?.title : rendered_mode === 'rename' && !management_title.trim()" /></div>
      </form>
      <div v-else-if="rendered_mode === 'settings'">
        <div class="theme-choices"><button v-for="theme in themes" :key="theme.value" :class="{ chosen: view.theme === theme.value }" :aria-pressed="view.theme === theme.value" @click="choose_theme(theme.value)"><span class="theme-preview" :class="theme.value"><UIcon :name="theme.icon" /></span><span><strong>{{ theme.title }}</strong><small>{{ theme.description }}</small></span><UIcon v-if="view.theme === theme.value" name="i-lucide-check" class="theme-check" /></button></div>
        <section class="channel-reading-setting">
          <h3 id="channel-reading-label">对话宽度</h3>
          <div class="channel-reading-options" role="group" aria-labelledby="channel-reading-label"><UButton v-for="option in readingOptions" :key="option.value" :label="option.label" color="neutral" variant="ghost" :class="{ chosen: reading_width === option.value }" :aria-pressed="reading_width === option.value" @click="reading_width = option.value" /></div>
        </section>
      </div>
      <form v-else-if="rendered_mode === 'create' || rendered_mode === 'edit'" class="dialog-form" @submit.prevent="save_form">
        <UFormField label="话题名称" required><UInput :model-value="view.fields[form_id('title')]" :maxlength="80" required placeholder="这次想讨论什么？" class="w-full" @update:model-value="bridge.write_field(form_id('title'), $event)" /></UFormField>
        <UFormField label="讨论目标"><UTextarea :model-value="view.fields[form_id('goal')]" :maxlength="1000" :rows="2" placeholder="希望通过讨论解决的问题" class="w-full" @update:model-value="bridge.write_field(form_id('goal'), $event)" /></UFormField>
        <div class="form-two-columns"><UFormField label="主持人"><USelect :model-value="view.fields[form_id('host')]" :items="participants" class="w-full" @update:model-value="bridge.write_field(form_id('host'), $event)" /></UFormField><UFormField v-if="rendered_mode === 'edit'" label="阶段"><USelect :model-value="view.fields[form_id('phase')]" :items="phases" class="w-full" @update:model-value="bridge.write_field(form_id('phase'), $event)" /></UFormField></div>
        <UFormField v-if="rendered_mode === 'edit'" label="当前焦点"><UInput :model-value="view.fields[form_id('focus')]" :maxlength="1000" placeholder="当前最需要回应的问题" class="w-full" @update:model-value="bridge.write_field(form_id('focus'), $event)" /></UFormField>
        <UCollapsible v-model:open="details_open" class="advanced-fields"><UButton :trailing-icon="details_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" label="背景、边界与参与专家" color="neutral" variant="ghost" block class="advanced-trigger" /><template #content><div class="advanced-content"><UFormField v-for="item in [{ key: 'background', label: '背景' }, { key: 'boundaries', label: '讨论边界' }]" :key="item.key" :label="item.label"><UTextarea :model-value="view.fields[form_id(item.key)]" :maxlength="4000" :rows="2" class="w-full" @update:model-value="bridge.write_field(form_id(item.key), $event)" /></UFormField><div class="expert-fields"><div v-for="name in experts" :key="name"><label>{{ name }}</label><USelect :model-value="view.experts[expert_container]?.[name] || 'none'" :items="expert_modes" :aria-label="`${name} 参与方式`" @update:model-value="bridge.write_expert(expert_container, name, $event === 'none' ? '' : $event)" /></div></div><p class="fine-print">AI 主持人需设为本地 CLI，可同时作为专家参与。</p></div></template></UCollapsible>
        <div class="dialog-actions"><UButton label="取消" color="neutral" variant="ghost" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" :label="rendered_mode === 'create' ? '创建讨论' : '保存议题'" :loading="pending === 'create' || pending === 'save_topic'" /></div>
      </form>
      <form v-else-if="rendered_mode === 'schedule'" class="dialog-form" @submit.prevent="save_form"><UFormField label="发言专家" required><USelect v-model="turn_expert" :items="Object.keys(view.room?.experts || {})" class="w-full" /></UFormField><UFormField label="需要回应的问题" required><UTextarea v-model="turn_question" :rows="5" :maxlength="1000" required class="w-full" placeholder="本轮希望这位专家回答什么？" /></UFormField><p class="fine-print">创建后为待通知状态；由主持人实际联系专家。</p><div class="dialog-actions"><UButton label="取消" variant="ghost" color="neutral" @click="mode = ''" /><UButton type="submit" class="channel-primary-button" label="创建发言安排" :loading="pending === 'schedule'" /></div></form>
      <div v-else-if="rendered_mode === 'message'" class="original-message"><p v-if="detail_error" role="alert">{{ detail_error }}</p><template v-else-if="detail"><div class="original-meta"><strong>{{ bridge.display_name(detail.author) }}</strong><span>#{{ detail.id }}</span><UBadge color="neutral" variant="subtle">{{ bridge.sources[detail.source] }}</UBadge></div><p class="fine-print">{{ bridge.provenance(detail) }} · {{ new Date(detail.created_at).toLocaleString('zh-CN') }}</p><section v-if="detail.summary" class="channel-answer-summary"><small>回答摘要 · {{ bridge.display_name(detail.summary_by) }}</small><p class="message-prose">{{ detail.summary }}</p></section><p class="message-prose">{{ detail.text }}</p><UButton v-if="detail.reply_to" :label="`查看被回复的原文 #${detail.reply_to}`" icon="i-lucide-corner-up-left" variant="outline" color="neutral" class="channel-surface-button" @click="follow_reply" /></template><p v-else class="fine-print">正在读取原文…</p></div>
    </template>
  </UModal>
</template>

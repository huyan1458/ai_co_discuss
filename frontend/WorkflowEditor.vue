<script setup>
/**
 * One workflow in an editor, new, imported or saved: its name, description, the host's SKILL.md and its member cards.
 * Nothing is written until 保存; the local service checks every field. The ID is the folder name, set by the program.
 */
import { computed, inject, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ExpertCard from "./ExpertCard.vue";
import RosterAdd from "./RosterAdd.vue";
import { access_label } from "../runner/expert_prompts.mjs";

const open = defineModel("open", { type: Boolean, default: false });
// `workflowId` loads a saved workflow; otherwise `draft` (a new or imported one) is edited.
const props = defineProps({ workflowId: { type: String, default: "" }, draft: { type: Object, default: null } });
const emit = defineEmits(["saved", "deleted"]);
const { view, bridge, act } = inject("discussion");
const MAX_SKILL = 20000;
const PRESET_PREFIX = "preset:";
// A card ID becomes the member name's suffix; 16 characters at most, so a numbered one keeps room for its digits.
const CARD_BASE = /^[a-z0-9_]{1,14}$/;
const PRESET_FIELDS = ["label", "description", "project_access", "model", "effort", "system_prompt"];
const platforms = Object.keys(bridge.identities).filter((name) => name !== "用户");
const workflow = ref(null);
const busy = ref(false);
const previewing = ref(false);
const deleting = ref(false);
const saved = computed(() => Boolean(props.workflowId));
// An import carrying an ID already in the library replaces that workflow when saved.
const replaced = computed(() => !saved.value && (view.value.launch.workflows || []).find((item) => item.id === workflow.value?.id));
const rendered = computed(() => previewing.value ? window.discuss_markdown.render_markdown(workflow.value.skill || "") : "");
const roster_items = computed(() => [...platforms.map((name) => ({ value: name, name: bridge.display_name(name), ...bridge.identities[name],
  title: `添加一张 ${bridge.display_name(name)} 卡片`, aria_label: `添加 ${name} 卡片` })),
  ...view.value && bridge.expert_presets().map((preset, index) => ({ value: PRESET_PREFIX + preset.name, name: preset.label || preset.name,
    ...bridge.identities[bridge.platform_of(preset.name)], separated: index === 0, title: preset.description || "专家预设", aria_label: `按预设 ${preset.label || preset.name} 添加卡片` }))]);

/** Run one request, report its failure on the toast and keep the editor open. */
async function run(action) {
  busy.value = true;
  try { return await action(); }
  catch (error) { bridge.notify("error", error.message); return null; }
  finally { busy.value = false; }
}

watch(open, async (value) => {
  if (!value) return;
  previewing.value = false;
  if (!props.workflowId) {
    const draft = JSON.parse(JSON.stringify(props.draft || {}));
    workflow.value = { label: "", description: "", skill: "", agents: [], ...draft, id: draft.id || `workflow-${Date.now().toString(36)}` };
    return;
  }
  workflow.value = null;
  workflow.value = await run(() => bridge.local_request("workflows", { action: "get", id: props.workflowId }));
  if (!workflow.value) open.value = false;
}, { immediate: true });

/** The first free card ID from a base: writer, writer2 … or role1, role2 … */
function next_card(base) {
  const taken = new Set(workflow.value.agents.map((agent) => agent.card.toLowerCase()));
  const root = CARD_BASE.test(base) ? base : "role";
  for (let number = 1; ; number++) {
    const card = number === 1 && root !== "role" ? root : `${root}${number}`;
    if (!taken.has(card)) return card;
  }
}

/** Add a blank card on a platform, or one filled from an expert preset. */
function add_card(value) {
  if (!value.startsWith(PRESET_PREFIX)) {
    const card = next_card("role");
    workflow.value.agents.push({ card, name: `${value}-${card}`, project_access: "read" });
    return;
  }
  const preset = bridge.expert_presets().find((item) => item.name === value.slice(PRESET_PREFIX.length));
  if (!preset) return;
  const platform = bridge.platform_of(preset.name);
  const card = next_card(preset.name.slice(platform.length + 1).toLowerCase());
  const fields = Object.fromEntries(PRESET_FIELDS.filter((key) => preset[key]).map((key) => [key, preset[key]]));
  workflow.value.agents.push({ project_access: "read", ...fields, card, name: `${platform}-${card}` });
}

/** Add the current room's members as cards, prompts verbatim; the user then edits or removes them. */
async function cards_from_room() {
  const result = await run(() => bridge.local_request("workflows", { action: "room-cards", room_id: view.value.room.id }));
  if (!result) return;
  for (const item of result.cards) {
    const card = next_card(item.card.toLowerCase().slice(0, 14));
    workflow.value.agents.push({ ...item, card, name: `${bridge.platform_of(item.name)}-${card}` });
  }
  bridge.notify("info", `已从当前房间带入 ${result.cards.length} 张卡片；请删去不需要的，并确认提示词里没有本机路径或密钥`);
}

/** An imported card asked for more than reading; the user grants it card by card. */
function grant(agent, allowed) {
  agent.project_access = allowed ? agent.requested_access : "read";
}

/** Save the workflow as files; the server checks every field. A saved workflow keeps its folder's other files as they are. */
async function save() {
  const { resources, ...edited } = workflow.value;
  const result = await run(() => bridge.local_request("workflows", { action: "save", workflow: saved.value ? edited : workflow.value }));
  if (!result) return;
  bridge.notify("info", `已保存工作流「${result.label || result.id}」`);
  open.value = false;
  emit("saved", result);
}

/** Delete the saved workflow the user confirmed. */
async function remove() {
  if (!await run(() => bridge.local_request("workflows", { action: "delete", id: props.workflowId }))) return;
  open.value = false;
  emit("deleted", props.workflowId);
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="saved ? '编辑工作流' : '新建工作流'"
    description="做法说明给主持人读，成员卡片是它带来的成员。启用后怎么做由主持人按说明组织，程序不保证工序。"
    :ui="{ content: 'glass-panel studio-modal workflow-editor-modal', body: 'dialog-body' }">
    <template #body>
      <p v-if="!workflow" class="fine-print">正在读取工作流…</p>
      <form v-else id="workflow-editor-form" class="workflow-editor" @submit.prevent="save">
        <UFormField label="名称" required><UInput v-model="workflow.label" :maxlength="32" autofocus placeholder="例如：小说剧本连载" class="w-full" /></UFormField>
        <UFormField label="一句话描述" description="主持人凭它判断什么时候用这个工作流。">
          <UInput v-model="workflow.description" :maxlength="500" placeholder="例如：主持人定方向与骨架，写手按任务书写集，批评家挑常识与设定硬伤。" class="w-full" />
        </UFormField>
        <UFormField label="做法说明（SKILL.md）" required :description="`给主持人读：按成员名称说明分工、顺序和产物位置，不引用卡片提示词。${workflow.skill.length} / ${MAX_SKILL}`">
          <template #hint><button type="button" class="workflow-editor-toggle" :aria-pressed="previewing" @click="previewing = !previewing">{{ previewing ? '编辑' : '预览' }}</button></template>
          <div v-if="previewing" class="workflow-editor-preview markdown-body" v-html="rendered"></div>
          <UTextarea v-else v-model="workflow.skill" :rows="10" autoresize :maxrows="20" :maxlength="MAX_SKILL" class="w-full" />
        </UFormField>
        <section class="workflow-editor-cards" aria-label="成员卡片">
          <h4>成员卡片<small>{{ workflow.agents.length }}</small></h4>
          <RosterAdd label="添加成员卡片" :items="roster_items" @add="add_card" />
          <div v-if="workflow.agents.length" class="workflow-editor-grid">
            <div v-for="(agent, index) in workflow.agents" :key="agent.card" class="workflow-editor-card">
              <ExpertCard v-model:preset="workflow.agents[index]" :name="agent.name" mode="cli" :status="{ text: '', tone: '' }"
                :access_locked="Boolean(agent.requested_access && agent.project_access === 'read')" @remove="workflow.agents.splice(index, 1)" />
              <label v-if="agent.requested_access" class="workflow-editor-grant"><input type="checkbox" :checked="agent.project_access !== 'read'" @change="grant(agent, $event.target.checked)" />
                允许卡片要求的「{{ access_label(agent.requested_access) }}」</label>
            </div>
          </div>
          <p v-else class="workflow-editor-empty">还没有成员卡片。点上方添加；只有做法说明时，主持人带着房间里已有的成员按它做。</p>
          <UButton v-if="view.room?.id" icon="i-lucide-users" label="从当前房间成员导入" size="xs" color="neutral" variant="soft" class="workflow-editor-room" :loading="busy" @click="cards_from_room" />
        </section>
        <p v-if="replaced" class="fine-print is-warn">工作流库里已有同 ID 的「{{ replaced.label }}」，保存会覆盖它。</p>
        <p v-if="saved" class="fine-print workflow-editor-path">修改会作用于所有启用它的房间，成员下一次执行时读到新内容。文件夹：{{ workflow.directory }}
          <UButton label="复制路径" size="xs" variant="ghost" icon="i-lucide-copy" @click="act('copy', workflow.directory)" /></p>
      </form>
    </template>
    <template #footer>
      <UButton v-if="saved" icon="i-lucide-trash-2" label="删除" color="error" variant="ghost" :disabled="busy || !workflow" @click="deleting = true" />
      <span class="workflow-editor-spacer" />
      <UButton label="取消" color="neutral" variant="ghost" @click="open = false" />
      <UButton type="submit" form="workflow-editor-form" label="保存" class="channel-primary-button" :loading="busy"
        :disabled="!workflow || !workflow.label.trim() || !workflow.skill.trim()" />
    </template>
  </UModal>
  <ConfirmDialog :open="deleting" :title="`删除工作流「${workflow?.label || ''}」`" description="工作流文件夹会从本机删除，无法撤销。"
    :items="['已启用它的房间会显示“工作流不可用”，成员改用房间里的设置。', '房间成员、消息记录和项目文件不受影响。']" confirm-label="删除" danger
    @update:open="(value) => { if (!value) deleting = false; }" @confirm="remove" />
</template>

<style scoped>
.workflow-editor { display: flex; flex-direction: column; gap: 14px; }
.workflow-editor-toggle { color: var(--ui-text-muted); font-size: 12px; }
.workflow-editor-toggle:hover { color: var(--ui-text-highlighted); }
.workflow-editor-preview { min-height: 120px; max-height: 420px; overflow: auto; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.workflow-editor-cards { display: grid; gap: 10px; }
.workflow-editor-cards h4 { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; }
.workflow-editor-cards h4 small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
/* Same card grid as the new-room member list. */
.workflow-editor-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(248px, 100%), 272px)); align-items: start; gap: 8px; }
.workflow-editor-card { display: grid; gap: 6px; }
.workflow-editor-grant { display: flex; gap: 6px; align-items: flex-start; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-editor-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.workflow-editor-room { justify-self: start; }
.workflow-editor-path { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; overflow-wrap: anywhere; }
.workflow-editor .fine-print { margin: 0; }
.workflow-editor .is-warn { color: var(--ui-warning, #e0a33a); }
.workflow-editor-spacer { flex: 1; }
@media (max-width: 600px) { .workflow-editor-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>

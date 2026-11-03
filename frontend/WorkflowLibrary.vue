<script setup>
/**
 * The workflow library: list, create, edit, delete and import workflows kept on this computer.
 * A workflow is a host's SKILL.md plus agent cards (expert presets); the program only stores and loads them.
 */
import { computed, inject, ref, watch } from "vue";
import ExpertCard from "./ExpertCard.vue";

const open = defineModel("open", { type: Boolean, default: false });
const { view, bridge, act } = inject("discussion");
const MAX_SKILL = 20000;
const ACCESS = [{ value: "read", label: "只读" }, { value: "write", label: "可写（改文件、运行命令）" },
  { value: "auto", label: "自动（软件自动审批）" }, { value: "full", label: "全放开（不审批、不沙箱）" }];
const platforms = Object.keys(bridge.identities).filter((name) => name !== "用户");
const workflows = computed(() => view.value.launch.workflows || []);
// The page shown: the list, the paste box, or the editor holding one workflow draft.
const page = ref("list");
const draft = ref(null);
const is_new = ref(false);
const busy = ref(false);
const parts = ref([""]);
const folder = ref("");
// Picking a folder is a dialog on the computer itself; another device imports by pasting.
const local_screen = computed(() => view.value.launch.available && !view.value.launch.relay);

watch(open, (value) => { if (value) { page.value = "list"; draft.value = null; } });

/** Run one library request, report its failure on the toast and keep the dialog open. */
async function run(action) {
  busy.value = true;
  try { return await action(); }
  catch (error) { bridge.notify("error", error.message); return null; }
  finally { busy.value = false; }
}

/** Start an empty workflow. */
function create() {
  draft.value = { id: "", label: "", description: "", skill: "", agents: [] };
  is_new.value = true;
  page.value = "edit";
}

/** Open a saved workflow in the editor. */
async function edit(id) {
  const workflow = await run(() => bridge.local_request("workflows", { action: "get", id }));
  if (!workflow) return;
  draft.value = workflow;
  is_new.value = false;
  page.value = "edit";
}

/** Delete one workflow after the user confirms. */
async function remove(item) {
  if (!window.confirm(`删除工作流「${item.label}」？已启用它的房间会提示“工作流不可用”。`)) return;
  if (await run(() => bridge.local_request("workflows", { action: "delete", id: item.id }))) await bridge.reload_workflows();
}

/** Parse pasted drafts or a folder into the editor; nothing is saved until the user saves. */
async function preview(input) {
  const result = await run(() => bridge.local_request("workflows", { action: "preview", ...input }));
  if (!result) return;
  draft.value = result;
  is_new.value = true;
  page.value = "edit";
  if (result.ignored?.length) bridge.notify("warning", `已忽略不支持的文件：${result.ignored.join("、")}`);
}

/** Choose the folder on this computer, then preview it. */
async function import_folder() {
  if (!folder.value) folder.value = await run(() => bridge.local_request("pick-directory", {}).then((result) => result.path || "")) || "";
  if (folder.value) await preview({ folder: folder.value });
}

/** Add the current room's members as cards, prompts verbatim; the user then edits or removes them. */
async function cards_from_room() {
  const result = await run(() => bridge.local_request("workflows", { action: "room-cards", room_id: view.value.room.id }));
  if (!result) return;
  const taken = new Set(draft.value.agents.map((agent) => agent.card.toLowerCase()));
  const names = new Set(draft.value.agents.map((agent) => agent.name));
  for (const card of result.cards) {
    const platform = bridge.platform_of(card.name);
    let id = card.card, name = card.name;
    for (let number = 2; taken.has(id.toLowerCase()) || names.has(name); number++) {
      id = `${card.card.slice(0, 16 - String(number).length)}${number}`;
      name = `${platform}-${id}`;
    }
    taken.add(id.toLowerCase()); names.add(name);
    draft.value.agents.push({ ...card, card: id, name });
  }
  bridge.notify("info", `已从当前房间带入 ${result.cards.length} 张卡片；请删去不需要的，并确认提示词里没有本机路径或密钥`);
}

/** A new card on a platform, named platform-card as the format expects. */
function add_card(platform) {
  const taken = new Set(draft.value.agents.map((agent) => agent.card.toLowerCase()));
  let number = draft.value.agents.length + 1;
  while (taken.has(`role${number}`)) number++;
  draft.value.agents.push({ card: `role${number}`, name: `${platform}-role${number}`, project_access: "read" });
}

/** Keep a card's name following its ID and platform, as `platform-card`. */
function rename(agent, platform = bridge.platform_of(agent.name) || platforms[0]) {
  if (platform !== bridge.platform_of(agent.name)) {
    agent.model = "";
    agent.effort = "";
    agent.needs_platform = !view.value.launch.profiles[platform]?.adapter;
  }
  agent.name = `${platform}-${agent.card}`;
}

/** An imported card asked for more than reading; the user grants it card by card. */
function grant(agent, allowed) {
  agent.project_access = allowed ? agent.requested_access : "read";
}

/** Save the draft as files; the server checks every field. */
async function save() {
  const saved = await run(() => bridge.local_request("workflows", { action: "save", workflow: draft.value }));
  if (!saved) return;
  await bridge.reload_workflows();
  bridge.notify("info", `已保存工作流「${saved.label || saved.id}」`);
  page.value = "list";
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" title="工作流库"
    description="工作流 = 一份给主持人读的做法说明（SKILL.md）+ 一组 Agent 卡片。启用后带来做法和成员，不保证工序：怎么做由主持人按说明组织。"
    :ui="{ content: 'glass-panel studio-modal workflow-library-modal', body: 'dialog-body' }">
    <template #body>
      <div v-if="page === 'list'" class="workflow-library">
        <ul v-if="workflows.length" class="workflow-library-list">
          <li v-for="item in workflows" :key="item.id">
            <div><strong>{{ item.label }}</strong><small>{{ item.id }} · {{ item.cards }} 张卡片</small>
              <p v-if="item.error" class="is-error">{{ item.error }}</p><p v-else-if="item.description">{{ item.description }}</p></div>
            <UButton label="编辑" size="sm" variant="soft" :disabled="busy || Boolean(item.error)" @click="edit(item.id)" />
            <UButton icon="i-lucide-trash-2" size="sm" color="neutral" variant="ghost" :aria-label="`删除工作流 ${item.label}`" :disabled="busy" @click="remove(item)" />
          </li>
        </ul>
        <p v-else class="workflow-library-empty">还没有工作流。可以新建，也可以让房间的主持人把做法起草成工作流，再粘贴导入。</p>
        <div class="workflow-library-actions">
          <UButton icon="i-lucide-plus" label="新建" variant="soft" @click="create" />
          <UButton icon="i-lucide-clipboard-paste" label="粘贴导入" variant="soft" @click="parts = ['']; page = 'paste'" />
          <template v-if="local_screen">
            <UInput v-model="folder" placeholder="工作流文件夹的完整路径（留空则弹出选择框）" class="workflow-library-folder" />
            <UButton icon="i-lucide-folder-input" label="从文件夹导入" variant="soft" :loading="busy" @click="import_folder" />
          </template>
        </div>
        <p class="fine-print">工作流保存在本机服务目录的 workflows 文件夹里，一个工作流一个文件夹；分享时直接复制该文件夹。导入的内容只是文本，不代表来源可信。</p>
      </div>

      <form v-else-if="page === 'paste'" class="workflow-library" @submit.prevent="preview({ parts: parts.filter((part) => part.trim()) })">
        <p class="fine-print">把主持人起草的工作流消息原样粘贴进来；拆成多条的，每条一段。</p>
        <UTextarea v-for="(part, index) in parts" :key="index" v-model="parts[index]" :rows="6" autoresize :maxrows="14" class="w-full" :aria-label="`第 ${index + 1} 段草稿`" placeholder="<!-- workflow-part: 1/1 id: ... -->" />
        <div class="workflow-library-actions">
          <UButton icon="i-lucide-plus" label="再加一段" color="neutral" variant="ghost" @click="parts.push('')" />
          <span class="workflow-library-spacer" />
          <UButton label="返回" color="neutral" variant="ghost" @click="page = 'list'" />
          <UButton type="submit" label="解析并预览" class="channel-primary-button" :loading="busy" :disabled="!parts.some((part) => part.trim())" />
        </div>
      </form>

      <form v-else class="workflow-library" @submit.prevent="save">
        <div class="workflow-library-grid">
          <UFormField label="ID" description="文件夹名：小写英文、数字、- 和 _"><UInput v-model="draft.id" :disabled="!is_new" :maxlength="40" class="w-full" /></UFormField>
          <UFormField label="显示名"><UInput v-model="draft.label" :maxlength="32" class="w-full" /></UFormField>
        </div>
        <UFormField label="一句话描述"><UInput v-model="draft.description" :maxlength="500" class="w-full" /></UFormField>
        <UFormField label="SKILL.md 正文（给主持人读）" :description="`只按角色的显示名、描述和产物路径说话，不引用卡片提示词；API 主持人读不到卡片。${draft.skill.length} / ${MAX_SKILL}`">
          <UTextarea v-model="draft.skill" :rows="10" autoresize :maxrows="20" :maxlength="MAX_SKILL" class="w-full" />
        </UFormField>
        <div v-if="!is_new" class="workflow-library-actions">
          <p class="fine-print">修改会作用于所有启用它的房间：主持人和工作流成员下一次执行时读到新内容。文件夹：{{ draft.directory }}</p>
          <UButton label="复制路径" size="xs" variant="ghost" icon="i-lucide-copy" @click="act('copy', draft.directory)" />
        </div>
        <section class="workflow-library-cards" aria-label="Agent 卡片">
          <h4>Agent 卡片（{{ draft.agents.length }}）</h4>
          <article v-for="(agent, index) in draft.agents" :key="index" class="workflow-library-card">
            <div class="workflow-library-grid">
              <UFormField label="卡片 ID"><UInput v-model="agent.card" :maxlength="16" class="w-full" @update:model-value="rename(agent)" /></UFormField>
              <UFormField label="平台"><USelect :model-value="bridge.platform_of(agent.name) || ''" :items="platforms" class="w-full" @update:model-value="rename(agent, $event)" /></UFormField>
            </div>
            <label v-if="agent.requested_access" class="workflow-library-grant"><input type="checkbox" :checked="agent.project_access !== 'read'" @change="grant(agent, $event.target.checked)" />
              卡片要求「{{ ACCESS.find((item) => item.value === agent.requested_access)?.label }}」，默认按只读导入，勾选后允许</label>
            <p v-if="agent.needs_platform" class="fine-print is-warn">本机还没有配置 {{ bridge.platform_of(agent.name) }}，请换一个平台。</p>
            <ExpertCard v-model:preset="draft.agents[index]" :name="agent.name" mode="cli" :status="{ text: '', tone: '' }"
              :access_locked="Boolean(agent.requested_access && agent.project_access === 'read')" @remove="draft.agents.splice(index, 1)" />
          </article>
          <div class="workflow-library-actions">
            <span class="fine-print">添加卡片：</span>
            <UButton v-for="platform in platforms" :key="platform" :label="bridge.display_name(platform)" size="xs" variant="soft" @click="add_card(platform)" />
            <UButton v-if="view.room?.id" icon="i-lucide-users" label="从当前房间成员导入" size="xs" color="neutral" variant="soft" :loading="busy" @click="cards_from_room" />
          </div>
        </section>
        <div class="workflow-library-actions">
          <span class="workflow-library-spacer" />
          <UButton label="返回" color="neutral" variant="ghost" @click="page = 'list'" />
          <UButton type="submit" label="保存" class="channel-primary-button" :loading="busy" :disabled="!draft.id || !draft.skill.trim()" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.workflow-library { display: flex; flex-direction: column; gap: 12px; }
.workflow-library-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.workflow-library-list li { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.workflow-library-list li > div { flex: 1; min-width: 0; }
.workflow-library-list strong { margin-right: 8px; color: var(--ui-text-highlighted); font-size: 13px; }
.workflow-library-list small { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-library-list p { margin: 2px 0 0; overflow: hidden; color: var(--ui-text-toned); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.workflow-library .is-error, .workflow-library .is-warn { color: var(--ui-warning, #e0a33a); }
.workflow-library-empty { margin: 0; padding: 18px 12px; border: 1px dashed var(--ui-border); border-radius: 8px; text-align: center; color: var(--ui-text-muted); font-size: 12px; }
.workflow-library-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.workflow-library-spacer { flex: 1; }
.workflow-library-folder { flex: 1; min-width: 220px; }
.workflow-library-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.workflow-library-cards { display: grid; gap: 8px; }
.workflow-library-cards h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; }
.workflow-library-card { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; }
.workflow-library-card > button { justify-self: end; }
.workflow-library-grant { display: flex; gap: 6px; align-items: flex-start; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-library .fine-print { margin: 0; }
</style>

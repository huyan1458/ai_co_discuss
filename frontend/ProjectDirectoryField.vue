<script setup>
/** Launch cwd field: type a path, pick a saved project, or browse on the service computer from its own browser.
 * A device without the local service picks only among the projects its paired computer published. */
import { computed, inject, nextTick, ref } from "vue";

const props = defineProps({ placeholder: { type: String, default: "输入完整路径，或选择项目" }, disabled: { type: Boolean, default: false } });
const { view, bridge } = inject("discussion");
const launch = computed(() => view.value.launch);
// Without the local service here, the paired computer resolves the chosen project to its own folder.
const relay = computed(() => launch.value.available ? null : launch.value.relay);
const projects = computed(() => relay.value ? relay.value.projects : launch.value.projects || []);
// The folder dialog opens on the computer running the service, so only its own browser (not a connected website) offers it.
const browsable = computed(() => launch.value.available && !launch.value.remote);
const cwd = computed(() => launch.value.workspace.cwd || "");
const chosen = computed(() => relay.value ? projects.value.find((project) => project.id === launch.value.workspace.local_project)
  : projects.value.find((project) => same_path(project.path, cwd.value)));

/** Windows paths compare without case or trailing separators. */
function same_path(left, right) {
  const normalize = (value) => String(value || "").replace(/[\\/]+$/, "").toLowerCase();
  return Boolean(left) && normalize(left) === normalize(right);
}
const write_cwd = (path) => bridge.write_launch("workspace", "cwd", path);
const choose = (project) => relay.value ? bridge.write_launch("workspace", "local_project", project?.id || "") : write_cwd(project.path);

const picking = ref(false);
/** Open the computer's folder dialog through the local service; typing a path remains available. */
async function pick_directory() {
  picking.value = true;
  try { await bridge.pick_launch_directory(); } finally { picking.value = false; }
}

const menu_items = computed(() => [
  [{ type: "label", label: relay.value ? `电脑「${relay.value.name}」上的项目` : "常用项目" },
    ...projects.value.map((project) => ({ label: project.name, description: relay.value ? undefined : project.path, icon: "i-lucide-folder",
      ...(chosen.value === project ? { trailingIcon: "i-lucide-check" } : {}), onSelect: () => choose(project) }))],
  relay.value ? (chosen.value ? [{ label: "不指定项目", icon: "i-lucide-circle-slash", onSelect: () => choose(null) }] : [])
    : [{ label: "管理项目…", icon: "i-lucide-settings-2", onSelect: open_manager }],
].filter((group) => group.length));

// ---- Manager: edit a draft of the list, saved as a whole on the service computer. ----
const managing = ref(false);
const draft = ref([]);
const editing = ref(-1);
const adding = ref(null);
const saving = ref(false);
const browsing = ref("");
const error = ref("");
const add_name = ref(null);

function open_manager() {
  draft.value = projects.value.map((project) => ({ ...project }));
  editing.value = -1;
  adding.value = draft.value.length ? null : { name: "", path: "" };
  error.value = "";
  managing.value = true;
}

function start_adding() {
  editing.value = -1;
  adding.value = { name: "", path: "" };
  nextTick(() => add_name.value?.inputRef?.focus());
}

/** The folder's own name is the usual project name, so fill it when still empty. */
function folder_name(path) {
  return String(path).split(/[\\/]+/).filter(Boolean).at(-1) || "";
}

/** Browse on this computer into the row being added or edited. */
async function browse(target, key) {
  browsing.value = key;
  error.value = "";
  try {
    const path = await bridge.browse_local_directory();
    if (path) { target.path = path; if (!target.name.trim()) target.name = folder_name(path); }
  } catch (failure) { error.value = failure.message; } finally { browsing.value = ""; }
}

const complete = (item) => Boolean(item?.name.trim() && item?.path.trim());
function confirm_add() {
  if (!complete(adding.value)) return;
  draft.value.push({ name: adding.value.name.trim(), path: adding.value.path.trim() });
  adding.value = null;
}

function remove(index) {
  draft.value.splice(index, 1);
  if (editing.value === index) editing.value = -1;
}

/** The service checks every path exists on its own computer before replacing the list. */
async function save_projects() {
  if (complete(adding.value)) confirm_add();
  saving.value = true;
  error.value = "";
  try {
    await bridge.save_launch_projects(draft.value);
    managing.value = false;
  } catch (failure) { error.value = failure.message; } finally { saving.value = false; }
}
</script>

<template>
  <div v-if="relay" class="project-field">
    <UDropdownMenu :items="menu_items" :content="{ align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-menu project-menu' }" :disabled="props.disabled || !projects.length">
      <button type="button" class="project-select" :class="{ 'is-empty': !chosen }" :disabled="props.disabled || !projects.length">
        <UIcon :name="chosen ? 'i-lucide-folder' : 'i-lucide-folder-search'" class="project-select-icon" />
        <span>{{ chosen ? chosen.name : projects.length ? "选择项目" : `电脑「${relay.name}」上还没有项目` }}</span>
        <UIcon name="i-lucide-chevron-down" class="project-select-chevron" />
      </button>
    </UDropdownMenu>
    <p v-if="!relay.online" class="project-note"><UIcon name="i-lucide-moon" />电脑「{{ relay.name }}」当前离线，创建请求会等它上线后执行。</p>
  </div>

  <!-- One field in two parts: the saved-project picker leads, naming the chosen project, and the typed path follows,
       with the computer's folder dialog at its end like any input's trailing action. -->
  <div v-else class="project-box" :class="{ 'is-disabled': props.disabled, 'is-chosen': chosen }">
    <UDropdownMenu v-if="projects.length" :items="menu_items" :content="{ align: 'start', sideOffset: 6 }" :ui="{ content: 'channel-menu project-menu' }" :disabled="props.disabled">
      <button type="button" class="project-prefix" :class="{ 'is-chosen': chosen }" :title="chosen ? chosen.path : '从常用项目中选择'" aria-label="选择常用项目" :disabled="props.disabled">
        <UIcon :name="chosen ? 'i-lucide-folder' : 'i-lucide-folders'" /><span>{{ chosen ? chosen.name : "常用项目" }}</span><UIcon name="i-lucide-chevron-down" class="project-prefix-chevron" />
      </button>
    </UDropdownMenu>
    <button v-else type="button" class="project-prefix" aria-label="添加常用项目" title="保存常用项目，之后一键选择；其他设备也能用" :disabled="props.disabled" @click="open_manager">
      <UIcon name="i-lucide-plus" /><span>常用项目</span>
    </button>
    <UInput :model-value="cwd" :placeholder="props.placeholder" variant="none" class="project-path" aria-label="项目目录完整路径" :disabled="props.disabled" @update:model-value="write_cwd" />
    <UButton v-if="browsable" icon="i-lucide-folder-open" color="neutral" variant="ghost" size="xs" class="project-browse" aria-label="在本机选择项目目录" :title="picking ? '目录选择窗口已打开，请在本机窗口中选择' : '在本机选择文件夹'" :loading="picking" :disabled="props.disabled" @click="pick_directory" />
  </div>

  <UModal v-model:open="managing" title="常用项目" description="保存在运行 codiscuss 的这台电脑上。登录同一网站的手机、平板可直接选择，路径不会离开这台电脑。"
    :ui="{ content: 'glass-panel studio-modal project-modal', body: 'dialog-body' }">
    <template #body>
      <form class="project-manager dialog-form" @submit.prevent="save_projects">
        <ul v-if="draft.length" class="project-rows" aria-label="常用项目">
          <li v-for="(project, index) in draft" :key="index" class="project-row" :class="{ 'is-editing': editing === index }">
            <span class="project-tile"><UIcon name="i-lucide-folder" /></span>
            <template v-if="editing === index">
              <div class="project-edit">
                <UInput v-model="project.name" placeholder="项目名称" aria-label="项目名称" size="sm" class="w-full" />
                <UInput v-model="project.path" placeholder="文件夹完整路径" aria-label="文件夹完整路径" size="sm" class="w-full" :ui="{ trailing: 'pe-1' }">
                  <template v-if="browsable" #trailing><UButton icon="i-lucide-folder-open" color="neutral" variant="ghost" size="xs" aria-label="在本机选择文件夹" :loading="browsing === `row-${index}`" @click="browse(project, `row-${index}`)" /></template>
                </UInput>
              </div>
              <UButton icon="i-lucide-check" color="neutral" variant="ghost" size="xs" aria-label="完成编辑" :disabled="!complete(project)" @click="editing = -1" />
            </template>
            <template v-else>
              <div class="project-text"><strong>{{ project.name }}</strong><small :title="project.path">{{ project.path }}</small></div>
              <div class="project-actions">
                <UButton icon="i-lucide-pencil" color="neutral" variant="ghost" size="xs" :aria-label="`编辑 ${project.name}`" @click="adding = null; editing = index" />
                <UButton icon="i-lucide-trash-2" color="neutral" variant="ghost" size="xs" :aria-label="`移除 ${project.name}`" @click="remove(index)" />
              </div>
            </template>
          </li>
        </ul>

        <div v-if="adding" class="project-add" role="group" aria-label="添加项目">
          <UFormField label="文件夹" :description="browsable ? '' : '运行 codiscuss 的电脑上的完整路径'">
            <UInput v-model="adding.path" placeholder="例如 D:\Projects\demo" class="w-full" :ui="{ trailing: 'pe-1' }" @blur="!adding.name.trim() && (adding.name = folder_name(adding.path))">
              <template v-if="browsable" #trailing><UButton icon="i-lucide-folder-open" color="neutral" variant="ghost" size="xs" aria-label="在本机选择文件夹" :loading="browsing === 'add'" @click="browse(adding, 'add')" /></template>
            </UInput>
          </UFormField>
          <UFormField label="名称"><UInput ref="add_name" v-model="adding.name" placeholder="在列表中显示的名称" :maxlength="80" class="w-full" @keydown.enter.prevent="confirm_add" /></UFormField>
          <div class="project-add-actions">
            <UButton v-if="draft.length" label="取消" color="neutral" variant="ghost" size="sm" @click="adding = null" />
            <UButton label="加入列表" icon="i-lucide-plus" color="neutral" variant="soft" size="sm" :disabled="!complete(adding)" @click="confirm_add" />
          </div>
        </div>
        <button v-else type="button" class="project-add-trigger" @click="start_adding"><UIcon name="i-lucide-plus" />添加项目</button>

        <p v-if="error" role="alert" class="project-error"><UIcon name="i-lucide-circle-alert" />{{ error }}</p>
        <div class="project-footer">
          <UButton label="取消" color="neutral" variant="ghost" @click="managing = false" />
          <UButton type="submit" label="保存" class="channel-primary-button" :loading="saving" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
/* Entry: the picker is the field's leading segment, so the chosen project and the way to change it are one control. */
.project-box { display: flex; align-items: stretch; width: 100%; min-height: 32px; padding-right: 3px; border: 1px solid var(--channel-edge-control, var(--ui-border));
  border-radius: 6px; background: var(--ui-bg); transition: border-color .15s, box-shadow .15s; }
.project-box:hover:not(.is-disabled) { border-color: var(--ui-border-accented); }
.project-box.is-disabled { cursor: not-allowed; opacity: .6; }
.project-prefix { display: inline-flex; flex-shrink: 0; align-items: center; gap: 5px; max-width: 200px; padding: 0 8px 0 10px; border-right: 1px solid var(--ui-border-muted);
  border-radius: 5px 0 0 5px; color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; transition: background-color .15s, color .15s; }
.project-prefix:hover:not(:disabled) { background: var(--channel-ghost-hover, var(--ui-bg-elevated)); color: var(--ui-text-highlighted); }
.project-prefix > span { overflow: hidden; text-overflow: ellipsis; }
.project-prefix > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; }
.project-prefix > .project-prefix-chevron { width: 12px; height: 12px; color: var(--ui-text-dimmed); }
.project-prefix.is-chosen { color: var(--ui-text-highlighted); font-weight: 500; }
.project-prefix.is-chosen > [class*="icon"]:first-child { color: var(--channel-accent); }
.project-path { flex: 1; min-width: 0; align-self: center; }
.project-path :deep(input) { padding-inline: 10px; text-overflow: ellipsis; }
.project-box.is-chosen .project-path :deep(input) { color: var(--ui-text-muted); font-size: 12px; }
.project-browse { flex-shrink: 0; align-self: center; }

/* Relay: a read-only chooser shaped like the other inputs. */
.project-field { display: flex; flex-direction: column; gap: 6px; }
.project-select { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 6px 10px; border: 1px solid var(--channel-edge-control, var(--ui-border));
  border-radius: 6px; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 13px; text-align: left; }
.project-select:hover:not(:disabled) { border-color: var(--ui-border-accented); }
.project-select:disabled { cursor: not-allowed; opacity: .6; }
.project-select.is-empty { color: var(--ui-text-dimmed); }
.project-select > span { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.project-select-icon { flex-shrink: 0; width: 14px; height: 14px; color: var(--channel-accent); }
.project-select.is-empty .project-select-icon, .project-select-chevron { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-muted); }
.project-note { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.project-note > [class*="icon"] { flex-shrink: 0; width: 12px; height: 12px; }

/* Manager */
.project-manager { display: flex; flex-direction: column; gap: 12px; }
.project-rows { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.project-row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 8px 8px 10px; border: 1px solid var(--ui-border-muted); border-radius: 10px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); transition: border-color .15s, background-color .15s; }
.project-row:hover, .project-row.is-editing { border-color: var(--ui-border); background: var(--channel-ghost-hover, var(--ui-bg-elevated)); }
.project-row.is-editing { align-items: flex-start; }
.project-tile { display: grid; flex-shrink: 0; place-items: center; width: 32px; height: 32px; border-radius: 8px;
  background: color-mix(in srgb, var(--channel-accent) 16%, transparent); color: var(--channel-accent); }
.project-tile > [class*="icon"] { width: 15px; height: 15px; }
.project-text { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; }
.project-text strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.project-text small { overflow: hidden; color: var(--ui-text-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.project-actions { display: flex; flex-shrink: 0; gap: 2px; opacity: 0; transition: opacity .15s; }
.project-row:hover .project-actions, .project-row:focus-within .project-actions { opacity: 1; }
.project-edit { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 0; }
.project-add { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--ui-border); border-radius: 10px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, transparent); }
.project-add-actions { display: flex; justify-content: flex-end; gap: 6px; }
.project-add-trigger { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; border: 1px dashed var(--ui-border-accented); border-radius: 10px;
  color: var(--ui-text-muted); font-size: 12px; transition: color .15s, border-color .15s, background-color .15s; }
.project-add-trigger:hover { border-color: var(--channel-accent); background: color-mix(in srgb, var(--channel-accent) 6%, transparent); color: var(--ui-text-highlighted); }
.project-add-trigger > [class*="icon"] { width: 14px; height: 14px; }
.project-error { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: #f0716b; font-size: 12px; line-height: 1.5; }
.project-error > [class*="icon"] { flex-shrink: 0; width: 14px; height: 14px; margin-top: 2px; }
.project-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
@media (hover: none), (max-width: 600px) { .project-actions { opacity: 1; } }
@media (max-width: 600px) { .project-prefix { max-width: 120px; } }
</style>

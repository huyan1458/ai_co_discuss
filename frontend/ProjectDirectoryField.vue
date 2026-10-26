<script setup>
/** Launch cwd input: type a path, pick one of the projects saved on the service computer, or browse there from its own browser. */
import { computed, inject, ref } from "vue";

const props = defineProps({ placeholder: { type: String, default: "输入完整路径，或点右侧图标选择" }, disabled: { type: Boolean, default: false } });
const { view, bridge } = inject("discussion");
const projects = computed(() => view.value.launch.projects || []);
// The folder dialog opens on the computer running the service, so only its own browser (not a connected website) offers it.
const browsable = computed(() => !view.value.launch.remote);
const write_cwd = (path) => bridge.write_launch("workspace", "cwd", path);

const picking = ref(false);
/** Open the computer's folder dialog through the local service; typing a path remains available. */
async function pick_directory() {
  picking.value = true;
  try { await bridge.pick_launch_directory(); } finally { picking.value = false; }
}

const managing = ref(false);
const draft = ref([]);
const added = ref({ name: "", path: "" });
const saving = ref(false);
const error = ref("");
function open_manager() {
  draft.value = projects.value.map((project) => ({ ...project }));
  added.value = { name: "", path: "" };
  error.value = "";
  managing.value = true;
}
const project_items = computed(() => [
  projects.value.map((project) => ({ label: project.name, description: project.path, icon: "i-lucide-folder", onSelect: () => write_cwd(project.path) })),
  [{ label: "管理项目…", icon: "i-lucide-settings-2", onSelect: open_manager }],
]);

/** Keep a filled add row so saving does not silently drop it. */
function add_project() {
  const name = added.value.name.trim(), path = added.value.path.trim();
  if (!name || !path) return;
  draft.value.push({ name, path });
  added.value = { name: "", path: "" };
}

/** The service checks every path exists on its own computer before replacing the list. */
async function save_projects() {
  add_project();
  saving.value = true;
  error.value = "";
  try {
    await bridge.save_launch_projects(draft.value);
    managing.value = false;
  } catch (failure) { error.value = failure.message; } finally { saving.value = false; }
}
</script>

<template>
  <UInput :model-value="view.launch.workspace.cwd || ''" :placeholder="props.placeholder" class="w-full" :ui="{ trailing: 'pe-1' }" :disabled="props.disabled" @update:model-value="write_cwd">
    <template #trailing>
      <UDropdownMenu v-if="projects.length" :items="project_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }" :disabled="props.disabled">
        <UButton icon="i-lucide-folder-kanban" color="neutral" variant="ghost" size="xs" aria-label="选择已配置项目" title="选择项目" :disabled="props.disabled" />
      </UDropdownMenu>
      <UButton v-else icon="i-lucide-folder-kanban" color="neutral" variant="ghost" size="xs" aria-label="添加项目" title="选择项目：先添加项目名称和路径" :disabled="props.disabled" @click="open_manager" />
      <UButton v-if="browsable" icon="i-lucide-folder-open" color="neutral" variant="ghost" size="xs" aria-label="在本机选择项目目录" :title="picking ? '目录选择窗口已打开，请在本机窗口中选择' : '在本机选择文件夹'" :disabled="picking || props.disabled" @click="pick_directory" />
    </template>
  </UInput>
  <UModal v-model:open="managing" title="项目" description="路径填写运行 codiscuss 服务那台电脑上的完整路径；列表只保存在那台电脑上。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="project-manager" @submit.prevent="save_projects">
        <ul v-if="draft.length" class="project-list">
          <li v-for="(project, index) in draft" :key="index">
            <UInput v-model="project.name" aria-label="项目名称" class="project-name" />
            <UInput v-model="project.path" aria-label="项目路径" class="project-path" />
            <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="`移除 ${project.name}`" @click="draft.splice(index, 1)" />
          </li>
        </ul>
        <div class="project-add">
          <UInput v-model="added.name" placeholder="项目名称" class="project-name" />
          <UInput v-model="added.path" placeholder="完整路径，如 D:\Projects\demo" class="project-path" />
          <UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="添加项目" :disabled="!added.name.trim() || !added.path.trim()" @click="add_project" />
        </div>
        <p v-if="error" role="alert" class="project-error">{{ error }}</p>
        <div class="project-actions">
          <UButton label="取消" color="neutral" variant="ghost" @click="managing = false" />
          <UButton type="submit" label="保存" class="channel-primary-button" :loading="saving" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.project-manager { display: flex; flex-direction: column; gap: 10px; }
.project-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.project-list li, .project-add { display: flex; align-items: center; gap: 8px; }
.project-name { flex: 0 0 34%; min-width: 0; }
.project-path { flex: 1; min-width: 0; }
.project-error { margin: 0; color: #f0716b; font-size: 12px; }
.project-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
@media (max-width: 600px) {
  .project-list li, .project-add { flex-wrap: wrap; }
  .project-name { flex-basis: calc(100% - 36px); }
  .project-path { flex-basis: 100%; order: 3; }
}
</style>

<script setup>
import { computed, inject, watch } from "vue";

// The create form shows directory, access and model choices beside their related controls.
const props = defineProps({ participants: { type: Array, default: () => [] }, workspace: { type: Boolean, default: true },
  modelSelection: { type: Boolean, default: true } });
const { view, bridge, act, pending } = inject("discussion");
const names = computed(() => [...new Set(props.participants)].filter(name => bridge.launch_clients[name]));
const profile = name => view.value.launch.profiles[name] || {};
const write = (name, field, value) => bridge.write_launch(name, field, value);
const ACCESS = [{ label: "只读", value: "read" }, { label: "可写", value: "write" }];
// Select items cannot use an empty value, so "inherit" stands for following the launch-wide setting.
const PARTICIPANT_ACCESS = [{ label: "沿用本次设置", value: "inherit" }, ...ACCESS];
const write_access = (name, value) => write(name, "project_access", value === "inherit" ? "" : value);
const models = name => bridge.launch_model_state(name, view.value.launch);
// Select items cannot hold an empty value, so "default" stands for the CLI's own effort.
const effort_items = name => [{ label: "CLI 默认", value: "default" }, ...(models(name).efforts || []).map(level => ({ label: level, value: level }))];
watch(() => [props.modelSelection, view.value.launch.available, ...names.value.map(name => `${name}:${profile(name).adapter}`)],
  ([selectable, available]) => { if (selectable && available) names.value.forEach(name => bridge.load_launch_models(name)); }, { immediate: true });
</script>

<template>
  <section class="launch-settings" aria-label="启动配置">
    <template v-if="!view.launch.available">
      <h3>连接这台电脑</h3>
      <p class="fine-print">先安装并配置 codiscuss，在运行 AI 的这台电脑上执行以下命令，使用命令打开的网页完成连接。浏览器询问时允许访问本机网络。</p>
      <div class="launch-connect-command"><code>{{ view.launch.connect_command }}</code><UButton icon="i-lucide-copy" aria-label="复制本机连接命令" variant="ghost" color="neutral" @click="act('copy', view.launch.connect_command)" /></div>
      <UButton label="重新检查连接" variant="outline" color="neutral" :loading="pending === 'retry_launch_connection'" @click="act('retry_launch_connection')" />
      <p v-if="view.launch.error" role="alert" class="fine-print">{{ view.launch.error }}</p>
    </template>
    <template v-else>
    <h3>启动配置</h3>
    <p class="fine-print">软件配置可保存供后续讨论复用。App 需要保持运行；CLI 按需启动，使用已有登录和工具权限。</p>
    <details v-for="name in names" :key="name" open class="launch-client">
      <summary>{{ name }} · {{ bridge.launch_summary(name).client }} · {{ bridge.launch_summary(name).session }}</summary>
      <p class="launch-effective">工作目录：{{ bridge.launch_summary(name).cwd }}（{{ bridge.launch_summary(name).access }}）<br>项目：{{ bridge.launch_summary(name).project }}</p>
      <div class="launch-client-fields">
        <UFormField :label="`${name} 执行客户端`"><USelect :model-value="profile(name).adapter || ''" :items="bridge.launch_clients[name]" placeholder="选择 CLI / App" class="w-full" @update:model-value="write(name, 'adapter', $event)" /></UFormField>
        <UFormField v-if="profile(name).adapter === 'antigravity'" label="Sidecar IPC 目录"><UInput :model-value="profile(name).ipc_directory || ''" placeholder="已配置的 Sidecar 目录" class="w-full" @update:model-value="write(name, 'ipc_directory', $event)" /></UFormField>
        <UFormField v-else label="原生可执行文件路径"><UInput :model-value="profile(name).executable || ''" placeholder="Windows 填写 .exe 的完整路径" class="w-full" @update:model-value="write(name, 'executable', $event)" @blur="props.modelSelection && bridge.load_launch_models(name)" /></UFormField>
        <UFormField v-if="props.modelSelection && models(name).supported" label="模型" :help="models(name).loading ? '正在读取软件模型列表…' : models(name).error || models(name).source"><USelect :model-value="profile(name).model || '__default__'" :items="models(name).items" :loading="models(name).loading" class="w-full" @update:model-value="bridge.write_launch_model(name, $event)" /><button v-if="models(name).error && !models(name).loading" type="button" class="model-retry" @click="bridge.load_launch_models(name, true)">重新读取模型列表</button></UFormField>
        <UFormField v-if="props.modelSelection && models(name).efforts?.length" label="思考档位（可选）"><USelect :model-value="profile(name).effort || 'default'" :items="effort_items(name)" class="w-full" @update:model-value="write(name, 'effort', $event === 'default' ? '' : $event)" /></UFormField>
        <UFormField v-if="profile(name).adapter === 'codex'" label="来源聊天 ID"><UInput :model-value="profile(name).source_thread_id || ''" placeholder="用于在 Codex App 新建会话" class="w-full" @update:model-value="write(name, 'source_thread_id', $event)" /></UFormField>
        <UFormField v-if="profile(name).adapter === 'claude'" label="允许的工具（可选，每行一项）"><UTextarea :model-value="(profile(name).allowed_tools || []).join('\n')" :rows="2" placeholder="例如 Read、Write 及按需配置的 Bash 权限" class="w-full" @update:model-value="write(name, 'allowed_tools', $event)" /></UFormField>
        <details><summary>会话与目录覆盖（可选）</summary><div class="launch-client-fields">
          <UFormField label="复用会话 ID（仅本次）"><UInput :model-value="profile(name).session_id || ''" placeholder="留空创建新会话" class="w-full" @update:model-value="write(name, 'session_id', $event)" /></UFormField>
          <UFormField label="此 AI 的工作目录"><UInput :model-value="profile(name).cwd || ''" placeholder="留空使用本次讨论目录" class="w-full" @update:model-value="write(name, 'cwd', $event)" /></UFormField>
          <UFormField label="此 AI 的项目文件"><USelect :model-value="profile(name).project_access || 'inherit'" :items="PARTICIPANT_ACCESS" class="w-full" @update:model-value="write_access(name, $event)" /></UFormField>
          <UFormField label="此 AI 的项目"><UInput :model-value="profile(name).project_name || ''" placeholder="留空使用本次讨论项目" class="w-full" @update:model-value="write(name, 'project_name', $event)" /></UFormField>
          <UFormField v-if="['codex', 'antigravity', 'antigravity_cli'].includes(profile(name).adapter)" label="软件中的项目 ID"><UInput :model-value="profile(name).project_id || ''" placeholder="可选；须与所选软件项目一致" class="w-full" @update:model-value="write(name, 'project_id', $event)" /></UFormField>
        </div></details>
      </div>
    </details>
    <div class="form-two-columns">
      <UFormField v-if="props.workspace" label="本次工作目录（可选）" help="要一起查看的项目目录；留空时 AI 只在讨论私有目录工作"><UInput :model-value="view.launch.workspace.cwd || ''" placeholder="已有目录的完整路径" class="w-full" @update:model-value="write('workspace', 'cwd', $event)" /></UFormField>
      <UFormField label="本次 AI 项目（可选）"><UInput :model-value="view.launch.workspace.discussion_project || ''" placeholder="软件中已有的项目名称" class="w-full" @update:model-value="write('workspace', 'discussion_project', $event)" /></UFormField>
      <UFormField v-if="props.workspace" label="项目文件" help="默认只读；可写允许 CLI 专家按议题修改工作目录中的文件，仅本次有效">
        <USelect :model-value="view.launch.workspace.project_access || 'read'" :items="ACCESS" class="w-full" @update:model-value="write('workspace', 'project_access', $event)" />
      </UFormField>
    </div>
    <UButton label="保存为本机软件默认配置" variant="outline" color="neutral" :loading="pending === 'save_launch_defaults'" @click="act('save_launch_defaults')" />
    <p v-if="view.launch.error" role="alert" class="fine-print">{{ view.launch.error }}</p>
    <p v-else-if="view.launch.notice" role="status" class="fine-print">{{ view.launch.notice }}</p>
    </template>
  </section>
</template>

<style scoped>
.launch-settings, .launch-client-fields { display: grid; gap: 14px; }
.launch-settings { padding: 16px 0; }
.launch-settings h3 { font-size: 14px; font-weight: 600; }
.launch-client { border: 1px solid var(--ui-border); border-radius: 8px; padding: 12px; }
.launch-client summary { cursor: pointer; font-size: 13px; }
.launch-effective { margin: 8px 0 0; font-size: 12px; color: var(--ui-text-muted); overflow-wrap: anywhere; }
.launch-client-fields { padding-top: 12px; }
.launch-settings > button { justify-self: start; }
.model-retry { margin-top: 6px; color: var(--ui-text-muted); font-size: 12px; }
.launch-connect-command { display: flex; align-items: center; gap: 8px; padding: 10px; border-radius: 8px; background: var(--ui-bg-elevated); }
.launch-connect-command code { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
</style>

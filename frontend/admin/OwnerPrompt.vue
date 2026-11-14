<script setup>
/**
 * The owner's system prompts: Claude Code, Codex and Antigravity each read one file; files that are hard links to one
 * another are shown and edited as one. Saving writes in place (the links stay) and is refused when the file changed
 * elsewhere since it was read.
 */
import { inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";

const { notify, refreshed } = inject("panel");
const groups = ref(null), loading = ref(false), open = ref(""), drafts = ref({}), saving = ref("");

async function load() {
  loading.value = true;
  try {
    groups.value = await call("owner/prompts");
    drafts.value = Object.fromEntries(groups.value.map((group) => [group.key, group.text]));
  } catch (failure) { groups.value = { error: failure.message }; }
  finally { loading.value = false; }
}
onMounted(load);
watch(refreshed, load);

const names = (group) => group.programs.map((program) => program.label).join("、");
async function save(group) {
  saving.value = group.key;
  try {
    groups.value = await call("owner/prompts", { key: group.key, text: drafts.value[group.key], original: group.text });
    notify("info", `${names(group)} 的系统提示词已保存`);
  } catch (failure) { notify("error", failure.message); await load(); }
  finally { saving.value = ""; }
}
</script>

<template>
  <div class="prompt">
    <div class="prompt-head">
      <span>系统提示词 <small>各程序每次启动时读取的全局指令</small></span>
      <button type="button" class="panel-icon-button" :class="{ 'is-spinning': loading }" :disabled="loading" title="重新读取" aria-label="重新读取" @click="load"><UIcon name="i-lucide-refresh-cw" /></button>
    </div>
    <p v-if="groups?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ groups.error }}</p>
    <p v-else-if="!groups" class="prompt-empty">读取中…</p>
    <div v-for="group in groups || []" v-else :key="group.key" class="prompt-group">
      <button type="button" class="prompt-toggle" @click="open = open === group.key ? '' : group.key">
        <span class="prompt-title"><strong>{{ names(group) }}</strong>
          <span v-if="group.programs.length > 1" class="panel-tag is-blue">共用一份</span>
          <span v-if="!group.exists" class="panel-tag is-gray">未创建</span>
          <small>{{ group.programs.map((program) => program.path).join("；") }}</small></span>
        <UIcon :name="open === group.key ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template v-if="open === group.key">
        <textarea v-model="drafts[group.key]" class="panel-input prompt-area" spellcheck="false" :placeholder="group.exists ? '' : '保存后创建该文件'" />
        <div class="prompt-actions">
          <button type="button" class="panel-button is-plain is-small" :disabled="drafts[group.key] === group.text" @click="drafts[group.key] = group.text">撤销修改</button>
          <button type="button" class="panel-button is-primary is-small" :disabled="drafts[group.key] === group.text || Boolean(saving)" @click="save(group)">
            <UIcon v-if="saving === group.key" name="i-lucide-loader" class="animate-spin" />保存</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.prompt { display: flex; flex-direction: column; gap: 4px; }
.prompt-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.prompt-head small { margin-left: 6px; color: var(--panel-faint); font-weight: 400; }
.prompt-empty { margin: 0; padding: 12px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-faint); font-size: 13px; }
.prompt-group { display: flex; flex-direction: column; gap: 10px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.prompt-toggle { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; }
.prompt-toggle > [class*="icon"] { width: 16px; height: 16px; flex-shrink: 0; color: var(--panel-faint); }
.prompt-title { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
.prompt-title strong { font-size: 14px; }
.prompt-title small { flex-basis: 100%; overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.prompt-area { height: 320px; padding: 12px 14px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.6; }
.prompt-actions { display: flex; justify-content: flex-end; gap: 8px; }
</style>

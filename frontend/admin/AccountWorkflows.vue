<script setup>
/**
 * The workflows in one account's library: each with its name, roles and state, and the shipped workflows it lacks,
 * installed with one button (an existing workflow, edited or not, is kept). `account` is "" for the owner. Workflows
 * are edited and disabled in the CoDiscuss site's sidebar and enabled in a room, not here.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";

const props = defineProps({ account: { type: String, required: true } });
const { notify, refreshed } = inject("panel");
const result = ref(null), loading = ref(false), installing = ref(false);
const base = computed(() => (props.account ? `accounts/${props.account}/workflows` : "owner/workflows"));

async function load() {
  loading.value = true;
  try { result.value = await call(base.value); }
  catch (failure) { result.value = { error: failure.message }; }
  finally { loading.value = false; }
}
onMounted(load);
watch(refreshed, load);
watch(() => props.account, load);

async function install() {
  installing.value = true;
  try { result.value = await call(`${base.value}/install`, {}); notify("info", "随包工作流已补齐"); }
  catch (failure) { notify("error", failure.message); }
  finally { installing.value = false; }
}
</script>

<template>
  <div class="flows">
    <div class="flows-head">
      <span>工作流 <small>房间中可启用的多人分工流程；编辑、停用在共议网站侧栏的“工作流”中进行</small></span>
      <button type="button" class="panel-icon-button" :class="{ 'is-spinning': loading }" :disabled="loading" title="重新读取" aria-label="重新读取" @click="load"><UIcon name="i-lucide-refresh-cw" /></button>
    </div>
    <p v-if="result?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ result.error }}</p>
    <p v-else-if="!result" class="flows-empty">读取中…</p>
    <template v-else>
      <p v-if="!result.workflows.length" class="flows-empty">暂无工作流。</p>
      <div v-for="flow in result.workflows" :key="flow.id" class="flows-row">
        <UIcon name="i-lucide-workflow" class="flows-icon" />
        <div class="flows-text">
          <strong>{{ flow.label }}
            <span class="panel-tag is-gray">{{ flow.cards }} 个角色</span>
            <span v-if="flow.disabled" class="panel-tag is-gray">已停用</span>
            <span v-if="flow.error" class="panel-tag is-amber">无法读取</span></strong>
          <small :title="flow.error || flow.description">{{ flow.error || flow.description || flow.id }}</small>
        </div>
      </div>
      <div v-if="result.missing.length" class="flows-missing">
        <span>缺少随包工作流：{{ result.missing.join("、") }}</span>
        <button type="button" class="panel-button is-outline is-small" :disabled="installing" @click="install">
          <UIcon :name="installing ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': installing }" />补齐</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.flows { display: flex; flex-direction: column; gap: 4px; }
.flows-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.flows-head small { margin-left: 6px; color: var(--panel-faint); font-weight: 400; }
.flows-empty { margin: 0; padding: 12px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-faint); font-size: 13px; }
.flows-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.flows-icon { width: 20px; height: 20px; flex-shrink: 0; color: var(--panel-muted); }
.flows-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.flows-text strong { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.flows-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.flows-missing { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 4px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-amber); font-size: 13px; }
</style>

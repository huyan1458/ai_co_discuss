<script setup>
/**
 * The workflows in one account's library, each with its name, roles and state, and two buttons always shown: "检查"
 * compares the library with the shipped workflows; "同步到最新版" installs the shipped ones it lacks and replaces those
 * whose copy differs (edited or older), backing each replaced copy up first, and is greyed out when nothing differs.
 * `account` is "" for the owner. Workflows are edited and disabled in the CoDiscuss site's sidebar, not here.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import { t } from '../i18n.js';

const props = defineProps({ account: { type: String, required: true } });
const { notify, refreshed } = inject("panel");
const result = ref(null), loading = ref(false), syncing = ref(false);
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

const missing = computed(() => result.value?.missing || []);
/** Shown names of the workflows that differ from the shipped version. */
const outdated = computed(() => (result.value?.outdated || []).map((id) => result.value.workflows.find((flow) => flow.id === id)?.label || id));
const behind = computed(() => missing.value.length + outdated.value.length > 0);

/** Install the missing shipped workflows, then replace the differing ones (each backed up first). */
async function sync() {
  syncing.value = true;
  try {
    if (missing.value.length) result.value = await call(`${base.value}/install`, {});
    if (result.value?.outdated?.length) result.value = await call(`${base.value}/update`, {});
    notify("info", t('工作流已同步到随包最新版，被替换的旧版已备份'));
  }
  catch (failure) { notify("error", failure.message); }
  finally { syncing.value = false; }
}
</script>

<template>
  <div class="flows">
    <div class="flows-head">
      <span>{{ t('工作流') }} <small>{{ t('房间中可启用的多人分工流程；编辑、停用在共议网站侧栏的“工作流”中进行') }}</small></span>
      <span class="flows-actions">
        <button type="button" class="panel-button is-outline is-small" :disabled="loading || syncing" @click="load">
          <UIcon :name="loading ? 'i-lucide-loader' : 'i-lucide-search-check'" :class="{ 'animate-spin': loading }" />{{ t('检查') }}</button>
        <button type="button" class="panel-button is-outline is-small" :disabled="!behind || loading || syncing"
          :title="t('补装缺少的随包工作流，并用最新版替换不同的；被替换的旧版先备份到该账号服务目录的 backups/workflows，在这里做过的修改也会被替换')" @click="sync">
          <UIcon :name="syncing ? 'i-lucide-loader' : 'i-lucide-refresh-cw'" :class="{ 'animate-spin': syncing }" />{{ t('同步到最新版') }}</button>
      </span>
    </div>
    <p v-if="result?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ result.error }}</p>
    <p v-else-if="!result" class="flows-empty">{{ t('读取中…') }}</p>
    <template v-else>
      <p class="flows-status" :class="{ 'is-behind': behind }">
        <template v-if="!behind">{{ t('已是随包最新版') }}</template>
        <template v-else>
          <span v-if="missing.length">{{ t('缺少随包工作流：{value1}', { value1: missing.join("、") }) }}</span>
          <span v-if="outdated.length">{{ t('与随包最新版不同：{value1}', { value1: outdated.join("、") }) }}</span>
        </template>
      </p>
      <p v-if="!result.workflows.length" class="flows-empty">{{ t('暂无工作流。') }}</p>
      <div v-for="flow in result.workflows" :key="flow.id" class="flows-row">
        <UIcon name="i-lucide-workflow" class="flows-icon" />
        <div class="flows-text">
          <strong>{{ flow.label }}
            <span class="panel-tag is-gray">{{ t('{value1} 个角色', { value1: flow.cards }) }}</span>
            <span v-if="flow.disabled" class="panel-tag is-gray">{{ t('已停用') }}</span>
            <span v-if="flow.error" class="panel-tag is-amber">{{ t('无法读取') }}</span></strong>
          <small :title="flow.error || flow.description">{{ flow.error || flow.description || flow.id }}</small>
        </div>
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
.flows-actions { display: flex; gap: 8px; }
.flows-status { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 8px 4px; color: var(--panel-faint); font-size: 13px; }
.flows-status.is-behind { color: var(--panel-amber); }
</style>

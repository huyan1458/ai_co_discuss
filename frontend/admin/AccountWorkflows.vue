<script setup>
/**
 * The workflows in one account's library, each with its name, roles and state. The header behaves like the version
 * check on the overview page: a tag says whether the library matches the shipped workflows; one icon button re-checks
 * while it does, and once something differs turns into "同步到最新版", which asks first, then installs the shipped ones
 * the library lacks and replaces those whose copy differs (edited or older), backing each replaced copy up first.
 * `account` is "" for the owner. Workflows are edited and disabled in the CoDiscuss site's sidebar, not here.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import { t } from '../i18n.js';

const props = defineProps({ account: { type: String, required: true } });
const { notify, refreshed } = inject("panel");
const result = ref(null), loading = ref(false), syncing = ref(false), confirming = ref(false);
const base = computed(() => (props.account ? `accounts/${props.account}/workflows` : "owner/workflows"));

/** Read the library; `announce` (a click on the check button) says so when nothing differs. */
async function load(announce = false) {
  loading.value = true;
  try {
    result.value = await call(base.value);
    if (announce && !behind.value) notify("info", t('工作流已是随包最新版'));
  }
  catch (failure) { result.value = { error: failure.message }; }
  finally { loading.value = false; }
}
onMounted(() => load());
watch(refreshed, () => load());
watch(() => props.account, () => load());

const missing = computed(() => result.value?.missing || []);
/** Shown names of the workflows that differ from the shipped version. */
const outdated = computed(() => (result.value?.outdated || []).map((id) => result.value.workflows.find((flow) => flow.id === id)?.label || id));
const behind = computed(() => missing.value.length + outdated.value.length > 0);

/** Install the missing shipped workflows, then replace the differing ones (each backed up first). */
async function sync() {
  confirming.value = false;
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
      <div class="flows-heading">
        <div class="flows-title">{{ t('工作流') }}
          <span class="flows-badge" role="status">
            <span v-if="loading" class="panel-tag is-gray">{{ t('正在检查…') }}</span>
            <span v-else-if="behind" class="panel-tag is-blue"><UIcon name="i-lucide-sparkles" />{{ t('{value1} 个可同步', { value1: missing.length + outdated.length }) }}</span>
            <span v-else-if="result && !result.error" class="panel-tag is-green"><UIcon name="i-lucide-check" />{{ t('已是最新') }}</span>
          </span>
        </div>
        <small :title="t('房间中可启用的多人分工流程，在共议网站侧栏编辑、停用')">{{ t('房间中可启用的多人分工流程，在共议网站侧栏编辑、停用') }}</small>
      </div>
      <div class="flows-actions">
        <button type="button" class="panel-icon-button" :class="{ 'is-spinning': loading }" :disabled="loading || syncing"
          :title="t('检查随包工作流')" :aria-label="t('检查随包工作流')" @click="load(true)"><UIcon name="i-lucide-refresh-cw" /></button>
        <span :title="loading ? t('正在检查…') : !behind ? (result && !result.error ? t('已是最新') : t('暂不可用')) : t('同步到最新版')">
          <button type="button" class="panel-icon-button flows-sync" :disabled="!behind || loading || syncing"
            :aria-label="t('同步到最新版')" @click="confirming = true">
            <UIcon :name="syncing ? 'i-lucide-loader' : 'i-lucide-download'" :class="{ 'animate-spin': syncing }" />
          </button>
        </span>
      </div>
    </div>
    <p v-if="result?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ result.error }}</p>
    <p v-else-if="!result" class="flows-empty">{{ t('读取中…') }}</p>
    <template v-else>
      <p v-if="behind" class="flows-status">
        <span v-if="missing.length">{{ t('缺少随包工作流：{value1}', { value1: missing.join("、") }) }}</span>
        <span v-if="outdated.length">{{ t('与随包最新版不同：{value1}', { value1: outdated.join("、") }) }}</span>
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

  <UModal :open="confirming" :title="t('同步随包工作流')" @update:open="(open) => !open && (confirming = false)">
    <template #body>
      <p v-if="missing.length" class="flows-confirm">{{ t('补装：{value1}', { value1: missing.join("、") }) }}</p>
      <p v-if="outdated.length" class="flows-confirm">{{ t('替换为最新版：{value1}', { value1: outdated.join("、") }) }}</p>
      <p class="panel-note"><UIcon name="i-lucide-info" />{{ t('被替换的旧版先备份到该账号服务目录的 backups/workflows，在这里做过的修改也会被替换。') }}</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="confirming = false">{{ t('取消') }}</button>
        <button type="button" class="panel-button is-primary" @click="sync">{{ t('同步') }}</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.flows { display: flex; flex-direction: column; gap: 4px; }
.flows-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.flows-heading { min-width: 0; }
.flows-title { display: flex; align-items: center; gap: 6px; height: 24px; white-space: nowrap; }
.flows-badge { display: flex; align-items: center; }
.flows-head small { display: -webkit-box; height: 32px; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: var(--panel-faint); font-weight: 400; line-height: 16px; }
.flows-actions { display: inline-flex; flex-shrink: 0; gap: 4px; }
.flows-actions > span { display: inline-flex; }
.flows-empty { margin: 0; padding: 12px 4px; border-top: 1px solid var(--panel-line); color: var(--panel-faint); font-size: 13px; }
.flows-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); }
.flows-icon { width: 20px; height: 20px; flex-shrink: 0; color: var(--panel-muted); }
.flows-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.flows-text strong { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.flows-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.flows-status { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; padding: 8px 4px; color: var(--panel-amber); font-size: 13px; }
.flows-sync:not(:disabled) { background: var(--panel-blue); color: #fff; }
.flows-sync:hover:not(:disabled) { background: #2563eb; color: #fff; }
.flows-confirm { margin: 0 0 8px; font-size: 14px; }
</style>

<script setup>
/**
 * Web search key of this computer, next to smart scheduling and image generation. API members search through the
 * DeepSeek Search API, so saving a DeepSeek API key here turns search on for every room; there is no per-room switch.
 * Input: `compact` for the room's settings row, `disabled` when this viewer cannot change it.
 * The key goes only to the local private store and never comes back to the page.
 */
import { computed, inject, ref } from "vue";
import { t } from './i18n.js';

const SEARCH_KEY_HOST = "api.deepseek.com";
const SAVED_MARK = "••••••••••••";

defineProps({ disabled: { type: Boolean, default: false }, compact: { type: Boolean, default: false } });
const { bridge, view } = inject("discussion");
const editing = ref(false), api_key = ref(""), key_visible = ref(false), saving = ref(false);

/** Whether a saved key's API root belongs to DeepSeek. */
function is_search_root(root) {
  try { return new URL(root).hostname === SEARCH_KEY_HOST; } catch { return false; }
}
const configured = computed(() => Object.keys(view.value.launch.api_keys || {}).some(is_search_root));
const summary = computed(() => configured.value ? t('已配置 DeepSeek API Key') : t('未配置，API 成员不能联网搜索'));

/** Store a newly entered key privately; the page keeps only that one is saved. */
async function save_key() {
  const key = api_key.value.trim();
  if (!key || saving.value) return;
  saving.value = true;
  try {
    await bridge.save_search_api_key(key);
    api_key.value = "";
    editing.value = false;
    bridge.notify("info", t('联网搜索的密钥已保存'));
  } catch (error) { bridge.notify("error", error.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <div class="search-service" :class="{ 'is-compact': compact }">
    <div v-if="!compact">
      <p class="search-title">{{ t('联网搜索') }}<UBadge size="xs" variant="soft" class="search-badge">DeepSeek</UBadge><small>{{ t('可选') }}</small></p>
      <p class="search-description">{{ t('填入 DeepSeek API Key 后，房间里的 API 成员都能联网搜索；按次计入该 DeepSeek 账号。') }}</p>
    </div>
    <div class="search-row">
      <span class="search-summary" :class="configured ? 'is-ready' : 'is-warn'" :title="summary"><i aria-hidden="true" />{{ summary }}</span>
      <UButton v-if="!disabled" :icon="editing ? 'i-lucide-chevron-up' : 'i-lucide-settings-2'" :label="editing ? t('收起') : t('设置')" size="xs" color="neutral" variant="ghost"
        :aria-expanded="editing" :aria-label="t('设置联网搜索')" @click="editing = !editing" />
    </div>
    <div v-if="editing && !disabled" class="search-editor">
      <div class="search-field"><span>{{ t('密钥') }}</span>
        <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
        <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="configured ? SAVED_MARK : t('填写 DeepSeek API Key')" :title="configured && !api_key ? t('已保存；本机不回传密钥，输入新 Key 可更换') : undefined" :aria-label="t('联网搜索 API Key')" size="xs" class="w-full" :loading="saving" :ui="{ base: key_visible ? '' : 'search-key-masked', trailing: 'pe-0.5' }" @change="save_key">
          <template #trailing><UButton :icon="key_visible ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!api_key" :aria-label="key_visible ? t('隐藏密钥') : t('显示密钥')" :aria-pressed="key_visible" size="xs" color="neutral" variant="link" @click="key_visible = !key_visible" /></template>
        </UInput>
      </div>
      <p class="search-note">{{ t('密钥存在这台电脑，所有房间共用；DeepSeek 成员搜索时用自己的 Key。') }}</p>
    </div>
  </div>
</template>

<style scoped>
/* Same section rhythm as smart scheduling and image generation, so the three read as one kind. */
.search-service { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.search-service.is-compact { gap: 6px; padding-top: 0; border-top: 0; }
.search-title { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.search-title small { color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
.search-badge { color: var(--channel-accent); }
.search-description { margin: 2px 0 0; color: var(--ui-text-muted); font-size: 13px; }
.search-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; min-height: 28px; }
.search-summary { min-width: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; }
.search-summary > i { display: inline-block; width: 6px; height: 6px; margin: 0 6px 1px 0; vertical-align: middle; border-radius: 50%; }
.search-summary.is-ready { color: var(--ui-text-toned); }
.search-summary.is-ready > i { background: var(--ui-success, #3fb27f); }
.search-summary.is-warn > i { background: var(--ui-warning, #e0a33a); }
.search-editor { display: flex; flex-direction: column; gap: 8px; max-width: 420px; }
.search-field { display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.search-note { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; }
.search-service :deep(.search-key-masked) { -webkit-text-security: disc; }
</style>

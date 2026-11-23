<script setup>
/**
 * The changelog, opened from the version number under the brand: the running version's changes, with earlier versions
 * folded below. The entries come from CHANGELOG.md (English) / CHANGELOG.zh-CN.md at build time (vite.config.mjs read_changelog).
 */
import { computed, ref, watch } from "vue";
import { locale, t } from "./i18n.js";

const props = defineProps({ version: { type: String, required: true } });
const open = defineModel("open", { type: Boolean, default: false });

const CHANGELOG = __CHANGELOG__;
// Each language's file carries its own item prefixes; the tags read the same words as the file.
const KIND_LABELS = { "zh-CN": { new: "新增", change: "调整", fix: "修复" }, en: { new: "New", change: "Changed", fix: "Fixed" } };
const language = String(locale).startsWith("zh") || !CHANGELOG.en ? "zh-CN" : "en";
const kinds = KIND_LABELS[language];
const entries = computed(() => CHANGELOG[language] || []);
// The running version's entry; a build ahead of the changelog shows the newest one written.
const current = computed(() => entries.value.find((entry) => entry.version === props.version) || entries.value[0] || null);
const earlier = computed(() => entries.value.filter((entry) => entry !== current.value));
const show_earlier = ref(false);
watch(open, (value) => { if (value) show_earlier.value = false; });
</script>

<template>
  <UModal v-model:open="open" :title="t('更新日志')" :description="t('当前版本 v{version}', { version })" :ui="{ content: 'glass-panel studio-modal changelog-modal', body: 'dialog-body changelog-body' }">
    <template #body>
      <p v-if="!current" class="changelog-empty">{{ t('还没有更新日志。') }}</p>
      <template v-else>
        <section class="changelog-version">
          <h3>v{{ current.version }} <small>{{ current.date }}</small></h3>
          <ul class="changelog-items">
            <li v-for="(item, index) in current.items" :key="index"><span class="changelog-kind" :class="`is-${item.kind}`">{{ kinds[item.kind] }}</span><span>{{ item.text }}</span></li>
          </ul>
        </section>
        <template v-if="earlier.length">
          <button type="button" class="changelog-more" :aria-expanded="show_earlier" @click="show_earlier = !show_earlier">
            <UIcon :name="show_earlier ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />{{ show_earlier ? t('收起更早的版本') : t('查看更早的版本（{count}）', { count: earlier.length }) }}
          </button>
          <section v-for="entry in show_earlier ? earlier : []" :key="entry.version" class="changelog-version">
            <h3>v{{ entry.version }} <small>{{ entry.date }}</small></h3>
            <ul class="changelog-items">
              <li v-for="(item, index) in entry.items" :key="index"><span class="changelog-kind" :class="`is-${item.kind}`">{{ kinds[item.kind] }}</span><span>{{ item.text }}</span></li>
            </ul>
          </section>
        </template>
      </template>
    </template>
  </UModal>
</template>

<style scoped>
.changelog-version + .changelog-version, .changelog-more + .changelog-version { margin-top: 18px; }
.changelog-version h3 { margin: 0 0 8px; color: var(--ui-text-highlighted); font-size: 15px; font-weight: 650; }
.changelog-version h3 small { margin-left: 6px; color: var(--ui-text-dimmed); font-size: 12px; font-weight: 400; font-variant-numeric: tabular-nums; }
.changelog-items { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.changelog-items li { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start; color: var(--ui-text); font-size: 14px; line-height: 1.6; }
.changelog-kind { padding: 0 6px; border: 1px solid var(--ui-border-accented); border-radius: 5px; color: var(--ui-text-muted); font-size: 12px; line-height: 20px; white-space: nowrap; margin-top: 1px; }
.changelog-kind.is-new { border-color: color-mix(in srgb, var(--ui-primary) 50%, transparent); color: var(--ui-primary); }
.changelog-kind.is-fix { border-color: color-mix(in srgb, var(--ui-warning) 45%, transparent); color: var(--ui-warning); }
.changelog-more { display: inline-flex; align-items: center; gap: 4px; margin-top: 16px; padding: 4px 6px; margin-left: -6px; border-radius: 6px; color: var(--ui-text-muted); font-size: 13px; cursor: pointer; }
.changelog-more:hover { background: var(--ui-bg-accented); color: var(--ui-text); }
.changelog-empty { color: var(--ui-text-muted); }
</style>

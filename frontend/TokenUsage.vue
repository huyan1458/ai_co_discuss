<script setup>
/**
 * The tokens one execution (or a member's executions together) took, as dsh shows a turn's use: `653K tok · 缓存命中 96%`
 * with a database icon; pressing it lists uncached input, cache reads, cache writes and output.
 */
import { computed } from "vue";
import { t } from "./i18n.js";
import { cache_hit, tokens, turn_total } from "./quota.js";

const props = defineProps({
  // `{input, cache_read, cache_write, output}`.
  usage: { type: Object, default: null },
  // The panel's title: one turn's use or all of them.
  title: { type: String, default: "" },
  // The total alone on the button; the cache hit rate is read in the panel.
  compact: Boolean,
});
const total = computed(() => turn_total(props.usage));
const hit = computed(() => cache_hit(props.usage));
const label = computed(() => [t('{value1} tok', { value1: tokens(total.value) }), hit.value === null || props.compact ? "" : t('缓存命中 {value1}%', { value1: hit.value })].filter(Boolean).join(" · "));
const rows = computed(() => [
  [t('未缓存输入'), props.usage?.input], [t('缓存读取'), props.usage?.cache_read], [t('缓存写入'), props.usage?.cache_write], [t('输出'), props.usage?.output],
].filter(([, count]) => count));
</script>

<template>
  <UPopover v-if="total" :content="{ side: 'top', align: 'start', sideOffset: 6 }">
    <button type="button" class="token-usage" :aria-label="label" @click.stop><UIcon v-if="!compact" name="i-lucide-database" /><span>{{ label }}</span></button>
    <template #content>
      <div class="context-meter-panel">
        <div class="context-meter-head"><span class="context-meter-muted">{{ title || t('Token 用量') }}</span><span class="context-meter-figures">{{ total.toLocaleString() }}</span></div>
        <dl class="context-meter-rows">
          <div v-if="hit !== null"><dt>{{ t('缓存命中') }}</dt><dd>{{ hit }}%</dd></div>
          <div v-for="[name, count] in rows" :key="name"><dt>{{ name }}</dt><dd>{{ count.toLocaleString() }}</dd></div>
        </dl>
      </div>
    </template>
  </UPopover>
</template>

<style>
/* Takes the size and line of the row it sits in, like the context meter, so it lines up with the text around it. */
.token-usage { display: inline-flex; flex: none; align-items: center; gap: 4px; margin: 0 -4px; padding: 0 4px; border: 0; border-radius: 5px; background: none; color: var(--ui-text-dimmed); font: inherit; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.token-usage:hover, .token-usage[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.token-usage .iconify { flex: none; width: 12px; height: 12px; opacity: .8; }
</style>

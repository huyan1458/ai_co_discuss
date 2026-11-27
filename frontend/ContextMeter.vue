<script setup>
/**
 * How full one member's session context is, drawn as dsh draws it: a 14px ring with the percentage beside it, the
 * tokens alone where the window is unknown. The ring's colour is the context's alone; an account window from QUOTA_WARN
 * on is written out beside it (`7d 99%`), and stands alone when there is no context reading. Pressing it opens the full
 * reading: tokens used against the window, then each usage-limit window of the member's account with when it resets.
 */
import { computed } from "vue";
import { t } from "./i18n.js";
import { context_fraction, quota_peak, quota_rows, tokens, used_level } from "./quota.js";

const props = defineProps({
  // The member's usage report from the room view (`free.members[].usage`).
  usage: { type: Object, default: null },
  // The account quota it draws on, or null.
  quota: { type: Object, default: null },
});
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const fraction = computed(() => context_fraction(props.usage));
const reading = computed(() => fraction.value === null ? tokens(props.usage?.context_used || 0) : `${Math.round(fraction.value * 100)}%`);
const level = computed(() => used_level(fraction.value || 0));
const peak = computed(() => quota_peak(props.quota));
// The account's most used window shows on the button once it needs attention, or as the only reading.
const shown_peak = computed(() => peak.value && (peak.value.level || !props.usage?.context_used) ? peak.value : null);
const rows = computed(() => quota_rows(props.quota));
const label = computed(() => [props.usage?.context_used ? t('上下文已用 {value1}', { value1: reading.value }) : "", shown_peak.value?.text || ""].filter(Boolean).join(" · "));
</script>

<template>
  <UPopover v-if="usage?.context_used || rows.length" :content="{ side: 'top', align: 'start', sideOffset: 6 }">
    <button type="button" class="context-meter" :aria-label="label" @click.stop>
      <svg v-if="fraction !== null" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle class="context-meter-track" cx="7" cy="7" :r="RADIUS" />
        <circle class="context-meter-fill" :class="level && `is-${level}`" cx="7" cy="7" :r="RADIUS" :stroke-dasharray="`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`" transform="rotate(-90 7 7)" />
      </svg>
      <span v-if="usage?.context_used" :class="level && `is-${level}`">{{ reading }}</span>
      <span v-if="shown_peak" :class="shown_peak.level && `is-${shown_peak.level}`">{{ shown_peak.text }}</span>
    </button>
    <template #content>
      <div class="context-meter-panel">
        <template v-if="usage?.context_used">
          <div class="context-meter-head">
            <span class="context-meter-muted">{{ t('上下文已用') }}</span>
            <strong v-if="fraction !== null">{{ reading }}</strong>
            <span class="context-meter-figures">{{ usage.context_window ? `~${tokens(usage.context_used)} / ${tokens(usage.context_window)}` : `~${tokens(usage.context_used)}` }}</span>
          </div>
          <div v-if="fraction !== null" class="context-meter-bar"><div :style="{ width: `${fraction * 100}%` }" /></div>
          <p v-else class="context-meter-muted">{{ t('这款软件不报告上下文窗口大小') }}</p>
        </template>
        <dl v-if="rows.length" class="context-meter-rows">
          <div v-for="row in rows" :key="row.key">
            <dt>{{ row.name }}</dt>
            <dd :class="row.level && `is-${row.level}`">{{ row.value }}</dd>
            <small v-if="row.note">{{ row.note }}</small>
          </div>
        </dl>
      </div>
    </template>
  </UPopover>
</template>

<style>
/* Laid out after dsh's composer meter: a quiet ring and tabular figures that brighten on hover. */
.context-meter { display: inline-flex; flex: none; align-items: center; gap: 5px; padding: 0 6px; border: 0; border-radius: 6px; background: none; color: var(--ui-text-dimmed); font: inherit; font-size: 11px; font-variant-numeric: tabular-nums; line-height: 18px; white-space: nowrap; cursor: pointer; }
.context-meter:hover, .context-meter[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.context-meter-track { fill: none; stroke: var(--ui-border-accented); stroke-width: 2px; }
.context-meter-fill { fill: none; stroke: currentColor; stroke-width: 2px; stroke-linecap: round; }
.context-meter .is-warn, .context-meter-rows dd.is-warn { color: var(--ui-warning); }
.context-meter .is-error, .context-meter-rows dd.is-error { color: var(--ui-error); }
.context-meter-panel { width: min(264px, 100vw - 24px); padding: 12px; font-size: 12px; line-height: 20px; color: var(--ui-text-muted); }
.context-meter-head { display: flex; align-items: center; gap: 6px; }
.context-meter-head strong { color: var(--ui-text-highlighted); font-weight: 500; }
.context-meter-figures { margin-left: auto; color: var(--ui-text-highlighted); font-weight: 500; font-variant-numeric: tabular-nums; }
.context-meter-muted { color: var(--ui-text-dimmed); }
.context-meter-bar { height: 4px; margin: 8px 0 4px; overflow: hidden; border-radius: 2px; background: var(--ui-border); }
.context-meter-bar > div { height: 100%; border-radius: 2px; background: var(--ui-text-muted); }
.context-meter-rows { display: grid; gap: 4px; margin: 8px 0 0; padding-top: 8px; border-top: 1px solid var(--ui-border); }
.context-meter-rows > div { display: grid; grid-template-columns: 1fr auto; column-gap: 8px; }
.context-meter-rows dt { color: var(--ui-text-dimmed); }
.context-meter-rows dd { margin: 0; color: var(--ui-text-highlighted); font-variant-numeric: tabular-nums; }
.context-meter-rows small { grid-column: 1 / -1; color: var(--ui-text-dimmed); font-size: 11px; line-height: 16px; }
</style>

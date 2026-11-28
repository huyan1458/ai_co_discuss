<script setup>
/**
 * How full one member's session context is, and nothing else: the context belongs to the member's session, while
 * usage limits belong to an account and are shown once per account (AccountQuotas; the design language of #15754).
 * Drawn as dsh draws it, a 12px ring that only ever means context, with the percentage beside it; where the window is
 * unknown the ring is hollow and the indicator carries no figure. Pressing it opens the details: tokens used against
 * the window. Three levels of detail by place: `alert` (a name or a working card) only from QUOTA_WARN on, `row` (the
 * right column's status line) and `full` (a member card's end, the private chat; `labelled` names it) always.
 */
import { computed } from "vue";
import { t } from "./i18n.js";
import { context_fraction, tokens, used_level } from "./quota.js";

const props = defineProps({
  // The member's usage report from the room view (`free.members[].usage`).
  usage: { type: Object, default: null },
  // `alert` | `row` | `full`, see above.
  mode: { type: String, default: "alert" },
  // In `full` mode, name the reading with “上下文” where no label sits beside it.
  labelled: Boolean,
});
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const fraction = computed(() => context_fraction(props.usage));
const percent = computed(() => fraction.value === null ? "" : `${Math.round(fraction.value * 100)}%`);
const level = computed(() => used_level(fraction.value || 0));
const shown = computed(() => Boolean(props.usage?.context_used) && (props.mode !== "alert" || Boolean(level.value)));
// The summary spells out an unknown window; the indicator keeps only the hollow ring.
const summary = computed(() => props.usage?.context_window ? `${tokens(props.usage.context_used)} / ${tokens(props.usage.context_window)}`
  : t('已用 {used}，窗口大小未知', { used: tokens(props.usage?.context_used || 0) }));
const label = computed(() => fraction.value === null ? t('上下文已用 {used}，窗口大小未知', { used: tokens(props.usage?.context_used || 0) }) : t('上下文已用 {value1}', { value1: percent.value }));
</script>

<template>
  <UPopover v-if="shown" :content="{ side: 'top', align: 'start', sideOffset: 6 }">
    <button type="button" class="context-meter" :data-mode="mode" :aria-label="label" @click.stop>
      <span v-if="mode === 'full' && labelled" class="context-meter-label">{{ t('上下文') }}</span>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <circle class="context-meter-track" cx="7" cy="7" :r="RADIUS" />
        <circle v-if="fraction !== null" class="context-meter-fill" :class="level && `is-${level}`" cx="7" cy="7" :r="RADIUS" :stroke-dasharray="`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`" transform="rotate(-90 7 7)" />
      </svg>
      <span v-if="percent">{{ percent }}</span>
      <span v-if="mode === 'full'" class="context-meter-muted">{{ summary }}</span>
    </button>
    <template #content>
      <div class="context-meter-panel">
        <div class="context-meter-head">
          <span class="context-meter-muted">{{ t('上下文已用') }}</span>
          <strong v-if="percent">{{ percent }}</strong>
          <span class="context-meter-figures">{{ usage.context_window ? `~${tokens(usage.context_used)} / ${tokens(usage.context_window)}` : `~${tokens(usage.context_used)}` }}</span>
        </div>
        <div v-if="fraction !== null" class="context-meter-bar"><div :style="{ width: `${fraction * 100}%` }" /></div>
        <p v-else class="context-meter-muted">{{ t('这款软件不报告上下文窗口大小') }}</p>
      </div>
    </template>
  </UPopover>
</template>

<style>
/* Laid out after dsh's composer meter: a quiet ring and tabular figures that brighten on hover. It takes the size and
   line of the row it sits in, and its hover background reaches past its text, so its figures line up with the text
   above and below (#15466). Only the ring and a small dot carry colour; the figures stay grey, never louder than the
   names beside them. */
.context-meter { display: inline-flex; flex: none; align-items: center; gap: 5px; margin: 0 -4px; padding: 0 4px; border: 0; border-radius: 5px; background: none; color: var(--ui-text-dimmed); font: inherit; font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.context-meter[data-mode="alert"], .context-meter[data-mode="row"] { margin: 0; font-size: 11px; line-height: 16px; }
.context-meter:hover, .context-meter[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.context-meter svg { flex: none; width: 12px; height: 12px; }
.context-meter-track { fill: none; stroke: var(--ui-border-accented); stroke-width: 2px; }
.context-meter-fill { fill: none; stroke: var(--ui-text-dimmed); stroke-width: 2px; stroke-linecap: round; }
.context-meter-fill.is-warn { stroke: color-mix(in srgb, var(--ui-warning) 75%, transparent); }
.context-meter-fill.is-error { stroke: color-mix(in srgb, var(--ui-error) 75%, transparent); }
.context-meter-peak { display: inline-flex; align-items: center; gap: 4px; }
.context-meter-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.context-meter-dot.is-warn { background: var(--ui-warning); }
.context-meter-dot.is-error { background: var(--ui-error); }
.context-meter-rows dd.is-warn { color: var(--ui-warning); }
.context-meter-rows dd.is-error { color: var(--ui-error); }
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
.context-meter-label { color: var(--ui-text-dimmed); }
/* Fingers need a bigger target than the 18px line; the reading itself stays small. */
@media (pointer: coarse) { .context-meter, .token-usage { min-height: 32px; } }
</style>

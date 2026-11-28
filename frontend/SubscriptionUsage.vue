<script setup>
import { computed, inject, ref } from "vue";
import { t } from "./i18n.js";

/**
 * The analytics page's subscription section (#15788, Fable #15790): how much of each plan's weekly limit was used, how
 * often its 5-hour window ran out and how many early resets (reset credits) it took, so the owner can decide whether to
 * move up or down a plan next cycle. Reads the site's `/api/quota-usage` (the manager's only); figures are lower bounds,
 * as a window's last reading may come before it resets. A slider asks “with N times this plan's room, how many of these
 * weeks would have run out”, so no price or plan table of ours is needed.
 */
const WEEKS = 8;
// Capacity multiples the slider offers, the plan's own room first.
const SCALES = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5];
const { bridge } = inject("discussion");
const data = ref(null);
const failed = ref(false);
const scale = ref(SCALES.indexOf(1));

async function load() {
  try { data.value = await bridge.request(`/api/quota-usage?weeks=${WEEKS}`); failed.value = false; }
  catch { failed.value = true; }
}
load();

const VERDICTS = {
  upgrade: { label: t("可以考虑升级"), tone: "warn" },
  downgrade: { label: t("可以考虑降级"), tone: "calm" },
  fit: { label: t("基本合适"), tone: "" },
  insufficient: { label: t("数据不足"), tone: "" },
};
const percent = (value) => `${Math.round(value * 100)}%`;
const day = (seconds) => new Date(seconds * 1000).toLocaleDateString([], { month: "numeric", day: "numeric" });
const waited = (seconds) => seconds >= 3600 ? t("{value1} 小时", { value1: Math.round(seconds / 360) / 10 }) : t("{value1} 分钟", { value1: Math.round(seconds / 60) });
const accounts = computed(() => (data.value?.accounts || []).map((item) => {
  const weeks = item.weeks || [];
  const top = Math.max(1, ...weeks.map((week) => week.used || 0));
  return { ...item, weeks, top, verdict: VERDICTS[item.verdict] || VERDICTS.insufficient };
}));
const factor = computed(() => SCALES[scale.value]);
// A week runs short with `factor` times the room when what it needed is more than that.
const short_weeks = (item) => item.weeks.filter((week) => week.complete && (week.used || 0) > factor.value).length;
const complete_weeks = (item) => item.weeks.filter((week) => week.complete).length;
</script>

<template>
  <div class="subscription-usage">
    <p class="analytics-detail-note">{{ t("各家订阅套餐每周用到多少、5 小时窗口撞限几次、用了几次提前重置，帮你决定下个周期升级还是降级。数字是下限：窗口重置前最后一次读到的值；只统计这台电脑读到的账号，包括你在共议之外直接使用的消耗。") }}</p>
    <p v-if="failed" class="analytics-calm analytics-calm-plain"><UIcon name="i-lucide-gauge" />{{ t("读取失败") }}</p>
    <p v-else-if="data && !accounts.length" class="analytics-calm analytics-calm-plain"><UIcon name="i-lucide-gauge" />{{ t("还没有额度记录：成员干活或本机查询额度后开始累积。") }}</p>
    <template v-else-if="accounts.length">
      <label class="subscription-scale">
        <span>{{ t("如果套餐容量是现在的") }}</span>
        <input v-model.number="scale" type="range" min="0" :max="SCALES.length - 1" step="1" :aria-valuetext="t('{value1} 倍', { value1: factor })" />
        <strong class="num">{{ t('{value1} 倍', { value1: factor }) }}</strong>
      </label>
      <article v-for="item in accounts" :key="`${item.account}|${item.group}`" class="subscription-card">
        <header>
          <strong>{{ item.label }}</strong>
          <small v-if="item.plan" class="analytics-dim">{{ item.plan }}</small>
          <span class="subscription-verdict" :class="item.verdict.tone && `is-${item.verdict.tone}`">{{ item.verdict === VERDICTS.insufficient && item.weeks_needed ? t("数据不足，还需要 {value1} 周", { value1: item.weeks_needed }) : item.verdict.label }}</span>
        </header>
        <!-- One bar per weekly window, oldest first; the line marks the plan's room at the chosen multiple. -->
        <div class="subscription-weeks" role="img" :aria-label="t('每周用量：{value1}', { value1: item.weeks.map((week) => percent(week.used || 0)).join('、') })">
          <div v-for="week in item.weeks" :key="week.start" class="subscription-week" :class="{ 'is-open': !week.complete, 'is-short': week.complete && (week.used || 0) > factor }"
            :title="week.resets ? t('{start}–{end}：至少用到 {used}，提前重置 {value1} 次', { start: day(week.start), end: day(week.end), used: percent(week.used || 0), value1: week.resets }) : t('{start}–{end}：至少用到 {used}', { start: day(week.start), end: day(week.end), used: percent(week.used || 0) })">
            <span class="subscription-bar" :style="{ height: `${Math.min((week.used || 0) / item.top, 1) * 100}%` }" />
            <i v-if="week.resets" class="subscription-reset" aria-hidden="true" />
          </div>
          <span class="subscription-line" :style="{ bottom: `${Math.min(factor / item.top, 1) * 100}%` }" aria-hidden="true" />
        </div>
        <dl class="subscription-facts">
          <div><dt>{{ t("容量 {value1} 倍时", { value1: factor }) }}</dt><dd>{{ t("{value1} / {value2} 周不够", { value1: short_weeks(item), value2: complete_weeks(item) }) }}</dd></div>
          <div><dt>{{ t("5h 撞限") }}</dt><dd>{{ item.five_hour?.hits ? t("{value1} 次，共等 {value2}", { value1: item.five_hour.hits, value2: waited(item.five_hour.wait_seconds || 0) }) : t("没有") }}</dd></div>
          <div><dt>{{ t("提前重置") }}</dt><dd>{{ t("{value1} 次", { value1: item.weeks.reduce((sum, week) => sum + (week.resets || 0), 0) }) }}<small v-if="Number.isFinite(item.reset_credits?.available)">{{ t("剩余重置卡 {value1} 张", { value1: item.reset_credits.available }) }}</small></dd></div>
        </dl>
      </article>
    </template>
  </div>
</template>

<style scoped>
.subscription-usage { display: grid; gap: 12px; }
.subscription-usage > .analytics-detail-note { margin: 0; color: var(--ui-text-dimmed); font-size: 12px; line-height: 1.6; }
.subscription-scale { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; color: var(--ui-text-muted); font-size: 12px; }
.subscription-scale input { flex: 1 1 160px; max-width: 280px; }
.subscription-scale strong { min-width: 3.5em; color: var(--ui-text-highlighted); font-weight: 600; text-align: left; }
.subscription-card { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.subscription-card header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.subscription-card header strong { color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.subscription-verdict { margin-left: auto; color: var(--ui-text-muted); font-size: 12px; }
.subscription-verdict.is-warn { color: var(--ui-warning); }
.subscription-verdict.is-calm { color: var(--viz-up, var(--ui-success)); }
.subscription-weeks { position: relative; display: grid; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; gap: 6px; height: 64px; padding-bottom: 1px; border-bottom: 1px solid var(--ui-border); }
.subscription-week { position: relative; display: flex; align-items: flex-end; justify-content: center; }
.subscription-bar { display: block; width: 100%; max-width: 28px; min-height: 2px; border-radius: 3px 3px 0 0; background: var(--ui-text-dimmed); opacity: .55; }
.subscription-week.is-short .subscription-bar { background: var(--ui-warning); opacity: .85; }
.subscription-week.is-open .subscription-bar { opacity: .3; }
.subscription-reset { position: absolute; top: -2px; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-error); }
.subscription-line { position: absolute; right: 0; left: 0; border-top: 1px dashed var(--ui-text-muted); pointer-events: none; }
.subscription-facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 0; font-size: 12px; }
.subscription-facts dt { color: var(--ui-text-dimmed); }
.subscription-facts dd { display: grid; gap: 2px; margin: 0; color: var(--ui-text); font-variant-numeric: tabular-nums; }
.subscription-facts dd small { color: var(--ui-text-dimmed); font-size: 11px; }
</style>

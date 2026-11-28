<script setup>
import { computed, inject, ref, watch } from "vue";
import { analytics_query, format_duration } from "./analytics-state.js";
import { t } from "./i18n.js";

/**
 * The analytics page's MOSS section (#15623): how often MOSS sent work out and how it went, from the site's
 * `/api/analytics/moss` for the chosen period, and the channel's "已排队" receipts counted on this computer.
 * Props: `preset` and `tz` as the page uses them; an unknown or unreachable source reads as 暂无数据.
 */
const props = defineProps({ preset: { type: String, required: true }, tz: { type: String, required: true } });
const { bridge } = inject("discussion");
const stats = ref(null);
const receipts = ref(null);
const loaded = ref(false);
let reading = 0;

async function load() {
  const serial = ++reading;
  const path = analytics_query(props.preset, props.tz).replace("/api/analytics?", "/api/analytics/moss?");
  const [site, local] = await Promise.allSettled([bridge.request(path), bridge.local_request("steward", {})]);
  if (serial !== reading) return;
  stats.value = site.status === "fulfilled" ? site.value : null;
  receipts.value = local.status === "fulfilled" ? local.value?.channel_queue_receipts || null : null;
  loaded.value = true;
}
watch(() => [props.preset, props.tz], load, { immediate: true });

const count = (value) => (Number.isFinite(value) ? value : null);
const figures = computed(() => {
  const data = stats.value || {};
  return [
    { key: "task", label: t("新建任务房间"), value: count(data.task_rooms) },
    { key: "project", label: t("新建项目房间"), value: count(data.project_rooms) },
    { key: "delegated", label: t("交给已有房间"), value: count(data.delegations) },
    { key: "rework", label: t("返工"), value: count(data.reworks) },
    { key: "unreported", label: t("未回报"), value: count(data.unreported) },
    { key: "reclaimed", label: t("改回在对话里做"), value: count(data.reclaimed) },
  ];
});
const runs = computed(() => stats.value?.executions || null);
</script>

<template>
  <div class="moss-analytics">
    <p class="analytics-detail-note">{{ t("MOSS 把事情分出去的情况，用来判断分流规则合不合适；只统计 MOSS 自己发起的。") }}</p>
      <dl class="moss-analytics-figures" :aria-busy="!loaded">
        <div v-for="item in figures" :key="item.key"><dt>{{ item.label }}</dt><dd class="num"><USkeleton v-if="!loaded" class="moss-analytics-value" /><span v-else :title="item.value === null ? t('暂无数据') : undefined">{{ item.value ?? "—" }}</span></dd></div>
      </dl>
      <dl class="moss-analytics-figures">
        <div><dt>{{ t("MOSS 执行") }}</dt><dd><USkeleton v-if="!loaded" class="moss-analytics-value" /><span v-else class="num">{{ runs?.count ?? "—" }}</span><small>{{ runs?.count ? t("通常 {usual} · 较慢 {slow}", { usual: format_duration(runs.p50), slow: format_duration(runs.p90) }) : "—" }}</small></dd></div>
        <div><dt>{{ t("渠道排队回执") }}</dt><dd><USkeleton v-if="!loaded" class="moss-analytics-value" /><span v-else class="num">{{ receipts?.total ?? "—" }}</span><small>{{ receipts ? t("最近 7 天 {count} 次", { count: receipts.last_7_days ?? 0 }) : "—" }}</small></dd></div>
      </dl>
  </div>
</template>

<style scoped>
.moss-analytics { display: grid; gap: 10px; }
/* The page's note style is scoped to the page; the section keeps the same quiet line. */
.moss-analytics > .analytics-detail-note { margin: 0; color: var(--ui-text-dimmed); font-size: 12px; line-height: 1.6; }
.moss-analytics-figures { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 0; }
.moss-analytics-figures > div { display: grid; gap: 2px; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.moss-analytics-figures dt { color: var(--ui-text-muted); font-size: 12px; }
.moss-analytics-figures dd { display: grid; gap: 2px; margin: 0; color: var(--ui-text-highlighted); font-size: 20px; font-weight: 650; }
.moss-analytics-value { align-self: center; height: 1.5em; width: 2em; }
.moss-analytics-figures dd small { min-height: 2.75em; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; }
</style>

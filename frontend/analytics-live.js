// The statistics page's “实时” view (#14994, #15070): what the AI is doing right now and what waits for the owner.
// Refreshes every 10 seconds while the view is shown and the page is visible; a hidden tab stops polling.
import { onBeforeUnmount, ref } from "vue";
import { format_duration } from "./analytics-state.js";
import { t } from "./i18n.js";

const REFRESH_MS = 10000;
const LABEL_MINUTES = 10;

/** Poll `/api/analytics?range=live` while active; stale responses are dropped. */
export function use_live_analytics(bridge) {
  const live = ref(null);
  const loading = ref(false);
  const error = ref("");
  let serial = 0;
  let timer = 0;
  let active = false;

  async function load(manual = false) {
    const current = ++serial;
    loading.value = true;
    try {
      const data = await bridge.request("/api/analytics?range=live");
      if (current !== serial) return;
      live.value = data.live || null;
      error.value = "";
    } catch (problem) {
      if (current !== serial) return;
      const message = problem?.message || t("读取统计失败");
      error.value = message;
      if (manual) bridge.notify("error", message);
    } finally {
      if (current === serial) loading.value = false;
    }
  }
  function schedule() {
    clearInterval(timer);
    timer = active && !document.hidden ? setInterval(() => load(false), REFRESH_MS) : 0;
  }
  function on_visibility() {
    if (active && !document.hidden) load(false);
    schedule();
  }
  /** Show or hide the live view: showing loads at once and starts polling, hiding stops it. */
  function set_active(value) {
    if (value === active) return;
    active = value;
    if (active) {
      document.addEventListener("visibilitychange", on_visibility);
      load(false);
    } else {
      serial++;
      document.removeEventListener("visibilitychange", on_visibility);
    }
    schedule();
  }
  onBeforeUnmount(() => set_active(false));
  return { live, loading, error, load, set_active };
}

/** The timeline series in the shape the page's chart expects, labelled by local clock time every 10 minutes. */
export function live_series(live) {
  const series = live?.timeline;
  if (!series?.points?.length) return null;
  const stamp = (index) => new Date((series.start + index * series.step) * 1000);
  const clock = (index) => stamp(index).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return { ...series, stamp, clock, label_every: Math.max(1, Math.round((LABEL_MINUTES * 60) / series.step)) };
}

/** One whole sentence per kind of thing waiting for the owner. */
export function waiting_title(item) {
  switch (item.kind) {
    case "goal": return t("Goal 等你确认");
    case "question": return t("{member} 在问你", { member: item.member });
    case "awaiting": return t("{member} 在等你回复", { member: item.member });
    case "rounds": return item.rounds
      ? t("主持人申请再加 {count} 轮，等你批准", { count: item.rounds })
      : t("任务链到了轮数上限，等你决定是否继续");
    case "failed": return t("{member} 的执行失败了，等你决定是否重试", { member: item.member });
    case "permission": return t("{member} 被权限拦住，等你放行", { member: item.member });
    default: return item.kind;
  }
}

export const WAITING_ICONS = {
  goal: "i-lucide-flag", question: "i-lucide-message-circle-question", rounds: "i-lucide-repeat",
  failed: "i-lucide-circle-x", permission: "i-lucide-shield-alert", awaiting: "i-lucide-message-circle-more",
};

/** How long something has waited, or been running, as of the snapshot. */
export function waited_text(since, at) {
  return since ? t("已等 {duration}", { duration: format_duration(at - since) }) : "";
}

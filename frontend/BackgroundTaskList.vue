<script setup>
/**
 * The background work panel of the private chat, opened from the line under the input box, laid out as Claude Code's
 * background panel: a titled block on a coloured rule, the running work grouped by kind (`●`, title, state), the ended
 * work folded under "较早的 (N)", and a key hint at the foot. It only shows: a single item cannot be stopped from here.
 * The list is generic; which software reported it is never shown or interpreted here. Its own clock keeps the times
 * current without re-rendering the page.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { t } from "./i18n.js";
import { KIND_LABELS, KIND_ORDER, running_text, shown_title } from "./background-tasks.js";

const props = defineProps({
  /** `[{id, kind, title, state, started_at, ended_at, next_at, schedule}]`, times in milliseconds (0 when unknown). */
  tasks: { type: Array, default: () => [] },
});
const emit = defineEmits(["close"]);
const STATE_LABELS = { done: t('已完成'), failed: t('失败'), stopped: t('已停止') };
const now = ref(Date.now());
const earlier = ref(false);
const panel = ref(null);
let timer = 0;
onMounted(() => {
  timer = setInterval(() => { now.value = Date.now(); }, 30_000);
  // Esc closes it, as the panel takes the input's place.
  nextTick(() => panel.value?.focus());
});
onBeforeUnmount(() => clearInterval(timer));

const running = computed(() => props.tasks.filter((task) => task.state === "running"));
const ended = computed(() => props.tasks.filter((task) => task.state !== "running"));
const groups = computed(() => KIND_ORDER.map((kind) => ({ kind, label: KIND_LABELS[kind], tasks: running.value.filter((task) => task.kind === kind) }))
  .filter((group) => group.tasks.length));
const hover = (task) => `${KIND_LABELS[task.kind] || ""}：${task.title}`;
</script>

<template>
  <section ref="panel" class="bg-panel" tabindex="-1" :aria-label="t('后台工作')" @keydown.esc.stop.prevent="emit('close')">
    <div class="bg-title">{{ t('后台工作') }}</div>
    <div class="bg-sub">{{ t('{value1} 个运行中 · {value2} 个已结束', { value1: running.length, value2: ended.length }) }}</div>
    <div v-for="group in groups" :key="group.kind" class="bg-group">
      <div class="bg-group-name">{{ group.label }}</div>
      <div v-for="task in group.tasks" :key="task.id" class="bg-row" :title="hover(task)">
        <span class="bg-bullet">●</span><span class="bg-name">{{ shown_title(task) }}</span><span class="bg-state">{{ running_text(task, now) }}</span>
      </div>
    </div>
    <template v-if="ended.length">
      <button type="button" class="bg-earlier" :aria-expanded="earlier" @click="earlier = !earlier">{{ t('较早的（{value1}）', { value1: ended.length }) }}<span aria-hidden="true">{{ earlier ? " ⌄" : " ›" }}</span></button>
      <div v-if="earlier" class="bg-group is-ended">
        <div v-for="task in ended" :key="task.id" class="bg-row" :title="hover(task)">
          <span class="bg-bullet" :class="`is-${task.state}`">●</span><span class="bg-name">{{ shown_title(task) }}</span><span class="bg-state">{{ STATE_LABELS[task.state] || "" }}</span>
        </div>
      </div>
    </template>
    <div class="bg-hint">{{ t('esc 关闭 · 单项后台工作不能在这里停止') }}</div>
  </section>
</template>

<style scoped>
/* Takes the input box's place in the private chat's column (PrivateChat.vue), on a coloured rule as in Claude Code. The
   `--term-*` values are that page's own. A long list scrolls inside, the page around it stays. */
.bg-panel { flex: none; width: calc(100% - 2 * var(--term-gutter, 24px)); max-width: calc(var(--term-width, 960px) - 2 * var(--term-gutter, 24px));
  max-height: min(60vh, 420px); margin: 0 auto; padding: 10px 2px 2px; overflow-y: auto; scrollbar-width: thin; outline: none;
  border-top: 1px solid var(--term-blue, var(--ui-primary)); color: var(--term-text, var(--ui-text)); font-size: 13px; line-height: 20px; }
.bg-title { color: var(--term-blue, var(--ui-primary)); }
.bg-sub { color: var(--term-dim, var(--ui-text-muted)); }
.bg-group { margin-top: 14px; padding-left: 2ch; }
.bg-group-name { color: var(--term-text, var(--ui-text)); }
/* Bullet, title (cut short), state: the state sits next to the title, not at the far edge. */
.bg-row { display: grid; grid-template-columns: 2ch minmax(0, 56ch) auto; column-gap: 2ch; justify-content: start; }
.bg-bullet { color: var(--term-dim, var(--ui-text-muted)); text-align: center; }
.bg-bullet.is-done { color: var(--term-green); }
.bg-bullet.is-failed { color: var(--term-red); }
.bg-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bg-state { color: var(--term-dim, var(--ui-text-muted)); white-space: nowrap; font-variant-numeric: tabular-nums; }
.bg-group.is-ended { margin-top: 4px; }
.bg-group.is-ended .bg-name { color: var(--term-dim, var(--ui-text-muted)); }
.bg-earlier { all: unset; display: block; margin-top: 14px; padding-left: 6ch; cursor: pointer; }
.bg-earlier:hover, .bg-earlier:focus-visible { text-decoration: underline; }
.bg-hint { margin-top: 14px; color: var(--term-faint, var(--ui-text-dimmed)); font-size: 12px; }
@media (max-width: 640px) {
  .bg-row { grid-template-columns: 2ch minmax(0, 1fr) auto; column-gap: 1ch; }
  .bg-group { padding-left: 0; }
  .bg-earlier { padding-left: 3ch; }
}
</style>

<script>
import { reactive } from "vue";
/**
 * Each rated dispatch on this page, by message: `wanted` is the latest click not yet settled, `sending` whether a save
 * is on its way, `saved` the last value the site confirmed and `saved_over` the time of the value it replaced (a
 * withdrawn rating has no time of its own). Kept outside the card: the transcript keeps each message as first read, and
 * a card mounted again after scrolling away, or a save still on its way, must not lose it.
 */
const cards = reactive(new Map());
</script>

<script setup>
import { t } from './i18n.js';
/**
 * The owner's 👍/👎 on one host dispatch, with the optional "who should it have gone to / why" form after 👎.
 * Same control as the smart-scheduling decision's rating (SchedulerDecision.vue). Saves go out one at a time per card,
 * the latest click last, so the site ends with what the page shows.
 */
import { computed, inject, ref } from "vue";

const props = defineProps({
  message: { type: Object, required: true },
});
const { view, bridge } = inject("discussion");
// The select needs a non-empty value for "not specified"; it is saved as an empty answer.
const UNSET_CORRECTION = "__unset__";

/** The rating as last confirmed: this page's save, unless the site's copy (only the owner reads it) is newer. */
function confirmed() {
  const local = cards.get(props.message.id);
  const server = props.message.dispatch_feedback || null;
  if (local?.saved === undefined) return server;
  return server?.created_at && server.created_at > (local.saved?.created_at || local.saved_over) ? server : local.saved;
}
const feedback = computed(() => {
  const wanted = cards.get(props.message.id)?.wanted;
  return wanted !== undefined ? wanted : confirmed();
});
const rating = computed(() => feedback.value?.rating || null);

/** Show the choice at once and save it; a click while a save is on its way is sent when that one returns. */
async function save(value) {
  const id = props.message.id;
  if (!cards.has(id)) cards.set(id, { wanted: undefined, sending: false, saved: undefined, saved_over: "" });
  const local = cards.get(id);
  local.wanted = value;
  if (local.sending) return;
  local.sending = true;
  while (local.wanted !== undefined) {
    const sent = local.wanted;
    try {
      const result = await bridge.rate_dispatch(id, { rating: sent?.rating || null,
        ...(sent?.rating === "bad" ? { should_be: sent.should_be, note: sent.note } : {}) });
      local.saved_over = confirmed()?.created_at || "";
      local.saved = result.dispatch_feedback || null;
    } catch (failure) {
      // A failed save leaves the last confirmed rating in place.
      if (!failure.notified) bridge.notify("error", t('派活评价未保存：{value1}', { value1: failure.message }));
    }
    if (local.wanted === sent) local.wanted = undefined;
  }
  local.sending = false;
}

/** Clicking the current verdict again withdraws it; a bad one saves at once and opens the optional correction form. */
const correcting = ref(null);
function rate(choice) {
  const withdraw = rating.value === choice;
  const kept = { should_be: feedback.value?.should_be || "", note: feedback.value?.note || "" };
  correcting.value = !withdraw && choice === "bad" ? { ...kept } : null;
  save(withdraw ? null : { rating: choice, ...(choice === "bad" ? kept : { should_be: "", note: "" }) });
}
function save_correction() {
  const { should_be, note } = correcting.value;
  correcting.value = null;
  save({ rating: "bad", should_be, note: note.trim() });
}
/** Who it could have gone to: every member present. */
const correction_options = computed(() => [{ label: t('未指定'), value: UNSET_CORRECTION },
  ...(view.value.room.members || []).filter((member) => member.status === "active")
    .map((member) => ({ label: bridge.display_name(member.name), value: member.name }))]);
</script>

<template>
  <div class="channel-dispatch-feedback">
    <div class="channel-dispatch-feedback-row" role="group" :aria-label="t('评价 #{value1} 的派活', { value1: message.id })">
      <span>{{ t('派活评价') }}</span>
      <button type="button" class="channel-schedule-rate" :class="{ 'is-on': rating === 'good' }" :aria-pressed="rating === 'good'" :aria-label="t('这次派活派得好')" :title="t('派得好')" @click="rate('good')"><UIcon name="i-lucide-thumbs-up" /></button>
      <button type="button" class="channel-schedule-rate" :class="{ 'is-on': rating === 'bad' }" :aria-pressed="rating === 'bad'" :aria-label="t('这次派活派得不好')" :title="t('派得不好')" @click="rate('bad')"><UIcon name="i-lucide-thumbs-down" /></button>
    </div>
    <form v-if="correcting && rating === 'bad'" class="channel-schedule-correction" @submit.prevent="save_correction">
      <label>{{ t('应该派给谁') }}<USelect :model-value="correcting.should_be || UNSET_CORRECTION" :items="correction_options" :aria-label="t('应该派给谁')" size="xs" class="channel-schedule-correction-select"
        @update:model-value="correcting.should_be = $event === UNSET_CORRECTION ? '' : $event" /></label>
      <UInput v-model="correcting.note" maxlength="200" :placeholder="t('为什么（可选）')" :aria-label="t('这次派活为什么不好')" size="xs" class="channel-schedule-correction-note" />
      <span class="channel-schedule-correction-actions">
        <UButton type="submit" :label="t('保存')" size="xs" variant="soft" color="primary" />
        <UButton :label="t('关闭')" size="xs" variant="ghost" color="neutral" @click="correcting = null" />
      </span>
    </form>
  </div>
</template>

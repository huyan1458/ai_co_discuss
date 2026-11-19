<script setup>
/**
 * What happened to a message's requests, on one line of the card's header: one member by name; several as a count per
 * status, with each member's status, reason and answer in a menu (user 2026-11-18, #4505: a row per member pushed the
 * header to four lines). A request still on its way to the software spins, so the card shows it is not stuck.
 */
import { computed } from "vue";
import { t } from "./i18n.js";

const props = defineProps({ badges: { type: Array, required: true } });
const emit = defineEmits(["locate"]);

const only = computed(() => (props.badges.length === 1 ? props.badges[0] : null));
const delivering = computed(() => props.badges.some((badge) => badge.delivering));
const summary = computed(() => {
  const counts = new Map();
  for (const badge of props.badges) counts.set(badge.status, (counts.get(badge.status) || 0) + 1);
  return [...counts].map(([status, count]) => t('{count} 位{status}', { count, status })).join(" · ");
});
const items = computed(() => [props.badges.map((badge) => ({ label: badge.label, description: [badge.title, badge.answer_label].filter(Boolean).join(" · "),
  onSelect: () => { if (badge.answer_id) emit("locate", badge.answer_id); } }))]);
</script>

<template>
  <button v-if="only?.answer_id" type="button" class="channel-source channel-request-status is-link" :title="only.answer_label" @click="emit('locate', only.answer_id)">{{ only.label }}</button>
  <span v-else-if="only" class="channel-source channel-request-status" :class="{ 'is-delivering': only.delivering }" :title="only.title || only.label"><UIcon v-if="only.delivering" name="i-lucide-loader-circle" class="channel-request-spin" />{{ only.label }}<template v-if="only.title"> · {{ only.title }}</template></span>
  <UDropdownMenu v-else :items="items" :content="{ align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-request-menu' }">
    <button type="button" class="channel-source channel-request-status is-link" :class="{ 'is-delivering': delivering }"><UIcon v-if="delivering" name="i-lucide-loader-circle" class="channel-request-spin" />{{ summary }}<UIcon name="i-lucide-chevron-down" /></button>
  </UDropdownMenu>
</template>

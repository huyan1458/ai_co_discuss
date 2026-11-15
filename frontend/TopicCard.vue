<script setup>
import { t } from './i18n.js';
import { computed, inject, nextTick, ref, watch } from "vue";

const emit = defineEmits(["edit"]);
const { view, bridge } = inject("discussion");
const TOPIC_BODY_MAX_HEIGHT = 240;
const topic_expanded = ref(false);
const topic_body = ref(null);
const topic_overflows = ref(false);
const room = computed(() => view.value.room);
/** The channel's purpose; old rooms without a user request fall back to background. */
const topic = computed(() => {
  const value = room.value || {};
  const request = value.user_request?.trim() ? { label: t('用户原文'), text: value.user_request } : value.background?.trim() ? { label: t('背景'), text: value.background } : null;
  const experts = Object.entries(value.experts || {}).map(([name]) => ({ name, mode: bridge.participant_access(name, value) }));
  const limits = value.limits || {};
  const discussing = ["active", "paused"].includes(value.session?.status);
  const bounds = [discussing ? t('本场讨论') : t('下次讨论默认上限'),
    limits.max_rounds ? t('{value1} 轮', { value1: limits.max_rounds }) : t('轮次不限'), limits.max_minutes ? t('{value1} 分钟', { value1: limits.max_minutes }) : t('时长不限')].join(" · ");
  return { request, goal: value.session?.goal || value.goal, boundaries: value.boundaries, host: value.host, experts, bounds };
});

/** Show "展开全文" only when the whole topic body is taller than its folded height. */
async function measure() {
  await nextTick();
  topic_overflows.value = (topic_body.value?.scrollHeight || 0) > TOPIC_BODY_MAX_HEIGHT;
}
watch(() => JSON.stringify(topic.value), measure, { immediate: true });
watch(() => view.value.tab, measure);
defineExpose({ measure });
</script>

<template>
  <section class="channel-message channel-topic-card" :class="{ 'is-expanded': topic_expanded }" :aria-label="t('议题')">
    <header class="channel-topic-heading"><span class="channel-topic-eyebrow"><UIcon name="i-lucide-target" />{{ t('议题') }}</span><h2>{{ room.title }}</h2><UButton icon="i-lucide-pencil" :label="t('编辑')" color="neutral" variant="ghost" size="xs" @click="emit('edit')" /></header>
    <div ref="topic_body" class="channel-topic-body" :class="{ 'is-clamped': topic_overflows && !topic_expanded }">
    <div v-if="topic.request" class="channel-topic-section channel-topic-request"><h3>{{ topic.request.label }}</h3><p class="channel-topic-text">{{ topic.request.text }}</p></div>
    <div v-if="topic.goal" class="channel-topic-section"><h3>{{ t('目标') }}</h3><p class="channel-topic-text">{{ topic.goal }}</p></div>
    <div v-if="topic.boundaries" class="channel-topic-section"><h3>{{ t('边界') }}</h3><p class="channel-topic-text">{{ topic.boundaries }}</p></div>
    </div>
    <UButton v-if="topic_overflows || topic_expanded" :label="topic_expanded ? t('收起') : t('展开全文')" :trailing-icon="topic_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" @click="topic_expanded = !topic_expanded" />
    <div class="channel-topic-section channel-topic-config"><h3>{{ t('参与配置') }}</h3><div class="channel-topic-people">
      <span v-for="person in topic.experts" :key="person.name" class="channel-topic-person"><UAvatar :src="bridge.identities[person.name]?.icon" :text="bridge.identities[person.name]?.initials" :alt="person.name" size="2xs" class="channel-avatar" :class="bridge.identities[person.name]?.style" />{{ bridge.display_name(person.name) }}<small>{{ person.name === topic.host ? t('主持 · {value1}', { value1: person.mode }) : person.mode }}</small></span>    </div><small class="channel-topic-bounds">{{ topic.bounds }}</small></div>
  </section>
</template>

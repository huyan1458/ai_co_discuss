<script setup>
import { computed, inject, nextTick, ref, watch } from "vue";

const emit = defineEmits(["edit"]);
const { view, bridge, act } = inject("discussion");
const TOPIC_BODY_MAX_HEIGHT = 240;
const topic_expanded = ref(false);
const topic_body = ref(null);
const topic_overflows = ref(false);
const room = computed(() => view.value.room);
/** The channel's purpose; old rooms without a user request fall back to background. */
const topic = computed(() => {
  const value = room.value || {};
  const request = value.user_request?.trim() ? { label: "用户原文", text: value.user_request } : value.background?.trim() ? { label: "背景", text: value.background } : null;
  const experts = Object.entries(value.experts || {}).map(([name]) => ({ name, mode: bridge.participant_access(name, value) }));
  const limits = value.limits || {};
  const bounds = value.mode === "free" ? `自由协作 · 单次执行最多 ${value.free?.execution_minutes || 20} 分钟`
    : [limits.max_rounds ? `${limits.max_rounds} 轮` : "轮次不限", limits.max_minutes ? `${limits.max_minutes} 分钟` : "时长不限",
      value.runtime?.mode === "automatic" ? "全自动" : "手动"].join(" · ");
  return { request, goal: value.goal, boundaries: value.boundaries, host: value.host, experts, bounds };
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
  <section class="channel-message channel-topic-card" :class="{ 'is-expanded': topic_expanded }" aria-label="议题">
    <header class="channel-topic-heading"><span class="channel-topic-eyebrow"><UIcon name="i-lucide-target" />议题</span><h2>{{ room.title }}</h2><UButton icon="i-lucide-pencil" label="编辑" color="neutral" variant="ghost" size="xs" @click="emit('edit')" /></header>
    <div ref="topic_body" class="channel-topic-body" :class="{ 'is-clamped': topic_overflows && !topic_expanded }">
    <div v-if="topic.request" class="channel-topic-section channel-topic-request"><h3>{{ topic.request.label }}</h3><p class="channel-topic-text">{{ topic.request.text }}</p></div>
    <div v-if="topic.goal" class="channel-topic-section"><h3>目标</h3><p class="channel-topic-text">{{ topic.goal }}</p></div>
    <div v-if="topic.boundaries" class="channel-topic-section"><h3>边界</h3><p class="channel-topic-text">{{ topic.boundaries }}</p></div>
    </div>
    <UButton v-if="topic_overflows || topic_expanded" :label="topic_expanded ? '收起' : '展开全文'" :trailing-icon="topic_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" @click="topic_expanded = !topic_expanded" />
    <div v-if="room.parent_room" class="channel-topic-section"><h3>来源</h3><p class="channel-topic-text">从自由协作「<button type="button" class="channel-link-button" @click="act('room', room.parent_room.id)">{{ room.parent_room.title }}</button>」发起<template v-if="room.phase === 'concluded'"> · <button type="button" class="channel-link-button" @click="act('return_conclusion')">把结论发回</button></template></p></div>
    <div class="channel-topic-section channel-topic-config"><h3>参与配置</h3><div class="channel-topic-people">
      <span v-for="person in topic.experts" :key="person.name" class="channel-topic-person"><UAvatar :src="bridge.identities[person.name]?.icon" :text="bridge.identities[person.name]?.initials" :alt="person.name" size="2xs" class="channel-avatar" :class="bridge.identities[person.name]?.style" />{{ bridge.display_name(person.name) }}<small>{{ person.name === topic.host ? `主持 · ${person.mode}` : person.mode }}</small></span>    </div><small class="channel-topic-bounds">{{ topic.bounds }}</small></div>
  </section>
</template>

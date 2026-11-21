<script setup>
import { HOST_ITEMS, normalize_host_permissions } from '../runner/host_permissions.mjs';
import { t } from './i18n.js';
import { computed, inject, nextTick, ref, watch } from "vue";

// preview: a room still being created, shown from what the new-room panel already knows.
const props = defineProps({ preview: { type: Object, default: null } });
const emit = defineEmits(["edit"]);
const { view, bridge, act } = inject("discussion");
const TOPIC_BODY_MAX_HEIGHT = 240;
const topic_expanded = ref(false);
const topic_body = ref(null);
const topic_overflows = ref(false);
const room = computed(() => props.preview || view.value.room);
/** The channel's purpose; old rooms without a user request fall back to background. */
const topic = computed(() => {
  const value = room.value || {};
  const request = value.user_request?.trim() ? { label: t('用户原文'), text: value.user_request } : value.background?.trim() ? { label: t('背景'), text: value.background } : null;
  const experts = view.value.share ? spoken(value) : Object.entries(value.experts || {}).map(([name]) => ({ name, mode: bridge.participant_access(name, value) }));
  const limits = value.limits || {};
  const discussing = ["active", "paused"].includes(value.session?.status);
  const bounds = discussing ? [t('本场讨论'), limits.max_rounds ? t('{value1} 轮', { value1: limits.max_rounds }) : t('轮次不限'),
    limits.max_minutes ? t('{value1} 分钟', { value1: limits.max_minutes }) : t('时长不限')].join(" · ") : settings_summary(value);
  return { request, goal: value.session?.goal || value.goal, boundaries: value.boundaries, host: value.host, experts, bounds, discussing };
});

// A share page lists at most this many of the AIs that spoke, then how many more.
const SHARED_PEOPLE_SHOWN = 12;
/**
 * On a share page: the AIs that spoke in the room, host first, in the order they first spoke. The roster holds only who is
 * in the room now, and members invited for one task and removed after it are part of what the reader sees.
 */
function spoken(value) {
  const names = [value.host, ...view.value.messages.filter((message) => !message.withdrawn && message.author && message.author !== "用户" && message.author !== "系统").map((message) => message.author)];
  return [...new Set(names.filter(Boolean))].map((name) => ({ name, mode: "" }));
}
const shown_people = computed(() => view.value.share ? topic.value.experts.slice(0, SHARED_PEOPLE_SHOWN) : topic.value.experts);

/**
 * Outside a discussion, the settings that shape everyday collaboration: only what is switched on, plus the chain-round
 * limit; the API members' search and request limit only when the room has an API member. Empty when nothing is known.
 */
function settings_summary(value) {
  const saved = !props.preview && view.value.launch?.room_models?.room_id === value.id ? view.value.launch.room_models : null;
  const items = [];
  if (saved?.scheduler) items.push(t('智能调度'));
  if (saved?.image_generation) items.push(t('生图'));
  if (saved?.host_workflows) items.push(normalize_host_permissions(saved.host_permissions, true).items.length === HOST_ITEMS.length ? t('主持人完整权限') : t('主持人部分权限'));
  if (value.free?.max_rounds != null) items.push(value.free.max_rounds ? t('连续派活 {count} 轮', { count: value.free.max_rounds }) : t('连续派活不限'));
  const has_api = Object.values(saved?.participants || {}).some((member) => member?.adapter === "api");
  if (has_api) {
    if (Object.keys(view.value.launch.api_keys || {}).some((root) => { try { return new URL(root).hostname === "api.deepseek.com"; } catch { return false; } })) items.push(t('联网搜索'));
    items.push(saved.api_max_requests ? t('API 请求 {count} 次', { count: saved.api_max_requests }) : t('API 请求不限'));
  }
  return items.join(" · ");
}

/** Show "展开全文" only when the whole topic body is taller than its folded height. */
async function measure() {
  await nextTick();
  topic_overflows.value = (topic_body.value?.scrollHeight || 0) > TOPIC_BODY_MAX_HEIGHT;
}
watch(() => JSON.stringify(topic.value), measure, { immediate: true });
watch(() => view.value.tab, measure);
/**
 * Hidden until the room's details and transcript are both read: the directory entry a new room opens with has no members
 * or request, so showing it early made the card grow as they arrived (user 2026-11-18, #4818).
 */
const ready = computed(() => Boolean(props.preview) || Boolean(room.value?.experts) && !view.value.messages_loading);
watch(ready, measure);
defineExpose({ measure });
</script>

<template>
  <section v-if="ready" class="channel-message channel-topic-card" :class="{ 'is-expanded': topic_expanded }" :aria-label="t('议题')">
    <header class="channel-topic-heading"><span class="channel-topic-eyebrow"><UIcon name="i-lucide-target" />{{ t('议题') }}</span><h2>{{ room.title }}</h2><UButton v-if="!preview && !view.share" icon="i-lucide-pencil" :label="t('编辑')" color="neutral" variant="ghost" size="xs" @click="emit('edit')" /></header>
    <div ref="topic_body" class="channel-topic-body" :class="{ 'is-clamped': topic_overflows && !topic_expanded }">
    <div v-if="topic.request" class="channel-topic-section channel-topic-request"><h3>{{ topic.request.label }}</h3><p class="channel-topic-text">{{ topic.request.text }}</p></div>
    <div v-if="topic.goal" class="channel-topic-section"><h3>{{ t('目标') }}</h3><p class="channel-topic-text">{{ topic.goal }}</p></div>
    <div v-if="topic.boundaries" class="channel-topic-section"><h3>{{ t('边界') }}</h3><p class="channel-topic-text">{{ topic.boundaries }}</p></div>
    </div>
    <UButton v-if="topic_overflows || topic_expanded" :label="topic_expanded ? t('收起') : t('展开全文')" :trailing-icon="topic_expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" variant="link" color="neutral" size="xs" class="channel-answer-toggle" @click="topic_expanded = !topic_expanded" />
    <div class="channel-topic-section channel-topic-config"><h3>{{ view.share ? t('参与的 AI') : t('参与配置') }}</h3><div class="channel-topic-people">
      <span v-for="person in shown_people" :key="person.name" class="channel-topic-person"><UAvatar :src="bridge.identities[person.name]?.icon" :text="bridge.identities[person.name]?.initials" :alt="person.name" size="2xs" class="channel-avatar" :class="bridge.identities[person.name]?.style" />{{ bridge.display_name(person.name) }}<small v-if="view.share">{{ person.name === topic.host ? t('主持') : '' }}</small><small v-else>{{ person.name === topic.host ? t('主持 · {value1}', { value1: person.mode }) : person.mode }}</small></span><small v-if="topic.experts.length > shown_people.length" class="channel-topic-more">{{ t('等 {count} 位', { count: topic.experts.length }) }}</small>    </div><small v-if="topic.bounds && (topic.discussing || preview)" class="channel-topic-bounds">{{ topic.bounds }}</small>
      <button v-else-if="topic.bounds && !view.share" type="button" class="channel-topic-bounds" :title="t('查看协作设置')" @click="act('tab', 'overview')">{{ topic.bounds }}</button></div>
  </section>
</template>

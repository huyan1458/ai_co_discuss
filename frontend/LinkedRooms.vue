<script setup>
/**
 * The right rail's 父子房间 section: this room's parent and child rooms, each opening on click, with the other room's
 * host and whether it is working. Shown only when the room has such a room, so a child set apart in the sidebar
 * ("设为独立房间") still shows where it came from. Any room of the site may message another; this only shows the family.
 * Input: the room in view. Output: none, it only reads the room's room-links endpoint.
 */
import { computed, inject, ref, watch } from "vue";
import { t } from "./i18n.js";

const { view, bridge, act } = inject("discussion");
const RELATION_LABELS = { child: t("子房间"), parent: t("父房间") };
const room = computed(() => view.value.room);

// What the site last said for this room.
const links = ref([]);
let reading = 0;

/** Read the room's parent and child rooms; a slower earlier read never overwrites a later one. */
async function refresh() {
  const room_id = room.value?.id;
  if (!room_id) return;
  const ticket = ++reading;
  try {
    const result = await bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/room-links`);
    if (ticket === reading && room.value?.id === room_id) links.value = result.links || [];
  } catch { /* Keep what was shown; the section only reads. */ }
}
watch(() => room.value?.id, () => { links.value = []; refresh(); }, { immediate: true });
// New messages may bring a new child room or change the other hosts' state.
watch(() => view.value.snapshot_id, refresh);

const shown = computed(() => links.value.filter((link) => RELATION_LABELS[link.relation]));

/** The row's state: the other room's host and whether it is working. */
function link_status(link) {
  const host = link.host ? t("{host} 主持", { host: link.host }) : t("无主持人");
  return link.busy ? { tone: "primary", text: t("{host} · 处理中", { host }) } : { tone: "neutral", text: t("{host} · 空闲", { host }) };
}
</script>

<template>
  <section v-if="shown.length" class="pb-section linked-rooms" :aria-label="t('父子房间')">
    <h4>{{ t("父子房间") }}</h4>
    <ul class="linked-rooms-list">
      <li v-for="link in shown" :key="link.room_id" class="pb-member linked-room">
        <UIcon name="i-lucide-git-branch" class="linked-room-icon" />
        <div class="pb-member-body">
          <div class="pb-member-name"><button type="button" class="linked-room-title" :title="t('打开房间「{title}」', { title: link.title })" @click="act('room', link.room_id)">{{ link.title }}</button><small>{{ RELATION_LABELS[link.relation] }}</small></div>
          <div class="pb-member-status" :class="`is-${link_status(link).tone}`"><span class="pb-dot"></span><span class="pb-member-status-text">{{ link_status(link).text }}</span></div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Rows bleed 8px past the section like the speaking order above, so icons and names line up with its avatars. */
.linked-rooms-list { display: flex; flex-direction: column; gap: 2px; margin: 0 -8px; padding: 0; list-style: none; }
.linked-room { min-height: 0; padding: 4px 8px; }
.linked-room .pb-member-body { line-height: 1.35; }
.linked-room-icon { width: 14px; height: 14px; color: var(--ui-text-muted); }
.linked-room-title { min-width: 0; overflow: hidden; color: inherit; font: inherit; text-align: left; text-overflow: ellipsis; cursor: pointer; }
.linked-room-title:hover { text-decoration: underline; }
</style>

<script setup>
/**
 * The right rail's 关联房间 section: the rooms this room's host may send to (child, parent or peer), each opening on click,
 * with 解除关联 at the end of the row and 关联房间 below to link another room of this site as a peer.
 * Input: the room in view. Output: links and unlinks through the room's room-links endpoint.
 */
import { computed, inject, ref, watch } from "vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import { t } from "./i18n.js";

const { view, bridge, act } = inject("discussion");
const RELATION_LABELS = { child: t("子房间"), parent: t("父房间"), peer: t("关联房间") };
const room = computed(() => view.value.room);
const can_manage = computed(() => Boolean(view.value.access?.can_manage) && !room.value.archived && !view.value.share);

/** The other room's owner credential, when this browser holds it, so the site can check both rooms. */
function other_token(room_id) {
  try { return localStorage.getItem(`discuss-access:${room_id}`) || ""; } catch { return ""; }
}
const with_other = (room_id, payload) => ({ ...payload, ...(other_token(room_id) ? { other_token: other_token(room_id) } : {}) });

// What the site last said, and the changes still on their way: a new link shows at once, an unlinked one is gone at once.
const links = ref([]), loaded_for = ref("");
const adding = ref(new Map()), removing = ref(new Set());
let reading = 0;

/** Read the room's links; a slower earlier read never overwrites a later one. */
async function refresh() {
  const room_id = room.value?.id;
  if (!room_id) return;
  const ticket = ++reading;
  try {
    const result = await bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/room-links`);
    if (ticket !== reading || room.value?.id !== room_id) return;
    links.value = result.links || [];
    loaded_for.value = room_id;
  } catch { if (ticket === reading && loaded_for.value !== room_id) { links.value = []; loaded_for.value = room_id; } }
}
watch(() => room.value?.id, () => { links.value = []; loaded_for.value = ""; adding.value = new Map(); removing.value = new Set(); refresh(); }, { immediate: true });
// New messages (link and unlink cards among them) may change the list or the other hosts' state.
watch(() => view.value.snapshot_id, () => { if (loaded_for.value) refresh(); });

const shown = computed(() => {
  const listed = links.value.filter((link) => !removing.value.has(link.room_id));
  const known = new Set(listed.map((link) => link.room_id));
  return [...listed, ...[...adding.value.values()].filter((link) => !known.has(link.room_id))];
});

/** The row's state: the other room's host and whether it is working, or that the link is still being made. */
function link_status(link) {
  if (adding.value.has(link.room_id) && !links.value.some((item) => item.room_id === link.room_id)) return { tone: "neutral", text: t("正在关联…") };
  const host = link.host ? t("{host} 主持", { host: link.host }) : t("无主持人");
  return link.busy ? { tone: "primary", text: t("{host} · 处理中", { host }) } : { tone: "neutral", text: t("{host} · 空闲", { host }) };
}

const unlinking = ref(null);
/** Unlink after the user confirms: the row goes at once and comes back only if the site refuses. */
async function unlink() {
  const link = unlinking.value, room_id = room.value.id;
  if (!link) return;
  removing.value = new Set([...removing.value, link.room_id]);
  try {
    await bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/room-links`, with_other(link.room_id, { action: "delete", room_id: link.room_id }));
    await refresh();
  } catch (error) {
    bridge.notify("error", t("解除与「{title}」的关联失败：{error}", { title: link.title, error: error.message }));
  } finally {
    const next = new Set(removing.value);
    next.delete(link.room_id);
    removing.value = next;
  }
}

// The picker: this site's rooms other than this one and those already linked.
const picking = ref(false), query = ref(""), chosen = ref("");
const candidates = computed(() => {
  const taken = new Set([room.value.id, ...shown.value.map((link) => link.room_id)]);
  const words = query.value.trim().toLowerCase();
  return (view.value.rooms || []).filter((item) => !item.archived && !taken.has(item.id)
    && (!words || String(item.title || "").toLowerCase().includes(words) || item.id.includes(words)));
});
watch(picking, (open) => { if (open) { query.value = ""; chosen.value = ""; } });

/** Link the chosen room as a peer: the row shows at once; only it is taken back if the site refuses. */
async function link_room() {
  const target = (view.value.rooms || []).find((item) => item.id === chosen.value);
  if (!target) return;
  const room_id = room.value.id;
  picking.value = false;
  adding.value = new Map(adding.value).set(target.id, { room_id: target.id, title: target.title, relation: "peer", host: null, busy: false });
  try {
    await bridge.request(`/api/rooms/${encodeURIComponent(room_id)}/room-links`, with_other(target.id, { room_id: target.id }));
    await refresh();
  } catch (error) {
    bridge.notify("error", t("关联「{title}」失败：{error}", { title: target.title, error: error.message }));
  } finally {
    const next = new Map(adding.value);
    next.delete(target.id);
    adding.value = next;
  }
}
</script>

<template>
  <section v-if="can_manage || shown.length" class="pb-section linked-rooms" :aria-label="t('关联房间')">
    <h4>{{ t("关联房间") }}</h4>
    <ul v-if="shown.length" class="linked-rooms-list">
      <li v-for="link in shown" :key="link.room_id" class="pb-member linked-room">
        <UIcon :name="link.relation === 'peer' ? 'i-lucide-link' : 'i-lucide-git-branch'" class="linked-room-icon" />
        <div class="pb-member-body">
          <div class="pb-member-name"><button type="button" class="linked-room-title" :title="t('打开房间「{title}」', { title: link.title })" @click="act('room', link.room_id)">{{ link.title }}</button><small>{{ RELATION_LABELS[link.relation] || RELATION_LABELS.peer }}</small></div>
          <div class="pb-member-status" :class="`is-${link_status(link).tone}`"><span class="pb-dot"></span><span class="pb-member-status-text">{{ link_status(link).text }}</span></div>
        </div>
        <UButton v-if="can_manage && link.relation === 'peer'" icon="i-lucide-unlink" color="neutral" variant="ghost" size="xs" class="pb-member-more" :disabled="adding.has(link.room_id)"
          :aria-label="t('解除与「{title}」的关联', { title: link.title })" :title="t('解除关联')" @click="unlinking = link" />
      </li>
    </ul>
    <UButton v-if="can_manage" icon="i-lucide-plus" :label="t('关联房间')" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block pb-action-add" @click="picking = true" />
    <ConfirmDialog :open="Boolean(unlinking)" :title="t('解除与「{title}」的关联？', { title: unlinking?.title || '' })" :confirm-label="t('解除关联')" danger
      :items="[t('两个房间的主持人不能再互发消息；已发出的消息和两边的记录保留。'), t('两边各留一条解除记录，之后可以重新关联。')]"
      @update:open="(open) => { if (!open) unlinking = null; }" @confirm="unlink" />
    <UModal v-model:open="picking" :title="t('关联房间')" :description="t('允许两个房间的主持人互发消息。主持人仍按各自房间的权限工作。')" :content="{ onInteractOutside: (event) => event.preventDefault() }"
      :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal', body: 'dialog-body' }">
      <template #body>
        <form class="dialog-form" @submit.prevent="link_room">
          <UInput v-model="query" icon="i-lucide-search" :placeholder="t('搜索房间名称')" :aria-label="t('搜索房间名称')" autofocus class="w-full" autocomplete="off" />
          <div class="linked-room-picker" role="radiogroup" :aria-label="t('选择要关联的房间')">
            <button v-for="item in candidates" :key="item.id" type="button" role="radio" class="linked-room-option" :class="{ chosen: chosen === item.id }" :aria-checked="chosen === item.id"
              @click="chosen = item.id" @dblclick="chosen = item.id; link_room()"><UIcon name="i-lucide-hash" /><span>{{ item.title }}</span></button>
            <p v-if="!candidates.length" class="pb-free-note">{{ query.trim() ? t("没有匹配的房间") : t("没有可关联的房间") }}</p>
          </div>
          <div class="dialog-actions"><UButton :label="t('取消')" color="neutral" variant="ghost" @click="picking = false" /><UButton type="submit" :label="t('关联')" class="channel-primary-button" :disabled="!chosen" /></div>
        </form>
      </template>
    </UModal>
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
.linked-room-picker { display: flex; flex-direction: column; gap: 2px; max-height: min(50vh, 360px); margin: 10px 0 14px; overflow: auto; }
.linked-room-option { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 10px; border: 1px solid transparent; border-radius: 6px; color: var(--ui-text); font-size: 13px; text-align: left; cursor: pointer; }
.linked-room-option span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.linked-room-option :deep(svg) { flex: none; width: 14px; height: 14px; color: var(--ui-text-muted); }
.linked-room-option:hover { background: color-mix(in srgb, var(--ui-bg-accented) 60%, transparent); }
.linked-room-option.chosen { border-color: var(--ui-primary); background: color-mix(in oklab, var(--ui-primary) 10%, transparent); }
</style>

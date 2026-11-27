<script setup>
/**
 * Websites in the room directory: the "Published" entry listing every live site with copy, open, renew and revoke, and
 * the deploy dialog every answer card opens (frontend/sites.js). Shown only while the directory's rooms are open.
 */
import { computed, inject, ref, watch } from "vue";
import { locale, t } from "./i18n.js";
import { close_deploy, confirm_deploy, expired_label, load_all_sites, renew_items, site_command, sites_state } from "./sites.js";
import ConfirmDialog from "./ConfirmDialog.vue";

defineProps({ visible: { type: Boolean, default: true } });
const { view, bridge } = inject("discussion");

// A site lives seven days from its last deploy or renewal; under a day left is marked.
const LIFETIME_MS = 7 * 24 * 3600 * 1000;
const SOON_MS = 24 * 3600 * 1000;

const open = ref(false);
const revoking = ref(null);
const busy = ref("");
const live = computed(() => (sites_state.all || []).filter((site) => site.status === "active" || site.renewable).sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at)));
watch(() => live.value.length, (count) => { if (!count) open.value = false; });
watch(open, (shown) => { if (shown) load_all_sites(bridge); });

const host = (site) => site.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const time_text = (value) => new Date(value).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const soon = (site) => Date.parse(site.expires_at) - Date.now() < SOON_MS;
const life_left = (site) => Math.max(2, Math.min(100, (Date.parse(site.expires_at) - Date.now()) / LIFETIME_MS * 100));
function expiry_label(site) {
  if (site.status !== "active") return expired_label();
  const hours = Math.max(0, Math.round((Date.parse(site.expires_at) - Date.now()) / 3600000));
  return hours >= 24 ? t("{days} 天 {hours} 小时后过期", { days: Math.floor(hours / 24), hours: hours % 24 }) : t("{hours} 小时后过期", { hours });
}
const size_label = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

async function copy(site) {
  await navigator.clipboard.writeText(site.url);
  bridge.notify("info", t("已复制 {value1}", { value1: host(site) }));
}
async function run(site, action, payload = {}) {
  busy.value = site.site_id;
  try {
    const result = await site_command(bridge, action, site.room_id, { site_id: site.site_id, ...payload });
    if (action === "renew") bridge.notify("info", t("已续期，{time} 前有效", { time: time_text(result.expires_at) }));
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

// The deploy dialog.
const dialog = computed(() => sites_state.dialog);
const stage = computed(() => dialog.value?.stage);
const flagged_files = computed(() => [...new Set((stage.value?.spots || []).map((spot) => spot.path))]);
const dialog_title = computed(() => ({ checking: t("部署为网站"), confirm: t("部署为网站"), publishing: t("正在部署…"), done: t("网站已上线"), error: t("没能部署") }[dialog.value?.phase] || ""));
const copied = ref(false);
async function copy_new() {
  await navigator.clipboard.writeText(dialog.value.site.url);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}

// Online pages connect to the computer's relay after mount: wait until local or relayed rooms are ready, then load.
const sites_ready = computed(() => !view.value.room_source?.computer || Boolean(view.value.room_source?.remote));
watch(sites_ready, (ready) => { if (ready) load_all_sites(bridge); }, { immediate: true });
</script>

<template>
  <UButton v-show="visible && live.length" icon="i-lucide-globe" color="neutral" variant="ghost" class="channel-archive-toggle" aria-haspopup="dialog" @click="open = true"><span class="channel-archive-label">{{ t("已发布") }}</span><small class="channel-archive-count">{{ live.length }}</small></UButton>
  <UModal v-model:open="open" :title="t('已发布的网站')" :description="t('每个网站从最近一次部署或续期起有效 7 天；过期后停止访问，续期即可恢复原地址。')"
    :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog', body: 'dialog-body' }">
    <template #body>
      <ul class="shared-rooms">
        <li v-for="site in live" :key="site.site_id" class="shared-room" :class="{ 'is-soon': soon(site) }">
          <div class="shared-room-main">
            <strong>{{ site.title || host(site) }}</strong>
            <a class="shared-room-url" :href="site.url" target="_blank" rel="noopener noreferrer" :title="site.url">{{ host(site) }}</a>
            <small class="site-source">{{ t("来自「{room}」#{message} · {count} 个文件 · {size}", { room: site.room_title || site.room_id, message: site.message_id || "-", count: site.file_count, size: size_label(site.bytes) }) }}</small>
          </div>
          <div class="shared-room-side">
            <span class="shared-room-expiry"><UIcon name="i-lucide-clock" />{{ expiry_label(site) }}</span>
            <div class="shared-room-actions">
              <template v-if="site.status === 'active'"><UTooltip :text="t('复制链接')"><UButton icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" :aria-label="t('复制网站地址')" @click="copy(site)" /></UTooltip>
              <UTooltip :text="t('在新窗口打开')"><UButton icon="i-lucide-external-link" size="xs" color="neutral" variant="ghost" :aria-label="t('打开网站')" :to="site.url" target="_blank" rel="noopener noreferrer" /></UTooltip></template>
              <UDropdownMenu :items="[renew_items((days) => run(site, 'renew', { days }))]" :content="{ align: 'start', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
                <UButton icon="i-lucide-timer-reset" :label="t('续期')" size="xs" color="neutral" variant="soft" :loading="busy === site.site_id" :aria-label="t('续期网站 {value1}', { value1: host(site) })" /></UDropdownMenu>
              <UTooltip :text="t('撤销网站')"><UButton icon="i-lucide-link-2-off" size="xs" color="neutral" variant="ghost" class="shared-room-revoke" :aria-label="t('撤销网站')" @click="revoking = site" /></UTooltip>
            </div>
          </div>
          <span class="shared-room-life" aria-hidden="true"><i :style="{ width: `${life_left(site)}%` }"></i></span>
        </li>
      </ul>
    </template>
  </UModal>
  <ConfirmDialog :open="Boolean(revoking)" :title="t('撤销网站 {value1}', { value1: revoking ? host(revoking) : '' })" :description="t('网站立即无法访问，文件随即删除；同一地址不会再分配给别人。')"
    :confirm-label="t('撤销网站')" danger @update:open="(value) => { if (!value) revoking = null; }" @confirm="run(revoking, 'revoke')" />

  <UModal :open="Boolean(dialog)" :title="dialog_title" :description="dialog?.phase === 'done' ? t('任何拿到地址的人都能打开，7 天后自动下线。') : t('把这份网页放到公网地址上，任何拿到地址的人都能打开。')"
    :content="{ onInteractOutside: (event) => event.preventDefault() }" :ui="{ content: 'glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog', body: 'dialog-body' }"
    @update:open="(value) => { if (!value && dialog?.phase !== 'publishing') close_deploy(); }">
    <template #body>
      <div v-if="dialog?.phase === 'checking' || dialog?.phase === 'publishing'" class="site-dialog-wait" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ dialog.phase === 'checking' ? t("正在检查文件：数量、大小与疑似敏感内容…") : t("正在上传文件，全部传完才切换到新版本…") }}</div>
      <template v-else-if="dialog?.phase === 'confirm'">
        <p class="site-dialog-line"><UIcon name="i-lucide-folder" />{{ t("{name} · {count} 个文件 · {size}", { name: stage.title || stage.directory, count: stage.file_count, size: size_label(stage.bytes) }) }}</p>
        <p v-if="stage.site_id" class="site-dialog-line"><UIcon name="i-lucide-refresh-cw" />{{ t("更新已有网站，地址不变；上一版保留，可回滚。") }}</p>
        <div v-if="flagged_files.length" class="site-dialog-warn">
          <strong>{{ t("这些文件疑似含有密钥或令牌：") }}</strong>
          <ul><li v-for="spot in stage.spots" :key="`${spot.path}:${spot.kind}`"><code>{{ spot.path }}</code> {{ spot.text }}</li></ul>
          <p>{{ t("默认把它们排除在外再部署。") }}</p>
        </div>
        <div class="site-dialog-foot">
          <UButton v-if="flagged_files.length" :label="t('仍然全部部署')" color="neutral" variant="ghost" @click="confirm_deploy(bridge, { ignore_spots: true })" />
          <UButton :label="flagged_files.length ? t('排除后部署') : t('部署')" icon="i-lucide-rocket" color="primary" @click="confirm_deploy(bridge)" />
        </div>
      </template>
      <template v-else-if="dialog?.phase === 'done'">
        <div class="share-done-link">
          <UIcon name="i-lucide-globe" class="share-done-link-icon" />
          <input :value="dialog.site.url.replace(/^https?:\/\//, '')" readonly class="share-done-url" :aria-label="t('网站地址')" @focus="$event.target.select()">
          <UTooltip :text="t('在新窗口打开')"><UButton icon="i-lucide-external-link" color="neutral" variant="ghost" size="sm" :aria-label="t('打开网站')" :to="dialog.site.url" target="_blank" rel="noopener noreferrer" /></UTooltip>
          <UButton :label="copied ? t('已复制') : t('复制链接')" :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'" color="primary" size="sm" @click="copy_new" />
        </div>
        <p class="site-dialog-line"><UIcon name="i-lucide-clock" />{{ t("{time} 前有效，到期前可在左栏“已发布”或回答下方续期。", { time: time_text(dialog.site.expires_at) }) }}</p>
      </template>
      <template v-else-if="dialog?.phase === 'error'">
        <p class="site-dialog-error">{{ dialog.error }}</p>
        <ul v-if="dialog.files.length" class="site-dialog-files"><li v-for="file in dialog.files" :key="file.path"><code>{{ file.path }}</code> {{ file.reason || file.text || (file.bytes ? size_label(file.bytes) : "") }}</li></ul>
      </template>
    </template>
  </UModal>
</template>

<style scoped>
.site-source { color: var(--ui-text-dimmed); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-dialog-wait { display: flex; align-items: center; gap: 8px; padding: 20px 0 28px; color: var(--ui-text-toned); font-size: 13px; }
.site-dialog-line { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; color: var(--ui-text-toned); font-size: 13px; }
.share-done-link + .site-dialog-line { margin-top: 12px; }
.site-dialog-warn { margin: 4px 0 12px; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--ui-warning) 10%, transparent); font-size: 12px; }
.site-dialog-warn ul, .site-dialog-files { margin: 6px 0; padding-left: 18px; max-height: 30vh; overflow-y: auto; font-size: 12px; }
.site-dialog-warn p { margin: 0; color: var(--ui-text-muted); }
.site-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.site-dialog-error { margin: 0 0 8px; color: var(--ui-error); font-size: 13px; }
.share-done-link { display: flex; align-items: center; gap: 4px; padding: 5px 5px 5px 12px; border: 1px solid var(--ui-border-accented); border-radius: 11px; background: var(--ui-bg); }
.share-done-link-icon { flex-shrink: 0; color: var(--ui-text-muted); }
.share-done-url { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ui-text-highlighted); font-size: 13px; }
</style>

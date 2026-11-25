<script setup>
/**
 * The websites an answer staged or published, as cards under its text: a directory a member staged
 * (`codiscuss site stage`) waits for the owner's "Deploy as website"; a published one shows its address, state and
 * what can be done with it. Matched by the answer's execution, or by the message a site was published from.
 */
import { computed, inject, onMounted, ref } from "vue";
import { locale, t } from "./i18n.js";
import { load_room_sites, open_deploy, site_command, sites_state } from "./sites.js";

const props = defineProps({
  message: { type: Object, required: true },
  roomId: { type: String, required: true },
  executionId: { type: Number, default: 0 },
});
const { bridge } = inject("discussion");

const record = computed(() => sites_state.rooms[props.roomId]);
const sites = computed(() => (record.value?.sites || []).filter((site) => site.message_id === props.message.id || (props.executionId && site.execution_id === props.executionId)));
const published = computed(() => new Set(sites.value.map((site) => site.site_id)));
// A stage already published from this answer shows as its site, not again as waiting.
// Once this answer published a site, its earlier stage (staged, then published with --dir) no longer waits either.
const stages = computed(() => sites.value.length ? [] : (record.value?.stages || []).filter((stage) => props.executionId && stage.execution_id === props.executionId && !published.value.has(stage.site_id)));
const busy = ref("");
const copied = ref("");

const size_label = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const expiry_text = (site) => new Date(site.expires_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const status_text = (site) => ({ active: t("已上线"), expired: t("已过期"), revoked: t("已撤销"), taken_down: t("已被运营方下架") }[site.status] || site.status);
// A site lives seven days from its last deploy or renewal: how much is left, for the bar along the card's foot.
const LIFETIME_MS = 7 * 864e5;
const life_left = (site) => Math.max(2, Math.min(100, (Date.parse(site.expires_at) - Date.now()) / LIFETIME_MS * 100));
const expires_soon = (site) => Date.parse(site.expires_at) - Date.now() < 864e5;
const host = (site) => site.url.replace(/^https?:\/\//, "").replace(/\/$/, "");

async function copy(site) {
  await navigator.clipboard.writeText(site.url);
  copied.value = site.site_id;
  setTimeout(() => { if (copied.value === site.site_id) copied.value = ""; }, 1500);
}

async function run(site, action, payload = {}) {
  busy.value = site.site_id;
  try {
    await site_command(bridge, action, props.roomId, { site_id: site.site_id, ...payload });
    bridge.notify("info", { renew: t("已续期，{time} 前有效", { time: expiry_text({ expires_at: Date.now() + 7 * 864e5 }) }), rollback: t("已回滚到上一版"), revoke: t("网站已撤销，地址立即失效") }[action]);
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

const menu = (site) => [[
  { label: t("续期 7 天"), icon: "i-lucide-clock", disabled: site.status !== "active", onSelect: () => run(site, "renew") },
  ...(site.previous_version ? [{ label: t("回滚到上一版"), icon: "i-lucide-undo-2", disabled: site.status !== "active", onSelect: () => run(site, "rollback", { version: site.previous_version }) }] : []),
], [{ label: t("撤销网站"), icon: "i-lucide-link-2-off", color: "error", disabled: site.status !== "active", onSelect: () => run(site, "revoke") }]];

const deploy_stage = (stage) => open_deploy(bridge, { room_id: props.roomId, message_id: props.message.id, execution_id: props.executionId, member: props.message.author, stage });

onMounted(() => load_room_sites(bridge, props.roomId, props.message.id));
</script>


<template>
  <div v-if="stages.length || sites.length" class="answer-sites">
    <div v-for="stage in stages" :key="stage.stage_id" class="site-card is-staged">
      <div class="site-card-chrome">
        <span class="site-card-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="site-card-address is-empty"><UIcon name="i-lucide-globe" />{{ t("尚未上线") }}</span>
        <span class="site-card-badge is-staged">{{ t("待部署") }}</span>
      </div>
      <div class="site-card-body">
        <div class="site-card-text">
          <strong>{{ stage.title || stage.directory }}</strong>
          <small>{{ t("{count} 个文件 · {size}", { count: stage.file_count, size: size_label(stage.bytes) }) }}</small>
        </div>
        <UButton :label="t('部署为网站')" icon="i-lucide-rocket" size="sm" color="primary" @click="deploy_stage(stage)" />
      </div>
    </div>
    <UContextMenu v-for="site in sites" :key="site.site_id" :disabled="busy === site.site_id" :items="menu(site)" :ui="{ content: 'channel-menu' }">
    <div class="site-card" :class="[`is-${site.status}`, { 'is-soon': site.status === 'active' && expires_soon(site) }]">
      <div class="site-card-chrome">
        <span class="site-card-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        <a v-if="site.status === 'active'" :href="site.url" target="_blank" rel="noopener noreferrer" class="site-card-address" :title="site.url"><UIcon name="i-lucide-lock" />{{ host(site) }}</a>
        <span v-else class="site-card-address is-gone"><UIcon name="i-lucide-globe" />{{ host(site) }}</span>
        <span class="site-card-badge" :class="`is-${site.status}`"><i aria-hidden="true"></i>{{ status_text(site) }}</span>
      </div>
      <div class="site-card-body">
        <div class="site-card-text">
          <strong>{{ site.title || host(site) }}</strong>
          <small>{{ t("第 {version} 版 · {count} 个文件 · {size}", { version: site.current_version, count: site.file_count, size: size_label(site.bytes) }) }}<template v-if="site.status === 'active'"> · {{ t("{time} 到期", { time: expiry_text(site) }) }}</template></small>
        </div>
        <span class="site-card-actions">
          <UButton v-if="site.status === 'active'" :label="t('打开网站')" icon="i-lucide-external-link" size="sm" color="primary" variant="soft" :to="site.url" target="_blank" rel="noopener noreferrer" />
          <UTooltip v-if="site.status === 'active'" :text="copied === site.site_id ? t('已复制') : t('复制链接')"><UButton :icon="copied === site.site_id ? 'i-lucide-check' : 'i-lucide-copy'" size="sm" color="neutral" variant="ghost" :aria-label="t('复制网站地址')" @click="copy(site)" /></UTooltip>
          <UDropdownMenu :items="menu(site)" :content="{ align: 'end' }"><UButton icon="i-lucide-ellipsis" size="sm" color="neutral" variant="ghost" :loading="busy === site.site_id" :aria-label="t('网站操作')" /></UDropdownMenu>
        </span>
      </div>
      <span v-if="site.status === 'active'" class="site-card-life" aria-hidden="true"><i :style="{ width: `${life_left(site)}%` }"></i></span>
    </div>
    </UContextMenu>
  </div>
</template>

<style scoped>
.answer-sites { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 12px; max-width: 100%; }
/* A website as a small browser window: the address bar on top, what it is and what to do with it below. */
.site-card { position: relative; width: min(460px, 100%); border: 1px solid var(--ui-border); border-radius: 12px; background: var(--ui-bg-elevated); overflow: hidden; transition: border-color .15s, box-shadow .15s; }
.site-card:hover { border-color: var(--ui-border-accented); box-shadow: 0 2px 10px color-mix(in srgb, #000 10%, transparent); }
.site-card.is-staged { border-style: dashed; background: transparent; }
.site-card-chrome { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-bottom: 1px solid var(--ui-border-muted); background: color-mix(in srgb, var(--ui-text) 3%, transparent); }
.site-card-dots { display: inline-flex; gap: 4px; flex-shrink: 0; }
.site-card-dots i { width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--ui-text) 18%, transparent); }
.site-card-address { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: var(--ui-bg); color: var(--ui-text-toned); font: 12px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.site-card-address .iconify { flex-shrink: 0; width: 12px; height: 12px; color: var(--ui-success); }
a.site-card-address:hover { color: var(--ui-text-highlighted); }
.site-card-address.is-empty, .site-card-address.is-gone { color: var(--ui-text-dimmed); }
.site-card-address.is-empty .iconify, .site-card-address.is-gone .iconify { color: var(--ui-text-dimmed); }
.site-card-address.is-gone { text-decoration: line-through; }
.site-card-badge { flex-shrink: 0; display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; color: var(--ui-text-muted); background: color-mix(in srgb, var(--ui-text) 7%, transparent); }
.site-card-badge i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.site-card-badge.is-active { color: var(--ui-success); background: color-mix(in srgb, var(--ui-success) 12%, transparent); }
.site-card-badge.is-active i { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-success) 22%, transparent); }
.site-card-badge.is-staged { color: var(--ui-primary); background: color-mix(in srgb, var(--ui-primary) 12%, transparent); }
.site-card-badge.is-taken_down { color: var(--ui-error); background: color-mix(in srgb, var(--ui-error) 12%, transparent); }
.site-card-body { display: flex; align-items: center; gap: 12px; padding: 12px 12px 13px 14px; }
.site-card-text { flex: 1; min-width: 0; display: grid; gap: 3px; }
.site-card-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
.site-card-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--ui-text-muted); }
.site-card.is-soon .site-card-text small { color: var(--ui-warning); }
.site-card-actions { flex-shrink: 0; display: inline-flex; align-items: center; gap: 2px; }
.site-card:not(.is-active):not(.is-staged) .site-card-body { opacity: .7; }
/* How much of the seven-day lifetime is left, as a hairline along the bottom edge (as in the "Published" list). */
.site-card-life { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; }
.site-card-life i { display: block; height: 100%; background: color-mix(in srgb, var(--ui-success) 70%, transparent); }
.site-card.is-soon .site-card-life i { background: var(--ui-warning); }
@media (max-width: 520px) { .site-card-body { flex-wrap: wrap; } .site-card-actions { width: 100%; justify-content: flex-end; } }
</style>

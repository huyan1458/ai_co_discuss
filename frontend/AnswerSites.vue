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
const stages = computed(() => (record.value?.stages || []).filter((stage) => props.executionId && stage.execution_id === props.executionId && !published.value.has(stage.site_id)));
const busy = ref("");
const copied = ref("");

const size_label = (bytes) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const expiry_text = (site) => new Date(site.expires_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const status_text = (site) => ({ active: t("已上线 · {time} 前有效", { time: expiry_text(site) }), expired: t("已过期"), revoked: t("已撤销"), taken_down: t("已被运营方下架") }[site.status] || site.status);
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
    <div v-for="stage in stages" :key="stage.stage_id" class="attachment-file answer-site is-staged">
      <span class="answer-site-icon"><UIcon name="i-lucide-globe" /></span>
      <span class="attachment-name">
        <span>{{ stage.title || stage.directory }}</span>
        <small>{{ t("待部署 · {count} 个文件 · {size}", { count: stage.file_count, size: size_label(stage.bytes) }) }}</small>
      </span>
      <UButton :label="t('部署为网站')" icon="i-lucide-rocket" size="xs" color="primary" variant="soft" @click="deploy_stage(stage)" />
    </div>
    <div v-for="site in sites" :key="site.site_id" class="attachment-file answer-site" :class="`is-${site.status}`">
      <span class="answer-site-icon"><UIcon name="i-lucide-globe" /><i class="answer-site-dot" aria-hidden="true"></i></span>
      <span class="attachment-name">
        <a v-if="site.status === 'active'" :href="site.url" target="_blank" rel="noopener noreferrer" class="answer-site-url">{{ host(site) }}</a>
        <span v-else class="answer-site-url">{{ host(site) }}</span>
        <small>{{ status_text(site) }}</small>
      </span>
      <span class="answer-site-actions">
        <UTooltip v-if="site.status === 'active'" :text="copied === site.site_id ? t('已复制') : t('复制链接')"><UButton :icon="copied === site.site_id ? 'i-lucide-check' : 'i-lucide-copy'" size="xs" color="neutral" variant="ghost" :aria-label="t('复制网站地址')" @click="copy(site)" /></UTooltip>
        <UTooltip v-if="site.status === 'active'" :text="t('在新窗口打开')"><UButton icon="i-lucide-external-link" size="xs" color="neutral" variant="ghost" :aria-label="t('打开网站')" :to="site.url" target="_blank" rel="noopener noreferrer" /></UTooltip>
        <UDropdownMenu :items="menu(site)" :content="{ align: 'end' }"><UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" :loading="busy === site.site_id" :aria-label="t('网站操作')" /></UDropdownMenu>
      </span>
    </div>
  </div>
</template>

<style scoped>
.answer-sites { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 10px; max-width: 100%; }
.answer-site { gap: 10px; padding-right: 8px; }
.answer-site-icon { position: relative; display: inline-flex; font-size: 20px; color: var(--ui-text-muted); }
.answer-site-dot { position: absolute; right: -2px; bottom: -1px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--ui-bg); background: var(--ui-success); }
.answer-site:not(.is-active) .answer-site-dot { background: var(--ui-text-dimmed); }
.answer-site:not(.is-active):not(.is-staged) { opacity: .65; }
.answer-site-url { font-weight: 600; color: var(--ui-text-highlighted); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.answer-site-url:hover { text-decoration: underline; }
.answer-site:not(.is-active):not(.is-staged) .answer-site-url { text-decoration: line-through; }
.answer-site-actions { display: inline-flex; align-items: center; gap: 2px; }
.answer-site .attachment-name small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

<script setup>
/**
 * "加入群" (Fable #16041, user #16110): put MOSS in a chat group in two steps of one dialog. Step 1 picks a group MOSS's
 * account is already in (searchable, refreshable, groups already on marked); step 2 shows the group's settings with
 * their defaults (the same `MossGroupFields` as a group's own settings), whether the owner is in that group, and an
 * unticked "say a word of introduction". Emits `confirm` with `{channel, group, settings, introduce}` and closes; the
 * caller turns the group on and shows its card at once. Emits `notify-settings` when a chat channel has to be bound first.
 */
import { computed, inject, ref, watch } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import HelpTip from "./HelpTip.vue";
import MossGroupFields from "./MossGroupFields.vue";
import { window_changes } from "./moss.js";
import { t } from "./i18n.js";

const open = defineModel("open", { type: Boolean, default: false });
const emit = defineEmits(["confirm", "notify-settings"]);
const { view, bridge } = inject("discussion");
const SKELETON_ROWS = 3;

const step = ref(1);
const channels = ref(null);
const groups = ref(null);
const load_error = ref("");
const query = ref("");
const chosen = ref(null);
const draft = ref({});
const introduce = ref(false);
const steward = ref(null);

const group_channels = computed(() => (channels.value || []).filter((item) => item.capabilities?.groups));
const bound_channels = computed(() => group_channels.value.filter((item) => item.ready));
// MOSS's own account on the channel, so the owner knows whom to pull into the group (`account_id` from the computer).
const account = computed(() => bound_channels.value.map((item) => item.account_id).find(Boolean) || "");
const scheduler_ready = computed(() => {
  const scheduler = view.value.launch.scheduler || {};
  return Boolean(scheduler.enabled && scheduler.provider && scheduler.model && scheduler.api_key_ref);
});
const adapter = computed(() => steward.value?.settings?.adapter || "");
const platform = computed(() => adapter_profile(adapter.value)?.platform || (adapter.value ? bridge.platform_of(adapter.value) : ""));

/** Read the channels and every group MOSS's account is in; `refresh` asks the channel again. */
async function load() {
  load_error.value = "";
  groups.value = null;
  try {
    const [notify, status] = await Promise.all([bridge.local_request("notify", {}), steward.value ? Promise.resolve(steward.value) : bridge.local_request("steward", {})]);
    channels.value = notify.channels || [];
    steward.value = status;
    const lists = await Promise.all(bound_channels.value.map(async (channel) => ((await bridge.local_request("notify", { channel: channel.id, action: "groups" })).groups || [])
      .map((group) => ({ ...group, channel: channel.id, channel_label: channel.label }))));
    groups.value = lists.flat();
  } catch (error) { load_error.value = error.message; groups.value = []; }
}
watch(open, (value) => {
  if (!value) return;
  step.value = 1; chosen.value = null; query.value = ""; introduce.value = false; draft.value = {};
  load();
}, { immediate: true });

const shown = computed(() => {
  const text = query.value.trim().toLowerCase();
  return (groups.value || []).filter((group) => !text || `${group.title || ""} ${group.id}`.toLowerCase().includes(text));
});
function choose(group) {
  if (group.enabled) return;
  chosen.value = group;
  draft.value = {};
  step.value = 2;
}
function confirm() {
  const group = chosen.value;
  if (!group) return;
  emit("confirm", { channel: group.channel, group, settings: window_changes(draft.value, {}), introduce: introduce.value });
  open.value = false;
}
function set_draft(patch) {
  const next = { ...draft.value, ...patch };
  for (const [field, value] of Object.entries(next)) if (value === "" || value == null) delete next[field];
  draft.value = next;
}
</script>

<template>
  <UModal v-model:open="open" :title="step === 1 ? t('加入群') : t('MOSS 在「{name}」里能做什么', { name: chosen?.title || chosen?.id || '' })"
    :ui="{ content: 'glass-panel studio-modal moss-settings-modal moss-join-modal', body: 'dialog-body' }">
    <template #body>
      <div class="moss-join">
        <template v-if="step === 1">
          <!-- What has to happen in QQ first, and the other way in: both always on top, the list below never moves. -->
          <div class="moss-join-howto">
            <p>{{ account ? t("先在 QQ 里把 MOSS 的号 {id} 拉进群，它在群里才收得到消息。", { id: account }) : t("先在 QQ 里把 MOSS 的号拉进群，它在群里才收得到消息。") }}</p>
            <p>{{ t("也可以在群里 @MOSS 说“开始工作”，用默认设置开启；说“停止工作”就停下。只认你本人的账号。") }}</p>
          </div>
          <template v-if="channels && !bound_channels.length">
            <p class="moss-join-empty">{{ group_channels.length ? t("还没有绑定 QQ 个人号，绑定后才能选群。") : t("还没有能进群的聊天渠道；目前只有 QQ 个人号（OneBot）可以。") }}</p>
            <UButton class="justify-self-start" icon="i-lucide-settings" :label="t('去绑定聊天渠道')" @click="open = false; emit('notify-settings')" />
          </template>
          <template v-else>
            <div class="moss-join-search">
              <UInput v-model="query" icon="i-lucide-search" size="sm" class="grow" :placeholder="t('搜索群名或群号')" :aria-label="t('搜索群名或群号')" />
              <UButton icon="i-lucide-refresh-cw" size="sm" color="neutral" variant="soft" :label="t('刷新')" :loading="channels !== null && groups === null" @click="load" />
            </div>
            <ul class="moss-join-groups" :aria-busy="groups === null || undefined">
              <template v-if="groups === null"><li v-for="row in SKELETON_ROWS" :key="row" class="moss-join-group" aria-hidden="true"><USkeleton class="h-4 w-44" /></li></template>
              <template v-else>
                <li v-for="group in shown" :key="`${group.channel}:${group.id}`">
                  <button type="button" class="moss-join-group" :disabled="group.enabled" :title="group.enabled ? t('已开启；在左侧窗口列表里查看') : undefined" @click="choose(group)">
                    <UIcon name="i-lucide-users" />
                    <span class="moss-join-title">{{ group.title || group.id }}</span>
                    <small class="moss-join-id">{{ group.id }}</small>
                    <small v-if="group.enabled" class="moss-join-on">{{ t("已开启") }}</small>
                    <UIcon v-else name="i-lucide-chevron-right" class="moss-join-next" />
                  </button>
                </li>
                <li v-if="load_error" class="moss-join-empty is-error">{{ t("读不到群列表：{error}", { error: load_error }) }}</li>
                <li v-else-if="!shown.length" class="moss-join-empty">{{ query.trim() ? t("没有名字或群号里带“{text}”的群。", { text: query.trim() }) : t("MOSS 的号还不在任何群里。") }}
                  {{ t("找不到想要的群：先在 QQ 里把它拉进群，再点刷新。") }}</li>
              </template>
            </ul>
          </template>
        </template>
        <template v-else-if="chosen">
          <p class="moss-join-note">{{ scheduler_ready ? t("它会自己判断哪些话是对它说的，其余只记下不回应。") : t("没有配置智能调度：只有 @ 它时才会回应。") }}</p>
          <p v-if="chosen.owner_in_group === false" class="moss-join-note is-warn">{{ t("你自己的 QQ 号不在这个群里：拿不准的事没法在群里问你，会改发到私聊。") }}</p>
          <MossGroupFields :value="draft" :adapter="adapter" :platform="platform" :skills="steward?.group_skills || []" @update="set_draft" />
          <UCheckbox v-model="introduce" :label="t('进群后说一句自我介绍')" :description="t('不勾时它安静地开始听，有人对它说话才回应。')" />
        </template>
        <div v-if="step === 2" class="moss-join-actions">
          <UButton icon="i-lucide-check" :label="t('开启')" @click="confirm" />
          <UButton color="neutral" variant="ghost" :label="t('上一步')" @click="step = 1" />
          <HelpTip :text="t('之后点这个群的卡片，在右栏“设置”里随时可改，下一条消息起生效。')" />
        </div>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.moss-join { display: grid; gap: 12px; min-width: 0; }
.moss-join-howto { display: grid; gap: 4px; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--ui-text) 4%, transparent); color: var(--ui-text-toned); font-size: 13px; line-height: 1.6; }
.moss-join-howto > p { margin: 0; }
.moss-join-howto > p + p { color: var(--ui-text-muted); font-size: 12px; }
.moss-join-search { display: flex; gap: 8px; }
/* As tall as its groups, up to a scrolling limit: no empty box for a short list (#16043). Nothing sits below it in step 1
   (the dialog closes from its header), so a list that grows when it loads moves nothing. */
.moss-join-groups { display: grid; align-content: start; gap: 2px; max-height: min(320px, 46dvh); margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.moss-join-group { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 0 10px; border-radius: 8px; text-align: left; font-size: 13px; }
@media (hover: hover) { .moss-join-group:not(:disabled):hover { background: color-mix(in srgb, var(--ui-bg-accented) 60%, transparent); } }
.moss-join-group:disabled { opacity: .6; cursor: default; }
.moss-join-group > :deep(svg) { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.moss-join-title { min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); text-overflow: ellipsis; white-space: nowrap; }
.moss-join-id { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-dimmed); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.moss-join-on { flex-shrink: 0; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-success) 16%, transparent); color: var(--ui-success); font-size: 12px; }
.moss-join-empty { margin: 0; padding: 8px 10px; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; }
.moss-join-empty.is-error { color: var(--ui-warning); }
.moss-join-note { margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; }
.moss-join-note.is-warn { color: var(--ui-warning); }
.moss-join-actions { display: flex; align-items: center; gap: 8px; }
</style>

<script setup>
/**
 * MOSS settings' 聊天窗口 (#15906, `.dev/plans/MOSS对外窗口/` §8.1): the private chat's way of talking, the groups' default,
 * and, under each bound channel that can join groups, one row per group the account is in. A group's switch takes effect
 * at once (`launch notify` group-enable / group-disable, rolled back with a notice when the computer refuses); everything
 * else is part of the dialog's draft (`habits`, `windows`) and waits for 保存 like the rest of MOSS's settings.
 *
 * Props: `adapter` and `platform`, MOSS's software (its model list for a group's model and strength); v-model `habits`
 * (`{private, group}`) and `windows` (`{"<channel>:<chat_id>": {habit, about, work_policy, daily_limit, model, effort}}`).
 */
import { computed, inject, onMounted, reactive, ref } from "vue";
import HelpTip from "./HelpTip.vue";
import MossGroupFields from "./MossGroupFields.vue";
import { t } from "./i18n.js";

const props = defineProps({ adapter: { type: String, default: "" }, platform: { type: String, default: "" }, habits: { type: Object, default: null }, windows: { type: Object, default: null },
  skills: { type: Array, default: () => [] } });
const emit = defineEmits(["update:habits", "update:windows"]);
const { view, bridge } = inject("discussion");

const HABIT_LIMIT = 500;
const DEFAULT_DAILY_LIMIT = 30;
const SKELETON_ROWS = 2;

// Channels that can join groups, as `launch notify` lists them; an older computer lists none that can.
const channels = ref(null);
const groups = reactive({});
const opened = reactive(new Set());
// Switches the user just flipped: shown at once, cleared when the computer confirms, put back when it refuses.
const switching = reactive({});
const group_channels = computed(() => (channels.value || []).filter((item) => item.capabilities?.groups));
const scheduler_ready = computed(() => {
  const scheduler = view.value.launch.scheduler || {};
  return Boolean(scheduler.enabled && scheduler.provider && scheduler.model && scheduler.api_key_ref);
});

/**
 * Why a channel's switches are off; empty when they can be used. Any software may join a group, read-only (§12.6, which
 * replaced the earlier `confines_reads` requirement); each group's settings say whether it can be kept from other files.
 */
function blocker(channel) {
  return channel.ready ? "" : t("{channel} 还没有绑定你的账号，先在“通知”里完成绑定。", { channel: channel.label });
}

async function load_groups(channel) {
  groups[channel.id] = { loading: true, items: groups[channel.id]?.items || null, error: "" };
  try {
    const result = await bridge.local_request("notify", { channel: channel.id, action: "groups" });
    groups[channel.id] = { loading: false, items: result.groups || [], error: "" };
  } catch (error) { groups[channel.id] = { loading: false, items: null, error: error.message }; }
}

onMounted(async () => {
  try { channels.value = (await bridge.local_request("notify", {})).channels || []; }
  catch { channels.value = []; }
  for (const channel of group_channels.value) if (channel.ready) load_groups(channel);
});

const key_of = (channel, group) => `${channel.id}:${group.id}`;
const enabled = (channel, group) => switching[key_of(channel, group)] ?? Boolean(group.enabled);

/** Show the new state at once; the computer creates or pauses the group's window, and a refusal puts the switch back. */
async function toggle(channel, group, on) {
  const key = key_of(channel, group);
  switching[key] = on;
  try {
    // Turning a group on carries what was already filled in for it, so the first run uses it (#16072).
    const drafted = on ? window_of(key) : {};
    const result = await bridge.local_request("notify", { channel: channel.id, action: on ? "group-enable" : "group-disable", chat_id: group.id, ...(Object.keys(drafted).length ? { settings: drafted } : {}) });
    const items = groups[channel.id]?.items || [];
    groups[channel.id] = { ...groups[channel.id], items: items.map((item) => item.id === group.id ? { ...item, enabled: on, ...(result?.group || {}) } : item) };
    if (on) opened.add(key);
  } catch (error) { const name = group.title || group.id;
    bridge.notify("error", on ? t("没能让 MOSS 进入「{name}」：{error}", { name, error: error.message }) : t("没能关闭「{name}」：{error}", { name, error: error.message }));
  }
  finally { delete switching[key]; }
}

// A question MOSS put to the owner in the group and still waits on (`pending_owner`, #15985): until it is answered the
// group cannot ask the owner again, so the owner may clear it here. Cleared at once on the page, put back if refused.
const cleared = reactive(new Set());
const waiting = (channel, group) => Boolean(group.pending_owner) && !cleared.has(key_of(channel, group));
async function clear_pending(channel, group) {
  const key = key_of(channel, group);
  if (cleared.has(key)) return;
  cleared.add(key);
  try {
    const result = await bridge.local_request("notify", { channel: channel.id, action: "group-clear-pending", chat_id: group.id });
    const pending_owner = result?.group ? Boolean(result.group.pending_owner) : false;
    const items = groups[channel.id]?.items || [];
    groups[channel.id] = { ...groups[channel.id], items: items.map((item) => item.id === group.id ? { ...item, pending_owner } : item) };
  } catch (error) { bridge.notify("error", t("没能清除「{name}」的待答问题：{error}", { name: group.title || group.id, error: error.message })); }
  finally { cleared.delete(key); }
}

const habits_value = computed(() => props.habits || {});
const window_of = (key) => props.windows?.[key] || {};
function set_habit(which, value) {
  const next = { ...habits_value.value, [which]: value };
  if (!value) delete next[which];
  emit("update:habits", next);
}
/** One field of one group's settings; a field put back to its default is dropped, so an untouched group saves nothing. */
function set_window(key, patch) {
  const next = { ...window_of(key), ...patch };
  for (const [field, value] of Object.entries(next)) if (value === "" || value == null) delete next[field];
  const windows = { ...(props.windows || {}) };
  if (Object.keys(next).length) windows[key] = next; else delete windows[key];
  emit("update:windows", windows);
}
const daily_limit = (key) => window_of(key).daily_limit ?? DEFAULT_DAILY_LIMIT;
const failure_text = (group) => typeof group.last_failure === "string" ? group.last_failure : group.last_failure?.reason || "";
</script>

<template>
  <section class="steward-group moss-windows-settings">
    <h4>{{ t("聊天窗口") }}<HelpTip :text="t('MOSS 在哪个聊天里说话，就有一个对应的窗口：各有自己的记录和说话方式。')" /></h4>
    <div class="moss-window-block">
      <strong>{{ t("私聊") }}</strong>
      <p class="fine-print">{{ t("你在各聊天渠道里和 MOSS 的私聊，都汇到“私聊”窗口；它和主理人的对话、记忆互不相通。") }}</p>
      <UFormField :label="t('私聊的说话方式')">
        <UTextarea :model-value="habits_value.private || ''" :maxlength="HABIT_LIMIT" :rows="2" autoresize :maxrows="6" class="w-full"
          :placeholder="t('留空沿用 MOSS 现在的说话方式')" @update:model-value="set_habit('private', $event)" />
      </UFormField>
    </div>
    <div class="moss-window-block">
      <strong>{{ t("群") }}</strong>
      <UFormField :label="t('群的默认说话方式')" :description="t('单个群没写时用这里的。')">
        <UTextarea :model-value="habits_value.group || ''" :maxlength="HABIT_LIMIT" :rows="2" autoresize :maxrows="6" class="w-full"
          :placeholder="t('简短、口语、不用 Markdown，只回答问题和查资料')" @update:model-value="set_habit('group', $event)" />
      </UFormField>
      <template v-if="channels">
        <p v-if="!group_channels.length" class="fine-print">{{ t("已连接的渠道都不能进群；目前只有 QQ 个人号（OneBot）可以。") }}</p>
        <div v-for="channel in group_channels" :key="channel.id" class="moss-window-channel">
          <div class="moss-window-channel-head"><strong>{{ channel.label }}</strong>
            <HelpTip :text="t('个人号走非官方协议，进群后账号被限制的风险比私聊更高。')" /></div>
          <!-- Fixed notes above the rows, so the rows do not move when a channel or the software changes. -->
          <p class="moss-window-note" :class="{ 'is-blocked': blocker(channel) }">{{ blocker(channel) || (scheduler_ready ? t("开启后，这个群的每条消息都会调用一次决策模型。") : t("未配置智能调度：只有 @ MOSS 时它才会被叫到。")) }}</p>
          <ul class="moss-window-rows" :aria-busy="groups[channel.id]?.loading || undefined">
            <li v-if="!channel.ready" class="moss-window-empty">{{ t("绑定后在这里列出这个账号所在的群。") }}</li>
            <li v-else-if="groups[channel.id]?.error" class="moss-window-empty is-error">{{ t("读不到群列表：{error}", { error: groups[channel.id].error }) }}
              <UButton :label="t('重试')" size="xs" color="neutral" variant="link" @click="load_groups(channel)" /></li>
              <template v-else-if="groups[channel.id]?.items">
                <li v-for="group in groups[channel.id].items" :key="group.id" :class="{ 'is-open': opened.has(key_of(channel, group)) }">
                  <div class="moss-window-row">
                    <button type="button" class="moss-window-toggle" :aria-expanded="opened.has(key_of(channel, group))" @click="opened.has(key_of(channel, group)) ? opened.delete(key_of(channel, group)) : opened.add(key_of(channel, group))">
                      <UIcon :name="opened.has(key_of(channel, group)) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
                      <span class="moss-window-title" :title="group.title || group.id">{{ group.title || group.id }}</span>
                      <small v-if="failure_text(group)" class="moss-window-failed" :title="failure_text(group)"><UIcon name="i-lucide-circle-alert" />{{ t("失败") }}</small>
                      <!-- Only while a question waits; the name gives way to it, the usage and switch stay at the end (#16043). -->
                      <small v-if="waiting(channel, group)" class="moss-window-waiting">{{ t("在等你答复") }}</small>
                      <small class="moss-window-usage">{{ t("今天 {used}/{limit}", { used: group.used_today ?? 0, limit: daily_limit(key_of(channel, group)) }) }}</small>
                    </button>
                    <USwitch :model-value="enabled(channel, group)" :disabled="Boolean(blocker(channel)) && !enabled(channel, group)" :aria-label="t('让 MOSS 进入「{name}」', { name: group.title || group.id })" @update:model-value="toggle(channel, group, $event)" />
                  </div>
                  <div v-if="opened.has(key_of(channel, group))" class="moss-window-detail">
                    <p v-if="failure_text(group)" class="moss-window-note is-blocked">{{ t("最近一次失败：{reason}", { reason: failure_text(group) }) }}</p>
                    <!-- A notice only while a question waits, with 清除; nothing is kept for it otherwise (#16043). -->
                    <div v-if="waiting(channel, group)" class="moss-window-pending" role="status">
                      <span>{{ t("MOSS 在群里问了你一个问题，还没收到你的答复；答复前这个群不能再问你。") }}</span>
                      <UButton :label="t('清除')" size="xs" color="neutral" variant="soft"
                        :title="t('不再等这个答复：原来那件事不做，之后 MOSS 可以再问你')" @click="clear_pending(channel, group)" />
                    </div>
                    <MossGroupFields :value="window_of(key_of(channel, group))" :used-today="group.used_today ?? 0" :tasks-today="group.tasks_used_today ?? 0"
                      :adapter="adapter" :platform="platform" :skills="skills" @update="set_window(key_of(channel, group), $event)" />
                  </div>
                </li>
                <li v-if="!groups[channel.id].items.length" class="moss-window-empty">{{ t("这个账号还没有加入任何群。") }}</li>
              </template>
              <template v-else><li v-for="row in SKELETON_ROWS" :key="`skeleton-${row}`" class="moss-window-row" aria-hidden="true"><USkeleton class="h-3.5 w-40" /><USkeleton class="h-5 w-9 rounded-full" /></li></template>
          </ul>
        </div>
      </template>
      <USkeleton v-else class="h-16 w-full" />
    </div>
  </section>
</template>

<style scoped>
.moss-windows-settings { gap: 12px; }
.moss-window-block { display: grid; gap: 8px; min-width: 0; padding: 10px 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; }
.moss-window-block > strong { color: var(--ui-text-highlighted); font-size: 13px; }
.moss-window-block > .fine-print { margin: -4px 0 0; }
.moss-window-channel { display: grid; gap: 6px; min-width: 0; margin-top: 4px; }
.moss-window-channel-head { display: flex; align-items: center; color: var(--ui-text-highlighted); font-size: 13px; }
.moss-window-note { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.55; }
.moss-window-note.is-blocked { color: var(--ui-warning); }
.moss-window-rows { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.moss-window-rows > li { min-width: 0; border-radius: 8px; }
.moss-window-rows > li.is-open { background: color-mix(in srgb, var(--ui-text) 3%, transparent); }
/* Every row the same height, loading or loaded, so the list does not jump when the groups arrive. */
.moss-window-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 36px; padding: 0 6px 0 2px; }
.moss-window-toggle { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; min-height: 32px; padding: 0 4px; border-radius: 6px; text-align: left; font-size: 13px; }
@media (hover: hover) { .moss-window-toggle:hover { background: color-mix(in srgb, var(--ui-bg-accented) 60%, transparent); } }
.moss-window-toggle > :deep(svg) { flex-shrink: 0; width: 14px; height: 14px; color: var(--ui-text-dimmed); }
.moss-window-title { flex: 1; min-width: 0; overflow: hidden; color: var(--ui-text-toned); text-overflow: ellipsis; white-space: nowrap; }
.moss-window-usage { flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 12px; font-variant-numeric: tabular-nums; }
.moss-window-waiting { flex-shrink: 0; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-warning) 16%, transparent); color: var(--ui-warning); font-size: 12px; }
.moss-window-pending { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--ui-warning) 12%, transparent); color: var(--ui-text-toned); font-size: 12px; line-height: 1.5; }
.moss-window-pending > button { flex-shrink: 0; }
.moss-window-failed { display: inline-flex; flex-shrink: 0; align-items: center; gap: 3px; color: var(--ui-warning); font-size: 12px; }
.moss-window-detail { display: grid; gap: 10px; padding: 4px 10px 12px 26px; }
.moss-window-empty { display: flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 6px; color: var(--ui-text-muted); font-size: 12px; }
.moss-window-empty.is-error { color: var(--ui-warning); }
@media (max-width: 560px) { .moss-window-detail { padding-left: 10px; } }
</style>

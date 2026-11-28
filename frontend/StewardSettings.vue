<script setup>
import { computed, inject, onMounted, reactive, ref } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { access_options } from "../runner/expert_prompts.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import HelpTip from "./HelpTip.vue";
import ModelEffortPicker from "./ModelEffortPicker.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import RosterAdd from "./RosterAdd.vue";
import { locale, t } from "./i18n.js";

/**
 * MOSS's settings: the first choice of software (`choosing`, a page of its own), and otherwise the dialog opened from
 * MOSS's rail. Every change in the dialog waits for 保存 and is applied together, so nothing here takes effect unseen (#15598).
 */
const { view, bridge } = inject("discussion");
const props = defineProps({ choosing: Boolean, changeSoftware: Boolean });
const emit = defineEmits(["done"]);
const saved = ref(null);
const draft = ref({});
const skills = ref([]);
const saving = ref(false);
const changing_software = ref(props.changeSoftware);
const switch_confirm = ref(false);
const history = ref(null);
const history_target = ref(null);
const deleting_history = reactive(new Set());
const deleted_history = new Set();
let history_read = 0;
const visible_history = computed(() => history.value?.filter(room => !deleting_history.has(room.room_id)));
const adapters = computed(() => {
  const result = new Map();
  for (const [platform, { adapter }] of Object.entries(view.value.launch.saved_profiles || {})) {
    const software = adapter_profile(adapter);
    if (!software || result.has(adapter)) continue;
    const name = software.platform || bridge.platform_of(platform);
    result.set(adapter, { ...bridge.identities[name], platform: name, value: adapter, name: software.platform ? t(software.label) : bridge.default_name(name) });
  }
  return result;
});
const candidates = computed(() => [...adapters.value.values()].map(item => ({ ...item, selected: item.value === draft.value.adapter })));
const card_platform = computed(() => adapters.value.get(draft.value.adapter)?.platform || adapter_profile(draft.value.adapter)?.platform);
// Choosing MOSS's software is one pick, not adding members (#15658): a single-choice row in the new-room chips' look, then a
// card with the software and its model; model and effort stay at the software's defaults unless 高级 is opened.
const chosen = computed(() => adapters.value.get(draft.value.adapter) || null);
// The profile the model list is read with: this computer's software settings for the platform, with MOSS's own choice
// over them, as the expert card reads a preset's (choosing other software clears model and strength back to its defaults).
const moss_profile = computed(() => ({ ...(view.value.launch.profiles?.[card_platform.value] || {}), adapter: draft.value.adapter, model: draft.value.model || "", effort: draft.value.effort || "" }));
// Project access is no first-run question: read-only by default, raised when an install or deploy asks for it. The
// settings dialog keeps one control for those who set it by hand.
const access_items = computed(() => access_options(draft.value.adapter, bridge.full_only_hint(draft.value.adapter)).filter((item) => !item.disabled));
const changed = computed(() => saved.value ? Object.fromEntries(Object.entries(draft.value)
  .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(saved.value[key]))) : {});

// Who joins a room MOSS creates: kept in the computer's new-room preferences (`members`, `host`); with none the runner takes
// the first configured AI (#15335). Edited here as a draft like the rest.
const spawn_saved = computed(() => {
  const preferences = view.value.launch.create_preferences || {};
  const members = preferences.members || [];
  return { members, host: members.includes(preferences.host) ? preferences.host : members[0] || "" };
});
const spawn = ref(null);
const spawn_draft = computed(() => spawn.value || spawn_saved.value);
const spawn_changed = computed(() => Boolean(spawn.value) && JSON.stringify(spawn.value) !== JSON.stringify(spawn_saved.value));
const spawn_library = computed(() => Object.keys(bridge.identities).filter((name) => name !== "用户" && bridge.launch_clients[name] && bridge.platform_configured(name))
  .map((name) => ({ value: name, name: bridge.default_name(name), ...bridge.identities[name], aria_label: t("添加 {name} 实例", { name }) })));
const spawn_fallback = computed(() => spawn_library.value[0]?.name || "");

/** Add one more instance of a platform, named as the new-room panel names them (Claude, Claude-2, …). */
function add_spawn_member(platform) {
  const { members, host } = spawn_draft.value;
  let name = platform;
  for (let index = 2; members.includes(name); index++) name = `${platform}-${index}`;
  spawn.value = { members: [...members, name], host: host || name };
}
function remove_spawn_member(name) {
  const members = spawn_draft.value.members.filter((item) => item !== name);
  const host = spawn_draft.value.host === name ? members[0] || "" : spawn_draft.value.host;
  spawn.value = { members, host };
}

// Proactive reports (#15355), off by default. The lists (duties MOSS records, muted reminders) are not part of the
// settings object the form saves; removing an item marks it here and 保存 removes it on the computer.
const PROACTIVE_DEFAULTS = { enabled: false, active_hours: { start: "09:00", end: "22:00" }, digest_at: "21:00" };
const duties = ref([]);
const mutes = ref([]);
const dropped_duties = reactive(new Set());
const dropped_mutes = reactive(new Set());
function split_proactive(settings) {
  const proactive = settings.proactive || {};
  duties.value = proactive.duties || [];
  mutes.value = proactive.mutes || [];
  return { ...settings, proactive: { enabled: proactive.enabled === true, active_hours: { ...PROACTIVE_DEFAULTS.active_hours, ...proactive.active_hours },
    digest_at: proactive.digest_at || PROACTIVE_DEFAULTS.digest_at } };
}
function set_proactive(patch) { draft.value = { ...draft.value, proactive: { ...draft.value.proactive, ...patch } }; }
function set_hours(edge, value) { if (value) set_proactive({ active_hours: { ...draft.value.proactive.active_hours, [edge]: value } }); }
const shown_duties = computed(() => duties.value.filter((item) => !dropped_duties.has(item.id)));
const shown_mutes = computed(() => mutes.value.filter((item) => !dropped_mutes.has(item.id)));

const dirty = computed(() => Object.keys(changed.value).length > 0 || spawn_changed.value || dropped_duties.size > 0 || dropped_mutes.size > 0);

const skill_labels = {
  "dispatch-analysis": t("派活分析"),
  "share-card": t("AI 制作分享卡"),
  "local-tts-setup": t("安装本机朗读"),
  "local-stt-setup": t("安装本机语音输入"),
  "notify-setup": t("配置通知渠道"),
  "discuss-report": t("整理讨论报告"),
  "codiscuss-draft-cleanup": t("共议占用盘点与清理"),
  "cloudflare-deploy": t("部署线上站点"),
  "codiscuss-help": t("使用帮助与排障"),
  "rooms-overview": t("房间总览"),
};

/** Load this computer's archived MOSS conversations without blocking settings. */
async function load_history() {
  const reading = ++history_read;
  try {
    const { rooms } = await bridge.local_request("steward-history", {});
    if (reading === history_read) history.value = rooms.filter(room => !deleted_history.has(room.room_id));
  } catch (error) { if (reading === history_read) bridge.notify("error", error.message); }
}

function history_label(room) {
  const adapter = adapter_profile(room.adapter);
  const date = room.archived_at ? new Date(room.archived_at).toLocaleString(locale) : "";
  return [adapter ? t(adapter.label) : room.adapter, date, room.room_id].filter(Boolean).join(" · ");
}

async function open_history_room(room_id) {
  try { await bridge.show_steward_room(room_id); emit("done"); }
  catch (error) { bridge.notify("error", error.message); }
}

/** Hide only the chosen room until the computer confirms deletion, then remove it from the snapshot. */
async function delete_history_room() {
  const room_id = history_target.value?.room_id;
  if (!room_id || deleting_history.has(room_id)) return;
  deleting_history.add(room_id);
  try {
    await bridge.local_request("steward-delete", { room_id });
    deleted_history.add(room_id);
    history.value = history.value?.filter(room => room.room_id !== room_id) ?? null;
  } catch (error) { bridge.notify("error", error.message); }
  finally { deleting_history.delete(room_id); }
}

/** Show server defaults until the user changes a field. Only edited fields are saved. */
async function load() {
  try {
    const status = await bridge.local_request("steward", {});
    saved.value = split_proactive({ ...status.settings, ...(status.configured === false ? { adapter: "" } : {}) });
    draft.value = { ...saved.value };
    skills.value = status.skills;
  } catch (error) { bridge.notify("error", error.message); }
}
onMounted(() => { load(); if (!props.choosing) load_history(); });

function choose_adapter(adapter) {
  if (adapter === draft.value.adapter) return;
  draft.value = { ...draft.value, adapter, model: "", effort: "" };
  const supported = access_options(adapter, bridge.full_only_hint(adapter)).filter(item => !item.disabled);
  if (!supported.some(item => item.value === draft.value.project_access)) draft.value.project_access = supported[0]?.value || "auto";
}

function submit() {
  if (!draft.value.adapter || saving.value) return;
  const previous = saved.value?.adapter;
  if (previous && previous !== draft.value.adapter && adapters.value.get(previous)?.platform !== card_platform.value) {
    switch_confirm.value = true;
  } else save();
}

function allow_skill(id, allowed) {
  const selected = new Set(draft.value.skills);
  if (allowed) selected.add(id); else selected.delete(id);
  draft.value.skills = skills.value.map(skill => skill.id).filter(id => selected.has(id));
}

/** Remove the marked list items on the computer; one that fails comes back with the reason. */
async function remove_marked(marked, list, action) {
  for (const id of [...marked]) {
    try {
      await bridge.local_request(action, { action: "remove", id });
      list.value = list.value.filter((item) => item.id !== id);
    } catch (error) { bridge.notify("error", error.message); }
    marked.delete(id);
  }
}

/** Apply everything changed in the dialog at once: settings, who joins MOSS's rooms, removed duties and mutes. */
async function save() {
  if (saving.value) return;
  const patch = changed.value;
  const proposed = spawn.value;
  const roster = spawn_changed.value ? { members: proposed.members, host: proposed.host || "" } : null;
  saving.value = true;
  try {
    let busy = false;
    if (Object.keys(patch).length || roster) {
      const status = await bridge.local_request("steward-settings", roster ? { ...patch, create_preferences: roster } : patch);
      const settings = split_proactive(status.settings);
      for (const key of Object.keys(settings)) {
        if (JSON.stringify(draft.value[key]) === JSON.stringify(patch[key] ?? saved.value[key])) draft.value[key] = settings[key];
      }
      saved.value = settings;
      skills.value = status.skills;
      busy = Boolean(status.busy);
      if (Object.hasOwn(patch, "skills")) document.dispatchEvent(new Event("discuss:steward-skills-changed"));
    }
    if (roster) {
      bridge.write_create_preferences(roster, { persisted: true });
      if (spawn.value === proposed) spawn.value = null;
    }
    await remove_marked(dropped_duties, duties, "steward-duty");
    await remove_marked(dropped_mutes, mutes, "steward-mute");
    changing_software.value = false;
    // A software change waits while MOSS is at work; the computer says so and the new software takes over once it is idle.
    if (busy) bridge.notify("warning", t("MOSS 正在工作，换软件会在它空闲后生效"));
    else if (!props.choosing) bridge.notify("info", t("已保存"));
    if (props.choosing || Object.hasOwn(patch, "adapter")) await bridge.open_steward();
    emit("done", saved.value);
  } catch (error) { bridge.notify("error", error.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <section class="steward-settings">
    <div class="steward-settings-body" :class="{ 'is-choosing': choosing }">
    <form v-if="saved" class="steward-settings-form" @submit.prevent="submit">
      <section class="steward-group">
        <h4 v-if="!choosing">{{ t("软件") }}</h4>
        <div v-if="(choosing || changing_software) && candidates.length" class="steward-software-choices" role="radiogroup" :aria-label="t('选择 MOSS 软件')">
          <button v-for="item in candidates" :key="item.value" type="button" role="radio" :aria-checked="item.selected" :class="{ 'is-selected': item.selected }" @click="choose_adapter(item.value)">
            <UAvatar :src="item.icon" :text="item.initials" size="2xs" class="channel-avatar" :class="item.style" /><span>{{ item.name }}</span>
          </button>
        </div>
        <p v-else-if="choosing && view.launch.available" class="fine-print">{{ t("这台电脑还没有配置可用的 AI 软件。") }}</p>
        <div v-if="chosen" class="steward-software-card">
          <div class="steward-software-name"><UAvatar :src="chosen.icon" :text="chosen.initials" size="sm" class="channel-avatar" :class="chosen.style" /><strong>{{ chosen.name }}</strong></div>
          <!-- The expert card's own model list, refresh and strength (#15717): one way to choose a model across the site. -->
          <ModelEffortPicker v-if="card_platform" :key="draft.adapter" :name="card_platform" :profile="moss_profile" portable
            @model="draft = { ...draft, model: $event === '__default__' ? '' : String($event || '').trim(), effort: '' }"
            @effort="draft = { ...draft, effort: $event }" @reset="draft = { ...draft, model: '', effort: '' }" />
        </div>
        <p v-if="choosing && candidates.length && !draft.adapter" class="steward-software-hint">{{ t("先选一个软件") }}</p>
        <UButton v-if="!choosing && !changing_software" class="justify-self-start" icon="i-lucide-arrow-left-right" :label="t('更换软件')" size="xs" color="neutral" variant="soft" @click="changing_software = true" />
      </section>
      <section v-if="!choosing && access_items.length > 1" class="steward-group">
        <h4>{{ t("项目权限") }}<HelpTip :text="t('默认只读；要运行命令时会先问你是否调高。')" /></h4>
        <div class="steward-access" role="radiogroup" :aria-label="t('项目权限')">
          <button v-for="item in access_items" :key="item.value" type="button" role="radio" :aria-checked="draft.project_access === item.value" :class="{ 'is-selected': draft.project_access === item.value }"
            :title="item.hint ? t(item.hint) : undefined" @click="draft = { ...draft, project_access: item.value }">{{ t(item.label) }}</button>
        </div>
      </section>
      <template v-if="!choosing">
        <section class="steward-group">
          <h4>{{ t("工作目录") }}</h4>
          <ProjectDirectoryField v-model="draft.cwd" compact />
        </section>
        <section class="steward-group">
          <h4>{{ t("新建房间") }}<HelpTip :text="t('关闭后 MOSS 不能建房，也不能给其他房间传话。')" /></h4>
          <!-- On unless the user turned it off: an older computer that does not send the setting yet reads as on. -->
          <USwitch :model-value="draft.create_rooms !== false" :label="t('允许 MOSS 新建房间')" @update:model-value="draft = { ...draft, create_rooms: $event }" />
          <template v-if="draft.create_rooms !== false">
            <span class="steward-label">{{ t("MOSS 建房时的成员") }}<HelpTip :text="t('新房间用本机保存的默认模型与强度，项目权限最高为可写。')" /></span>
            <ul v-if="spawn_draft.members.length" class="steward-spawn-members" :aria-label="t('MOSS 建房时的成员')">
              <li v-for="name in spawn_draft.members" :key="name">
                <img v-if="bridge.identities[bridge.platform_of(name)]?.icon" class="steward-spawn-icon" :src="bridge.identities[bridge.platform_of(name)].icon" alt="" />
                <span>{{ bridge.display_name(name) }}</span>
                <UButton icon="i-lucide-crown" size="xs" color="neutral" :variant="spawn_draft.host === name ? 'soft' : 'ghost'" :class="{ 'is-host': spawn_draft.host === name }" :aria-pressed="spawn_draft.host === name"
                  :title="spawn_draft.host === name ? t('主持人') : t('设为主持人')" :aria-label="t('设 {name} 为主持人', { name: bridge.display_name(name) })" @click="spawn = { ...spawn_draft, host: name }" />
                <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('移出 {name}', { name: bridge.display_name(name) })" @click="remove_spawn_member(name)" />
              </li>
            </ul>
            <p v-else class="steward-spawn-none">{{ spawn_fallback ? t("未指定，将使用 {name}", { name: spawn_fallback }) : t("未指定，将使用第一位本机已配置的 AI") }}</p>
            <RosterAdd :label="t('添加 AI')" :items="spawn_library" @add="add_spawn_member" />
          </template>
        </section>
        <section class="steward-group">
          <h4>{{ t("主动汇报") }}<HelpTip :text="t('等你回答时立即告诉你，其他事攒到简报时间；会消耗 MOSS 所用软件的额度。')" /></h4>
          <USwitch :model-value="draft.proactive.enabled" :label="t('让 MOSS 主动汇报')" @update:model-value="set_proactive({ enabled: $event })" />
          <div v-if="draft.proactive.enabled" class="steward-proactive-times">
            <UFormField :label="t('活跃时段')">
              <div class="steward-proactive-row">
                <UInput type="time" size="sm" :model-value="draft.proactive.active_hours.start" :aria-label="t('活跃时段开始')" @update:model-value="set_hours('start', $event)" />
                <span aria-hidden="true">–</span>
                <UInput type="time" size="sm" :model-value="draft.proactive.active_hours.end" :aria-label="t('活跃时段结束')" @update:model-value="set_hours('end', $event)" />
              </div>
            </UFormField>
            <UFormField :label="t('简报时间')">
              <UInput type="time" size="sm" class="steward-proactive-digest" :model-value="draft.proactive.digest_at" :aria-label="t('简报时间')" @update:model-value="$event && set_proactive({ digest_at: $event })" />
            </UFormField>
          </div>
          <span class="steward-label">{{ t("交代给 MOSS 的职责") }}</span>
          <ul v-if="shown_duties.length" class="steward-proactive-list">
            <li v-for="item in shown_duties" :key="item.id"><span>{{ item.text }}</span>
              <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('删除职责：{text}', { text: item.text })" @click="dropped_duties.add(item.id)" /></li>
          </ul>
          <p v-else class="fine-print">{{ draft.proactive.enabled ? t("还没有职责，MOSS 不会主动汇报。在对话里交代一句，它会记下。") : t("在对话里交代一句，MOSS 会记下。") }}</p>
          <template v-if="shown_mutes.length">
            <span class="steward-label">{{ t("已屏蔽的提醒") }}</span>
            <ul class="steward-proactive-list">
              <li v-for="item in shown_mutes" :key="item.id"><span>{{ item.text }}<small v-if="item.reason">{{ t("原因：{reason}", { reason: item.reason }) }}</small></span>
                <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('恢复提醒：{text}', { text: item.text })" :title="t('恢复提醒')" @click="dropped_mutes.add(item.id)" /></li>
            </ul>
          </template>
        </section>
        <section class="steward-group">
          <h4>{{ t("允许的技能") }}</h4>
          <UCheckbox v-for="skill in skills" :key="skill.id" :label="skill_labels[skill.id] || skill.id" :disabled="!skill.available"
            :model-value="draft.skills?.includes(skill.id)" @update:model-value="allow_skill(skill.id, $event)" />
        </section>
      </template>
      <div class="steward-settings-actions">
        <UButton type="submit" :label="choosing ? t('开始对话') : t('保存')" :loading="saving" :disabled="!draft.adapter || (!choosing && !dirty)" />
        <UButton v-if="!choosing" color="neutral" variant="ghost" :label="t('取消')" :disabled="saving" @click="emit('done')" />
      </div>
    </form>
    <div v-else class="steward-settings-form" role="status" :aria-label="t('读取中…')">
      <section v-for="group in (choosing ? 1 : 4)" :key="group" class="steward-group" aria-hidden="true">
        <USkeleton class="h-4 w-24" />
        <USkeleton class="h-9 w-full" />
      </section>
      <USkeleton class="h-9 w-24" />
    </div>
    </div>
    <section v-if="!choosing" class="steward-group steward-history">
      <h4>{{ t("旧对话") }}</h4>
      <p v-if="visible_history && !visible_history.length" class="fine-print">{{ t("没有存档的 MOSS 对话") }}</p>
      <ul v-else-if="visible_history" class="grid gap-2">
        <li v-for="room in visible_history" :key="room.room_id" class="flex flex-wrap items-center gap-2">
          <span class="grow">{{ history_label(room) }}</span>
          <UButton :label="t('打开')" color="neutral" variant="soft" size="xs" @click="open_history_room(room.room_id)" />
          <UButton :label="t('删除')" color="error" variant="ghost" size="xs" @click="history_target = room" />
        </li>
      </ul>
    </section>
    <ConfirmDialog v-model:open="switch_confirm" :title="t('更换软件')" :description="t('更换 MOSS 软件会开始新的 AI 会话，原有对话记录会保留。')" @confirm="save" />
    <ConfirmDialog :open="Boolean(history_target)" :title="t('删除 MOSS 旧对话')" :description="t('这会永久删除该对话的历史记录，不能撤销。')"
      :confirm-label="t('删除')" danger @update:open="!$event && (history_target = null)" @confirm="delete_history_room" />
  </section>
</template>

<style scoped>
.steward-settings-body { block-size: min(34rem, 58dvh); overflow: auto; scrollbar-gutter: stable; }
.steward-settings-body.is-choosing { block-size: min(16rem, 45dvh); }
.steward-settings-form { display: grid; gap: 18px; padding-top: 4px; }
.steward-group { display: grid; gap: 8px; min-width: 0; }
.steward-group > h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.steward-history { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.steward-settings-actions { display: flex; gap: 8px; }
/* One pick among the configured software: the new-room chips' pill look, the chosen one filled (#15658). */
.steward-software-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.steward-software-choices > button, .steward-access > button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 3px 12px 3px 4px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 13px; transition: background .12s, border-color .12s, color .12s; }
.steward-access > button { padding: 3px 12px; }
@media (hover: hover) { .steward-software-choices > button:hover, .steward-access > button:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); } }
:is(.steward-software-choices, .steward-access) > button.is-selected { border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 70%, transparent); background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--ui-text-highlighted); font-weight: 600; }
.steward-access { display: flex; flex-wrap: wrap; gap: 6px; }
.steward-software-card { display: grid; gap: 8px; width: min(100%, 320px); padding: 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; background: color-mix(in srgb, var(--ui-text) 3%, transparent); text-align: left; }
.steward-software-name { display: flex; align-items: center; gap: 8px; }
.steward-software-name > strong { color: var(--ui-text-highlighted); font-size: 14px; }
/* What stays as text reads one step larger and brighter than the old fine print (#15685). */
.steward-settings :deep(.fine-print) { color: var(--ui-text-muted); font-size: 13px; line-height: 1.55; }
.steward-group > h4, .steward-label { display: flex; align-items: center; }
.steward-label { color: var(--ui-text-toned); font-size: 13px; }
/* The shared model picker as it sits in MOSS's card: label and control in two columns, its notes and 恢复默认 in the flow. */
.steward-software-card :deep(.expert-card-field) { display: grid; grid-template-columns: 3em minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-muted); font-size: 12px; }
.steward-software-card :deep(.expert-card-catalog) { display: flex; gap: 8px; margin-left: calc(3em + 8px); color: var(--ui-text-dimmed); font-size: 11px; overflow-wrap: anywhere; }
.steward-software-card :deep(.expert-card-catalog > button) { flex-shrink: 0; color: var(--channel-accent); }
.steward-software-card :deep(.expert-card-note) { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.steward-software-card :deep(.expert-card-defaults) { justify-self: start; padding: 0; color: var(--ui-text-muted); font-size: 12px; }
.steward-software-card :deep(.expert-card-defaults:hover:not(:disabled)) { color: var(--channel-accent); }
.steward-software-card :deep(.expert-card-defaults:disabled) { opacity: .4; }
.steward-software-hint { margin: 0; color: var(--ui-text-muted); font-size: 13px; }
.steward-spawn-members { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.steward-spawn-members li { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 2px 4px 2px 6px; border-radius: 8px; background: color-mix(in srgb, var(--ui-text) 4%, transparent); font-size: 13px; }
.steward-spawn-members li > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.steward-spawn-none { margin: 0; padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--ui-text) 4%, transparent); color: var(--ui-text-muted); font-size: 13px; }
.steward-spawn-icon { flex-shrink: 0; width: 20px; height: 20px; padding: 3px; border-radius: 50%; background: #f7f8fa; object-fit: contain; }
.steward-spawn-members .is-host { color: var(--ui-warning); }
/* Two fields side by side on a desktop, stacked on a phone: the time boxes never wrap mid-row (#15598). */
.steward-proactive-times { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 10px; }
@media (max-width: 560px) { .steward-proactive-times { grid-template-columns: minmax(0, 1fr); } }
.steward-proactive-row { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: 6px; font-size: 13px; }
.steward-proactive-row :deep(input), .steward-proactive-digest :deep(input) { min-width: 0; }
.steward-proactive-digest { width: 100%; }
.steward-proactive-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.steward-proactive-list li { display: flex; align-items: flex-start; gap: 6px; padding: 4px 4px 4px 8px; border-radius: 8px; background: color-mix(in srgb, var(--ui-text) 4%, transparent); font-size: 13px; line-height: 1.5; }
.steward-proactive-list li > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.steward-proactive-list small { display: block; color: var(--ui-text-dimmed); font-size: 12px; }
</style>

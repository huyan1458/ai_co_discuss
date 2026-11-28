<script setup>
import { computed, inject, onMounted, reactive, ref } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import HelpTip from "./HelpTip.vue";
import ModelEffortPicker from "./ModelEffortPicker.vue";
import MossGroupFields from "./MossGroupFields.vue";
import MossWindowSettings from "./MossWindowSettings.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import RosterAdd from "./RosterAdd.vue";
import { is_platform_skill, skill_label } from "./moss-skills.js";
import { WINDOW_DEFAULTS, moss_window_key, window_changes } from "./moss.js";
import { locale, t } from "./i18n.js";

/**
 * MOSS's settings: the first choice of software (`choosing`, a page of its own), and otherwise the dialog opened from
 * MOSS's rail. Every change in the dialog waits for 保存 and is applied together, so nothing here takes effect unseen (#15598).
 */
const { view, bridge } = inject("discussion");
// `window`: whose settings to show (§12): "" the owner's own window (主理人, everything below), "private" the private
// chat's, or a group's key ("<channel>:<chat_id>"). `focus: "windows"` opens the main settings at 聊天窗口.
const props = defineProps({ choosing: Boolean, changeSoftware: Boolean, window: { type: String, default: "" }, focus: { type: String, default: "" } });
const window_mode = computed(() => !props.window ? "" : props.window === "private" ? "private" : "group");
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
// The software, model and strength shown are the window's own: 主理人's, or the private chat's (`settings.private`, §12.1),
// with the same controls for both.
const soft = computed(() => window_mode.value === "private" ? draft.value.private || {} : draft.value);
function set_soft(patch) {
  if (window_mode.value === "private") draft.value = { ...draft.value, private: { ...(draft.value.private || {}), ...patch } };
  else draft.value = { ...draft.value, ...patch };
}
const candidates = computed(() => [...adapters.value.values()].map(item => ({ ...item, selected: item.value === soft.value.adapter })));
const card_platform = computed(() => adapters.value.get(soft.value.adapter)?.platform || adapter_profile(soft.value.adapter)?.platform);
// Choosing MOSS's software is one pick, not adding members (#15658): a single-choice row in the new-room chips' look, then a
// card with the software and its model; model and effort stay at the software's defaults unless 高级 is opened.
const chosen = computed(() => adapters.value.get(soft.value.adapter) || null);
// The profile the model list is read with: this computer's software settings for the platform, with MOSS's own choice
// over them, as the expert card reads a preset's (choosing other software clears model and strength back to its defaults).
const moss_profile = computed(() => ({ ...(view.value.launch.profiles?.[card_platform.value] || {}), adapter: soft.value.adapter, model: soft.value.model || "", effort: soft.value.effort || "" }));
// 主理人's own fields go to `steward-settings` as they are; the private chat's go there as `private` with only what changed
// (its `cwd` and `room_id` are the computer's); each group's go one by one through `group-settings` (#16072).
const OWN_FIELDS = new Set(["private", "windows"]);
const changed = computed(() => saved.value ? Object.fromEntries(Object.entries(draft.value)
  .filter(([key, value]) => !OWN_FIELDS.has(key) && JSON.stringify(value) !== JSON.stringify(saved.value[key]))) : {});
const PRIVATE_FIELDS = ["adapter", "model", "effort", "project_access", "skills"];
const private_changes = computed(() => {
  const now = draft.value.private || {}, before = saved.value?.private || {};
  return Object.fromEntries(PRIVATE_FIELDS.filter((field) => JSON.stringify(now[field] ?? "") !== JSON.stringify(before[field] ?? "")).map((field) => [field, now[field] ?? ""]));
});
const window_patches = computed(() => Object.entries(draft.value.windows || {})
  .map(([key, value]) => [key, window_changes(value, saved.value?.windows?.[key])]).filter(([, patch]) => Object.keys(patch).length));

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

const dirty = computed(() => Object.keys(changed.value).length > 0 || Object.keys(private_changes.value).length > 0 || window_patches.value.length > 0
  || spawn_changed.value || dropped_duties.size > 0 || dropped_mutes.size > 0);
// The private chat's project access: read-only by default, 自动 when the owner raises it; separate from 主理人's (§12.1).
const PRIVATE_ACCESS = [{ value: "read", label: t("只读") }, { value: "auto", label: t("自动") }];

// The private chat's and a group's own settings sit in the same draft (`private`, `windows`) and save with 保存 (§12.3).
const private_draft = computed(() => draft.value.private || {});
function set_private(patch) {
  const next = { ...private_draft.value, ...patch };
  draft.value = { ...draft.value, private: next };
}
function allow_private_skill(id, allowed) {
  const selected = new Set(private_draft.value.skills || []);
  if (allowed) selected.add(id); else selected.delete(id);
  set_private({ skills: skills.value.map((skill) => skill.id).filter((item) => selected.has(item)) });
}
const group_draft = computed(() => draft.value.windows?.[props.window] || {});
function set_group(patch) {
  const next = { ...group_draft.value, ...patch };
  for (const [field, value] of Object.entries(next)) if (value === "" || value == null) delete next[field];
  draft.value = { ...draft.value, windows: { ...(draft.value.windows || {}), [props.window]: next } };
}
// Today's counts for the open group, read from the computer's group list; zero until they arrive.
const group_today = ref({ used_today: 0, tasks_used_today: 0 });
async function load_group_today() {
  const [channel, chat_id] = props.window.split(":");
  try {
    const { groups } = await bridge.local_request("notify", { channel, action: "groups" });
    const group = (groups || []).find((item) => item.id === chat_id);
    if (group) group_today.value = { used_today: group.used_today ?? 0, tasks_used_today: group.tasks_used_today ?? 0 };
  } catch { /* The counts stay at zero; the settings themselves still load and save. */ }
}

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
    group_skills.value = status.group_skills || [];
  } catch (error) { bridge.notify("error", error.message); }
}
// The skills a group may be given (`steward.group_skills`, `[{id, platform}]`); a group's own choice is in its `skills`.
const group_skills = ref([]);
const form = ref(null);
onMounted(async () => {
  if (window_mode.value === "group") load_group_today();
  if (!props.choosing && !window_mode.value) load_history();
  await load();
  // Opened from the window list's "+": straight to the group list.
  if (props.focus === "windows") requestAnimationFrame(() => form.value?.querySelector(".moss-windows-settings")?.scrollIntoView({ block: "start" }));
});

function choose_adapter(adapter) {
  if (adapter === soft.value.adapter) return;
  set_soft({ adapter, model: "", effort: "" });
}

/** A group's name for messages: its window's room title (an open group has one), else its number. */
function group_title(key, chat_id) {
  return view.value.rooms.find((room) => room.system_kind === "steward_group" && moss_window_key(room) === key)?.title || chat_id;
}
/** Each changed group through `group-settings`; a group the computer refuses keeps its edits and says why. */
async function save_windows() {
  let all_saved = true;
  for (const [key, patch] of window_patches.value) {
    const [channel, chat_id] = key.split(":");
    try {
      const result = await bridge.local_request("notify", { action: "group-settings", channel, chat_id, settings: patch });
      const merged = { ...(saved.value.windows?.[key] || {}), ...patch, ...Object.fromEntries(Object.keys(WINDOW_DEFAULTS).filter((field) => field in (result || {})).map((field) => [field, result[field]])) };
      saved.value = { ...saved.value, windows: { ...(saved.value.windows || {}), [key]: merged } };
    } catch (error) { bridge.notify("error", t("「{name}」的设置没有保存：{error}", { name: group_title(key, chat_id), error: error.message })); all_saved = false; }
  }
  return all_saved;
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
  const own = changed.value;
  const patch = Object.keys(private_changes.value).length ? { ...own, private: private_changes.value } : own;
  const proposed = spawn.value;
  const roster = spawn_changed.value ? { members: proposed.members, host: proposed.host || "" } : null;
  saving.value = true;
  try {
    let busy = false;
    if (Object.keys(patch).length || roster) {
      const status = await bridge.local_request("steward-settings", roster ? { ...patch, create_preferences: roster } : patch);
      const settings = split_proactive(status.settings);
      for (const key of Object.keys(settings)) {
        if (!OWN_FIELDS.has(key) && JSON.stringify(draft.value[key]) === JSON.stringify(patch[key] ?? saved.value[key])) draft.value[key] = settings[key];
      }
      saved.value = { ...settings, windows: saved.value.windows };
      skills.value = status.skills;
      busy = Boolean(status.busy);
      if (Object.hasOwn(patch, "skills")) document.dispatchEvent(new Event("discuss:steward-skills-changed"));
    }
    // A group that was not saved keeps the dialog open with its edits; everything else is already saved.
    if (!await save_windows()) return;
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
    <form v-if="saved" ref="form" class="steward-settings-form" @submit.prevent="submit">
      <!-- 主理人's and the private chat's software: the same choice row and card for both (#16079). -->
      <section v-if="window_mode !== 'group'" class="steward-group">
        <h4 v-if="!choosing">{{ t("软件") }}</h4>
        <div v-if="(choosing || changing_software || (window_mode === 'private' && !soft.adapter)) && candidates.length" class="steward-software-choices" role="radiogroup" :aria-label="t('选择 MOSS 软件')">
          <button v-for="item in candidates" :key="item.value" type="button" role="radio" :aria-checked="item.selected" :class="{ 'is-selected': item.selected }" @click="choose_adapter(item.value)">
            <UAvatar :src="item.icon" :text="item.initials" size="2xs" class="channel-avatar" :class="item.style" /><span>{{ item.name }}</span>
          </button>
        </div>
        <p v-else-if="choosing && view.launch.available" class="fine-print">{{ t("这台电脑还没有配置可用的 AI 软件。") }}</p>
        <div v-if="chosen" class="steward-software-card">
          <div class="steward-software-name"><UAvatar :src="chosen.icon" :text="chosen.initials" size="sm" class="channel-avatar" :class="chosen.style" /><strong>{{ chosen.name }}</strong></div>
          <!-- The expert card's own model list, refresh and strength (#15717): one way to choose a model across the site. -->
          <ModelEffortPicker v-if="card_platform" :key="soft.adapter" :name="card_platform" :profile="moss_profile" portable
            @model="set_soft({ model: $event === '__default__' ? '' : String($event || '').trim(), effort: '' })"
            @effort="set_soft({ effort: $event })" @reset="set_soft({ model: '', effort: '' })" />
        </div>
        <!-- Before a pick, the card's slot holds the hint at the card's size, so 开始对话 does not move (#15841). -->
        <div v-if="choosing && candidates.length && !draft.adapter" class="steward-software-card is-empty"><p class="steward-software-hint">{{ t("先选一个软件") }}</p></div>
        <UButton v-if="!choosing && !changing_software && chosen" class="justify-self-start" icon="i-lucide-arrow-left-right" :label="t('更换软件')" size="xs" color="neutral" variant="soft" @click="changing_software = true" />
      </section>
      <!-- The private chat's own settings (§12.1, §12.3): how it talks and which skills it gets; platform skills stay with 主理人. -->
      <template v-if="window_mode === 'private'">
        <section class="steward-group">
          <h4>{{ t("项目权限") }}<HelpTip :text="t('默认只读；调到自动后，私聊里的 MOSS 能运行命令、改文件。和主理人的设置互不影响。')" /></h4>
          <div class="steward-access" role="radiogroup" :aria-label="t('项目权限')">
            <button v-for="item in PRIVATE_ACCESS" :key="item.value" type="button" role="radio" :aria-checked="(soft.project_access || 'read') === item.value"
              :class="{ 'is-selected': (soft.project_access || 'read') === item.value }" @click="set_soft({ project_access: item.value })">{{ item.label }}</button>
          </div>
        </section>
        <section class="steward-group">
          <h4>{{ t("说话方式") }}</h4>
          <UTextarea :model-value="draft.habits?.private || ''" :maxlength="500" :rows="2" autoresize :maxrows="6" class="w-full"
            :placeholder="t('留空沿用 MOSS 现在的说话方式')" @update:model-value="draft = { ...draft, habits: { ...(draft.habits || {}), private: $event } }" />
        </section>
        <section class="steward-group">
          <h4>{{ t("私聊可用的技能") }}<HelpTip :text="t('私聊里看不到没勾选的技能；安装、部署、配置类只在主理人里可用。')" /></h4>
          <UCheckbox v-for="skill in skills" :key="skill.id" :label="skill_label(skill)" :disabled="skill.available === false || is_platform_skill(skill)"
            :description="is_platform_skill(skill) ? t('只在主理人里可用') : undefined"
            :model-value="!is_platform_skill(skill) && Boolean(private_draft.skills?.includes(skill.id))" @update:model-value="allow_private_skill(skill.id, $event)" />
        </section>
      </template>
      <!-- A group's own settings, the same fields as its row in 聊天窗口. -->
      <MossGroupFields v-else-if="window_mode === 'group'" :value="group_draft" :used-today="group_today.used_today" :tasks-today="group_today.tasks_used_today"
        :adapter="draft.adapter" :platform="card_platform || ''" :skills="group_skills" @update="set_group" />
      <template v-if="!choosing && !window_mode">
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
        <MossWindowSettings v-model:habits="draft.habits" v-model:windows="draft.windows" :adapter="draft.adapter" :platform="card_platform || ''" :skills="group_skills" />
        <section class="steward-group">
          <h4>{{ t("允许的技能") }}</h4>
          <UCheckbox v-for="skill in skills" :key="skill.id" :label="skill_label(skill)" :disabled="!skill.available"
            :model-value="draft.skills?.includes(skill.id)" @update:model-value="allow_skill(skill.id, $event)" />
        </section>
      </template>
      <div class="steward-settings-actions">
        <UButton type="submit" :label="choosing ? t('开始对话') : t('保存')" :loading="saving" :disabled="!draft.adapter || (!choosing && !dirty)" />
        <UButton v-if="!choosing" color="neutral" variant="ghost" :label="t('取消')" :disabled="saving" @click="emit('done')" />
      </div>
    </form>
    <div v-else class="steward-settings-form" role="status" :aria-label="t('读取中…')">
      <section v-if="choosing" class="steward-group" aria-hidden="true">
        <USkeleton class="h-[30px] w-full rounded-full" />
        <USkeleton class="steward-software-card" />
      </section>
      <section v-for="group in (choosing ? 0 : 4)" :key="group" class="steward-group" aria-hidden="true">
        <USkeleton class="h-4 w-24" />
        <USkeleton class="h-9 w-full" />
      </section>
      <USkeleton class="h-8 w-24" :class="{ 'justify-self-center': choosing }" />
    </div>
    </div>
    <section v-if="!choosing && !window_mode" class="steward-group steward-history">
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
/* The first choice shows whole: no box of its own to scroll, the page scrolls if the window is short (#15841). */
.steward-settings-body.is-choosing { block-size: auto; overflow: visible; scrollbar-gutter: auto; }
.is-choosing .steward-settings-form { gap: 14px; }
.is-choosing .steward-software-card { min-block-size: 168px; }
.steward-settings-form { display: grid; gap: 18px; padding-top: 4px; }
.steward-group { display: grid; gap: 8px; min-width: 0; }
.steward-group > h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.steward-history { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.steward-settings-actions { display: flex; gap: 8px; }
/* One pick among the configured software: the new-room chips' pill look, the chosen one filled (#15658). */
.steward-software-choices, .steward-access { display: flex; flex-wrap: wrap; gap: 6px; }
.steward-software-choices > button, .steward-access > button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 3px 12px 3px 4px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 13px; transition: background .12s, border-color .12s, color .12s; }
.steward-access > button { padding: 3px 12px; }
@media (hover: hover) { .steward-software-choices > button:hover, .steward-access > button:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); } }
:is(.steward-software-choices, .steward-access) > button.is-selected { border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 70%, transparent); background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--ui-text-highlighted); font-weight: 600; }
/* The model list's loading or error line shares the 恢复默认 row instead of a blank row of its own (#15841). */
.steward-software-card { display: grid; grid-template-columns: auto minmax(0, 1fr); grid-template-areas: "name name" "field field" "effort effort" "defaults catalog"; align-content: start; gap: 8px; width: min(100%, 340px); padding: 12px; border: 1px solid var(--ui-border-muted); border-radius: 10px; background: color-mix(in srgb, var(--ui-text) 3%, transparent); text-align: left; }
.steward-software-card.is-empty { grid-template-areas: none; place-content: center; }
.steward-software-name { grid-area: name; display: flex; align-items: center; gap: 8px; }
.steward-software-card :deep(.expert-card-field) { grid-area: field; }
.steward-software-card :deep(.model-effort-slot) { grid-area: effort; }
.steward-software-name > strong { color: var(--ui-text-highlighted); font-size: 14px; }
/* What stays as text reads one step larger and brighter than the old fine print (#15685). */
.steward-settings :deep(.fine-print) { color: var(--ui-text-muted); font-size: 13px; line-height: 1.55; }
.steward-group > h4, .steward-label { display: flex; align-items: center; }
.steward-label { color: var(--ui-text-toned); font-size: 13px; }
/* The shared model picker as it sits in MOSS's card: label and control in two columns, its notes and 恢复默认 in the flow. */
.steward-software-card :deep(.expert-card-field) { display: grid; grid-template-columns: 3em minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-muted); font-size: 12px; }
.steward-software-card :deep(.expert-card-catalog) { grid-area: catalog; display: flex; gap: 8px; min-width: 0; color: var(--ui-text-dimmed); font-size: 11px; text-align: right; }
.steward-software-card :deep(.expert-card-catalog > button) { flex-shrink: 0; color: var(--channel-accent); }
.steward-software-card :deep(.expert-card-note) { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.steward-software-card :deep(.expert-card-defaults) { grid-area: defaults; justify-self: start; padding: 0; color: var(--ui-text-muted); font-size: 12px; }
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

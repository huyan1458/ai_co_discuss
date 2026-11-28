<script setup>
import { computed, inject, onMounted, reactive, ref } from "vue";
import { adapter_profile } from "../runner/adapters/profiles.mjs";
import { access_options } from "../runner/expert_prompts.mjs";
import ConfirmDialog from "./ConfirmDialog.vue";
import ExpertCard from "./ExpertCard.vue";
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
    <form v-if="saved" class="steward-settings-form" @submit.prevent="submit">
      <section class="steward-group">
        <h4 v-if="!choosing">{{ t("软件") }}</h4>
        <RosterAdd v-if="(choosing || changing_software) && candidates.length" :label="t('选择 MOSS 软件')" :items="candidates" @add="choose_adapter" />
        <p v-else-if="choosing && view.launch.available" class="fine-print">{{ t("这台电脑还没有配置可用的 AI 软件。") }}</p>
        <ExpertCard v-if="card_platform" :key="draft.adapter" v-model:preset="draft" class="w-full max-w-[280px]" :name="card_platform" mode="cli" :status="{}" settings-only />
        <UButton v-if="!choosing && !changing_software" class="justify-self-start" icon="i-lucide-arrow-left-right" :label="t('更换软件')" size="xs" color="neutral" variant="soft" @click="changing_software = true" />
      </section>
      <template v-if="!choosing">
        <section class="steward-group">
          <h4>{{ t("工作目录") }}</h4>
          <ProjectDirectoryField v-model="draft.cwd" compact />
        </section>
        <section class="steward-group">
          <h4>{{ t("新建房间") }}</h4>
          <!-- On unless the user turned it off: an older computer that does not send the setting yet reads as on. -->
          <USwitch :model-value="draft.create_rooms !== false" :label="t('允许 MOSS 新建房间')" @update:model-value="draft = { ...draft, create_rooms: $event }" />
          <p class="fine-print">{{ t("关闭后 MOSS 不能新建房间，也不能给其他房间的主持人传话。") }}</p>
          <template v-if="draft.create_rooms !== false">
            <span class="text-sm">{{ t("MOSS 建房时的成员") }}</span>
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
            <p class="fine-print">{{ t("新房间的成员用本机保存的默认模型与强度；项目权限沿用你保存的新建房间项目权限，最高为可写，未设置时只读。") }}</p>
          </template>
        </section>
        <section class="steward-group">
          <h4>{{ t("主动汇报") }}</h4>
          <USwitch :model-value="draft.proactive.enabled" :label="t('让 MOSS 主动汇报')" @update:model-value="set_proactive({ enabled: $event })" />
          <p class="fine-print">{{ t("默认关闭。开启后，房间等你回答时 MOSS 立即告诉你，其他事攒到简报时间一起说；只在活跃时段内汇报，会消耗 MOSS 所用软件的额度。") }}</p>
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
          <span class="text-sm">{{ t("交代给 MOSS 的职责") }}</span>
          <ul v-if="shown_duties.length" class="steward-proactive-list">
            <li v-for="item in shown_duties" :key="item.id"><span>{{ item.text }}</span>
              <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" :aria-label="t('删除职责：{text}', { text: item.text })" @click="dropped_duties.add(item.id)" /></li>
          </ul>
          <p v-else class="fine-print">{{ draft.proactive.enabled ? t("还没有职责，MOSS 不会主动汇报。在对话里交代一句即可，例如“有房间等我回答时提醒我”，它会记下。") : t("在对话里交代一句即可，例如“有房间等我回答时提醒我”，它会记下。") }}</p>
          <template v-if="shown_mutes.length">
            <span class="text-sm">{{ t("已屏蔽的提醒") }}</span>
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
.steward-settings-form { display: grid; gap: 18px; padding-top: 4px; }
.steward-group { display: grid; gap: 8px; min-width: 0; }
.steward-group > h4 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.steward-history { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.steward-settings-actions { display: flex; gap: 8px; }
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

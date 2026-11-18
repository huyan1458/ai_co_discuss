<script>
// Titles of the conversations picked on this page, by ID, so a card drawn again names its conversation instead of showing the ID.
const session_titles = new Map();
</script>

<script setup>
import { t } from './i18n.js';
/** Show one participant instance and its actual software configuration boundary. */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { motion, useSpring } from "motion-v";
import EffortSlider from "./EffortSlider.vue";
import ModelRefresh from "./ModelRefresh.vue";
import ApiSettings from "./ApiSettings.vue";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import MemberTextDialog from "./MemberTextDialog.vue";
import SessionBrowser from "./SessionBrowser.vue";
import { adapter_profile, same_session_family } from "../runner/adapters/profiles.mjs";
import { EXPERT_PROMPT_HEADING, EXPERT_PROMPT_PRESETS, MAX_EXPERT_PROMPT, READ_RULE, access_label, access_options, free_task_text } from "../runner/expert_prompts.mjs";

const props = defineProps({
  name: { type: String, required: true },
  mode: { type: String, default: "" },
  // Delivery options this card offers: cli (woken by the local service) or manual; empty when fixed.
  choices: { type: Array, default: () => [] },
  status: { type: Object, required: true },
  host: Boolean,
  hostable: Boolean,
  // True where the form picks a host, so the card states whether this one may host.
  hosting: Boolean,
  // The project directory whose conversations the history window lists first; the form's own directory when not given.
  directory: { type: String, default: "" },
  // The workflow this card came from: its prompt is read from the workflow at each execution, so here it is read-only.
  workflow: { type: String, default: "" },
  // Imported presets start read-only until the user grants the requested level on that card.
  access_locked: Boolean,
});
// Library edits stay in this draft; no room profile, software default or saved expert preset is changed.
const preset = defineModel("preset", { type: Object, default: null });
const emit = defineEmits(["remove", "mode", "host"]);
const { view, bridge } = inject("discussion");
// Feel.words("smooth, crisp"): 2.615 Hz reads as a deliberate turn; ζ .96 avoids bounce.
// Unit mass: this is a button-controlled angular spring, with no drag-weight effect.
const FLIP_SPRING = { mass: 1, stiffness: 270.0323764138049, damping: 31.550710806760762 };
const BACK_ANGLE = 180;
const angle = useSpring(0, FLIP_SPRING);
const card = ref(null), front_button = ref(null), back_button = ref(null);
const back = ref(false), visible_back = ref(false);
const profile = computed(() => preset.value ? {
  ...view.value.launch.profiles[bridge.platform_of(props.name)],
  model: "", effort: "", system_prompt: "", project_access: "read", ...preset.value,
} : view.value.launch.profiles[props.name] || {});
const member_label = computed(() => preset.value ? preset.value.label || bridge.default_name(props.name) : view.value && bridge.member_label(props.name));
const entry_items = computed(() => bridge.launch_clients[props.name] || []);
// Manual start needs a local AI session; a platform reachable only through its API cannot offer it.
// A hosted account runs members only the way the computer owner set them up: no manual start, no choice of software entry.
const restricted = computed(() => view.value.launch.projects_restricted === true);
const offered = computed(() => props.choices.filter((option) => option !== "manual" || !restricted.value && entry_items.value.some((item) => item.value !== "api")));
const automatic = computed(() => props.mode === "cli");
// Short labels for the front control; the 启动 row spells out what each one means.
const HISTORY = "history";
const ACCESS_LABELS = { cli: t('程序启动'), manual: t('手动启动'), [HISTORY]: t('历史会话') };
const MODE_TITLES = { cli: t('由程序新建一个空白会话'), manual: t('把启动指令交给你已打开的 AI 会话'), [HISTORY]: t('浏览这个软件的历史会话，选一个由程序续接') };
const api_mode = computed(() => !preset.value && automatic.value && profile.value.adapter === "api");
const api_check = ref({ state: "" });
// A previous check result no longer applies once any checked field changes.
watch(() => [profile.value.base_url, profile.value.api_protocol, profile.value.model, profile.value.api_key_ref], () => { api_check.value = { state: "" }; });

/** Send one tiny request through the local service with the current address, key, protocol and model. */
async function check_api() {
  api_check.value = { state: "loading" };
  try { await bridge.check_launch_api(props.name); api_check.value = { state: "ok" }; bridge.notify("info", t('检查通过：模型已响应')); }
  catch (failure) { api_check.value = { state: "error" }; bridge.notify("error", failure.message); }
}
// Without the local service here, the paired computer wakes the member with the software configured there.
const relay_client = computed(() => !view.value.launch.available && view.value.launch.relay?.clients[bridge.platform_of(props.name)]);
const entry_label = computed(() => entry_items.value.find((item) => item.value === (relay_client.value || profile.value.adapter))?.label
  || (view.value.launch.relay && !view.value.launch.available ? t('电脑上未配置') : t('待选择 App / CLI')));
const manual = computed(() => props.mode === "manual");
// A manual card has nothing to configure, so the front states what testing showed about taking over a window that is already open.
const MANUAL_NOTES = {
  Codex: t('已实测：消息实时显示在已开窗口。'),
  Antigravity: t('已实测：App 会话实时显示；agy CLI 窗口需重启才显示后台发言。'),
  Claude: t('已实测：原窗口开着时消息实时送入；关闭后在后台续接同一会话。'),
};
const manual_note = computed(() => MANUAL_NOTES[bridge.platform_of(props.name)] || "");
const resuming = computed(() => Boolean(profile.value.session_id));
// A card woken by the local service may instead resume a conversation its software already holds, picked from a
// browsing window: offered where the card's entry (else another entry of its platform) can list its conversations.
const browsing = ref(false);
const browse_adapter = computed(() => {
  const own = relay_client.value || profile.value.adapter;
  if (adapter_profile(own)?.browse_sessions) return own;
  return relay_client.value ? "" : entry_items.value.find((item) => adapter_profile(item.value)?.browse_sessions)?.value || "";
});
const mode_options = computed(() => {
  const reachable = view.value.launch.available || Boolean(view.value.launch.relay);
  if (!offered.value.includes("cli") || props.workflow || preset.value || !browse_adapter.value || !reachable) return offered.value;
  return ["cli", HISTORY, ...offered.value.filter((option) => option !== "cli")];
});
const current_mode = computed(() => props.mode === "cli" && resuming.value ? HISTORY : props.mode);
const browse_directory = computed(() => props.directory || profile.value.cwd || view.value.launch.workspace?.cwd || "");
const session_label = computed(() => session_titles.get(profile.value.session_id) || profile.value.session_id || "");

/** Bind the picked conversation: the card is woken by the local service, through the entry that listed it. */
function resume_session(session) {
  session_titles.set(session.id, session.title);
  if (props.mode !== "cli") emit("mode", "cli");
  if (!relay_client.value && profile.value.adapter !== browse_adapter.value) bridge.write_launch(props.name, "adapter", browse_adapter.value);
  bridge.write_launch(props.name, "session_id", session.id);
}
// A conversation belongs to the software that holds it: another entry keeps it only when both share one session store.
watch(() => profile.value.adapter, (next, previous) => {
  if (previous && next && next !== previous && resuming.value && !same_session_family(next, previous)) bridge.write_launch(props.name, "session_id", null);
});
// Software paths and models typed here belong to this browser's computer, so a relayed member keeps the paired computer's settings.
// A workflow card does not turn over: its software, model, strength and access are set together in the workflow's
// 专家配置, and its description and prompt from the front.
const can_flip = computed(() => !preset.value && automatic.value && entry_items.value.length > 0 && !(view.value.launch.relay && !view.value.launch.available));
const card_label = computed(() => preset.value ? t('编辑 {value1} 的卡片', { value1: props.name }) : t('配置 {value1} 的启动方式', { value1: props.name }));
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch, profile.value));
const preset_model_input = computed(() => preset.value && !adapter_profile(profile.value.adapter)?.models);
const configurable = computed(() => Boolean(preset.value || automatic.value && models.value.supported));
const configuration_note = computed(() => configurable.value && connection.value.length ? t('补齐上方连接后，可在这里选择模型与思考强度。')
  : profile.value.adapter ? t('模型与思考强度在 App 原聊天中选择，本页不覆盖 App 设置。') : t('先选择软件入口。支持启动参数的 CLI 可在这里设置模型与强度。'));
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const effort_items = computed(() => {
  // A preset or a software that lists no models (a model API) offers the levels its profile declares.
  const facts = adapter_profile(profile.value.adapter);
  const levels = models.value.efforts || (preset.value || !facts?.models ? facts?.efforts : null);
  return levels?.length ? [{ label: t('默认强度'), value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
});
// An empty choice shows what the software's own settings select; only when they say nothing does the software decide.
// agy's default effort belongs to its default model, so a chosen model keeps its own default instead.
const default_effort = computed(() => profile.value.adapter === "antigravity_cli" && profile.value.model ? "" : models.value.defaults?.effort);
const effort_label = computed(() => profile.value.effort ? EFFORT_LABELS[profile.value.effort] || profile.value.effort
  : default_effort.value ? EFFORT_LABELS[default_effort.value] || default_effort.value
  : t('默认'));
// The front lists the read-only configuration; strength appears only where this page sets it.
// Room speech and project files are separate: only woken CLIs and API members get a project choice from this page,
// Apps and manual sessions keep their own settings.
const sets_access = computed(() => Boolean(preset.value) || automatic.value && bridge.launch_can_set_access(props.name, view.value.launch));
const local_connection = computed(() => !preset.value && automatic.value && profile.value.adapter !== "api");
const full_only = computed(() => bridge.full_only_hint(profile.value.adapter));
const access = computed(() => full_only.value ? "full" : profile.value.project_access || view.value.launch.workspace?.project_access || "read");
// Who starts the member and whether it can host: the two things the delivery choice changes and a user must see before inviting.
const launch_fact = computed(() => props.mode === "manual" ? t('你来启动 · 自主发言')
  : t('程序启动 · {value1}', { value1: resuming.value ? t('续接会话') : profile.value.adapter === "api" ? t('调用 API') : t('新会话') }));
const host_fact = computed(() => t('不可（须本机唤醒）'));
// A workflow card naming software this computer has not set up (known once the library listed the platforms).
const platform_missing = computed(() => {
  const ready = view.value.launch.card_platforms || [];
  return Boolean(preset.value) && ready.length > 0 && !ready.includes(bridge.platform_of(props.name));
});
// The front states only what is decided or an exception; placeholders such as "set in the original software" stay off it.
const facts = computed(() => preset.value ? [
  ...preset.value.needs_platform || platform_missing.value ? [{ label: t('平台'), value: t('本机未配置此软件'), tone: "warn" }] : [],
  { label: t('模型'), value: profile.value.model || t('软件默认模型') },
  ...profile.value.effort ? [{ label: t('强度'), value: effort_label.value }] : [],
  { label: t('项目'), value: access_label(access.value), ...(access.value !== "read" ? { tone: "warn" } : {}) },
] : [
  ...automatic.value ? [{ label: t('状态'), value: props.status.text, tone: props.status.tone }] : [],
  { label: t('启动'), value: launch_fact.value },
  ...automatic.value && resuming.value ? [{ label: t('会话'), value: session_label.value }] : [],
  ...automatic.value ? [{ label: t('软件'), value: entry_label.value }] : [],
  ...configurable.value ? [{ label: t('模型'), value: profile.value.model || models.value.defaults?.model || t('软件默认模型') }] : [],
  ...configurable.value && (profile.value.adapter !== "api" || profile.value.effort) ? [{ label: t('强度'), value: effort_label.value }] : [],
  // A workflow card that may change files is pointed out before it joins.
  ...sets_access.value ? [{ label: t('项目'), value: access_label(access.value), ...(props.workflow && access.value !== "read" ? { tone: "warn" } : {}) }] : [],
  // The crown already offers hosting and the badge names the host, so only the refusal needs a row.
  ...props.hosting && !props.host && !props.hostable ? [{ label: t('主持'), value: host_fact.value }] : [],
]);
// Ask only for connection values that are missing; a field stays while the back is open so typing does not hide it.
const CONNECTION_FIELDS = { executable: { label: t('路径'), placeholder: t('可执行文件完整路径') },
  ipc_directory: { label: "IPC", placeholder: t('Sidecar IPC 目录') }, source_thread_id: { label: t('聊天'), placeholder: t('Codex App 来源聊天 ID') } };
const asked = ref([]);
const required_connection = () => {
  const adapter = profile.value.adapter;
  if (!local_connection.value || !adapter) return [];
  return (adapter === "antigravity" ? ["ipc_directory"] : adapter === "codex" ? ["executable", "source_thread_id"] : ["executable"])
    .filter(field => !profile.value[field]);
};
const connection = computed(() => !local_connection.value ? []
  : [...new Set([...asked.value, ...required_connection()])].map(field => ({ field, ...CONNECTION_FIELDS[field] })));

/** Restore focus only while the user is still waiting on this card. */
function focus_face() {
  nextTick(() => {
    if (document.activeElement === card.value) (visible_back.value ? back_button : front_button).value?.focus({ preventScroll: true });
  });
}

/** Expose the incoming face when the spring crosses the edge. */
function reveal(degrees) {
  const next = degrees >= BACK_ANGLE / 2;
  if (visible_back.value === next) return;
  visible_back.value = next;
  focus_face();
}
const stop_observing = angle.on("change", reveal);
// A rapid reversal can settle without ever crossing the edge.
const stop_settling = angle.on("animationComplete", focus_face);

/** Retarget the same spring so a reversal carries its current angle and velocity. */
// Opening the back remembers this instance's settings so Cancel can restore them exactly.
let opened_with = null;

function flip(next) {
  if (next && !can_flip.value) return;
  card.value?.focus({ preventScroll: true });
  asked.value = next ? required_connection() : [];
  if (next && !back.value) { opened_with = { profile: JSON.parse(JSON.stringify(preset.value || profile.value)), mode: props.mode }; }
  back.value = next;
}

/** Discard edits made since the back opened, then return to the front. */
function cancel() {
  if (opened_with) {
    if (preset.value) preset.value = opened_with.profile;
    else bridge.restore_launch_profile(props.name, opened_with.profile);
    if (opened_with.mode !== props.mode) emit("mode", opened_with.mode);
    opened_with = null;
  }
  flip(false);
}

// The description says what this member is good at, for the scheduler and the host; any delivery mode may have one.
// Drafts live in the bridge, so reading the published view ties this to each update.
const description = computed(() => preset.value ? (preset.value.description || "").trim() : view.value && bridge.description_draft(props.name).trim());
const describing = ref(false);
const describe_title = computed(() => description.value ? t('编辑名称与描述：{value1}', { value1: description.value }) : t('编辑名称与描述'));

/** Keep the card's description for the room or invitation, and optionally as this platform's default. */
function save_description({ text, label, as_template }) {
  if (preset.value) {
    preset.value.description = text;
    if (label !== undefined) preset.value.label = label;
  } else {
    bridge.write_description_draft(props.name, text);
    if (label !== undefined) bridge.write_label_draft(props.name, label);
    if (as_template) bridge.save_description_template(props.name, text);
  }
  describing.value = false;
}

// A preset keeps this card's description, prompt, project access, model and effort under its name for later rooms.
const own_preset = computed(() => view.value.launch.presets.some((preset) => preset.name === props.name));
// A card not added from its own preset is saved under a name the user gives; the platform prefix is only a suggestion.
const naming = ref(false), naming_draft = ref("");
const saving_preset = ref(false);
const naming_text = computed(() => naming_draft.value.trim());
const naming_blank = computed(() => !naming_text.value || naming_text.value === `${bridge.default_name(bridge.platform_of(props.name))}-`);
const naming_id = computed(() => view.value && !naming_blank.value ? bridge.preset_identity(props.name, naming_text.value) : "");
const naming_note = computed(() => {
  if (!naming_id.value) return t('预设名称会显示在“预设”行和房间里，可以不带平台前缀。');
  const existing = bridge.expert_presets().find((preset) => preset.name === naming_id.value);
  const id_note = naming_id.value === naming_text.value ? "" : t('成员 ID：{value1}', { value1: naming_id.value });
  return [id_note, existing ? t('将覆盖已有预设「{value1}」', { value1: existing.label || existing.name }) : ""].filter(Boolean).join(" · ") || t('预设名称即成员 ID');
});

/** Update the card's own preset in place; any other card asks for a name first. */
function save_preset() {
  if (saving_preset.value) return;
  if (own_preset.value) return store_preset();
  // Suggest the first numbered name that no saved preset holds yet.
  const taken = new Set(bridge.expert_presets().map((preset) => preset.name));
  const platform = bridge.platform_of(props.name);
  let number = 1;
  const nickname = bridge.default_name(platform);
  while (taken.has(bridge.preset_identity(props.name, `${nickname}-${number}`))) number += 1;
  naming_draft.value = `${nickname}-${number}`;
  naming.value = true;
}

/** Save under the typed name and close. */
async function save_named_preset() {
  if (naming_blank.value || saving_preset.value) return;
  if (await store_preset(naming_text.value)) naming.value = false;
}

/** Keep saving visible and retain the named draft on failure. */
async function store_preset(label) {
  saving_preset.value = true;
  try { return await bridge.save_expert_preset(props.name, label); }
  finally { saving_preset.value = false; }
}

// The expert prompt adds guidance for this member alone; its own text, even empty, replaces the software's preset.
const prompt_preset = computed(() => EXPERT_PROMPT_PRESETS[profile.value.adapter] || "");
const prompt_own = computed(() => preset.value ? Boolean(preset.value.system_prompt?.trim()) : Object.hasOwn(profile.value, "system_prompt"));
const prompt_text = computed(() => (prompt_own.value ? profile.value.system_prompt : prompt_preset.value).trim());
// The back has no room for a row, so the heading carries an icon whose tooltip states the prompt's source and first line.
const prompt_title = computed(() => !prompt_text.value ? t('专属提示词：未设置，点击添加')
  : t('专属提示词（{value1}）：{value2}', { value1: prompt_own.value ? t('自定义') : t('软件预设'), value2: prompt_text.value.split("\n")[0] }));
const prompt_open = ref(false), prompt_draft = ref("");
const prompt_changed = computed(() => prompt_draft.value.trim() !== prompt_text.value);
// The dialog says live whether the text being typed still follows the preset, replaces it, or leaves this expert without one.
const prompt_note = computed(() => {
  const text = prompt_draft.value.trim();
  if (preset.value) return text ? t('保存到这张工作流卡片，Ctrl + Enter 保存') : t('留空使用软件预设');
  if (!text) return prompt_preset.value ? t('留空：这位专家不使用预设，也没有专属提示词') : t('留空表示不使用');
  if (text === prompt_preset.value.trim()) return t('与软件预设一致，预设更新时自动跟随');
  return prompt_preset.value ? t('已改写，不再跟随软件预设') : t('只发给这位专家，Ctrl + Enter 保存');
});
const prompt_source = computed(() => prompt_preset.value && prompt_draft.value.trim() !== prompt_preset.value.trim()
  ? { tag: t('软件预设'), text: prompt_preset.value, action: t('恢复预设') } : null);
// What the runner adds for this member, built by the runner's own function so the dialog never drifts from what is sent;
// values known only at delivery are placeholders. An API expert gets the skills as its system prompt instead.
const prompt_fixed = computed(() => {
  if (preset.value) return null;
  const adapter = profile.value.adapter;
  if (!adapter || adapter === "api") return null;
  // The local service runs on this computer, so its command name and the Windows read rule follow this browser's system.
  const windows = /Windows/.test(navigator.userAgent);
  const cli = windows && adapter !== "claude" ? "codiscuss.cmd" : "codiscuss";
  const read_rule = !windows ? "" : adapter === "codex_cli" ? READ_RULE : `（本机装有 rg 时附加）${READ_RULE}`;
  const { prompt, instructions } = free_task_text({ name: props.name, role: props.host ? "host" : "member", discussion: false,
    profile: { ...profile.value, cwd: view.value.launch.workspace?.cwd || profile.value.cwd }, cli, room: "{房间}",
    messages: "#{消息编号}", read_after: "{已读编号}", execution_id: "{执行编号}", task_path: "{任务文件}",
    // Only the CLIs get the credential bound to their process; the others name the file on each command.
    access_file: ["claude", "codex_cli", "antigravity_cli"].includes(adapter) ? "" : "{凭据文件}", read_rule });
  return { summary: t("程序固定附加的说明（只读）"), sections: [
    // The heading goes out only when there is an expert prompt to follow it, so it is described, not shown as sent text.
    { label: t('每次唤醒随消息发送；填了专属提示词时，后面另起一段“{heading}”再接它', { heading: EXPERT_PROMPT_HEADING }), text: prompt },
    { label: t("任务文件中的说明（由 AI 读取）"), text: instructions },
    { label: t("说明"), text: t("以上是房间未开讨论时的版本；开启讨论后改用讨论版说明。{…} 为每次执行时才确定的值。") },
  ] };
});

/** Edit in a dialog: the back has no room for a long text. */
function open_prompt() {
  prompt_draft.value = prompt_text.value;
  prompt_open.value = true;
}

/** Text equal to the preset is stored as following it, so later preset updates still reach this member. */
function save_prompt() {
  const text = prompt_draft.value.trim();
  write_setting("system_prompt", preset.value ? text : text === prompt_preset.value.trim() ? null : text);
  prompt_open.value = false;
}

/** Write either a library draft or this room's launch profile, never both. */
function write_setting(field, value) {
  if (preset.value) preset.value[field] = value;
  else bridge.write_launch(props.name, field, value);
}

/** A model change clears the old model's effort override in a portable card. */
function write_model(value) {
  if (!preset.value) return bridge.write_launch_model(props.name, value);
  write_setting("model", value === "__default__" ? "" : value);
  write_setting("effort", "");
}

/** Read a catalog with this card's effective profile without saving it to room settings. */
function load_models(force = false) {
  return bridge.load_launch_models(props.name, force, profile.value);
}

/** Restore the CLI defaults for this participant only. */
function reset_model() {
  write_setting("model", "");
  write_setting("effort", "");
}

/** Switch this card's delivery; every dialog showing the card shares this one rule. */
function choose_mode(option) {
  // The history window binds a conversation only when one is picked; closing it leaves the card as it was.
  if (option === HISTORY) { browsing.value = true; return; }
  if (resuming.value) bridge.write_launch(props.name, "session_id", null);
  if (option === "cli") bridge.default_launch_entry(props.name);
  // A manual card carries no description, not even a preset's; the room's member menu can add one later.
  if (option === "manual") bridge.write_description_draft(props.name, "");
  emit("mode", option);
}

/** Keep the delivery choices usable as one keyboard radio group. */
function choose_capability(event) {
  const keys = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
  if (!(event.key in keys) && !["Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const options = mode_options.value, index = options.indexOf(current_mode.value);
  const next = event.key === "Home" ? options[0] : event.key === "End" ? options.at(-1) : options[(index + keys[event.key] + options.length) % options.length];
  choose_mode(next);
  event.currentTarget.querySelector(`[data-mode="${next}"]`)?.focus();
}

/** Escape closes this face before it can close the surrounding create dialog. */
function escape(event) {
  if (!back.value) return;
  event.stopPropagation();
  event.preventDefault();
  cancel();
}

// Dropdowns of the back's selects render outside the card, so they count as inside.
const FLOATING_SELECTOR = "[role='listbox'], [role='menu'], [data-reka-popper-content-wrapper]";

/** Clicking anywhere outside the open back keeps its edits and returns to the front. */
function close_on_outside(event) {
  if (prompt_open.value || describing.value || naming.value || browsing.value || card.value?.contains(event.target) || event.target.closest?.(FLOATING_SELECTOR)) return;
  flip(false);
}
watch(back, (open) => {
  if (open) document.addEventListener("pointerdown", close_on_outside, true);
  else document.removeEventListener("pointerdown", close_on_outside, true);
});

// The flip always plays, even under prefers-reduced-motion: the user asked to keep it.
watch(back, (next) => angle.set(next ? BACK_ANGLE : 0));
// Prefetch as soon as the card can use a catalog, so flipping does not wait on a slow CLI query.
watch(() => [configurable.value, view.value.launch.available, profile.value.adapter],
  ([enabled, available]) => { if (enabled && available) load_models(); }, { immediate: true });
onBeforeUnmount(() => { document.removeEventListener("pointerdown", close_on_outside, true); stop_observing(); stop_settling(); angle.stop(); });
</script>

<template>
  <div ref="card" class="expert-card" :class="{ 'is-configurable': configurable, 'is-host': host, 'is-static': !automatic, 'is-manual': manual }"
    :data-identity="bridge.identities[name]?.style" :data-face="visible_back ? 'back' : 'front'" tabindex="-1" @keydown.esc="escape">
    <motion.div class="expert-card-turn" :style="{ rotateY: angle }">
      <div class="expert-card-face expert-card-front" :inert="visible_back" :aria-hidden="visible_back">
        <component :is="can_flip ? 'button' : 'div'" ref="front_button" :type="can_flip ? 'button' : undefined" class="expert-card-open" :class="{ 'is-static': !can_flip, 'has-modes': mode_options.length > 1 }"
          :aria-label="can_flip ? card_label : undefined" :title="can_flip ? t('点击翻面设置') : undefined" @click="flip(true)">
          <span class="expert-card-identity">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar expert-card-avatar" :class="bridge.identities[name]?.style" />
            <span class="expert-card-names">
              <span v-if="manual"><strong>{{ t('{value1}（手动）', { value1: bridge.display_name(name) }) }}</strong><span v-if="host && !hostable" class="expert-card-badge">{{ t('主持') }}</span></span>
              <span v-else><strong>{{ member_label }}</strong><span v-if="host && !hostable" class="expert-card-badge">{{ t('主持') }}</span></span>
              <small v-if="description && !preset" :title="description">{{ description }}</small>
            </span>
          </span>
          <!-- A workflow card (preset) is read for what it does, so its description fills the middle of the front. -->
          <p v-if="preset" class="expert-card-summary" :class="{ 'is-empty': !description }" :title="description">{{ description || t('还没有描述') }}</p>
          <dl class="expert-card-facts">
            <div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :class="fact.tone ? ['expert-card-status', `is-${fact.tone}`] : ''" :title="fact.value"><i v-if="fact.tone" aria-hidden="true" />{{ fact.value }}</dd></div>
          </dl>
          <div v-if="manual" class="expert-card-manual">
            <p>{{ t('会话自行注册后才算到场。') }}</p>
            <p v-if="manual_note">{{ manual_note }}</p>
          </div>
          <!-- Drawn like the start switch beside it and level with it, so the way to the settings is seen at a glance; beside
               three start choices its word shows only where the card leaves room (styles below), the card's tooltip says it. -->
          <span v-if="can_flip" class="expert-card-flip is-open" :class="{ 'is-tight': mode_options.length > 2 }"><UIcon name="i-lucide-settings-2" /><span class="expert-card-flip-label">{{ t('设置') }}</span></span>
        </component>
        <div v-if="mode_options.length > 1" class="expert-card-modes expert-card-front-modes" :class="{ 'is-dense': mode_options.length > 2 }" role="radiogroup" :aria-label="t('{value1} 启动方式', { value1: name })" @keydown="choose_capability">
          <button v-for="option in mode_options" :key="option" type="button" :title="MODE_TITLES[option]"
            role="radio" :aria-checked="current_mode === option" :tabindex="current_mode === option ? 0 : -1" :data-mode="option" @click="choose_mode(option)">{{ ACCESS_LABELS[option] }}</button>
        </div>
        <span class="expert-card-tools">
          <!-- A card with a back keeps the description beside the prompt there; one without a back has only the front. A manual card has none, as its settings live in the user's own session. -->
          <button v-if="!can_flip && !manual" type="button" :class="{ 'is-set': description }" :aria-label="t('编辑 {value1} 的名称与描述', { value1: name })" :title="describe_title" @click="describing = true"><UIcon name="i-lucide-user-pen" /></button>
          <button v-if="preset" type="button" :class="{ 'is-set': prompt_text }" :title="prompt_title" :aria-label="t('编辑 {value1} 的专属提示词', { value1: name })" @click="open_prompt"><UIcon name="i-lucide-scroll-text" /></button>
          <button v-if="hostable" type="button" class="expert-card-host" :aria-pressed="host" :aria-label="host ? t('{value1} 是主持人', { value1: name }) : t('设 {value1} 为主持人', { value1: name })" :title="host ? t('主持人') : t('设为主持人')" @click="emit('host')"><UIcon name="i-lucide-crown" /></button>
          <button type="button" :aria-label="t('移出 {value1}', { value1: name })" :title="t('移出')" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
        </span>
      </div>
      <div v-if="can_flip" class="expert-card-face expert-card-back" :inert="!visible_back" :aria-hidden="!visible_back">
        <!-- nowheel / nopan / nodrag: inside the workflow canvas the wheel and a finger scroll these settings instead of zooming, panning or dragging the card (Vue Flow skips such elements); no effect elsewhere. -->
        <div class="expert-card-back-body nowheel nopan nodrag">
        <div class="expert-card-heading"><strong>{{ member_label }}<span v-if="member_label !== name">{{ name }}</span><span>{{ t('设置') }}</span></strong>
          <span class="expert-card-heading-tools">
          <button type="button" class="expert-card-back-tool" :class="{ 'is-set': description }" :aria-label="t('编辑 {value1} 的名称与描述', { value1: name })" :title="describe_title" @click="describing = true"><UIcon name="i-lucide-user-pen" /></button>
          <button v-if="preset || profile.adapter" type="button" class="expert-card-back-tool" :class="{ 'is-set': prompt_text, 'is-own': prompt_own && prompt_text }" :title="prompt_title" :aria-label="t('编辑 {value1} 的专属提示词', { value1: name })" @click="open_prompt"><UIcon name="i-lucide-scroll-text" /></button>
          <UButton v-if="api_mode" icon="i-lucide-zap" :aria-label="t('检查 {value1} 的 API 配置', { value1: name })" :title="t('检查配置：发送一次极短请求，核对地址、密钥、协议与模型')" size="xs" :color="api_check.state === 'ok' ? 'success' : api_check.state === 'error' ? 'error' : 'neutral'" variant="ghost" :loading="api_check.state === 'loading'" :disabled="!profile.api_key_ref || !profile.model || !view.launch.available" @click="check_api" /></span></div>
        <div v-if="!preset && automatic && !restricted && entry_items.length > 1" class="expert-card-field">
          <span>{{ t('接入') }}</span><USelect :model-value="profile.adapter || ''" :items="entry_items" :placeholder="t('选择 API / App / CLI')" :aria-label="t('{value1} 软件入口', { value1: name })" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, 'adapter', $event)" />
        </div>
        <div v-for="item in restricted ? [] : connection" :key="item.field" class="expert-card-field">
          <span>{{ item.label }}</span><UInput :model-value="profile[item.field] || ''" :placeholder="item.placeholder" :aria-label="`${name} ${item.placeholder}`" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, item.field, $event)" />
        </div>
        <div v-if="sets_access" class="expert-card-field">
          <span>{{ t('项目') }}</span>
          <div class="expert-card-modes" role="radiogroup" :aria-label="t('{value1} 的项目文件权限', { value1: name })">
            <button v-for="option in access_options(profile.adapter, full_only)" :key="option.value" type="button" role="radio" :title="option.hint"
              :disabled="access_locked || option.disabled" :aria-checked="access === option.value" @click="write_setting('project_access', option.value)">{{ option.label }}</button>
          </div>
        </div>
        <ApiSettings v-if="api_mode" :name="name" />
        <template v-else-if="configurable && !connection.length">
          <div class="expert-card-field">
            <span>{{ t('模型') }}</span>
            <UInput v-if="preset_model_input" :model-value="profile.model || ''" :placeholder="t('留空使用默认模型')" :aria-label="t('{value1} 使用的模型', { value1: name })" size="xs" class="w-full" @update:model-value="write_model" />
            <div v-else class="model-picker"><USelect :model-value="profile.model || '__default__'" :items="models.items" :title="models.source" :ui="{ base: 'model-select', content: 'model-select-menu' }" :aria-label="t('{value1} 使用的模型', { value1: name })" size="xs" class="w-full" @update:model-value="write_model" /><ModelRefresh :loading="models.refreshing" :disabled="!view.launch.available" @refresh="load_models(true)" /></div>
          </div>
          <div v-if="models.loading || models.error" class="expert-card-catalog"><span>{{ models.loading ? t('正在读取软件模型列表…') : models.error }}</span><button v-if="!models.loading && models.error && view.launch.available" type="button" @click="load_models(true)">{{ t('重试') }}</button></div>
          <div v-if="effort_items" class="expert-card-effort">
            <EffortSlider :caption="t('强度')" :items="effort_items" :model-value="profile.effort || ''" :label="t('{value1} 的思考强度', { value1: name })" @update:model-value="write_setting('effort', $event)" />
          </div>
          <p v-else class="expert-card-note">{{ models.effort_note }}</p>
          <button type="button" class="expert-card-defaults" :title="t('留空使用 CLI 默认值')" :aria-label="t('恢复 {value1} 的默认模型与强度', { value1: name })" :disabled="!profile.model && !profile.effort" @click="reset_model">{{ t('恢复默认') }}</button>
        </template>
        <p v-else class="expert-card-note"><UIcon name="i-lucide-monitor" />{{ configuration_note }}</p>
        </div>
        <span class="expert-card-flip-actions">
          <template v-if="view.launch.available && !workflow && !preset">
            <button type="button" class="expert-card-flip is-cancel" :disabled="saving_preset" :aria-label="t('{value1}预设「{value2}」', { value1: own_preset ? t('更新') : t('存为'), value2: name })" :title="t('存下描述、提示词、项目权限、模型与强度，之后在“预设”行一键加入')" @click="save_preset">{{ saving_preset ? t('保存中…') : own_preset ? t('更新预设') : t('存为预设') }}</button>
          </template>
          <button type="button" class="expert-card-flip is-cancel" :aria-label="t('放弃 {value1} 的修改', { value1: name })" @click="cancel">{{ t('取消') }}</button>
          <button ref="back_button" type="button" class="expert-card-flip is-done" :aria-label="t('保存并返回 {value1} 角色卡片', { value1: name })" @click="flip(false)"><UIcon name="i-lucide-check" />{{ t('完成') }}</button>
        </span>
      </div>
    </motion.div>
    <SessionBrowser v-if="browse_adapter" v-model:open="browsing" :name="name" :adapter="browse_adapter" :directory="browse_directory" :selected="profile.session_id || ''" @pick="resume_session" />
    <MemberDescriptionDialog v-model:open="describing" :name="name" :platform="preset ? '' : bridge.default_name(bridge.platform_of(name))" :default_label="bridge.default_name(name)" :text="description" :label="preset ? preset.label || '' : bridge.label_draft(name)" :template="preset ? '' : bridge.description_template(name)" @save="save_description" />
    <MemberTextDialog v-model:open="prompt_open" v-model:draft="prompt_draft" :title="t('{value1} 的专属提示词', { value1: name })"
      :description="workflow ? t('来自工作流「{value1}」，每次执行时按工作流里的这张卡片发送；请在“工作流”一行点“编辑”修改，修改会作用于所有启用它的房间。', { value1: workflow }) : t('只发给这位专家，补充它的做法与偏好；不改变权限和技能规则。')" :label="t('{value1} 的专属提示词', { value1: name })"
      :placeholder="t('例如：回答先给结论，控制在三段以内。')" :max="MAX_EXPERT_PROMPT" :rows="8" :readonly="Boolean(workflow)"
      :note="workflow ? t('只读') : prompt_note" :source="prompt_source" :fixed="prompt_fixed" :changed="prompt_changed" @save="save_prompt">
    </MemberTextDialog>
    <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="naming" :title="t('存为专家预设')" :description="t('存下描述、提示词、项目权限、模型与强度，之后在“预设”行一键加入。')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <form class="expert-card-naming" @submit.prevent="save_named_preset">
          <UInput v-model="naming_draft" :maxlength="32" autofocus class="w-full" :aria-label="t('预设名称')" :placeholder="t('预设名称，如 评审官')" />
          <p>{{ naming_note }}</p>
          <div class="expert-card-naming-actions">
            <UButton :label="t('取消')" color="neutral" variant="ghost" @click="naming = false" />
            <UButton type="submit" :label="t('保存')" class="channel-primary-button" :disabled="naming_blank" :loading="saving_preset" />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.expert-card { min-width: 0; perspective: 900px; outline: none; container-type: inline-size; }
/* Both faces keep one size; long settings scroll inside the back while its actions stay in place.
   Perspective makes the turn read as a flip rather than a squeeze; the faces stay flat, and
   the hidden one is switched by data-face at 90°, where the card is edge-on. */
.expert-card-turn { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); height: 100cqi; }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 0; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.expert-card[data-face="front"] .expert-card-back, .expert-card[data-face="back"] .expert-card-front { visibility: hidden; }
.expert-card.is-host .expert-card-front { border-color: color-mix(in srgb, #e0b44a 45%, var(--ui-border)); }
.expert-card-front { position: relative; display: flex; flex-direction: column; }
.expert-card-back { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px 8px; transform: rotateY(180deg); }
.expert-card-back-body { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 2px; overflow-y: auto; scrollbar-width: thin; }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; min-width: 0; padding: 12px 12px 48px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-open.is-static { cursor: default; padding-bottom: 12px; }
.expert-card-open.has-modes { padding-bottom: 8px; }
.expert-card-front-modes { flex-shrink: 0; width: fit-content; margin: 0 0 10px 12px; }
.expert-card-front-modes button { flex: none; padding: 0 8px; white-space: nowrap; }
.expert-card-front-modes.is-dense button { padding: 0 6px; }
.expert-card-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 76px; }
.expert-card-avatar { flex-shrink: 0; width: 26px; height: 26px; font-size: 10px; }
.expert-card-names { display: grid; min-width: 0; }
.expert-card-names > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The description reads as the member's subtitle: one line here, the full text on hover and in the dialog. */
.expert-card-names > small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
/* A workflow card's description: as many lines as fit between the name and the facts, the full text on hover. */
.expert-card-summary { display: -webkit-box; flex: 1; min-height: 0; margin: 0; overflow: hidden; color: var(--ui-text-toned); font-size: 12px; line-height: 18px;
  -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow-wrap: anywhere; }
.expert-card-summary.is-empty { color: var(--ui-text-dimmed); }
.expert-card-identity strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.expert-card-badge { flex-shrink: 0; padding: 0 5px; border-radius: 4px; background: color-mix(in srgb, #e0b44a 16%, transparent); color: #e0b44a; font-size: 10px; font-weight: 500; line-height: 16px; }
.expert-card-facts .expert-card-status > i { display: inline-block; margin: 0 5px 1px 0; vertical-align: middle; width: 5px; height: 5px; border-radius: 50%; background: var(--ui-text-dimmed); }
.expert-card-facts .expert-card-status.is-ready > i { background: var(--ui-success, #3fb27f); }
.expert-card-facts .expert-card-status.is-warn > i { background: var(--ui-warning, #e0a33a); }
.expert-card-facts { display: grid; gap: 4px; width: 100%; margin: 0; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); font-size: 11px; }
.expert-card-facts > div { display: grid; grid-template-columns: 3em minmax(0, 1fr); gap: 8px; }
.expert-card-facts dt { color: var(--ui-text-dimmed); white-space: nowrap; }
.expert-card-facts dd { overflow: hidden; margin: 0; color: var(--ui-text-toned); white-space: nowrap; text-overflow: ellipsis; }
.expert-card-flip { position: absolute; right: 8px; bottom: 8px; display: inline-flex; align-items: center; gap: 4px; min-height: 22px; padding: 2px 6px; border-radius: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-flip > span:not(.expert-card-flip-label) { width: 12px; height: 12px; }
.expert-card-open:hover .expert-card-flip, .expert-card-flip.is-done { color: var(--channel-accent); }
.expert-card-flip.is-done:hover, .expert-card-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.expert-card-flip-actions { display: flex; flex-shrink: 0; justify-content: flex-end; gap: 2px; margin-right: -4px; }
.expert-card-flip-actions > .expert-card-flip { position: static; }
.expert-card-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
/* The front's settings button has the start switch's height and fill (.expert-card-modes) and sits on its line. */
.expert-card-flip.is-open { right: 12px; bottom: 10px; min-height: 28px; padding: 0 10px; border-radius: 5px; background: var(--ui-bg-muted); color: var(--ui-text-toned); font-weight: 500; }
.expert-card-flip.is-open > span:not(.expert-card-flip-label) { color: var(--channel-accent); }
.expert-card-flip.is-open.is-tight { padding: 0 8px; }
/* Three start choices take 180px in Chinese and 218px in English: the word fits beside them only on a Chinese card at
   least 270px wide (measured 2026-11-16 at 1440 × 900); otherwise the same button shows its icon alone. */
:lang(en) .expert-card-flip.is-open.is-tight > .expert-card-flip-label { display: none; }
:lang(en) .expert-card-front-modes.is-dense button { padding: 0 4px; }
@container (max-width: 269px) { .expert-card-flip.is-open.is-tight > .expert-card-flip-label { display: none; } }
.expert-card-open:hover .expert-card-flip.is-open { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-tools { position: absolute; top: 9px; right: 8px; display: flex; gap: 2px; }
.expert-card-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.expert-card-tools > button > span { width: 13px; height: 13px; }
.expert-card-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-tools > .expert-card-host[aria-pressed="true"] { color: #e0b44a; }
.expert-card-tools > .is-set { color: var(--ui-text-muted); }
.expert-card-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.expert-card-heading strong { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 12px; font-weight: 600; white-space: nowrap; }
.expert-card-heading strong > span { font-size: 10px; font-weight: 400; color: var(--ui-text-muted); }
.expert-card-field { display: grid; grid-template-columns: 26px minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-catalog { display: flex; align-items: baseline; gap: 8px; margin: -5px 0 0 34px; color: var(--ui-text-dimmed); font-size: 10px; overflow-wrap: anywhere; }
.expert-card-catalog > span { flex: 1; }
.expert-card-catalog > button { flex-shrink: 0; color: var(--channel-accent); }
.expert-card-defaults { position: absolute; left: 8px; bottom: 8px; min-height: 22px; padding: 2px 4px; border-radius: 4px; color: var(--ui-text-muted); font-size: 11px; }
.expert-card-defaults:hover:not(:disabled) { color: var(--channel-accent); }
.expert-card-defaults:disabled { opacity: .4; }
/* Same shape as the front's tools: dimmed when unset, brighter once set; a prompt the user wrote is accented. */
.expert-card-heading-tools { display: flex; flex-shrink: 0; align-items: center; gap: 2px; margin: -2px 0; }
.expert-card-back-tool { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.expert-card-back-tool > span { width: 13px; height: 13px; }
.expert-card-back-tool.is-set { color: var(--ui-text-muted); }
.expert-card-back-tool.is-own { color: var(--channel-accent); }
.expert-card-back-tool:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.expert-card-naming { display: grid; gap: 8px; }
.expert-card-naming > p { margin: -2px 0 0; color: var(--ui-text-dimmed); font-size: 11px; }
.expert-card-naming-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.expert-card-note { display: flex; gap: 6px; margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.7; }
/* A manual card is set by the user's own AI session, not this page: a dashed frame and a system-given name. */
.expert-card.is-manual .expert-card-face { border-style: dashed; }
.expert-card-manual { display: grid; gap: 4px; width: 100%; color: var(--ui-text-muted); font-size: 11px; line-height: 1.7; }
.expert-card-manual > p { margin: 0; }
.expert-card-note > span { flex-shrink: 0; width: 13px; height: 13px; margin-top: 3px; }
/* A member with a nickname also shows its ID, which AI messages, @ and records use. */
/* Narrow card (two per row on a phone): the name moves under the avatar so the corner tools leave it the full
   width, the card grows by that line, and 恢复默认 joins the settings flow instead of sitting under the actions. */
@container (max-width: 220px) {
  .expert-card-turn { height: 272px; }
  .expert-card-identity { flex-wrap: wrap; row-gap: 6px; padding-right: 0; }
  .expert-card-names { flex-basis: 100%; }
  .expert-card-defaults { position: static; align-self: flex-start; margin-left: -4px; }
}
</style>

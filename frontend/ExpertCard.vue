<script setup>
/** Show one participant instance and its actual software configuration boundary. */
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { motion, useSpring } from "motion-v";
import EffortSlider from "./EffortSlider.vue";
import ApiSettings from "./ApiSettings.vue";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";
import MemberTextDialog from "./MemberTextDialog.vue";
import { EXPERT_PROMPT_HEADING, EXPERT_PROMPT_PRESETS, MAX_EXPERT_PROMPT, READ_RULE, access_label, access_options, free_task_text } from "../runner/expert_prompts.mjs";

const props = defineProps({
  name: { type: String, required: true },
  mode: { type: String, default: "" },
  // Delivery options this card offers: cli (woken by the local service), manual or online; empty when fixed.
  choices: { type: Array, default: () => [] },
  status: { type: Object, required: true },
  host: Boolean,
  hostable: Boolean,
  // True where the form picks a host, so the card states whether this one may host.
  hosting: Boolean,
  // An existing conversation to resume; null where the form offers no such choice (the invite dialog does).
});
const emit = defineEmits(["remove", "mode", "host"]);
const { view, bridge } = inject("discussion");
// Feel.words("smooth, crisp"): 2.615 Hz reads as a deliberate turn; ζ .96 avoids bounce.
// Unit mass: this is a button-controlled angular spring, with no drag-weight effect.
const FLIP_SPRING = { mass: 1, stiffness: 270.0323764138049, damping: 31.550710806760762 };
const BACK_ANGLE = 180;
const angle = useSpring(0, FLIP_SPRING);
const card = ref(null), front_button = ref(null), back_button = ref(null);
const back = ref(false), visible_back = ref(false);
const profile = computed(() => view.value.launch.profiles[props.name] || {});
const entry_items = computed(() => bridge.launch_clients[props.name] || []);
// Manual start needs a local AI session; a platform reachable only through its API cannot offer it.
const offered = computed(() => props.choices.filter((option) => option !== "manual" || entry_items.value.some((item) => item.value !== "api")));
const automatic = computed(() => props.mode === "cli");
// Short labels for the front control; the 启动 row spells out what each one means.
const ACCESS_LABELS = { cli: "程序启动", manual: "手动启动", online: "网页" };
const api_mode = computed(() => automatic.value && profile.value.adapter === "api");
const api_check = ref({ state: "", message: "" });
// A previous check result no longer applies once any checked field changes.
watch(() => [profile.value.base_url, profile.value.api_protocol, profile.value.model, profile.value.api_key_ref], () => { api_check.value = { state: "", message: "" }; });

/** Send one tiny request through the local service with the current address, key, protocol and model. */
async function check_api() {
  api_check.value = { state: "loading", message: "" };
  try { await bridge.check_launch_api(props.name); api_check.value = { state: "ok", message: "检查通过：模型已响应" }; }
  catch (failure) { api_check.value = { state: "error", message: failure.message }; }
}
// Without the local service here, the paired computer wakes the member with the software configured there.
const relay_client = computed(() => !view.value.launch.available && view.value.launch.relay?.clients[bridge.platform_of(props.name)]);
const entry_label = computed(() => entry_items.value.find((item) => item.value === (relay_client.value || profile.value.adapter))?.label
  || (view.value.launch.relay && !view.value.launch.available ? "电脑上未配置" : "待选择 App / CLI"));
const manual = computed(() => props.mode === "manual");
// A manual card has nothing to configure, so the front states what testing showed about taking over a window that is already open.
const MANUAL_NOTES = {
  Codex: "已实测：消息实时显示在已开窗口。",
  Gemini: "已实测：App 会话实时显示；agy CLI 窗口需重启才显示后台发言。",
  Claude: "已实测：原窗口开着时消息实时送入；关闭后在后台续接同一会话。",
};
const manual_note = computed(() => MANUAL_NOTES[bridge.platform_of(props.name)] || "");
const resuming = computed(() => Boolean(profile.value.session_id));
// Software paths and models typed here belong to this browser's computer, so a relayed member keeps the paired computer's settings.
const can_flip = computed(() => automatic.value && entry_items.value.length > 0 && !(view.value.launch.relay && !view.value.launch.available));
const card_label = computed(() => props.mode === "online" ? `设置 ${props.name} 的参与方式` : `配置 ${props.name} 的启动方式`);
const models = computed(() => bridge.launch_model_state(props.name, view.value.launch));
const configurable = computed(() => Boolean(automatic.value && models.value.supported));
const configuration_note = computed(() => configurable.value && connection.value.length ? "补齐上方连接后，可在这里选择模型与思考强度。"
  : profile.value.adapter ? "模型与思考强度在 App 原聊天中选择，本页不覆盖 App 设置。" : "先选择软件入口。支持启动参数的 CLI 可在这里设置模型与强度。");
const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra" };
const effort_items = computed(() => {
  const levels = models.value.efforts;
  return levels?.length ? [{ label: "默认强度", value: "" }, ...levels.map((level) => ({ label: EFFORT_LABELS[level] || level, value: level }))] : null;
});
// An empty choice shows what the software's own settings select; only when they say nothing does the software decide.
// agy's default effort belongs to its default model, so a chosen model keeps its own default instead.
const default_effort = computed(() => profile.value.adapter === "antigravity_cli" && profile.value.model ? "" : models.value.defaults?.effort);
const effort_label = computed(() => profile.value.effort ? EFFORT_LABELS[profile.value.effort] || profile.value.effort
  : default_effort.value ? EFFORT_LABELS[default_effort.value] || default_effort.value
  : "默认");
// The front lists the read-only configuration; strength appears only where this page sets it.
// Room speech and project files are separate: only woken CLIs get a project choice from this page,
// Apps and manual sessions keep their own settings, and API or web members never see project files.
const sets_access = computed(() => automatic.value && bridge.launch_can_set_access(props.name, view.value.launch));
const no_files = computed(() => props.mode === "online" || automatic.value && profile.value.adapter === "api");
const local_connection = computed(() => automatic.value && profile.value.adapter !== "api");
const access = computed(() => profile.value.project_access || view.value.launch.workspace?.project_access || "read");
// Who starts the member and whether it can host: the two things the delivery choice changes and a user must see before inviting.
const launch_fact = computed(() => props.mode === "online" ? "你转发回答 · 网页聊天"
  : props.mode === "manual" ? "你来启动 · 自主发言"
  : `程序启动 · ${resuming.value ? "续接会话" : profile.value.adapter === "api" ? "调用 API" : "新会话"}`);
const host_fact = computed(() => props.mode === "online" ? "不可（网页只读）" : "不可（须本机唤醒）");
// The front states only what is decided or an exception; placeholders such as "set in the original software" stay off it.
const facts = computed(() => [
  ...automatic.value ? [{ label: "状态", value: props.status.text, tone: props.status.tone }] : [],
  { label: "启动", value: launch_fact.value },
  ...automatic.value ? [{ label: "软件", value: entry_label.value }] : [],
  ...configurable.value ? [{ label: "模型", value: profile.value.model || models.value.defaults?.model || "软件默认模型" }] : [],
  ...configurable.value && profile.value.adapter !== "api" ? [{ label: "强度", value: effort_label.value }] : [],
  ...sets_access.value ? [{ label: "项目", value: access_label(access.value) }] : no_files.value ? [{ label: "项目", value: "不访问" }] : [],
  // The crown already offers hosting and the badge names the host, so only the refusal needs a row.
  ...props.hosting && !props.host && !props.hostable ? [{ label: "主持", value: host_fact.value }] : [],
]);
// Ask only for connection values that are missing; a field stays while the back is open so typing does not hide it.
const CONNECTION_FIELDS = { executable: { label: "路径", placeholder: "可执行文件完整路径" },
  ipc_directory: { label: "IPC", placeholder: "Sidecar IPC 目录" }, source_thread_id: { label: "聊天", placeholder: "Codex App 来源聊天 ID" } };
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
  if (next && !back.value) { opened_with = { profile: JSON.parse(JSON.stringify(profile.value)), mode: props.mode }; }
  back.value = next;
}

/** Discard edits made since the back opened, then return to the front. */
function cancel() {
  if (opened_with) {
    bridge.restore_launch_profile(props.name, opened_with.profile);
    if (opened_with.mode !== props.mode) emit("mode", opened_with.mode);
    opened_with = null;
  }
  flip(false);
}

// The description says what this member is good at, for the scheduler and the host; any delivery mode may have one.
// Drafts live in the bridge, so reading the published view ties this to each update.
const description = computed(() => view.value && bridge.description_draft(props.name).trim());
const describing = ref(false);
const describe_title = computed(() => description.value ? `描述：${description.value}` : "添加描述：擅长什么、适合分到什么工作");

/** Keep the card's description for the room or invitation, and optionally as this platform's default. */
function save_description({ text, as_template }) {
  bridge.write_description_draft(props.name, text);
  if (as_template) bridge.save_description_template(props.name, text);
  describing.value = false;
}

// A preset keeps this card's description, prompt, project access, model and effort under its name for later rooms.
const own_preset = computed(() => view.value.launch.presets.some((preset) => preset.name === props.name));
// A card not added from its own preset is saved under a name the user gives; the platform prefix is only a suggestion.
const naming = ref(false), naming_draft = ref("");
const naming_text = computed(() => naming_draft.value.trim());
const naming_blank = computed(() => !naming_text.value || naming_text.value === `${bridge.platform_of(props.name)}-`);
const naming_id = computed(() => view.value && !naming_blank.value ? bridge.preset_identity(props.name, naming_text.value) : "");
const naming_note = computed(() => {
  if (!naming_id.value) return "预设名称会显示在“预设”行和房间里，可以不带平台前缀。";
  const existing = bridge.expert_presets().find((preset) => preset.name === naming_id.value);
  const id_note = naming_id.value === naming_text.value ? "" : `成员 ID：${naming_id.value}`;
  return [id_note, existing ? `将覆盖已有预设「${existing.label || existing.name}」` : ""].filter(Boolean).join(" · ") || "预设名称即成员 ID";
});

/** Update the card's own preset in place; any other card asks for a name first. */
function save_preset() {
  if (own_preset.value) return bridge.save_expert_preset(props.name);
  // Suggest the first numbered name that no saved preset holds yet.
  const taken = new Set(bridge.expert_presets().map((preset) => preset.name));
  const platform = bridge.platform_of(props.name);
  let number = 1;
  while (taken.has(bridge.preset_identity(props.name, `${platform}-${number}`))) number += 1;
  naming_draft.value = `${platform}-${number}`;
  naming.value = true;
}

/** Save under the typed name and close. */
async function save_named_preset() {
  if (naming_blank.value) return;
  await bridge.save_expert_preset(props.name, naming_text.value);
  naming.value = false;
}

// The expert prompt adds guidance for this member alone; its own text, even empty, replaces the software's preset.
const prompt_preset = computed(() => EXPERT_PROMPT_PRESETS[profile.value.adapter] || "");
const prompt_own = computed(() => Object.hasOwn(profile.value, "system_prompt"));
const prompt_text = computed(() => (prompt_own.value ? profile.value.system_prompt : prompt_preset.value).trim());
// The back has no room for a row, so the heading carries an icon whose tooltip states the prompt's source and first line.
const prompt_title = computed(() => !prompt_text.value ? "专属提示词：未设置，点击添加"
  : `专属提示词（${prompt_own.value ? "自定义" : "软件预设"}）：${prompt_text.value.split("\n")[0]}`);
const prompt_open = ref(false), prompt_draft = ref("");
const prompt_changed = computed(() => prompt_draft.value.trim() !== prompt_text.value);
// The dialog says live whether the text being typed still follows the preset, replaces it, or leaves this expert without one.
const prompt_note = computed(() => {
  const text = prompt_draft.value.trim();
  if (!text) return prompt_preset.value ? "留空：这位专家不使用预设，也没有专属提示词" : "留空表示不使用";
  if (text === prompt_preset.value.trim()) return "与软件预设一致，预设更新时自动跟随";
  return prompt_preset.value ? "已改写，不再跟随软件预设" : "只发给这位专家，Ctrl + Enter 保存";
});
const prompt_source = computed(() => prompt_preset.value && prompt_draft.value.trim() !== prompt_preset.value.trim()
  ? { tag: "软件预设", text: prompt_preset.value, action: "恢复预设" } : null);
// What the runner adds for this member, built by the runner's own function so the dialog never drifts from what is sent;
// values known only at delivery are placeholders. An API expert gets the skills as its system prompt instead.
const prompt_fixed = computed(() => {
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
  return { summary: "程序固定附加的说明（只读）", sections: [
    // The heading goes out only when there is an expert prompt to follow it, so it is described, not shown as sent text.
    { label: `每次唤醒随消息发送；填了专属提示词时，后面另起一段“${EXPERT_PROMPT_HEADING}”再接它`, text: prompt },
    { label: "任务文件中的说明（由 AI 读取）", text: instructions },
    { label: "说明", text: "以上是自由协作时的版本；房间开启讨论后改用讨论版说明。{…} 为每次执行时才确定的值。" },
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
  bridge.write_launch(props.name, "system_prompt", text === prompt_preset.value.trim() ? null : text);
  prompt_open.value = false;
}

/** Restore the CLI defaults for this participant only. */
function reset_model() {
  bridge.write_launch(props.name, "model", "");
  bridge.write_launch(props.name, "effort", "");
}

/** Switch this card's delivery; every dialog showing the card shares this one rule. */
function choose_mode(option) {
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
  const options = offered.value, index = options.indexOf(props.mode);
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
  if (prompt_open.value || describing.value || naming.value || card.value?.contains(event.target) || event.target.closest?.(FLOATING_SELECTOR)) return;
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
  ([enabled, available]) => { if (enabled && available) bridge.load_launch_models(props.name); }, { immediate: true });
onBeforeUnmount(() => { document.removeEventListener("pointerdown", close_on_outside, true); stop_observing(); stop_settling(); angle.stop(); });
</script>

<template>
  <div ref="card" class="expert-card" :class="{ 'is-configurable': configurable, 'is-host': host, 'is-static': !automatic, 'is-manual': manual }"
    :data-identity="bridge.identities[name]?.style" :data-face="visible_back ? 'back' : 'front'" tabindex="-1" @keydown.esc="escape">
    <motion.div class="expert-card-turn" :style="{ rotateY: angle }">
      <div class="expert-card-face expert-card-front" :inert="visible_back" :aria-hidden="visible_back">
        <component :is="can_flip ? 'button' : 'div'" ref="front_button" :type="can_flip ? 'button' : undefined" class="expert-card-open" :class="{ 'is-static': !can_flip, 'has-modes': offered.length > 1 }"
          :aria-label="can_flip ? card_label : undefined" :title="can_flip ? '点击翻面设置' : undefined" @click="flip(true)">
          <span class="expert-card-identity">
            <UAvatar :src="bridge.identities[name]?.icon" :text="bridge.identities[name]?.initials" :alt="name" size="sm" class="channel-avatar expert-card-avatar" :class="bridge.identities[name]?.style" />
            <span class="expert-card-names">
              <span v-if="manual"><strong :title="name">{{ bridge.display_name(name) }}（手动）</strong><span v-if="host && !hostable" class="expert-card-badge">主持</span></span>
              <span v-else><strong :title="bridge.member_label(name) === name ? undefined : name">{{ bridge.member_label(name) }}</strong><span v-if="host && !hostable" class="expert-card-badge">主持</span></span>
              <small v-if="description" :title="description">{{ description }}</small>
            </span>
          </span>
          <dl class="expert-card-facts">
            <div v-for="fact in facts" :key="fact.label"><dt>{{ fact.label }}</dt><dd :class="fact.tone ? ['expert-card-status', `is-${fact.tone}`] : ''" :title="fact.value"><i v-if="fact.tone" aria-hidden="true" />{{ fact.value }}</dd></div>
          </dl>
          <div v-if="manual" class="expert-card-manual">
            <p>会话自行注册后才算到场。</p>
            <p v-if="manual_note">{{ manual_note }}</p>
          </div>
          <span v-if="can_flip" class="expert-card-flip"><UIcon name="i-lucide-settings-2" />设置</span>
        </component>
        <div v-if="offered.length > 1" class="expert-card-modes expert-card-front-modes" role="radiogroup" :aria-label="`${name} 启动方式`" @keydown="choose_capability">
          <button v-for="option in offered" :key="option" type="button"
            role="radio" :aria-checked="mode === option" :tabindex="mode === option ? 0 : -1" :data-mode="option" @click="choose_mode(option)">{{ ACCESS_LABELS[option] }}</button>
        </div>
        <span class="expert-card-tools">
          <!-- A card with a back keeps the description beside the prompt there; one without a back has only the front. A manual card has none, as its settings live in the user's own session. -->
          <button v-if="!can_flip && !manual" type="button" :class="{ 'is-set': description }" :aria-label="`编辑 ${name} 的描述`" :title="describe_title" @click="describing = true"><UIcon name="i-lucide-user-pen" /></button>
          <button v-if="hostable" type="button" class="expert-card-host" :aria-pressed="host" :aria-label="host ? `${name} 是主持人` : `设 ${name} 为主持人`" :title="host ? '主持人' : '设为主持人'" @click="emit('host')"><UIcon name="i-lucide-crown" /></button>
          <button type="button" :aria-label="`移出 ${name}`" title="移出" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
        </span>
      </div>
      <div v-if="can_flip" class="expert-card-face expert-card-back" :inert="!visible_back" :aria-hidden="!visible_back">
        <div class="expert-card-back-body">
        <div class="expert-card-heading"><strong>{{ bridge.member_label(name) }}<span>设置</span></strong>
          <span class="expert-card-heading-tools">
          <button type="button" class="expert-card-back-tool" :class="{ 'is-set': description }" :aria-label="`编辑 ${name} 的描述`" :title="describe_title" @click="describing = true"><UIcon name="i-lucide-user-pen" /></button>
          <button v-if="profile.adapter" type="button" class="expert-card-back-tool" :class="{ 'is-set': prompt_text, 'is-own': prompt_own && prompt_text }" :title="prompt_title" :aria-label="`编辑 ${name} 的专属提示词`" @click="open_prompt"><UIcon name="i-lucide-scroll-text" /></button>
          <UButton v-if="api_mode" icon="i-lucide-zap" :aria-label="`检查 ${name} 的 API 配置`" title="检查配置：发送一次极短请求，核对地址、密钥、协议与模型" size="xs" :color="api_check.state === 'ok' ? 'success' : api_check.state === 'error' ? 'error' : 'neutral'" variant="ghost" :loading="api_check.state === 'loading'" :disabled="!profile.api_key_ref || !profile.model || !view.launch.available" @click="check_api" /></span></div>
        <p v-if="api_mode && api_check.message" :role="api_check.state === 'error' ? 'alert' : 'status'" class="expert-card-check">{{ api_check.message }}</p>
        <div v-if="automatic && entry_items.length > 1" class="expert-card-field">
          <span>接入</span><USelect :model-value="profile.adapter || ''" :items="entry_items" placeholder="选择 API / App / CLI" :aria-label="`${name} 软件入口`" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, 'adapter', $event)" />
        </div>
        <div v-for="item in connection" :key="item.field" class="expert-card-field">
          <span>{{ item.label }}</span><UInput :model-value="profile[item.field] || ''" :placeholder="item.placeholder" :aria-label="`${name} ${item.placeholder}`" size="xs" class="w-full" @update:model-value="bridge.write_launch(name, item.field, $event)" />
        </div>
        <div v-if="sets_access" class="expert-card-field">
          <span>项目</span>
          <div class="expert-card-modes" role="radiogroup" :aria-label="`${name} 的项目文件权限`">
            <button v-for="option in access_options(profile.adapter)" :key="option.value" type="button" role="radio" :title="option.hint"
              :disabled="option.disabled" :aria-checked="access === option.value" @click="bridge.write_launch(name, 'project_access', option.value)">{{ option.label }}</button>
          </div>
        </div>
        <ApiSettings v-if="api_mode" :name="name" />
        <template v-else-if="configurable && !connection.length">
          <div class="expert-card-field">
            <span>模型</span><USelect :model-value="profile.model || '__default__'" :items="models.items" :title="models.source" :aria-label="`${name} 使用的模型`" size="xs" class="w-full" @update:model-value="bridge.write_launch_model(name, $event)" />
          </div>
          <div v-if="models.loading || models.error" class="expert-card-catalog"><span>{{ models.loading ? '正在读取软件模型列表…' : models.error }}</span><button v-if="!models.loading && models.error && view.launch.available" type="button" @click="bridge.load_launch_models(name, true)">重试</button></div>
          <div v-if="effort_items" class="expert-card-effort">
            <EffortSlider caption="强度" :items="effort_items" :model-value="profile.effort || ''" :label="`${name} 的思考强度`" @update:model-value="bridge.write_launch(name, 'effort', $event)" />
          </div>
          <p v-else class="expert-card-note">{{ models.effort_note }}</p>
          <button type="button" class="expert-card-defaults" title="留空使用 CLI 默认值" :aria-label="`恢复 ${name} 的默认模型与强度`" :disabled="!profile.model && !profile.effort" @click="reset_model">恢复默认</button>
        </template>
        <p v-else class="expert-card-note"><UIcon :name="mode === 'online' ? 'i-lucide-globe' : 'i-lucide-monitor'" />{{ configuration_note }}</p>
        </div>
        <span class="expert-card-flip-actions">
          <template v-if="view.launch.available">
            <button v-if="own_preset" type="button" class="expert-card-flip is-cancel" :aria-label="`删除预设「${name}」`" title="删除预设" @click="bridge.delete_expert_preset(name)"><UIcon name="i-lucide-trash-2" /></button>
            <button type="button" class="expert-card-flip is-cancel" :aria-label="`${own_preset ? '更新' : '存为'}预设「${name}」`" title="存下描述、提示词、项目权限、模型与强度，之后在“预设”行一键加入" @click="save_preset">{{ own_preset ? '更新预设' : '存为预设' }}</button>
          </template>
          <button type="button" class="expert-card-flip is-cancel" :aria-label="`放弃 ${name} 的修改`" @click="cancel">取消</button>
          <button ref="back_button" type="button" class="expert-card-flip is-done" :aria-label="`保存并返回 ${name} 角色卡片`" @click="flip(false)"><UIcon name="i-lucide-check" />完成</button>
        </span>
      </div>
    </motion.div>
    <MemberDescriptionDialog v-model:open="describing" :name="name" :platform="bridge.platform_of(name)" :text="description" :template="bridge.description_template(name)" @save="save_description" />
    <MemberTextDialog v-model:open="prompt_open" v-model:draft="prompt_draft" :title="`${name} 的专属提示词`"
      description="只发给这位专家，补充它的做法与偏好；不改变权限和技能规则。" :label="`${name} 的专属提示词`"
      placeholder="例如：回答先给结论，控制在三段以内。" :max="MAX_EXPERT_PROMPT" :rows="8"
      :note="prompt_note" :source="prompt_source" :fixed="prompt_fixed" :changed="prompt_changed" @save="save_prompt" />
    <UModal v-model:open="naming" title="存为专家预设" description="存下描述、提示词、项目权限、模型与强度，之后在“预设”行一键加入。" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
      <template #body>
        <form class="expert-card-naming" @submit.prevent="save_named_preset">
          <UInput v-model="naming_draft" :maxlength="32" autofocus class="w-full" aria-label="预设名称" placeholder="预设名称，如 评审官" />
          <p>{{ naming_note }}</p>
          <div class="expert-card-naming-actions">
            <UButton label="取消" color="neutral" variant="ghost" @click="naming = false" />
            <UButton type="submit" label="保存" class="channel-primary-button" :disabled="naming_blank" />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
.expert-card { min-width: 0; perspective: 900px; outline: none; }
/* Both faces keep one size; long settings scroll inside the back while its actions stay in place.
   Perspective makes the turn read as a flip rather than a squeeze; the faces stay flat, and
   the hidden one is switched by data-face at 90°, where the card is edge-on. */
.expert-card-turn { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); height: 240px; }
.expert-card-face { grid-area: 1 / 1; min-width: 0; min-height: 0; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.expert-card[data-face="front"] .expert-card-back, .expert-card[data-face="back"] .expert-card-front { visibility: hidden; }
.expert-card.is-host .expert-card-front { border-color: color-mix(in srgb, #e0b44a 45%, var(--ui-border)); }
.expert-card-front { position: relative; display: flex; flex-direction: column; }
.expert-card-back { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 10px 12px 8px; transform: rotateY(180deg); }
.expert-card-back-body { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 2px; overflow-y: auto; scrollbar-width: thin; }
.expert-card:hover .expert-card-face { border-color: var(--ui-border-accented); }
.expert-card-open { display: flex; flex: 1; flex-direction: column; gap: 10px; width: 100%; min-width: 0; padding: 12px 12px 30px; text-align: left; border-radius: inherit; outline: none; }
.expert-card-open.is-static { cursor: default; padding-bottom: 12px; }
.expert-card-open.has-modes { padding-bottom: 8px; }
.expert-card-front-modes { flex-shrink: 0; width: fit-content; margin: 0 0 10px 12px; }
.expert-card-front-modes button { flex: none; padding: 0 8px; white-space: nowrap; }
.expert-card-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; padding-right: 76px; }
.expert-card-avatar { flex-shrink: 0; width: 26px; height: 26px; font-size: 10px; }
.expert-card-names { display: grid; min-width: 0; }
.expert-card-names > span { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The description reads as the member's subtitle: one line here, the full text on hover and in the dialog. */
.expert-card-names > small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
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
.expert-card-flip > span { width: 12px; height: 12px; }
.expert-card-open:hover .expert-card-flip, .expert-card-flip.is-done { color: var(--channel-accent); }
.expert-card-flip.is-done:hover, .expert-card-flip.is-cancel:hover { background: var(--ui-bg-accented); }
.expert-card-flip-actions { display: flex; flex-shrink: 0; justify-content: flex-end; gap: 2px; margin-right: -4px; }
.expert-card-flip-actions > .expert-card-flip { position: static; }
.expert-card-flip.is-cancel:hover { color: var(--ui-text-highlighted); }
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
.expert-card-check { margin: -4px 0 0; color: var(--ui-text-muted); font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
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
@media (pointer: coarse) {
  .expert-card-flip, .expert-card-defaults, .expert-card-tools > button, .expert-card-back-tool { min-width: 44px; min-height: 44px; }
  .expert-card-turn { height: 262px; }
  .expert-card-tools { top: 4px; right: 4px; }
  .expert-card-identity { padding-right: 136px; }
  .expert-card-modes button { min-height: 44px; }
}
</style>

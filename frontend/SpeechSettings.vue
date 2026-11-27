<script setup>
/**
 * Speech settings kept by the local service: read-aloud uses the chosen service (the speech model on this computer,
 * Volcengine, Aliyun, Azure or OpenAI), each with its own key and voices; voice input chooses its own service (Volcengine
 * or OpenAI with the key of its reading part, or the recognizer on this computer). Keys never come back to the page; a local service's token is saved by its
 * setup skill, so it asks for none.
 */
import { computed, inject, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import { request_tts } from "./read-aloud.js";
import ConfirmDialog from "./ConfirmDialog.vue";
import { t } from './i18n.js';

const { bridge } = inject("discussion");
const SAVED_MARK = "••••••••••••";
const PREVIEW_TEXT = "你好，我会用这个声音为你朗读房间里的消息。";
const rates = [{ value: -20, label: "0.8×" }, { value: 0, label: "1×" }, { value: 20, label: "1.2×" }, { value: 50, label: "1.5×" }, { value: 100, label: "2×" }];
const settings = reactive({ provider: "volcengine", speech_rate: 0, providers: {}, catalog: [], api_key_ref: "", stt_provider: "volcengine", stt_catalog: [], stt_key_ref: "" });
// One voice per AI platform; members of an unset platform, the user and program messages use the default voice.
const platforms = Object.keys(bridge.launch_clients).map((name) => ({ name, label: bridge.identities[name]?.label || name }));
// Key of the project-file voice row, apart from platform names.
const FILE_KEY = ":file";
// Key of the default-voice row for a playing sample, apart from platform names and the file row.
const GENERAL_KEY = ":general";
const loaded = ref(false), unavailable = ref(""), busy = ref("");
// The row whose sample is playing (its button turns into stop) and that sample's audio.
const playing = ref("");
let sample_audio = null;
// A newly typed key per service, cleared once stored.
const typed_keys = reactive({});
// Whether a typed key shows in clear, per service.
const visible_keys = reactive({});
// Collapsed by default; the header still says whether speech is ready.
const open = ref(false);
const service = computed(() => settings.catalog.find((item) => item.id === settings.provider) || {});
const own = computed(() => settings.providers[settings.provider] || { member_voices: {} });
const status = computed(() => unavailable.value ? t('需连接本机服务') : !loaded.value ? t('读取中…')
  : !settings.api_key_ref ? t('{value1} · 未配置', { value1: service.value.label }) : t('已配置 · {value1} · {value2}', { value1: service.value.label, value2: voice_items.value.find((voice) => voice.value === own.value.speaker)?.label || own.value.speaker }));
// The voice-input service chosen; a cloud one shares the key of its reading part, which gets its own row when reading uses another service.
const stt_service = computed(() => settings.stt_catalog.find((item) => item.id === settings.stt_provider) || {});
const input_service = computed(() => settings.provider === settings.stt_provider ? null : settings.catalog.find((item) => item.id === settings.stt_provider));

onMounted(async () => {
  try { Object.assign(settings, await bridge.local_request("tts-settings", {})); loaded.value = true; }
  catch (error) { unavailable.value = error.message; }
});

// The local read-aloud and voice-input services' processes, so one left running after a crash can be seen and ended.
const SERVICES_POLL_MS = 10_000;
const services = ref({});
const install_skill = ref("");
async function ask_install(skill) {
  if (await bridge.ensure_steward_configured()) install_skill.value = skill;
}
function confirm_install() {
  if (install_skill.value) bridge.request_steward(install_skill.value, {}, { confirmed: true });
}
let services_timer = 0;
/** Read whether the local services run; a failed read keeps the last state. */
async function load_services() {
  try { services.value = await bridge.local_request("local-speech", {}); } catch { /* Shown again at the next read. */ }
}
watch([open, loaded], ([shown, ready]) => {
  clearInterval(services_timer);
  if (!shown || !ready) return;
  load_services();
  services_timer = setInterval(load_services, SERVICES_POLL_MS);
});
onBeforeUnmount(() => clearInterval(services_timer));
/** The state line of one local service. */
function service_label(id) {
  const item = services.value[id];
  if (!item) return t('读取中…');
  if (item.state === "running") return item.pid ? t('运行中 · {value1} · PID {value2}', { value1: item.name, value2: item.pid }) : t('运行中');
  if (item.state === "other") return t('端口 {value1} 被 {value2}（PID {value3}）占用', { value1: item.port, value2: item.name, value3: item.pid });
  return item.installed ? t('未运行') : t('未安装');
}
/** Force one local service to stop, with its child processes. */
async function stop_service(id) {
  if (busy.value) return;
  busy.value = `stop:${id}`;
  try { services.value = await bridge.local_request("local-speech", { stop: id }); }
  catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

/**
 * Save the rate and every service's part, with `chosen` holding a service the user just picked. Services are sent only
 * then, so until the user picks one the default keeps following what is installed on this computer.
 */
async function save_with(chosen) {
  const { speech_rate, providers } = settings;
  try { Object.assign(settings, await bridge.local_request("tts-settings", { speech_rate, providers, ...chosen })); }
  catch (error) { bridge.notify("error", error.message); }
}
const save = () => save_with({});

/** Switch the voice-input service. */
function choose_input(provider) {
  if (provider === settings.stt_provider) return;
  settings.stt_provider = provider;
  save_with({ stt_provider: provider });
}

/** Switch the reading service; each keeps its own key and voices. */
function choose(provider) {
  if (provider === settings.provider) return;
  settings.provider = provider;
  save_with({ provider });
}

// Known voices of the chosen service show by name, their kind as a second line; IDs typed earlier (enabled in its
// console) are kept and shown as themselves.
const voice_items = computed(() => {
  const items = (service.value.voices || []).map((voice) => {
    const [label, ...kind] = voice.label.split(" · ");
    return { label, description: kind.join(" · "), value: voice.id };
  });
  const typed = [own.value.speaker, own.value.file_voice, ...Object.values(own.value.member_voices || {})].filter((id) => id && !items.some((item) => item.value === id));
  return [...items, ...[...new Set(typed)].map((id) => ({ label: id, value: id }))];
});
const general_voice = computed(() => voice_items.value.find((voice) => voice.value === own.value.speaker) || { label: own.value.speaker });
const platform_items = computed(() => [{ label: t('跟随通用'), description: general_voice.value.label, value: "" }, ...voice_items.value]);
/** The item a voice menu shows for its value. */
const shown_voice = (items, value) => items.find((item) => item.value === (value || "")) || { label: value };
// On a touch screen the search field waits for a tap: focusing it on open raises the keyboard over the list.
const voice_menu = {
  "value-key": "value", "create-item": true, size: "sm", class: "min-w-0 flex-1", "filter-fields": ["label", "description", "value"],
  "search-input": { placeholder: t('搜索或输入音色 ID'), autofocus: !window.matchMedia("(pointer: coarse)").matches },
  ui: { content: "speech-voice-menu", itemDescription: "speech-voice-kind" },
};
// Per-AI voices fold under one line, so the usual case (all follow the general voice) is not a column of repeats.
const platforms_open = ref(false);
const custom_count = computed(() => platforms.filter((platform) => own.value.member_voices?.[platform.name]).length);
/** The voice a row plays: a platform's or the file voice when set, otherwise the default voice. */
const voice_of = (key) => (key === FILE_KEY ? own.value.file_voice : key ? own.value.member_voices[key] : "") || own.value.speaker;
/** Set the default voice, one platform's or the file voice (empty follows the default), from a choice or a typed ID. */
function set_voice(platform, id) {
  const voice = String(id || "").trim(), part = own.value;
  if (platform === FILE_KEY) part.file_voice = voice;
  else if (platform) part.member_voices = { ...part.member_voices, [platform]: voice };
  else if (voice) part.speaker = voice;
  save();
}

/** Store a newly entered key of one service privately, then remember only its reference. */
async function save_key(item) {
  const api_key = String(typed_keys[item.id] || "").trim();
  if (!api_key || busy.value) return;
  busy.value = `key:${item.id}`;
  try {
    const { api_key_ref } = await bridge.local_request("api-key", { base_url: item.key_base_url, api_key });
    settings.providers[item.id].api_key_ref = api_key_ref;
    typed_keys[item.id] = "";
    await save();
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

/** Play a short sample in one voice (the default when empty); the element is started in the click so phones allow sound. */
async function preview(platform) {
  if (playing.value === platform) return stop_preview();
  stop_preview();
  const sample = new Audio();
  sample.play().catch(() => {});
  busy.value = `preview:${platform}`;
  try {
    const speaker = voice_of(platform);
    const { audio, format } = await request_tts(bridge, { text: PREVIEW_TEXT, speaker });
    sample.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(audio), (character) => character.charCodeAt(0))], { type: format === "m4a" ? "audio/mp4" : "audio/mpeg" }));
    sample.onended = () => { if (sample_audio === sample) stop_preview(); };
    sample_audio = sample;
    playing.value = platform;
    await sample.play();
    // A browser plays to an output with nothing plugged in without any error, so say that it plays and where to look.
    const label = voice_items.value.find((voice) => voice.value === speaker)?.label || speaker;
    bridge.notify("info", t('正在试听：{value1}。听不到声音时，请检查这台设备的音量和声音输出（耳机或音箱）', { value1: label }));
  } catch (error) {
    if (sample_audio === sample) stop_preview();
    bridge.notify("error", error.message);
  }
  finally { busy.value = ""; }
}

/** Stop the sample playing, if any, and free its audio. */
function stop_preview() {
  if (sample_audio) { sample_audio.pause(); URL.revokeObjectURL(sample_audio.src); }
  sample_audio = null;
  playing.value = "";
}
onBeforeUnmount(stop_preview);
</script>

<template>
  <section class="channel-reading-setting">
    <UCollapsible v-model:open="open">
      <button type="button" class="speech-header" :aria-expanded="open">
        <h3>{{ t('语音') }}</h3><small>{{ t('朗读与语音输入') }}</small><span :class="{ 'is-ready': settings.api_key_ref }">{{ status }}</span><UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <div class="speech-settings">
          <p v-if="unavailable" class="fine-print">{{ t('语音由这台电脑的本机服务调用语音服务，需要连接本机服务或已配对电脑：{value1}', { value1: unavailable }) }}</p>
          <template v-else-if="loaded">
            <h4>{{ t('朗读') }}</h4>
            <div class="speech-row"><span>{{ t('服务') }}</span>
              <div class="speech-rates speech-providers" role="group" :aria-label="t('朗读语音服务')"><UButton v-for="item in settings.catalog" :key="item.id" :label="item.label" color="neutral" variant="ghost" size="xs" :class="{ chosen: settings.provider === item.id }" :aria-pressed="settings.provider === item.id" @click="choose(item.id)" /></div>
            </div>
            <p class="fine-print speech-note" :title="service.note">{{ service.note }} · <a :href="service.console_url" target="_blank" rel="noopener">{{ t('控制台') }}</a></p>
            <div class="speech-row"><span>{{ t('密钥') }}</span>
              <UInput v-if="service.local" disabled :placeholder="own.api_key_ref ? t('已配置，无需填写') : services.tts?.installed === false ? t('尚未安装，请选择“让平台主理人安装”') : t('未配置')" :aria-label="t('本机语音令牌')" size="sm" class="w-full" />
              <!-- A text field masked by CSS keeps browsers from offering to generate or save a password. -->
              <UInput v-else v-model="typed_keys[service.id]" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="own.api_key_ref ? SAVED_MARK : t('粘贴 API Key，只存这台电脑')" :title="own.api_key_ref &amp;&amp; !typed_keys[service.id] ? t('已保存；本机不回传密钥，输入新 Key 可更换') : undefined" :aria-label="`${service.label} API Key`" size="sm" class="w-full" :loading="busy === `key:${service.id}`" :ui="{ base: visible_keys[service.id] ? '' : 'speech-key-masked', trailing: 'pe-0.5' }" @change="save_key(service)">
                <template #trailing><UButton :icon="visible_keys[service.id] ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!typed_keys[service.id]" :aria-label="visible_keys[service.id] ? t('隐藏密钥') : t('显示密钥')" :aria-pressed="Boolean(visible_keys[service.id])" size="xs" color="neutral" variant="link" @click="visible_keys[service.id] = !visible_keys[service.id]" /></template>
              </UInput>
            </div>
            <!-- Rows a service does not use stay in place, disabled, so switching services never moves the rows below. -->
            <div class="speech-row"><span>{{ t('区域') }}</span>
              <UInput v-if="service.region" v-model="own.region" :placeholder="t('语音资源所在区域，如 eastasia')" :aria-label="t('Azure 区域')" size="sm" class="w-full" @change="save" />
              <UInput v-else disabled :placeholder="t('此服务无需区域')" :aria-label="t('区域')" size="sm" class="w-full" />
            </div>
            <div class="speech-row"><span>{{ t('通用') }}</span>
              <div class="speech-inline">
                <USelectMenu :model-value="own.speaker" :items="voice_items" v-bind="voice_menu" :aria-label="t('通用音色')" @update:model-value="set_voice('', $event)" @create="set_voice('', $event)">
                  <template #default><span class="speech-voice-value">{{ general_voice.label }}<small v-if="general_voice.description">{{ general_voice.description }}</small></span></template>
                </USelectMenu>
                <UButton :icon="playing === GENERAL_KEY ? 'i-lucide-square' : 'i-lucide-volume-2'" :aria-label="playing === GENERAL_KEY ? t('停止试听') : t('试听通用音色')" color="neutral" variant="ghost" size="sm" :loading="busy === `preview:${GENERAL_KEY}`" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview(GENERAL_KEY)" />
              </div>
            </div>
            <div class="speech-row"><span>{{ t('文件') }}</span>
              <div class="speech-inline">
                <USelectMenu :model-value="own.file_voice || ''" :items="platform_items" v-bind="voice_menu" :aria-label="t('朗读文件的音色')" @update:model-value="set_voice(FILE_KEY, $event)" @create="set_voice(FILE_KEY, $event)">
                  <template #default><span v-for="shown in [shown_voice(platform_items, own.file_voice)]" :key="shown.value" :class="['speech-voice-value', { follows: !own.file_voice }]">{{ shown.label }}<small v-if="shown.description">{{ shown.description }}</small></span></template>
                </USelectMenu>
                <UButton :icon="playing === FILE_KEY ? 'i-lucide-square' : 'i-lucide-volume-2'" :aria-label="playing === FILE_KEY ? t('停止试听') : t('试听朗读文件的音色')" color="neutral" variant="ghost" size="sm" :loading="busy === `preview:${FILE_KEY}`" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview(FILE_KEY)" />
              </div>
            </div>
            <div class="speech-row"><span>{{ t('各 AI') }}</span>
              <button type="button" class="speech-fold" :aria-expanded="platforms_open" :title="t('未单独设置的 AI 与其他消息用通用音色')" @click="platforms_open = !platforms_open">
                <span>{{ custom_count ? t('已单独设置 {value1} 个', { value1: custom_count }) : t('全部跟随通用') }}</span><UIcon :name="platforms_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
              </button>
            </div>
            <div v-if="platforms_open" class="speech-platforms">
              <div v-for="platform in platforms" :key="platform.name" class="speech-row"><span :title="platform.label">{{ platform.label }}</span>
                <div class="speech-inline">
                  <USelectMenu :model-value="own.member_voices[platform.name] || ''" :items="platform_items" v-bind="voice_menu" :aria-label="t('{value1} 的音色', { value1: platform.label })" @update:model-value="set_voice(platform.name, $event)" @create="set_voice(platform.name, $event)">
                    <template #default><span v-for="shown in [shown_voice(platform_items, own.member_voices[platform.name])]" :key="shown.value" :class="['speech-voice-value', { follows: !own.member_voices[platform.name] }]">{{ shown.label }}<small v-if="shown.description">{{ shown.description }}</small></span></template>
                  </USelectMenu>
                  <UButton :icon="playing === platform.name ? 'i-lucide-square' : 'i-lucide-volume-2'" :aria-label="playing === platform.name ? t('停止试听') : t('试听 {value1} 的音色', { value1: platform.label })" color="neutral" variant="ghost" size="sm" :loading="busy === `preview:${platform.name}`" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview(platform.name)" />
                </div>
              </div>
              <p class="fine-print speech-note">{{ t('未单独设置的 AI 与其他消息用通用音色') }}</p>
            </div>
            <div class="speech-row"><span>{{ t('语速') }}</span>
              <div class="speech-rates" role="group" :aria-label="t('朗读语速')" :title="service.rate === false ? t('当前接入不支持调节语速') : undefined"><UButton v-for="rate in rates" :key="rate.value" :label="rate.label" color="neutral" variant="ghost" size="xs" :disabled="service.rate === false" :class="{ chosen: settings.speech_rate === rate.value }" :aria-pressed="settings.speech_rate === rate.value" @click="settings.speech_rate = rate.value; save()" /></div>
            </div>
            <div class="speech-row"><span>{{ t('语气') }}</span>
              <UTextarea v-if="service.context" v-model="own.context" :maxlength="200" :rows="1" autoresize :maxrows="4" :placeholder="t('可选，如：像朋友聊天一样自然地读')" :aria-label="t('朗读语气提示')" size="sm" class="w-full" @change="save" />
              <UInput v-else disabled :placeholder="t('当前接入不支持自定义语气')" :aria-label="t('朗读语气提示')" size="sm" class="w-full" />
            </div>
            <p class="fine-print speech-note">{{ t('输入框右下角的播报按钮自动读新回复摘要') }}</p>
            <div class="speech-row"><span>{{ t('本机进程') }}</span>
              <div class="speech-inline speech-process">
                <span :class="['speech-process-state', services.tts?.state]" :title="service_label('tts')">{{ service_label('tts') }}</span>
                <UButton v-if="services.tts?.installed === false" size="xs" color="neutral" variant="soft" :label="t('让平台主理人安装')" @click="ask_install('local-tts-setup')" />
                <UButton v-if="services.tts?.state === 'running'" icon="i-lucide-power" :aria-label="t('强行停止本机朗读服务')" :title="t('强行停止本机朗读服务（连同子进程）')" color="error" variant="ghost" size="sm" :loading="busy === 'stop:tts'" :disabled="Boolean(busy)" @click="stop_service('tts')" />
              </div>
            </div>
            <h4>{{ t('语音输入') }}</h4>
            <div class="speech-row"><span>{{ t('服务') }}</span>
              <div class="speech-rates speech-providers" role="group" :aria-label="t('语音输入服务')"><UButton v-for="item in settings.stt_catalog" :key="item.id" :label="item.label" color="neutral" variant="ghost" size="xs" :class="{ chosen: settings.stt_provider === item.id }" :aria-pressed="settings.stt_provider === item.id" @click="choose_input(item.id)" /></div>
            </div>
            <p class="fine-print speech-note" :title="stt_service.note">{{ stt_service.note }}</p>
            <div class="speech-row"><span>{{ t('密钥') }}</span>
              <UInput v-if="stt_service.local" disabled :placeholder="settings.stt_key_ref ? t('已配置，无需填写') : services.stt?.installed === false ? t('尚未安装，请选择“让平台主理人安装”') : t('未配置')" :aria-label="t('本机语音识别令牌')" size="sm" class="w-full" />
              <UInput v-else-if="input_service" v-model="typed_keys[input_service.id]" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="settings.providers[input_service.id]?.api_key_ref ? SAVED_MARK : t('粘贴{value1} API Key', { value1: input_service.label })" :title="settings.providers[input_service.id]?.api_key_ref &amp;&amp; !typed_keys[input_service.id] ? t('已保存；本机不回传密钥，输入新 Key 可更换') : undefined" :aria-label="t('语音输入的{value1} API Key', { value1: input_service.label })" size="sm" class="w-full" :loading="busy === `key:${input_service.id}`" :ui="{ base: visible_keys[input_service.id] ? '' : 'speech-key-masked', trailing: 'pe-0.5' }" @change="save_key(input_service)">
                <template #trailing><UButton :icon="visible_keys[input_service.id] ? 'i-lucide-eye' : 'i-lucide-eye-off'" :disabled="!typed_keys[input_service.id]" :aria-label="visible_keys[input_service.id] ? t('隐藏密钥') : t('显示密钥')" :aria-pressed="Boolean(visible_keys[input_service.id])" size="xs" color="neutral" variant="link" @click="visible_keys[input_service.id] = !visible_keys[input_service.id]" /></template>
              </UInput>
              <UInput v-else disabled :placeholder="t('与朗读共用上方的{value1} Key', { value1: stt_service.label })" :aria-label="t('语音输入的{value1} API Key', { value1: stt_service.label })" size="sm" class="w-full" />
            </div>
            <div class="speech-row"><span>{{ t('本机进程') }}</span>
              <div class="speech-inline speech-process">
                <span :class="['speech-process-state', services.stt?.state]" :title="service_label('stt')">{{ service_label('stt') }}</span>
                <UButton v-if="services.stt?.installed === false" size="xs" color="neutral" variant="soft" :label="t('让平台主理人安装')" @click="ask_install('local-stt-setup')" />
                <UButton v-if="services.stt?.state === 'running'" icon="i-lucide-power" :aria-label="t('强行停止本机语音识别服务')" :title="t('强行停止本机语音识别服务（连同子进程）')" color="error" variant="ghost" size="sm" :loading="busy === 'stop:stt'" :disabled="Boolean(busy)" @click="stop_service('stt')" />
              </div>
            </div>
          </template>
          <p v-else class="fine-print">{{ t('正在读取语音设置…') }}</p>
        </div>
      </template>
    </UCollapsible>
    <ConfirmDialog :open="Boolean(install_skill)" :title="install_skill === 'local-tts-setup' ? t('安装本机朗读') : t('安装本机语音输入')"
      :description="t('平台主理人将下载所需组件并更改本机语音设置。')" @update:open="!$event && (install_skill = '')" @confirm="confirm_install" />
  </section>
</template>

<style scoped>
.speech-header { display: flex; width: 100%; align-items: baseline; gap: 8px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }
.speech-header h3 { flex-shrink: 0; margin: 0; white-space: nowrap; }
.speech-header small { flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 12px; white-space: nowrap; }
.speech-header span { min-width: 0; margin-left: auto; overflow: hidden; color: var(--ui-text-dimmed); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
/* A phone keeps one line: the subtitle gives way, and the status shortens with an ellipsis. */
@media (max-width: 480px) { .speech-header small { display: none; } }
.speech-header span.is-ready { color: var(--ui-success); }
.speech-header > :last-child { align-self: center; color: var(--ui-text-dimmed); }
.speech-settings { display: grid; gap: 10px; padding-top: 10px; }
.speech-settings h4 { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; font-weight: 600; }
.speech-settings .fine-print { margin: 0; }
.speech-settings a { color: var(--ui-primary); text-decoration: underline; }
.speech-row { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.speech-inline { display: flex; gap: 6px; min-width: 0; }
.speech-row > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Notes keep to one line, so their length never shifts the rows below; the full text shows on hover. */
.speech-settings .speech-note { padding-left: 66px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speech-follow { display: flex; align-items: center; gap: 8px; color: var(--ui-text-muted); cursor: pointer; }
.speech-rates { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 8px; background: var(--ui-bg-elevated); width: fit-content; }
.speech-rates button { min-width: 44px; justify-content: center; color: var(--ui-text-muted); }
.speech-rates button.chosen { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
/* A phone gives the service choice its own line under its name, so all services sit in one even row instead of wrapping. */
@media (max-width: 480px) {
  .speech-row:has(> .speech-providers) { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .speech-providers { flex-wrap: nowrap; width: 100%; }
  .speech-providers button { flex: 1 1 auto; min-width: 0; padding-inline: 4px; }
  .speech-row:has(> .speech-providers) + .speech-note { padding-left: 0; }
}
.speech-process { align-items: center; min-height: 32px; }
.speech-process-state { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speech-process-state.running { color: var(--ui-success); }
.speech-process-state.other { color: var(--ui-warning); }
.speech-settings :deep(.speech-key-masked) { -webkit-text-security: disc; }
/* A chosen voice reads as its name, its kind dimmed after it; a row that follows the general voice is dimmed whole. */
.speech-voice-value { display: flex; min-width: 0; align-items: baseline; gap: 6px; overflow: hidden; color: var(--ui-text-highlighted); white-space: nowrap; }
.speech-voice-value small { min-width: 0; overflow: hidden; color: var(--ui-text-dimmed); font-size: 12px; text-overflow: ellipsis; }
.speech-voice-value.follows { color: var(--ui-text-muted); }
.speech-fold { display: flex; min-height: 32px; align-items: center; justify-content: space-between; gap: 8px; padding: 0 10px; border: 1px solid var(--ui-border); border-radius: 6px; background: none; color: var(--ui-text-muted); cursor: pointer; font-size: 13px; }
.speech-fold:hover { background: var(--ui-bg-elevated); }
.speech-platforms { display: grid; gap: 10px; padding-left: 12px; border-left: 2px solid var(--ui-border); }
.speech-platforms .speech-row { grid-template-columns: 44px minmax(0, 1fr); }
.speech-platforms .speech-note { padding-left: 54px; }
/* The list is portaled out of this section; each voice takes two lines, name over kind. */
:global(.speech-voice-menu) { min-width: 220px; }
:global(.speech-voice-menu .speech-voice-kind) { font-size: 12px; }
</style>

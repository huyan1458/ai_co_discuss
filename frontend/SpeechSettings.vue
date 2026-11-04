<script setup>
/**
 * Speech settings kept by the local service: read-aloud uses the chosen service (Volcengine, Aliyun or Azure), each with
 * its own key and voices; voice input always uses the Volcengine key. Keys never come back to the page.
 */
import { computed, inject, onMounted, reactive, ref } from "vue";

const { bridge } = inject("discussion");
const SAVED_MARK = "••••••••••••";
const PREVIEW_TEXT = "你好，我会用这个声音为你朗读房间里的消息。";
const VOICE_INPUT = "volcengine";
const rates = [{ value: -20, label: "0.8×" }, { value: 0, label: "1×" }, { value: 20, label: "1.2×" }, { value: 50, label: "1.5×" }, { value: 100, label: "2×" }];
const settings = reactive({ provider: "volcengine", speech_rate: 0, context: "", providers: {}, catalog: [], api_key_ref: "" });
// One voice per AI platform; members of an unset platform, the user and program messages use the default voice.
const platforms = Object.keys(bridge.launch_clients).map((name) => ({ name, label: bridge.identities[name]?.label || name }));
// Key of the project-file voice row, apart from platform names.
const FILE_KEY = ":file";
const loaded = ref(false), unavailable = ref(""), busy = ref("");
// A newly typed key per service, cleared once stored.
const typed_keys = reactive({});
// Collapsed by default; the header still says whether speech is ready.
const open = ref(false);
const service = computed(() => settings.catalog.find((item) => item.id === settings.provider) || {});
const own = computed(() => settings.providers[settings.provider] || { member_voices: {} });
const status = computed(() => unavailable.value ? "需连接本机服务" : !loaded.value ? "读取中…"
  : !settings.api_key_ref ? `${service.value.label} · 未配置` : `已配置 · ${service.value.label} · ${voice_items.value.find((voice) => voice.value === own.value.speaker)?.label || own.value.speaker}`);
// Voice input needs Volcengine's key; it gets its own key row when reading uses another service.
const input_service = computed(() => settings.provider === VOICE_INPUT ? null : settings.catalog.find((item) => item.id === VOICE_INPUT));

onMounted(async () => {
  try { Object.assign(settings, await bridge.local_request("tts-settings", {})); loaded.value = true; }
  catch (error) { unavailable.value = error.message; }
});

/** Save every field together; the service validates and answers with what it kept. */
async function save() {
  const { provider, speech_rate, context, providers } = settings;
  try { Object.assign(settings, await bridge.local_request("tts-settings", { provider, speech_rate, context, providers })); }
  catch (error) { bridge.notify("error", error.message); }
}

/** Switch the reading service; each keeps its own key and voices. */
function choose(provider) {
  if (provider === settings.provider) return;
  settings.provider = provider;
  save();
}

// Known voices of the chosen service show by name; IDs typed earlier (enabled in its console) are kept and shown as themselves.
const voice_items = computed(() => {
  const items = (service.value.voices || []).map((voice) => ({ label: voice.label, value: voice.id }));
  const typed = [own.value.speaker, own.value.file_voice, ...Object.values(own.value.member_voices || {})].filter((id) => id && !items.some((item) => item.value === id));
  return [...items, ...[...new Set(typed)].map((id) => ({ label: id, value: id }))];
});
const platform_items = computed(() => [{ label: "跟随通用", value: "" }, ...voice_items.value]);
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
  const sample = new Audio();
  sample.play().catch(() => {});
  busy.value = `preview:${platform}`;
  try {
    const speaker = voice_of(platform);
    const { audio } = await bridge.local_request("tts", { text: PREVIEW_TEXT, speaker });
    sample.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(audio), (character) => character.charCodeAt(0))], { type: "audio/mpeg" }));
    sample.onended = () => URL.revokeObjectURL(sample.src);
    await sample.play();
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}
</script>

<template>
  <section class="channel-reading-setting">
    <UCollapsible v-model:open="open">
      <button type="button" class="speech-header" :aria-expanded="open">
        <h3>语音</h3><small>朗读与语音输入</small><span :class="{ 'is-ready': settings.api_key_ref }">{{ status }}</span><UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <div class="speech-settings">
          <p v-if="unavailable" class="fine-print">语音由这台电脑的本机服务调用语音服务，需要连接本机服务或已配对电脑：{{ unavailable }}</p>
          <template v-else-if="loaded">
            <h4>朗读</h4>
            <div class="speech-row"><span>服务</span>
              <div class="speech-rates" role="group" aria-label="朗读语音服务"><UButton v-for="item in settings.catalog" :key="item.id" :label="item.label" color="neutral" variant="ghost" size="xs" :class="{ chosen: settings.provider === item.id }" :aria-pressed="settings.provider === item.id" @click="choose(item.id)" /></div>
            </div>
            <p class="fine-print speech-note">{{ service.note }}<a :href="service.console_url" target="_blank" rel="noopener">打开控制台</a>获取 API Key。密钥只存这台电脑，费用按你的账号计费。</p>
            <label class="speech-row"><span>密钥</span>
              <UInput v-model="typed_keys[service.id]" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="own.api_key_ref ? `${SAVED_MARK}（输入新 Key 可更换）` : '粘贴 API Key'" :aria-label="`${service.label} API Key`" size="sm" class="w-full speech-key" :loading="busy === `key:${service.id}`" @change="save_key(service)" />
            </label>
            <label v-if="service.region" class="speech-row"><span>区域</span>
              <UInput v-model="own.region" placeholder="语音资源所在区域，如 eastasia" aria-label="Azure 区域" size="sm" class="w-full" @change="save" />
            </label>
            <div class="speech-row"><span>通用</span>
              <div class="speech-inline">
                <USelectMenu :model-value="own.speaker" :items="voice_items" value-key="value" create-item :search-input="{ placeholder: '搜索或输入音色 ID' }" aria-label="通用音色" size="sm" class="min-w-0 flex-1" @update:model-value="set_voice('', $event)" @create="set_voice('', $event)" />
                <UButton icon="i-lucide-volume-2" aria-label="试听通用音色" color="neutral" variant="ghost" size="sm" :loading="busy === 'preview:'" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview('')" />
              </div>
            </div>
            <div v-for="platform in platforms" :key="platform.name" class="speech-row"><span :title="platform.label">{{ platform.label }}</span>
              <div class="speech-inline">
                <USelectMenu :model-value="own.member_voices[platform.name] || ''" :items="platform_items" value-key="value" create-item :search-input="{ placeholder: '搜索或输入音色 ID' }" :aria-label="`${platform.label} 的音色`" size="sm" class="min-w-0 flex-1" @update:model-value="set_voice(platform.name, $event)" @create="set_voice(platform.name, $event)" />
                <UButton icon="i-lucide-volume-2" :aria-label="`试听 ${platform.label} 的音色`" color="neutral" variant="ghost" size="sm" :loading="busy === `preview:${platform.name}`" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview(platform.name)" />
              </div>
            </div>
            <div class="speech-row"><span>文件</span>
              <div class="speech-inline">
                <USelectMenu :model-value="own.file_voice || ''" :items="platform_items" value-key="value" create-item :search-input="{ placeholder: '搜索或输入音色 ID' }" aria-label="朗读文件的音色" size="sm" class="min-w-0 flex-1" @update:model-value="set_voice(FILE_KEY, $event)" @create="set_voice(FILE_KEY, $event)" />
                <UButton icon="i-lucide-volume-2" aria-label="试听朗读文件的音色" color="neutral" variant="ghost" size="sm" :loading="busy === `preview:${FILE_KEY}`" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview(FILE_KEY)" />
              </div>
            </div>
            <p class="fine-print speech-note">没单独设置的 AI、你自己的消息、程序消息和文件都用通用音色；每个服务的密钥与音色分开保存，切回时仍在。</p>
            <div class="speech-row"><span>语速</span>
              <div class="speech-rates" role="group" aria-label="朗读语速"><UButton v-for="rate in rates" :key="rate.value" :label="rate.label" color="neutral" variant="ghost" size="xs" :class="{ chosen: settings.speech_rate === rate.value }" :aria-pressed="settings.speech_rate === rate.value" @click="settings.speech_rate = rate.value; save()" /></div>
            </div>
            <label v-if="service.context" class="speech-row"><span>语气</span>
              <UInput v-model="settings.context" :maxlength="200" placeholder="可选，如：像朋友聊天一样自然地读" aria-label="朗读语气提示" size="sm" class="w-full" @change="save" />
            </label>
            <p class="fine-print speech-note">输入框右下角的播报按钮可开启语音播报：新回复自动朗读回答摘要，并提示轮次、失败与讨论结束。</p>
            <h4>语音输入</h4>
            <p class="fine-print">点输入框右下角的麦克风开始说话，再点一次转成文字，单次最长 5 分钟。语音输入使用火山引擎「录音文件识别2.0」<template v-if="settings.provider !== VOICE_INPUT">，需单独填写火山引擎 API Key</template>。</p>
            <label v-if="input_service" class="speech-row"><span>密钥</span>
              <UInput v-model="typed_keys[input_service.id]" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="settings.providers[input_service.id]?.api_key_ref ? `${SAVED_MARK}（输入新 Key 可更换）` : '粘贴火山引擎 API Key'" aria-label="语音输入的火山引擎 API Key" size="sm" class="w-full speech-key" :loading="busy === `key:${input_service.id}`" @change="save_key(input_service)" />
            </label>
          </template>
          <p v-else class="fine-print">正在读取语音设置…</p>
        </div>
      </template>
    </UCollapsible>
  </section>
</template>

<style scoped>
.speech-header { display: flex; width: 100%; align-items: baseline; gap: 8px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }
.speech-header h3 { margin: 0; }
.speech-header small { color: var(--ui-text-dimmed); font-size: 12px; }
.speech-header span { margin-left: auto; color: var(--ui-text-dimmed); font-size: 12px; }
.speech-header span.is-ready { color: var(--ui-success); }
.speech-header > :last-child { align-self: center; color: var(--ui-text-dimmed); }
.speech-settings { display: grid; gap: 10px; padding-top: 10px; }
.speech-settings h4 { margin: 4px 0 0; color: var(--ui-text-muted); font-size: 12px; font-weight: 600; }
.speech-settings .fine-print { margin: 0; }
.speech-settings a { color: var(--ui-primary); text-decoration: underline; }
.speech-row { display: grid; grid-template-columns: 56px minmax(0, 1fr); align-items: center; gap: 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.speech-inline { display: flex; gap: 6px; min-width: 0; }
.speech-row > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.speech-settings .speech-note { padding-left: 66px; }
.speech-follow { display: flex; align-items: center; gap: 8px; color: var(--ui-text-muted); cursor: pointer; }
.speech-rates { display: flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: 8px; background: var(--ui-bg-elevated); width: fit-content; }
.speech-rates button { min-width: 44px; justify-content: center; color: var(--ui-text-muted); }
.speech-rates button.chosen { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.speech-settings :deep(.speech-key input) { -webkit-text-security: disc; }
</style>

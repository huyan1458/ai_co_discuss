<script setup>
/** Speech settings (read-aloud and voice input share one Volcengine key), kept by the local service; the key never comes back. */
import { computed, inject, onMounted, reactive, ref } from "vue";

const { bridge } = inject("discussion");
const SAVED_MARK = "••••••••••••";
const PREVIEW_TEXT = "你好，我会用这个声音为你朗读房间里的消息。";
const CONSOLE_URL = "https://console.volcengine.com/speech/new";
const rates = [{ value: -20, label: "0.8×" }, { value: 0, label: "1×" }, { value: 20, label: "1.2×" }, { value: 50, label: "1.5×" }, { value: 100, label: "2×" }];
const settings = reactive({ speaker: "", speech_rate: 0, context: "", api_key_ref: "", voices: [], key_base_url: "" });
const loaded = ref(false), unavailable = ref(""), api_key = ref(""), busy = ref("");
// Collapsed by default; the header still says whether speech is ready.
const open = ref(false);
const status = computed(() => unavailable.value ? "需连接本机服务" : !loaded.value ? "读取中…"
  : !settings.api_key_ref ? "未配置" : `已配置 · ${settings.voices.find((voice) => voice.id === settings.speaker)?.label || settings.speaker}`);

onMounted(async () => {
  try { Object.assign(settings, await bridge.local_request("tts-settings", {})); loaded.value = true; }
  catch (error) { unavailable.value = error.message; }
});

/** Save every field together; the service validates and answers with what it kept. */
async function save() {
  const { speaker, speech_rate, context, api_key_ref } = settings;
  try { Object.assign(settings, await bridge.local_request("tts-settings", { speaker, speech_rate, context, api_key_ref })); }
  catch (error) { bridge.notify("error", error.message); }
}

// Known voices show by name; a typed ID enabled in the console is kept and shown as itself.
const voice_items = computed(() => {
  const items = settings.voices.map((voice) => ({ label: voice.label, value: voice.id }));
  return items.some((item) => item.value === settings.speaker) || !settings.speaker ? items : [...items, { label: settings.speaker, value: settings.speaker }];
});
/** Use a voice ID typed into the search box. */
function add_voice(id) {
  settings.speaker = id.trim();
  save();
}

/** Store a newly entered key privately, then remember only its reference. */
async function save_key() {
  if (!api_key.value.trim() || busy.value) return;
  busy.value = "key";
  try {
    const { api_key_ref } = await bridge.local_request("api-key", { base_url: settings.key_base_url, api_key: api_key.value });
    settings.api_key_ref = api_key_ref;
    api_key.value = "";
    await save();
  } catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

/** Play a short sample with the saved voice; the audio context is opened in the click so phones allow sound. */
async function preview() {
  if (navigator.audioSession) navigator.audioSession.type = "playback";
  const context = new AudioContext();
  context.resume();
  busy.value = "preview";
  try {
    const { audio } = await bridge.local_request("tts", { text: PREVIEW_TEXT });
    const source = context.createBufferSource();
    source.buffer = await context.decodeAudioData(Uint8Array.from(atob(audio), (character) => character.charCodeAt(0)).buffer);
    source.connect(context.destination);
    source.onended = () => context.close();
    source.start();
  } catch (error) { bridge.notify("error", error.message); context.close(); }
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
          <p v-if="unavailable" class="fine-print">语音由这台电脑的本机服务调用火山引擎，需要连接本机服务或已配对电脑：{{ unavailable }}</p>
          <template v-else-if="loaded">
            <p class="fine-print">在<a :href="CONSOLE_URL" target="_blank" rel="noopener">火山引擎控制台</a>开通「语音合成2.0」（朗读）和「录音文件识别2.0」（语音输入），复制 API Key 填在下面。密钥只存这台电脑，费用按你的账号计费。</p>
            <label class="speech-row"><span>密钥</span>
              <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="settings.api_key_ref ? `${SAVED_MARK}（输入新 Key 可更换）` : '粘贴 API Key'" aria-label="火山引擎 API Key" size="sm" class="w-full speech-key" :loading="busy === 'key'" @change="save_key" />
            </label>
            <h4>朗读</h4>
            <div class="speech-row"><span>音色</span>
              <div class="speech-inline">
                <USelectMenu v-model="settings.speaker" :items="voice_items" value-key="value" create-item :search-input="{ placeholder: '搜索或输入音色 ID' }" aria-label="朗读音色" size="sm" class="min-w-0 flex-1" @update:model-value="save" @create="add_voice" />
                <UButton label="试听" icon="i-lucide-volume-2" color="neutral" variant="soft" size="sm" :loading="busy === 'preview'" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview" />
              </div>
            </div>
            <div class="speech-row"><span>语速</span>
              <div class="speech-rates" role="group" aria-label="朗读语速"><UButton v-for="rate in rates" :key="rate.value" :label="rate.label" color="neutral" variant="ghost" size="xs" :class="{ chosen: settings.speech_rate === rate.value }" :aria-pressed="settings.speech_rate === rate.value" @click="settings.speech_rate = rate.value; save()" /></div>
            </div>
            <label class="speech-row"><span>语气</span>
              <UInput v-model="settings.context" :maxlength="200" placeholder="可选，如：像朋友聊天一样自然地读" aria-label="朗读语气提示" size="sm" class="w-full" @change="save" />
            </label>
            <h4>语音输入</h4>
            <p class="fine-print">点输入框右下角的麦克风开始说话，再点一次转成文字，单次最长 5 分钟。</p>
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
.speech-row { display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.speech-inline { display: flex; gap: 6px; min-width: 0; }
.speech-rates { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--ui-bg-elevated); width: fit-content; }
.speech-rates button { min-width: 44px; justify-content: center; color: var(--ui-text-muted); }
.speech-rates button.chosen { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.speech-settings :deep(.speech-key input) { -webkit-text-security: disc; }
</style>

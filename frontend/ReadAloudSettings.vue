<script setup>
/** Read-aloud settings, kept by the local service; the key goes straight to its private store and never comes back. */
import { inject, onMounted, reactive, ref } from "vue";

const { bridge } = inject("discussion");
const SAVED_MARK = "••••••••••••";
const PREVIEW_TEXT = "你好，我会用这个声音为你朗读房间里的消息。";
const rates = [{ value: -20, label: "0.8 倍" }, { value: 0, label: "1 倍" }, { value: 20, label: "1.2 倍" }, { value: 50, label: "1.5 倍" }, { value: 100, label: "2 倍" }];
const settings = reactive({ speaker: "", speech_rate: 0, context: "", api_key_ref: "", voices: [], key_base_url: "" });
const loaded = ref(false), unavailable = ref(""), api_key = ref(""), busy = ref("");

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

let save_timer = 0;
/** Save once typing in the voice field pauses, instead of on every keystroke. */
function schedule_save() {
  window.clearTimeout(save_timer);
  save_timer = window.setTimeout(save, 600);
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
  <section class="channel-reading-setting read-aloud-settings">
    <h3>朗读</h3>
    <p v-if="unavailable" class="fine-print">朗读由这台电脑的本机服务调用火山引擎豆包语音合成，需要连接本机服务或已配对电脑：{{ unavailable }}</p>
    <template v-else-if="loaded">
      <p class="fine-print">使用火山引擎豆包语音合成 2.0。密钥只保存在本机，不经过网站。</p>
      <UFormField label="API Key">
        <UInput v-model="api_key" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true" :placeholder="settings.api_key_ref ? SAVED_MARK : '火山引擎控制台的 API Key'" aria-label="朗读 API Key" class="w-full read-aloud-key" :loading="busy === 'key'" @change="save_key" />
      </UFormField>
      <UFormField label="音色" help="可填写控制台已开通的其他 2.0 音色 ID">
        <UInputMenu v-model="settings.speaker" mode="autocomplete" ignore-filter :items="settings.voices.map((voice) => ({ label: voice.label, value: voice.id }))" value-key="value" aria-label="朗读音色" class="w-full" @update:model-value="schedule_save" />
      </UFormField>
      <UFormField label="语速">
        <USelect v-model="settings.speech_rate" :items="rates" aria-label="朗读语速" class="w-full" @update:model-value="save" />
      </UFormField>
      <UFormField label="语气提示" help="用一句话描述想要的语气，例如“像朋友聊天一样自然地读”，可留空">
        <UTextarea v-model="settings.context" :maxlength="200" :rows="2" aria-label="朗读语气提示" class="w-full" @change="save" />
      </UFormField>
      <UButton label="试听" icon="i-lucide-volume-2" color="neutral" variant="soft" size="sm" :loading="busy === 'preview'" :disabled="!settings.api_key_ref || Boolean(busy)" @click="preview" />
    </template>
    <p v-else class="fine-print">正在读取朗读设置…</p>
  </section>
</template>

<style scoped>
.read-aloud-settings { display: grid; gap: 10px; }
.read-aloud-settings > button { justify-self: start; }
.read-aloud-settings :deep(.read-aloud-key input) { -webkit-text-security: disc; }
</style>

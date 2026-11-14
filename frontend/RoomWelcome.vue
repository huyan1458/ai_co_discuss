<script setup>
/**
 * The middle area with no room selected: the first message creates a room with the new-room panel's defaults. Its
 * composer is the room composer's own markup and styles, with attachments and voice input; members, files and modes
 * are not offered here because the room does not exist yet (typed /goal or /discuss still reach the new room).
 */
import { computed, inject, nextTick, onBeforeUnmount, ref } from "vue";
import { ENTER_SENDS } from "./enter-sends.js";
import { format_voice_time, use_voice_input, use_voice_press } from "./voice-input.js";
import UTooltip from "@nuxt/ui/components/Tooltip.vue";

const EDITOR_MAX_ROWS = 6;
const LENGTH_WARNING_RATIO = 0.9;

const { view, bridge, act, pending } = inject("discussion");
const draft = ref("");
const prompt = ref(null);
const creating = computed(() => pending.value === "quick_create");
const has_draft = computed(() => Boolean(draft.value.trim() || view.value.attachment_drafts.length));
const text_length = computed(() => [...draft.value].length);
const near_length_limit = computed(() => text_length.value >= bridge.max_message_length * LENGTH_WARNING_RATIO);

// Voice input inserts recognized text where the caret was, as in the room composer.
const voice = use_voice_input({ bridge, on_text: (spoken) => {
  const area = prompt.value?.textareaRef, value = draft.value;
  const start = area ? area.selectionStart : value.length, end = area ? area.selectionEnd : value.length;
  draft.value = `${value.slice(0, start)}${spoken}${value.slice(end)}`;
  nextTick(() => { if (ENTER_SENDS) area?.focus(); area?.setSelectionRange(start + spoken.length, start + spoken.length); });
} });
const voice_press = use_voice_press({ voice, textarea: () => prompt.value?.textareaRef, text: draft, busy: () => creating.value });
onBeforeUnmount(() => voice.cancel());

/** Create the room and post the message; a failed creation keeps the draft and files here for another try. */
async function start() {
  if (!has_draft.value || pending.value) return;
  if (await act("quick_create", draft.value)) draft.value = "";
}
</script>

<template>
  <div class="room-welcome">
    <div class="room-welcome-hero"><UIcon name="i-lucide-messages-square" /><h2>想和 AI 一起做什么？</h2>
      <p v-if="view.launch.projects_restricted">说说要做的事，AI 会接手，在这里回复你。</p>
      <p v-else>发出第一条消息即新建房间，沿用新建面板的默认设置，由第一位可唤醒的 AI 主持。</p></div>
    <div class="channel-composer-dock"><div class="channel-composer-column" @dragover="bridge.drop_attachments" @drop="bridge.drop_attachments" @paste="bridge.paste_attachments">
      <UChatPrompt ref="prompt" v-model="draft" :submit-on-enter="ENTER_SENDS" :enterkeyhint="ENTER_SENDS ? 'send' : 'enter'" :autofocus="ENTER_SENDS" :rows="1" :maxrows="EDITOR_MAX_ROWS" placeholder="描述要一起做的事…" aria-label="第一条消息" variant="outline" color="neutral" class="channel-composer" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="start">
        <template #header>
          <div v-if="view.attachment_drafts.length" class="attachment-drafts">
            <div v-for="file in view.attachment_drafts" :key="file.id" :class="file.preview_url ? 'attachment-draft-image' : 'attachment-draft-file'">
              <img v-if="file.preview_url" :src="file.preview_url" :alt="file.file_name" :title="file.file_name">
              <template v-else>
                <span v-html="bridge.attachment_file_icon(file.file_name)"></span>
                <span class="attachment-name"><span :title="file.file_name">{{ file.file_name }}</span><small>{{ bridge.attachment_size(file.size) }}</small></span>
              </template>
              <button type="button" class="attachment-remove" :aria-label="`移除 ${file.file_name}`" :disabled="creating" @click="act('remove_attachment', file.id)"><UIcon name="i-lucide-x" /></button>
            </div>
          </div>
        </template>
        <template #footer>
          <template v-if="voice.state.status">
            <UTooltip :text="ENTER_SENDS ? '取消 · Esc' : '取消'"><UButton type="button" icon="i-lucide-x" color="neutral" variant="ghost" size="sm" class="channel-voice-button" aria-label="取消语音输入" @click="voice.cancel()" /></UTooltip>
            <span class="channel-voice-levels" :class="{ 'is-discarding': voice_press.hold.discard }" role="status" :aria-label="voice.state.status === 'recording' ? `正在录音 ${format_voice_time(voice.state.seconds)}` : '正在识别'">
              <template v-if="voice.state.status === 'recording'"><span class="channel-voice-bars"><i v-for="(level, index) in voice.state.levels" :key="index" :style="{ transform: `scaleY(${0.15 + level * 0.85})` }" /></span><small>{{ format_voice_time(voice.state.seconds) }}</small><small v-if="voice_press.hold.by" class="channel-voice-hint">{{ voice_press.hold.discard ? '松开取消' : voice_press.hold.by === 'touch' ? '松开转文字 · 上滑取消' : '松开空格转文字' }}</small></template>
              <small v-else>{{ voice.state.status === 'starting' ? '正在打开麦克风…' : '正在识别…' }}</small>
            </span>
            <UTooltip :text="ENTER_SENDS ? '完成，转成文字 · Enter' : '完成，转成文字'"><UButton type="button" icon="i-lucide-check" color="neutral" size="sm" class="channel-primary-button channel-round-button" aria-label="结束录音并转成文字" :loading="voice.state.status !== 'recording'" @click="voice.toggle()" /></UTooltip>
          </template>
          <template v-else>
            <UButton type="button" icon="i-lucide-paperclip" aria-label="添加附件" title="图片、PDF 或其他文件 · 每个最多 20 MiB" color="neutral" variant="ghost" size="sm" :disabled="creating" @click="act('choose_attachments')" />
            <UTooltip :text="ENTER_SENDS ? '语音输入 · 也可按住空格说话' : '按住说话，或轻点开始'"><UButton type="button" icon="i-lucide-mic" color="neutral" variant="ghost" size="sm" class="channel-voice-button channel-voice-mic" aria-label="语音输入" :disabled="creating" @pointerdown="voice_press.pointerdown" @click="voice_press.click" @contextmenu.prevent /></UTooltip>
            <UButton type="button" icon="i-lucide-arrow-up" color="neutral" size="sm" class="channel-primary-button channel-round-button channel-send" aria-label="新建房间并发送" title="发送 · Enter" :loading="creating" :disabled="!has_draft || Boolean(pending)" @click="start" />
          </template>
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span>发送后新建房间</span><span class="channel-draft-length"><span v-if="text_length" :class="{ 'is-near-limit': near_length_limit }">{{ text_length }} / {{ bridge.max_message_length }}<span class="channel-note-divider">·</span></span><span class="channel-key-hint"><kbd>Enter</kbd> 发送<span class="channel-note-divider">·</span><kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span></span></div>
    </div></div>
  </div>
</template>

<style scoped>
/* channel.css lays .room-welcome out on the room's grid and inset, so the composer sits exactly where the room's does
   and the text above it shares its column. */
.room-welcome { width: 100%; }
.room-welcome-hero { grid-column: 2; grid-row: 2; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; width: 100%; max-width: var(--channel-reading-width); margin-inline: auto; padding: 24px var(--message-inset-end, 16px) 24px 16px; text-align: center; }
.room-welcome-hero > [class*="icon"] { width: 34px; height: 34px; color: var(--ui-text-dimmed); }
.room-welcome-hero h2 { color: var(--ui-text-highlighted); font-size: 24px; font-weight: 600; }
.room-welcome-hero p { max-width: 420px; margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; text-wrap: pretty; }
@media (max-width: 700px) {
  .room-welcome-hero { padding: 16px 20px; }
  .room-welcome-hero h2 { font-size: 20px; }
}
</style>

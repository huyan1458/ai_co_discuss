<script setup>
import { computed, inject, nextTick, ref, watch } from "vue";

const emit = defineEmits(["detail"]);
const { view, bridge, field, act, pending } = inject("discussion");
const text = field("message-input");
const author = field("author-select");
const kind = field("message-kind");
const search = field("search-input");
const transcript = ref(null);
const input = ref(null);
const follow_tail = ref(true);
const origin = location.origin;
const FOLLOW_TAIL_THRESHOLD = 70;
const identities = Object.keys(bridge.identities);
const kinds = [{ label: "运行回执", value: "receipt" }, { label: "普通发言 / 代发", value: "opinion" }, { label: "主持发言", value: "moderation" }, { label: "主持人代发", value: "forward" }];
const day_label = computed(() => view.value.messages.length ? new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(view.value.messages[0].created_at)) : "讨论记录");
const author_note = computed(() => kind.value === "receipt" ? "运行回执，由用户录入" : kind.value === "moderation" ? "主持发言" : kind.value === "forward" ? `由 ${view.value.room?.host} 代发` : author.value === "用户" ? "以自己的身份发言" : `代发 ${author.value} 的观点`);

/** Keep polling from moving a reader who has scrolled away from the latest item. */
function track_scroll() {
  const element = transcript.value;
  if (element) follow_tail.value = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
}

/** Reveal new records only when the reader was already at the end. */
async function follow_messages() {
  await nextTick();
  if (follow_tail.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
}
watch(() => view.value.messages, follow_messages);
watch(() => view.value.room?.id, () => { follow_tail.value = true; });

/** Associate the reply and focus the visible Nuxt UI editor. */
async function reply_to(message) {
  await act("reply", message);
  input.value?.textareaRef?.focus();
}

/** Send from the shared draft and follow the saved message. */
async function send() {
  if (!text.value.trim() || pending.value) return;
  follow_tail.value = true;
  await act("send");
  await follow_messages();
}

/** Honor the existing shortcut without submitting a composing IME character. */
function on_key(event) {
  if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="discussion-tools">
    <form class="record-search" @submit.prevent="act('filter', { query: search })">
      <UInput v-model="search" icon="i-lucide-search" variant="none" size="sm" placeholder="搜索发言或 #编号" aria-label="搜索讨论记录" class="search-box" />
      <UButton v-if="search || view.query" icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="清除搜索" @click="search = ''; act('filter', { query: '' })" />
      <UButton type="submit" color="neutral" variant="ghost" size="xs" label="搜索" />
    </form>
    <UButton icon="i-lucide-at-sign" :variant="view.mention_only ? 'soft' : 'ghost'" :color="view.mention_only ? 'primary' : 'neutral'" size="xs" :aria-pressed="view.mention_only" label="提到我" @click="act('filter', { mention: !view.mention_only })" />
  </div>
  <div ref="transcript" class="studio-transcript" aria-label="聊天记录" @scroll="track_scroll">
    <div class="transcript-inner">
      <div class="transcript-divider"><span>{{ view.query || view.mention_only ? `筛选结果 · ${view.total || 0} 条` : day_label }}</span><i></i><span>原始记录</span></div>
      <article v-for="message in view.messages" :key="message.id" class="studio-message" :class="{ 'is-moderation': message.kind === 'moderation' }">
        <div class="message-mark" :class="bridge.identities[message.author]?.style">{{ bridge.identities[message.author]?.initials || '·' }}</div>
        <div class="message-content">
          <div class="message-byline"><strong>{{ message.author }}</strong><span v-if="message.source === 'demo'" class="demo-label">示例</span><span v-else class="message-source">{{ bridge.sources[message.source] }}</span><span v-if="message.kind === 'moderation'" class="moderation-label">主持人</span><span v-if="message.kind === 'receipt'" class="message-source">运行回执</span><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time></div>
          <button v-if="message.reply_to" class="message-quote" @click="emit('detail', message.reply_to)"><UIcon name="i-lucide-corner-up-left" /> 回复 #{{ message.reply_to }} <span>查看原文</span></button>
          <p class="message-prose">{{ message.text }}</p>
          <div class="message-foot"><button @click="emit('detail', message.id)">#{{ message.id }}</button><span v-if="message.submitted_by && message.submitted_by !== message.author">{{ message.submitted_by }} 代发</span><span v-if="message.turn_id">回答安排 #{{ message.turn_id }}</span>
            <div class="message-operations"><UButton icon="i-lucide-corner-up-left" label="回复" size="xs" variant="ghost" color="neutral" :aria-label="`回复 #${message.id}`" @click="reply_to(message)" /><UTooltip text="复制原文链接"><UButton icon="i-lucide-link" size="xs" variant="ghost" color="neutral" :aria-label="`复制 #${message.id} 原文链接`" @click="act('copy', `${origin}/r/${view.room.id}/messages/${message.id}`)" /></UTooltip></div>
          </div>
        </div>
      </article>
      <div v-if="!view.messages.length" class="transcript-empty"><UIcon :name="view.query || view.mention_only ? 'i-lucide-search' : 'i-lucide-message-square'" /><h3>{{ view.query || view.mention_only ? '没有找到相关发言' : '讨论从第一句话开始' }}</h3><p>{{ view.query || view.mention_only ? '换个关键词，或清除筛选查看完整记录。' : '提出问题、补充证据，或分享一个不同的看法。' }}</p></div>
    </div>
  </div>
  <div v-if="view.pages > 1" class="studio-pagination"><UButton icon="i-lucide-chevron-left" label="上一页" color="neutral" variant="ghost" size="xs" :disabled="view.page <= 1" @click="act('filter', { page: view.page - 1 })" /><span>{{ view.page }} / {{ view.pages }}</span><UButton trailing-icon="i-lucide-chevron-right" label="下一页" color="neutral" variant="ghost" size="xs" :disabled="view.page >= view.pages" @click="act('filter', { page: view.page + 1 })" /></div>
  <div class="composer-dock">
    <form class="studio-composer" @submit.prevent="send">
      <div class="composer-options"><span class="composer-avatar" :class="bridge.identities[author]?.style">{{ bridge.identities[author]?.initials }}</span><USelect v-model="author" :items="identities" :disabled="kind === 'moderation'" variant="none" size="sm" aria-label="发言身份" class="identity-select" /><span class="option-separator"></span><USelect v-model="kind" :items="kinds" variant="none" size="sm" aria-label="发言职责" class="kind-select" /><span class="author-note">{{ author_note }}</span></div>
      <div v-if="view.reply_to" class="composer-reference"><UIcon name="i-lucide-corner-up-left" /><span>回复 #{{ view.reply_to }}</span><UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="取消回复" @click="act('cancel_reply')" /></div>
      <div v-if="view.turn_reply_to" class="composer-reference"><UIcon name="i-lucide-message-square-reply" /><span>回答安排 #{{ view.turn_reply_to }} · {{ author }}，由 {{ view.room.host }} 代发</span><UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="取消关联安排" @click="act('cancel_answer')" /></div>
      <UTextarea ref="input" v-model="text" variant="none" :rows="2" :maxrows="5" autoresize :maxlength="4000" required placeholder="写下你的观点，或用 @ 提及参与者…" aria-label="留言正文" class="studio-editor" @keydown="on_key" />
      <div class="composer-bottom"><span><UIcon name="i-lucide-at-sign" /> 提及参与者 <span class="keyboard-hint">· Ctrl + Enter 发送</span></span><UButton type="submit" trailing-icon="i-lucide-arrow-up" label="发送" :disabled="!text.trim()" :loading="pending === 'send'" class="send-button" /></div>
    </form>
    <div class="discussion-footnote"><span>本地 CLI 可读写 · 在线 AI 的观点由用户代发</span><span>{{ text.length }} / 4000</span></div>
  </div>
</template>

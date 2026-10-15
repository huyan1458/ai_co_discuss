<script setup>
import { computed, inject, nextTick, ref, watch } from "vue";

const emit = defineEmits(["detail"]);
const { view, bridge, field, act, pending } = inject("discussion");
const text = field("message-input");
const author = field("author-select");
const kind = field("message-kind");
const search = field("search-input");
const transcript = ref(null);
const prompt = ref(null);
const follow_tail = ref(true);
const FOLLOW_TAIL_THRESHOLD = 70;
const room = computed(() => view.value.room);
const identities = computed(() => Object.entries(bridge.identities).map(([name, identity]) => ({
  label: name, value: name,
  avatar: { text: identity.initials, alt: name, class: `channel-avatar ${identity.style}` },
  description: name === "用户" ? "发起与协助" : room.value?.experts?.[name] === "cli" ? "本地 CLI · 读写" : room.value?.experts?.[name] === "online" ? "在线 AI · 只读" : "未配置参与方式",
})));
const selected_identity = computed(() => identities.value.find((item) => item.value === author.value));
const kinds = [{ label: "运行回执", value: "receipt" }, { label: "普通发言 / 代发", value: "opinion", icon: "i-lucide-message-square" }, { label: "主持发言", value: "moderation", icon: "i-lucide-list-checks" }, { label: "主持人代发", value: "forward", icon: "i-lucide-forward" }];
const date_formatter = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" });
const author_note = computed(() => kind.value === "receipt" ? "运行回执，由用户录入" : kind.value === "forward" ? `${room.value.host} 代发` : kind.value === "moderation" ? "主持发言" : author.value === "用户" ? "本人发言" : `代发 ${author.value} 的观点`);

/** Split the loaded chronological page at local calendar boundaries. */
const message_groups = computed(() => {
  const groups = [];
  for (const message of view.value.messages) {
    const date = new Date(message.created_at);
    const key = date.toLocaleDateString();
    if (groups.at(-1)?.key !== key) groups.push({ key, label: date_formatter.format(date), messages: [] });
    groups.at(-1).messages.push(message);
  }
  return groups;
});

/** Polling follows new messages only while the reader is near the end. */
function track_scroll() {
  const element = transcript.value;
  if (element) follow_tail.value = element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_TAIL_THRESHOLD;
}

/** Reveal saved messages without interrupting a reader of earlier records. */
async function follow_messages() {
  await nextTick();
  if (follow_tail.value && transcript.value) transcript.value.scrollTop = transcript.value.scrollHeight;
}
watch(() => view.value.messages, follow_messages, { immediate: true });
watch(() => view.value.room?.id, () => { follow_tail.value = true; });
watch(() => view.value.tab, (tab) => { if (tab === "discussion") follow_messages(); });

/** Select the shared reply target and focus the library's chat editor. */
async function reply_to(message) { await act("reply", message); prompt.value?.textareaRef?.focus(); }

/** Send the shared draft through the established idempotent controller. */
async function send() {
  if (!text.value.trim() || pending.value) return;
  follow_tail.value = true;
  await act("send");
  await follow_messages();
}

/** Copy a durable reference to the original record. */
function copy_message(message) { act("copy", `${location.origin}/r/${room.value.id}/messages/${message.id}`); }

/** Emphasize known participant mentions while preserving literal message text. */
function text_parts(content) {
  return content.split(/(@(?:Codex|Claude|Gemini|DeepSeek|Qwen|用户)(?!\w))/g)
    .map((value, index) => ({ text: value, mention: index % 2 === 1 }));
}
</script>

<template>
  <section class="channel-conversation" role="tabpanel" aria-label="消息">
    <div v-if="view.query || view.mention_only" class="channel-filter-summary"><span>{{ view.query ? `“${view.query}”` : `@${author}` }} · {{ view.total }} 条结果</span><UButton label="清除筛选" size="xs" variant="link" color="neutral" @click="search = ''; act('filter', { query: '', mention: false })" /></div>
    <div ref="transcript" class="channel-transcript" aria-label="聊天记录" @scroll="track_scroll">
      <div v-for="group in message_groups" :key="group.key" class="channel-message-group">
        <USeparator :label="group.label" class="channel-date-divider" />
        <UChatMessage v-for="message in group.messages" :id="String(message.id)" :key="message.id" :role="message.author === '用户' ? 'user' : 'assistant'" :parts="[]" side="left" variant="naked" color="neutral" class="channel-message" :class="{ 'channel-moderation': message.kind === 'moderation' }" :ui="{ container: 'channel-message-container', leading: 'channel-message-leading', body: 'channel-message-body' }">
          <template #leading><UAvatar :text="bridge.identities[message.author]?.initials || '?'" :alt="message.author" size="md" class="channel-avatar" :class="bridge.identities[message.author]?.style" /></template>
          <template #body>
            <div class="channel-message-byline"><strong>{{ message.author }}</strong><UBadge size="xs" color="neutral" variant="soft" class="channel-source">{{ bridge.sources[message.source] }}</UBadge><UBadge v-if="message.kind === 'moderation'" size="xs" color="neutral" variant="soft" class="channel-source">主持人</UBadge><UBadge v-if="message.kind === 'receipt'" size="xs" color="neutral" variant="soft" class="channel-source">运行回执</UBadge><span v-if="message.submitted_by && message.submitted_by !== message.author && !(message.source === 'proxy' && message.submitted_by === '用户')" class="channel-message-provenance">{{ message.submitted_by }} 代发</span><span v-if="message.turn_id" class="channel-message-provenance">回答安排 #{{ message.turn_id }}</span><time :title="new Date(message.created_at).toLocaleString('zh-CN')">{{ bridge.format_time(message.created_at) }}</time><UButton :label="`#${message.id}`" color="neutral" variant="link" size="xs" :aria-label="`查看原文 #${message.id}`" class="channel-message-id" @click="emit('detail', message.id)" /></div>
            <UButton v-if="message.reply_to" :label="`回复 #${message.reply_to}`" icon="i-lucide-corner-up-left" variant="link" color="neutral" size="xs" class="channel-message-reference" :aria-label="`回复 #${message.reply_to} 查看原文`" @click="emit('detail', message.reply_to)" />
            <p class="channel-message-text"><template v-for="(part, index) in text_parts(message.text)" :key="index"><span v-if="part.mention" class="channel-mention">{{ part.text }}</span><template v-else>{{ part.text }}</template></template></p>
            <div class="channel-message-actions"><UTooltip text="回复"><UButton icon="i-lucide-corner-up-left" size="xs" color="neutral" variant="ghost" :aria-label="`回复 #${message.id}`" @click="reply_to(message)" /></UTooltip><UTooltip text="复制原文链接"><UButton icon="i-lucide-link" size="xs" color="neutral" variant="ghost" :aria-label="`复制 #${message.id} 原文链接`" @click="copy_message(message)" /></UTooltip><UTooltip text="查看原文"><UButton icon="i-lucide-expand" size="xs" color="neutral" variant="ghost" :aria-label="`展开 #${message.id}`" @click="emit('detail', message.id)" /></UTooltip></div>
          </template>
        </UChatMessage>
      </div>
      <div v-if="!view.messages.length" class="channel-empty"><UIcon :name="view.query || view.mention_only ? 'i-lucide-search' : 'i-lucide-hash'" /><h2>{{ view.query || view.mention_only ? '没有找到消息' : room.title }}</h2><p>{{ view.query || view.mention_only ? '试试其他关键词，或清除筛选。' : '这是频道的开始。发送第一条消息，开启讨论。' }}</p></div>
    </div>
    <div v-if="view.pages > 1" class="channel-pagination"><UButton icon="i-lucide-chevron-left" label="上一页" color="neutral" variant="ghost" size="xs" :disabled="view.page <= 1" @click="act('filter', { page: view.page - 1 })" /><span>{{ view.page }} / {{ view.pages }}</span><UButton trailing-icon="i-lucide-chevron-right" label="下一页" color="neutral" variant="ghost" size="xs" :disabled="view.page >= view.pages" @click="act('filter', { page: view.page + 1 })" /></div>
    <div class="channel-composer-dock">
      <UChatPrompt ref="prompt" v-model="text" :submit-on-enter="false" :autofocus="false" :rows="1" :maxrows="6" :maxlength="4000" :placeholder="`发消息到 # ${room.title}`" aria-label="留言正文" variant="outline" color="neutral" class="channel-composer" :ui="{ header: 'channel-composer-header', base: 'channel-editor', footer: 'channel-composer-footer' }" @submit="send">
        <template #header>
          <div v-if="view.reply_to || view.turn_reply_to" class="channel-reply-draft"><UIcon name="i-lucide-corner-up-left" /><span>{{ view.turn_reply_to ? `回答安排 #${view.turn_reply_to} · ${room.host} 代发` : `回复 #${view.reply_to}` }}</span><UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" :aria-label="view.turn_reply_to ? '取消关联安排' : '取消回复'" @click="act(view.turn_reply_to ? 'cancel_answer' : 'cancel_reply')" /></div>
        </template>
        <template #footer>
          <div class="channel-composer-identity">
            <USelectMenu v-model="author" :items="identities" value-key="value" :avatar="selected_identity?.avatar" :disabled="kind === 'moderation'" :search-input="{ placeholder: '搜索身份…', icon: 'i-lucide-search' }" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言身份" class="channel-author-select" :ui="{ content: 'channel-select-menu channel-identity-menu', itemLeadingAvatarSize: 'xs' }" />
            <span class="channel-control-divider"></span>
            <USelect v-model="kind" :items="kinds" :content="{ side: 'top', align: 'start', sideOffset: 10 }" variant="none" size="sm" aria-label="发言职责" class="channel-kind-select" :ui="{ content: 'channel-select-menu' }" />
          </div>
          <span class="channel-shortcut"><UKbd value="ctrl" /><UKbd value="enter" /></span>
          <UButton type="submit" trailing-icon="i-lucide-arrow-up" color="neutral" label="发送" size="sm" class="channel-primary-button channel-send" :disabled="!text.trim()" :loading="pending === 'send'" />
        </template>
      </UChatPrompt>
      <div class="channel-composer-note"><span>{{ author_note }}<span class="channel-note-divider">·</span>在线 AI 的观点需代发</span><span class="channel-draft-length">{{ text.length }} / 4000<span class="channel-note-divider">·</span>Enter 换行</span></div>
    </div>
  </section>
</template>

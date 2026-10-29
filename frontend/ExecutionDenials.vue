<script setup>
/**
 * Operations a member's software refused without asking, since a headless run cannot ask for approval. Laid out like
 * the progress notes, each names the tool and what it tried. When the owner can allow them, one button adds their rules
 * to the member and puts the original message back in the input to send again, as 重发 does.
 */
defineProps({
  /** The refused operations: {tool, detail, rule}. */
  denials: { type: Array, required: true },
  /** Whether the owner can allow them here: the local service is connected and the original message is loaded. */
  allowable: Boolean,
  busy: Boolean,
  error: { type: String, default: "" },
});
const emit = defineEmits(["allow"]);
</script>

<template>
  <div class="channel-answer-summary channel-execution-denials">
    <small>被拒操作</small>
    <div class="channel-message-text">
      <ul>
        <li v-for="item in denials" :key="item.detail"><code>{{ item.tool }}</code> {{ item.detail }}</li>
      </ul>
      <UButton v-if="allowable" label="允许并重发" icon="i-lucide-shield-check" size="xs" variant="soft" color="neutral" :loading="busy"
        title="把这些操作加入该成员的放行规则（下次执行起生效），并把原消息填回输入框" @click="emit('allow')" />
      <p v-if="error" class="channel-failure-error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

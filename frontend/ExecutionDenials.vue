<script setup>
/**
 * Operations a member's software refused without asking, since a headless run cannot ask for approval. Laid out like
 * the progress notes, each names the tool and what it tried. On a completed run the row folds quietly (the member
 * worked around the refusal); on a failed or stopped run it stays open with one button to add the rules and restore
 * the original message in the input, as 重发 does.
 */
import { ref } from "vue";

defineProps({
  /** The refused operations: {tool, detail, rule}. */
  denials: { type: Array, required: true },
  /** Whether the owner can allow them here: the local service is connected and the original message is loaded. */
  allowable: Boolean,
  /** Start collapsed for completed runs whose answer still landed, keeping the record inspectable without noise. */
  folded: Boolean,
  busy: Boolean,
  error: { type: String, default: "" },
});
const emit = defineEmits(["allow"]);
const open = ref(false);
</script>

<template>
  <div class="channel-answer-summary channel-execution-denials">
    <small>{{ t("被拒操作") }}</small>
    <div class="channel-message-text">
      <ul v-if="!folded || open">
        <li v-for="item in denials" :key="item.detail"><code>{{ item.tool }}</code> {{ item.detail }}</li>
      </ul>
      <UButton v-if="folded" :label="open ? t('收起') : t('{count} 次', { count: denials.length })" :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        variant="link" color="neutral" size="xs" class="channel-answer-toggle" :class="{ 'is-folded': !open }" :aria-expanded="open"
        :aria-label="open ? t('收起被拒操作') : t('展开 {count} 次被拒操作', { count: denials.length })" @click="open = !open" />
      <UButton v-if="allowable" :label="t('允许并重发')" icon="i-lucide-shield-check" size="xs" variant="soft" color="neutral" :loading="busy"
        :title="t('把这些操作加入该成员的放行规则（下次执行起生效），并把原消息填回输入框')" @click="emit('allow')" />
      <p v-if="error" class="channel-failure-error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
/* Folded, the toggle stands on the label's baseline like the progress notes toggle does. */
.channel-answer-toggle.is-folded { min-height: 0; margin-top: 0; }
</style>

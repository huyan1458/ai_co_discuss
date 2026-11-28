<script setup>
/**
 * A question mark beside a label that explains it on hover or focus (#15685): one sentence the control's name does not
 * already say, kept off the page so the form reads clean. Props: `text`, the sentence.
 */
defineProps({ text: { type: String, required: true } });
</script>

<template>
  <UTooltip :text="text" :ui="{ content: 'help-tip-content' }">
    <button type="button" class="help-tip" :aria-label="text" @click.prevent><UIcon name="i-lucide-circle-help" /></button>
  </UTooltip>
</template>

<style scoped>
.help-tip { display: inline-grid; place-items: center; width: 18px; height: 18px; margin-left: 4px; padding: 0; border-radius: 50%; color: var(--ui-text-dimmed); vertical-align: middle; cursor: help; }
.help-tip:hover, .help-tip:focus-visible { color: var(--ui-text-toned); }
.help-tip > :deep(svg) { width: 14px; height: 14px; }
:global(.help-tip-content) { max-width: 300px; height: auto; white-space: normal; line-height: 1.5; }
</style>

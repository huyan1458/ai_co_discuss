<script setup>
import { computed, ref } from "vue";
import { file_preview } from "./file-preview.js";
import { inline_visual_collapsed, inline_visual_document, inline_visual_theme, open_html_preview_tab } from "./inline-visual.js";
import InlineHtmlFrame from "./InlineHtmlFrame.vue";
import { t } from "./i18n.js";

const props = defineProps({ visual: { type: Object, required: true } });
const panel = ref(null);
const collapsed = ref(inline_visual_collapsed(props.visual));
const showing_source = ref(false);

function set_collapsed(value) {
  collapsed.value = value;
  inline_visual_collapsed(props.visual, value);
}

function toggle_source() {
  if (collapsed.value) {
    showing_source.value = true;
    set_collapsed(false);
  } else showing_source.value = !showing_source.value;
}

function open_tab() {
  open_html_preview_tab(props.visual.name, props.visual.source, inline_visual_theme(panel.value), true);
}

function download() {
  const link = document.createElement("a");
  // The file carries the room's unified styles: a page drawn with the cd-* classes alone would open unstyled.
  const page = inline_visual_document(props.visual.source, false, { measure: false });
  link.href = URL.createObjectURL(new Blob([page], { type: "text/html;charset=utf-8" }));
  link.download = props.visual.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// One list feeds the pointer toolbar's icons and the touch menu, so both offer the same actions. Collapse stays a button
// of its own in both: the room keeps the visual's place on screen only for an in-transcript control with aria-controls.
const actions = computed(() => [
  showing_source.value
    ? { label: t('预览'), icon: "i-lucide-eye", onSelect: toggle_source }
    : { label: t('源码'), icon: "i-lucide-code-xml", onSelect: toggle_source },
  { label: t('放大'), icon: "i-lucide-maximize-2", onSelect: () => file_preview.open_visual?.(props.visual) },
  { label: t('新标签页'), icon: "i-lucide-external-link", onSelect: open_tab },
  { label: t('下载'), icon: "i-lucide-download", onSelect: download },
]);
</script>

<template>
  <div ref="panel" class="channel-message-visual" :class="{ 'is-collapsed': collapsed }">
    <div v-if="collapsed" class="channel-visual-collapsed">
      <UIcon name="i-lucide-chart-spline" class="channel-visual-collapsed-icon" />
      <span class="channel-visual-name">{{ t('交互式可视化') }}</span>
      <UButton color="neutral" variant="ghost" size="xs" icon="i-lucide-code-xml" :aria-label="t('源码')" :title="t('源码')" @click="toggle_source" />
      <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-chevrons-up-down" :label="t('展开')" class="channel-inline-html-toggle"
        :aria-expanded="false" @click="set_collapsed(false)" />
    </div>
    <div v-else :id="`channel-visual-${visual.id}`" class="channel-visual-content">
      <pre v-if="showing_source"><code v-text="visual.source"></code></pre>
      <InlineHtmlFrame v-else :visual="visual" />
      <div class="channel-visual-tools" role="toolbar" :aria-label="t('交互式可视化')">
        <UButton v-for="action in actions" :key="action.icon" class="channel-visual-tool" color="neutral" variant="ghost" size="xs" :icon="action.icon"
          :aria-label="action.label" :title="action.label" @click="action.onSelect" />
        <UDropdownMenu :items="actions" :content="{ align: 'end', sideOffset: 6 }" :ui="{ content: 'channel-menu' }">
          <UButton class="channel-visual-more" color="neutral" variant="ghost" size="xs" icon="i-lucide-ellipsis" :aria-label="t('更多操作')" />
        </UDropdownMenu>
        <span class="channel-visual-tools-divider" aria-hidden="true"></span>
        <UButton class="channel-inline-html-toggle" color="neutral" variant="ghost" size="xs" icon="i-lucide-chevrons-down-up"
          :aria-label="t('收起')" :title="t('收起')" :aria-expanded="true" :aria-controls="`channel-visual-${visual.id}`" @click="set_collapsed(true)" />
      </div>
    </div>
  </div>
</template>

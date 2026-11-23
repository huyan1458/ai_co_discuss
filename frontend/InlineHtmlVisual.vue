<script setup>
import { ref } from "vue";
import { file_preview } from "./file-preview.js";
import { inline_visual_collapsed, inline_visual_theme, open_html_preview_tab } from "./inline-visual.js";
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
  link.href = URL.createObjectURL(new Blob([props.visual.source], { type: "text/html;charset=utf-8" }));
  link.download = props.visual.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
</script>

<template>
  <div ref="panel" class="channel-message-visual" :class="{ 'is-collapsed': collapsed }">
    <div v-if="!collapsed" :id="`channel-visual-${visual.id}`" class="channel-visual-content">
      <pre v-if="showing_source"><code v-text="visual.source"></code></pre>
      <InlineHtmlFrame v-else :visual="visual" />
    </div>
    <div class="channel-visual-actions">
      <span v-if="collapsed" class="channel-visual-name">{{ t('交互式可视化') }}</span>
      <UButton color="neutral" variant="ghost" size="xs" class="channel-inline-html-toggle"
        :label="collapsed ? t('展开') : t('收起')" :aria-expanded="!collapsed"
        :aria-controls="collapsed ? undefined : `channel-visual-${visual.id}`" @click="set_collapsed(!collapsed)" />
      <UButton color="neutral" variant="ghost" size="xs" :label="showing_source && !collapsed ? t('预览') : t('源码')" @click="toggle_source" />
      <UButton color="neutral" variant="ghost" size="xs" :label="t('放大')" @click="file_preview.open_visual?.(visual)" />
      <UButton color="neutral" variant="ghost" size="xs" :label="t('新标签页')" @click="open_tab" />
      <UButton color="neutral" variant="ghost" size="xs" :label="t('下载')" @click="download" />
    </div>
  </div>
</template>

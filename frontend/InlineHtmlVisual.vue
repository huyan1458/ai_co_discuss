<script setup>
import { computed, inject, onBeforeUnmount, ref } from "vue";
import { ATTACHMENT_TEXT_LIMIT, create_inline_html_preview } from "./file-preview.js";
import { inline_visual_collapsed, inline_visual_document } from "./inline-visual.js";
import InlineHtmlFrame from "./InlineHtmlFrame.vue";
import { t } from "./i18n.js";

const props = defineProps({ file: { type: Object, required: true } });
const { bridge, act } = inject("discussion");
const collapsed = ref(inline_visual_collapsed(props.file));
const { preview, open, close } = create_inline_html_preview(bridge.attachment_url, (source) => inline_visual_document(source, true));
const fallback = computed(() => {
  if (props.file.size > ATTACHMENT_TEXT_LIMIT || preview.value?.status === "truncated") return t('HTML 附件超过 2 MiB，请在预览窗口查看源码。');
  return preview.value?.status === "error" ? preview.value.error : "";
});

function load_visible() {
  if (!preview.value) open(props.file);
}

function toggle() {
  collapsed.value = !collapsed.value;
  inline_visual_collapsed(props.file, collapsed.value);
  if (collapsed.value && preview.value?.status === "loading") close();
}

onBeforeUnmount(close);
</script>

<template>
  <div class="channel-message-visual" :class="{ 'is-collapsed': collapsed }">
    <template v-if="fallback">
      <div v-html="bridge.attachment_markup([file])"></div>
      <p class="channel-visual-fallback" role="status">{{ fallback }}</p>
    </template>
    <template v-else>
      <InlineHtmlFrame v-if="!collapsed" :id="`channel-visual-${file.id}`" :file="file" :preview="preview" automatic @visible="load_visible" />
      <div class="channel-visual-actions">
        <bdi class="channel-visual-name">{{ file.file_name }}</bdi>
        <UButton color="neutral" variant="ghost" size="xs" class="channel-inline-html-toggle"
          :label="collapsed ? t('展开') : t('收起')" :aria-expanded="!collapsed"
          :aria-controls="collapsed ? undefined : `channel-visual-${file.id}`" @click="toggle" />
        <UButton color="neutral" variant="ghost" size="xs" :label="t('放大')" @click="act('preview_attachment', { ...file, source: false })" />
        <UButton color="neutral" variant="ghost" size="xs" :label="t('源码')" @click="act('preview_attachment', { ...file, source: true })" />
        <a class="channel-visual-download" v-bind="bridge.attachment_download_link(file)" download>{{ t('下载') }}</a>
      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref, shallowRef, watch } from "vue";
import InlineHtmlVisual from "./InlineHtmlVisual.vue";

const props = defineProps({ markup: String, blocks: Array, message: Object });
const body = ref(null), placements = shallowRef([]);

/** Mount a visual at each slot emitted by the Markdown renderer. */
function place_visuals() {
  placements.value = Array.from(body.value.querySelectorAll("[data-visual-slot]"), (target) => {
    const ordinal = Number(target.dataset.visualSlot) + 1;
    const { id: message_id, room_id, created_at } = props.message;
    const author = props.message.author_label || props.message.author;
    return { target, visual: { id: `${room_id}-${message_id}-${ordinal}`, room_id, message_id, ordinal, created_at, author,
      name: `visual-${message_id}-${ordinal}.html`, source: props.blocks[ordinal - 1] } };
  });
}

onMounted(place_visuals);
watch(() => [props.markup, props.blocks], place_visuals, { flush: "post" });
</script>

<template>
  <div :id="`channel-answer-${message.id}`" ref="body" class="channel-message-text markdown-body" v-html="markup"></div>
  <Teleport v-for="{ visual, target } in placements" :key="visual.id" :to="target">
    <InlineHtmlVisual :visual="visual" />
  </Teleport>
</template>

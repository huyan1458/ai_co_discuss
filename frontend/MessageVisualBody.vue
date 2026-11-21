<script setup>
import { onMounted, ref, shallowRef, watch } from "vue";
import InlineHtmlVisual from "./InlineHtmlVisual.vue";

const props = defineProps({ visuals: { type: Object, required: true }, answer_id: { type: String, required: true } });
const body = ref(null), placements = shallowRef([]);

/** Move only the visual into the marker emitted at its Markdown reference. */
function place_visuals() {
  const files = new Map(props.visuals.files.map((file) => [file.id, file]));
  placements.value = Array.from(body.value.querySelectorAll("[data-visual-slot]"), (target) => ({ file: files.get(target.dataset.visualSlot), target }))
    .filter(({ file }) => file);
}

onMounted(place_visuals);
watch(() => props.visuals, place_visuals, { flush: "post" });
</script>

<template>
  <div :id="answer_id" ref="body" class="channel-message-text markdown-body" v-html="visuals.markup"></div>
  <Teleport v-for="{ file, target } in placements" :key="file.id" :to="target">
    <InlineHtmlVisual :file="file" />
  </Teleport>
</template>

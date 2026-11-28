<script setup>
/**
 * A workflow's canvas as a small picture (#15749): its nodes as boxes and its arrows as lines, scaled to fit. It shows
 * the shape of the collaboration only: no text, nothing to click. `flow` is the stored `{ nodes, edges }`; while it is
 * not read yet, or holds nothing beyond its start node, a plain placeholder stands in.
 */
import { computed } from "vue";

const props = defineProps({ flow: { type: Object, default: null } });

// The canvas's own node sizes (WorkflowCanvas.vue), so the picture keeps the canvas's proportions.
const WIDTH = { start: 96 }, HEIGHT = { start: 60, branch: 132 };
const NODE_WIDTH = 240, NODE_HEIGHT = 96, PADDING = 60;

const picture = computed(() => {
  const nodes = (props.flow?.nodes || []).map((node) => {
    const width = WIDTH[node.type] || NODE_WIDTH, height = HEIGHT[node.type] || NODE_HEIGHT;
    return { id: node.id, type: node.type, x: node.x || 0, y: node.y || 0, width, height };
  });
  if (nodes.length < 2) return null;
  const left = Math.min(...nodes.map((node) => node.x)) - PADDING, top = Math.min(...nodes.map((node) => node.y)) - PADDING;
  const right = Math.max(...nodes.map((node) => node.x + node.width)) + PADDING, bottom = Math.max(...nodes.map((node) => node.y + node.height)) + PADDING;
  const by_id = new Map(nodes.map((node) => [node.id, node]));
  const edges = (props.flow.edges || []).flatMap((edge) => {
    const source = by_id.get(edge.source), target = by_id.get(edge.target);
    if (!source || !target) return [];
    const x1 = source.x + source.width, y1 = source.y + source.height / 2, x2 = target.x, y2 = target.y + target.height / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    return [`M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`];
  });
  // Lines and corners keep a readable weight however far the canvas is scaled down.
  const scale = Math.max((right - left) / 320, (bottom - top) / 180, 1);
  return { nodes, edges, box: `${left} ${top} ${right - left} ${bottom - top}`, stroke: 1.2 * scale, radius: 6 * scale };
});
</script>

<template>
  <svg v-if="picture" class="workflow-thumb" :viewBox="picture.box" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path v-for="(path, index) in picture.edges" :key="index" :d="path" class="workflow-thumb-edge" :stroke-width="picture.stroke" />
    <rect v-for="node in picture.nodes" :key="node.id" :x="node.x" :y="node.y" :width="node.width" :height="node.height"
      :rx="node.type === 'start' ? node.height / 2 : picture.radius" class="workflow-thumb-node" :data-type="node.type" :stroke-width="picture.stroke" />
  </svg>
  <span v-else class="workflow-thumb is-empty" aria-hidden="true"><UIcon name="i-lucide-network" /></span>
</template>

<style scoped>
.workflow-thumb { display: block; width: 100%; height: 100%; }
.workflow-thumb.is-empty { display: grid; place-items: center; color: var(--ui-text-dimmed); }
.workflow-thumb.is-empty > :deep(svg) { width: 22px; height: 22px; opacity: .5; }
.workflow-thumb-edge { fill: none; stroke: var(--ui-text-dimmed); opacity: .7; }
.workflow-thumb-node { fill: color-mix(in srgb, var(--ui-text) 10%, transparent); stroke: var(--ui-border-accented); }
/* The host's own steps carry the accent, an expert card the neutral fill; the user's turns and branches sit between. */
.workflow-thumb-node[data-type="host"] { fill: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 26%, transparent); stroke: var(--channel-accent, var(--ui-primary)); }
.workflow-thumb-node[data-type="start"] { fill: color-mix(in srgb, var(--ui-text) 22%, transparent); stroke: none; }
.workflow-thumb-node[data-type="user"] { fill: color-mix(in srgb, var(--ui-warning) 18%, transparent); stroke: color-mix(in srgb, var(--ui-warning) 60%, transparent); }
</style>

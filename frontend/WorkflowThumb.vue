<script setup>
/**
 * A workflow's canvas as a small picture (#15749): its nodes as boxes and its arrows as lines, scaled to fit. It shows
 * the shape of the collaboration only: no text, nothing to click. `flow` is the stored `{ nodes, edges }`; while it is
 * not read yet, or holds nothing beyond its start node, a plain placeholder stands in.
 *
 * It is a schematic of the canvas, not a copy (#16090): columns keep their order but sit closer, every node gets one
 * small box centred where the canvas centres it, rows spread out when the flow is long and flat, and an arrow back to
 * an earlier column runs as a loop below the nodes it spans, as on the canvas, instead of cutting across the picture.
 */
import { computed } from "vue";

const props = defineProps({ flow: { type: Object, default: null } });

// The canvas's own heights (WorkflowCanvas.vue), only to find each node's middle, which the canvas lines up.
const CANVAS_HEIGHT = { start: 60, card: 96, host: 96, user: 96, sub: 96 };
const BRANCH_HEADER_HEIGHT = 64, BRANCH_ROW_HEIGHT = 30, BRANCH_PAD_BOTTOM = 10;
// Nodes this far apart on the canvas share a column.
const COLUMN_TOLERANCE = 60;
// The picture's own units: column pitch, box size and corner, the start's radius, a loop's drop below the nodes.
const COLUMN_PITCH = 200, BOX_WIDTH = 140, BOX_HEIGHT = 64, BOX_RADIUS = 16, START_RADIUS = 22, LOOP_DROP = 36, PADDING = 36;
// The thumbnail's shape (WorkflowOverview.vue: 16:8 less its padding); a flat flow's rows spread up to this much.
const FRAME_ASPECT = 2.2, MAX_SPREAD = 1.4;

function canvas_height(node) {
  if (node.type === "branch") return BRANCH_HEADER_HEIGHT + Math.max(1, node.branches?.length || 2) * BRANCH_ROW_HEIGHT + BRANCH_PAD_BOTTOM;
  return CANVAS_HEIGHT[node.type] || CANVAS_HEIGHT.card;
}

/** Each distinct canvas x (within COLUMN_TOLERANCE) becomes the next column, left to right. */
function column_index(nodes) {
  const xs = [...new Set(nodes.map((node) => node.x || 0))].sort((left, right) => left - right);
  const index = new Map();
  let column = -1, last = -Infinity;
  for (const x of xs) {
    if (x - last > COLUMN_TOLERANCE) column++;
    index.set(x, column);
    last = x;
  }
  return index;
}

const picture = computed(() => {
  const stored = props.flow?.nodes || [];
  if (stored.length < 2) return null;
  const columns = column_index(stored);
  const middles = stored.map((node) => (node.y || 0) + canvas_height(node) / 2);
  const top = Math.min(...middles), bottom = Math.max(...middles);
  const width = (Math.max(...columns.values()) * COLUMN_PITCH) + BOX_WIDTH;
  const spread = Math.min(MAX_SPREAD, Math.max(1, width / FRAME_ASPECT / Math.max(bottom - top + BOX_HEIGHT, 1)));
  const nodes = stored.map((node, index) => {
    const column = columns.get(node.x || 0);
    return { id: node.id, type: node.type, column, cx: column * COLUMN_PITCH + BOX_WIDTH / 2, cy: (middles[index] - top) * spread };
  });
  const by_id = new Map(nodes.map((node) => [node.id, node]));
  const forward = [], loops = [];
  for (const edge of props.flow.edges || []) {
    const source = by_id.get(edge.source), target = by_id.get(edge.target);
    if (!source || !target) continue;
    if (target.column > source.column) {
      const x1 = source.cx + half_width(source), x2 = target.cx - half_width(target), bend = (x2 - x1) / 2;
      forward.push(`M${x1} ${source.cy}C${x1 + bend} ${source.cy} ${x2 - bend} ${target.cy} ${x2} ${target.cy}`);
      continue;
    }
    // Back to an earlier column (or its own): down from the source, along below every node it spans, up into the target.
    const low = Math.min(source.column, target.column), high = Math.max(source.column, target.column);
    const floor = Math.max(...nodes.filter((node) => node.column >= low && node.column <= high).map((node) => node.cy)) + BOX_HEIGHT / 2 + LOOP_DROP;
    const y1 = source.cy + half_height(source), y2 = target.cy + half_height(target);
    loops.push(`M${source.cx} ${y1}C${source.cx} ${floor} ${target.cx} ${floor} ${target.cx} ${y2}`);
  }
  const ys = nodes.map((node) => node.cy);
  const box_top = Math.min(...ys) - BOX_HEIGHT / 2 - PADDING;
  const box_bottom = Math.max(...ys) + BOX_HEIGHT / 2 + PADDING + (loops.length ? LOOP_DROP : 0);
  const view_width = width + 2 * PADDING, view_height = box_bottom - box_top;
  // Lines keep about one screen pixel however far the picture is scaled down (the frame is about 320 pixels wide).
  const units_per_pixel = Math.max(view_width / 320, view_height / 146, 0.5);
  return { nodes, forward, loops, box: `${-PADDING} ${box_top} ${view_width} ${view_height}`, stroke: 1.25 * units_per_pixel };
});

function half_width(node) { return node.type === "start" ? START_RADIUS : BOX_WIDTH / 2; }
function half_height(node) { return node.type === "start" ? START_RADIUS : BOX_HEIGHT / 2; }

</script>

<template>
  <svg v-if="picture" class="workflow-thumb" :viewBox="picture.box" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
    <path v-for="(path, index) in picture.loops" :key="`loop-${index}`" :d="path" class="workflow-thumb-edge is-loop" :stroke-width="picture.stroke" />
    <path v-for="(path, index) in picture.forward" :key="index" :d="path" class="workflow-thumb-edge" :stroke-width="picture.stroke" />
    <template v-for="node in picture.nodes" :key="node.id">
      <circle v-if="node.type === 'start'" :cx="node.cx" :cy="node.cy" :r="START_RADIUS" class="workflow-thumb-node" data-type="start" />
      <rect v-else :x="node.cx - BOX_WIDTH / 2" :y="node.cy - BOX_HEIGHT / 2" :width="BOX_WIDTH" :height="BOX_HEIGHT" :rx="BOX_RADIUS"
        class="workflow-thumb-node" :data-type="node.type" :stroke-width="picture.stroke" />
    </template>
  </svg>
  <span v-else class="workflow-thumb is-empty" aria-hidden="true"><UIcon name="i-lucide-network" /></span>
</template>

<style scoped>
.workflow-thumb { display: block; width: 100%; height: 100%; }
.workflow-thumb.is-empty { display: grid; place-items: center; color: var(--ui-text-dimmed); }
.workflow-thumb.is-empty > :deep(svg) { width: 22px; height: 22px; opacity: .5; }
.workflow-thumb-edge { fill: none; stroke: var(--ui-text-dimmed); opacity: .55; }
.workflow-thumb-edge.is-loop { opacity: .35; }
/* The same tint per kind as the canvas's node bars (WorkflowCanvas.vue): host amber, user green, branch sky, sub-workflow violet. */
.workflow-thumb-node { --tint: var(--channel-accent, var(--ui-primary)); fill: color-mix(in srgb, var(--tint) 22%, var(--ui-bg)); stroke: color-mix(in srgb, var(--tint) 75%, transparent); }
.workflow-thumb-node[data-type="host"] { --tint: #e0b44a; }
.workflow-thumb-node[data-type="user"] { --tint: #2eb886; }
.workflow-thumb-node[data-type="branch"] { --tint: #38bdf8; }
.workflow-thumb-node[data-type="sub"] { --tint: #9b7cf0; }
.workflow-thumb-node[data-type="start"] { fill: var(--ui-text-dimmed); stroke: none; }
</style>

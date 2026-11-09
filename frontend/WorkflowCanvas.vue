<script setup>
/**
 * A workflow's flow canvas: member cards (the same expert cards as everywhere else) and host checkpoints joined by arrows.
 * Arrows from 开始 set who speaks after whom; cards side by side in one column work at once; an arrow back to an earlier
 * card makes a loop. The canvas compiles live into the host's relay (runner/workflow_flow.mjs), errors shown below.
 * Cards stay the workflow's own list: taking one off the canvas keeps it, removing it on the card drops it.
 */
import { computed, inject, nextTick, ref, watch } from "vue";
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Panel, Position, VueFlow, getBezierPath, getSmoothStepPath } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import ExpertCard from "./ExpertCard.vue";
import { access_label } from "../runner/expert_prompts.mjs";
import { compile_flow, empty_flow, flow_shape } from "../runner/workflow_flow.mjs";

const flow = defineModel("flow", { type: Object, default: null });
const agents = defineModel("agents", { type: Array, required: true });
const { bridge } = inject("discussion");
// Widths the layout leaves for each kind of node, and the gaps between columns and rows.
const NODE_WIDTH = { card: 272, start: 132, host: 150 };
const NODE_HEIGHT = { card: 276, start: 44, host: 44 };
const COLUMN_GAP = 88, ROW_GAP = 28;
// A loop's path: how far it leaves its ends sideways, how far below the nodes it passes, and its corner radius.
const LOOP_OUT = 24, LOOP_CLEARANCE = 36, LOOP_RADIUS = 14;
const CARD_HANDLE = ".workflow-node-grip";
const STATUS = { text: "", tone: "" };

/** A stored node as Vue Flow draws it; a card is dragged by its title bar so its own buttons keep working. */
function to_node(item) {
  const base = { id: item.id, type: item.type, position: { x: item.x || 0, y: item.y || 0 } };
  if (item.type === "card") return { ...base, data: { card: item.card }, dragHandle: CARD_HANDLE };
  return item.type === "start" ? { ...base, deletable: false } : base;
}

/** A stored arrow as Vue Flow draws it. */
function to_edge({ source, target }) {
  return { id: `${source}>${target}`, source, target, type: "flow", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } };
}

const cards = computed(() => agents.value.map((agent) => agent.card));
const agent_of = (card) => agents.value.find((agent) => agent.card === card);
const label_of = (card) => { const agent = agent_of(card); return agent ? agent.label || bridge.default_name(agent.name) : card; };
const initial = flow.value?.nodes?.length ? flow.value : empty_flow();
const nodes = ref(initial.nodes.filter((item) => item.type !== "card" || cards.value.includes(item.card)).map(to_node));
const edges = ref(initial.edges.filter((edge) => nodes.value.some((node) => node.id === edge.source) && nodes.value.some((node) => node.id === edge.target)).map(to_edge));
const known = new Set(cards.value);

// What is saved: positions rounded, arrows only between nodes still here.
const stored = computed(() => {
  const ids = new Set(nodes.value.map((node) => node.id));
  return { nodes: nodes.value.map((node) => ({ id: node.id, type: node.type, ...(node.type === "card" ? { card: node.data.card } : {}),
    x: Math.round(node.position.x), y: Math.round(node.position.y) })),
    edges: edges.value.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target })) };
});
watch(stored, (value) => { flow.value = value; }, { immediate: true });
const compiled = computed(() => compile_flow(stored.value, cards.value, Object.fromEntries(cards.value.map((card) => [card, label_of(card)]))));
const shape = computed(() => flow_shape(stored.value));

const off_canvas = computed(() => agents.value.filter((agent) => !nodes.value.some((node) => node.type === "card" && node.data.card === agent.card)));
// Which step each card plays, and the gate after each step, for the badges on the canvas.
const step_of = computed(() => new Map(compiled.value.steps.flatMap((step, index) => step.map((card) => [card, { index, together: step.length > 1 }]))));
const gate_after = computed(() => new Map(compiled.value.gates.map((gate) => [gate.after, gate])));
const order_text = computed(() => compiled.value.steps.map((step, index) => {
  const gate = gate_after.value.get(index);
  const mark = !gate ? "" : gate.repeat_from === null ? " ⏸ 主持人把关" : ` ⟲ 可从 ${label_of(compiled.value.steps[gate.repeat_from][0])} 再来一圈`;
  return `${step.map(label_of).join(" + ")}${mark}`;
}));

/** The badge on a card: its step, and whether it works alongside others in that step. */
function step_badge(card) {
  const step = step_of.value.get(card);
  return step ? `第 ${step.index + 1} 棒${step.together ? " · 同时" : ""}` : "未接入";
}

/** Nodes with no arrow leading on (loops aside): where a new node is appended. */
function tails() {
  const loops = shape.value.loops;
  return nodes.value.filter((node) => !edges.value.some((edge) => edge.source === node.id && !loops.has(edge.id)));
}

/** Put a node right of the single open end and join it there; with several open ends, place it unjoined. */
function append_node(node) {
  const ends = tails();
  const tail = ends.length === 1 ? ends[0] : null;
  const right = Math.max(...nodes.value.map((item) => item.position.x + NODE_WIDTH[item.type]));
  node.position = tail ? { x: tail.position.x + NODE_WIDTH[tail.type] + COLUMN_GAP, y: tail.position.y + (NODE_HEIGHT[tail.type] - NODE_HEIGHT[node.type]) / 2 }
    : { x: right + COLUMN_GAP, y: 0 };
  nodes.value = [...nodes.value, node];
  // Vue Flow drops an arrow whose node it has not registered yet, so the arrow follows on the next tick.
  if (tail) nextTick(() => { edges.value = [...edges.value, to_edge({ source: tail.id, target: node.id })]; });
}

/** A node ID not yet taken. */
function next_id(prefix) {
  for (let number = 1; ; number++) if (!nodes.value.some((node) => node.id === `${prefix}${number}`)) return `${prefix}${number}`;
}

/** Bring a card onto the canvas. */
function place_card(card) {
  append_node(to_node({ id: next_id("card_"), type: "card", card }));
}

/** Add a host checkpoint after the open end. */
function add_checkpoint() {
  append_node(to_node({ id: next_id("host_"), type: "host" }));
}

// A card added to the workflow goes onto the canvas at the open end; a card removed from it leaves the canvas.
watch(cards, (list) => {
  nodes.value = nodes.value.filter((node) => node.type !== "card" || list.includes(node.data.card));
  for (const card of list) if (!known.has(card)) { known.add(card); place_card(card); }
});

/** Take a node off the canvas; a card stays in the workflow and returns to the tray. */
function take_off(id) {
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id);
}

/** Remove a card from the workflow altogether, as its own 移出 button does in the list view. */
function remove_card(card) {
  agents.value = agents.value.filter((agent) => agent.card !== card);
}

/** Replace a card the expert card rewrote as a whole (its Cancel restores the earlier copy). */
function set_agent(card, value) {
  agents.value = agents.value.map((agent) => agent.card === card ? value : agent);
}

/** An imported card asked for more than reading; the user grants it card by card. */
function grant(agent, allowed) {
  agent.project_access = allowed ? agent.requested_access : "read";
}

/** Arrows go from a node's right side to another's left, and the start takes none. Vue Flow also checks arrows it is
 * given this way, so a repeated pair is refused only when a new one is drawn. */
function valid_connection(connection) {
  return connection.source !== connection.target && connection.target !== "start";
}

/** Keep a newly drawn arrow, once per pair and direction. */
function connect(connection) {
  if (valid_connection(connection) && !edges.value.some((edge) => edge.source === connection.source && edge.target === connection.target)) {
    edges.value = [...edges.value, to_edge(connection)];
  }
}

function remove_edge(id) {
  edges.value = edges.value.filter((edge) => edge.id !== id);
}

/** A loop runs out right, down below every node it spans, back left and up into its target, with rounded corners. */
function loop_path({ sourceX, sourceY, targetX, targetY }) {
  const left = targetX - LOOP_OUT, right = sourceX + LOOP_OUT, radius = LOOP_RADIUS;
  const spanned = nodes.value.filter((node) => node.position.x < right && node.position.x + NODE_WIDTH[node.type] > left);
  const below = Math.max(sourceY, targetY, ...spanned.map((node) => node.position.y + NODE_HEIGHT[node.type])) + LOOP_CLEARANCE;
  const path = `M ${sourceX} ${sourceY} H ${right - radius} Q ${right} ${sourceY} ${right} ${sourceY + radius} V ${below - radius}`
    + ` Q ${right} ${below} ${right - radius} ${below} H ${left + radius} Q ${left} ${below} ${left} ${below - radius}`
    + ` V ${targetY + radius} Q ${left} ${targetY} ${left + radius} ${targetY} H ${targetX}`;
  return [path, (left + right) / 2, below];
}

/** A loop goes around underneath the cards it repeats; other arrows are curves. */
function edge_path(edge) {
  if (!shape.value.loops.has(edge.id)) return getBezierPath(edge);
  return edge.sourceX > edge.targetX + 2 * LOOP_OUT ? loop_path(edge) : getSmoothStepPath({ ...edge, borderRadius: LOOP_RADIUS, offset: LOOP_OUT });
}

/** Lay the canvas out in columns by step, members of one step stacked, then fit it in view. */
function arrange(instance) {
  const layers = shape.value.layers;
  const columns = [];
  for (const node of nodes.value) {
    const column = layers.has(node.id) ? layers.get(node.id) : Math.max(0, ...layers.values()) + 1;
    (columns[column] ||= []).push(node);
  }
  let x = 0;
  const placed = new Map();
  for (const column of columns.filter(Boolean)) {
    column.sort((left, right) => left.position.y - right.position.y);
    const height = column.reduce((sum, node) => sum + NODE_HEIGHT[node.type], 0) + ROW_GAP * (column.length - 1);
    let y = -height / 2;
    for (const node of column) {
      placed.set(node.id, { x, y });
      y += NODE_HEIGHT[node.type] + ROW_GAP;
    }
    x += Math.max(...column.map((node) => NODE_WIDTH[node.type])) + COLUMN_GAP;
  }
  nodes.value = nodes.value.map((node) => ({ ...node, position: placed.get(node.id) || node.position }));
  if (instance?.fitView) setTimeout(() => instance.fitView({ padding: 0.15, maxZoom: 1, duration: 250 }), 0);
}

const instance = ref(null);
function ready(flow_instance) {
  instance.value = flow_instance;
  flow_instance.fitView({ padding: 0.15, maxZoom: 1 });
}
</script>

<template>
  <div class="workflow-canvas">
    <div class="workflow-canvas-bar">
      <div class="workflow-canvas-tray" role="group" aria-label="未放上画布的卡片">
        <span v-if="off_canvas.length" class="workflow-canvas-tray-label">未上画布</span>
        <button v-for="agent in off_canvas" :key="agent.card" type="button" class="workflow-canvas-chip" :data-identity="bridge.identities[agent.name]?.style"
          :title="`把 ${label_of(agent.card)} 放到画布上`" @click="place_card(agent.card)">
          <UAvatar :src="bridge.identities[agent.name]?.icon" :text="bridge.identities[agent.name]?.initials" :alt="agent.name" size="3xs" />
          {{ label_of(agent.card) }}<UIcon name="i-lucide-plus" class="workflow-icon" />
        </button>
      </div>
      <UButton icon="i-lucide-shield-check" label="主持人检查点" size="xs" color="neutral" variant="soft" title="在接力末端加一个主持人检查点：前一棒结束后交回主持人把关" @click="add_checkpoint" />
      <UButton icon="i-lucide-layout-grid" label="自动整理" size="xs" color="neutral" variant="soft" @click="arrange(instance)" />
    </div>
    <div class="workflow-canvas-board">
      <VueFlow v-model:nodes="nodes" v-model:edges="edges" :min-zoom="0.25" :max-zoom="1.5" :delete-key-code="['Delete', 'Backspace']"
        :is-valid-connection="valid_connection" :default-viewport="{ zoom: 0.8 }" elevate-nodes-on-select
        :zoom-on-scroll="false" :prevent-scrolling="false" zoom-on-pinch @connect="connect" @pane-ready="ready">
        <template #node-start>
          <div class="workflow-node workflow-node-pill is-start" title="主持人在这里派活：把任务书交给第一棒">
            <UIcon name="i-lucide-play" class="workflow-icon" /><span>开始 · 主持人派活</span>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </template>
        <template #node-host="node">
          <div class="workflow-node workflow-node-pill is-host" :class="{ 'is-selected': node.selected }"
            title="前一棒结束后交回主持人：主持人让接力继续，或直接回答结束；从这里连回前面的卡片即为循环">
            <Handle type="target" :position="Position.Left" class="workflow-handle" />
            <UIcon name="i-lucide-shield-check" class="workflow-icon" /><span>主持人检查点</span>
            <button type="button" class="workflow-node-tool nodrag" title="删除检查点" aria-label="删除检查点" @click="take_off(node.id)"><UIcon name="i-lucide-x" class="workflow-icon" /></button>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </template>
        <template #node-card="node">
          <div class="workflow-node workflow-node-card" :class="{ 'is-selected': node.selected, 'is-off': !step_of.has(node.data.card) }">
            <Handle type="target" :position="Position.Left" class="workflow-handle" />
            <div class="workflow-node-grip" title="按住拖动">
              <UIcon name="i-lucide-grip-vertical" class="workflow-icon" /><span class="workflow-node-step">{{ step_badge(node.data.card) }}</span>
              <button type="button" class="workflow-node-tool nodrag" :title="`把 ${label_of(node.data.card)} 移出画布（卡片保留）`" :aria-label="`把 ${label_of(node.data.card)} 移出画布`" @click="take_off(node.id)"><UIcon name="i-lucide-undo-2" class="workflow-icon" /></button>
            </div>
            <div v-if="agent_of(node.data.card)" class="workflow-node-body nodrag nopan nowheel">
              <ExpertCard :preset="agent_of(node.data.card)" :name="agent_of(node.data.card).name" mode="cli" :status="STATUS"
                :access_locked="Boolean(agent_of(node.data.card).requested_access && agent_of(node.data.card).project_access === 'read')"
                @update:preset="(value) => set_agent(node.data.card, value)" @remove="remove_card(node.data.card)" />
              <label v-if="agent_of(node.data.card).requested_access" class="workflow-node-grant">
                <input type="checkbox" :checked="agent_of(node.data.card).project_access !== 'read'" @change="grant(agent_of(node.data.card), $event.target.checked)" />
                允许卡片要求的「{{ access_label(agent_of(node.data.card).requested_access) }}」</label>
            </div>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </template>
        <template #edge-flow="edge">
          <BaseEdge :id="edge.id" :path="edge_path(edge)[0]" :marker-end="edge.markerEnd" class="workflow-edge"
            :class="{ 'is-loop': shape.loops.has(edge.id), 'is-selected': edge.selected }" />
          <EdgeLabelRenderer>
            <button v-if="edge.selected" type="button" class="workflow-edge-delete nodrag nopan" aria-label="删除这条连线" title="删除连线"
              :style="{ transform: `translate(-50%, -50%) translate(${edge_path(edge)[1]}px, ${edge_path(edge)[2]}px)` }" @click="remove_edge(edge.id)">
              <UIcon name="i-lucide-x" class="workflow-icon" /></button>
          </EdgeLabelRenderer>
        </template>
        <Background :gap="20" :size="1.2" color="var(--ui-border-accented)" />
        <Controls :show-interactive="false" position="bottom-left" class="workflow-canvas-controls" />
        <MiniMap pannable zoomable position="bottom-right" class="workflow-canvas-minimap" :node-border-radius="6" />
        <Panel v-if="compiled.empty" position="top-center" class="workflow-canvas-hint">
          从「开始」右侧的圆点拖出连线连到卡片，排出谁先谁后；同一列并排的卡片同时做，连回前面的卡片即循环。画布留空时，主持人按做法说明组织。
        </Panel>
      </VueFlow>
    </div>
    <div class="workflow-canvas-status" :class="{ 'is-error': compiled.errors.length }" aria-live="polite">
      <template v-if="compiled.errors.length"><UIcon name="i-lucide-triangle-alert" class="workflow-icon" /><span>{{ compiled.errors.join("；") }}</span></template>
      <template v-else-if="!compiled.empty"><UIcon name="i-lucide-route" class="workflow-icon" />
        <ol><li v-for="(text, index) in order_text" :key="index">{{ text }}</li></ol></template>
      <template v-else><UIcon name="i-lucide-info" class="workflow-icon" /><span>还没有接力顺序。选中连线或节点后按 Delete 删除；卡片拖标题栏移动。</span></template>
    </div>
  </div>
</template>

<style scoped>
.workflow-canvas { display: grid; gap: 8px; }
.workflow-canvas-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.workflow-canvas-tray { display: flex; flex: 1; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.workflow-canvas-tray-label { color: var(--ui-text-dimmed); font-size: 11px; }
.workflow-canvas-chip { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px 0 4px; border: 1px dashed var(--ui-border-accented); border-radius: 999px; color: var(--ui-text-toned); font-size: 12px; }
.workflow-canvas-chip:hover { border-style: solid; border-color: var(--channel-accent, var(--ui-primary)); color: var(--ui-text-highlighted); }
.workflow-icon { flex-shrink: 0; width: 13px; height: 13px; }
.workflow-canvas-chip .workflow-icon { width: 12px; height: 12px; color: var(--ui-text-dimmed); }
.workflow-canvas-board { position: relative; height: min(62vh, 600px); min-height: 380px; overflow: hidden; border: 1px solid var(--ui-border-muted); border-radius: 10px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 35%, var(--ui-bg)); }
.workflow-canvas-status { display: flex; align-items: flex-start; gap: 6px; min-height: 22px; color: var(--ui-text-muted); font-size: 12px; line-height: 20px; }
.workflow-canvas-status > .workflow-icon { width: 14px; height: 14px; margin-top: 3px; }
.workflow-canvas-status.is-error { color: var(--ui-error, #e5484d); }
.workflow-canvas-status ol { display: flex; flex-wrap: wrap; gap: 4px 0; margin: 0; padding: 0; list-style: none; counter-reset: step; }
.workflow-canvas-status li { counter-increment: step; }
.workflow-canvas-status li::before { content: counter(step); display: inline-grid; place-items: center; width: 16px; height: 16px; margin-right: 4px; border-radius: 50%;
  background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 18%, transparent); color: var(--channel-accent, var(--ui-primary)); font-size: 10px; }
.workflow-canvas-status li:not(:last-child)::after { content: "→"; margin: 0 8px; color: var(--ui-text-dimmed); }

.workflow-node { position: relative; color: var(--ui-text); }
.workflow-node-pill { display: flex; width: max-content; align-items: center; gap: 6px; height: 44px; padding: 0 14px; border: 1px solid var(--ui-border-accented); border-radius: 999px;
  background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control, 0 1px 2px rgb(0 0 0 / .08)); font-size: 12px; white-space: nowrap; }
.workflow-node-pill > .workflow-icon { width: 14px; height: 14px; }
.workflow-node-pill.is-start { color: var(--channel-accent, var(--ui-primary)); border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 45%, var(--ui-border)); }
.workflow-node-pill.is-host { color: #c99a2e; border-color: color-mix(in srgb, #e0b44a 50%, var(--ui-border)); }
.workflow-node-pill.is-selected, .workflow-node-card.is-selected .workflow-node-grip { box-shadow: 0 0 0 2px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 45%, transparent); }
.workflow-node-card { width: 272px; }
.workflow-node-grip { display: flex; align-items: center; gap: 4px; height: 28px; margin-bottom: 6px; padding: 0 4px 0 6px; border: 1px solid var(--ui-border-muted); border-radius: 7px;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 11px; cursor: grab; }
.workflow-node-grip:active { cursor: grabbing; }
.workflow-node-grip > .workflow-icon { color: var(--ui-text-dimmed); }
.workflow-node-step { flex: 1; color: var(--channel-accent, var(--ui-primary)); font-weight: 500; }
.workflow-node-card.is-off .workflow-node-step { color: var(--ui-text-dimmed); font-weight: 400; }
.workflow-node-body { cursor: default; }
.workflow-node-tool { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; color: var(--ui-text-dimmed); }
.workflow-node-tool > .workflow-icon { width: 12px; height: 12px; }
.workflow-node-tool:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-node-grant { display: flex; gap: 6px; align-items: flex-start; margin-top: 6px; color: var(--ui-warning, #e0a33a); font-size: 12px; }
/* Handles: round ports on both sides, larger than Vue Flow's default so they are easy to grab. */
:deep(.workflow-handle) { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); }
.workflow-node-card :deep(.workflow-handle) { top: 154px; }
:deep(.workflow-handle:hover) { background: var(--channel-accent, var(--ui-primary)); }
:deep(.workflow-edge) { stroke: var(--ui-text-dimmed); stroke-width: 1.6; }
:deep(.workflow-edge.is-loop) { stroke: #c99a2e; stroke-dasharray: 6 5; }
:deep(.workflow-edge.is-selected) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 2.2; }
.workflow-edge-delete { position: absolute; display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--ui-border-accented); border-radius: 50%;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); pointer-events: all; }
.workflow-edge-delete:hover { color: var(--ui-error, #e5484d); border-color: currentColor; }
.workflow-edge-delete > .workflow-icon { width: 11px; height: 11px; }
.workflow-canvas-hint { max-width: 420px; padding: 8px 12px; border: 1px solid var(--ui-border-muted); border-radius: 8px; background: var(--ui-bg-elevated);
  color: var(--ui-text-muted); font-size: 12px; line-height: 1.6; text-align: center; }
:deep(.vue-flow__connection-path) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 1.6; }
:deep(.vue-flow__edge-path) { fill: none; }
:deep(.vue-flow__arrowhead polyline) { stroke: var(--ui-text-dimmed); fill: var(--ui-text-dimmed); }
:deep(.workflow-canvas-controls) { border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; box-shadow: none; }
:deep(.workflow-canvas-controls .vue-flow__controls-button) { border-bottom-color: var(--ui-border-muted); background: var(--ui-bg-elevated); fill: var(--ui-text-muted); color: var(--ui-text-muted); }
:deep(.workflow-canvas-controls .vue-flow__controls-button:hover) { background: var(--ui-bg-accented); }
:deep(.workflow-canvas-minimap) { border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; background: var(--ui-bg-elevated); }
:deep(.workflow-canvas-minimap .vue-flow__minimap-node) { fill: var(--ui-bg-accented); stroke: none; }
:deep(.workflow-canvas-minimap .vue-flow__minimap-mask) { fill: color-mix(in srgb, var(--ui-bg) 60%, transparent); }
:deep(.vue-flow__node) { cursor: default; }
</style>

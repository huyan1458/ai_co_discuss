<script setup>
/**
 * A workflow as an infinite canvas: compact member nodes and host checkpoints joined by arrows. Arrows from 开始 set who
 * speaks after whom; nodes side by side in one column work at once; an arrow back to an earlier node makes a loop. The
 * canvas compiles live into the host's relay (runner/workflow_flow.mjs). Selecting a member opens the inspector with the
 * same expert card used everywhere else; dropping an arrow on empty canvas offers what to add there. Every card of the
 * workflow is on the canvas. The `actions` slot sits top right.
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
import RosterAdd from "./RosterAdd.vue";
import { access_label } from "../runner/expert_prompts.mjs";
import { compile_flow, empty_flow, flow_shape } from "../runner/workflow_flow.mjs";

const flow = defineModel("flow", { type: Object, default: null });
const agents = defineModel("agents", { type: Array, required: true });
const { view, bridge } = inject("discussion");
// Sizes the layout leaves for each kind of node, and the gaps between columns and rows.
const NODE_WIDTH = { card: 216, start: 84, host: 104 };
const NODE_HEIGHT = { card: 76, start: 40, host: 40 };
const COLUMN_GAP = 64, ROW_GAP = 20;
// A loop's path: how far it leaves its ends sideways, how far below the nodes it passes, and its corner radius.
const LOOP_OUT = 24, LOOP_CLEARANCE = 32, LOOP_RADIUS = 14;
const STATUS = { text: "", tone: "" };
const PRESET_PREFIX = "preset:";
// A card ID becomes the member name's suffix; 16 characters at most, so a numbered one keeps room for its digits.
const CARD_BASE = /^[a-z0-9_]{1,14}$/;
const PRESET_FIELDS = ["label", "description", "project_access", "model", "effort", "system_prompt"];

/** A stored node as Vue Flow draws it. */
function to_node(item) {
  const base = { id: item.id, type: item.type, position: { x: item.x || 0, y: item.y || 0 } };
  if (item.type === "card") return { ...base, data: { card: item.card } };
  return item.type === "start" ? { ...base, deletable: false } : base;
}

/** A stored arrow as Vue Flow draws it. */
function to_edge({ source, target }) {
  return { id: `${source}>${target}`, source, target, type: "flow", markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } };
}

const cards = computed(() => agents.value.map((agent) => agent.card));
const agent_of = (card) => agents.value.find((agent) => agent.card === card);
const label_of = (card) => { const agent = agent_of(card); return agent ? agent.label || bridge.default_name(agent.name) : card; };

/** The saved canvas, with any card it lacks (a workflow saved before canvases) laid out unjoined to the right. */
function initial_nodes() {
  const saved = flow.value?.nodes?.length ? flow.value : empty_flow();
  const list = saved.nodes.filter((item) => item.type !== "card" || cards.value.includes(item.card)).map(to_node);
  const missing = cards.value.filter((card) => !list.some((node) => node.type === "card" && node.data.card === card));
  const left = Math.max(...list.map((node) => node.position.x + NODE_WIDTH[node.type])) + COLUMN_GAP;
  missing.forEach((card, index) => list.push(to_node({ id: `card_${card}`, type: "card", card,
    x: left, y: (index - (missing.length - 1) / 2) * (NODE_HEIGHT.card + ROW_GAP) - NODE_HEIGHT.card / 2 + NODE_HEIGHT.start / 2 })));
  return { list, edges: saved.edges };
}
const initial = initial_nodes();
const nodes = ref(initial.list);
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
// Which step each card plays, and the gate after each step, for the badges on the canvas.
const step_of = computed(() => new Map(compiled.value.steps.flatMap((step, index) => step.map((card) => [card, { index, together: step.length > 1 }]))));
const gate_after = computed(() => new Map(compiled.value.gates.map((gate) => [gate.after, gate])));
// Cards that loop back somewhere: the gate after their step repeats.
const gate_of = (card) => gate_after.value.get(step_of.value.get(card)?.index);

/** The two chips on a member node: its model, and its project access (writing stands out). */
function node_facts(agent) {
  return { model: agent.model || "默认模型", access: access_label(agent.project_access || "read"), writes: (agent.project_access || "read") !== "read" };
}

/** Nodes with no arrow leading on (loops aside): where a new node is appended. */
function tails() {
  const loops = shape.value.loops;
  return nodes.value.filter((node) => !edges.value.some((edge) => edge.source === node.id && !loops.has(edge.id)));
}

/** Place a node and, when it has a source, join it on the next tick (Vue Flow drops arrows to nodes it has not seen). */
function place(node, position, source) {
  node.position = position;
  nodes.value = [...nodes.value, node];
  if (source) nextTick(() => { edges.value = [...edges.value, to_edge({ source, target: node.id })]; });
}

/** Where a node goes after a source: beside it, centred on its row. */
function beside(source, type) {
  return { x: source.position.x + NODE_WIDTH[source.type] + COLUMN_GAP, y: source.position.y + (NODE_HEIGHT[source.type] - NODE_HEIGHT[type]) / 2 };
}

/** Put a node at a dropped arrow's end, at the single open end, or (several open ends) unjoined on the right. */
function add_node(node) {
  if (drop.value) {
    const { source, flow_point } = drop.value;
    drop.value = null;
    place(node, { x: flow_point.x, y: flow_point.y - NODE_HEIGHT[node.type] / 2 }, source);
    return;
  }
  const ends = tails();
  const tail = ends.length === 1 ? ends[0] : null;
  const right = Math.max(...nodes.value.map((item) => item.position.x + NODE_WIDTH[item.type]));
  place(node, tail ? beside(tail, node.type) : { x: right + COLUMN_GAP, y: 0 }, tail?.id);
}

/** A node ID not yet taken. */
function next_id(prefix) {
  for (let number = 1; ; number++) if (!nodes.value.some((node) => node.id === `${prefix}${number}`)) return `${prefix}${number}`;
}

function add_checkpoint() {
  adding.value = false;
  add_node(to_node({ id: next_id("host_"), type: "host" }));
}

// A card added to the workflow goes onto the canvas; a card removed from it leaves the canvas.
watch(cards, (list) => {
  nodes.value = nodes.value.filter((node) => node.type !== "card" || list.includes(node.data.card));
  for (const card of list) if (!known.has(card)) { known.add(card); add_node(to_node({ id: next_id("card_"), type: "card", card })); }
  if (inspected.value && !list.includes(inspected.value)) inspected.value = "";
});

// ── Adding: from the toolbar, or by dropping an arrow on empty canvas (the menu opens where it was dropped). ──
const adding = ref(false);
const drop = ref(null);
const add_anchor = ref(null);
const platforms = Object.keys(bridge.identities).filter((name) => name !== "用户");
const roster_items = computed(() => [...platforms.map((name) => ({ value: name, name: bridge.display_name(name), ...bridge.identities[name],
  title: `添加一张 ${bridge.display_name(name)} 卡片`, aria_label: `添加 ${name} 卡片` })),
  ...bridge.expert_presets().map((preset, index) => ({ value: PRESET_PREFIX + preset.name, name: preset.label || preset.name,
    ...bridge.identities[bridge.platform_of(preset.name)], separated: index === 0, title: preset.description || "专家预设", aria_label: `按预设 ${preset.label || preset.name} 添加卡片` }))]);

/** The first free card ID from a base: writer, writer2 … or role1, role2 … */
function next_card(base) {
  const taken = new Set(agents.value.map((agent) => agent.card.toLowerCase()));
  const root = CARD_BASE.test(base) ? base : "role";
  for (let number = 1; ; number++) {
    const card = number === 1 && root !== "role" ? root : `${root}${number}`;
    if (!taken.has(card)) return card;
  }
}

/** Add a blank card on a platform, or one filled from an expert preset; the new card opens in the inspector. */
function add_card(value) {
  adding.value = false;
  let agent;
  if (!value.startsWith(PRESET_PREFIX)) {
    const card = next_card("role");
    agent = { card, name: `${value}-${card}`, project_access: "read" };
  } else {
    const preset = bridge.expert_presets().find((item) => item.name === value.slice(PRESET_PREFIX.length));
    if (!preset) return;
    const platform = bridge.platform_of(preset.name);
    const card = next_card(preset.name.slice(platform.length + 1).toLowerCase());
    const fields = Object.fromEntries(PRESET_FIELDS.filter((key) => preset[key]).map((key) => [key, preset[key]]));
    agent = { project_access: "read", ...fields, card, name: `${platform}-${card}` };
  }
  agents.value = [...agents.value, agent];
  inspected.value = agent.card;
}

/** Add the open room's members as cards, prompts verbatim; the user then edits or removes them. */
async function cards_from_room() {
  adding.value = false;
  drop.value = null;
  let result;
  try { result = await bridge.local_request("workflows", { action: "room-cards", room_id: view.value.room.id }); }
  catch (error) { bridge.notify("error", error.message); return; }
  for (const item of result.cards) {
    const card = next_card(item.card.toLowerCase().slice(0, 14));
    agents.value = [...agents.value, { ...item, card, name: `${bridge.platform_of(item.name)}-${card}` }];
  }
  bridge.notify("info", `已带入 ${result.cards.length} 张卡片；请确认提示词里没有本机路径或密钥`);
}

/** Open the add menu at the toolbar button. */
function open_add(event) {
  drop.value = null;
  add_anchor.value = event.currentTarget;
  adding.value = true;
}
watch(adding, (open) => { if (!open) setTimeout(() => { if (!adding.value) drop.value = null; }, 0); });

// An arrow started from a node's right side that ends on no node offers to add one there.
let connecting = null, connected = false;
function connect_start({ nodeId, handleType }) {
  connecting = handleType === "source" ? nodeId : null;
  connected = false;
}

function connect_end(event) {
  const source = connecting;
  connecting = null;
  const point = event?.changedTouches?.[0] || event;
  if (!source || connected || !point || !instance.value || event.target?.closest?.(".vue-flow__node")) return;
  const rect = { x: point.clientX, y: point.clientY, width: 0, height: 0, top: point.clientY, left: point.clientX, right: point.clientX, bottom: point.clientY };
  // Screen to canvas coordinates: undo the pane's offset on the page, then the viewport's pan and zoom.
  const pane = canvas_element.value.getBoundingClientRect(), viewport = instance.value.getViewport();
  drop.value = { source, flow_point: { x: (point.clientX - pane.left - viewport.x) / viewport.zoom, y: (point.clientY - pane.top - viewport.y) / viewport.zoom } };
  add_anchor.value = { getBoundingClientRect: () => rect };
  adding.value = true;
}

/** Arrows go from a node's right side to another's left, and the start takes none. Vue Flow also checks arrows it is
 * given this way, so a repeated pair is refused only when a new one is drawn. */
function valid_connection(connection) {
  return connection.source !== connection.target && connection.target !== "start";
}

/** Keep a newly drawn arrow, once per pair and direction. */
function connect(connection) {
  connected = true;
  if (valid_connection(connection) && !edges.value.some((edge) => edge.source === connection.source && edge.target === connection.target)) {
    edges.value = [...edges.value, to_edge(connection)];
  }
}

function remove_node(id) {
  nodes.value = nodes.value.filter((node) => node.id !== id);
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id);
}

function remove_edge(id) {
  edges.value = edges.value.filter((edge) => edge.id !== id);
}

// ── The inspector: the selected member's expert card, to flip and set as anywhere else. ──
const inspected = ref("");
const inspected_agent = computed(() => inspected.value ? agent_of(inspected.value) : null);

function node_click({ node }) {
  inspected.value = node.type === "card" ? node.data.card : "";
}

/** Remove a card from the workflow altogether. */
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

const instance = ref(null), canvas_element = ref(null);
/** Lay the canvas out in columns by step, members of one step stacked, then fit it in view. */
function arrange() {
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
  // Fit once Vue Flow has moved the nodes, a frame after the positions change.
  nextTick(() => requestAnimationFrame(() => instance.value?.fitView({ padding: 0.06, maxZoom: 1.1, minZoom: 0.65, duration: 250 })));
}

function ready(flow_instance) {
  instance.value = flow_instance;
  requestAnimationFrame(fit_once);
}

/** Fit the whole workflow in view: when the pane is ready and again once Vue Flow has measured its nodes (either may come first). */
let fitted = false;
function fit_once() {
  // Vue Flow reports every node added later too; only the first measurement fits.
  if (fitted || !instance.value || !nodes.value.length) return;
  fitted = true;
  instance.value.fitView({ padding: 0.06, maxZoom: 1.1, minZoom: 0.65 });
}
</script>

<template>
  <div ref="canvas_element" class="workflow-canvas">
    <VueFlow v-model:nodes="nodes" v-model:edges="edges" :min-zoom="0.2" :max-zoom="1.8" :delete-key-code="['Delete', 'Backspace']"
      :is-valid-connection="valid_connection" elevate-nodes-on-select @connect="connect" @connect-start="connect_start" @connect-end="connect_end"
      @node-click="node_click" @pane-click="inspected = ''" @pane-ready="ready" @nodes-initialized="fit_once">
      <template #node-start>
        <UTooltip text="主持人从这里派活：拖动右侧圆点连到第一棒，拖到空白处可直接添加">
          <div class="workflow-pill is-start">
            <UIcon name="i-lucide-play" class="workflow-icon" /><span>开始</span>
            <Handle type="source" :position="Position.Right" class="workflow-handle" :class="{ 'is-calling': compiled.empty }" />
          </div>
        </UTooltip>
      </template>
      <template #node-host="node">
        <UTooltip text="检查点：前一棒结束后交回主持人把关；从这里连回前面的成员即循环">
          <div class="workflow-pill is-host" :class="{ 'is-selected': node.selected }">
            <Handle type="target" :position="Position.Left" class="workflow-handle" />
            <UIcon name="i-lucide-shield-check" class="workflow-icon" /><span>检查点</span>
            <button type="button" class="workflow-pill-close nodrag" aria-label="删除检查点" @click.stop="remove_node(node.id)"><UIcon name="i-lucide-x" class="workflow-icon" /></button>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </UTooltip>
      </template>
      <template #node-card="node">
        <div v-if="agent_of(node.data.card)" class="workflow-member" :data-identity="bridge.identities[agent_of(node.data.card).name]?.style"
          :class="{ 'is-selected': node.selected || inspected === node.data.card, 'is-off': !step_of.has(node.data.card) }">
          <Handle type="target" :position="Position.Left" class="workflow-handle" />
          <span v-if="step_of.has(node.data.card)" class="workflow-member-step" :title="step_of.get(node.data.card).together ? '与同一列的成员同时做' : '第几棒'">
            {{ step_of.get(node.data.card).index + 1 }}</span>
          <UTooltip v-else text="还没接入接力：从前一棒拖线连过来"><span class="workflow-member-step is-loose"><UIcon name="i-lucide-unlink" class="workflow-icon" /></span></UTooltip>
          <UAvatar :src="bridge.identities[agent_of(node.data.card).name]?.icon" :text="bridge.identities[agent_of(node.data.card).name]?.initials" :alt="agent_of(node.data.card).name" size="md" class="workflow-member-avatar" />
          <span class="workflow-member-text">
            <strong>{{ label_of(node.data.card) }}</strong>
            <small :title="agent_of(node.data.card).description">{{ agent_of(node.data.card).description || bridge.display_name(bridge.platform_of(agent_of(node.data.card).name)) }}</small>
            <span class="workflow-member-chips">
              <em>{{ node_facts(agent_of(node.data.card)).model }}</em>
              <em :class="{ 'is-warn': node_facts(agent_of(node.data.card)).writes }">{{ node_facts(agent_of(node.data.card)).access }}</em>
            </span>
          </span>
          <UIcon v-if="gate_of(node.data.card)" :name="gate_of(node.data.card).repeat_from === null ? 'i-lucide-shield-check' : 'i-lucide-repeat'"
            class="workflow-icon workflow-member-gate" :title="gate_of(node.data.card).repeat_from === null ? '之后交回主持人把关' : '之后可回去再来一圈'" />
          <Handle type="source" :position="Position.Right" class="workflow-handle" />
        </div>
      </template>
      <template #edge-flow="edge">
        <BaseEdge :id="edge.id" :path="edge_path(edge)[0]" :marker-end="edge.markerEnd" class="workflow-edge"
          :class="{ 'is-loop': shape.loops.has(edge.id), 'is-selected': edge.selected }" />
        <EdgeLabelRenderer>
          <button v-if="edge.selected" type="button" class="workflow-edge-delete nodrag nopan" aria-label="删除这条连线"
            :style="{ transform: `translate(-50%, -50%) translate(${edge_path(edge)[1]}px, ${edge_path(edge)[2]}px)` }" @click="remove_edge(edge.id)">
            <UIcon name="i-lucide-x" class="workflow-icon" /></button>
        </EdgeLabelRenderer>
      </template>
      <Background :gap="22" :size="1.2" color="var(--ui-border-accented)" />
      <Controls :show-interactive="false" position="bottom-left" class="workflow-canvas-controls" />
      <MiniMap pannable zoomable position="bottom-right" class="workflow-canvas-minimap" :width="168" :height="104" :node-border-radius="8" />
      <Panel position="top-left" class="workflow-canvas-toolbar">
        <UTooltip text="添加成员（也可从圆点拖线到空白处）"><UButton icon="i-lucide-user-plus" label="成员" size="sm" color="neutral" variant="ghost" @click="open_add" /></UTooltip>
        <UTooltip text="检查点：前一棒结束后交回主持人把关"><UButton icon="i-lucide-shield-check" label="检查点" size="sm" color="neutral" variant="ghost" @click="add_checkpoint" /></UTooltip>
        <span class="workflow-canvas-divider" />
        <UTooltip text="自动整理"><UButton icon="i-lucide-wand-sparkles" size="sm" color="neutral" variant="ghost" aria-label="自动整理" @click="arrange" /></UTooltip>
      </Panel>
      <Panel position="top-right" class="workflow-canvas-toolbar is-plain"><slot name="actions" /></Panel>
      <Panel position="bottom-center" class="workflow-canvas-status" :class="{ 'is-error': compiled.errors.length, 'is-empty': compiled.empty }" aria-live="polite">
        <template v-if="compiled.errors.length"><UIcon name="i-lucide-triangle-alert" class="workflow-icon" /><span>{{ compiled.errors[0] }}</span></template>
        <template v-else-if="compiled.empty"><UIcon name="i-lucide-mouse-pointer-2" class="workflow-icon" /><span>从「开始」的圆点拖出连线</span></template>
        <template v-else>
          <span v-for="(step, index) in compiled.steps" :key="index" class="workflow-canvas-step">
            <b>{{ index + 1 }}</b>{{ step.map(label_of).join(" + ") }}
            <UIcon v-if="gate_after.get(index)" :name="gate_after.get(index).repeat_from === null ? 'i-lucide-shield-check' : 'i-lucide-repeat'" class="workflow-icon is-gate" />
          </span>
        </template>
      </Panel>
    </VueFlow>
    <Transition name="workflow-inspector">
      <aside v-if="inspected_agent" class="workflow-inspector" aria-label="成员设置">
        <ExpertCard :key="inspected" :preset="inspected_agent" :name="inspected_agent.name" mode="cli" :status="STATUS"
          :access_locked="Boolean(inspected_agent.requested_access && inspected_agent.project_access === 'read')"
          @update:preset="(value) => set_agent(inspected, value)" @remove="remove_card(inspected)" />
        <label v-if="inspected_agent.requested_access" class="workflow-inspector-grant">
          <input type="checkbox" :checked="inspected_agent.project_access !== 'read'" @change="grant(inspected_agent, $event.target.checked)" />
          允许「{{ access_label(inspected_agent.requested_access) }}」</label>
        <button type="button" class="workflow-inspector-close" aria-label="收起成员设置" @click="inspected = ''"><UIcon name="i-lucide-chevrons-right" class="workflow-icon" /></button>
      </aside>
    </Transition>
    <UPopover :open="adding" :reference="add_anchor" :content="{ side: 'bottom', align: 'start', sideOffset: 8, collisionPadding: 12 }"
      :ui="{ content: 'workflow-canvas-add' }" @update:open="(value) => { adding = value; }">
      <template #content>
        <div class="workflow-canvas-add-body">
          <RosterAdd label="添加成员卡片" :items="roster_items" @add="add_card" />
          <div class="workflow-canvas-add-more">
            <UButton v-if="drop" icon="i-lucide-shield-check" label="检查点" size="xs" color="neutral" variant="soft" @click="add_checkpoint" />
            <UButton v-if="view.room?.id && !drop" icon="i-lucide-users" label="当前房间的成员" size="xs" color="neutral" variant="soft" @click="cards_from_room" />
          </div>
        </div>
      </template>
    </UPopover>
  </div>
</template>

<style scoped>
.workflow-canvas { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: color-mix(in srgb, var(--ui-bg-elevated) 30%, var(--ui-bg)); }
.workflow-icon { flex-shrink: 0; width: 14px; height: 14px; }
.workflow-canvas-toolbar { display: flex; align-items: center; gap: 2px; padding: 3px; border: 1px solid var(--ui-border-muted); border-radius: 10px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent); box-shadow: 0 6px 20px rgb(0 0 0 / .14); backdrop-filter: blur(8px); }
.workflow-canvas-divider { width: 1px; height: 18px; margin: 0 3px; background: var(--ui-border-muted); }
.workflow-canvas-status { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; max-width: min(760px, 64%); padding: 7px 14px; border: 1px solid var(--ui-border-muted);
  border-radius: 999px; background: color-mix(in srgb, var(--ui-bg-elevated) 92%, transparent); color: var(--ui-text-toned); font-size: 12px;
  box-shadow: 0 6px 20px rgb(0 0 0 / .14); backdrop-filter: blur(8px); }
.workflow-canvas-status.is-error { border-color: color-mix(in srgb, var(--ui-error, #e5484d) 50%, transparent); color: var(--ui-error, #e5484d); }
.workflow-canvas-status.is-empty { color: var(--ui-text-muted); }
.workflow-canvas-step { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.workflow-canvas-step:not(:last-child)::after { content: "→"; margin-left: 5px; color: var(--ui-text-dimmed); }
.workflow-canvas-step > b { display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 10px; font-weight: 600;
  background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 18%, transparent); color: var(--channel-accent, var(--ui-primary)); }
.workflow-canvas-step .is-gate { width: 13px; height: 13px; color: #c99a2e; }

/* Start and checkpoint: small pills. */
.workflow-pill { position: relative; display: flex; width: max-content; align-items: center; gap: 6px; height: 40px; padding: 0 16px; border: 1px solid var(--ui-border-accented);
  border-radius: 999px; background: var(--ui-bg-elevated); box-shadow: 0 2px 8px rgb(0 0 0 / .12); font-size: 13px; font-weight: 500; white-space: nowrap; }
.workflow-pill.is-start { color: var(--channel-accent, var(--ui-primary)); border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 50%, var(--ui-border)); }
.workflow-pill.is-host { padding-right: 10px; color: #c99a2e; border-color: color-mix(in srgb, #e0b44a 55%, var(--ui-border)); }
.workflow-pill.is-selected { box-shadow: 0 0 0 2px color-mix(in srgb, #e0b44a 45%, transparent); }
.workflow-pill-close { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; color: var(--ui-text-dimmed); opacity: 0; transition: opacity .15s; }
.workflow-pill:hover .workflow-pill-close, .workflow-pill.is-selected .workflow-pill-close { opacity: 1; }
.workflow-pill-close:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-pill-close > .workflow-icon { width: 11px; height: 11px; }

/* Members: compact nodes, the way the expert card's front reads at a glance. */
.workflow-member { position: relative; display: flex; align-items: center; gap: 10px; width: 216px; height: 76px; padding: 0 12px 0 14px;
  border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 12px; background: var(--ui-bg-elevated); box-shadow: 0 2px 10px rgb(0 0 0 / .14);
  cursor: grab; transition: border-color .15s, box-shadow .15s; }
.workflow-member:hover { border-color: var(--ui-border-accented); }
.workflow-member.is-selected { border-color: var(--channel-accent, var(--ui-primary)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 25%, transparent); }
.workflow-member.is-off { border-style: dashed; background: color-mix(in srgb, var(--ui-bg-elevated) 55%, transparent); }
.workflow-member.is-off .workflow-member-text, .workflow-member.is-off .workflow-member-avatar { opacity: .65; }
.workflow-member-step { position: absolute; top: -9px; left: -9px; display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
  background: var(--channel-accent, var(--ui-primary)); color: #fff; font-size: 11px; font-weight: 700; box-shadow: 0 0 0 3px var(--ui-bg); }
.workflow-member-step.is-loose { background: var(--ui-bg-accented); color: var(--ui-warning, #e0a33a); }
.workflow-member-step.is-loose > .workflow-icon { width: 11px; height: 11px; }
.workflow-member-avatar { flex-shrink: 0; }
.workflow-member-text { display: grid; gap: 2px; min-width: 0; }
.workflow-member-text strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.workflow-member-text small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; white-space: nowrap; text-overflow: ellipsis; }
.workflow-member-chips { display: flex; gap: 4px; min-width: 0; margin-top: 2px; }
.workflow-member-chips em { overflow: hidden; max-width: 110px; padding: 0 6px; border-radius: 4px; background: var(--ui-bg-accented); color: var(--ui-text-toned);
  font-size: 10px; font-style: normal; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.workflow-member-chips em.is-warn { background: color-mix(in srgb, #e0a33a 18%, transparent); color: #d89a2c; }
.workflow-member-gate { position: absolute; top: 8px; right: 10px; width: 13px; height: 13px; color: #c99a2e; }

/* Ports: round, larger than Vue Flow's default; the start's pulses while nothing is connected. */
:deep(.workflow-handle) { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); transition: background .15s; }
:deep(.workflow-handle:hover) { background: var(--channel-accent, var(--ui-primary)); }
:deep(.workflow-handle.is-calling) { animation: workflow-call 1.6s ease-out infinite; }
@keyframes workflow-call { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--channel-accent, #6c7bff) 55%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
@media (prefers-reduced-motion: reduce) { :deep(.workflow-handle.is-calling) { animation: none; } }
:deep(.workflow-edge) { stroke: var(--ui-text-dimmed); stroke-width: 1.6; }
:deep(.workflow-edge.is-loop) { stroke: #c99a2e; stroke-dasharray: 6 5; }
:deep(.workflow-edge.is-selected) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 2.2; }
.workflow-edge-delete { position: absolute; display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--ui-border-accented); border-radius: 50%;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); pointer-events: all; }
.workflow-edge-delete:hover { color: var(--ui-error, #e5484d); border-color: currentColor; }
.workflow-edge-delete > .workflow-icon { width: 11px; height: 11px; }
:deep(.vue-flow__connection-path) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 1.8; stroke-dasharray: 5 4; }
:deep(.vue-flow__edge-path) { fill: none; }
:deep(.vue-flow__node) { cursor: grab; }
:deep(.workflow-canvas-controls) { border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; box-shadow: none; }
:deep(.workflow-canvas-controls .vue-flow__controls-button) { border-bottom-color: var(--ui-border-muted); background: var(--ui-bg-elevated); fill: var(--ui-text-muted); color: var(--ui-text-muted); }
:deep(.workflow-canvas-controls .vue-flow__controls-button:hover) { background: var(--ui-bg-accented); }
:deep(.workflow-canvas-minimap) { border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; background: var(--ui-bg-elevated); }
:deep(.workflow-canvas-minimap .vue-flow__minimap-node) { fill: var(--ui-bg-accented); stroke: none; }
:deep(.workflow-canvas-minimap .vue-flow__minimap-mask) { fill: color-mix(in srgb, var(--ui-bg) 60%, transparent); }

/* Inspector: the selected member's expert card, floating at the right edge below the actions. */
.workflow-inspector { position: absolute; top: 64px; right: 12px; z-index: 6; display: grid; gap: 8px; width: 300px; padding: 14px 14px 12px; border: 1px solid var(--ui-border-muted);
  border-radius: 14px; background: color-mix(in srgb, var(--ui-bg-elevated) 96%, transparent); box-shadow: 0 12px 40px rgb(0 0 0 / .28); backdrop-filter: blur(10px); }
.workflow-inspector-grant { display: flex; gap: 6px; align-items: center; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-inspector-close { position: absolute; top: -10px; left: -10px; display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid var(--ui-border-muted);
  border-radius: 50%; background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.workflow-inspector-close:hover { color: var(--ui-text-highlighted); }
.workflow-inspector-enter-active, .workflow-inspector-leave-active { transition: opacity .16s ease, transform .16s ease; }
.workflow-inspector-enter-from, .workflow-inspector-leave-to { opacity: 0; transform: translateX(12px); }
</style>

<style>
/* The add menu renders outside the canvas. */
.workflow-canvas-add { padding: 10px 12px; max-width: min(560px, 92vw); }
.workflow-canvas-add-body { display: grid; gap: 10px; justify-items: start; }
.workflow-canvas-add-more { display: flex; gap: 6px; }
.workflow-canvas-add-more:empty { display: none; }
</style>

<script setup>
/**
 * A workflow as an infinite canvas: the members' expert cards and host nodes joined by arrows. The canvas only helps the
 * user see how the members work together: the arrows run nothing, and the host dispatches by SKILL.md alone. What the
 * canvas edits for real is the cards (add, set, remove); SKILL.md is in the drawer. Each card is the same expert card
 * used everywhere else, dragged by its title bar; dropping an arrow on empty canvas offers what to add there. Every card
 * of the workflow is on the canvas. Edits can be undone and redone; a double click on empty canvas fits it in view. The
 * `actions` slot sits top right.
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
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
import { MAX_EDGE_LABEL, MAX_HOST_LABEL, empty_flow, flow_shape } from "../runner/workflow_flow.mjs";

const flow = defineModel("flow", { type: Object, default: null });
// Clicking SKILL.md in the "派活以 SKILL.md 为准" hint opens it.
const emit = defineEmits(["open-skill"]);
const agents = defineModel("agents", { type: Array, required: true });
// On a phone the canvas is small: tools show icons only, and the minimap and the SKILL.md hint step aside.
const props = defineProps({ compact: Boolean });
const { view, bridge } = inject("discussion");
// Sizes the layout leaves for each kind of node, and the gaps between columns and rows.
const NODE_WIDTH = { card: 272, start: 84, host: 104 };
const NODE_HEIGHT = { card: 268, start: 40, host: 40 };
const COLUMN_GAP = 120, ROW_GAP = 28;
// How far below a node's top its round connection points sit: a card's are level with its body, below the drag bar, a
// pill's in its middle. Layout lines these up, not the nodes' middles, so arrows between a pill and a card run straight.
const HANDLE_Y = { card: 146, start: 20, host: 20 };
// Before Vue Flow has measured a pill, its width is estimated from its text: the bare pill, then per character of its note.
const PILL_TEXT = { base: 92, note: 18, char: 13 };
// An arrow's note sits on its middle: the gap it crosses leaves this much on each side of the note (ports, arrowhead).
const NOTE_CHAR = 11, NOTE_PAD = 16, NOTE_MARGIN = 36;
// A column an arrow skips over is lifted this far clear of the line the arrow runs along (room for its note too).
const BYPASS_CLEARANCE = 44;
const CARD_HANDLE = ".workflow-card-grip";
// The whole-workflow view (double click, the fit button): as far out as it takes, on a phone further still.
const FIT = { padding: 0.08, maxZoom: 1, minZoom: 0.25 };
const COMPACT_FIT = { ...FIT, minZoom: 0.15 };
// The view a workflow opens at: the whole of it when that is still readable, else readable from the start onwards.
const READABLE_ZOOM = 0.8, OPEN_PADDING = 24;
// Undo keeps this many steps; edits within this many milliseconds of each other (typing, say) are one step.
const HISTORY_LIMIT = 100, HISTORY_DELAY = 400;
// A loop's path: how far it leaves its ends sideways, how far below the nodes it passes, and its corner radius.
const LOOP_OUT = 24, LOOP_CLEARANCE = 32, LOOP_RADIUS = 14;
// Each wider loop runs this much lower than the one inside it, so loops never share a line.
const LOOP_STACK = 22;
const STATUS = { text: "", tone: "" };
const PRESET_PREFIX = "preset:";
// A card ID becomes the member name's suffix; 16 characters at most, so a numbered one keeps room for its digits.
const CARD_BASE = /^[a-z0-9_]{1,14}$/;
const PRESET_FIELDS = ["label", "description", "project_access", "model", "effort", "system_prompt"];

/** A stored node as Vue Flow draws it; a card is dragged by its title bar so its own buttons keep working. */
function to_node(item) {
  const base = { id: item.id, type: item.type, position: { x: item.x || 0, y: item.y || 0 } };
  if (item.type === "card") return { ...base, data: { card: item.card }, dragHandle: CARD_HANDLE };
  if (item.type === "host") return { ...base, data: { label: item.label || "" } };
  return { ...base, deletable: false };
}

/** A stored arrow as Vue Flow draws it; its note (if any) rides in `data`. */
function to_edge({ source, target, label }) {
  return { id: `${source}>${target}`, source, target, type: "flow", data: { label: label || "" }, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } };
}

/** Set the note on a host node or an arrow (trimmed when stored); `kind` is "nodes" or "edges". */
function set_note(kind, id, label) {
  const list = kind === "nodes" ? nodes : edges;
  list.value = list.value.map((item) => item.id === id ? { ...item, data: { ...item.data, label } } : item);
}

// Vue Flow's instance (set once its pane is ready; layout reads measured sizes from it) and the canvas element.
const instance = ref(null), canvas_element = ref(null);
const cards = computed(() => agents.value.map((agent) => agent.card));
const agent_of = (card) => agents.value.find((agent) => agent.card === card);
const label_of = (card) => { const agent = agent_of(card); return agent ? agent.label || bridge.default_name(agent.name) : card; };

/**
 * The saved canvas, with any card it lacks (a workflow saved before canvases) laid out unjoined to the right. A canvas
 * written without positions (every node at the origin, as an AI drafts it) is laid out in columns straight away.
 */
function initial_nodes() {
  const saved = flow.value?.nodes?.length ? flow.value : empty_flow();
  const list = saved.nodes.filter((item) => item.type !== "card" || cards.value.includes(item.card)).map(to_node);
  const missing = cards.value.filter((card) => !list.some((node) => node.type === "card" && node.data.card === card));
  if (list.length > 1 && list.every((node) => !node.position.x && !node.position.y)) {
    const all = [...list, ...missing.map((card) => to_node({ id: `card_${card}`, type: "card", card }))];
    const placed = layout(all, flow_shape(saved), saved.edges);
    return { list: all.map((node) => ({ ...node, position: placed.get(node.id) })), edges: saved.edges };
  }
  const left = Math.max(...list.map((node) => node.position.x + NODE_WIDTH[node.type])) + COLUMN_GAP;
  missing.forEach((card, index) => list.push(to_node({ id: `card_${card}`, type: "card", card,
    x: left, y: (index - (missing.length - 1) / 2) * (NODE_HEIGHT.card + ROW_GAP) - HANDLE_Y.card })));
  return { list, edges: saved.edges };
}
const initial = initial_nodes();
const nodes = ref(initial.list);
const edges = ref(initial.edges.filter((edge) => nodes.value.some((node) => node.id === edge.source) && nodes.value.some((node) => node.id === edge.target)).map(to_edge));
const known = new Set(cards.value);

// What is saved: positions rounded, arrows only between nodes still here.
const live = computed(() => {
  const ids = new Set(nodes.value.map((node) => node.id));
  const noted = (item) => item.data?.label?.trim() ? { label: item.data.label.trim() } : {};
  return { nodes: nodes.value.map((node) => ({ id: node.id, type: node.type, ...(node.type === "card" ? { card: node.data.card } : {}),
    ...(node.type === "host" ? noted(node) : {}), x: Math.round(node.position.x), y: Math.round(node.position.y) })),
    edges: edges.value.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target, ...noted(edge) })) };
});
// The saved form (and through it the undo history, the loop layout and the page's unsaved check) follows the canvas,
// but not on every frame of a drag: that is taken once the card is let go, so dragging stays smooth.
const stored = shallowRef(live.value);
watch(live, (value) => { if (!dragging) stored.value = value; });
watch(stored, (value) => { flow.value = value; }, { immediate: true });
const shape = computed(() => flow_shape(stored.value));
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

function add_host() {
  adding.value = false;
  add_node(to_node({ id: next_id("host_"), type: "host" }));
}

// A card added to the workflow goes onto the canvas; a card removed from it leaves the canvas.
watch(cards, (list) => {
  nodes.value = nodes.value.filter((node) => node.type !== "card" || list.includes(node.data.card));
  for (const card of list) if (!known.has(card)) { known.add(card); add_node(to_node({ id: next_id("card_"), type: "card", card })); }
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

/** Add a blank card on a platform, or one filled from an expert preset. */
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
function loop_path({ id, sourceX, sourceY, targetX, targetY }) {
  const left = targetX - LOOP_OUT, right = sourceX + LOOP_OUT, radius = LOOP_RADIUS;
  const spanned = nodes.value.filter((node) => node.position.x < right && node.position.x + NODE_WIDTH[node.type] > left);
  const below = Math.max(sourceY, targetY, ...spanned.map((node) => node.position.y + NODE_HEIGHT[node.type])) + LOOP_CLEARANCE
    + (loop_rank.value.get(id) || 0) * LOOP_STACK;
  const path = `M ${sourceX} ${sourceY} H ${right - radius} Q ${right} ${sourceY} ${right} ${sourceY + radius} V ${below - radius}`
    + ` Q ${right} ${below} ${right - radius} ${below} H ${left + radius} Q ${left} ${below} ${left} ${below - radius}`
    + ` V ${targetY + radius} Q ${left} ${targetY} ${left + radius} ${targetY} H ${targetX}`;
  return [path, (left + right) / 2, below];
}

// Loops from narrowest to widest: a wider loop runs below the narrower ones.
const loop_rank = computed(() => {
  const at = new Map(nodes.value.map((node) => [node.id, node.position.x]));
  const loops = edges.value.filter((edge) => shape.value.loops.has(edge.id));
  loops.sort((left, right) => (at.get(left.source) - at.get(left.target)) - (at.get(right.source) - at.get(right.target)) || left.id.localeCompare(right.id));
  return new Map(loops.map((edge, index) => [edge.id, index]));
});

/** A loop goes around underneath the cards it repeats; other arrows are curves. */
function edge_path(edge) {
  if (!shape.value.loops.has(edge.id)) return getBezierPath(edge);
  return edge.sourceX > edge.targetX + 2 * LOOP_OUT ? loop_path(edge) : getSmoothStepPath({ ...edge, borderRadius: LOOP_RADIUS, offset: LOOP_OUT });
}

/** Lay the canvas out in columns by step, members of one step stacked, then fit it in view. */
function arrange() {
  const placed = layout(nodes.value, shape.value, edges.value);
  nodes.value = nodes.value.map((node) => ({ ...node, position: placed.get(node.id) || node.position }));
  // Fit once Vue Flow has moved the nodes, a frame after the positions change.
  nextTick(() => requestAnimationFrame(() => instance.value?.fitView({ ...fit_options(), duration: 250 })));
}

/** A node's width: as Vue Flow measured it, else the layout size (a host pill's estimated from its note). */
function node_width(node) {
  const measured = instance.value?.findNode(node.id)?.dimensions?.width;
  if (measured) return measured;
  const label = node.data?.label || "";
  return node.type === "host" ? PILL_TEXT.base + (label ? PILL_TEXT.note + label.length * PILL_TEXT.char : 0) : NODE_WIDTH[node.type];
}

/** The gap after a column: wide enough for the longest note on a forward arrow leaving it (loops run below). */
function column_gap(column, arrows, loops) {
  const ids = new Set(column.map((node) => node.id));
  const notes = arrows.filter((edge) => ids.has(edge.source) && !loops.has(`${edge.source}>${edge.target}`))
    .map((edge) => (edge.label ?? edge.data?.label ?? "").trim().length).filter(Boolean);
  return Math.max(COLUMN_GAP, ...notes.map((length) => length * NOTE_CHAR + NOTE_PAD + 2 * NOTE_MARGIN));
}

/**
 * Positions for nodes in columns by their layer (nodes the start does not reach go last): each column as wide as its
 * widest node, nodes centred in it, the column centred on its connection points, and gaps wide enough for arrow notes.
 */
function layout(list, { layers, loops }, arrows) {
  const columns = [];
  const index_of = (id) => layers.has(id) ? layers.get(id) : Math.max(0, ...layers.values()) + 1;
  for (const node of list) (columns[index_of(node.id)] ||= []).push(node);
  // Columns a forward arrow skips (a branch that leaves a step out) move up, so that arrow runs straight below them.
  const skipped = new Set();
  for (const edge of arrows) {
    if (loops.has(`${edge.source}>${edge.target}`) || !list.some((node) => node.id === edge.source) || !list.some((node) => node.id === edge.target)) continue;
    for (let column = index_of(edge.source) + 1; column < index_of(edge.target); column++) skipped.add(column);
  }
  let x = 0;
  const placed = new Map();
  for (const [index, column] of columns.entries()) {
    if (!column) continue;
    column.sort((left, right) => left.position.y - right.position.y);
    const height = column.reduce((sum, node) => sum + NODE_HEIGHT[node.type], 0) + ROW_GAP * (column.length - 1);
    let y = -height / 2;
    const tops = column.map((node) => { const top = y; y += NODE_HEIGHT[node.type] + ROW_GAP; return top; });
    // Shift the column so its connection points centre on the line the other columns' do.
    const shift = column.reduce((sum, node, row) => sum + tops[row] + HANDLE_Y[node.type], 0) / column.length;
    const lift = skipped.has(index) ? Math.max(...column.map((node, row) => tops[row] - shift + NODE_HEIGHT[node.type])) + BYPASS_CLEARANCE : 0;
    const width = Math.max(...column.map(node_width));
    column.forEach((node, row) => placed.set(node.id, { x: x + (width - node_width(node)) / 2, y: tops[row] - shift - lift }));
    x += width + column_gap(column, arrows, loops);
  }
  return placed;
}

function ready(flow_instance) {
  instance.value = flow_instance;
  requestAnimationFrame(fit_once);
}

/** Put a card already in the workflow on the canvas once more (a role that acts at two points of the flow). */
function place_again(card) {
  adding.value = false;
  add_node(to_node({ id: next_id("card_"), type: "card", card }));
}

/** Open the workflow in view: when the pane is ready and again once Vue Flow has measured its nodes (either may come first). */
let fitted = false;
function fit_once() {
  // Vue Flow reports every node added later too; only the first measurement places the view.
  if (fitted || !instance.value || !nodes.value.length) return;
  fitted = true;
  open_view();
}

/** The whole workflow when it fits at a readable size; otherwise readable size, its start at the left, its height centred. */
function open_view() {
  const pane = canvas_element.value?.getBoundingClientRect();
  if (!pane?.width || !pane.height) return;
  const left = Math.min(...nodes.value.map((node) => node.position.x)), right = Math.max(...nodes.value.map((node) => node.position.x + NODE_WIDTH[node.type]));
  const top = Math.min(...nodes.value.map((node) => node.position.y)), bottom = Math.max(...nodes.value.map((node) => node.position.y + NODE_HEIGHT[node.type]));
  const whole = Math.min(pane.width / ((right - left) * (1 + 2 * FIT.padding)), pane.height / ((bottom - top) * (1 + 2 * FIT.padding)));
  if (whole >= READABLE_ZOOM) { instance.value.fitView(FIT); return; }
  instance.value.setViewport({ x: OPEN_PADDING - left * READABLE_ZOOM, y: pane.height / 2 - (top + bottom) / 2 * READABLE_ZOOM, zoom: READABLE_ZOOM });
}

/** How far fitting may zoom out. */
function fit_options() {
  return props.compact ? COMPACT_FIT : FIT;
}

/** Place the opening view now (a phone or a tablet held upright shows the canvas only after switching to it). */
function fit() {
  if (instance.value) open_view();
}
defineExpose({ fit });

/** A double click on empty canvas (not a card, an arrow or a floating tool) resets the view to the whole workflow. */
function pane_double_click(event) {
  if (event.target.closest(".vue-flow__node, .vue-flow__edge, .vue-flow__panel, .vue-flow__edge-labels, .workflow-edge-note")) return;
  reset_view();
}

function reset_view() {
  instance.value?.fitView({ ...fit_options(), duration: 250 });
}

/** A middle-button double press anywhere on the canvas resets the view too (browsers fire no dblclick for it). */
const MIDDLE_BUTTON = 1, DOUBLE_PRESS_MS = 400;
let middle_pressed_at = 0;
function middle_press(event) {
  if (event.button !== MIDDLE_BUTTON) return;
  // The pan this press starts stops any view animation, so the reset runs once the press has been handled.
  if (event.timeStamp - middle_pressed_at < DOUBLE_PRESS_MS) { middle_pressed_at = 0; setTimeout(reset_view, 0); return; }
  middle_pressed_at = event.timeStamp;
}

// ── Two-finger pinch: it always zooms the view, wherever the fingers land, cards included (Vue Flow leaves a touch
// that starts on a card to the card's drag, so a pinch half on a card panned and dragged at once). The browser never
// zooms the page from the canvas: pinches and Ctrl+wheel (a touchpad pinch) stop here. ──
const ZOOM = { min: 0.2, max: 1.8 };
// The canvas is one layer the GPU only shifts and scales while the view pans or zooms, instead of being repainted every
// frame. A layer keeps the scale it was drawn at, so after a zoom it is dropped for two frames to draw the text sharp.
const layered = ref(true);
let zoom_at_start = 1;

function view_moved() {
  zoom_at_start = instance.value?.getViewport().zoom ?? 1;
}

function view_settled() {
  if (!instance.value || instance.value.getViewport().zoom === zoom_at_start) return;
  layered.value = false;
  requestAnimationFrame(() => requestAnimationFrame(() => { layered.value = true; }));
}
let pinch = null, pinch_frame = 0, pinch_target = null, touch_positions = null;

/** The touches currently down on the canvas. */
function canvas_touches(event) {
  return [...event.touches].filter((touch) => canvas_element.value?.contains(touch.target));
}

/** Midpoint and spread of two touches. */
function touch_pair([first, second]) {
  return { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2, spread: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY) || 1 };
}

/** Remember the cards' places as a touch begins; a second finger turns it into a pinch, and the cards go back. */
function touch_start(event) {
  const touches = canvas_touches(event);
  if (!pinch && touches.length === 1) touch_positions = new Map(nodes.value.map((node) => [node.id, { ...node.position }]));
  if (touches.length < 2 || !instance.value) return;
  event.stopPropagation();
  event.preventDefault();
  if (!pinch) {
    for (const node of nodes.value) {
      const before = touch_positions?.get(node.id);
      if (before && (before.x !== node.position.x || before.y !== node.position.y)) instance.value.updateNode(node.id, { position: before });
    }
  }
  if (!pinch) view_moved();
  begin_pinch(touches);
}

/** Take the fingers' current midpoint and spread as the pinch's start; the canvas point under the midpoint stays under it. */
function begin_pinch(touches) {
  const pane = canvas_element.value.getBoundingClientRect(), viewport = instance.value.getViewport(), pair = touch_pair(touches);
  pinch = { pair, zoom: viewport.zoom, point: { x: (pair.x - pane.left - viewport.x) / viewport.zoom, y: (pair.y - pane.top - viewport.y) / viewport.zoom } };
}

/** Follow the fingers, one viewport change per frame. */
function touch_move(event) {
  const touches = canvas_touches(event);
  if (touches.length >= 2) event.preventDefault();
  if (!pinch) return;
  event.stopPropagation();
  if (touches.length < 2) return;
  pinch_target = touch_pair(touches);
  if (!pinch_frame) pinch_frame = requestAnimationFrame(apply_pinch);
}

function apply_pinch() {
  pinch_frame = 0;
  if (!pinch || !pinch_target || !instance.value) return;
  const pane = canvas_element.value.getBoundingClientRect();
  const zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, pinch.zoom * pinch_target.spread / pinch.pair.spread));
  instance.value.setViewport({ x: pinch_target.x - pane.left - pinch.point.x * zoom, y: pinch_target.y - pane.top - pinch.point.y * zoom, zoom });
}

/** A lifted finger lets the card drags and the pane end; the pinch lasts until every finger is up. */
function touch_end(event) {
  if (!pinch) return;
  const touches = canvas_touches(event);
  // Two fingers still down (a third was lifted): carry on from where they are, without a jump.
  if (touches.length >= 2) begin_pinch(touches);
  else if (!touches.length) { pinch = null; pinch_target = null; view_settled(); }
}

/** Ctrl+wheel is a touchpad pinch: Vue Flow zooms the view with it, the page must not zoom. */
function wheel(event) {
  if (event.ctrlKey) event.preventDefault();
}

/** Safari's own pinch gesture events. */
function gesture(event) {
  event.preventDefault();
}

const TOUCH_LISTENERS = [["touchstart", touch_start], ["touchmove", touch_move], ["touchend", touch_end], ["touchcancel", touch_end], ["wheel", wheel],
  ["gesturestart", gesture], ["gesturechange", gesture]];
onMounted(() => { for (const [type, listener] of TOUCH_LISTENERS) canvas_element.value.addEventListener(type, listener, { capture: true, passive: false }); });
onBeforeUnmount(() => {
  for (const [type, listener] of TOUCH_LISTENERS) canvas_element.value?.removeEventListener(type, listener, { capture: true });
  cancelAnimationFrame(pinch_frame);
});

// ── Undo and redo: snapshots of the canvas and its cards; a drag counts once it ends. ──
const state = computed(() => JSON.stringify({ flow: stored.value, agents: agents.value }));
const past = ref([]), future = ref([]);
let current = state.value, restoring = false, dragging = false, timer = 0;

/** Take the pending edit as one step, unless nothing changed. */
function commit() {
  clearTimeout(timer);
  if (restoring || state.value === current) return;
  past.value = [...past.value, current].slice(-HISTORY_LIMIT);
  future.value = [];
  current = state.value;
}
watch(state, () => { if (restoring || dragging) return; clearTimeout(timer); timer = setTimeout(commit, HISTORY_DELAY); });

/** Put back a snapshot; arrows follow on the next tick, once Vue Flow has its nodes. */
function restore(text) {
  const saved = JSON.parse(text);
  restoring = true;
  saved.agents.forEach((agent) => known.add(agent.card));
  agents.value = saved.agents;
  nodes.value = saved.flow.nodes.map(to_node);
  edges.value = [];
  nextTick(() => { edges.value = saved.flow.edges.map(to_edge); nextTick(() => { restoring = false; }); });
}

function undo() {
  commit();
  if (!past.value.length) return;
  future.value = [current, ...future.value];
  current = past.value.at(-1);
  past.value = past.value.slice(0, -1);
  restore(current);
}

function redo() {
  commit();
  if (!future.value.length) return;
  past.value = [...past.value, current];
  current = future.value[0];
  future.value = future.value.slice(1);
  restore(current);
}

/** Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes; inside a text box the box keeps its own undo. */
function history_key(event) {
  if (!(event.ctrlKey || event.metaKey) || event.target.closest?.("input, textarea, [contenteditable]")) return;
  const key = event.key.toLowerCase();
  if (key !== "z" && key !== "y") return;
  event.preventDefault();
  if (key === "y" || event.shiftKey) redo(); else undo();
}
window.addEventListener("keydown", history_key);
onBeforeUnmount(() => { window.removeEventListener("keydown", history_key); clearTimeout(timer); });

/** A card being dragged would repaint the whole one-layer canvas every frame, so the layer waits until it is let go. */
function drag_start() { dragging = true; layered.value = false; }
function drag_stop() { dragging = false; layered.value = true; stored.value = live.value; commit(); }
</script>

<template>
  <div ref="canvas_element" class="workflow-canvas" :class="{ 'is-layered': layered }" @dblclick="pane_double_click" @pointerdown.capture="middle_press">
    <VueFlow v-model:nodes="nodes" v-model:edges="edges" :min-zoom="ZOOM.min" :max-zoom="ZOOM.max" :delete-key-code="['Delete', 'Backspace']" :zoom-on-double-click="false"
      :is-valid-connection="valid_connection" elevate-nodes-on-select @connect="connect" @connect-start="connect_start" @connect-end="connect_end"
      @node-drag-start="drag_start" @node-drag-stop="drag_stop" @pane-ready="ready" @nodes-initialized="fit_once" @move-start="view_moved" @move-end="view_settled">
      <template #node-start>
        <UTooltip text="从右侧圆点拖线连到成员，示意谁先接手；拖到空白处可直接添加">
          <div class="workflow-pill is-start">
            <UIcon name="i-lucide-play" class="workflow-icon" /><span>开始</span>
            <Handle type="source" :position="Position.Right" class="workflow-handle" :class="{ 'is-calling': !edges.some((edge) => edge.source === 'start') }" />
          </div>
        </UTooltip>
      </template>
      <template #node-host="node">
        <UTooltip text="主持人：示意这里交回主持人判断；选中后可写上做什么">
          <div class="workflow-pill is-host" :class="{ 'is-selected': node.selected }">
            <Handle type="target" :position="Position.Left" class="workflow-handle" />
            <UIcon name="i-lucide-crown" class="workflow-icon" /><span>主持人</span>
            <input v-if="node.selected" :value="node.data.label" class="workflow-note-input nodrag" :maxlength="MAX_HOST_LABEL" placeholder="做什么"
              aria-label="主持人在这里做什么" :style="{ width: `${Math.max(3, (node.data.label || '').length + 1)}em` }"
              @input="set_note('nodes', node.id, $event.target.value)" @keydown.enter="$event.target.blur()" />
            <b v-else-if="node.data.label" class="workflow-pill-note">{{ node.data.label }}</b>
            <button type="button" class="workflow-pill-close nodrag" aria-label="删除主持人节点" @click.stop="remove_node(node.id)"><UIcon name="i-lucide-x" class="workflow-icon" /></button>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </UTooltip>
      </template>
      <template #node-card="node">
        <div v-if="agent_of(node.data.card)" class="workflow-card" :class="{ 'is-selected': node.selected }">
          <Handle type="target" :position="Position.Left" class="workflow-handle" />
          <div class="workflow-card-grip" title="按住拖动">
            <UIcon name="i-lucide-grip-horizontal" class="workflow-icon" />
          </div>
          <div class="workflow-card-body nodrag nopan">
            <ExpertCard :preset="agent_of(node.data.card)" :name="agent_of(node.data.card).name" mode="cli" :status="STATUS"
              :access_locked="Boolean(agent_of(node.data.card).requested_access && agent_of(node.data.card).project_access === 'read')"
              @update:preset="(value) => set_agent(node.data.card, value)" @remove="remove_card(node.data.card)" />
            <label v-if="agent_of(node.data.card).requested_access" class="workflow-card-grant">
              <input type="checkbox" :checked="agent_of(node.data.card).project_access !== 'read'" @change="grant(agent_of(node.data.card), $event.target.checked)" />
              允许「{{ access_label(agent_of(node.data.card).requested_access) }}」</label>
          </div>
          <Handle type="source" :position="Position.Right" class="workflow-handle" />
        </div>
      </template>
      <template #edge-flow="edge">
        <BaseEdge :id="edge.id" :path="edge_path(edge)[0]" :marker-end="edge.markerEnd" class="workflow-edge"
          :class="{ 'is-loop': shape.loops.has(edge.id), 'is-selected': edge.selected }" />
        <EdgeLabelRenderer>
          <div v-if="edge.selected || edge.data?.label" class="workflow-edge-note nodrag nopan" :class="{ 'is-loop': shape.loops.has(edge.id), 'is-selected': edge.selected }"
            :style="{ transform: `translate(-50%, -50%) translate(${edge_path(edge)[1]}px, ${edge_path(edge)[2]}px)` }">
            <template v-if="edge.selected">
              <input :value="edge.data?.label" class="workflow-note-input" :maxlength="MAX_EDGE_LABEL" placeholder="说明，如“返工”" aria-label="这条连线的说明"
                :style="{ width: `${Math.max(6, (edge.data?.label || '').length + 1)}em` }" @input="set_note('edges', edge.id, $event.target.value)" @keydown.enter="$event.target.blur()" />
              <button type="button" class="workflow-edge-delete" aria-label="删除这条连线" @click="remove_edge(edge.id)"><UIcon name="i-lucide-x" class="workflow-icon" /></button>
            </template>
            <span v-else>{{ edge.data.label }}</span>
          </div>
        </EdgeLabelRenderer>
      </template>
      <Background :gap="22" :size="1.2" color="var(--ui-border-accented)" />
      <Controls :show-interactive="false" position="top-right" class="workflow-canvas-controls" />
      <MiniMap v-if="!props.compact" pannable zoomable position="bottom-right" class="workflow-canvas-minimap" :width="168" :height="104" :node-border-radius="8" />
      <Panel position="top-left" class="workflow-canvas-toolbar">
        <UTooltip text="添加成员（也可从圆点拖线到空白处）"><UButton icon="i-lucide-user-plus" :label="props.compact ? undefined : '成员'" aria-label="添加成员" size="sm" color="neutral" variant="ghost" @click="open_add" /></UTooltip>
        <UTooltip text="主持人节点：示意交回主持人判断的地方"><UButton icon="i-lucide-crown" :label="props.compact ? undefined : '主持人'" aria-label="添加主持人节点" size="sm" color="neutral" variant="ghost" @click="add_host" /></UTooltip>
        <span class="workflow-canvas-divider" />
        <UTooltip text="撤销 (Ctrl+Z)"><UButton icon="i-lucide-undo-2" size="sm" color="neutral" variant="ghost" aria-label="撤销" :disabled="!past.length" @click="undo" /></UTooltip>
        <UTooltip text="重做 (Ctrl+Shift+Z)"><UButton icon="i-lucide-redo-2" size="sm" color="neutral" variant="ghost" aria-label="重做" :disabled="!future.length" @click="redo" /></UTooltip>
        <UTooltip text="自动整理"><UButton icon="i-lucide-wand-sparkles" size="sm" color="neutral" variant="ghost" aria-label="自动整理" @click="arrange" /></UTooltip>
        <template v-if="$slots.actions"><span class="workflow-canvas-divider" /><slot name="actions" /></template>
      </Panel>
      <Panel v-if="!props.compact" position="bottom-left" class="workflow-canvas-status">
        <UIcon name="i-lucide-info" class="workflow-icon" /><span>连线只作示意，派活以</span>
        <button type="button" class="workflow-canvas-skill" @click="emit('open-skill')">SKILL.md</button><span>为准</span>
      </Panel>
    </VueFlow>
    <UPopover :open="adding" :reference="add_anchor" :content="{ side: 'bottom', align: 'start', sideOffset: 8, collisionPadding: 12 }"
      :ui="{ content: 'workflow-canvas-add' }" @update:open="(value) => { adding = value; }">
      <template #content>
        <div class="workflow-canvas-add-body">
          <RosterAdd label="添加成员卡片" :items="roster_items" @add="add_card" />
          <div v-if="agents.length" class="workflow-canvas-add-again">
            <span>已有成员再放一次</span>
            <UButton v-for="agent in agents" :key="agent.card" :label="label_of(agent.card)" icon="i-lucide-copy-plus" size="xs" color="neutral" variant="soft"
              :title="`在画布上再放一个「${label_of(agent.card)}」：同一张卡片，示意它在流程里出场两次`" @click="place_again(agent.card)" />
          </div>
          <div class="workflow-canvas-add-more">
            <UButton v-if="drop" icon="i-lucide-crown" label="主持人" size="xs" color="neutral" variant="soft" @click="add_host" />
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
  background: var(--ui-bg-elevated); box-shadow: 0 6px 20px rgb(0 0 0 / .14); }
.workflow-canvas-divider { width: 1px; height: 18px; margin: 0 3px; background: var(--ui-border-muted); }
.workflow-canvas-status { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border: 1px solid var(--ui-border-muted); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; }
.workflow-canvas.is-layered :deep(.vue-flow__transformationpane) { will-change: transform; }

/* Start and host: small pills. */
.workflow-pill { position: relative; display: flex; width: max-content; align-items: center; gap: 6px; height: 40px; padding: 0 16px; border: 1px solid var(--ui-border-accented);
  border-radius: 999px; background: var(--ui-bg-elevated); box-shadow: 0 2px 8px rgb(0 0 0 / .12); font-size: 13px; font-weight: 500; white-space: nowrap; }
.workflow-pill.is-start { color: var(--channel-accent, var(--ui-primary)); border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 50%, var(--ui-border)); }
.workflow-pill.is-host { padding-right: 10px; color: #c99a2e; border-color: color-mix(in srgb, #e0b44a 55%, var(--ui-border)); }
.workflow-pill.is-selected { box-shadow: 0 0 0 2px color-mix(in srgb, #e0b44a 45%, transparent); }
.workflow-pill-close { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; color: var(--ui-text-dimmed); opacity: 0; transition: opacity .15s; }
.workflow-pill:hover .workflow-pill-close, .workflow-pill.is-selected .workflow-pill-close { opacity: 1; }
.workflow-pill-close:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.workflow-pill-close > .workflow-icon { width: 11px; height: 11px; }

/* Members: the expert card itself under a title bar that drags it and shows its step. */
.workflow-card { position: relative; width: 272px; color: var(--ui-text); }
.workflow-card-grip { display: flex; align-items: center; justify-content: center; gap: 5px; height: 20px; margin-bottom: 6px; padding: 0 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 12px; cursor: grab; }
.workflow-card-grip:active { cursor: grabbing; }
.workflow-card.is-selected .workflow-card-grip { border-color: var(--channel-accent, var(--ui-primary)); box-shadow: 0 0 0 2px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 30%, transparent); }
.workflow-card-body { cursor: default; }
.workflow-canvas-skill { color: var(--channel-accent, var(--ui-primary)); text-decoration: underline; text-underline-offset: 3px; }
.workflow-canvas-skill:hover { color: var(--ui-text-highlighted); }
.workflow-card-grant { display: flex; gap: 6px; align-items: center; margin-top: 6px; color: var(--ui-warning, #e0a33a); font-size: 12px; }
.workflow-card :deep(.workflow-handle) { top: 146px; }

/* Ports: round, larger than Vue Flow's default; the start's pulses while nothing is connected. */
:deep(.workflow-handle) { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); transition: background .15s; }
:deep(.workflow-handle:hover) { background: var(--channel-accent, var(--ui-primary)); }
:deep(.workflow-handle.is-calling) { animation: workflow-call 1.6s ease-out infinite; }
@keyframes workflow-call { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--channel-accent, #6c7bff) 55%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
@media (prefers-reduced-motion: reduce) { :deep(.workflow-handle.is-calling) { animation: none; } }
:deep(.workflow-edge) { stroke: var(--ui-text-dimmed); stroke-width: 1.6; }
:deep(.workflow-edge.is-loop) { stroke: #c99a2e; stroke-dasharray: 6 5; }
:deep(.workflow-edge.is-selected) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 2.2; }
.workflow-edge-note { position: absolute; display: flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--ui-border-muted); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text-toned); font-size: 11px; line-height: 18px; white-space: nowrap; pointer-events: all; }
.workflow-edge-note.is-loop { border-color: color-mix(in srgb, #e0b44a 55%, var(--ui-border)); color: #c99a2e; }
.workflow-edge-note.is-selected { padding: 2px 2px 2px 6px; border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-note-input { min-width: 0; height: 20px; padding: 0 4px; border: 0; border-radius: 4px; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 11px; outline: none; }
.workflow-pill-note { padding-left: 6px; border-left: 1px solid color-mix(in srgb, #e0b44a 40%, transparent); font-weight: 500; }
.workflow-edge-delete { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--ui-border-accented); border-radius: 50%;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.workflow-edge-delete:hover { color: var(--ui-error, #e5484d); border-color: currentColor; }
.workflow-edge-delete > .workflow-icon { width: 11px; height: 11px; }
:deep(.vue-flow__connection-path) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 1.8; stroke-dasharray: 5 4; }
:deep(.vue-flow__edge-path) { fill: none; }
:deep(.vue-flow__node) { cursor: grab; }
:deep(.workflow-canvas-controls) { display: flex; border: 1px solid var(--ui-border-muted); border-radius: 10px; overflow: hidden; box-shadow: 0 6px 20px rgb(0 0 0 / .14); }
:deep(.workflow-canvas-controls .vue-flow__controls-button) { width: 32px; height: 32px; border-bottom: 0; border-right: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); fill: var(--ui-text-muted); color: var(--ui-text-muted); }
:deep(.workflow-canvas-controls .vue-flow__controls-button:last-child) { border-right: 0; }
:deep(.workflow-canvas-controls .vue-flow__controls-button:hover) { background: var(--ui-bg-accented); }
:deep(.workflow-canvas-minimap) { border: 1px solid var(--ui-border-muted); border-radius: 8px; overflow: hidden; background: var(--ui-bg-elevated); }
:deep(.workflow-canvas-minimap .vue-flow__minimap-node) { fill: var(--ui-bg-accented); stroke: none; }
:deep(.workflow-canvas-minimap .vue-flow__minimap-mask) { fill: color-mix(in srgb, var(--ui-bg) 60%, transparent); }

</style>

<style>
/* Light theme: on a white canvas the cards' grey secondary text washes out once zoomed out, so it is one step darker. */
html[data-theme="channel-light"] .workflow-canvas .expert-card-summary,
html[data-theme="channel-light"] .workflow-canvas .expert-card-facts dd { color: var(--ui-text); }
html[data-theme="channel-light"] .workflow-canvas .expert-card-names > small,
html[data-theme="channel-light"] .workflow-canvas .expert-card-facts dt,
html[data-theme="channel-light"] .workflow-canvas .workflow-edge-note { color: var(--ui-text-toned); }
html[data-theme="channel-light"] .workflow-canvas .workflow-pill.is-host,
html[data-theme="channel-light"] .workflow-canvas .workflow-edge-note.is-loop { color: #8a5d00; }

/* The add menu renders outside the canvas. */
.workflow-canvas-add { padding: 10px 12px; max-width: min(560px, 92vw); }
.workflow-canvas-add-body { display: grid; gap: 10px; justify-items: start; }
.workflow-canvas-add-more { display: flex; gap: 6px; }
.workflow-canvas-add-more:empty { display: none; }
.workflow-canvas-add-again { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 520px; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); }
.workflow-canvas-add-again > span { width: 100%; color: var(--ui-text-muted); font-size: 12px; }
</style>

<script setup>
/**
 * A workflow as an infinite canvas: the members' expert cards and host nodes joined by arrows. The canvas only helps the
 * user see how the members work together: the arrows run nothing, and the host dispatches by SKILL.md alone. What the
 * canvas edits for real is the cards (add, set, remove); SKILL.md is in the drawer. Each card is the same expert card
 * used everywhere else, dragged by its title bar; dropping an arrow on empty canvas offers what to add there. Every card
 * of the workflow is on the canvas. Edits can be undone and redone; a double click on empty canvas fits it in view. The
 * `actions` slot sits top right. The main canvas also shows where a sub-workflow is used (a node that enters it); a
 * sub-workflow's canvas may also show main-flow members taking part in it (`shared`, the main flow's cards).
 */
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Panel, Position, VueFlow, getBezierPath, getSmoothStepPath } from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { Controls } from "@vue-flow/controls";
import { MiniMap } from "@vue-flow/minimap";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/controls/dist/style.css";
import "@vue-flow/minimap/dist/style.css";
import RosterAdd from "./RosterAdd.vue";
import { sub_member_count } from "./workflow-library.js";
import { access_label as source_access_label } from "../runner/expert_prompts.mjs";
import { MAX_EDGE_LABEL, MAX_HOST_LABEL, MAX_LOOP_OFFSET, empty_flow, flow_shape } from "../runner/workflow_flow.mjs";
import { t } from './i18n.js';
const access_label = level => ({ read: t('只读'), write: t('可写'), auto: t('自动'), full: t('全放开'), own: t('自行决定') }[level] || source_access_label(level));

const flow = defineModel("flow", { type: Object, default: null });
// Clicking SKILL.md in the "派活以 SKILL.md 为准" hint opens it.
// A sub-workflow node asks to show that sub-workflow (`fresh` when it was just created).
// "configure": a card's settings (software, model, description, prompt) open in the 专家配置 panel at that card.
const emit = defineEmits(["open-skill", "open-sub", "configure"]);
const agents = defineModel("agents", { type: Array, required: true });
// On a sub-workflow's canvas: the main flow's cards, which may be placed here too; null on the main canvas.
const shared = defineModel("shared", { type: Array, default: null });
// On a phone the canvas is small: tools show icons only, and the minimap and the SKILL.md hint step aside.
// `reserved`: card IDs the workflow's other canvases (its main flow or sub-workflows) already use; IDs are unique across them.
// `subs`: the workflow's sub-workflows, on the main canvas only.
const props = defineProps({ compact: Boolean, reserved: { type: Array, default: () => [] }, subs: { type: Array, default: null } });
const { view, bridge } = inject("discussion");
const tool_size = computed(() => (props.compact ? "xs" : "sm"));
// Below this canvas width the labelled toolbar would run under the zoom buttons, so it shows icons only
// (a wide window can still leave a narrow canvas beside the sidebar and the SKILL.md panel).
const LABELLED_TOOLBAR_WIDTH = 680;
const narrow = ref(false);
// Whether the toolbar shows words goes by the canvas's own width only: a portrait tablet stacks the page yet has room for them.
const icons_only = computed(() => narrow.value);
// Layout reads each node's size as Vue Flow measured it (node_size), so restyling a node needs no change here; these are
// only its first guess for a node not drawn yet (a workflow opened without positions, a node just added).
// Member, host and sub-workflow nodes share one flat shape and one delete (user 2026-11-21, #6830); the start stays small.
// A card on the canvas only says who it is (user 2026-11-17); its settings live in the 专家配置 panel.
const NODE_WIDTH = { card: 240, start: 96, host: 240, sub: 240 };
const NODE_HEIGHT = { card: 96, start: 60, host: 96, sub: 96 };
const COLUMN_GAP = 120, ROW_GAP = 28;
// An arrow's note sits on its middle: the gap it crosses leaves this much on each side of the note (ports, arrowhead).
const NOTE_CHAR = 11, NOTE_PAD = 16, NOTE_MARGIN = 36;
// A column an arrow skips over is lifted this far clear of the line the arrow runs along (room for its note too).
const BYPASS_CLEARANCE = 44;
// Every node moves only by its top bar, with a mouse or a finger alike (user 2026-11-20, #6109); a card's body works like
// the card on the new-room page. Dragging a body pans the canvas, with a finger (touch_start) or a mouse (edge_press);
// its buttons and note still take presses, and its text is not selectable anyway (Vue Flow's nodes are user-select: none).
const NODE_HANDLE = ".workflow-card-grip";
const NODE_BODY = ".workflow-card-body, .workflow-node-body";
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
const PRESET_PREFIX = "preset:";
// A card ID becomes the member name's suffix; 16 characters at most, so a numbered one keeps room for its digits.
const CARD_BASE = /^[a-z0-9_]{1,14}$/;
const PRESET_FIELDS = ["label", "description", "project_access", "model", "effort", "system_prompt"];

/** A stored node as Vue Flow draws it; a card is dragged by its top bar so its own buttons and swipes keep working. */
function to_node(item) {
  const base = { id: item.id, type: item.type, position: { x: item.x || 0, y: item.y || 0 } };
  // Not by Vue Flow's Delete: the key presses the node's × instead (delete_key), so it asks twice like the button.
  if (item.type === "card") return { ...base, data: { card: item.card }, dragHandle: NODE_HANDLE, deletable: false };
  if (item.type === "host") return { ...base, data: { label: item.label || "" }, dragHandle: NODE_HANDLE, deletable: false };
  if (item.type === "sub") return { ...base, data: { sub: item.sub }, dragHandle: NODE_HANDLE, deletable: false };
  return { ...base, deletable: false, dragHandle: NODE_HANDLE };
}

/** A stored arrow as Vue Flow draws it; its note and a loop's up-or-down offset (if any) ride in `data`. */
function to_edge({ source, target, label, offset }) {
  return { id: `${source}>${target}`, source, target, type: "flow", data: { label: label || "", offset: offset || 0 }, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } };
}

// Every node's × asks twice (user 2026-11-21): the first press turns it into a red bin for a few seconds.
const removing = ref(""), REMOVE_ARMED_MS = 3000;
let removing_timer = 0;
function press_remove(node) {
  clearTimeout(removing_timer);
  if (removing.value !== node.id) {
    removing.value = node.id;
    removing_timer = setTimeout(() => { removing.value = ""; }, REMOVE_ARMED_MS);
    return;
  }
  removing.value = "";
  if (node.type === "card") remove_card(node.data.card);
  else remove_node(node.id);
}

/** Delete or Backspace on a selected node presses its ×; arrows are still deleted by Vue Flow. */
function delete_key(event) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  if (event.target.closest?.("input, textarea, [contenteditable]")) return;
  // `instance` sits in a ref, which unwraps the store's computed getters; read either form.
  const selected = instance.value?.getSelectedNodes;
  const node = (Array.isArray(selected) ? selected : selected?.value || []).find((item) => item.type !== "start");
  if (node) press_remove(node);
}

/** Set the note on a host node or an arrow (trimmed when stored); `kind` is "nodes" or "edges". */
function set_note(kind, id, label) {
  const list = kind === "nodes" ? nodes : edges;
  list.value = list.value.map((item) => item.id === id ? { ...item, data: { ...item.data, label } } : item);
}

// Vue Flow's instance (set once its pane is ready; layout reads measured sizes from it) and the canvas element.
const instance = ref(null), canvas_element = ref(null);
const cards = computed(() => agents.value.map((agent) => agent.card));
const shared_cards = computed(() => (shared.value || []).map((agent) => agent.card));
const sub_ids = computed(() => (props.subs || []).map((sub) => sub.id));
const own = (card) => cards.value.includes(card);
const agent_of = (card) => agents.value.find((agent) => agent.card === card) || shared.value?.find((agent) => agent.card === card);
const sub_of = (id) => props.subs?.find((sub) => sub.id === id);
/** Whether a node's card or sub-workflow still exists (other nodes always do). */
const present = (type, card, sub) => type === "card" ? own(card) || shared_cards.value.includes(card) : type !== "sub" || sub_ids.value.includes(sub);
const label_of = (card) => { const agent = agent_of(card); return agent ? agent.label || bridge.default_name(agent.name) : card; };

/**
 * The saved canvas, with any card it lacks (a workflow saved before canvases) laid out unjoined to the right. A canvas
 * written without positions (every node at the origin, as an AI drafts it) is laid out in columns straight away.
 */
function initial_nodes() {
  const saved = flow.value?.nodes?.length ? flow.value : empty_flow();
  const list = saved.nodes.filter((item) => present(item.type, item.card, item.sub)).map(to_node);
  const missing = cards.value.filter((card) => !list.some((node) => node.type === "card" && node.data.card === card));
  if (list.length > 1 && list.every((node) => !node.position.x && !node.position.y)) {
    const all = [...list, ...missing.map((card) => to_node({ id: `card_${card}`, type: "card", card }))];
    const placed = layout(all, flow_shape(saved), saved.edges);
    return { list: all.map((node) => ({ ...node, position: placed.get(node.id) })), edges: saved.edges };
  }
  const left = Math.max(...list.map((node) => node.position.x + NODE_WIDTH[node.type])) + COLUMN_GAP;
  missing.forEach((card, index) => list.push(to_node({ id: `card_${card}`, type: "card", card,
    x: left, y: (index - (missing.length - 1) / 2) * (NODE_HEIGHT.card + ROW_GAP) - NODE_HEIGHT.card / 2 })));
  return { list, edges: saved.edges };
}
const initial = initial_nodes();

/**
 * A node's size: as Vue Flow measured it, else the first guess for its kind. Its round connection points sit in its
 * middle (half its height); layout lines these up, not the nodes' tops, so arrows between different heights run straight.
 */
function node_size(node) {
  const measured = instance.value?.findNode(node.id)?.dimensions;
  return { width: measured?.width || NODE_WIDTH[node.type] || NODE_WIDTH.card, height: measured?.height || NODE_HEIGHT[node.type] || NODE_HEIGHT.card };
}
const nodes = ref(initial.list);
const edges = ref(initial.edges.filter((edge) => nodes.value.some((node) => node.id === edge.source) && nodes.value.some((node) => node.id === edge.target)).map(to_edge));
const known = new Set(cards.value);

// The canvas's steps (`stages`): drawn as frames around their nodes; edited in flow.json, kept here as they were loaded.
const stages = (flow.value?.stages || []).map((stage) => ({ id: stage.id, label: stage.label || "", nodes: [...(stage.nodes || [])] }));
const STAGE_PADDING = 20, STAGE_TITLE = 26;
/** Each step's frame around its nodes still on the canvas, with the sub-workflows that attach to it (`attach`). */
const stage_frames = computed(() => stages.flatMap((stage) => {
  const members = nodes.value.filter((node) => stage.nodes.includes(node.id));
  if (!members.length) return [];
  const left = Math.min(...members.map((node) => node.position.x)) - STAGE_PADDING;
  const top = Math.min(...members.map((node) => node.position.y)) - STAGE_PADDING - STAGE_TITLE;
  const right = Math.max(...members.map((node) => node.position.x + node_size(node).width)) + STAGE_PADDING;
  const bottom = Math.max(...members.map((node) => node.position.y + node_size(node).height)) + STAGE_PADDING;
  const attached = (props.subs || []).filter((sub) => (sub.attach || []).includes(stage.id)).map((sub) => sub.label || sub.id);
  return [{ id: stage.id, label: stage.label || stage.id, attached, style: { left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` } }];
}));

// What is saved: positions rounded, arrows only between nodes still here.
const live = computed(() => {
  const ids = new Set(nodes.value.map((node) => node.id));
  const kept = stages.map((stage) => ({ id: stage.id, ...(stage.label ? { label: stage.label } : {}), nodes: stage.nodes.filter((id) => ids.has(id)) }));
  const noted = (item) => item.data?.label?.trim() ? { label: item.data.label.trim() } : {};
  return { nodes: nodes.value.map((node) => ({ id: node.id, type: node.type, ...(node.type === "card" ? { card: node.data.card } : {}),
    ...(node.type === "sub" ? { sub: node.data.sub } : {}),
    ...(node.type === "host" ? noted(node) : {}), x: Math.round(node.position.x), y: Math.round(node.position.y) })),
    edges: edges.value.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ source: edge.source, target: edge.target, ...noted(edge),
      ...(edge.data?.offset ? { offset: Math.round(edge.data.offset) } : {}) })), ...(kept.length ? { stages: kept } : {}) };
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

/** Where a node goes after a source: beside it, centred on its row (the new node is not drawn yet: its kind's guess). */
function beside(source, type) {
  const { width, height } = node_size(source);
  return { x: source.position.x + width + COLUMN_GAP, y: source.position.y + (height - NODE_HEIGHT[type]) / 2 };
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
  const right = Math.max(...nodes.value.map((item) => item.position.x + node_size(item).width));
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

// A card added to the workflow goes onto the canvas; a card or sub-workflow removed from it leaves the canvas.
watch([cards, shared_cards, sub_ids], ([list]) => {
  nodes.value = nodes.value.filter((node) => present(node.type, node.data?.card, node.data?.sub));
  for (const card of list) if (!known.has(card)) { known.add(card); add_node(to_node({ id: next_id("card_"), type: "card", card })); }
});

// ── Adding: from the toolbar, or by dropping an arrow on empty canvas (the menu opens where it was dropped). ──
const adding = ref(false);
const drop = ref(null);
const add_anchor = ref(null);
const platforms = Object.keys(bridge.identities).filter((name) => name !== "用户");
const roster_items = computed(() => [...platforms.map((name) => ({ value: name, name: bridge.display_name(name), ...bridge.identities[name],
  title: t('添加一张 {value1} 卡片', { value1: bridge.display_name(name) }), aria_label: t('添加 {value1} 卡片', { value1: name }) })),
  ...bridge.expert_presets().map((preset, index) => ({ value: PRESET_PREFIX + preset.name, name: preset.label || preset.name,
    ...bridge.identities[bridge.platform_of(preset.name)], separated: index === 0, title: preset.description || t('专家预设'), aria_label: t('按预设 {value1} 添加卡片', { value1: preset.label || preset.name }) }))]);

/** The first free card ID from a base: writer, writer2 … or role1, role2 … */
function next_card(base) {
  const taken = new Set([...agents.value.map((agent) => agent.card), ...props.reserved].map((card) => card.toLowerCase()));
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
  bridge.notify("info", t('已带入 {value1} 张卡片；请确认提示词里没有本机路径或密钥', { value1: result.cards.length }));
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

/** Select an arrow by its note: an unselected note only pans the view and takes a click (user 2026-11-20). */
function select_edge(id) {
  const edge = instance.value?.findEdge(id);
  if (!edge) return;
  instance.value.removeSelectedElements();
  instance.value.addSelectedEdges([edge]);
}

function remove_edge(id) {
  edges.value = edges.value.filter((edge) => edge.id !== id);
}

/** Remove a card from the workflow altogether; a main-flow card on a sub-workflow's canvas only leaves this canvas. */
function remove_card(card) {
  if (own(card)) { agents.value = agents.value.filter((agent) => agent.card !== card); return; }
  const gone = new Set(nodes.value.filter((node) => node.type === "card" && node.data.card === card).map((node) => node.id));
  nodes.value = nodes.value.filter((node) => !gone.has(node.id));
  edges.value = edges.value.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target));
}

/** Put a sub-workflow on the main canvas: where the flow turns to it. */
function add_sub_node(id) {
  adding.value = false;
  add_node(to_node({ id: next_id("sub_"), type: "sub", sub: id }));
}

/**
 * Put a sub-workflow on the main canvas from the parts list, or, when it is there already, find it: either way the view
 * moves to its node and selects it, so the user sees where it is.
 */
function show_sub_node(id) {
  const existing = nodes.value.find((node) => node.type === "sub" && node.data.sub === id);
  const node_id = existing?.id || next_id("sub_");
  if (!existing) add_sub_node(id);
  // Once Vue Flow has the node (a frame after it is added), centre it at the current zoom.
  nextTick(() => requestAnimationFrame(() => {
    const node = instance.value?.findNode(node_id);
    if (!node) return;
    instance.value.removeSelectedElements();
    instance.value.addSelectedNodes([node]);
    const { zoom } = instance.value.getViewport();
    const { width, height } = node_size(node);
    instance.value.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom, duration: 300 });
  }));
}

/** Show a sub-workflow; this canvas, about to be replaced, hands back its latest state first. */
function open_sub(id, fresh = false) {
  flow.value = live.value;
  emit("open-sub", id, fresh);
}

/** A double click on a sub-workflow node enters it. */
function node_double_click({ node }) {
  if (node.type === "sub") open_sub(node.data.sub);
}

/** An imported card asked for more than reading; the user grants it card by card. */
function grant(agent, allowed) {
  agent.project_access = allowed ? agent.requested_access : "read";
}

/**
 * How low a loop runs: `auto` clears every node it spans and the loops inside it; the user's offset moves it from there
 * (user 2026-11-20), but never above `floor`, where its corners would cross its own ends.
 */
function loop_depth({ id, sourceX, sourceY, targetX, targetY, data }) {
  const left = targetX - LOOP_OUT, right = sourceX + LOOP_OUT;
  const spanned = nodes.value.filter((node) => node.position.x < right && node.position.x + node_size(node).width > left);
  const auto = Math.max(sourceY, targetY, ...spanned.map((node) => node.position.y + node_size(node).height)) + LOOP_CLEARANCE
    + (loop_rank.value.get(id) || 0) * LOOP_STACK;
  const floor = Math.max(sourceY, targetY) + 2 * LOOP_RADIUS;
  return { auto, floor, below: Math.max(floor, auto + (data?.offset || 0)) };
}

/** Whether a loop goes around underneath (its source well right of its target); a short one is a plain step path. */
function loops_under(edge) {
  return shape.value.loops.has(edge.id) && edge.sourceX > edge.targetX + 2 * LOOP_OUT;
}

/** A loop runs out right, down below every node it spans, back left and up into its target, with rounded corners. */
function loop_path(edge) {
  const { sourceX, sourceY, targetX, targetY } = edge;
  const left = targetX - LOOP_OUT, right = sourceX + LOOP_OUT, radius = LOOP_RADIUS, { below } = loop_depth(edge);
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
  return loops_under(edge) ? loop_path(edge) : getSmoothStepPath({ ...edge, borderRadius: LOOP_RADIUS, offset: LOOP_OUT });
}

/** Lay the canvas out in columns by step, members of one step stacked, then fit it in view. */
function arrange() {
  const placed = layout(nodes.value, shape.value, edges.value);
  nodes.value = nodes.value.map((node) => ({ ...node, position: placed.get(node.id) || node.position }));
  // Fit once Vue Flow has moved the nodes, a frame after the positions change.
  nextTick(() => requestAnimationFrame(() => instance.value?.fitView({ ...fit_options(), duration: 250 })));
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
    const sizes = column.map(node_size);
    const height = sizes.reduce((sum, size) => sum + size.height, 0) + ROW_GAP * (column.length - 1);
    let y = -height / 2;
    const tops = sizes.map((size) => { const top = y; y += size.height + ROW_GAP; return top; });
    // Shift the column so its connection points (each node's middle) centre on the line the other columns' do.
    const shift = sizes.reduce((sum, size, row) => sum + tops[row] + size.height / 2, 0) / column.length;
    const lift = skipped.has(index) ? Math.max(...sizes.map((size, row) => tops[row] - shift + size.height)) + BYPASS_CLEARANCE : 0;
    const width = Math.max(...sizes.map((size) => size.width));
    column.forEach((node, row) => placed.set(node.id, { x: x + (width - sizes[row].width) / 2, y: tops[row] - shift - lift }));
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
  const left = Math.min(...nodes.value.map((node) => node.position.x)), right = Math.max(...nodes.value.map((node) => node.position.x + node_size(node).width));
  const top = Math.min(...nodes.value.map((node) => node.position.y)), bottom = Math.max(...nodes.value.map((node) => node.position.y + node_size(node).height));
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
defineExpose({ fit, show_sub_node });

/** A double click on empty canvas (not a card, an arrow or a floating tool) resets the view to the whole workflow. */
function pane_double_click(event) {
  if (event.target.closest(".vue-flow__node, .vue-flow__edge, .vue-flow__panel, .vue-flow__edge-labels, .workflow-edge-note")) return;
  reset_view();
}

function reset_view() {
  instance.value?.fitView({ ...fit_options(), duration: 250 });
}

/**
 * A quick middle-button double press on one spot of the canvas resets the view too (browsers fire no dblclick for it).
 * The middle button also pans: a new drag started soon after the last one begins elsewhere, so it is no double press
 * (user 2026-11-18, #4919: panning in short strokes kept resetting the view).
 */
const MIDDLE_BUTTON = 1, DOUBLE_PRESS_MS = 250, DOUBLE_PRESS_REACH_PX = 6;
let middle_pressed = null;
function middle_press(event) {
  if (event.button !== MIDDLE_BUTTON) return;
  const previous = middle_pressed;
  middle_pressed = { at: event.timeStamp, x: event.clientX, y: event.clientY };
  if (!previous || event.timeStamp - previous.at >= DOUBLE_PRESS_MS) return;
  if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > DOUBLE_PRESS_REACH_PX) return;
  middle_pressed = null;
  // The pan this press starts stops any view animation, so the reset runs once the press has been handled.
  setTimeout(reset_view, 0);
}

// ── Two-finger pinch: it always zooms the view, wherever the fingers land, cards included (Vue Flow leaves a touch
// that starts on a card to the card's drag, so a pinch half on a card panned and dragged at once). The browser never
// zooms the page from the canvas: pinches and Ctrl+wheel (a touchpad pinch) stop here. ──
const ZOOM = { min: 0.2, max: 1.8 };
// The canvas is one layer the GPU only shifts while the view pans, instead of being repainted every frame. A layer keeps
// the scale it was drawn at, so scaling it blurs the text: once the zoom changes the layer is dropped until the view
// settles, and every frame of the zoom is drawn sharp at its own scale.
const layered = ref(true);
let zoom_at_start = 1;

function view_moved() {
  zoom_at_start = instance.value?.getViewport().zoom ?? 1;
}

function view_moving({ flowTransform }) {
  if (layered.value && flowTransform.zoom !== zoom_at_start) layered.value = false;
}

function view_settled() {
  if (!layered.value) requestAnimationFrame(() => { layered.value = true; });
}
let pinch = null, pinch_frame = 0, pinch_target = null, touch_positions = null;
// A finger or a mouse on a node's body or on an arrow pans the view here: Vue Flow marks every node and every
// arrow `nopan`, so its own pan never starts there (user 2026-11-20, #6111: the long loop arrows covered much of the canvas).
let card_pan = null, card_pan_frame = 0;
// A press that moved this far is a pan, so the click it ends in does not select the arrow under it.
const PAN_CLICK_REACH_PX = 4;

// Controls inside a node's body keep their own presses.
const BODY_CONTROL = "button, input, textarea, select, label, a";

/** Whether `target` is an arrow's line (its note is drawn apart and keeps its own input and delete button). */
function on_edge_line(target) {
  return Boolean(target.closest?.(".vue-flow__edge"));
}

/** Whether a press on `target` pans the view: an arrow's line, or a node's body away from its controls. */
function pans_view(target) {
  return on_edge_line(target) || Boolean(target.closest?.(NODE_BODY) && !target.closest(BODY_CONTROL));
}

/** The click a press that moved ends in selects nothing. */
function swallow_click() {
  const swallow = (click) => { click.stopPropagation(); click.preventDefault(); };
  window.addEventListener("click", swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}

/**
 * The loop under `target` when it is selected and goes around underneath: only then does a press on its line move it up
 * or down. Unselected, a press on it pans like anywhere else, so panning never moves a line by accident (user 2026-11-20).
 */
function selected_loop(target) {
  const id = target.closest?.(".vue-flow__edge.selected")?.getAttribute("data-id");
  const edge = id && instance.value?.findEdge(id);
  return edge && loops_under(edge) ? edge : null;
}

// The loop being moved up or down: its ID, where the press began, its offset then, and how far up it may go.
let loop_drag = null;

/** Move a selected loop up or down with the pointer, by mouse, pen or finger, until it is let go. */
function start_loop_drag(edge, event) {
  const { auto, floor, below } = loop_depth(edge);
  loop_drag = { id: edge.id, from: event.clientY, offset: below - auto, min: floor - auto, zoom: instance.value.getViewport().zoom, moved: false };
  drag_start();
  const move = (moved) => {
    if (!loop_drag) return;
    const offset = Math.min(MAX_LOOP_OFFSET, Math.max(loop_drag.min, Math.round(loop_drag.offset + (moved.clientY - loop_drag.from) / loop_drag.zoom)));
    loop_drag.moved ||= Math.abs(moved.clientY - loop_drag.from) > PAN_CLICK_REACH_PX;
    edges.value = edges.value.map((item) => item.id === loop_drag.id ? { ...item, data: { ...item.data, offset } } : item);
  };
  const release = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    if (loop_drag?.moved) swallow_click();
    loop_drag = null;
    drag_stop();
  };
  loop_drag.release = release;
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
}

/**
 * A press on a selected loop's line moves it; a mouse (or pen) press on any other arrow or on a node's body pans the view
 * until it is released (touches are panned in touch_start).
 */
function edge_press(event) {
  if (event.button !== 0 || !instance.value) return;
  const loop = selected_loop(event.target);
  if (loop) { start_loop_drag(loop, event); return; }
  if (event.pointerType === "touch" || !pans_view(event.target)) return;
  const from = { x: event.clientX, y: event.clientY };
  card_pan = { from, to: null, view: instance.value.getViewport() };
  const move = (moved) => {
    card_pan.to = { x: moved.clientX, y: moved.clientY };
    if (!card_pan_frame) card_pan_frame = requestAnimationFrame(apply_card_pan);
  };
  const release = (released) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", release);
    window.removeEventListener("pointercancel", release);
    card_pan = null;
    if (Math.hypot(released.clientX - from.x, released.clientY - from.y) > PAN_CLICK_REACH_PX) swallow_click();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
}

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
  if (!pinch && touches.length === 1) {
    touch_positions = new Map(nodes.value.map((node) => [node.id, { ...node.position }]));
    const on_body = instance.value && pans_view(event.target) && !loop_drag;
    card_pan = on_body ? { from: { x: touches[0].clientX, y: touches[0].clientY }, to: null, view: instance.value.getViewport() } : null;
  }
  if (touches.length < 2 || !instance.value) return;
  card_pan = null;
  loop_drag?.release();
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
  if (touches.length >= 2 || loop_drag) event.preventDefault();
  if (card_pan && touches.length === 1) {
    event.preventDefault();
    card_pan.to = { x: touches[0].clientX, y: touches[0].clientY };
    if (!card_pan_frame) card_pan_frame = requestAnimationFrame(apply_card_pan);
  }
  if (!pinch) return;
  event.stopPropagation();
  if (touches.length < 2) return;
  pinch_target = touch_pair(touches);
  if (!pinch_frame) pinch_frame = requestAnimationFrame(apply_pinch);
}

/** Follow the finger on a card's body, one viewport change per frame. */
function apply_card_pan() {
  card_pan_frame = 0;
  if (!card_pan?.to || !instance.value) return;
  const { from, to, view } = card_pan;
  instance.value.setViewport({ x: view.x + to.x - from.x, y: view.y + to.y - from.y, zoom: view.zoom });
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
  const touches = canvas_touches(event);
  if (!touches.length) card_pan = null;
  if (!pinch) return;
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
const width_watcher = new ResizeObserver(([entry]) => { narrow.value = entry.contentRect.width < LABELLED_TOOLBAR_WIDTH; });
onMounted(() => {
  for (const [type, listener] of TOUCH_LISTENERS) canvas_element.value.addEventListener(type, listener, { capture: true, passive: false });
  width_watcher.observe(canvas_element.value);
});
onBeforeUnmount(() => {
  width_watcher.disconnect();
  for (const [type, listener] of TOUCH_LISTENERS) canvas_element.value?.removeEventListener(type, listener, { capture: true });
  cancelAnimationFrame(pinch_frame);
  cancelAnimationFrame(card_pan_frame);
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
window.addEventListener("keydown", delete_key);
onBeforeUnmount(() => { window.removeEventListener("keydown", history_key); window.removeEventListener("keydown", delete_key); clearTimeout(timer); clearTimeout(removing_timer); });

/** A card being dragged would repaint the whole one-layer canvas every frame, so the layer waits until it is let go. */
function drag_start() { dragging = true; layered.value = false; }
function drag_stop() { dragging = false; layered.value = true; stored.value = live.value; commit(); }
</script>

<template>
  <div ref="canvas_element" class="workflow-canvas" :class="{ 'is-layered': layered, 'is-compact': props.compact }" @dblclick="pane_double_click" @pointerdown.capture="middle_press" @pointerdown="edge_press">
    <VueFlow v-model:nodes="nodes" v-model:edges="edges" :min-zoom="ZOOM.min" :max-zoom="ZOOM.max" :delete-key-code="['Delete', 'Backspace']" :zoom-on-double-click="false"
      :is-valid-connection="valid_connection" elevate-nodes-on-select @connect="connect" @connect-start="connect_start" @connect-end="connect_end"
      @node-drag-start="drag_start" @node-drag-stop="drag_stop" @pane-ready="ready" @nodes-initialized="fit_once" @move-start="view_moved" @move="view_moving" @move-end="view_settled" @node-double-click="node_double_click">
      <template #node-start>
        <UTooltip :text="t('从右侧圆点拖线连到成员，示意谁先接手；拖到空白处可直接添加')">
          <div class="workflow-pill is-start">
            <div class="workflow-card-grip" :title="t('按住拖动')"><UIcon name="i-lucide-grip-horizontal" class="workflow-icon" /></div>
            <div class="workflow-node-body nodrag"><UIcon name="i-lucide-play" class="workflow-icon" /><span>{{ t('开始') }}</span></div>
            <Handle type="source" :position="Position.Right" class="workflow-handle" :class="{ 'is-calling': !edges.some((edge) => edge.source === 'start') }" />
          </div>
        </UTooltip>
      </template>
      <template #node-host="node">
        <UTooltip :text="t('主持人：示意这里交回主持人判断；选中后可写上做什么')">
          <div class="workflow-host" :class="{ 'is-selected': node.selected }">
            <Handle type="target" :position="Position.Left" class="workflow-handle" />
            <div class="workflow-card-grip" :title="t('按住拖动')"><UIcon name="i-lucide-grip-horizontal" class="workflow-icon" />
              <button type="button" class="workflow-node-close nodrag" :class="{ 'is-armed': removing === node.id }" :aria-label="removing === node.id ? t('再点一次删除主持人节点') : t('删除主持人节点')"
                :title="removing === node.id ? t('再点一次删除主持人节点') : t('删除主持人节点')" @click.stop="press_remove(node)"><UIcon :name="removing === node.id ? 'i-lucide-trash-2' : 'i-lucide-x'" class="workflow-icon" /></button></div>
            <div class="workflow-node-body nodrag">
              <UIcon name="i-lucide-crown" class="workflow-host-icon" />
              <div class="workflow-node-text"><strong>{{ t('主持人') }}</strong>
              <input v-if="node.selected" :value="node.data.label" class="workflow-note-input workflow-host-input" :maxlength="MAX_HOST_LABEL" :placeholder="t('做什么')"
                :aria-label="t('主持人在这里做什么')" @input="set_note('nodes', node.id, $event.target.value)" @keydown.enter="$event.target.blur()" />
              <p v-else-if="node.data.label" class="workflow-host-note">{{ node.data.label }}</p></div>
            </div>
            <Handle type="source" :position="Position.Right" class="workflow-handle" />
          </div>
        </UTooltip>
      </template>
      <template #node-sub="node">
        <div v-if="sub_of(node.data.sub)" class="workflow-sub" :class="{ 'is-selected': node.selected }" :title="sub_of(node.data.sub).description || undefined">
          <Handle type="target" :position="Position.Left" class="workflow-handle" />
          <div class="workflow-card-grip" :title="t('按住拖动')"><UIcon name="i-lucide-grip-horizontal" class="workflow-icon" />
              <button type="button" class="workflow-node-close nodrag" :class="{ 'is-armed': removing === node.id }" :aria-label="removing === node.id ? t('再点一次，从画布移除子工作流节点') : t('从画布移除子工作流节点')"
                :title="removing === node.id ? t('再点一次，从画布移除子工作流节点') : t('从画布移除子工作流节点')" @click.stop="press_remove(node)"><UIcon :name="removing === node.id ? 'i-lucide-trash-2' : 'i-lucide-x'" class="workflow-icon" /></button></div>
          <div class="workflow-node-body nodrag">
            <UIcon name="i-lucide-git-branch" class="workflow-sub-icon" />
            <div class="workflow-node-text">
              <strong>{{ sub_of(node.data.sub).label || node.data.sub }}</strong>
              <small>{{ t('子工作流') }} · {{ t('{value1} 位成员', { value1: sub_member_count(sub_of(node.data.sub), agents) }) }}</small>
            </div>
            <button type="button" class="workflow-sub-enter" :title="t('进入这个子工作流（也可双击）')" @click.stop="open_sub(node.data.sub)">{{ t('进入') }}<UIcon name="i-lucide-arrow-right" class="workflow-icon" /></button>
          </div>
          <Handle type="source" :position="Position.Right" class="workflow-handle" />
        </div>
      </template>
      <template #node-card="node">
        <div v-if="agent_of(node.data.card)" class="workflow-card" :class="{ 'is-selected': node.selected }">
          <Handle type="target" :position="Position.Left" class="workflow-handle" />
          <div class="workflow-card-grip" :title="t('按住拖动')"><UIcon name="i-lucide-grip-horizontal" class="workflow-icon" />
              <button type="button" class="workflow-node-close nodrag" :class="{ 'is-armed': removing === node.id }" :aria-label="removing === node.id ? t('再点一次移除 {value1}', { value1: label_of(node.data.card) }) : t('移除 {value1}', { value1: label_of(node.data.card) })"
                :title="removing === node.id ? t('再点一次，从工作流移除这位成员') : t('从工作流移除这张卡片')" @click.stop="press_remove(node)"><UIcon :name="removing === node.id ? 'i-lucide-trash-2' : 'i-lucide-x'" class="workflow-icon" /></button></div>
          <div v-for="agent in [agent_of(node.data.card)]" :key="agent.card" class="workflow-card-body nodrag" :title="agent.description || undefined"
            @dblclick="emit('configure', agent.card)">
            <UAvatar :src="bridge.identities[bridge.platform_of(agent.name)]?.icon" :text="bridge.identities[bridge.platform_of(agent.name)]?.initials || '?'" size="md"
              class="channel-avatar" :class="bridge.identities[bridge.platform_of(agent.name)]?.style" />
            <div class="workflow-card-who">
              <strong>{{ agent.label || bridge.default_name(agent.name) }}</strong>
              <span>{{ bridge.default_name(bridge.platform_of(agent.name)) }}</span>
              <small>{{ agent.model || t('软件默认模型') }} · {{ access_label(agent.project_access || 'read') }}</small>
            </div>
            <div class="workflow-card-tools">
              <UButton icon="i-lucide-sliders-horizontal" size="xs" color="neutral" variant="ghost" :aria-label="t('配置 {value1}', { value1: agent.label || agent.card })" :title="t('配置：软件、模型、描述与专属提示词（也可双击卡片）')" @click="emit('configure', agent.card)" />
            </div>
            <label v-if="agent_of(node.data.card).requested_access" class="workflow-card-grant">
              <input type="checkbox" :checked="agent_of(node.data.card).project_access !== 'read'" @change="grant(agent_of(node.data.card), $event.target.checked)" /> {{ t('允许「{value1}」', { value1: access_label(agent_of(node.data.card).requested_access) }) }}</label>
          </div>
          <Handle type="source" :position="Position.Right" class="workflow-handle" />
        </div>
      </template>
      <template #edge-flow="edge">
        <BaseEdge :id="edge.id" :path="edge_path(edge)[0]" :marker-end="edge.markerEnd" class="workflow-edge"
          :class="{ 'is-loop': shape.loops.has(edge.id), 'is-under': loops_under(edge), 'is-selected': edge.selected }" />
        <EdgeLabelRenderer>
          <div v-if="edge.selected || edge.data?.label" class="workflow-edge-note" :class="{ 'is-loop': shape.loops.has(edge.id), 'is-selected': edge.selected, nopan: edge.selected }"
            @click.stop="edge.selected || select_edge(edge.id)"
            :style="{ transform: `translate(-50%, -50%) translate(${edge_path(edge)[1]}px, ${edge_path(edge)[2]}px)` }">
            <template v-if="edge.selected">
              <input :value="edge.data?.label" class="workflow-note-input" :maxlength="MAX_EDGE_LABEL" :placeholder="t('说明，如“返工”')" :aria-label="t('这条连线的说明')"
                :style="{ width: `${Math.max(6, (edge.data?.label || '').length + 1)}em` }" @input="set_note('edges', edge.id, $event.target.value)" @keydown.enter="$event.target.blur()" />
              <button type="button" class="workflow-edge-delete" :aria-label="t('删除这条连线')" @click="remove_edge(edge.id)"><UIcon name="i-lucide-x" class="workflow-icon" /></button>
            </template>
            <span v-else>{{ edge.data.label }}</span>
          </div>
        </EdgeLabelRenderer>
      </template>
      <template #zoom-pane>
        <div v-for="frame in stage_frames" :key="frame.id" class="workflow-stage" :style="frame.style">
          <span class="workflow-stage-title">{{ frame.label }}<small v-if="frame.attached.length">{{ t('挂靠：{value1}', { value1: frame.attached.join('、') }) }}</small></span>
        </div>
      </template>
      <Background :gap="22" :size="1.2" color="var(--ui-border-accented)" />
      <Controls :show-interactive="false" position="top-right" class="workflow-canvas-controls" />
      <MiniMap v-if="!props.compact" pannable zoomable position="bottom-right" class="workflow-canvas-minimap" :width="168" :height="104" :node-border-radius="8" />
      <Panel position="top-left" class="workflow-canvas-toolbar">
        <UTooltip :text="t('添加成员（也可从圆点拖线到空白处）')"><UButton icon="i-lucide-user-plus" :label="icons_only ? undefined : t('成员')" :aria-label="t('添加成员')" :size="tool_size" color="neutral" variant="ghost" @click="open_add" /></UTooltip>
        <UTooltip :text="t('主持人节点：示意交回主持人判断的地方')"><UButton icon="i-lucide-crown" :label="icons_only ? undefined : t('主持人')" :aria-label="t('添加主持人节点')" :size="tool_size" color="neutral" variant="ghost" @click="add_host" /></UTooltip>
        <span class="workflow-canvas-divider" />
        <UTooltip :text="t('撤销 (Ctrl+Z)')"><UButton icon="i-lucide-undo-2" :size="tool_size" color="neutral" variant="ghost" :aria-label="t('撤销')" :disabled="!past.length" @click="undo" /></UTooltip>
        <UTooltip :text="t('重做 (Ctrl+Shift+Z)')"><UButton icon="i-lucide-redo-2" :size="tool_size" color="neutral" variant="ghost" :aria-label="t('重做')" :disabled="!future.length" @click="redo" /></UTooltip>
        <UTooltip :text="t('自动整理')"><UButton icon="i-lucide-wand-sparkles" :size="tool_size" color="neutral" variant="ghost" :aria-label="t('自动整理')" @click="arrange" /></UTooltip>
        <template v-if="$slots.actions"><span class="workflow-canvas-divider" /><slot name="actions" :icons-only="icons_only" /></template>
      </Panel>
      <!-- The arrows only illustrate: kept on phones too, where the bottom left holds the main line / sub-workflow switch. -->
      <Panel :position="props.compact ? 'bottom-right' : 'bottom-left'" class="workflow-canvas-status">
        <UIcon name="i-lucide-info" class="workflow-icon" /><span>{{ t('连线只作示意，派活以') }}</span>
        <button type="button" class="workflow-canvas-skill" @click="emit('open-skill')">SKILL.md</button><span>{{ t('为准') }}</span>
      </Panel>
    </VueFlow>
    <UPopover :open="adding" :reference="add_anchor" :content="{ side: 'bottom', align: 'start', sideOffset: 8, collisionPadding: 12 }"
      :ui="{ content: 'workflow-canvas-add' }" @update:open="(value) => { adding = value; }">
      <template #content>
        <div class="workflow-canvas-add-body">
          <RosterAdd :label="t('添加成员卡片')" :items="roster_items" @add="add_card" />
          <div v-if="agents.length" class="workflow-canvas-add-again">
            <span>{{ t('已有成员再放一次') }}</span>
            <UButton v-for="agent in agents" :key="agent.card" :label="label_of(agent.card)" icon="i-lucide-copy-plus" size="xs" color="neutral" variant="soft"
              :title="t('在画布上再放一个「{value1}」：同一张卡片，示意它在流程里出场两次', { value1: label_of(agent.card) })" @click="place_again(agent.card)" />
          </div>
          <div v-if="shared?.length" class="workflow-canvas-add-again">
            <span>{{ t('主线的成员') }}</span>
            <UButton v-for="agent in shared" :key="agent.card" :label="label_of(agent.card)" icon="i-lucide-user-round-plus" size="xs" color="neutral" variant="soft"
              :title="t('把主线的「{value1}」放进这个子工作流：同一张卡片，示意它在这里参与', { value1: label_of(agent.card) })" @click="place_again(agent.card)" />
          </div>
          <!-- A line dropped on empty canvas may end at a sub-workflow; everything else about them is in the parts list. -->
          <div v-if="drop && props.subs?.length" class="workflow-canvas-add-again">
            <span>{{ t('子工作流') }}</span>
            <UButton v-for="sub in props.subs" :key="sub.id" :label="sub.label || sub.id" icon="i-lucide-git-branch" size="xs" color="neutral" variant="soft"
              :title="sub.description || t('示意这里转去这个子工作流')" @click="add_sub_node(sub.id)" />
          </div>
          <div class="workflow-canvas-add-more">
            <UButton v-if="drop" icon="i-lucide-crown" :label="t('主持人')" size="xs" color="neutral" variant="soft" @click="add_host" />
            <UButton v-if="view.room?.id && !drop" icon="i-lucide-users" :label="t('当前房间的成员')" size="xs" color="neutral" variant="soft" @click="cards_from_room" />
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
/* Phone and upright tablet: smaller tools, every panel the same 10px from the edge, the toolbar and zoom buttons on one row. */
.workflow-canvas.is-compact :deep(.vue-flow__panel) { margin: 10px; }
.workflow-canvas.is-compact .workflow-canvas-toolbar { gap: 0; padding: 2px; border-radius: 9px; }
.workflow-canvas.is-compact .workflow-canvas-divider { height: 14px; margin: 0 2px; }
.workflow-canvas.is-compact .workflow-canvas-status { max-width: calc(100% - 190px); padding: 4px 10px; font-size: 11px; white-space: normal; }
.workflow-canvas-status { display: flex; align-items: center; gap: 4px; padding: 6px 12px; border: 1px solid var(--ui-border-muted); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); font-size: 12px; white-space: nowrap; }
.workflow-canvas.is-layered :deep(.vue-flow__transformationpane) { will-change: transform; }

/* Start: a small card, its drag bar on top like every node's. */
.workflow-pill { --workflow-card-edge: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 50%, var(--ui-border)); position: relative; display: flex; flex-direction: column;
  width: max-content; min-width: 96px; border: 1px solid var(--workflow-card-edge); border-radius: 12px; background: var(--ui-bg-elevated); box-shadow: 0 2px 8px rgb(0 0 0 / .12);
  font-size: 13px; font-weight: 500; white-space: nowrap; }
.workflow-pill > .workflow-card-grip { border-radius: 11px 11px 0 0; }
.workflow-pill > .workflow-node-body { display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 16px; }
.workflow-pill.is-start { color: var(--channel-accent, var(--ui-primary)); }
/* A node's body: pressing it neither drags the node nor (with a mouse) pans the canvas. */
.workflow-node-body { cursor: default; }
/* Every node's ×: at the right end of its drag bar. Hidden until hovered or selected, and not pressable while hidden: a phone
   has no hover, so a tap there removed the node unseen. Armed (first press), it turns into a red bin until pressed again. */
.workflow-node-close { position: absolute; top: 50%; right: 4px; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%;
  transform: translateY(-50%); color: var(--ui-text-dimmed); opacity: 0; pointer-events: none; cursor: pointer; transition: opacity .15s; }
:is(.workflow-host, .workflow-sub, .workflow-card):is(:hover, .is-selected) .workflow-node-close, .workflow-node-close.is-armed { opacity: 1; pointer-events: auto; }
.workflow-node-close:hover { background: var(--ui-bg-accented); color: var(--ui-error, #e5484d); }
.workflow-node-close.is-armed { background: color-mix(in srgb, var(--ui-error, #e5484d) 18%, transparent); color: var(--ui-error, #e5484d); }
.workflow-node-close > .workflow-icon { width: 12px; height: 12px; }
/* Host, sub-workflow and member share one body: icon or avatar, a title over a dim line, then the node's own action. */
.workflow-node-text { display: flex; flex: 1; flex-direction: column; gap: 2px; min-width: 0; text-align: left; line-height: 1.3; }
.workflow-node-text > * { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Host: gold, its note under the title. */
.workflow-host { --workflow-grip-tint: #e0b44a; --workflow-card-edge: color-mix(in srgb, #e0b44a 70%, var(--ui-border)); position: relative; display: flex; flex-direction: column; width: 240px; height: 96px;
  border: 1.5px solid var(--workflow-card-edge); border-radius: 12px; background: color-mix(in srgb, #e0b44a 10%, var(--ui-bg-elevated));
  box-shadow: 0 6px 18px rgb(0 0 0 / .28); color: #d6a63a; text-align: center; }
.workflow-host.is-selected { box-shadow: 0 0 0 3px color-mix(in srgb, #e0b44a 45%, transparent), 0 6px 18px rgb(0 0 0 / .28); }
.workflow-host > .workflow-node-body, .workflow-sub > .workflow-node-body { display: flex; flex: 1; align-items: center; gap: 10px; min-height: 0; padding: 0 12px; }
.workflow-host-icon, .workflow-sub-icon { flex-shrink: 0; width: 26px; height: 26px; }
.workflow-host strong { font-size: 14px; font-weight: 600; }
.workflow-node-text > .workflow-host-note { display: -webkit-box; margin: 0; color: var(--ui-text-toned); font-size: 12px; line-height: 17px; white-space: normal;
  -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
.workflow-host-input { width: 100%; }

/* Sub-workflow: violet, entered by its button. */
.workflow-sub { --workflow-grip-tint: #9b7cf0; --workflow-card-edge: color-mix(in srgb, #9b7cf0 70%, var(--ui-border)); position: relative; display: flex; flex-direction: column; width: 240px; height: 96px;
  border: 1.5px solid var(--workflow-card-edge); border-radius: 12px; background: color-mix(in srgb, #9b7cf0 12%, var(--ui-bg-elevated));
  box-shadow: 0 6px 18px rgb(0 0 0 / .28); color: #b49cf5; text-align: center; }
.workflow-sub.is-selected { box-shadow: 0 0 0 3px color-mix(in srgb, #9b7cf0 45%, transparent), 0 6px 18px rgb(0 0 0 / .28); }
.workflow-sub strong { color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.workflow-sub small { color: var(--ui-text-muted); font-size: 11px; }
.workflow-sub-enter { display: inline-flex; flex-shrink: 0; align-items: center; gap: 3px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, #9b7cf0 22%, transparent);
  color: inherit; font-size: 11px; }
.workflow-sub-enter:hover { background: color-mix(in srgb, #9b7cf0 36%, transparent); color: var(--ui-text-highlighted); }
.workflow-sub-enter > .workflow-icon { width: 11px; height: 11px; }

/* Members: one square frame, a drag bar on top and the expert card filling the rest. */
.workflow-card { --workflow-card-edge: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 45%, var(--ui-border-accented));
  position: relative; display: flex; flex-direction: column; width: 240px; height: 96px; border: 1.5px solid var(--workflow-card-edge); border-radius: 12px;
  background: var(--ui-bg-elevated); box-shadow: 0 6px 18px rgb(0 0 0 / .28); color: var(--ui-text); }
.workflow-card-grip { position: relative; display: flex; flex-shrink: 0; align-items: center; justify-content: center; height: 22px; border-bottom: 1px solid var(--workflow-card-edge); border-radius: 10px 10px 0 0;
  background: color-mix(in srgb, var(--workflow-grip-tint, var(--channel-accent, var(--ui-primary))) 16%, var(--ui-bg-elevated)); color: var(--ui-text-muted); cursor: grab; }
.workflow-card-grip:active { cursor: grabbing; }
/* A finger needs about 40px, and the bar and ports shrink with the view: on touch screens both reach further than they show. */
@media (pointer: coarse) {
  .workflow-card-grip { position: relative; }
  .workflow-card-grip::before { content: ""; position: absolute; inset: -14px -10px -4px; }
  /* Ports reach out from the card only: reaching in, they covered the card's configure button. */
  :deep(.workflow-handle)::after { content: ""; position: absolute; }
  :deep(.workflow-handle.vue-flow__handle-left)::after { inset: -12px 0 -12px -16px; }
  :deep(.workflow-handle.vue-flow__handle-right)::after { inset: -12px -16px -12px 0; }
  /* Every control on the canvas takes a finger: about 40px, or as near as fits inside a card. */
  .workflow-canvas-toolbar :deep(button) { min-width: 40px; min-height: 40px; justify-content: center; }
  :deep(.workflow-canvas-controls .vue-flow__controls-button) { width: 40px; height: 40px; }
  .workflow-canvas.is-compact :deep(.workflow-canvas-controls .vue-flow__controls-button) { width: 40px; height: 40px; }
  .workflow-card-tools :deep(button) { min-width: 32px; min-height: 32px; justify-content: center; }
  .workflow-card-tools { gap: 0; }
  .workflow-node-close { width: 28px; height: 28px; }
  .workflow-edge-delete { width: 32px; height: 32px; }
}
.workflow-card.is-selected { border-color: var(--channel-accent, var(--ui-primary)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 30%, transparent), 0 6px 18px rgb(0 0 0 / .28); }
/* Who the card is: avatar, role, software, then model and project access in one dim line; its tools at the right. */
.workflow-card-body { display: flex; flex: 1; align-items: center; gap: 10px; min-height: 0; padding: 0 6px 0 12px; cursor: default; }
.workflow-card-who { display: flex; flex: 1; flex-direction: column; min-width: 0; line-height: 1.3; }
.workflow-card-who > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-card-who strong { font-size: 14px; color: var(--ui-text-highlighted); }
.workflow-card-who span { font-size: 12px; color: var(--ui-text-muted); }
.workflow-card-who small { font-size: 11px; color: var(--ui-text-dimmed); }
.workflow-card-tools { display: flex; flex-direction: column; align-self: stretch; justify-content: center; gap: 2px; }
.workflow-canvas-skill { color: var(--channel-accent, var(--ui-primary)); text-decoration: underline; text-underline-offset: 3px; }
.workflow-canvas-skill:hover { color: var(--ui-text-highlighted); }
.workflow-card-grant { position: absolute; top: calc(100% + 6px); left: 0; display: flex; gap: 6px; align-items: center; color: var(--ui-warning, #e0a33a); font-size: 12px; white-space: nowrap; }

/* Ports: round, larger than Vue Flow's default; the start's pulses while nothing is connected. */
:deep(.workflow-handle) { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--channel-accent, var(--ui-primary)); background: var(--ui-bg); transition: background .15s; }
.workflow-stage { position: absolute; z-index: -1; pointer-events: none; border: 1px dashed var(--ui-border-accented); border-radius: 14px;
  background: color-mix(in srgb, var(--ui-bg-elevated, #888) 40%, transparent); }
.workflow-stage-title { position: absolute; top: 6px; left: 12px; display: flex; gap: 8px; align-items: baseline; font-size: 12px; font-weight: 600;
  color: var(--ui-text-muted); white-space: nowrap; }
.workflow-stage-title small { font-weight: 400; color: var(--ui-text-dimmed); }
:deep(.workflow-handle:hover) { background: var(--channel-accent, var(--ui-primary)); }
:deep(.workflow-handle.is-calling) { animation: workflow-call 1.6s ease-out infinite; }
@keyframes workflow-call { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--channel-accent, #6c7bff) 55%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
:deep(.workflow-edge) { stroke: var(--ui-text-dimmed); stroke-width: 1.6; }
:deep(.workflow-edge.is-loop) { stroke: #c99a2e; stroke-dasharray: 6 5; }
:deep(.vue-flow__edge.selected:has(.workflow-edge.is-under)) { cursor: ns-resize; }
:deep(.workflow-edge.is-selected) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 2.2; }
.workflow-edge-note { position: absolute; display: flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--ui-border-muted); border-radius: 999px;
  background: var(--ui-bg-elevated); color: var(--ui-text-toned); font-size: 11px; line-height: 18px; white-space: nowrap; pointer-events: all; }
.workflow-edge-note.is-loop { border-color: color-mix(in srgb, #e0b44a 55%, var(--ui-border)); color: #c99a2e; }
.workflow-edge-note.is-selected { padding: 2px 2px 2px 6px; border-color: var(--channel-accent, var(--ui-primary)); }
.workflow-note-input { min-width: 0; height: 20px; padding: 0 4px; border: 0; border-radius: 4px; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 11px; outline: none; }
.workflow-edge-delete { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--ui-border-accented); border-radius: 50%;
  background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.workflow-edge-delete:hover { color: var(--ui-error, #e5484d); border-color: currentColor; }
.workflow-edge-delete > .workflow-icon { width: 11px; height: 11px; }
:deep(.vue-flow__connection-path) { stroke: var(--channel-accent, var(--ui-primary)); stroke-width: 1.8; stroke-dasharray: 5 4; }
:deep(.vue-flow__edge-path) { fill: none; }
:deep(.vue-flow__node) { cursor: default; }
:deep(.vue-flow__edge) { cursor: grab; }
:deep(.vue-flow__edge:active) { cursor: grabbing; }
:deep(.workflow-canvas-controls) { display: flex; border: 1px solid var(--ui-border-muted); border-radius: 10px; overflow: hidden; box-shadow: 0 6px 20px rgb(0 0 0 / .14); }
:deep(.workflow-canvas-controls .vue-flow__controls-button) { width: 34px; height: 34px; border-bottom: 0; border-right: 1px solid var(--ui-border-muted); background: var(--ui-bg-elevated); fill: var(--ui-text-muted); color: var(--ui-text-muted); }
:deep(.workflow-canvas-controls .vue-flow__controls-button:last-child) { border-right: 0; }
:deep(.workflow-canvas-controls .vue-flow__controls-button:hover) { background: var(--ui-bg-accented); }
.workflow-canvas.is-compact :deep(.workflow-canvas-controls) { border-radius: 9px; }
.workflow-canvas.is-compact :deep(.workflow-canvas-controls .vue-flow__controls-button) { width: 28px; height: 28px; }
/* Narrow canvas (phone portrait, or desktop squeezed beside drawers): stack zoom vertically below the top toolbar so they never collide. */
.workflow-canvas.is-tight .workflow-canvas-toolbar { max-width: calc(100% - 20px); overflow-x: auto; }
.workflow-canvas.is-tight :deep(.workflow-canvas-controls) { top: 44px; flex-direction: column; }
@media (pointer: coarse) { .workflow-canvas.is-tight :deep(.workflow-canvas-controls) { top: 56px; } }
.workflow-canvas.is-tight :deep(.workflow-canvas-controls .vue-flow__controls-button) { border-right: 0; border-bottom: 1px solid var(--ui-border-muted); }
.workflow-canvas.is-tight :deep(.workflow-canvas-controls .vue-flow__controls-button:last-child) { border-bottom: 0; }
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
html[data-theme="channel-light"] .workflow-canvas .workflow-sub { color: #6a4bc4; }
html[data-theme="channel-light"] .workflow-canvas .workflow-host,
html[data-theme="channel-light"] .workflow-canvas .workflow-edge-note.is-loop { color: #8a5d00; }

/* The add menu renders outside the canvas. */
.workflow-canvas-add { padding: 10px 12px; max-width: min(560px, 92vw); }
.workflow-canvas-add-body { display: grid; gap: 10px; justify-items: start; }
.workflow-canvas-add-more { display: flex; gap: 6px; }
.workflow-canvas-add-more:empty { display: none; }
.workflow-canvas-add-again { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; max-width: 520px; padding-top: 8px; border-top: 1px solid var(--ui-border-muted); }
.workflow-canvas-add-again > span { width: 100%; color: var(--ui-text-muted); font-size: 12px; }
.workflow-canvas-add-again:first-child { padding-top: 0; border-top: 0; }
/* Phone: each label sits above its chips, so the chips use the whole width and line up with the sections below. */
@media (max-width: 640px) {
  .workflow-canvas-add .roster-add { grid-template-columns: minmax(0, 1fr); gap: 4px; width: 100%; }
  .workflow-canvas-add .roster-add .roster-add-label { color: var(--ui-text-muted); line-height: 20px; }
  .workflow-canvas-add .roster-add .roster-add-chips + .roster-add-label { margin-top: 6px; }
}
</style>

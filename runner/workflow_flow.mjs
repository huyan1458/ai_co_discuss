/**
 * A workflow's canvas (`flow.json`): member cards and host nodes joined by arrows, drawn to help the user see how the
 * workflow's members work together. It only illustrates SKILL.md: the program neither runs it nor hands it to the host,
 * who dispatches by SKILL.md alone. Plain JavaScript without Node modules: the web editor and the runner share it.
 */

export const FLOW_NODE_TYPES = ['start', 'card', 'host'];
export const MAX_FLOW_NODES = 60;
export const MAX_FLOW_EDGES = 120;
const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Short notes drawn on the canvas: what the host does at a host node ("验收"), what an arrow means ("返工", "不等交回").
export const MAX_HOST_LABEL = 12;
export const MAX_EDGE_LABEL = 16;

/** A note's text, trimmed; empty means none. */
function note(value, max, where) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value.trim() : null;
  if (text === null || text.length > max || /\n/.test(text)) throw new Error(`${where}的说明须为不换行的文字，最多 ${max} 字`);
  return text;
}

/** A blank canvas: only the start node. */
export function empty_flow() {
  return { nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], edges: [] };
}

/** Whether a flow holds anything beyond its start node. */
export function flow_in_use(flow) {
  return Boolean(flow?.nodes?.some(node => node.type !== 'start'));
}

/** Check the stored shape of a flow and return a clean copy; throws in Chinese on anything malformed. */
export function normalize_flow(flow) {
  if (!flow || typeof flow !== 'object' || !Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) throw new Error('flow 须为 { nodes, edges }');
  if (flow.nodes.length > MAX_FLOW_NODES || flow.edges.length > MAX_FLOW_EDGES) throw new Error(`画布最多 ${MAX_FLOW_NODES} 个节点、${MAX_FLOW_EDGES} 条连线`);
  const ids = new Set();
  const nodes = flow.nodes.map(node => {
    if (!node || !NODE_ID.test(node.id) || ids.has(node.id) || !FLOW_NODE_TYPES.includes(node.type)) throw new Error('画布节点须有不重复的 id 与类型 start / card / host');
    if (node.type === 'card' && (typeof node.card !== 'string' || !node.card)) throw new Error(`节点 ${node.id} 没有指明卡片`);
    ids.add(node.id);
    const x = Number.isFinite(node.x) ? Math.round(node.x) : 0, y = Number.isFinite(node.y) ? Math.round(node.y) : 0;
    const label = node.type === 'host' ? note(node.label, MAX_HOST_LABEL, `主持人节点 ${node.id} `) : '';
    return { id: node.id, type: node.type, ...(node.type === 'card' ? { card: node.card } : {}), ...(label ? { label } : {}), x, y };
  });
  const seen = new Set();
  const edges = flow.edges.map(edge => {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('连线须连接画布上已有的节点');
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) throw new Error('两个节点之间只能有一条同向连线');
    seen.add(key);
    const label = note(edge.label, MAX_EDGE_LABEL, `连线 ${key} `);
    return { source: edge.source, target: edge.target, ...(label ? { label } : {}) };
  });
  return { nodes, edges };
}

/** Top to bottom, then left to right: the order members of one step are named in. */
function by_position(left, right) {
  return left.y - right.y || left.x - right.x;
}

/** Walk from the start: an arrow to a node still on the walk's path goes back (a loop); every other arrow runs forward. */
function walk_edges(nodes, outgoing, start_id) {
  const back = [], forward = [], state = new Map();
  const walk = id => {
    state.set(id, 'open');
    for (const target of [...outgoing.get(id)].sort((left, right) => by_position(nodes.get(left), nodes.get(right)))) {
      if (state.get(target) === 'open') back.push({ source: id, target });
      else {
        forward.push({ source: id, target });
        if (!state.has(target)) walk(target);
      }
    }
    state.set(id, 'done');
  };
  walk(start_id);
  return { back, forward, state };
}

/**
 * Arrows of a canvas as the relay reads them, for drawing it: `loops` holds `source>target` of each arrow going back, and
 * `layers` gives each node reached from the start its column (the longest forward path to it).
 */
export function flow_shape(flow) {
  try {
    const shape = normalize_flow(flow);
    const nodes = new Map(shape.nodes.map(node => [node.id, node]));
    const start = shape.nodes.find(node => node.type === 'start');
    if (!start) return { loops: new Set(), layers: new Map() };
    const outgoing = new Map(shape.nodes.map(node => [node.id, []]));
    for (const edge of shape.edges) if (edge.source !== edge.target && edge.target !== start.id) outgoing.get(edge.source).push(edge.target);
    const { back, forward } = walk_edges(nodes, outgoing, start.id);
    const layers = new Map([[start.id, 0]]);
    // Forward arrows have no cycle, so relaxing them as many times as there are nodes settles every column.
    for (let round = 0; round < shape.nodes.length; round++) {
      for (const edge of forward) if (layers.has(edge.source)) layers.set(edge.target, Math.max(layers.get(edge.target) ?? 0, layers.get(edge.source) + 1));
    }
    return { loops: new Set(back.map(edge => `${edge.source}>${edge.target}`)), layers };
  } catch { return { loops: new Set(), layers: new Map() }; }
}

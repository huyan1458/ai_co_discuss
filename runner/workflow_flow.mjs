/**
 * A workflow's canvas (`flow.json`): member cards, host/user/branch nodes and (on the main flow) sub-workflow nodes
 * joined by arrows, drawn to help the user see how the workflow's members work together. It only illustrates SKILL.md:
 * the program neither runs it nor hands it to the host, who dispatches by SKILL.md alone. Plain JavaScript without Node
 * modules: the web editor and the runner share it.
 */

export const FLOW_NODE_TYPES = ['start', 'card', 'host', 'user', 'branch', 'sub'];
export const MAX_FLOW_NODES = 60;
export const MAX_FLOW_EDGES = 120;
const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;
// Short notes drawn on the canvas: what the host/user/branch does ("验收", "确认大纲", "判断类型"), what an arrow means ("返工", "不等交回").
export const MAX_HOST_LABEL = 12;
export const MAX_USER_LABEL = 16;
export const MAX_BRANCH_NODE_LABEL = 16;
export const MAX_BRANCH_LABEL = 16;
export const MAX_BRANCHES = 20;
export const MAX_EDGE_LABEL = 16;
export const MAX_STAGE_LABEL = 16;
export const MAX_FLOW_STAGES = 20;
// How far the user may move a loop arrow up or down from where the canvas draws it (`offset`, canvas pixels).
export const MAX_LOOP_OFFSET = 2000;

/** Stable identifier for an arrow: includes the branch ID when leaving a conditional branch node. */
export function edge_key(edge) {
  return edge.branch ? `${edge.source}:${edge.branch}>${edge.target}` : `${edge.source}>${edge.target}`;
}

/** A note's text, trimmed; empty means none. */
function note(value, max, where) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value.trim() : null;
  if (text === null || text.length > max || /\n/.test(text)) throw new Error(`${where}的说明须为不换行的文字，最多 ${max} 字`);
  return text;
}

/** Branches of a conditional branch node: 1 to MAX_BRANCHES items, each with a unique ID and an optional short label. */
function normalize_branches(branches, node_id) {
  if (!Array.isArray(branches) || !branches.length || branches.length > MAX_BRANCHES) {
    throw new Error(`条件分支节点 ${node_id} 须包含 1—${MAX_BRANCHES} 个分支`);
  }
  const seen = new Set();
  return branches.map(item => {
    if (!item || typeof item.id !== 'string' || !NODE_ID.test(item.id) || seen.has(item.id)) {
      throw new Error(`条件分支节点 ${node_id} 的分支须有不重复的 id（英文、数字、下划线或连字符，1—40 位）`);
    }
    seen.add(item.id);
    const label = note(item.label, MAX_BRANCH_LABEL, `分支 ${node_id}.${item.id} `);
    return { id: item.id, ...(label ? { label } : {}) };
  });
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
  const ids = new Set(), node_map = new Map();
  const nodes = flow.nodes.map(node => {
    if (!node || typeof node.id !== 'string' || !NODE_ID.test(node.id) || ids.has(node.id) || !FLOW_NODE_TYPES.includes(node.type)) {
      throw new Error('画布节点须有不重复的 id 与类型 start / card / host / user / branch / sub');
    }
    if (node.type === 'card' && (typeof node.card !== 'string' || !node.card)) throw new Error(`节点 ${node.id} 没有指明卡片`);
    if (node.type === 'sub' && (typeof node.sub !== 'string' || !node.sub)) throw new Error(`节点 ${node.id} 没有指明子工作流`);
    ids.add(node.id);
    const x = Number.isFinite(node.x) ? Math.round(node.x) : 0, y = Number.isFinite(node.y) ? Math.round(node.y) : 0;
    const label = node.type === 'host' ? note(node.label, MAX_HOST_LABEL, `主持人节点 ${node.id} `)
      : node.type === 'user' ? note(node.label, MAX_USER_LABEL, `用户节点 ${node.id} `)
      : node.type === 'branch' ? note(node.label, MAX_BRANCH_NODE_LABEL, `条件分支节点 ${node.id} `) : '';
    const branches = node.type === 'branch' ? normalize_branches(node.branches, node.id) : null;
    const normalized = { id: node.id, type: node.type, ...(node.type === 'card' ? { card: node.card } : {}),
      ...(node.type === 'sub' ? { sub: node.sub } : {}), ...(label ? { label } : {}),
      ...(branches ? { branches } : {}), x, y };
    node_map.set(node.id, normalized);
    return normalized;
  });
  const seen = new Set();
  const edges = flow.edges.map(edge => {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('连线须连接画布上已有的节点');
    const source_node = node_map.get(edge.source);
    const has_branch = edge.branch !== undefined && edge.branch !== null && edge.branch !== '';
    let branch = '';
    if (has_branch) {
      if (source_node.type !== 'branch') throw new Error(`连线 ${edge.source}>${edge.target} 的 branch 只能用于条件分支节点`);
      if (typeof edge.branch !== 'string' || !source_node.branches.some(item => item.id === edge.branch)) {
        throw new Error(`连线引用了不存在的分支：${edge.source}.${edge.branch}`);
      }
      branch = edge.branch;
    } else if (source_node.type === 'branch') {
      throw new Error(`从条件分支节点 ${edge.source} 出发的连线须指明 branch（分支 ID）`);
    }
    const key = edge_key({ source: edge.source, branch, target: edge.target });
    if (seen.has(key)) throw new Error(branch ? '同一分支到同一节点只能有一条连线' : '两个节点之间只能有一条同向连线');
    seen.add(key);
    const label = note(edge.label, MAX_EDGE_LABEL, `连线 ${key} `);
    const offset = Number.isFinite(edge.offset) ? Math.max(-MAX_LOOP_OFFSET, Math.min(MAX_LOOP_OFFSET, Math.round(edge.offset))) : 0;
    return { source: edge.source, ...(branch ? { branch } : {}), target: edge.target, ...(label ? { label } : {}), ...(offset ? { offset } : {}) };
  });
  const stages = normalize_stages(flow.stages, ids);
  return { nodes, edges, ...(stages.length ? { stages } : {}) };
}

/**
 * The canvas's steps (`stages`): named groups of its nodes, drawn as frames, that sub-workflows name to say where they
 * attach (`metadata.attach`). Like the canvas they only illustrate SKILL.md. A stage ID follows the node ID rule and may
 * equal a node's ID; a node belongs to one stage at most; an unknown node is refused.
 */
function normalize_stages(stages, node_ids) {
  if (stages === undefined || stages === null) return [];
  if (!Array.isArray(stages) || stages.length > MAX_FLOW_STAGES) throw new Error(`stages 须为列表，最多 ${MAX_FLOW_STAGES} 个`);
  const ids = new Set(), placed = new Set();
  return stages.map(stage => {
    if (!stage || typeof stage.id !== 'string' || !NODE_ID.test(stage.id) || ids.has(stage.id)) throw new Error('画布的步骤须有不重复的 id（英文、数字、下划线或连字符，1—40 位）');
    ids.add(stage.id);
    const label = note(stage.label, MAX_STAGE_LABEL, `步骤 ${stage.id} `);
    const nodes = stage.nodes === undefined ? [] : stage.nodes;
    if (!Array.isArray(nodes)) throw new Error(`步骤 ${stage.id} 的 nodes 须为节点 id 列表`);
    for (const id of nodes) {
      if (!node_ids.has(id)) throw new Error(`步骤 ${stage.id} 引用了不存在的节点：${id}`);
      if (placed.has(id)) throw new Error(`节点 ${id} 只能属于一个步骤`);
      placed.add(id);
    }
    return { id: stage.id, ...(label ? { label } : {}), nodes: [...nodes] };
  });
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
    const items = [...outgoing.get(id)].sort((left, right) => left.order - right.order || by_position(nodes.get(left.target), nodes.get(right.target)));
    for (const item of items) {
      if (state.get(item.target) === 'open') back.push({ source: id, target: item.target, key: item.key });
      else {
        forward.push({ source: id, target: item.target });
        if (!state.has(item.target)) walk(item.target);
      }
    }
    state.set(id, 'done');
  };
  walk(start_id);
  return { back, forward, state };
}

/**
 * Arrows of a canvas as the relay reads them, for drawing it: `loops` holds `edge_key(edge)` of each arrow going back,
 * and `layers` gives each node reached from the start its column (the longest forward path to it).
 */
export function flow_shape(flow) {
  try {
    const shape = normalize_flow(flow);
    const nodes = new Map(shape.nodes.map(node => [node.id, node]));
    const start = shape.nodes.find(node => node.type === 'start');
    if (!start) return { loops: new Set(), layers: new Map() };
    const outgoing = new Map(shape.nodes.map(node => [node.id, []]));
    for (const edge of shape.edges) {
      if (edge.source === edge.target || edge.target === start.id) continue;
      const source = nodes.get(edge.source);
      const order = source?.type === 'branch' ? Math.max(0, source.branches.findIndex(item => item.id === edge.branch)) : 0;
      outgoing.get(edge.source).push({ target: edge.target, key: edge_key(edge), order });
    }
    const { back, forward } = walk_edges(nodes, outgoing, start.id);
    const layers = new Map([[start.id, 0]]);
    // Forward arrows have no cycle, so relaxing them as many times as there are nodes settles every column.
    for (let round = 0; round < shape.nodes.length; round++) {
      for (const edge of forward) if (layers.has(edge.source)) layers.set(edge.target, Math.max(layers.get(edge.target) ?? 0, layers.get(edge.source) + 1));
    }
    return { loops: new Set(back.map(edge => edge.key)), layers };
  } catch { return { loops: new Set(), layers: new Map() }; }
}

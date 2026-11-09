/**
 * A workflow's canvas (`flow.json`): member cards and host checkpoints joined by arrows, compiled into the host's
 * one-after-another dispatch: steps (a card, or cards working at once), and gates where the relay hands back to the host,
 * optionally looping over part of it. Plain JavaScript without Node modules: the web editor and the runner share it.
 *
 * Shape the program runs: from the start node, each layer is one step; cards in one layer work at once and must all come
 * from the same step and go to the same next one. A host node is a checkpoint after the step before it. An arrow back to an
 * earlier card makes a loop: the step it leaves (or the host node it leaves) becomes a checkpoint whose next pass starts at
 * that card, never reaching back past the checkpoint before it. No branching on conditions: put a host node there.
 */

export const FLOW_NODE_TYPES = ['start', 'card', 'host'];
export const MAX_FLOW_NODES = 60;
export const MAX_FLOW_EDGES = 120;
const NODE_ID = /^[A-Za-z0-9_-]{1,40}$/;

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
    return { id: node.id, type: node.type, ...(node.type === 'card' ? { card: node.card } : {}), x, y };
  });
  const seen = new Set();
  const edges = flow.edges.map(edge => {
    if (!edge || !ids.has(edge.source) || !ids.has(edge.target)) throw new Error('连线须连接画布上已有的节点');
    const key = `${edge.source}>${edge.target}`;
    if (seen.has(key)) throw new Error('两个节点之间只能有一条同向连线');
    seen.add(key);
    return { source: edge.source, target: edge.target };
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

/**
 * Compile a flow over the given card IDs (`labels` names them in errors): `{ steps: [[card…]…], gates: [{after, repeat_from}], errors: [text…], empty }`.
 * Step and gate positions are step indexes. Any error leaves steps and gates out.
 */
export function compile_flow(flow, cards = [], labels = {}) {
  let shape;
  try { shape = normalize_flow(flow || empty_flow()); }
  catch (error) { return { steps: [], gates: [], errors: [error.message], empty: false }; }
  const errors = [];
  const nodes = new Map(shape.nodes.map(node => [node.id, node]));
  const starts = shape.nodes.filter(node => node.type === 'start');
  if (starts.length !== 1) return { steps: [], gates: [], errors: ['画布须有且只有一个开始节点'], empty: false };
  const start = starts[0];
  const used = shape.nodes.filter(node => node.type !== 'start');
  // Cards laid out with no arrow from the start yet are no relay at all, not a broken one.
  if (!used.length || !shape.edges.some(edge => edge.source === start.id)) return { steps: [], gates: [], errors: [], empty: true };
  const known = new Set(cards);
  const label = node => node.type === 'host' ? '主持人检查点' : node.type === 'start' ? '开始' : `卡片 ${labels[node.card] || node.card}`;
  const placed = new Set();
  for (const node of used) {
    if (node.type !== 'card') continue;
    if (!known.has(node.card)) errors.push(`画布引用了不存在的卡片 ${node.card}`);
    if (placed.has(node.card)) errors.push(`卡片 ${node.card} 在画布上出现了多次`);
    placed.add(node.card);
  }
  const outgoing = new Map(shape.nodes.map(node => [node.id, []]));
  for (const edge of shape.edges) {
    if (edge.source === edge.target) errors.push(`${label(nodes.get(edge.source))} 连向了自己`);
    else if (edge.target === start.id) errors.push('不能连回开始节点');
    else outgoing.get(edge.source).push(edge.target);
  }
  if (errors.length) return { steps: [], gates: [], errors, empty: false };

  const { back, forward, state } = walk_edges(nodes, outgoing, start.id);
  const unreached = used.filter(node => !state.has(node.id));
  if (unreached.length) return { steps: [], gates: [], errors: unreached.map(node => `${label(node)} 没有从开始节点连过来`), empty: false };

  const successors = id => new Set(forward.filter(edge => edge.source === id).map(edge => edge.target));
  const predecessors = id => new Set(forward.filter(edge => edge.target === id).map(edge => edge.source));
  const same = (left, right) => left.size === right.size && [...left].every(item => right.has(item));
  const steps = [], gates = [], step_of = new Map(), gate_node = new Map();
  let layer = [start.id];
  while (true) {
    const next = new Set(layer.flatMap(id => [...successors(id)]));
    if (!next.size) break;
    const current = new Set(layer);
    if (layer.some(id => !same(successors(id), next))) {
      errors.push(`${layer.map(id => label(nodes.get(id))).join('、')} 须一起交给同一棒`);
      break;
    }
    const members = [...next].map(id => nodes.get(id)).sort(by_position);
    if (members.some(node => !same(predecessors(node.id), current))) {
      errors.push(`${members.map(label).join('、')} 须由同一棒交来`);
      break;
    }
    const hosts = members.filter(node => node.type === 'host');
    if (hosts.length) {
      if (members.length > 1) { errors.push('主持人检查点须单独一棒，不能与卡片并列'); break; }
      if (!steps.length) { errors.push('开始节点之后须先接卡片，主持人本来就在开始处派活'); break; }
      if (gate_node.has(steps.length - 1)) { errors.push('两个主持人检查点不能相连'); break; }
      gate_node.set(steps.length - 1, hosts[0].id);
    } else {
      members.forEach(node => step_of.set(node.id, steps.length));
      steps.push(members.map(node => node.card));
    }
    layer = members.map(node => node.id);
  }
  if (errors.length) return { steps: [], gates: [], errors, empty: false };
  if (steps.flat().length < 2) return { steps: [], gates: [], errors: ['流程至少要有两位成员接力'], empty: false };

  const gate_of_node = new Map([...gate_node].map(([after, id]) => [id, after]));
  const loops = new Map();
  for (const edge of back) {
    const target = nodes.get(edge.target);
    if (target.type !== 'card') { errors.push('循环的回连须指向一张卡片'); continue; }
    const after = step_of.has(edge.source) ? step_of.get(edge.source) : gate_of_node.get(edge.source);
    const from = step_of.get(edge.target);
    if (loops.has(after) && loops.get(after) !== from) errors.push(`第 ${after + 1} 棒之后只能回到一个起点`);
    loops.set(after, from);
  }
  for (const after of new Set([...gate_node.keys(), ...loops.keys()])) {
    // A plain checkpoint after the last step changes nothing: the relay hands back there anyway.
    if (!loops.has(after) && after === steps.length - 1) continue;
    gates.push({ after, repeat_from: loops.has(after) ? loops.get(after) : null });
  }
  gates.sort((left, right) => left.after - right.after);
  gates.forEach((gate, index) => {
    const floor = index ? gates[index - 1].after + 1 : 0;
    if (gate.repeat_from !== null && gate.repeat_from < floor) errors.push(`第 ${gate.after + 1} 棒之后的循环跨过了前一个检查点`);
  });
  return errors.length ? { steps: [], gates: [], errors, empty: false } : { steps, gates, errors: [], empty: false };
}

/** Quote a member handle for a shell command line when it needs it. */
function quoted(value) {
  return /^[\w\u4e00-\u9fff.-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * The dispatch a compiled flow becomes for the room's members: `{ to, parallel, gates }` for the API and the CLI flags.
 * `member_of` maps a card ID to the member handle the host names it by; a card without a member is listed in `missing`.
 */
export function flow_dispatch(compiled, member_of) {
  const missing = compiled.steps.flat().filter(card => !member_of[card]);
  if (compiled.errors.length || compiled.empty || missing.length) return { missing };
  const steps = compiled.steps.map(step => step.map(card => member_of[card]));
  const to = steps.flat();
  const parallel = steps.filter(step => step.length > 1);
  const gates = compiled.gates.map(gate => ({ after: steps[gate.after][0], ...(gate.repeat_from === null ? {} : { repeat_from: steps[gate.repeat_from][0] }) }));
  const flags = [...steps.flatMap(step => step.map((name, index) => `${index ? '--with' : '--to'} ${quoted(name)}`)), '--sequential',
    ...gates.map(gate => gate.repeat_from ? `--repeat ${quoted(`${gate.after}=${gate.repeat_from}`)}` : `--checkpoint ${quoted(gate.after)}`)];
  return { missing, to, ...(parallel.length ? { parallel } : {}), ...(gates.length ? { gates } : {}), cli: flags.join(' '),
    order: steps.map((step, index) => {
      const gate = gates.find(item => item.after === step[0]);
      const tail = !gate ? '' : gate.repeat_from ? `（之后检查点：可从 ${gate.repeat_from} 再来一圈）` : '（之后交回主持人）';
      return `${index + 1}. ${step.join(' + ')}${tail}`;
    }) };
}

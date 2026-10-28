/**
 * Layout for the execution timeline page, from the website's timeline read: rows nested by who dispatched whom, each
 * execution's stages in epoch milliseconds, and a time axis on which long idle stretches fold into labelled bands.
 * Pure functions, so the page and the tests share them.
 */

export const PHASE_LABELS = { thinking: "思考", command: "命令", tool: "工具", editing: "编辑", writing: "撰写" };
export const STATE_LABELS = { running: "进行中", done: "完成", failed: "失败", cancelled: "已撤销" };
/** Idle stretches longer than this fold into a band; each band takes this share of the axis. */
export const FOLD_GAP_MS = 5 * 60_000;
export const FOLD_SHARE = 0.03;

/** 820ms, 6.9s, 42s, 3m 05s, 2h 05m: the precision a reader compares at each scale. */
export function format_duration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, "0")}m`;
}

/**
 * One execution's stages. Queue runs from the request to delivery and wake from delivery to the first sign of work:
 * the discussion's enter, else a free execution's first recorded segment (approximate). Without either, the time after
 * delivery is all work and wake is absent. An execution still running ends at `now_ms`.
 */
export function execution_stages(item, now_ms) {
  const end = item.finished_at ? item.finished_at * 1000 : now_ms;
  const dispatched = item.dispatched_at ? item.dispatched_at * 1000 : 0;
  const queued = Math.min(item.queued_at ? item.queued_at * 1000 : dispatched || end, dispatched || end);
  const segments = dispatched ? item.segments.map((segment) => ({
    phase: segment.phase, tool: segment.tool,
    start: Math.min(dispatched + segment.start_ms, end), end: Math.min(dispatched + segment.end_ms, end),
  })) : [];
  const entered = item.started_at ? item.started_at * 1000 : segments[0]?.start ?? 0;
  const work_start = dispatched ? Math.max(dispatched, Math.min(entered || dispatched, end)) : end;
  return {
    start: queued, end, queue: [queued, dispatched || end],
    wake: dispatched && work_start > dispatched ? [dispatched, work_start] : null,
    work: dispatched ? [work_start, end] : null,
    wake_approx: !item.started_at, segments,
  };
}

/** Rows in time order with each free execution under the one that dispatched it; a parent outside the list makes a root. */
export function timeline_rows(timeline, now_ms) {
  const rows = timeline.executions.map((item) => ({
    key: `${item.source}:${item.id}`, parent: item.parent_id ? `free:${item.parent_id}` : "", item,
    truncated: item.segments.length >= timeline.segment_limit, ...execution_stages(item, now_ms),
  }));
  const keys = new Set(rows.map((row) => row.key));
  const children = new Map();
  for (const row of rows) {
    const parent = keys.has(row.parent) && row.parent !== row.key ? row.parent : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(row);
  }
  const ordered = [];
  const seen = new Set();
  const visit = (parent, depth, ancestors) => {
    for (const row of (children.get(parent) || []).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      ordered.push({ ...row, depth, ancestors, has_children: Boolean(children.get(row.key)?.length) });
      visit(row.key, depth + 1, [...ancestors, row.key]);
    }
  };
  visit("", 0, []);
  // A cycle leaves its members unvisited; they still show, at the top level.
  for (const row of rows) if (!seen.has(row.key)) ordered.push({ ...row, depth: 0, ancestors: [], has_children: false });
  return ordered;
}

/**
 * The axis: busy stretches keep their length and idle stretches longer than FOLD_GAP_MS fold into bands, so a room
 * used over several days still reads. `x(t)` maps a time to a fraction of the width; `folds` are the bands.
 */
export function timeline_axis(rows) {
  const spans = rows.map((row) => [row.start, row.end]).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return { start: 0, end: 0, busy_ms: 0, folds: [], x: () => 0 };
  const busy = [];
  for (const [start, end] of spans) {
    const last = busy.at(-1);
    if (last && start <= last[1] + FOLD_GAP_MS) last[1] = Math.max(last[1], end);
    else busy.push([start, end]);
  }
  const busy_ms = busy.reduce((sum, [start, end]) => sum + (end - start), 0);
  const fold_share = Math.min(FOLD_SHARE, 0.5 / Math.max(1, busy.length - 1));
  const scale = busy_ms ? (1 - fold_share * (busy.length - 1)) / busy_ms : 0;
  const pieces = [];
  let offset = 0;
  busy.forEach(([start, end], index) => {
    if (index) {
      const gap_start = busy[index - 1][1];
      pieces.push({ start: gap_start, end: start, from: offset, width: fold_share, fold: true });
      offset += fold_share;
    }
    const width = busy_ms ? (end - start) * scale : 1 / busy.length;
    pieces.push({ start, end, from: offset, width, fold: false });
    offset += width;
  });
  const x = (time) => {
    const piece = pieces.find((item) => time <= item.end) || pieces.at(-1);
    if (time <= piece.start) return piece.from;
    return piece.from + (piece.end > piece.start ? Math.min(1, (time - piece.start) / (piece.end - piece.start)) * piece.width : 0);
  };
  return { start: busy[0][0], end: busy.at(-1)[1], busy_ms, x,
    folds: pieces.filter((piece) => piece.fold).map(({ start, end, from, width }) => ({ start, end, from, width })) };
}

/** Counts for the summary and the step a reader should look at first: the longest recorded phase segment. */
export function timeline_summary(rows) {
  let slowest = null;
  for (const row of rows) {
    for (const segment of row.segments) {
      if (!slowest || segment.end - segment.start > slowest.end - slowest.start) slowest = { ...segment, row: row.key, member: row.item.member };
    }
  }
  return {
    executions: rows.length,
    running: rows.filter((row) => row.item.state === "running").length,
    failed: rows.filter((row) => row.item.state === "failed").length,
    // Consecutive calls of one tool merge into one segment, so this counts segments, not calls.
    tool_segments: rows.reduce((sum, row) => sum + row.segments.filter((segment) => ["command", "tool", "editing"].includes(segment.phase)).length, 0),
    slowest,
  };
}

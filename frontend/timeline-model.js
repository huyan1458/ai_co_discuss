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
 * delivery is all work and wake is absent. An execution still running ends at `now_ms`, and so does its last segment:
 * the phase it was last seen in is shown as lasting until the next report says otherwise (`live`). Progress notes are
 * placed when the website received them, within the execution.
 */
export function execution_stages(item, now_ms) {
  const running = item.state === "running";
  const end = item.finished_at ? item.finished_at * 1000 : now_ms;
  const dispatched = item.dispatched_at ? item.dispatched_at * 1000 : 0;
  const queued = Math.min(item.queued_at ? item.queued_at * 1000 : dispatched || end, dispatched || end);
  // `seen` is where output was last seen; past it a live segment is only assumed to go on, and is drawn as a faint tail.
  const segments = dispatched ? item.segments.map((segment, index) => {
    const live = running && index === item.segments.length - 1;
    const seen = Math.min(dispatched + segment.end_ms, end);
    return { phase: segment.phase, tool: segment.tool, live, seen, start: Math.min(dispatched + segment.start_ms, end), end: live ? end : seen };
  }) : [];
  const entered = item.started_at ? item.started_at * 1000 : segments[0]?.start ?? 0;
  const work_start = dispatched ? Math.max(dispatched, Math.min(entered || dispatched, end)) : end;
  const notes = dispatched ? (item.notes || []).map((at, index) => ({ index, at: Math.min(Math.max(at * 1000, dispatched), end) })) : [];
  return {
    start: queued, end, queue: [queued, dispatched || end],
    wake: dispatched && work_start > dispatched ? [dispatched, work_start] : null,
    work: dispatched ? [work_start, end] : null,
    wake_approx: !item.started_at, segments, notes,
  };
}

/** No output for this long marks a running execution as possibly stuck, as the message page's working card does. */
export const STALL_MS = 3 * 60_000;

/**
 * The line under a row's name, so the timeline reads without hovering: what a running execution last said (else its
 * phase), that it may be stuck, why it failed, or what it answered. `tone` is live, warn, failed, done or muted.
 * Output is known from the runner's last report, segment or note; with none (an App or manual member) nothing is
 * called stuck, since silence there says nothing.
 */
export function row_status(row, now_ms) {
  const { item } = row;
  if (item.state === "failed") return { tone: "failed", text: item.reason || "执行失败" };
  if (item.state === "cancelled") return { tone: "muted", text: "已撤销" };
  if (item.state === "done") {
    const changes = item.changes ? ` · 改动 ${item.changes} 个文件` : "";
    return { tone: "done", text: `${item.result || "已完成"}${changes}` };
  }
  if (!item.dispatched_at) return { tone: "muted", text: "排队中" };
  const dispatched = item.dispatched_at * 1000;
  const last_segment = item.segments.at(-1);
  const last_output = Math.max(item.activity_at ? item.activity_at * 1000 : 0,
    last_segment ? dispatched + last_segment.end_ms : 0, ...(item.notes || []).map((at) => at * 1000));
  const silent = last_output ? now_ms - last_output : 0;
  if (silent >= STALL_MS) {
    // A long command prints nothing while it runs; that is not a stall.
    return last_segment?.phase === "command" ? { tone: "warn", text: `命令已运行 ${format_duration(silent)}` }
      : { tone: "warn", text: `已 ${format_duration(silent)} 无输出，可能卡住` };
  }
  if (item.last_note) return { tone: "live", text: item.last_note };
  if (last_segment) return { tone: "live", text: `${PHASE_LABELS[last_segment.phase]}${last_segment.tool ? ` · ${last_segment.tool}` : ""}中` };
  return { tone: "live", text: "处理中" };
}

/**
 * One execution's story in time order for its detail: each phase segment and each progress note, so a reader follows
 * what the agent did and said. Note texts come separately and may still be loading.
 */
export function execution_log(row, texts) {
  const entries = [
    ...row.segments.map((segment) => ({ at: segment.start, kind: "phase", phase: segment.phase, tool: segment.tool, duration: segment.end - segment.start, live: segment.live })),
    ...row.notes.map((note) => ({ at: note.at, kind: "note", text: texts?.[note.index] ?? (texts ? "（未能读取）" : "读取中…") })),
  ];
  return entries.sort((a, b) => a.at - b.at || (a.kind === "note") - (b.kind === "note"));
}

/**
 * The progress notes that belong to a moment between `start` and `end`: those received within it, else the latest one
 * received before it, marked `earlier`, since a note usually explains what the agent goes on to do.
 */
export function notes_between(notes, start, end) {
  const within = notes.filter((note) => note.at >= start && note.at <= end);
  if (within.length) return { notes: within, earlier: false };
  const before = notes.filter((note) => note.at < start).at(-1);
  return { notes: before ? [before] : [], earlier: Boolean(before) };
}

/**
 * Rows in time order with each free execution under the one that dispatched it; a parent outside the list makes a root.
 * A member continuing its own earlier execution, such as the host summing up a round it dispatched, sits beside that
 * execution rather than under it, so a long chain reads as rounds one after another instead of a deepening staircase.
 */
export function timeline_rows(timeline, now_ms) {
  const rows = timeline.executions.map((item) => ({
    key: `${item.source}:${item.id}`, parent: item.parent_id ? `free:${item.parent_id}` : "", item,
    truncated: item.segments.length >= timeline.segment_limit, ...execution_stages(item, now_ms),
  }));
  const by_key = new Map(rows.map((row) => [row.key, row]));
  const placed_under = (row) => {
    let parent = by_key.get(row.parent);
    for (const seen = new Set([row.key]); parent?.item.member === row.item.member && !seen.has(parent.key); parent = by_key.get(parent.parent)) {
      seen.add(parent.key);
    }
    return parent && parent.key !== row.key && parent.item.member !== row.item.member ? parent.key : "";
  };
  const children = new Map();
  for (const row of rows) {
    const parent = placed_under(row);
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
    spans: pieces.filter((piece) => !piece.fold).map(({ start, end, from, width }) => ({ start, end, from, width })),
    folds: pieces.filter((piece) => piece.fold).map(({ start, end, from, width }) => ({ start, end, from, width })) };
}

/** Round clock steps an axis may tick at, from a second to a day. */
const TICK_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400].map((seconds) => seconds * 1000);
/** Ticks closer than this share of the width are dropped, so labels never overlap. */
const MIN_TICK_GAP = 0.12;

/**
 * Clock ticks for the axis: round times (22:18:30, 22:20) inside the shown stretches, about `count` across the busy
 * time and none inside a folded idle band. Times of day rather than offsets, since a room's work spans days.
 * `seconds` says whether the labels need seconds.
 */
export function axis_ticks(axis, count = 6) {
  if (!axis.busy_ms) return [];
  const step = TICK_STEPS_MS.find((ms) => axis.busy_ms / ms <= count) ?? TICK_STEPS_MS.at(-1);
  const ticks = [];
  for (const span of axis.spans) {
    for (let at = Math.ceil(span.start / step) * step; at <= span.end; at += step) {
      const x = axis.x(at);
      if (!ticks.length || x - ticks.at(-1).x >= MIN_TICK_GAP) ticks.push({ at, x });
    }
  }
  return ticks.map((tick) => ({ ...tick, seconds: step < 60_000 }));
}

/** Counts for the summary and the step a reader should look at first: the longest recorded phase segment. */
export function timeline_summary(rows, now_ms = Date.now()) {
  // Only recorded time counts: a live segment's assumed tail would make a stuck execution look like the slowest step.
  let slowest = null;
  for (const row of rows) {
    for (const segment of row.segments) {
      if (!slowest || segment.seen - segment.start > slowest.end - slowest.start) slowest = { ...segment, end: segment.seen, row: row.key, member: row.item.member };
    }
  }
  return {
    executions: rows.length,
    running: rows.filter((row) => row.item.state === "running").length,
    failed: rows.filter((row) => row.item.state === "failed").length,
    stalled: rows.filter((row) => row.item.state === "running" && row_status(row, now_ms).tone === "warn").length,
    // Consecutive calls of one tool merge into one segment, so this counts segments, not calls.
    tool_segments: rows.reduce((sum, row) => sum + row.segments.filter((segment) => ["command", "tool", "editing"].includes(segment.phase)).length, 0),
    slowest,
  };
}

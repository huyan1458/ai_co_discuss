/**
 * Layout for the execution timeline page, from the website's timeline read: rows nested by who dispatched whom, each
 * execution's stages in epoch milliseconds, and a time axis on which long idle stretches fold into labelled bands.
 * Pure functions, so the page and the tests share them.
 */

export const PHASE_LABELS = { thinking: "思考", command: "命令", tool: "工具", editing: "编辑", writing: "撰写" };
/** Bars are colored by member and shaded by kind, as in a trace: the model's own turns dark, its tool work light. */
export const PHASE_KINDS = { thinking: "model", writing: "model", command: "tool", tool: "tool", editing: "tool" };
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
 * The timeline as it stood at `at_ms`, for replay: what had not been requested yet is gone, what had not finished is
 * running, and every phase, note and output is cut at that moment. A replay is then drawn exactly as live work is, with
 * `at_ms` as now. `texts` (execution id → note texts) names what each was last saying; results stay hidden until the end.
 */
export function snapshot_at(timeline, at_ms, texts = new Map()) {
  const at = at_ms / 1000;
  const executions = [];
  for (const item of timeline.executions) {
    if ((item.queued_at || item.dispatched_at || Infinity) > at) continue;
    if (item.finished_at && item.finished_at <= at) { executions.push(item); continue; }
    const dispatched = item.dispatched_at && item.dispatched_at <= at ? item.dispatched_at : 0;
    const elapsed_ms = dispatched ? (at - dispatched) * 1000 : 0;
    const notes = (item.notes || []).filter((time) => time <= at);
    executions.push({ ...item, state: "running", status: "started", finished_at: 0, dispatched_at: dispatched,
      started_at: item.started_at && item.started_at <= at ? item.started_at : 0,
      segments: dispatched ? item.segments.filter((segment) => segment.start_ms <= elapsed_ms)
        .map((segment) => ({ ...segment, end_ms: Math.min(segment.end_ms, elapsed_ms) })) : [],
      notes, last_note: notes.length ? texts.get(item.id)?.[notes.length - 1] ?? null : null,
      activity_at: item.activity_at && item.activity_at <= at ? item.activity_at : 0,
      reason: "", result: null, answer_id: null, changes: null });
  }
  return { ...timeline, executions };
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
      ordered.push({ ...row, depth, ancestors, placed_parent: parent, has_children: Boolean(children.get(row.key)?.length) });
      visit(row.key, depth + 1, [...ancestors, row.key]);
    }
  };
  visit("", 0, []);
  // A cycle leaves its members unvisited; they still show, at the top level.
  for (const row of rows) if (!seen.has(row.key)) ordered.push({ ...row, depth: 0, ancestors: [], placed_parent: "", has_children: false });
  return ordered;
}

/**
 * The run an execution belongs to, as a trace is one agent run: a free execution's run is the request that started its
 * chain (the task of the execution at the top of its dispatch tree), so every hand-off and summary of one user message
 * reads as one trace; a discussion execution's run is its discussion run.
 */
export function run_key(item, by_id) {
  if (item.source === "discussion") return `run:${item.run_id || item.id}`;
  let root = item;
  for (const seen = new Set([item.id]); root.parent_id && by_id.has(root.parent_id) && !seen.has(root.parent_id); root = by_id.get(root.parent_id)) {
    seen.add(root.parent_id);
  }
  return root.task_id ? `task:${root.task_id}` : `exec:${root.id}`;
}

/**
 * The runs on the timeline, newest first: what started each (its opening request or discussion question), when it ran,
 * how many executions it took and whether any is still running or failed. `key` of each execution is in `runs.of`.
 */
export function timeline_runs(timeline, now_ms) {
  const free = new Map(timeline.executions.filter((item) => item.source === "free").map((item) => [item.id, item]));
  const runs = new Map();
  const of = new Map();
  for (const item of timeline.executions) {
    const key = run_key(item, free);
    of.set(`${item.source}:${item.id}`, key);
    const stages = execution_stages(item, now_ms);
    const run = runs.get(key) || { key, source: item.source, start: stages.start, end: stages.end, count: 0, running: false, failed: false, task: "", first: Infinity };
    run.start = Math.min(run.start, stages.start);
    run.end = Math.max(run.end, stages.end);
    run.count += 1;
    run.running ||= item.state === "running";
    run.failed ||= item.state === "failed";
    // The opening request names the run: the task of its earliest execution that has one.
    if (item.task && stages.start < run.first) { run.task = item.task; run.first = stages.start; }
    runs.set(key, run);
  }
  return { list: [...runs.values()].sort((a, b) => b.start - a.start), of };
}

/**
 * Hand-off lines, one per dispatched execution whose dispatcher is shown above it: from the dispatcher's bar at the
 * moment of dispatch (the request's time) straight down to the dispatched row. Returns, per row key, the pieces that
 * row draws: `start` (a dot on the dispatcher's bar and the line leaving it), `through` (rows in between) and `end`
 * (the elbow into the dispatched bar), each at fraction `x` and named by the dispatched member.
 */
export function handoff_lines(rows, axis) {
  const index = new Map(rows.map((row, position) => [row.key, position]));
  const pieces = new Map();
  const add = (key, piece) => { if (!pieces.has(key)) pieces.set(key, []); pieces.get(key).push(piece); };
  rows.forEach((row, position) => {
    const from = index.get(row.placed_parent);
    if (from === undefined || from >= position) return;
    const x = axis.x(row.queue[0]);
    const member = row.item.member;
    add(rows[from].key, { x, part: "start", member });
    for (let between = from + 1; between < position; between += 1) add(rows[between].key, { x, part: "through", member });
    add(row.key, { x, part: "end", member, to: axis.x(row.queue[1] > row.queue[0] ? row.queue[0] : row.start) });
  });
  return pieces;
}

/**
 * Totals a live axis may show, so it rescales in round steps rather than every frame. Neighbours differ by at most
 * 1.25×, so crossing a step never drops work below LIVE_FILL / 1.25 (60%) of the width.
 */
const LIVE_TOTALS_MS = [5, 6, 7, 8, 10, 12, 15, 18, 20, 24, 30, 36, 45, 50, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360,
  420, 480, 600, 720, 900, 1080, 1200, 1500, 1800, 2100, 2400, 3000, 3600, 4500, 5400, 6300, 7200, 9000, 10800, 12600, 14400,
  18000, 21600, 25200, 28800, 36000, 43200, 54000, 64800, 72000, 86400].map((seconds) => seconds * 1000);
/** While work runs, it fills at most this share of the axis; the rest is room for it to grow into. */
const LIVE_FILL = 0.75;

/**
 * The axis: busy stretches keep their length and idle stretches longer than FOLD_GAP_MS fold into bands, so a room
 * used over several days still reads. `x(t)` maps a time to a fraction of the width; `folds` are the bands. While work
 * runs (`live`), the last stretch runs on past now to the next round total, so bars grow into free room and the axis
 * rescales only now and then.
 */
export function timeline_axis(rows, live = false) {
  const spans = rows.map((row) => [row.start, row.end]).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return { start: 0, end: 0, busy_ms: 0, folds: [], spans: [], x: () => 0 };
  const busy = [];
  for (const [start, end] of spans) {
    const last = busy.at(-1);
    if (last && start <= last[1] + FOLD_GAP_MS) last[1] = Math.max(last[1], end);
    else busy.push([start, end]);
  }
  // `busy_ms` is the time work actually took; `total_ms` is what the axis shows, the room ahead of live work included.
  const busy_ms = busy.reduce((sum, [start, end]) => sum + (end - start), 0);
  let total_ms = busy_ms;
  if (live && busy_ms) {
    total_ms = LIVE_TOTALS_MS.find((ms) => ms >= busy_ms / LIVE_FILL) ?? Math.ceil(busy_ms / LIVE_FILL);
    busy.at(-1)[1] += total_ms - busy_ms;
  }
  const fold_share = Math.min(FOLD_SHARE, 0.5 / Math.max(1, busy.length - 1));
  const scale = total_ms ? (1 - fold_share * (busy.length - 1)) / total_ms : 0;
  const pieces = [];
  let offset = 0;
  busy.forEach(([start, end], index) => {
    if (index) {
      const gap_start = busy[index - 1][1];
      pieces.push({ start: gap_start, end: start, from: offset, width: fold_share, fold: true });
      offset += fold_share;
    }
    const width = total_ms ? (end - start) * scale : 1 / busy.length;
    pieces.push({ start, end, from: offset, width, fold: false });
    offset += width;
  });
  const x = (time) => {
    const piece = pieces.find((item) => time <= item.end) || pieces.at(-1);
    if (time <= piece.start) return piece.from;
    return piece.from + (piece.end > piece.start ? Math.min(1, (time - piece.start) / (piece.end - piece.start)) * piece.width : 0);
  };
  return { start: busy[0][0], end: busy.at(-1)[1], busy_ms, total_ms, x,
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
export function axis_ticks(axis, count = 6, window = { from: 0, span: 1 }) {
  const shown_ms = (axis.total_ms ?? axis.busy_ms) * window.span;
  if (!shown_ms) return [];
  // Zoomed in, the same number of ticks covers less time, so they fall at finer steps; only those in view are made.
  const step = TICK_STEPS_MS.find((ms) => shown_ms / ms <= count) ?? TICK_STEPS_MS.at(-1);
  const gap = MIN_TICK_GAP * window.span;
  const ticks = [];
  for (const span of axis.spans) {
    if (span.from + span.width < window.from || span.from > window.from + window.span) continue;
    for (let at = Math.ceil(span.start / step) * step; at <= span.end; at += step) {
      const x = axis.x(at);
      if (x < window.from || x > window.from + window.span) continue;
      if (!ticks.length || x - ticks.at(-1).x >= gap) ticks.push({ at, x });
    }
  }
  return ticks.map((tick) => ({ ...tick, seconds: step < 60_000 }));
}

/** Zooming never shows less than this share of the axis, nor less time than this. */
export const MIN_VIEW_SPAN = 0.01;
export const MIN_VIEW_MS = 2000;

/**
 * The axis as seen through a zoom window (`from` and `span` are shares of the whole axis): positions are mapped so the
 * window fills the width, and what lies outside falls below 0 or past 1, for the track to clip.
 */
export function view_axis(axis, window) {
  const map = (fraction) => (fraction - window.from) / window.span;
  return { ...axis, x: (time) => map(axis.x(time)),
    spans: axis.spans.map((span) => ({ ...span, from: map(span.from), width: span.width / window.span })),
    folds: axis.folds.map((fold) => ({ ...fold, from: map(fold.from), width: fold.width / window.span })) };
}

/**
 * The window after zooming by `factor` (below 1 zooms in) around `anchor`, a point of the current view (0 left, 1 right),
 * which stays under the pointer; kept within the axis and no narrower than the limits above.
 */
export function zoom_window(window, anchor, factor, total_ms = 0) {
  const narrowest = Math.max(MIN_VIEW_SPAN, total_ms ? MIN_VIEW_MS / total_ms : 0);
  const span = Math.min(1, Math.max(narrowest, window.span * factor));
  const at = window.from + anchor * window.span;
  return { from: Math.min(1 - span, Math.max(0, at - anchor * span)), span };
}

/** The window moved by `delta` shares of the view (positive moves later in time), kept within the axis. */
export function pan_window(window, delta) {
  return { from: Math.min(1 - window.span, Math.max(0, window.from + delta * window.span)), span: window.span };
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

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
/** Thinking reports nothing until it ends, so a silent thinking phase is called stuck only after this long. */
export const THINKING_STALL_MS = 10 * 60_000;

/** A wait (request to first sign of work) at least this long is marked on the bar and in the round's digest. */
export const WAIT_WARN_MS = 2 * 60_000;

/**
 * Where one execution's time went: the wait from the request to the first sign of work (queue and wake), each phase's
 * recorded time (a live phase's assumed tail is left out) and the work with no phase detail. `phases` is sorted longest
 * first.
 */
export function row_breakdown(row) {
  const work_start = row.work ? row.work[0] : row.end;
  const totals = new Map();
  for (const segment of row.segments) totals.set(segment.phase, (totals.get(segment.phase) || 0) + Math.max(0, segment.seen - segment.start));
  return {
    wait: Math.max(0, work_start - row.queue[0]),
    work: row.work ? row.work[1] - row.work[0] : 0,
    phases: [...totals].map(([phase, ms]) => ({ phase, ms })).sort((a, b) => b.ms - a.ms),
  };
}
/**
 * A row's time by kind, for a bar that shows proportions rather than order: waiting, the model's own turns, tool work,
 * and the rest of the work that no phase report covers (no detail, or a live phase past its last output).
 */
export function row_mix(row) {
  const { wait, work, phases } = row_breakdown(row);
  const by_kind = (kind) => phases.filter((part) => PHASE_KINDS[part.phase] === kind).reduce((sum, part) => sum + part.ms, 0);
  const model = by_kind("model");
  const tool = by_kind("tool");
  return { wait, model, tool, other: Math.max(0, work - model - tool) };
}
/** Phases shorter than this are left out of a row's line, and so is a shorter wait. */
const LINE_MIN_MS = 1000;
const LINE_MIN_WAIT_MS = 10_000;
const LINE_PHASES = 3;

/**
 * The line under a row's name, about time rather than content (what was said lives on the message page): where a
 * finished execution's time went, how long a running one has gone without output and whether it may be stuck, or why
 * one failed. `tone` is live, warn, failed, done or muted. Output is known from the runner's last report, segment or
 * note; with none (an App or manual member) nothing is called stuck, since silence there says nothing.
 */
export function row_status(row, now_ms) {
  const { item } = row;
  if (item.source === "user") return { tone: "done", text: row.end > row.start ? `阅读与思考 ${format_duration(row.end - row.start)}` : "发出消息" };
  if (item.state === "failed") return { tone: "failed", text: `失败：${item.reason || "执行失败"}` };
  if (item.state === "cancelled") return { tone: "muted", text: "已撤销" };
  if (item.state === "done") {
    const { wait, work, phases } = row_breakdown(row);
    const parts = phases.filter((part) => part.ms >= LINE_MIN_MS).slice(0, LINE_PHASES).map((part) => `${PHASE_LABELS[part.phase]} ${format_duration(part.ms)}`);
    if (!parts.length) parts.push(`执行 ${format_duration(work)}${row.segments.length ? "" : "（无阶段明细）"}`);
    if (wait >= LINE_MIN_WAIT_MS) parts.push(`等待 ${format_duration(wait)}`);
    return { tone: "done", text: parts.join(" · ") };
  }
  if (!item.dispatched_at) return { tone: "muted", text: `排队中 · 已 ${format_duration(now_ms - row.queue[0])}` };
  const dispatched = item.dispatched_at * 1000;
  const last_segment = item.segments.at(-1);
  const last_output = Math.max(item.activity_at ? item.activity_at * 1000 : 0,
    last_segment ? dispatched + last_segment.end_ms : 0, ...(item.notes || []).map((at) => at * 1000));
  if (!last_output) return { tone: "live", text: "处理中 · 这种接入方式不上报进度" };
  const silent = Math.max(0, now_ms - last_output);
  const phase = last_segment ? `${PHASE_LABELS[last_segment.phase]}${last_segment.tool ? ` ${last_segment.tool}` : ""}中` : "处理中";
  if (silent >= STALL_MS) {
    // A long command prints nothing while it runs; that is not a stall.
    if (last_segment?.phase === "command") return { tone: "warn", text: `${phase} · 命令已运行 ${format_duration(silent)}` };
    if (last_segment?.phase === "thinking" && silent < THINKING_STALL_MS) return { tone: "live", text: `${phase} · 已 ${format_duration(silent)} 无中间输出` };
    return { tone: "warn", text: `可能卡住 · 已 ${format_duration(silent)} 无输出` };
  }
  return { tone: "live", text: `${phase} · 距上次输出 ${format_duration(silent)}` };
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
 * Rows in time order, at most two levels deep: each free execution under the one that dispatched it, or under that
 * one's own top-level row when the dispatcher is itself nested; a parent outside the list makes a root. A member
 * continuing its own earlier execution up its chain, as far back as the nearest top-level row, such as the host summing
 * up a round after a relay of members, sits beside that execution rather than under it, so a long chain reads as rounds
 * one after another instead of a deepening staircase. `dispatched_by` is the execution that dispatched the row (none
 * when it continues itself), which the hand-off line starts from.
 */
export function timeline_rows(timeline, now_ms) {
  const rows = timeline.executions.map((item) => ({
    key: `${item.source}:${item.id}`, parent: item.parent_id ? `free:${item.parent_id}` : "", item,
    truncated: item.segments.length >= timeline.segment_limit, ...execution_stages(item, now_ms),
  }));
  const by_key = new Map(rows.map((row) => [row.key, row]));
  const ancestors_of = (row) => {
    const list = [];
    for (let parent = by_key.get(row.parent), seen = new Set([row.key]); parent && !seen.has(parent.key); parent = by_key.get(parent.parent)) {
      seen.add(parent.key);
      list.push(parent);
    }
    return list;
  };
  const placement = new Map();
  const placing = new Set();
  // Where a row sits: "" (top level) or the key of a top-level row; a cycle leaves its rows to the fallback below.
  const placed_under = (row) => {
    if (placement.has(row.key)) return placement.get(row.key).under;
    if (placing.has(row.key)) return "";
    placing.add(row.key);
    const ancestors = ancestors_of(row);
    const dispatcher = ancestors[0];
    // The round's top-level row closes the search, so a member is never placed back in an earlier round.
    let earlier_self = null;
    for (const ancestor of ancestors) {
      if (ancestor.item.member === row.item.member) { earlier_self = ancestor; break; }
      if (!placed_under(ancestor)) break;
    }
    let under = "";
    if (earlier_self) under = placed_under(earlier_self);
    else if (dispatcher) under = placed_under(dispatcher) || dispatcher.key;
    if (under === row.key) under = "";
    placing.delete(row.key);
    placement.set(row.key, { under, dispatched_by: dispatcher && dispatcher.item.member !== row.item.member ? dispatcher.key : "" });
    return under;
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
    for (const row of (children.get(parent) || []).sort((a, b) => a.start - b.start || (b.item.source === "user") - (a.item.source === "user") || a.key.localeCompare(b.key))) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      ordered.push({ ...row, depth, ancestors, placed_parent: parent, dispatched_by: placement.get(row.key)?.dispatched_by || "", has_children: Boolean(children.get(row.key)?.length) });
      visit(row.key, depth + 1, [...ancestors, row.key]);
    }
  };
  visit("", 0, []);
  // A cycle leaves its members unvisited; they still show, at the top level.
  for (const row of rows) if (!seen.has(row.key)) ordered.push({ ...row, depth: 0, ancestors: [], placed_parent: "", dispatched_by: "", has_children: false });
  return ordered;
}

/** When an execution was asked for, in seconds: its request, else its delivery. */
export const requested_at = (item) => item.queued_at || item.dispatched_at || 0;

/**
 * The latest `count` executions by request time, plus the execution that dispatched any of them (and so on up), so a
 * hand-off is never cut in half. One continuous timeline needs no grouping: how much it shows is a count the reader
 * extends, and idle time folds on the axis.
 */
export function recent_window(executions, count) {
  const picked = new Set([...executions].sort((a, b) => requested_at(b) - requested_at(a)).slice(0, count));
  const free = new Map(executions.filter((item) => item.source === "free").map((item) => [item.id, item]));
  for (const item of [...picked]) {
    for (let parent = free.get(item.parent_id); parent && !picked.has(parent); parent = free.get(parent.parent_id)) picked.add(parent);
  }
  return executions.filter((item) => picked.has(item));
}

/**
 * The room cut into tasks, oldest first. A task starts only where the owner asked for something new while the room was
 * idle: an execution started by a message the owner wrote (`task_author` "用户") that no earlier execution answered, with
 * every execution requested before it already ended. Everything else joins the task in progress: the owner's
 * interjections while work runs, the host's dispatches and proactive posts, hand-backs, the program's wakes, Goal runs and
 * retries. No time threshold and no dispatch chain decide it.
 *
 * Each task: `key` (the execution that opened it), `opener` (that execution's item), `items` (each `{ item, stages }`),
 * `keys` (their row keys), `interjections` (the owner's messages that joined it while work ran: `key`, `task_id`, `task`,
 * `at`), and `opened` (false for the first task when it does not begin at an owner's message, as when older executions
 * were not loaded).
 */
export function timeline_segments(executions, now_ms) {
  const ordered = executions.map((item) => ({ item, stages: execution_stages(item, now_ms) }))
    .sort((a, b) => a.stages.queue[0] - b.stages.queue[0] || a.item.id - b.item.id);
  const segments = [];
  const asked = new Set();
  let busy_until = -Infinity;
  for (const entry of ordered) {
    const { item, stages } = entry;
    const key = `${item.source}:${item.id}`;
    const new_ask = item.task_author === "用户" && item.task_id != null && !asked.has(item.task_id);
    if (!segments.length || (new_ask && stages.queue[0] >= busy_until)) {
      segments.push({ key, opener: item, opened: new_ask, items: [], keys: new Set(), interjections: [] });
    } else if (new_ask) {
      segments.at(-1).interjections.push({ key, task_id: item.task_id, task: item.task || "", at: stages.queue[0] });
    }
    const segment = segments.at(-1);
    segment.items.push(entry);
    segment.keys.add(key);
    if (item.task_id != null) asked.add(item.task_id);
    busy_until = Math.max(busy_until, stages.end);
  }
  return segments;
}

/** The owner as a member of the timeline: rows named this, drawn from the owner's messages rather than executions. */
export const USER_MEMBER = "用户";
export const is_user_row = (row) => row.item.source === "user";

/**
 * Put the owner on the timeline (2026-11-11 user's choice): each task gains a row for the owner, its bar the time from
 * the room handing back (the previous task's end) to the message that opened this task, the owner reading, thinking
 * and checking; the first task, with nothing handed back before it, gets only the moment. Each interjection is a
 * moment too. Rows are built from the tasks' own records, so no extra read is needed. Each segment gains `users` (the
 * owner items) and has them in `items` and `keys`.
 */
export function add_user_turns(segments, now_ms) {
  let handed_back = 0;
  return segments.map((segment) => {
    const moment = (task_id, task, at, from = at) => ({ source: "user", id: task_id, member: USER_MEMBER, role: "user", state: "done", parent_id: null,
      queued_at: from / 1000, dispatched_at: from / 1000, started_at: from / 1000, finished_at: at / 1000, segments: [], notes: [],
      task, task_id, task_author: USER_MEMBER });
    const users = [];
    if (segment.opened && segment.opener.task_id != null) {
      const at = execution_stages(segment.opener, now_ms).queue[0];
      users.push(moment(segment.opener.task_id, segment.opener.task || "", at, handed_back && handed_back < at ? handed_back : at));
    }
    for (const aside of segment.interjections) if (aside.task_id != null) users.push({ ...moment(aside.task_id, aside.task, aside.at), aside: true });
    const entries = users.map((item) => ({ item, stages: execution_stages(item, now_ms) }));
    handed_back = Math.max(...segment.items.map(({ stages }) => stages.end));
    return { ...segment, users, items: [...entries, ...segment.items], keys: new Set([...users.map((item) => `user:${item.id}`), ...segment.keys]) };
  });
}

/**
 * The tasks as a list, newest first: what opened each (`task`, `task_id`, and the answer to it as `result`), when it began
 * and last ended, how many executions, who did the work and for how long (`work`, longest first; members working at once
 * each count), and how its time went in one sweep (`parts`, `wait`; see time_parts). Also whether any is still running
 * or failed, and how many interjections joined it. For the overview's unfolded task: `steps` (each execution in the order
 * it began: `key`, `member`, `role`, `state`, `ask` what it was asked, `reason` why it failed, `ms` its span), `outcome`
 * (the answer of the last execution to finish with one, as `member` and `text`) and `changes` (files changed in all).
 */
export function task_overview(segments) {
  return segments.map((segment) => {
    const work = new Map();
    for (const { item, stages } of segment.items) work.set(item.member, (work.get(item.member) || 0) + (stages.work ? stages.work[1] - stages.work[0] : 0));
    // The owner's time is named among the people; the task's span, count and bar are the room's work, so a night
    // between tasks does not stretch one.
    const runs = segment.items.filter(({ item }) => item.source !== "user");
    const steps = [...runs].sort((a, b) => a.stages.start - b.stages.start).map(({ item, stages }) => ({
      key: `${item.source}:${item.id}`, member: item.member, role: item.role, state: item.state,
      ask: item.task || "", reason: item.reason || "", ms: stages.end - stages.start }));
    const answered = runs.filter(({ item }) => item.state === "done" && item.result).sort((a, b) => b.stages.end - a.stages.end)[0];
    return {
      steps, outcome: answered ? { member: answered.item.member, text: answered.item.result } : null,
      changes: runs.reduce((sum, { item }) => sum + (item.changes || 0), 0),
      key: segment.key, opened: segment.opened, task: segment.opener.task || "", task_id: segment.opener.task_id || null,
      result: segment.opener.result || "", interjections: segment.interjections,
      start: Math.min(...runs.map(({ stages }) => stages.start)), end: Math.max(...runs.map(({ stages }) => stages.end)),
      count: runs.length,
      running: runs.some(({ item }) => item.state === "running"), failed: runs.some(({ item }) => item.state === "failed"),
      work: [...work].map(([member, ms]) => ({ member, ms })).filter((part) => part.ms > 0).sort((a, b) => b.ms - a.ms),
      ...time_parts(runs),
    };
  }).reverse();
}

/**
 * What the latest task came down to, for the sentence at the top, the replay and "最慢": the rows of the last task
 * (`keys`), their span (`start`, `end`, `total`), each member's work time (`members`, longest first), the time it stood
 * waiting with nobody at work (`wait`), and its slowest recorded phase. Running, failed and stalled counts cover every
 * row given, so live work elsewhere is never missed.
 */
export function task_digest(rows, keys, now_ms) {
  const running = rows.filter((row) => row.item.state === "running");
  const counts = { running, failed: rows.filter((row) => row.item.state === "failed").length,
    stalled: running.filter((row) => row_status(row, now_ms).tone === "warn").length };
  const task = rows.filter((row) => keys.has(row.key));
  // The task's span (and so its replay) is the room's work; the owner's time before it shows among the members.
  const work_rows = task.filter((row) => !is_user_row(row));
  if (!work_rows.length) return { ...counts, keys, start: 0, end: 0, total: 0, members: [], wait: 0, slowest: null };
  const start = Math.min(...work_rows.map((row) => row.start));
  const end = Math.max(...work_rows.map((row) => row.end));
  const members = new Map();
  for (const row of task) members.set(row.item.member, (members.get(row.item.member) || 0) + (row.work ? row.work[1] - row.work[0] : 0));
  const { wait } = time_parts(task.map((row) => ({ item: row.item, stages: row })));
  return { ...counts, keys, start, end, total: end - start, wait, slowest: timeline_summary(task).slowest,
    members: [...members].map(([member, ms]) => ({ member, ms })).sort((a, b) => b.ms - a.ms) };
}

/** One sweep over a task's executions: work shared among whoever works at each moment, then waiting, then idle. */
function time_parts(members) {
  const spans = members.flatMap(({ item, stages }) => [
    ...(stages.work ? [{ from: stages.work[0], to: stages.work[1], member: item.member }] : []),
    { from: stages.queue[0], to: stages.work ? stages.work[0] : stages.end, wait: true },
  ]).filter((span) => span.to > span.from);
  const edges = [...new Set(spans.flatMap((span) => [span.from, span.to]))].sort((a, b) => a - b);
  const shares = new Map();
  let wait = 0, idle = 0;
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const [from, to] = [edges[index], edges[index + 1]];
    const active = spans.filter((span) => span.from <= from && span.to >= to);
    const working = [...new Set(active.filter((span) => span.member !== undefined).map((span) => span.member))];
    if (working.length) for (const member of working) shares.set(member, (shares.get(member) || 0) + (to - from) / working.length);
    else if (active.length) wait += to - from;
    else idle += to - from;
  }
  return { wait, parts: [...[...shares].map(([member, ms]) => ({ member, ms })).sort((a, b) => b.ms - a.ms),
    ...(wait ? [{ wait: true, ms: wait }] : []), ...(idle ? [{ idle: true, ms: idle }] : [])] };
}

/**
 * Hand-off lines, one per dispatched execution whose dispatcher (`dispatched_by`) is shown above it: from the dispatcher's bar at the
 * moment of dispatch (the request's time) straight down to the dispatched row. Returns, per row key, the pieces that
 * row draws: `start` (a dot on the dispatcher's bar and the line leaving it), `through` (rows in between) and `end`
 * (the elbow into the dispatched bar), each at fraction `x` and named by the dispatched member.
 */
export function handoff_lines(rows, axis) {
  const index = new Map(rows.map((row, position) => [row.key, position]));
  const pieces = new Map();
  const add = (key, piece) => { if (!pieces.has(key)) pieces.set(key, []); pieces.get(key).push(piece); };
  rows.forEach((row, position) => {
    const from = index.get(row.dispatched_by);
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
 * 1.25×, so crossing a step never drops work below LIVE_FILL / 1.25 (68%) of the width.
 */
const LIVE_TOTALS_MS = [5, 6, 7, 8, 10, 12, 15, 18, 20, 24, 30, 36, 45, 50, 60, 75, 90, 105, 120, 150, 180, 210, 240, 300, 360,
  420, 480, 600, 720, 900, 1080, 1200, 1500, 1800, 2100, 2400, 3000, 3600, 4500, 5400, 6300, 7200, 9000, 10800, 12600, 14400,
  18000, 21600, 25200, 28800, 36000, 43200, 54000, 64800, 72000, 86400].map((seconds) => seconds * 1000);
/** While work runs, it fills at most this share of the axis; the rest is room for it to grow into. */
const LIVE_FILL = 0.85;

/**
 * The axis: busy stretches keep their length and idle stretches longer than FOLD_GAP_MS fold into bands, so a room
 * used over several days still reads. `x(t)` maps a time to a fraction of the width; `folds` are the bands. While work
 * runs (`live`), the last stretch runs on past now to the next round total, so bars grow into free room and the axis
 * rescales only now and then.
 */
export function timeline_axis(rows, live = false) {
  // The owner's bar spans the room standing idle, which still folds; only the moment the owner wrote counts as busy.
  const spans = rows.map((row) => is_user_row(row) ? [row.end, row.end] : [row.start, row.end]).sort((a, b) => a[0] - b[0]);
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

/** The step a reader should look at first: the longest recorded phase segment, and the counts the run picker needs. */
export function timeline_summary(rows) {
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
    slowest,
  };
}

// ---- Room event log: the website's append-only record of room state changes (GET /api/rooms/:id/events). ----

export const REQUEST_STATUS = { pending: "待投递", delivering: "投递中", completed: "已完成", cancelled: "已取消", failed: "失败" };
export const EXECUTION_STATUS = { dispatched: "已派出", started: "已开始", completed: "已完成", cancelled: "已作废", failed: "失败" };
export const PURPOSES = { route: "接收", ask: "派活", handoff: "交还主持人", notice: "程序通知主持人", keep_working: "主持人接着工作" };
const CREATORS = { user: "用户", host: "主持人", system: "程序" };
const CANCEL_REASONS = { user_stop: "用户停止", member_away: "成员暂离", member_removed: "成员移除", rerouted: "改派", no_reply: "未回复", archived: "房间归档" };
const MEMBER_STATUS = { active: "在场", away: "暂离", removed: "移除" };
const ROLES = { host: "主持人", member: "成员" };
/** The event's group, which colors its tag: message, request, execution, flow (batch, queue, chain), scheduler, room. */
export const EVENT_GROUPS = { api: "输入", message: "消息", request: "请求", execution: "执行", batch: "流转", queue: "流转", chain: "流转",
  scheduler: "调度", member: "房间", discussion: "房间", room: "房间" };
const OPEN_EXECUTIONS = new Set(["dispatched", "started"]);
const OPEN_REQUESTS = new Set(["pending", "delivering"]);
// Who sent a write, from the first product of its User-Agent.
const API_CLIENTS = [["Mozilla", "网页"], ["node", "本机服务"], ["AI-CoDiscuss-CLI", "CLI"], ["Python", "脚本"]];
const PATH_ENTITIES = { executions: "execution", requests: "request", messages: "message" };

/** A write's logged payload: the server stores it as JSON text, cut when long. */
function api_payload(data) {
  try { return JSON.parse(data.payload || "{}"); } catch { return {}; }
}

/** The entities an event touches, as `request:345`, `execution:321`, `message:647`, for filtering and linking. */
export function event_entities(event) {
  const data = event.kind.startsWith("api.") ? { ...api_payload(event.data), ...event.data } : event.data, keys = [];
  if (data.request_id) keys.push(`request:${data.request_id}`);
  if (data.execution_id) keys.push(`execution:${data.execution_id}`);
  for (const field of ["message_id", "answer_id", "batch_id", "reply_to", "after_message_id"]) if (data[field]) keys.push(`message:${data[field]}`);
  for (const [, collection, id] of String(data.path || "").matchAll(/\/(executions|requests|messages)\/(\d+)/g)) keys.push(`${PATH_ENTITIES[collection]}:${id}`);
  return [...new Set(keys)];
}

/** One line for a write request: who, through what, which endpoint and action, its text, and the rejection if any. */
function api_text(event) {
  const data = event.data, payload = api_payload(data);
  const actor = data.actor === "owner" ? "房主" : data.actor?.startsWith("member:") ? data.actor.slice(7) : data.actor === "none" ? "无凭据" : "未知凭据";
  const client = API_CLIENTS.find(([prefix]) => (data.client || "").startsWith(prefix))?.[1] || data.client || "未知客户端";
  const action = payload.action ? ` ${payload.action}` : "";
  const text = typeof payload.text === "string" ? `：${payload.text}` : "";
  const outcome = event.kind === "api.rejected" ? ` → 被拒 ${data.status}：${data.error}` : "";
  return `${actor}（${client}${data.bridged ? "·中转" : ""}）POST ${data.path}${action}${outcome}${text}`;
}

/** One line in plain words for an event; `name` turns a member id into a display name. */
export function event_text(event, name) {
  const data = event.data, who = name(data.member_id);
  const status = (labels, value) => labels[value] || value;
  switch (event.kind) {
    case "api.write":
    case "api.rejected": return api_text(event);
    case "message.posted": return `${data.author} 发言 #${data.message_id}${data.reply_to ? `（回复 #${data.reply_to}）` : ""}：${data.text}`;
    case "message.withdrawn": return `#${data.message_id} ${data.kind === "rewound" ? "被回退" : "被撤回"}`;
    case "room.rewound": return `回退到 #${data.message_id}`;
    case "member.joined": return `${who} 加入（${status(ROLES, data.role)} · ${data.adapter || "未知软件"}）`;
    case "member.changed": return `${who}：${data.from_role !== data.role ? `${status(ROLES, data.from_role)} → ${status(ROLES, data.role)}` : `${status(MEMBER_STATUS, data.from_status)} → ${status(MEMBER_STATUS, data.status)}`}`;
    case "request.created": return `请求 R${data.request_id} → ${who} · ${status(PURPOSES, data.purpose)} · 挂在 #${data.message_id} · 由${status(CREATORS, data.created_by)}创建${data.batch_id ? ` · 批次 #${data.batch_id}` : ""}`;
    case "request.changed": return `请求 R${data.request_id}（${who}）${data.from_status !== data.status ? `${status(REQUEST_STATUS, data.from_status)} → ${status(REQUEST_STATUS, data.status)}` : "更新"}${data.execution_id ? ` · 执行 E${data.execution_id}` : ""}${data.answer_id ? ` · 回答 #${data.answer_id}` : ""}`;
    case "request.cancel_reason": return `请求 R${data.request_id}（${who}）取消原因：${status(CANCEL_REASONS, data.reason)}`;
    case "execution.created": return `执行 E${data.execution_id}（${who}）${status(EXECUTION_STATUS, data.status)}`;
    case "execution.changed": return `执行 E${data.execution_id}（${who}）${status(EXECUTION_STATUS, data.from_status)} → ${status(EXECUTION_STATUS, data.status)}${data.result ? `：${data.result}` : ""}`;
    case "execution.retry": return data.stopped ? `执行 E${data.execution_id} 停止自动重试` : `执行 E${data.execution_id} 第 ${data.attempt} 次重试${data.reason ? `：${data.reason}` : ""}`;
    case "execution.late_answer": return `执行 E${data.execution_id} 作废后迟到的回答：${data.text}`;
    case "batch.opened": return `批次 #${data.batch_id} 开启（${name(data.host_id)} 派出，链 #${data.chain_id}）`;
    case "batch.settled": return `批次 #${data.batch_id} 已收齐`;
    case "batch.handoff": return `批次 #${data.batch_id} 交还主持人`;
    case "queue.added": return `${who} 排队等候 #${data.message_id}`;
    case "queue.removed": return `${who} 出队 #${data.message_id}`;
    case "chain.held": return `任务链 #${data.chain_id} 到限暂停，等用户决定`;
    case "chain.released": return `任务链 #${data.chain_id} 解除暂停`;
    case "scheduler.decided": return `智能调度（${data.kind === "round" ? "轮次" : "插话"}）在 #${data.after_message_id} 后选择「${data.label}」${data.confidence != null ? ` · 置信 ${Number(data.confidence).toFixed(2)}` : ""}${data.applied ? " · 已采用" : ""}`;
    case "scheduler.applied": return `智能调度选择「${data.label}」${data.applied ? "已采用" : "撤销采用"}`;
    case "discussion.created": return `讨论 #${data.session_id} 创建：${data.goal}`;
    case "discussion.changed": return `讨论 #${data.session_id}：${data.from_status} → ${data.status}`;
    default: return JSON.stringify(data);
  }
}

/**
 * Fold the events up to and including `index` into what was open at that moment: requests not yet finished (with the
 * message they hang under), executions still running, queue entries and paused chains. Events before the log began are
 * unknown, so anything that only finishes inside the window is ignored.
 */
export function state_at(events, index) {
  const requests = new Map(), executions = new Map(), queue = new Map(), chains = new Map();
  for (const event of events.slice(0, index + 1)) {
    const data = event.data;
    if (event.kind === "request.created") requests.set(data.request_id, { ...data, at: event.at });
    else if (event.kind === "request.changed" && requests.has(data.request_id)) {
      if (OPEN_REQUESTS.has(data.status)) requests.set(data.request_id, { ...requests.get(data.request_id), ...data });
      else requests.delete(data.request_id);
    } else if (event.kind === "execution.created") executions.set(data.execution_id, { ...data, at: event.at });
    else if (event.kind === "execution.changed" && executions.has(data.execution_id)) {
      if (OPEN_EXECUTIONS.has(data.status)) executions.set(data.execution_id, { ...executions.get(data.execution_id), ...data });
      else executions.delete(data.execution_id);
    } else if (event.kind === "queue.added") queue.set(data.queue_id, data);
    else if (event.kind === "queue.removed") queue.delete(data.queue_id);
    else if (event.kind === "chain.held") chains.set(data.chain_id, data);
    else if (event.kind === "chain.released") chains.delete(data.chain_id);
  }
  return { requests: [...requests.values()], executions: [...executions.values()], queue: [...queue.values()], chains: [...chains.values()] };
}

/**
 * Pure timeline and concurrency-panorama calculations shared by the web timeline page (`frontend/timeline-model.js`),
 * the share-card CLI (`runner/share_card.mjs`), and share modules. Zero UI, locale, or Node.js dependencies.
 */

/** The owner as a member of the timeline: rows named this represent the owner's messages rather than executions. */
export const USER_MEMBER = '用户';

/** 820ms, 6.9s, 42s, 3m 05s, 2h 05m: the precision a reader compares at each scale. */
export function format_duration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
}

/**
 * One execution's stages. Queue runs from the request to delivery and wake from delivery to the first sign of work:
 * the discussion's enter, else a free execution's first recorded segment (approximate). Without either, the time after
 * delivery is all work and wake is absent. An execution still running ends at `now_ms`, and so does its last segment:
 * the phase it was last seen in is shown as lasting until the next report says otherwise (`live`). Progress notes are
 * placed when the website received them, within the execution.
 */
export function execution_stages(item, now_ms) {
  const running = item.state === 'running';
  const end = item.finished_at ? item.finished_at * 1000 : now_ms;
  const dispatched = item.dispatched_at ? item.dispatched_at * 1000 : 0;
  const queued = Math.min(item.queued_at ? item.queued_at * 1000 : dispatched || end, dispatched || end);
  const raw_segments = Array.isArray(item.segments) ? item.segments : [];
  // `seen` is where output was last seen; past it a live segment is only assumed to go on, and is drawn as a faint tail.
  const segments = dispatched ? raw_segments.map((segment, index) => {
    const live = running && index === raw_segments.length - 1;
    const seen = Math.min(dispatched + segment.end_ms, end);
    return { phase: segment.phase, tool: segment.tool, live, seen, start: Math.min(dispatched + segment.start_ms, end), end: live ? end : seen };
  }) : [];
  // Phases not read yet (`segments_pending`, see has_phase_detail) still say where the first began.
  const entered = item.started_at ? item.started_at * 1000 : segments[0]?.start ?? (dispatched && item.first_ms != null ? Math.min(dispatched + item.first_ms, end) : 0);
  const work_start = dispatched ? Math.max(dispatched, Math.min(entered || dispatched, end)) : end;
  const notes = dispatched ? (item.notes || []).map((at, index) => ({ index, at: Math.min(Math.max(at * 1000, dispatched), end) })) : [];
  return {
    start: queued, end, queue: [queued, dispatched || end],
    wake: dispatched && work_start > dispatched ? [dispatched, work_start] : null,
    work: dispatched ? [work_start, end] : null,
    wake_approx: !item.started_at, segments, notes,
  };
}

/**
 * The room cut into tasks, oldest first. A task starts only where the owner asked for something new while the room was
 * idle: an execution started by a message the owner wrote (`task_author` "用户") that no earlier execution answered, with
 * every execution requested before it already ended. Everything else joins the task in progress: the owner's
 * interjections while work runs, the host's dispatches and proactive posts, hand-backs, the program's wakes, Goal runs and
 * retries. No time threshold and no dispatch chain decide it.
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
    const new_ask = item.task_author === USER_MEMBER && item.task_id != null && !asked.has(item.task_id);
    if (!segments.length || (new_ask && stages.queue[0] >= busy_until)) {
      segments.push({ key, opener: item, opened: new_ask, items: [], keys: new Set(), interjections: [] });
    } else if (new_ask) {
      segments.at(-1).interjections.push({ key, task_id: item.task_id, task: item.task || '', at: stages.queue[0] });
    }
    const segment = segments.at(-1);
    segment.items.push(entry);
    segment.keys.add(key);
    if (item.task_id != null) asked.add(item.task_id);
    busy_until = Math.max(busy_until, stages.end);
  }
  return segments;
}

/**
 * The room in real time (2026-11-23 user's request, #8032): one linear axis from the first execution to the last end,
 * nothing folded. `steps` cut that span wherever an execution starts or ends; each has `members` (who was working then,
 * as `{ member, count, keys }` in order of first appearance, `keys` the row keys of their executions then) and `total`.
 * An execution counts from its delivery to its end, so waiting in the queue is not work; a step with `total` 0 is the
 * room standing idle, also listed in `idle`. `tasks` are the segments' spans (`key`, `task`, `opened`, `start`, `end`),
 * the owner's rows left out. `peak` is the most at once.
 * What the view is opened for (#8279): how much of the span the room worked by itself (`busy_ms`, the span less its idle
 * time) and how many executions started without the owner (`runs`, of which `self_started` were begun by the host's
 * dispatch, a relay, a hand-back, a wake or a Goal run rather than a message the owner wrote). `unattended` is the
 * longest the room ran on by itself after one of the owner's messages (#8313): from the message until the room first
 * stood idle or the owner wrote again, as `{ start, end }`, or null.
 */
export function realtime_model(segments) {
  const runs = segments.flatMap((segment) => segment.items).filter(({ item, stages }) => item.source !== 'user' && stages.work)
    .map(({ item, stages }) => ({ key: `${item.source}:${item.id}`, member: item.member, start: stages.queue[1], end: Math.max(stages.queue[1], stages.end),
      asked: stages.queue[0], self_started: Boolean(item.task_author) && item.task_author !== USER_MEMBER }));
  if (!runs.length) return { start: 0, end: 0, steps: [], idle: [], tasks: [], peak: 0, members: [], idle_ms: 0, busy_ms: 0, runs: 0, self_started: 0, unattended: null };
  const members = [...new Set([...runs].sort((a, b) => a.start - b.start).map((run) => run.member))];
  const times = [...new Set(runs.flatMap((run) => [run.start, run.end]))].sort((a, b) => a - b);
  const steps = [];
  for (let index = 0; index + 1 < times.length; index += 1) {
    const [start, end] = [times[index], times[index + 1]];
    const keys = new Map();
    for (const run of runs) if (run.start <= start && run.end >= end) keys.set(run.member, [...(keys.get(run.member) || []), run.key]);
    const list = members.filter((member) => keys.has(member)).map((member) => ({ member, count: keys.get(member).length, keys: keys.get(member) }));
    const total = list.reduce((sum, entry) => sum + entry.count, 0);
    const last = steps.at(-1);
    if (last && last.total === total && last.members.length === list.length && last.members.every((entry, at) => entry.member === list[at].member && entry.keys.join() === list[at].keys.join())) last.end = end;
    else steps.push({ start, end, members: list, total });
  }
  const idle = steps.filter((step) => !step.total).map(({ start, end }) => ({ start, end }));
  const tasks = segments.map((segment) => {
    const spans = segment.items.filter(({ item }) => item.source !== 'user').map(({ stages }) => stages);
    return spans.length ? { key: segment.key, task: segment.opener.task || '', opened: segment.opened,
      start: Math.min(...spans.map((stages) => stages.queue[1] || stages.start)), end: Math.max(...spans.map((stages) => stages.end)) } : null;
  }).filter(Boolean);
  const idle_ms = idle.reduce((sum, gap) => sum + gap.end - gap.start, 0);
  // The room's busy stretches, then for each run the owner asked for: until its stretch ends or the owner writes again.
  const busy = [];
  for (const run of [...runs].sort((a, b) => a.start - b.start)) {
    const last = busy.at(-1);
    if (last && run.start <= last.end) last.end = Math.max(last.end, run.end);
    else busy.push({ start: run.start, end: run.end });
  }
  const asks = [...new Set(runs.filter((run) => !run.self_started).map((run) => run.asked))].sort((a, b) => a - b);
  let unattended = null;
  for (const run of runs.filter((item) => !item.self_started)) {
    const stretch = busy.find((item) => item.start <= run.start && run.start <= item.end);
    const next = asks.find((at) => at > run.asked) ?? Infinity;
    const end = Math.min(stretch?.end ?? run.end, next);
    if (end > run.asked && (!unattended || end - run.asked > unattended.end - unattended.start)) unattended = { start: run.asked, end };
  }
  return { start: times[0], end: times.at(-1), steps, idle, tasks, members, peak: Math.max(...steps.map((step) => step.total)),
    idle_ms, busy_ms: times.at(-1) - times[0] - idle_ms, runs: runs.length, self_started: runs.filter((run) => run.self_started).length, unattended };
}

/**
 * Compute collaboration metrics from raw timeline executions using the exact same definitions as RealtimeView.vue.
 *
 * @param {Array<object>} executions Timeline execution records from `/api/rooms/:id/timeline`.
 * @param {number} [now_ms] Reference timestamp in epoch ms for running executions.
 * @returns {object} Summary metrics, per-member work totals, and the underlying realtime model.
 */
export function collaboration_metrics(executions, now_ms = Date.now()) {
  const segments = timeline_segments(executions || [], now_ms);
  const model = realtime_model(segments);
  const span_ms = Math.max(0, model.end - model.start);
  const percent = (part, whole) => (whole ? Math.round(part / whole * 100) : 0);
  const member_stats = new Map();
  for (const segment of segments) {
    for (const { item, stages } of segment.items) {
      if (item.source === 'user' || !stages.work) continue;
      const entry = member_stats.get(item.member) || { member: item.member, runs: 0, work_ms: 0 };
      entry.runs += 1;
      entry.work_ms += Math.max(0, stages.end - stages.queue[1]);
      member_stats.set(item.member, entry);
    }
  }
  const member_totals = [...member_stats.values()]
    .sort((a, b) => b.work_ms - a.work_ms || b.runs - a.runs)
    .map((entry) => ({ ...entry, work_text: format_duration(entry.work_ms) }));
  const unattended = model.unattended ? {
    start_ms: model.unattended.start,
    end_ms: model.unattended.end,
    duration_ms: model.unattended.end - model.unattended.start,
    duration_text: format_duration(model.unattended.end - model.unattended.start),
  } : null;
  return {
    span_ms,
    span_text: format_duration(span_ms),
    busy_ms: model.busy_ms,
    busy_text: format_duration(model.busy_ms),
    busy_percent: percent(model.busy_ms, span_ms),
    idle_ms: model.idle_ms,
    idle_text: format_duration(model.idle_ms),
    runs: model.runs,
    self_started: model.self_started,
    self_started_percent: percent(model.self_started, model.runs),
    peak_concurrency: model.peak,
    unattended,
    member_totals,
    model,
  };
}

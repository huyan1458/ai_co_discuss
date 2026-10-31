/**
 * What each execution's software showed while it worked, kept until reported to the website: phase segments and
 * progress notes. Fed by whichever adapter reached the software (see adapters/), read by the room runner.
 */

/** Segments one execution may record, how many one report carries, and a tool name's length; the website enforces the same. */
export const MAX_EXECUTION_SEGMENTS = 400;
export const MAX_SEGMENTS_PER_REPORT = 40;
export const MAX_SEGMENT_TOOL = 60;
/** Progress notes kept per execution, each cut to this length, and how many one report carries; the website enforces the same. */
export const MAX_EXECUTION_NOTES = 50;
export const MAX_NOTE_LENGTH = 500;
export const MAX_NOTES_PER_REPORT = 10;

/**
 * What each execution's software showed while it worked, waiting to be reported: the phases it went through, as
 * millisecond offsets from its delivery on this machine's clock, and its progress notes. Consecutive events of the same
 * phase and tool extend one segment. The open segment is reported as far as it has run and again once it runs further;
 * numbering makes a resent report harmless.
 */
export class SegmentLog {
  constructor(now = Date.now) {
    this.now = now;
    this.executions = new Map();
  }
  /** Begin timing one execution at its delivery; a repeated start keeps the first origin. */
  start(id) {
    if (!this.executions.has(id)) this.executions.set(id, { origin: this.now(), last: 0, open: null, closed: [], next_seq: 0,
      notes: [], next_note: 0, open_sent: null, reported: 0 });
  }
  /** Queue one progress note; notes past the cap are dropped. Cut by UTF-16 units like the website's check, never mid-pair. */
  note(id, text) {
    const log = this.executions.get(id);
    if (!log || log.next_note >= MAX_EXECUTION_NOTES) return;
    log.next_note += 1;
    log.notes.push({ seq: log.next_note, text: text.slice(0, MAX_NOTE_LENGTH).replace(/[\uD800-\uDBFF]$/, '') });
  }
  /** The software produced output now; a phase, when the output names one, starts a new segment unless it continues the open one. */
  mark(id, phase = '', tool = '') {
    const log = this.executions.get(id);
    if (!log) return;
    log.last = this.now() - log.origin;
    if (log.open) log.open.end_ms = log.last;
    if (!phase) return;
    tool = tool.slice(0, MAX_SEGMENT_TOOL).replace(/[\uD800-\uDBFF]$/, '');
    if (log.open?.phase === phase && log.open.tool === tool) return;
    if (log.open) log.closed.push(log.open);
    log.open = null;
    if (log.next_seq >= MAX_EXECUTION_SEGMENTS) return;
    log.next_seq += 1;
    log.open = { seq: log.next_seq, phase, tool, start_ms: log.last, end_ms: log.last };
  }
  /** Whether something new waits to be reported (an open segment only once it ran further) and the last report is `interval_ms` old. */
  due(id, interval_ms) {
    const log = this.executions.get(id);
    const open_moved = log?.open && !(log.open_sent?.seq === log.open.seq && log.open_sent.end_ms === log.open.end_ms);
    return Boolean(log && (log.closed.length || log.notes.length || open_moved) && this.now() - log.reported >= interval_ms);
  }
  /** The next report: closed segments first, then the open one as it stands, and the queued notes. `final` closes the open segment. */
  batch(id, final = false) {
    const log = this.executions.get(id);
    if (!log) return { segments: [], notes: [] };
    if (final && log.open) { log.closed.push(log.open); log.open = null; }
    const segments = log.closed.slice(0, MAX_SEGMENTS_PER_REPORT);
    if (log.open && segments.length < MAX_SEGMENTS_PER_REPORT) segments.push({ ...log.open });
    return { segments, notes: log.notes.slice(0, MAX_NOTES_PER_REPORT) };
  }
  /** Forget what a successful report carried in full; a segment that ran on since it was sent stays. */
  sent(id, batch) {
    const log = this.executions.get(id);
    if (!log) return;
    const ends = new Map(batch.segments.map(segment => [segment.seq, segment.end_ms]));
    log.closed = log.closed.filter(segment => !(ends.has(segment.seq) && segment.end_ms <= ends.get(segment.seq)));
    const notes = new Set(batch.notes.map(note => note.seq));
    log.notes = log.notes.filter(note => !notes.has(note.seq));
    const open = log.open && batch.segments.find(segment => segment.seq === log.open.seq);
    if (open) log.open_sent = { seq: open.seq, end_ms: open.end_ms };
    log.reported = this.now();
  }
  /**
   * Send the execution's segments and notes with `send({segments, notes})`. `final` closes the open segment, sends
   * everything left and forgets the execution. A refused report drops them and any other failure keeps them for the
   * next try; it never throws, so a progress report cannot fail the execution it describes.
   */
  async report(id, final, send) {
    do {
      const batch = this.batch(id, final);
      if (!batch.segments.length && !batch.notes.length) break;
      try { await send(batch); }
      catch (error) {
        if (/HTTP 4\d\d/.test(error.message)) this.drop(id);
        return;
      }
      this.sent(id, batch);
    } while (final && (this.executions.get(id)?.closed.length || this.executions.get(id)?.notes.length));
    if (final) this.drop(id);
  }
  drop(id) { this.executions.delete(id); }
}

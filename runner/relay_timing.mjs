/** Best-effort, bounded diagnostic output. The writer accepts only fixed numeric fields and categories. */
import { appendFile, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';

const pending = new Map();
const LIMIT = 4 * 1024 * 1024;
const MAX_PENDING = 256;
const MAX_MS = 600000;
let writes = Promise.resolve();
let queued = 0;
const millis = value => Number.isInteger(value) && value >= 0 && value <= MAX_MS ? value : null;
const colo = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;

function finish(key, report = {}) {
  const entry = pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(key);
  const { home, row, measurement } = entry;
  row.frame_bytes = measurement.frame_bytes;
  row.buffered_bytes = measurement.queued_before_send ?? null;
  const total = millis(report.total), worker = millis(report.worker), relay = millis(report.relay);
  const diff = (a, b) => a !== null && b !== null ? millis(a - b) : null;
  Object.assign(row, { mobile_ms: diff(total, worker), site_ms: diff(worker, relay),
    link_ms: diff(relay, row.local_ms), device_colo: colo(report.dc), machine_colo: colo(report.mc) });
  if (queued >= MAX_PENDING) return;
  queued++;
  writes = writes.then(async () => {
    const file = join(home, 'relay-timing.jsonl');
    const line = JSON.stringify(row) + '\n';
    const size = await stat(file).then(s => s.size, e => { if (e.code === 'ENOENT') return 0; throw e; });
    if (size + Buffer.byteLength(line) > LIMIT) await truncate(file, 0);
    await appendFile(file, line, { mode: 0o600 });
  }).catch(() => {}).finally(() => { queued--; });
}

/** Match feedback only to requests authenticated for this device and site. */
export function accept_timing(home, site, device, reports) {
  if (!device || !Array.isArray(reports)) return;
  for (const report of reports.slice(0, 16)) {
    if (report && typeof report.id === 'string') finish(JSON.stringify([home, site, device, report.id]), report);
  }
}

/** Flush locally observed requests even if a browser closes before reporting. */
export function remember_timing(home, site, device, id, category, elapsed, status, measurement) {
  const key = JSON.stringify([home, site, device, id]);
  if (pending.has(key)) finish(key);
  if (pending.size >= MAX_PENDING) finish(pending.keys().next().value);
  const timer = setTimeout(() => finish(key), 30000);
  timer.unref();
  const request_id = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null;
  pending.set(key, { timer, home, measurement, row: { at: Date.now(), request_id, category, local_ms: millis(elapsed), status } });
}

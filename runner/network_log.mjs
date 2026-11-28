/** Service-side network history. Only controlled categories, origins and measurements reach disk. */
import { appendFileSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n.mjs';

const WINDOW = 300000;
const LIMIT = 4 * 1024 * 1024;
const SEGMENTS = ['mobile_ms', 'site_ms', 'link_ms'];
const windows = new Map();
const streaks = new Map();

function origin(site) {
  try { return new URL(site).origin; } catch { return 'unknown'; }
}

function write(home, row) {
  try {
    const file = join(home, 'network.jsonl');
    const line = JSON.stringify(row) + '\n';
    if ((statSync(file, { throwIfNoEntry: false })?.size || 0) + Buffer.byteLength(line) > LIMIT) renameSync(file, file + '.1');
    appendFileSync(file, line, { mode: 0o600 });
  } catch { /* Diagnostics cannot interrupt a request. */ }
}

function blank() {
  return { requests: 0, failures: 0, disconnects: 0, hist: Object.fromEntries(SEGMENTS.map(k => [k, {}])) };
}

function quantiles(hist) {
  const bins = Object.entries(hist).map(([ms, n]) => [+ms, n]).sort((a, b) => a[0] - b[0]);
  const count = bins.reduce((n, b) => n + b[1], 0);
  function percentile(fraction) {
    let rank = Math.ceil(count * fraction);
    for (const [ms, n] of bins) if ((rank -= n) <= 0) return ms;
    return null;
  }
  return { n: count, p50: percentile(0.5), p90: percentile(0.9) };
}

function segments(row) {
  return Object.fromEntries(SEGMENTS.map(key => [key, quantiles(row.hist[key])]));
}

function persist(key) {
  const slot = windows.get(key);
  if (!slot) return;
  windows.delete(key);
  clearTimeout(slot.timer);
  write(slot.home, { ...slot.row, segments: segments(slot.row) });
}

process.once('exit', () => { for (const key of windows.keys()) persist(key); });

function bucket(home, site, at) {
  const start = Math.floor(at / WINDOW) * WINDOW;
  const key = JSON.stringify([home, site, start]);
  if (!windows.has(key)) {
    const row = { at: start, site: origin(site), event: 'summary', ...blank() };
    const timer = setTimeout(() => persist(key), Math.max(1, start + WINDOW - Date.now())).unref();
    windows.set(key, { home, row, timer });
  }
  return windows.get(key).row;
}

/** Count one observation. A late device receipt can add failure or latency without adding a second request. */
export function observe(home, site, { request = true, failed = false, at = Date.now(), ...times } = {}) {
  const row = bucket(home, site, at);
  row.requests += Number(request);
  row.failures += Number(failed);
  for (const key of SEGMENTS) {
    const ms = times[key];
    if (!Number.isInteger(ms) || ms < 0 || ms > 600000) continue;
    // Exact low latencies; round larger values to two significant digits for mergeable bounded histograms.
    const unit = 10 ** Math.max(0, Math.floor(Math.log10(ms || 1)) - 1);
    const bin = Math.round(ms / unit) * unit;
    row.hist[key][bin] = (row.hist[key][bin] || 0) + 1;
  }
}

/** Extract a transport or HTTP code without retaining arbitrary remote text. */
export function network_code(error) {
  const code = error?.cause?.code || error?.cause?.errors?.find(item => item.code)?.code || error?.code;
  if (/^(?:E[A-Z0-9_]{2,28}|UND_ERR_[A-Z_]{2,32}|ERR_(?:TLS|SSL)_[A-Z0-9_]{2,50}|CERT_[A-Z_]{2,40}|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_(?:VERIFY_LEAF_SIGNATURE|GET_ISSUER_CERT_LOCALLY|GET_ISSUER_CERT)|SELF_SIGNED_CERT_IN_CHAIN)$/.test(code)) return code;
  if (Number.isInteger(error?.status)) return 'HTTP_' + error.status;
  return error?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR';
}

/** Store fixed categories supplied by transport call sites; raw error messages and close reasons are excluded. */
export function network_event(home, site, event, fields, at = Date.now()) {
  write(home, { ...fields, at, site: origin(site), event });
  if (event === 'disconnected') bucket(home, site, at).disconnects++;
}

/** Record HTTP attempts and emit only the edges of a failure streak. */
export function http_result(home, site, operation, elapsed_ms, error, log) {
  const at = Date.now();
  observe(home, site, { at, failed: Boolean(error) });
  const key = JSON.stringify([home, site, operation]);
  const failure = streaks.get(key);
  const segment = operation === 'upload' ? 'computer_local_http' : 'computer_site_http';
  const operation_name = () => ({ sync: t('同步电脑状态'), claim: t('领取远程命令'), command_response: t('回传远程命令'), upload: t('上传附件') })[operation];
  if (error) {
    if (failure) { failure.count++; return; }
    streaks.set(key, { at, count: 1 });
    log?.(t('{label}失败：{reason}', { label: origin(site) + ': ' + operation_name(), reason: network_code(error) }));
    network_event(home, site, 'http_failed', { operation, segment, code: network_code(error), elapsed_ms }, at);
  } else if (failure) {
    streaks.delete(key);
    log?.(t('{label}已恢复，持续 {seconds} 秒，失败 {count} 次', { label: origin(site) + ': ' + operation_name(), seconds: Math.round((at - failure.at) / 1000), count: failure.count }));
    network_event(home, site, 'http_recovered', { operation, segment, count: failure.count, duration_ms: at - failure.at, elapsed_ms }, at);
  }
}

const receipts = new Map();
const FAILURE_SEGMENTS = new Map([['machine_unregistered', 'link'], ['offline', 'link'], ['relay_timeout', 'unknown'], ['browser_timeout', 'unknown'], ['fetch_failed', 'unknown'], ['site_http', 'site']]);

// Negative evidence requires coverage from the start of the exact socket and a complete retained set.
const connections = new Map();
/** Track frame IDs from socket registration, before dispatch or authentication. */
export function track_relay_connection(home, site, connection) {
  const state = { ids: new Set(), complete: true };
  connections.set(JSON.stringify([home, site, connection]), state);
  if (connections.size > 32) connections.delete(connections.keys().next().value);
  return id => {
    state.ids.add(id);
    if (state.ids.size > 4096) { state.complete = false; state.ids.delete(state.ids.values().next().value); }
  };
}

function receipt(home, site, device, id, at) {
  const key = JSON.stringify([home, site, device, id]);
  if (!receipts.has(key)) {
    receipts.set(key, { at });
    observe(home, site, { at });
    if (receipts.size > 4096) receipts.delete(receipts.keys().next().value);
  }
  return receipts.get(key);
}

function count_failure(home, site, seen) {
  if (!seen.failed) observe(home, site, { at: seen.at, request: false, failed: true });
  seen.failed = true;
}

/** Record the computer's terminal result, even if the phone cannot send a receipt. */
export function relay_outcome(home, site, timing, failed) {
  const seen = receipt(home, site, timing.device, timing.id, Date.now());
  seen.local_ms = timing.local_ms;
  if (failed) count_failure(home, site, seen);
}

/** Accept bounded numeric timings and fixed failure labels from a paired device. */
export function device_feedback(home, site, device, reports) {
  if (!device || !Array.isArray(reports)) return;
  for (const report of reports.slice(0, 16)) {
    if (!report || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(report.id)) continue;
    const key = JSON.stringify([home, site, device, report.id]);
    if (FAILURE_SEGMENTS.has(report.failure)) {
      const at = Number.isSafeInteger(report.at) && Math.abs(Date.now() - report.at) < 86400000 ? report.at : Date.now();
      const seen = receipt(home, site, device, report.id, at);
      if (seen.browser_failure) continue;
      seen.browser_failure = true;
      count_failure(home, site, seen);
      const operation = ['room-api', 'room-upload', 'computer-site'].includes(report.operation) ? report.operation : 'other';
      const valid_ms = value => Number.isInteger(value) && value >= 0 && value <= 600000 ? value : null;
      const elapsed_ms = valid_ms(report.total), worker_ms = valid_ms(report.worker);
      if (elapsed_ms !== null && worker_ms !== null) observe(home, site, { request: false, at: seen.at, mobile_ms: elapsed_ms - worker_ms });
      const connection = report.failure === 'relay_timeout' && typeof report.connection === 'string'
        && connections.get(JSON.stringify([home, site, report.connection]));
      if (report.failure === 'relay_timeout' && report.relay_close === 'unresponsive')
        network_event(home, site, 'relay_unresponsive', { source: 'device_request', segment: 'link', close_code: 4003 }, at);
      const unreceived = connection?.complete && !connection.ids.has(report.id);
      const event = unreceived ? 'relay_timeout_unreceived' : report.failure === 'machine_unregistered' ? 'machine_unregistered' : 'relay_failed';
      network_event(home, site, event, { source: 'device_request', operation, segment: unreceived ? 'link' : FAILURE_SEGMENTS.get(report.failure), code: report.failure,
        elapsed_ms, worker_ms, rpc_ms: valid_ms(report.rpc), http_status: Number.isInteger(report.status) && report.status >= 400 && report.status <= 599 ? report.status : null }, at);
    } else {
      const seen = receipts.get(key);
      if (!seen || seen.timed) continue;
      seen.timed = true;
      const diff = (a, b) => [a, b].every(ms => Number.isInteger(ms) && ms >= 0 && ms <= 600000) ? a - b : null;
      observe(home, site, { request: false, at: seen.at, mobile_ms: diff(report.total, report.worker),
        site_ms: diff(report.worker, report.relay), link_ms: diff(report.relay, seen.local_ms) });
    }
  }
}

function time_arg(value, fallback, reference = Date.now()) {
  if (value == null) return fallback;
  const relative = /^(\d+)([mhd])$/.exec(value);
  const time = relative ? reference - Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]] : Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(t('无效的报告时间'));
  return time;
}

/** Aggregate completed five-minute windows. Event timestamps retain millisecond precision. */
export function network_report(home, { since, until, by = '10m' } = {}) {
  const end = time_arg(until, Date.now()), start = time_arg(since, end - 86400000, end);
  const span = { '10m': 600000, '1h': 3600000 }[by];
  if (!Number.isFinite(span) || start >= end) throw new Error(t('网络报告需要有效时间范围和 10m 或 1h 分组'));
  const grouped = new Map(), events = [];
  for (const file of ['network.jsonl.1', 'network.jsonl']) {
    let lines;
    try { lines = readFileSync(join(home, file), 'utf8').split('\n'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    for (const line of lines) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || !(row.at >= start && row.at < end)) continue;
      if (row.event !== 'summary') { events.push(row); continue; }
      const at = Math.floor(row.at / span) * span, key = JSON.stringify([at, row.site]);
      if (!grouped.has(key)) grouped.set(key, { at, site: row.site, ...blank() });
      const group = grouped.get(key);
      for (const k of ['requests', 'failures', 'disconnects']) group[k] += row[k];
      for (const k of SEGMENTS) for (const [bin, n] of Object.entries(row.hist[k])) group.hist[k][bin] = (group.hist[k][bin] || 0) + n;
    }
  }
  const periods = [...grouped.values()].sort((a, b) => a.at - b.at).map(group => {
    const timing = segments(group);
    const ranked = SEGMENTS.filter(k => timing[k].n).sort((a, b) => timing[b].p90 - timing[a].p90);
    const { hist, ...counts } = group;
    return { ...counts, at: new Date(group.at).toISOString(), segments: timing, worst_p90: ranked[0] || null };
  });
  return { periods, events: events.sort((a, b) => a.at - b.at).map(row => ({ ...row, at: new Date(row.at).toISOString() })) };
}

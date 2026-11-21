/** Service-owned observations of each online site's relay. Times are Unix milliseconds. */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomic_json } from './files.mjs';

const HEALTH_FILE = 'relay-health.json';
const RECONNECT_FILE = 'relay-reconnect.json';
// Longer than the reconnect backoff and multiple heartbeat periods.
const STALE_MS = 90_000;

/** Keep transport diagnostics free of request URLs, credentials and response bodies. */
export function network_failure(error) {
  const code = error?.cause?.code || error?.code;
  if (code === 'ECONNRESET') return 'reset';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || error?.name === 'TimeoutError') return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (error?.status) return `HTTP ${error.status}`;
  return 'network';
}

/** Collect callbacks in the service process; one atomic write per dirty service tick. */
export function relay_health_writer(home) {
  const sites = Object.create(null);
  let dirty = true;
  function observe(site, machine) {
    dirty = true;
    if (sites[site]?.machine !== machine) sites[site] = { machine, state: 'connecting', since: Date.now(),
      updated_at: 0, retries: 0, last_failure: null, last_request_at: null, http_failures: 0, http_at: 0 };
    return sites[site];
  }
  return {
    rebuild(site, machine, reason) {
      const row = observe(site, machine);
      row.updated_at = row.since = Date.now();
      row.state = 'connecting';
      row.last_rebuild = { reason, at: row.updated_at };
    },
    attempt(site, machine) {
      const row = observe(site, machine);
      if (row.last_failure) row.retries++;
      row.updated_at = Date.now();
    },
    channel(site, machine, state, failure = null) {
      const row = observe(site, machine);
      row.updated_at = Date.now();
      if (row.state !== state) row.since = row.updated_at;
      row.state = state;
      if (state === 'connected') row.retries = 0;
      if (failure) row.last_failure = { ...failure, at: row.updated_at };
    },
    request(site, machine) { observe(site, machine).last_request_at = Date.now(); },
    http(site, machine, error) {
      if (sites[site] && sites[site].machine !== machine) return;
      const row = observe(site, machine), now = Date.now();
      row.http_failures = error ? (now - row.http_at <= STALE_MS ? row.http_failures : 0) + 1 : 0;
      row.http_reason = error ? network_failure(error) : null;
      row.http_at = now;
    },
    flush() {
      if (!dirty) return;
      atomic_json(join(home, HEALTH_FILE), { pid: process.pid, sites });
      dirty = false;
    },
  };
}

/** Send one idempotent reconnect request to the current service and binding. */
export function request_relay_reconnect(home, bound, pid) {
  atomic_json(join(home, RECONNECT_FILE), { ...bound, pid, id: randomUUID() });
}

/** Consume each request once, ignoring requests for a replaced service or binding. */
export function reconnect_reader(home) {
  let seen;
  return sites => {
    let request;
    try { request = JSON.parse(readFileSync(join(home, RECONNECT_FILE), 'utf8')); }
    catch { return; } // A manual request must not prevent the normal channels starting.
    if (!request?.id || request.id === seen || request.pid !== process.pid) return;
    seen = request.id;
    if (sites[request.site]?.id === request.machine) return request.site;
  };
}

/** Return observations for this binding and service only; HTTP traffic never refreshes socket liveness. */
export function read_relay_health(home, bound, pid, now = Date.now()) {
  if (!bound) return null;
  if (!pid) return { state: 'unknown', reason: 'stopped' };
  try {
    const snapshot = JSON.parse(readFileSync(join(home, HEALTH_FILE), 'utf8'));
    const row = snapshot.sites?.[bound.site];
    if (snapshot.pid === pid && row?.machine === bound.machine && row.updated_at > 0 &&
        row.updated_at <= now && now - row.updated_at <= STALE_MS) {
      return now - row.http_at <= STALE_MS ? row : { ...row, http_failures: 0, http_reason: null };
    }
  } catch { /* Missing, old or unreadable status cannot establish a live relay. */ }
  return { state: 'unknown', reason: 'stale' };
}

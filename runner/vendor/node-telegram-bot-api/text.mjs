// Adapted from node-telegram-bot-api 2.5.0, dist/core/{transport,longpoll}.js. See SOURCE.md.
import { setTimeout as delay } from 'node:timers/promises';

const API_ROOT = 'https://api.telegram.org';
const HTTP_TIMEOUT_MS = 15_000;
const POLL_SECONDS = 25;
const POLL_MARGIN_MS = 10_000;
const MAX_RETRY_MS = 60_000;

/** Telegram JSON-only transport. Retry only explicit throttling, never ambiguous sends. */
export async function telegram_request(token, method, params, { fetch_impl = fetch, signal } = {}) {
  const timeout = method === 'getUpdates' ? params.timeout * 1000 + POLL_MARGIN_MS : HTTP_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetch_impl(`${API_ROOT}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      redirect: 'error',
    });
    const json = await response.json();
    if (response.ok && json.ok) return json.result;
    const wait_ms = Number(json.parameters?.retry_after) * 1000;
    if (response.status === 429 && attempt === 0 && wait_ms >= 0 && wait_ms <= MAX_RETRY_MS) {
      await delay(wait_ms, undefined, { signal });
      continue;
    }
    throw Object.assign(new Error(json.description || `HTTP ${response.status}`), {
      code: json.error_code ?? response.status, detail: json.description || '',
    });
  }
}

/** Read one batch. Caller advances the cursor after processing each update. */
export function telegram_updates(token, offset, options) {
  return telegram_request(token, 'getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] }, options);
}

// Adapted from larksuite/node-sdk ws-client (MIT, see SOURCE.md).
import { decode_frame, encode_frame } from './frame.mjs';

const CONTROL = 0;
const DATA = 1;
const ACK_OK = 200;
const ACK_FAILED = 500;
const DEFAULT_PING_MS = 120_000;
const DEFAULT_RETRY_MS = 5_000;
const HANDSHAKE_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const FRAGMENT_TTL_MS = 10_000;
const MAX_FRAGMENTS = 128;

function seconds(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value * 1_000 : fallback;
}

/** Fetch the SDK long-connection URL and timing options. Never log the signed URL. */
export async function discover_endpoint(post, account, signal) {
  const { data } = await post('/callback/ws/endpoint', { AppID: account.app_id, AppSecret: account.app_secret }, { signal });
  const url = new URL(data?.URL || '');
  if (url.protocol !== 'wss:') throw new Error('Invalid Feishu WebSocket URL');
  const config = data.ClientConfig || {};
  return { url: url.href, service: Number(url.searchParams.get('service_id')) || 0,
    ping_ms: seconds(config.PingInterval, DEFAULT_PING_MS), retry_ms: seconds(config.ReconnectInterval, DEFAULT_RETRY_MS) };
}

function assemble(fragments, headers, payload) {
  const now = Date.now();
  for (const [id, entry] of fragments) if (entry.expires <= now) fragments.delete(id);
  const count = Number(headers.sum);
  const index = Number(headers.seq);
  const id = headers.message_id;
  if (!id || !Number.isInteger(count) || count < 1 || count > MAX_FRAGMENTS
      || !Number.isInteger(index) || index < 0 || index >= count || !payload) throw new Error('Invalid Feishu event fragments');
  if (count === 1) return payload;
  const entry = fragments.get(id) || { parts: Array(count).fill(null), expires: now + FRAGMENT_TTL_MS };
  if (entry.parts.length !== count) throw new Error('Inconsistent Feishu event fragments');
  entry.parts[index] = payload;
  if (entry.parts.some(part => part === null)) {
    fragments.set(id, entry);
    return null;
  }
  fragments.delete(id);
  return Buffer.concat(entry.parts);
}

async function acknowledge(socket, frame, payload, on_event) {
  const start = Date.now();
  let code = ACK_OK;
  try { await on_event(JSON.parse(payload.toString())); }
  catch { code = ACK_FAILED; }
  if (socket.readyState === 1) socket.send(encode_frame({ ...frame,
    headers: [...frame.headers, { key: 'biz_rt', value: String(Date.now() - start) }],
    payload: Buffer.from(JSON.stringify({ code })) }));
}

function handle_frame(socket, input, state) {
  const frame = decode_frame(input);
  const headers = Object.fromEntries(frame.headers.map(({ key, value }) => [key, value]));
  if (frame.method === CONTROL && headers.type === 'pong' && frame.payload?.length) {
    state.ping_ms = seconds(JSON.parse(frame.payload.toString()).PingInterval, state.ping_ms);
  } else if (frame.method === DATA && headers.type === 'event') {
    const payload = assemble(state.fragments, headers, frame.payload);
    if (payload) return acknowledge(socket, frame, payload, state.on_event);
  }
}

/** Run one connection until close, transport timeout, or the caller aborts it. */
export function connect_events(endpoint, { websocket_impl, on_event, on_error, signal }) {
  if (signal.aborted) return Promise.resolve();
  const socket = new websocket_impl(endpoint.url);
  socket.binaryType = 'arraybuffer';
  return new Promise(resolve => {
    const state = { fragments: new Map(), on_event, ping_ms: endpoint.ping_ms };
    let ping_timer;
    let watchdog = setTimeout(finish, HANDSHAKE_MS);
    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(ping_timer);
      clearTimeout(watchdog);
      signal.removeEventListener('abort', finish);
      if (socket.readyState < 2) socket.close();
      resolve();
    }
    function ping() {
      if (finished || socket.readyState !== 1) return;
      socket.send(encode_frame({ SeqID: 0, LogID: 0, service: endpoint.service, method: CONTROL,
        headers: [{ key: 'type', value: 'ping' }] }));
      clearTimeout(watchdog);
      watchdog = setTimeout(finish, Math.min(PONG_TIMEOUT_MS, state.ping_ms));
      ping_timer = setTimeout(ping, state.ping_ms);
    }
    socket.addEventListener('open', ping);
    socket.addEventListener('message', async ({ data }) => {
      if (finished) return;
      clearTimeout(watchdog);
      try { await handle_frame(socket, data, state); }
      catch { on_error(); }
    });
    socket.addEventListener('close', finish);
    socket.addEventListener('error', finish);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

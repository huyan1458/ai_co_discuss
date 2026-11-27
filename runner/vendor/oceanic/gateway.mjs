// Adapted from Oceanic.js 1.15.0, dist/lib/gateway/Shard.js. See SOURCE.md.
const HELLO_TIMEOUT_MS = 15_000;
const STALE_SESSION = new Set([4007, 4009]);
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const DEFAULT_GATEWAY = 'wss://gateway.discord.gg';
const DIRECT_MESSAGES = 1 << 12;
const MESSAGE_CONTENT = 1 << 15;

function gateway_url(session) {
  const url = new URL(session.url || DEFAULT_GATEWAY);
  url.searchParams.set('v', '10');
  url.searchParams.set('encoding', 'json');
  return url;
}

function authenticate(send, token, session) {
  if (session.id) send(6, { token, session_id: session.id, seq: session.sequence });
  else send(2, { token, intents: DIRECT_MESSAGES | MESSAGE_CONTENT,
    properties: { os: process.platform, browser: 'codiscuss', device: 'codiscuss' } });
}

/** One Gateway connection. The caller keeps session state across recoverable reconnects. */
export function discord_gateway(token, session, { signal, websocket_impl = WebSocket, on_message }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve();
    const socket = new websocket_impl(gateway_url(session));
    let heartbeat_timer, heartbeat_start, awaiting_ack = false, closed = false;
    const hello_timer = setTimeout(() => finish(new Error('Gateway Hello timeout')), HELLO_TIMEOUT_MS);
    const send = (op, d) => { if (socket.readyState === 1) socket.send(JSON.stringify({ op, d })); };
    const heartbeat = (requested = false) => {
      if (!requested && awaiting_ack) return finish(new Error('Gateway heartbeat ACK timeout'));
      if (!requested) awaiting_ack = true;
      send(1, session.sequence ?? null);
    };
    const abort = () => finish();
    function finish(error) {
      if (closed) return;
      closed = true;
      clearTimeout(hello_timer);
      clearTimeout(heartbeat_start);
      clearInterval(heartbeat_timer);
      signal.removeEventListener('abort', abort);
      if (socket.readyState < 2) socket.close(4000);
      error ? reject(error) : resolve();
    }
    function dispatch(event) {
      session.sequence = event.s;
      if (event.t === 'READY') {
        session.id = event.d.session_id;
        session.url = event.d.resume_gateway_url;
      } else if (event.t === 'MESSAGE_CREATE') on_message(event.d);
    }
    function handle(event) {
      switch (event.op) {
        case 0: dispatch(event); break;
        case 1: heartbeat(true); break;
        case 7: finish(); break;
        case 9:
          if (!event.d) clear_session(session);
          finish();
          break;
        case 10:
          clearTimeout(hello_timer);
          authenticate(send, token, session);
          heartbeat_start = setTimeout(() => {
            heartbeat();
            heartbeat_timer = setInterval(heartbeat, event.d.heartbeat_interval);
          }, Math.random() * event.d.heartbeat_interval);
          break;
        case 11: awaiting_ack = false; break;
      }
    }
    socket.addEventListener('message', event => {
      if (closed) return;
      try { handle(JSON.parse(event.data)); } catch (error) { finish(error); }
    });
    socket.addEventListener('error', () => finish(new Error('Gateway connection failed')));
    socket.addEventListener('close', event => {
      if (closed) return;
      if (STALE_SESSION.has(event.code)) clear_session(session);
      const error = Object.assign(new Error(`Gateway closed (${event.code})`), {
        code: event.code, fatal: FATAL_CLOSE.has(event.code),
      });
      finish(error);
    });
    signal.addEventListener('abort', abort, { once: true });
  });
}

function clear_session(session) {
  delete session.id;
  delete session.url;
  delete session.sequence;
}

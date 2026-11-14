/** The relay Durable Object bound by the Pages website; it lets devices reach the paired computer's rooms. */
/** How long a device's request waits for the computer before it is reported as unconfirmed; local operations that run longer ask for more. */
const RELAY_WAIT_MS = 9000;
const RELAY_MAX_WAIT_MS = 80000;
const RELAY_PROTOCOL = "codiscuss-relay";
const RELAY_ROLES = ["machine", "device"];
// The hosted accounts' entry traffic (backend/entry_worker.mjs): how long the computer may take to start an answer, and
// how much of a request body goes in one frame (a WebSocket frame is at most 1 MiB, and the part is sent as base64).
const ENTRY_HEAD_WAIT_MS = 30000;
const ENTRY_PART_BYTES = 512 * 1024;
const OFFLINE_PAGE = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>暂时无法访问</title></head>'
  + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#374151"><h1 style="font-size:1.3rem">这台电脑当前不在线</h1>'
  + '<p>为你开通服务的电脑没有连上线上站点（可能关机或断网）。请稍后再试，或联系为你开通的服务商。</p></body></html>';

const to_base64 = bytes => { let text = ""; for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(text); };
const from_base64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

/**
 * One paired computer's relay: the computer and the administrator's devices each keep a hibernating WebSocket, and a
 * device's encrypted request is handed to the computer and its encrypted answer back. Nothing is stored or decrypted;
 * pending requests live only in memory, so losing them leaves the outcome unconfirmed, never retried here.
 */
export class MachineRelay {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();
    // Entry requests in flight: id → { resolve, writer, timer, started }.
    this.entries = new Map();
    // Keep-alives are answered without waking the object, so idle connections cost no duration.
    if (globalThis.WebSocketRequestResponsePair) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Accept a socket the Pages Worker has already authenticated, or relay one device request. */
  async fetch(request) {
    const role = request.headers.get("X-Relay-Role");
    if (request.headers.get("Upgrade") === "websocket" && RELAY_ROLES.includes(role)) {
      const pair = new WebSocketPair();
      let device = null;
      try { device = JSON.parse(request.headers.get("X-Relay-Device") || "null"); } catch { /* An untagged socket is closed at the next list. */ }
      this.accept(pair[1], role, device);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
    }
    if (request.method === "POST" && role === "request") return Response.json(await this.relay(await request.json()));
    if (request.method === "POST" && role === "entry") return this.entry(request);
    if (request.method === "GET" && role === "entry-status") return Response.json({ online: this.machine() !== null });
    if (request.method === "POST" && role === "devices") return Response.json(this.devices((await request.json()).devices));
    return new Response(null, { status: 404 });
  }

  /**
   * Register a socket; a new computer connection replaces the old one, and devices learn whether it is online. A device
   * socket keeps which device opened it and until when that device is paired.
   */
  accept(socket, role, device = null) {
    if (role === "machine") {
      // Requests waiting now went to the old connection, whose answers can no longer arrive (a stalled one never sends
      // them): fail them at once so the device can ask again over the new one, instead of waiting out the timeout.
      for (const id of [...this.pending.keys()]) this.settle(id, { id, status: "offline" });
      for (const id of [...this.entries.keys()]) this.entry_finish(id, 503);
      for (const old of this.ctx.getWebSockets("machine")) old.close(1000, "replaced");
    }
    this.ctx.acceptWebSocket(socket, [role]);
    // The role survives hibernation with the socket, so a woken object still knows who sent a frame.
    socket.serializeAttachment(role === "device" ? { role, device: device?.id ?? "", expires_at: Number(device?.expires_at) || 0 } : { role });
    if (role === "machine") this.broadcast({ type: "presence", online: true });
    else socket.send(JSON.stringify({ type: "presence", online: this.machine() !== null }));
  }

  /** The connected computer, if any. */
  machine() {
    return this.ctx.getWebSockets("machine").find(socket => socket.readyState === undefined || socket.readyState === 1) ?? null;
  }

  /** Hand one request to the computer and wait for its answer; the outcome is unconfirmed when it does not come in time. */
  relay({ id, envelope, wait }) {
    const machine = this.machine();
    if (!machine) return { id, status: "offline" };
    if (this.pending.has(id)) return { id, status: "duplicate" };
    return new Promise(resolve => {
      const limit = Number.isInteger(wait) ? Math.min(Math.max(wait, 1000), RELAY_MAX_WAIT_MS) : RELAY_WAIT_MS;
      const timer = setTimeout(() => this.settle(id, { id, status: "unknown" }), limit);
      this.pending.set(id, { resolve, timer });
      try { machine.send(JSON.stringify({ type: "request", id, envelope })); }
      catch { this.settle(id, { id, status: "offline" }); }
    });
  }

  /**
   * Pass one HTTP request of the hosted accounts' entry to the computer and stream its answer back. This channel is apart
   * from the administrator's: it carries no device signature, and the computer sends it only to its sign-in entry, only
   * while its owner has chosen this way in the panel. The request is described by the X-Entry-Request header (method,
   * path, headers; URI-encoded JSON) with the body as the request's own; the answer streams as it comes, so the entry's
   * live updates (server-sent events) reach the page.
   */
  async entry(request) {
    const machine = this.machine();
    if (!machine) return new Response(OFFLINE_PAGE, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    let meta;
    try { meta = JSON.parse(decodeURIComponent(request.headers.get("X-Entry-Request") || "")); } catch { return new Response(null, { status: 400 }); }
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
    const id = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    return new Promise(resolve => {
      const timer = setTimeout(() => this.entry_finish(id, 504), ENTRY_HEAD_WAIT_MS);
      this.entries.set(id, { resolve, readable, writer: writable.getWriter(), timer, started: false });
      try {
        const parts = Math.max(1, Math.ceil(body.length / ENTRY_PART_BYTES));
        for (let index = 0; index < parts; index += 1) {
          const part = to_base64(body.subarray(index * ENTRY_PART_BYTES, (index + 1) * ENTRY_PART_BYTES));
          machine.send(JSON.stringify(index === 0 ? { type: "entry", id, method: meta.method, path: meta.path, headers: meta.headers, body: part, more: parts > 1 }
            : { type: "entry-body", id, body: part, more: index < parts - 1 }));
        }
      } catch { this.entry_finish(id, 503); }
    });
  }

  /** The computer's answer to an entry request: its status and headers, parts of its body, its end. */
  entry_frame(frame) {
    const entry = this.entries.get(frame.id);
    if (!entry) return;
    if (frame.type === "entry-head" && !entry.started) {
      entry.started = true;
      clearTimeout(entry.timer);
      const headers = new Headers();
      for (const [name, value] of Array.isArray(frame.headers) ? frame.headers : []) {
        try { headers.append(name, value); } catch { /* A header this platform will not carry. */ }
      }
      entry.resolve(new Response(entry.readable, { status: Number(frame.status) || 502, headers }));
    } else if (frame.type === "entry-data" && entry.started) {
      // The page went away: tell the computer to stop sending.
      entry.writer.write(from_base64(String(frame.data || ""))).catch(() => this.entry_cancel(frame.id));
    } else if (frame.type === "entry-end") this.entry_finish(frame.id);
  }

  /** End an entry request: a started one closes its body, one not started yet answers `status`. */
  entry_finish(id, status = 502) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    if (entry.started) entry.writer.close().catch(() => {});
    else entry.resolve(new Response(null, { status }));
  }

  entry_cancel(id) {
    if (!this.entries.has(id)) return;
    this.entry_finish(id);
    try { this.machine()?.send(JSON.stringify({ type: "entry-cancel", id })); } catch { /* The computer went away too. */ }
  }

  /** Finish a waiting request once. */
  settle(id, result) {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(result);
  }

  /** Computers send answers and change notices; devices only keep their socket open. */
  webSocketMessage(socket, message) {
    if (socket.deserializeAttachment()?.role !== "machine" || typeof message !== "string") return;
    let frame;
    try { frame = JSON.parse(message); } catch { return; }
    if (typeof frame.type === "string" && frame.type.startsWith("entry-") && typeof frame.id === "string") this.entry_frame(frame);
    else if (frame.type === "response" && typeof frame.id === "string") this.settle(frame.id, { id: frame.id, status: "done", response: frame.envelope });
    else if (frame.type === "event") this.broadcast({ type: "change", rooms: Array.isArray(frame.rooms) ? frame.rooms.slice(0, 100) : null });
  }

  /** A computer that leaves fails its waiting requests at once, rather than after the timeout. */
  webSocketClose(socket) {
    if (socket.deserializeAttachment()?.role !== "machine" || this.machine()) return;
    for (const id of [...this.pending.keys()]) this.settle(id, { id, status: "offline" });
    for (const id of [...this.entries.keys()]) this.entry_finish(id, 503);
    this.broadcast({ type: "presence", online: false });
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  /**
   * Apply the computer's new device list: sockets of devices no longer on it are closed, the others take its expiry.
   * A revoked device thereby stops hearing which rooms change and whether the computer is online.
   */
  devices(list) {
    const kept = new Map((Array.isArray(list) ? list : []).map(item => [item?.id, Number(item?.expires_at) || 0]));
    let closed = 0;
    for (const socket of this.ctx.getWebSockets("device")) {
      const attachment = socket.deserializeAttachment() || {};
      if (!kept.has(attachment.device)) { closed += 1; this.drop(socket, "revoked"); }
      else socket.serializeAttachment({ ...attachment, expires_at: kept.get(attachment.device) });
    }
    return { closed };
  }

  /** Close a device socket that may no longer listen. */
  drop(socket, reason) {
    try { socket.close(4001, reason); } catch { /* Already closed. */ }
  }

  /** Send a frame to every device still paired; a socket whose device expired since it connected is closed instead. */
  broadcast(frame) {
    const text = JSON.stringify(frame), now = Date.now();
    for (const socket of this.ctx.getWebSockets("device")) {
      if (!(socket.deserializeAttachment()?.expires_at > now)) { this.drop(socket, "expired"); continue; }
      try { socket.send(text); } catch { /* A closed device reconnects and reads the current state. */ }
    }
  }
}

// The namespace is called through the Pages binding, never a public publish URL.
export default { fetch: () => new Response(null, { status: 404 }) };

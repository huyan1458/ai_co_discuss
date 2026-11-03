/** The relay Durable Object bound by the Pages website; it lets devices reach the paired computer's rooms. */
/** How long a device's request waits for the computer before it is reported as unconfirmed; local operations that run longer ask for more. */
const RELAY_WAIT_MS = 9000;
const RELAY_MAX_WAIT_MS = 80000;
const RELAY_PROTOCOL = "codiscuss-relay";
const RELAY_ROLES = ["machine", "device"];

/**
 * One paired computer's relay: the computer and the administrator's devices each keep a hibernating WebSocket, and a
 * device's encrypted request is handed to the computer and its encrypted answer back. Nothing is stored or decrypted;
 * pending requests live only in memory, so losing them leaves the outcome unconfirmed, never retried here.
 */
export class MachineRelay {
  constructor(ctx) {
    this.ctx = ctx;
    this.pending = new Map();
    // Keep-alives are answered without waking the object, so idle connections cost no duration.
    if (globalThis.WebSocketRequestResponsePair) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Accept a socket the Pages Worker has already authenticated, or relay one device request. */
  async fetch(request) {
    const role = request.headers.get("X-Relay-Role");
    if (request.headers.get("Upgrade") === "websocket" && RELAY_ROLES.includes(role)) {
      const pair = new WebSocketPair();
      this.accept(pair[1], role);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
    }
    if (request.method === "POST" && role === "request") return Response.json(await this.relay(await request.json()));
    return new Response(null, { status: 404 });
  }

  /** Register a socket; a new computer connection replaces the old one, and devices learn whether it is online. */
  accept(socket, role) {
    if (role === "machine") for (const old of this.ctx.getWebSockets("machine")) old.close(1000, "replaced");
    this.ctx.acceptWebSocket(socket, [role]);
    // The role survives hibernation with the socket, so a woken object still knows who sent a frame.
    socket.serializeAttachment({ role });
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
    if (frame.type === "response" && typeof frame.id === "string") this.settle(frame.id, { id: frame.id, status: "done", response: frame.envelope });
    else if (frame.type === "event") this.broadcast({ type: "change", rooms: Array.isArray(frame.rooms) ? frame.rooms.slice(0, 100) : null });
  }

  /** A computer that leaves fails its waiting requests at once, rather than after the timeout. */
  webSocketClose(socket) {
    if (socket.deserializeAttachment()?.role !== "machine" || this.machine()) return;
    for (const id of [...this.pending.keys()]) this.settle(id, { id, status: "offline" });
    this.broadcast({ type: "presence", online: false });
  }

  webSocketError(socket) {
    this.webSocketClose(socket);
  }

  /** Send a frame to every device. */
  broadcast(frame) {
    const text = JSON.stringify(frame);
    for (const socket of this.ctx.getWebSockets("device")) {
      try { socket.send(text); } catch { /* A closed device reconnects and reads the current state. */ }
    }
  }
}

// The namespace is called through the Pages binding, never a public publish URL.
export default { fetch: () => new Response(null, { status: 404 }) };

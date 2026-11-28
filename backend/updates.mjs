import policy from './attachment_policy.json' with { type: 'json' };
import { CLOUD_SHARE_CODE, CLOUD_SHARE_TOKEN, cloud_share_not_found, local_cloud_share } from './cloud_share_routes.mjs';
/** The relay Durable Object bound by the Pages website; it lets devices reach the paired computer's rooms. */
/** How long a device's request waits for the computer before it is reported as unconfirmed; local operations that run longer ask for more. */
const RELAY_WAIT_MS = 9000;
const MAX_CONSECUTIVE_TIMEOUTS = 2;
const CURRENT_CONNECTION = "current_machine_connection";
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
const OFFLINE_PAGE_EN = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Temporarily unavailable</title></head>'
  + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#374151"><h1 style="font-size:1.3rem">This computer is offline</h1>'
  + '<p>The computer hosting your service is not connected to the online site. It may be turned off or disconnected from the network. Try again later or contact your service provider.</p></body></html>';

const to_base64 = bytes => { let text = ""; for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(text); };
const from_base64 = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

/**
 * One paired computer's relay: the computer and the administrator's devices each keep a hibernating WebSocket, and a
 * device's encrypted request is handed to the computer and its encrypted answer back. Only the current machine connection ID is persisted;
 * pending requests live only in memory, so losing them leaves the outcome unconfirmed, never retried here.
 */
export class MachineRelay {
  constructor(ctx) {
    this.ctx = ctx;
    this.current_connection = ctx.storage.kv.get(CURRENT_CONNECTION);
    this.pending = new Map();
    // Entry requests in flight: id → { resolve, writer, timer, started }.
    this.entries = new Map();
    // Transport pongs can sleep; registered probes and legacy machine pings reach the application.
    if (globalThis.WebSocketRequestResponsePair) ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("link_ping", "pong"));
    this.reported_missing = false;
  }

  /** Accept a socket the Pages Worker has already authenticated, or relay one device request. */
  async fetch(request) {
    const role = request.headers.get("X-Relay-Role");
    if (request.headers.get("Upgrade") === "websocket" && RELAY_ROLES.includes(role)) {
      const pair = new WebSocketPair();
      let device = null;
      try { device = JSON.parse(request.headers.get("X-Relay-Device") || "null"); } catch { /* An untagged socket is closed at the next list. */ }
      const probes = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").some(token => token.trim() === "codiscuss-probe-v1");
      this.accept(pair[1], role, device, request.headers.get("X-Relay-Colo"), probes);
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
    }
    if (request.method === "POST" && role === "request") return Response.json(await this.relay(await request.json()));
    if (request.method === "POST" && role === "entry") return this.entry(request);
    if (request.method === "POST" && role === "cloud-share") {
      const token = request.headers.get("X-Cloud-Share-Token") || "";
      const code = request.headers.get("X-Cloud-Share-Code");
      return !request.body && CLOUD_SHARE_TOKEN.test(token) && (code === null || CLOUD_SHARE_CODE.test(code))
        ? this.entry(request, local_cloud_share(token, code)) : cloud_share_not_found();
    }
    if (request.method === "GET" && role === "entry-status") return Response.json({ online: this.machine() !== null, limit_mib: this.machine()?.deserializeAttachment()?.limit_mib ?? policy.default_mib });
    if (request.method === "POST" && role === "relocate") {
      for (const id of this.pending.keys()) this.settle(id, { id, status: "offline" });
      for (const id of this.entries.keys()) this.entry_finish(id, 503);
      for (const socket of this.ctx.getWebSockets()) socket.close(1012, "relay region changed");
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST" && role === "devices") return Response.json(this.devices((await request.json()).devices));
    return new Response(null, { status: 404 });
  }

  /**
   * Register a socket; a new computer connection replaces the old one, and devices learn whether it is online. A device
   * socket keeps which device opened it and until when that device is paired.
   */
  accept(socket, role, device = null, colo = null, probes = false) {
    let connection;
    if (role === "machine") {
      connection = crypto.randomUUID();
      this.ctx.storage.kv.put(CURRENT_CONNECTION, connection);
      this.current_connection = connection;
      // Requests waiting now went to the old connection, whose answers can no longer arrive (a stalled one never sends
      // them): fail them at once so the device can ask again over the new one, instead of waiting out the timeout.
      for (const id of [...this.pending.keys()]) this.settle(id, { id, status: "offline" });
      for (const id of [...this.entries.keys()]) this.entry_finish(id, 503);
      for (const old of this.ctx.getWebSockets("machine")) {
        if (old.readyState !== 1 || old.deserializeAttachment()?.retired) continue;
        old.serializeAttachment({ ...old.deserializeAttachment(), retired: true });
        old.close(1000, "replaced");
      }
      this.reported_missing = false;
    }
    this.ctx.acceptWebSocket(socket, [role]);
    // The role survives hibernation with the socket, so a woken object still knows who sent a frame.
    socket.serializeAttachment(role === "device" ? { role, device: device?.id ?? "", expires_at: Number(device?.expires_at) || 0 } : { role, colo, connection, probes });
    if (role === "machine" && probes) socket.send(JSON.stringify({ type: "probe-ready", connection: socket.deserializeAttachment().connection }));
    if (role === "machine") this.broadcast({ type: "presence", online: true });
    else socket.send(JSON.stringify({ type: "presence", online: this.machine() !== null }));
  }

  /** The connected computer, if any. */
  machine() {
    if (!this.current_connection) return null;
    return this.ctx.getWebSockets("machine").find(socket => {
      const info = socket.deserializeAttachment();
      return socket.readyState === 1 && info?.role === "machine" && !info.retired && info.connection === this.current_connection;
    }) ?? null;
  }

  /** Hand one request to the computer and wait for its answer; the outcome is unconfirmed when it does not come in time. */
  relay({ id, envelope, wait, guest }) {
    const machine = this.machine();
    if (!machine) {
      if (!this.reported_missing) console.warn(JSON.stringify({ event: "machine_unregistered", source: "device_request" }));
      this.reported_missing = true;
      return { id, status: "offline", reason: "machine_unregistered" };
    }
    if (this.pending.has(id)) return { id, status: "duplicate" };
    return new Promise(resolve => {
      const limit = Number.isInteger(wait) ? Math.min(Math.max(wait, 1000), RELAY_MAX_WAIT_MS) : RELAY_WAIT_MS;
      const timer = setTimeout(() => this.request_timeout(machine, id), limit);
      this.pending.set(id, { resolve, timer, guest, machine, started: performance.now() });
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
  async entry(request, public_share_path = null) {
    const machine = this.machine();
    if (!machine) return new Response(/^zh\b/i.test(request.headers.get("Accept-Language") || "zh") ? OFFLINE_PAGE : OFFLINE_PAGE_EN,
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Language" } });
    let meta;
    if (public_share_path) {
      meta = { cloud_share: true, method: 'GET', path: public_share_path,
        headers: [["accept-language", request.headers.get("Accept-Language") || "zh"]] };
    } else {
      try { meta = JSON.parse(decodeURIComponent(request.headers.get("X-Entry-Request") || "")); } catch { return new Response(null, { status: 400 }); }
      // The ordinary hosted entry cannot ask for the separate anonymous path to the owner's room service.
      if (!meta || typeof meta !== "object" || meta.cloud_share) return new Response(null, { status: 400 });
    }
    const limit = machine.deserializeAttachment()?.limit_mib ?? policy.default_mib;
    const maximum = (limit + policy.entry_overhead_mib) * 1024 * 1024;
    const id = crypto.randomUUID();
    const { readable, writable } = new TransformStream();
    return new Promise(resolve => {
      const timeout = () => this.entry_cancel(id, 504);
      const timer = setTimeout(timeout, ENTRY_HEAD_WAIT_MS);
      this.entries.set(id, { resolve, readable, writer: writable.getWriter(), timer, timeout, started: false });
      this.send_entry_body(machine, id, meta, public_share_path ? null : request.body, maximum).catch(() => this.entry_cancel(id, 503));
    });
  }

  /** Forward bounded frames without buffering the whole upload in the Durable Object. */
  async send_entry_body(machine, id, meta, stream, maximum) {
    let first = true, size = 0;
    const send = (bytes, more) => {
      const frame = first ? { type: "entry", id, ...meta } : { type: "entry-body", id };
      machine.send(JSON.stringify({ ...frame, body: to_base64(bytes), more }));
      first = false;
    };
    if (stream) {
      for await (const chunk of stream) {
        const pending = this.entries.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(pending.timeout, ENTRY_HEAD_WAIT_MS);
        size += chunk.length;
        if (size > maximum) {
          this.entry_finish(id, 413);
          machine.send(JSON.stringify({ type: "entry-cancel", id }));
          return;
        }
        for (let offset = 0; offset < chunk.length; offset += ENTRY_PART_BYTES)
          send(chunk.subarray(offset, offset + ENTRY_PART_BYTES), true);
      }
    }
    if (this.entries.has(id)) send(new Uint8Array(), false);
  }

  /** Timeouts belong to the socket that received the request. Never replay an unconfirmed operation. */
  request_timeout(socket, id) {
    if (this.pending.get(id)?.machine !== socket) return;
    const state = socket.deserializeAttachment() ?? {};
    const timeouts = (state.timeouts || 0) + 1;
    this.settle(id, { id, status: "unknown", ...(state.probes ? { connection: state.connection,
      ...(timeouts >= MAX_CONSECUTIVE_TIMEOUTS ? { relay_close: "unresponsive" } : {}) } : {}) });
    const current = this.machine();
    if (state.retired || (current !== socket && (!state.connection || current?.deserializeAttachment()?.connection !== state.connection))) return;
    socket.serializeAttachment({ ...state, timeouts });
    if (timeouts < MAX_CONSECUTIVE_TIMEOUTS) return;
    console.warn(JSON.stringify({ event: "relay_unresponsive", close_code: 4003, timeouts }));
    for (const [pending_id, pending] of this.pending) {
      if (pending.machine === socket || (state.connection && pending.machine.deserializeAttachment()?.connection === state.connection))
        this.settle(pending_id, { id: pending_id, status: "unknown" });
    }
    this.webSocketClose(socket);
    socket.close(4003, "unresponsive");
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
  entry_finish(id, status) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    if (entry.started && status) entry.writer.abort(new Error('Relay disconnected')).catch(() => {});
    else if (entry.started) entry.writer.close().catch(() => {});
    else entry.resolve(new Response(null, { status: status ?? 502 }));
  }

  entry_cancel(id, status) {
    if (!this.entries.has(id)) return;
    this.entry_finish(id, status);
    try { this.machine()?.send(JSON.stringify({ type: "entry-cancel", id })); } catch { /* The computer went away too. */ }
  }

  /** Finish a waiting request once. */
  settle(id, result) {
    const waiting = this.pending.get(id);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(waiting.guest && waiting.guest.expires_at <= Date.now() ? { id, status: "revoked", reason: "expired" } : result);
  }

  /** Computers send answers and change notices; devices only keep their socket open. */
  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role === "device" && message === "ping") { socket.send("pong"); return; }
    if (attachment?.role !== "machine" || typeof message !== "string") return;
    const current = this.machine();
    const registered = current === socket || (attachment.connection && current?.deserializeAttachment()?.connection === attachment.connection);
    if (attachment.retired || !registered) {
      if (message === "ping" || attachment.probes) {
        try { if (socket.readyState === 1) socket.send("machine_unregistered"); }
        finally { socket.close(4002, "machine unregistered"); }
      }
      return;
    }
    if (message === "ping" || message === "link_ping") { socket.send("pong"); return; }
    let frame;
    try { frame = JSON.parse(message); } catch { return; }
    if (frame.type === "probe" && attachment.probes && Number.isSafeInteger(frame.seq)) {
      socket.send(JSON.stringify({ type: "probe-reply", seq: frame.seq }));
      return;
    }
    if (frame.type === "attachment-policy" && Number.isInteger(frame.limit_mib)
        && frame.limit_mib >= policy.min_mib && frame.limit_mib <= policy.max_mib) {
      socket.serializeAttachment({ ...socket.deserializeAttachment(), limit_mib: frame.limit_mib });
      return;
    }
    if (typeof frame.type === "string" && frame.type.startsWith("entry-") && typeof frame.id === "string") this.entry_frame(frame);
    else if (frame.type === "response" && typeof frame.id === "string") {
      const waiting = this.pending.get(frame.id);
      if (waiting && attachment.timeouts) socket.serializeAttachment({ ...attachment, timeouts: 0 });
      if (waiting) this.settle(frame.id, { id: frame.id, status: "done", response: frame.envelope,
        frame_bytes: message.length, roundtrip_ms: Math.round(performance.now() - waiting.started), machine_colo: socket.deserializeAttachment()?.colo || null });
    }
    else if (frame.type === "event") this.broadcast({ type: "change", rooms: Array.isArray(frame.rooms) ? frame.rooms.slice(0, 100) : null });
  }

  /** A computer that leaves fails its waiting requests at once, rather than after the timeout. */
  webSocketClose(socket) {
    const attachment = socket.deserializeAttachment();
    if (attachment?.role !== "machine" || attachment.retired || !this.current_connection || attachment.connection !== this.current_connection) return;
    this.ctx.storage.kv.delete(CURRENT_CONNECTION);
    this.current_connection = undefined;
    if (socket.readyState === 1) socket.serializeAttachment({ ...attachment, retired: true });
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
    const guests = new Map((list || []).filter(item => item.kind === "guest").map(item => [item.id, item.expires_at]));
    for (const [id, pending] of this.pending) {
      if (!pending.guest) continue;
      const expiry = guests.get(pending.guest.id);
      if (!(expiry > Date.now())) this.settle(id, { id, status: "revoked", reason: "disconnected" });
      else pending.guest.expires_at = expiry;
    }
    for (const id of guests.keys()) kept.delete(id);
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

/** A Pages-bound Durable Object broadcasts invalidations across Worker instances. */
const HEARTBEAT_MS = 15000;
const STREAM_QUEUE_LIMIT = 16;
const encoder = new TextEncoder();

export class DiscussionUpdates {
  constructor() {
    this.clients = new Set();
    this.heartbeat = null;
  }

  /** Open a read-only stream or publish a committed-write notification from Pages. */
  fetch(request) {
    if (request.method === "POST") {
      // Name the changed room so a runner wakes only that room; without one every room may have changed.
      const room = new URL(request.url).searchParams.get("room");
      this.broadcast(`event: change\ndata: ${JSON.stringify(room ? { rooms: [room] } : {})}\n\n`);
      return new Response(null, { status: 204 });
    }
    if (request.method !== "GET") return new Response(null, { status: 405 });
    let client;
    const stream = new ReadableStream({
      start: controller => {
        client = controller;
        this.clients.add(client);
        client.enqueue(encoder.encode("retry: 3000\nevent: ready\ndata: {}\n\n"));
        this.heartbeat ??= setInterval(() => this.broadcast(": keepalive\n\n"), HEARTBEAT_MS);
      },
      cancel: () => this.remove_client(client),
    }, { highWaterMark: STREAM_QUEUE_LIMIT });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store",
    } });
  }

  /** Bound slow-reader memory; reconnecting clients fetch a fresh snapshot. */
  broadcast(frame) {
    const bytes = encoder.encode(frame);
    for (const client of this.clients) {
      try {
        if (client.desiredSize <= 0) {
          client.error(new Error("Update stream reader is too slow"));
          this.remove_client(client);
        } else client.enqueue(bytes);
      } catch { this.remove_client(client); }
    }
  }

  /** Stop the heartbeat when the last subscriber leaves. */
  remove_client(client) {
    this.clients.delete(client);
    if (!this.clients.size) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

// The namespace is called through the Pages binding, never a public publish URL.
export default { fetch: () => new Response(null, { status: 404 }) };

import { MachineRelay } from "../../backend/updates.mjs";

export class RelayCheck extends MachineRelay {
  generation = crypto.randomUUID();

  async fetch(request) {
    if (new URL(request.url).pathname === "/probe") {
      const result = await this.relay({ id: crypto.randomUUID(), envelope: {} });
      return Response.json({ generation: this.generation, ...result });
    }
    return super.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const { hostname, pathname } = new URL(request.url);
    if (hostname !== "127.0.0.1" || !["/connect", "/probe"].includes(pathname)) return new Response(null, { status: 404 });
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Role", "machine");
    return env.RELAY.get(env.RELAY.idFromName("local-check")).fetch(forwarded);
  }
};

/**
 * The hosted accounts' sign-in entry over the online relay: a Worker on a workers.dev address of its own that hands each
 * request to a computer's relay (backend/updates.mjs, `MachineRelay`), which passes it to that computer's sign-in entry
 * and streams the answer back. Accounts need no domain of the owner's: the address is the Worker's own.
 *
 * It must not share an origin with the online site, where the administrator's paired devices keep their keys: a page of a
 * hosted account (with its users' and AIs' content) on that origin could use those keys. Here it reads, keeps and decides
 * nothing; signing in, sessions and protection stay with the computer's entry.
 *
 * Which computer: the link the owner hands out carries it (`?m=<computer id>`); it is kept in a cookie of this address,
 * and every later request goes to that computer.
 */

const MACHINE_PATTERN = /^[0-9a-f]{32}$/;
const MACHINE_COOKIE = "codiscuss_machine";
const MACHINE_COOKIE_SECONDS = 365 * 24 * 3600;
// The largest request passed on: attachments are uploaded in one request of up to 40 MB, plus the form around them.
const BODY_MAX_BYTES = 45 * 1024 * 1024;
// Headers the relay sets itself or that describe only this hop.
const DROPPED_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length",
  "x-forwarded-proto", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]);

const page = (status, title, text) => new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
  + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#374151"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></body></html>`,
{ status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

function machine_cookie(request) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${MACHINE_COOKIE}=([0-9a-f]{32})`));
  return match ? match[1] : "";
}

const relay_of = (env, machine) => env.RELAY.get(env.RELAY.idFromName(machine));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Whether a computer is connected, for its owner's panel: `/_codiscuss/status?machine=<id>`.
    if (url.pathname === "/_codiscuss/status") {
      const machine = url.searchParams.get("machine") || "";
      if (!MACHINE_PATTERN.test(machine)) return Response.json({ error: "电脑编号无效" }, { status: 400 });
      const answer = await relay_of(env, machine).fetch("https://relay.internal/", { headers: { "X-Relay-Role": "entry-status" } });
      return Response.json({ service: "codiscuss-entry", ...(await answer.json()) }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    // The link handed out: keep its computer and continue without it in the address.
    const asked = url.searchParams.get("m");
    if (asked !== null) {
      if (!MACHINE_PATTERN.test(asked)) return page(404, "链接不完整", "请使用为你开通服务的人发给你的完整链接。");
      url.searchParams.delete("m");
      return new Response(null, { status: 302, headers: { Location: `${url.pathname}${url.search}`,
        "Set-Cookie": `${MACHINE_COOKIE}=${asked}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MACHINE_COOKIE_SECONDS}`, "Cache-Control": "no-store" } });
    }
    const machine = machine_cookie(request);
    if (!machine) return page(404, "链接不完整", "请使用为你开通服务的人发给你的完整链接。");
    if (Number(request.headers.get("Content-Length") || 0) > BODY_MAX_BYTES) return page(413, "文件太大", "单次上传不能超过 40 MB。");
    // The browser's own host, which the entry compares a page's Origin with, from the address itself.
    const headers = [...request.headers].filter(([name]) => !DROPPED_HEADERS.has(name) && name !== "host" && !name.startsWith("cf-")).concat([["host", url.host]]);
    const meta = encodeURIComponent(JSON.stringify({ method: request.method, path: `${url.pathname}${url.search}`, headers }));
    const streamed = !["GET", "HEAD"].includes(request.method);
    return relay_of(env, machine).fetch("https://relay.internal/", { method: "POST", headers: { "X-Relay-Role": "entry", "X-Entry-Request": meta },
      ...(streamed ? { body: request.body, duplex: "half" } : {}) });
  },
};

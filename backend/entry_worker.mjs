import { read_relay_region, relay_in_region } from "./worker.mjs";
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

const CACHE_SECONDS = 30;
const CACHE_LIMIT = 512;
const relay_caches = new WeakMap();

/** Cache each computer's resolved relay briefly within this Worker isolate. */
async function entry_relay(env, machine) {
  let cache = relay_caches.get(env);
  if (!cache) {
    cache = new Map();
    relay_caches.set(env, cache);
  }
  const now = Date.now();
  const cached = cache.get(machine);
  if (cached?.expires > now) return relay_in_region(env.RELAY, machine, cached.region);
  const region = await read_relay_region(env, machine);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(machine, { region, expires: now + CACHE_SECONDS * 1000 });
  return relay_in_region(env.RELAY, machine, region);
}

const MACHINE_PATTERN = /^[0-9a-f]{32}$/;
const MACHINE_COOKIE = "codiscuss_machine";
const MACHINE_COOKIE_SECONDS = 365 * 24 * 3600;
// The largest request passed on: attachments are uploaded in one request of up to 40 MB, plus the form around them.
const BODY_MAX_BYTES = 45 * 1024 * 1024;
// Headers the relay sets itself or that describe only this hop.
const DROPPED_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length",
  "x-forwarded-proto", "x-forwarded-for", "x-forwarded-host", "x-real-ip"]);

const PAGE_ENGLISH = {
  "链接不完整": "Incomplete link",
  "请使用为你开通服务的人发给你的完整链接。": "Use the complete link sent by the person who set up your access.",
  "文件太大": "File too large",
  "单次上传不能超过 40 MB。": "Each upload must be no larger than 40 MB.",
};
/** Standalone pages have no UI runtime; select their language from the browser request. */
function page(request, status, title, text) {
  const chinese = /^zh\b/i.test(request.headers.get("Accept-Language") || "zh");
  const heading = chinese ? title : PAGE_ENGLISH[title], body = chinese ? text : PAGE_ENGLISH[text];
  return new Response(`<!doctype html><html lang="${chinese ? "zh-CN" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#374151"><h1 style="font-size:1.3rem">${heading}</h1><p>${body}</p></body></html>`,
  { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Language" } });
}
/** Keep the Chinese JSON error for older callers and expose its translation template. */
function entry_error(template, params = {}) {
  return { error: template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match), error_text: { template, params } };
}

function machine_cookie(request) {
  const match = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${MACHINE_COOKIE}=([0-9a-f]{32})`));
  return match ? match[1] : "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Whether a computer is connected, for its owner's panel: `/_codiscuss/status?machine=<id>`.
    if (url.pathname === "/_codiscuss/status") {
      const machine = url.searchParams.get("machine") || "";
      if (!MACHINE_PATTERN.test(machine)) return Response.json(entry_error("电脑编号无效"), { status: 400 });
      const answer = await (await entry_relay(env, machine)).fetch("https://relay.internal/", { headers: { "X-Relay-Role": "entry-status" } });
      return Response.json({ service: "codiscuss-entry", ...(await answer.json()) }, { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } });
    }
    // The link handed out: keep its computer and continue without it in the address.
    const asked = url.searchParams.get("m");
    if (asked !== null) {
      if (!MACHINE_PATTERN.test(asked)) return page(request, 404, "链接不完整", "请使用为你开通服务的人发给你的完整链接。");
      url.searchParams.delete("m");
      return new Response(null, { status: 302, headers: { Location: `${url.pathname}${url.search}`,
        "Set-Cookie": `${MACHINE_COOKIE}=${asked}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MACHINE_COOKIE_SECONDS}`, "Cache-Control": "no-store" } });
    }
    const machine = machine_cookie(request);
    if (!machine) return page(request, 404, "链接不完整", "请使用为你开通服务的人发给你的完整链接。");
    if (Number(request.headers.get("Content-Length") || 0) > BODY_MAX_BYTES) return page(request, 413, "文件太大", "单次上传不能超过 40 MB。");
    // The browser's own host, which the entry compares a page's Origin with, from the address itself.
    const headers = [...request.headers].filter(([name]) => !DROPPED_HEADERS.has(name) && name !== "host" && !name.startsWith("cf-")).concat([["host", url.host]]);
    const meta = encodeURIComponent(JSON.stringify({ method: request.method, path: `${url.pathname}${url.search}`, headers }));
    const streamed = !["GET", "HEAD"].includes(request.method);
    return (await entry_relay(env, machine)).fetch("https://relay.internal/", { method: "POST", headers: { "X-Relay-Role": "entry", "X-Entry-Request": meta, "Accept-Language": request.headers.get("Accept-Language") || "zh" },
      ...(streamed ? { body: request.body, duplex: "half" } : {}) });
  },
};

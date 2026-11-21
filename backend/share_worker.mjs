/** Public, read-only room snapshots on the share site's own origin. */
const MAX_BYTES = 5 * 1024 * 1024;
const CHUNK_BYTES = 512 * 1024;
const DAY_MS = 86_400_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const PUBLIC_ASSET = /^\/(?:i18n\.js|markdown\.js|backup\.js|app\.js|modern\.js|modern\.css|markdown\.css|icons\/[\w.-]+|katex\/(?:fonts\/)?[\w.-]+)$/;
const CODE = {
  invalid: [400, "分享数据无效", "Invalid share data"],
  ttl: [400, "有效期须为 1、3 或 7 天", "Choose 1, 3 or 7 days"],
  auth: [403, "凭据无效", "Invalid credential"],
  missing: [404, "分享不存在或已撤销", "Share not found or revoked"],
  expired: [410, "分享已过期", "Share expired"],
  moderated: [409, "分享已暂停更新，等待运营方复核", "Share updates are suspended pending review"],
  hidden: [410, "分享已暂停展示", "Share unavailable pending review"],
  size: [413, "分享超过大小上限", "Share exceeds the size limit"],
  media: [415, "请发送 JSON 数据", "Send JSON data"],
  limit: [429, "超过发布或举报限额", "Publication or reporting quota exceeded"],
  full: [507, "分享站空间已满", "Share storage is full"],
  busy: [503, "分享服务暂时不可用", "Share service temporarily unavailable"]
};
const encoder = new TextEncoder();
const HEADER_FIELDS = "id,title,description,created_at,updated_at,expires_at,bytes,status,reports,revision";
const json_headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

class ShareError extends Error {}
function fail(code) { throw new ShareError(code); }
function json(body, status = 200) { return Response.json(body, { status, headers: json_headers }); }
function base64(bytes) {
  const strings = [];
  for (let start = 0; start < bytes.length; start += 8192) strings.push(String.fromCharCode(...bytes.subarray(start, start + 8192)));
  return btoa(strings.join(""));
}
function random_key(size) {
  return base64(crypto.getRandomValues(new Uint8Array(size))).replaceAll("+","-").replaceAll("/","_").replace(/=+$/, "");
}
async function digest(value) {
  return base64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
function bearer(request) { return /^Bearer ([^\s]{1,512})$/i.exec(request.headers.get("Authorization") || "")?.[1] || ""; }
async function check_admin(request, env) {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN) fail("busy");
  if (!token || await digest(token) !== await digest(env.ADMIN_TOKEN)) fail("auth");
}
/**
 * The network an address stands for: an IPv4 address itself, an IPv6 address by its /64, since one home line or server
 * usually holds a whole /64 and could otherwise count as any number of sources.
 */
function source_network(address) {
  if (!address.includes(":")) return address;
  const [head, tail = ""] = address.toLowerCase().split("%")[0].split("::");
  const left = head ? head.split(":") : [], right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map(group => (parseInt(group, 16) || 0).toString(16)).join(":")}::/64`;
}
async function source_hash(request, env) {
  const address = request.headers.get("CF-Connecting-IP");
  if (!env.SOURCE_SALT || !address) fail("busy");
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.SOURCE_SALT), { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(source_network(address)))));
}
async function read_json(request, max = MAX_BYTES) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") fail("media");
  if (Number(request.headers.get("Content-Length")) > max) fail("size");
  const reader = request.body?.getReader();
  if (!reader) fail("invalid");
  let total = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); fail("size"); }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal:true }).decode(await new Blob(chunks).arrayBuffer())); }
  catch { fail("invalid"); }
}
function string_field(value, limit) { return typeof value === "string" && value.length <= limit; }
function record(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function snapshot(input) {
  if (!record(input) || input.format !== 1 || !string_field(input.title, 1000) || !input.title.trim()
      || !string_field(input.description, 4000) || !string_field(input.exported_at, 64) || !Number.isFinite(Date.parse(input.exported_at))
      || typeof input.room_id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.room_id) || !record(input.responses)) fail("invalid");
  const base = "/api/rooms/"+input.room_id;
  const rooms = input.responses["/api/rooms"]?.rooms;
  if (!Array.isArray(rooms) || rooms.length !== 1 || rooms[0]?.id !== input.room_id || input.responses[base]?.id !== input.room_id
      || !Array.isArray(input.responses[base+"/timeline"]?.executions)) fail("invalid");
  for (const path of Object.keys(input.responses)) {
    if (path === "/api/rooms" || path === base || path === base+"/timeline") continue;
    if (!path.startsWith(base+"/") || !/^(?:\/messages\?[^#]*|\/executions\/\d+\/notes)$/.test(path.slice(base.length))) fail("invalid");
  }
  const { format, room_id, title, description, exported_at, responses } = input;
  return { format, room_id, title, description, exported_at, responses };
}
async function encode_snapshot(data) {
  let raw;
  try { raw = JSON.stringify(data); } catch { fail("invalid"); }
  const blob = new Blob([raw]);
  if (blob.size > MAX_BYTES) fail("size");
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  const encoded = base64(new Uint8Array(await new Response(stream).arrayBuffer()));
  const chunks = [];
  for (let offset = 0; offset < encoded.length; offset += CHUNK_BYTES) chunks.push(encoded.slice(offset, offset + CHUNK_BYTES));
  return { bytes: blob.size, chunks };
}
async function decode_chunks(rows) {
  if (!rows.length) return null;
  // Each stored base64 block ends on a four-character boundary.
  const blocks = rows.map(row => {
    const binary = atob(row.content);
    const bytes = new Uint8Array(binary.length);
    for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = binary.charCodeAt(offset);
    return bytes;
  });
  const stream = new Blob(blocks).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}
function rate(db, source, action, hour) {
  return db.prepare("INSERT INTO share_rates VALUES (?,?,?,1) ON CONFLICT(source_hash,action,hour) DO UPDATE SET total=total+1").bind(source,action,hour);
}
function state_check(row, now, visible = true) {
  if (!row) fail("missing");
  if (row.expires_at <= now) fail("expired");
  if (visible && row.status !== "active") fail("hidden");
}
function editable(row, now) {
  state_check(row,now,false);
  if (row.status !== "active") fail("moderated");
}
async function authorize(request, db, id) {
  const token = bearer(request);
  const row = await db.prepare("SELECT token_hash,status,expires_at FROM shares WHERE id=?").bind(id).first();
  if (!row) fail("missing");
  if (!token || row.token_hash !== await digest(token)) fail("auth");
  return row;
}
async function save_share(request, env, id) {
  const db = env.DB;
  if (id) editable(await authorize(request, db, id), new Date().toISOString());
  const input = await read_json(request);
  const data = snapshot(input);
  const days = input.ttl_days === undefined ? 7 : input.ttl_days;
  if (![1,3,7].includes(days)) fail("ttl");
  const { chunks, bytes } = await encode_snapshot(data);
  const source = await source_hash(request, env);
  const now = Date.now(), stamp = new Date(now).toISOString(), expires = new Date(now + days * DAY_MS).toISOString();
  const revision = random_key(16), token = id ? null : random_key(32);
  const share_id = id || random_key(16);
  const header = id
    ? db.prepare("UPDATE shares SET title=?,description=?,updated_at=?,expires_at=?,bytes=?,revision=? WHERE id=? AND status='active' AND expires_at>?")
      .bind(data.title,data.description,stamp,expires,bytes,revision,id,stamp)
    : db.prepare("INSERT INTO shares(id,token_hash,source_hash,title,description,created_at,updated_at,expires_at,bytes,revision) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(share_id,await digest(token),source,data.title,data.description,stamp,stamp,expires,bytes,revision);
  const statements = [header, rate(db,source,"publish",Math.floor(now / 3600000))];
  if (id) statements.push(db.prepare("DELETE FROM share_chunks WHERE share_id=? AND EXISTS(SELECT 1 FROM shares WHERE id=? AND revision=?)").bind(id,id,revision));
  chunks.forEach((chunk, index) => statements.push(db.prepare(
    "INSERT INTO share_chunks SELECT id,?,? FROM shares WHERE id=? AND revision=?").bind(index,chunk,share_id,revision)));
  const [written] = await db.batch(statements);
  if (!written.meta.changes) { editable(await authorize(request,db,id), stamp); fail("busy"); }
  const url = new URL("/s/"+share_id, request.url).href;
  return json({ id:share_id, url, expires_at:expires, ...(token ? { manage_token:token } : {}) }, id ? 200 : 201);
}
async function delete_share(request, db, id) {
  await authorize(request, db, id);
  await db.prepare("DELETE FROM shares WHERE id=?").bind(id).run();
  return json({ ok:true });
}
async function report_share(request, env, id) {
  const input = await read_json(request, 8192);
  if (!string_field(input?.reason,1000) || !input.reason.trim()) fail("invalid");
  const source = await source_hash(request,env);
  const now = Date.now(), stamp = new Date(now).toISOString();
  state_check(await env.DB.prepare("SELECT expires_at,status FROM shares WHERE id=?").bind(id).first(), stamp);
  await env.DB.batch([rate(env.DB,source,"report",Math.floor(now / 3600000)), env.DB.prepare(
    "INSERT OR IGNORE INTO share_reports SELECT id,?,?,? FROM shares WHERE id=? AND status='active' AND expires_at>?")
    .bind(source,input.reason.trim(),stamp,id,stamp)]);
  return json({ ok:true });
}

function escape_html(value) {
  const entities = { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" };
  return String(value).replace(/[&<>"']/g, char => entities[char]);
}
function html_headers(nonce) {
  return { "Content-Type":"text/html; charset=utf-8", "Cache-Control":"private, no-store",
    "Referrer-Policy":"no-referrer", "X-Robots-Tag":"noindex, noarchive", "X-Content-Type-Options":"nosniff",
    "Content-Security-Policy":"default-src 'none'; script-src 'self' 'nonce-"+nonce+
      "'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "+
      "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
}
function render_page(template, data, nonce) {
  const title = escape_html(data.title), description = escape_html(data.description);
  // Parsing JSON as data also preserves keys such as __proto__ as ordinary data.
  const literal = JSON.stringify(JSON.stringify(data)).replace(/[<\u2028\u2029]/g,
    char => "\\u"+char.charCodeAt(0).toString(16).padStart(4,"0"));
  const head = '<meta property="og:title" content="'+title+'"><meta property="og:description" content="'+description+
    '"><meta property="og:type" content="website"><meta name="twitter:card" content="summary">'+
    '<meta name="twitter:title" content="'+title+'"><meta name="twitter:description" content="'+description+'">'+
    '<script nonce="'+nonce+'">window.CODISCUSS_SHARE = JSON.parse('+literal+');</script>';
  // Use callbacks: dollar sequences in titles and messages must survive replacement.
  return template.replace(/<script>/g, () => '<script nonce="'+nonce+'">')
    .replace(/<head>/i, () => "<head>"+head)
    .replace(/<title>[^<]*<\/title>/i, () => "<title>"+title+" · AI CoDiscuss</title>")
    .replace(/<meta name="description" content="[^"]*">/i, () => '<meta name="description" content="'+description+'">')
    .replace("</head>", () => '<script type="module" id="modern-script" src="/modern.js"></script></head>');
}
async function stored_data(db, id, revision) {
  const { results } = await db.prepare("SELECT c.content FROM share_chunks c JOIN shares s ON s.id=c.share_id WHERE s.id=? AND s.revision=? ORDER BY c.position")
    .bind(id, revision).all();
  return decode_chunks(results);
}
async function served_data(request, db, row, ctx) {
  const cache = globalThis.caches?.default;
  const key = new Request(new URL("/_cache/"+row.id+"/"+row.revision+"/"+encodeURIComponent(row.updated_at), request.url));
  const hit = await cache?.match(key);
  if (hit) return hit.json();
  const data = await stored_data(db,row.id,row.revision);
  if (cache && data) {
    const seconds = Math.floor((Date.parse(row.expires_at)-Date.now())/1000);
    if (seconds > 0) ctx.waitUntil(cache.put(key, Response.json(data, { headers:{ "Cache-Control":"public, max-age="+seconds } })).catch(() => {}));
  }
  return data;
}
async function read_page(request, env, ctx, id) {
  // Check visibility before each cache hit. Retry once if an update replaced chunks between the two reads.
  for (let attempt = 0; attempt < 2; attempt++) {
    const row = await env.DB.prepare("SELECT id,status,expires_at,updated_at,revision FROM shares WHERE id=?").bind(id).first();
    state_check(row,new Date().toISOString());
    const data = await served_data(request,env.DB,row,ctx);
    if (!data) continue;
    const asset = await env.ASSETS.fetch(new Request(new URL("/index.html", request.url)));
    if (!asset.ok) fail("busy");
    const nonce = random_key(24);
    return new Response(render_page(await asset.text(),data,nonce), { headers:html_headers(nonce) });
  }
  fail("busy");
}
function iso_filter(value) {
  if (!value) return "";
  const time = /^\d{1,13}$/.test(value) ? Number(value) * (value.length > 10 ? 1 : 1000) : Date.parse(value);
  if (!Number.isFinite(time)) fail("invalid");
  return new Date(time).toISOString();
}
async function admin_list(url, db) {
  const since = iso_filter(url.searchParams.get("since")), status = url.searchParams.get("status") || "";
  if (status && !["active","reported","taken_down"].includes(status)) fail("invalid");
  const cursor = url.searchParams.get("cursor");
  let updated = "", id = "";
  if (cursor) {
    const parts = cursor.split("|");
    if (parts.length !== 2 || !ID_PATTERN.test(parts[1])) fail("invalid");
    updated = iso_filter(parts[0]); id = parts[1];
  }
  const { results } = await db.prepare("SELECT "+HEADER_FIELDS+",moderation_reason, "+
    "(SELECT reason FROM share_reports r WHERE r.share_id=shares.id ORDER BY created_at DESC LIMIT 1) AS latest_report_reason FROM shares "+
    "WHERE updated_at>=? AND (updated_at,id)>(?,?) AND (?='' OR status=?) AND expires_at>? ORDER BY updated_at,id LIMIT 101")
    .bind(since,updated,id,status,status,new Date().toISOString()).all();
  const shares = results.slice(0,100);
  return json({ shares, next_cursor:results.length>100 ? shares.at(-1).updated_at+"|"+shares.at(-1).id : null });
}
async function admin_detail(db, id) {
  const [headers, parts, reports] = await db.batch([
    db.prepare("SELECT "+HEADER_FIELDS+",moderation_reason FROM shares WHERE id=?").bind(id),
    db.prepare("SELECT content FROM share_chunks WHERE share_id=? ORDER BY position").bind(id),
    db.prepare("SELECT reason,created_at FROM share_reports WHERE share_id=? ORDER BY created_at LIMIT 100").bind(id)]);
  const row = headers.results[0];
  state_check(row,new Date().toISOString(),false);
  return json({ share:row, data:await decode_chunks(parts.results), reports:reports.results });
}
async function moderate(request, db, id, action) {
  const now = new Date().toISOString();
  let reason = "";
  if (action === "takedown") {
    const input = await read_json(request,8192);
    if (!string_field(input?.reason,1000) || !input.reason.trim()) fail("invalid");
    reason = input.reason.trim();
  }
  const statement = db.prepare("UPDATE shares SET status=?,moderation_reason=?,updated_at=?,reports=CASE WHEN ?='restore' THEN 0 ELSE reports END WHERE id=? AND expires_at>?")
    .bind(action === "restore" ? "active" : "taken_down", reason, now, action, id, now);
  const statements = [statement];
  if (action === "restore") statements.push(db.prepare("DELETE FROM share_reports WHERE share_id=?").bind(id));
  const [result] = await db.batch(statements);
  if (!result.meta.changes) fail("missing");
  return json({ ok:true });
}
async function admin_route(request, env, url, parts) {
  await check_admin(request,env);
  const [id,action] = parts;
  if (!id && request.method === "GET") return admin_list(url,env.DB);
  if (!ID_PATTERN.test(id) || parts.length > 2) fail("missing");
  if (!action && request.method === "GET") return admin_detail(env.DB,id);
  if (["takedown","restore"].includes(action) && request.method === "POST") return moderate(request,env.DB,id,action);
  fail("missing");
}
function write_method(path) {
  if (path === "/api/shares" || /^\/api\/shares\/[\w-]{22}\/report$/.test(path)) return "POST";
  return /^\/api\/shares\/[\w-]{22}$/.test(path) ? "PUT, DELETE" : "";
}
async function route(request, env, ctx, url) {
  const parts = url.pathname.slice(1).split("/"), method = request.method;
  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "shares") return admin_route(request,env,url,parts.slice(3));
  if (method === "GET" && parts.length === 2 && parts[0] === "s" && ID_PATTERN.test(parts[1])) return read_page(request,env,ctx,parts[1]);
  if ((method === "GET" || method === "HEAD") && PUBLIC_ASSET.test(url.pathname)) return env.ASSETS.fetch(request);
  if (!write_method(url.pathname)) fail("missing");
  if (method === "OPTIONS") return new Response(null, { status:204 });
  if (method === "POST" && parts.length === 2) return save_share(request,env,null);
  if (method === "POST" && parts[3] === "report") return report_share(request,env,parts[2]);
  if (method === "PUT" && parts.length === 3) return save_share(request,env,parts[2]);
  if (method === "DELETE" && parts.length === 3) return delete_share(request,env.DB,parts[2]);
  fail("missing");
}
function error_response(error, request, path) {
  const message = [error?.message, error?.cause?.message].join(" ");
  const code = error instanceof ShareError ? error.message
    : /share_source_quota|share_frequency/.test(message) ? "limit"
    : /share_site_quota|SQLITE_FULL|database or disk is full/i.test(message) ? "full" : "busy";
  const [status,zh,en] = CODE[code];
  const label = /^zh\b/i.test(request.headers.get("Accept-Language") || "") ? zh : en;
  if (path.startsWith("/s/")) return new Response("<!doctype html><meta charset=utf-8><title>AI CoDiscuss</title><p>"+label+"</p>", { status,headers:html_headers(random_key(24)) });
  return json({ error:label, code },status);
}

/** Handle anonymous views, publisher actions and authenticated moderation on the share origin. */
async function fetch_share(request, env, ctx) {
  const url = new URL(request.url);
  let response;
  try { response = await route(request,env,ctx,url); }
  catch (error) { response = error_response(error,request,url.pathname); }
  const methods = write_method(url.pathname);
  if (methods) {
    response.headers.set("Access-Control-Allow-Origin","*");
    if (request.method === "OPTIONS") {
      response.headers.set("Access-Control-Allow-Methods",methods);
      response.headers.set("Access-Control-Allow-Headers","Content-Type, Authorization");
    }
  }
  return response;
}

/** Remove expired shares (children cascade) and previous hourly rate counters. */
async function scheduled(event, env) {
  const now = event.scheduledTime ?? Date.now();
  await env.DB.batch([env.DB.prepare("DELETE FROM shares WHERE expires_at<=?").bind(new Date(now).toISOString()),
    env.DB.prepare("DELETE FROM share_rates WHERE hour<?").bind(Math.floor(now / 3600000))]);
}
export default { fetch: fetch_share, scheduled };

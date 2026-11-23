import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import vm from "node:vm";

import worker, { SHARE_FILE_TYPES } from "../backend/share_worker.mjs";

const ORIGIN = "https://share.example.test";
const DAY = 86400000;
const TEMPLATE = '<html><head><script>window.theme=1</script><title>Local</title><meta name="description" content=""><script src="/app.js"></script></head><body></body></html>';
const schema = readFileSync(new URL("../backend/share_schema.sql",import.meta.url),"utf8");

function d1_statement(sql, values = []) {
  return {
    bind: (...args) => d1_statement(sql,args),
    first: () => sql.get(...values) ?? null,
    all: () => ({ results:sql.all(...values),meta:{changes:0} }),
    run: () => ({ results:[],meta:sql.run(...values) }),
    execute() { return sql.columns().length ? this.all() : this.run(); }
  };
}

// Workers' FixedLengthStream: passes the bytes through and fails when they are not exactly `length`.
globalThis.FixedLengthStream ??= class extends TransformStream {
  constructor(length) {
    let seen = 0;
    super({ transform(chunk, controller) { seen += chunk.byteLength; if (seen > length) throw new Error("too long"); controller.enqueue(chunk); },
      flush() { if (seen !== length) throw new Error("too short"); } });
  }
};
/** An R2 bucket in memory: put, get, delete and list by prefix. */
function memory_bucket() {
  const objects = new Map();
  return { objects,
    async put(key, body, options) { objects.set(key, { bytes:new Uint8Array(await new Response(body).arrayBuffer()), type:options?.httpMetadata?.contentType }); return { key }; },
    async get(key) { const object = objects.get(key); return object ? { body:new Blob([object.bytes]).stream() } : null; },
    async delete(keys) { for (const key of [keys].flat()) objects.delete(key); },
    async list({ prefix }) { return { objects:[...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated:false }; } };
}

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  t.after(() => sqlite.close());
  const DB = { prepare:sql => d1_statement(sqlite.prepare(sql)), async batch(items) {
    sqlite.exec("BEGIN");
    try { const results = items.map(item => item.execute()); sqlite.exec("COMMIT"); return results; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  }};
  const env = { DB, FILES:memory_bucket(), SOURCE_SALT:"fixture-salt", ADMIN_TOKEN:"fixture-admin", ASSETS:{ fetch:req =>
    new Response(new URL(req.url).pathname === "/index.html" ? TEMPLATE : "asset") } };
  const pending = [];
  const call = (method,path,body,token,ip="192.0.2.1") => {
    const headers = { "CF-Connecting-IP":ip, "Content-Type":"application/json", ...(token && { Authorization:"Bearer "+token }) };
    return worker.fetch(new Request(new URL(path,ORIGIN),{ method, headers, body:body === undefined ? undefined : JSON.stringify(body) }),env,{waitUntil:p=>pending.push(p)});
  };
  const publish = async (data = payload()) => {
    const res = await call("POST","/api/shares",data);
    assert.equal(res.status,201);
    return res.json();
  };
  return { sqlite,env,call,publish,pending };
}

function payload(title="Shared room", text="Hello") {
  const room_id = "example", base = "/api/rooms/"+room_id, room = { id:room_id,title };
  return { format:1, room_id,title,description:"Two members",exported_at:new Date().toISOString(),responses:{
    "/api/rooms":{rooms:[room]}, [base]:room, [base+"/timeline"]:{executions:[]},
    [base+"/messages?after=0"]:{messages:[{id:1,text}]}
  }};
}

test("publishes a nonce-protected page and preserves literal text across chunk boundaries", async t => {
  const f = fixture(t), title = "Room $&", text = randomBytes(680000).toString("base64")+"<tag>\u2028\u2029";
  const data = payload(title,text), share = await f.publish(data);
  assert.match(share.id,/^[\w-]{22}$/);
  assert.match(share.manage_token,/^[\w-]{43}$/);
  assert.equal(share.url,ORIGIN+"/s/"+share.id);
  const { token_hash, source_hash } = f.sqlite.prepare("SELECT token_hash,source_hash FROM shares").get();
  assert.notEqual(token_hash,share.manage_token);
  assert.notEqual(source_hash,"192.0.2.1");
  const { count,max } = f.sqlite.prepare("SELECT COUNT(*) AS count,MAX(length(content)) AS max FROM share_chunks").get();
  assert.ok(count>1 && max<=524288);
  const res = await f.call("GET",share.url), html = await res.text();
  assert.equal(res.status,200);
  assert.match(html,/<title>Room \$&amp; · AI CoDiscuss<\/title>/);
  const [,nonce,script] = html.match(/<script nonce="([^"]+)">(window\.CODISCUSS_SHARE = [\s\S]*?;)<\/script>/);
  assert.match(res.headers.get("Content-Security-Policy"),new RegExp("nonce-"+nonce));
  // Nothing loads from another site, no inline script runs without the nonce, and no form can send anything out.
  const csp = res.headers.get("Content-Security-Policy");
  assert.ok(!/https?:|\*/.test(csp), csp);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), csp);
  assert.match(csp,/form-action 'none'/);
  // Attachments' scripts run only in /frame: an opaque origin that sends no requests, submits no forms and is framed
  // only by this site's own pages.
  const frame = (await f.call("GET","/frame")).headers.get("Content-Security-Policy");
  assert.match(frame,/^sandbox allow-scripts allow-modals;/);
  assert.ok(!/allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(frame), frame);
  assert.match(frame,/connect-src data: blob:;/);
  assert.match(frame,/frame-ancestors 'self'/);
  assert.equal(res.headers.get("Referrer-Policy"),"no-referrer");
  assert.equal(res.headers.get("X-Robots-Tag"),"noindex, noarchive");
  assert.doesNotMatch(script,/[<\u2028\u2029]/);
  const win = {};
  vm.runInNewContext(script,{window:win});
  assert.deepEqual(JSON.parse(JSON.stringify(win.CODISCUSS_SHARE)),data);
  assert.ok(html.indexOf(script)<html.indexOf('src="/app.js"'));
  assert.match(html,/type="module" id="modern-script" src="\/modern.js"/);
});

/** The payload with its message listing these attachments ({ id, file_name, content_type }). */
function with_files(files, attachments, sent) {
  const data = payload();
  data.responses["/api/rooms/example/messages?after=0"].messages[0].attachments = files.map(file => ({ room_id: "example", ...file }));
  return { ...data, ...(attachments ? { attachments } : {}), ...(sent ? { files:sent } : {}) };
}

test("included attachments are kept as this room's data URLs; any other route or value is refused", async t => {
  const f = fixture(t), route = "/api/rooms/example/attachments/a1/content", file = "data:text/html;base64,PGI+aGk8L2I+";
  const listed = [{ id: "a1", file_name: "demo.html", content_type: "text/html" }];
  const share = await f.publish(with_files(listed, { [route]: file }));
  const html = await (await f.call("GET", share.url)).text();
  const win = {};
  vm.runInNewContext(html.match(/<script nonce="[^"]+">(window\.CODISCUSS_SHARE = [\s\S]*?;)<\/script>/)[1], { window: win });
  assert.deepEqual(JSON.parse(JSON.stringify(win.CODISCUSS_SHARE.attachments)), { [route]: file });
  // Review lists attachments instead of inlining them, and hands each over only as a download.
  const admin = "/api/admin/shares/"+share.id;
  const detail = await (await f.call("GET", admin, undefined, f.env.ADMIN_TOKEN)).json();
  assert.deepEqual(detail.data.attachments, [{ route, content_type: "text/html", bytes: 9 }]);
  const download = await f.call("GET", admin+"/attachment?route="+encodeURIComponent(route), undefined, f.env.ADMIN_TOKEN);
  assert.equal(download.headers.get("Content-Disposition"), "attachment");
  assert.equal(await download.text(), "<b>hi</b>");
  assert.equal((await f.call("GET", admin+"/attachment?route="+encodeURIComponent(route), undefined, share.manage_token)).status, 403);
  for (const attachments of [{ "/api/rooms/other/attachments/a1/content": file }, { [route]: "https://example.com/a.png" },
    { [route]: "data:text/html,<script>" }, { "/api/rooms/example/files/a1": file }, [file]]) {
    assert.equal((await f.call("POST", "/api/shares", with_files(listed, attachments))).status, 400);
  }
  // Only kinds the site takes, named by their message with the type their extension gives: a program declared as text,
  // a file no message lists, or a type its extension does not give is refused.
  const text = "data:text/plain;base64,aGk=";
  for (const [files, attachments] of [
    [[{ id: "a1", file_name: "setup.exe", content_type: "text/plain" }], { [route]: text }],
    [[{ id: "a1", file_name: "notes.rar", content_type: "application/vnd.rar" }], { [route]: "data:application/vnd.rar;base64,aGk=" }],
    [[], { [route]: text }],
    [[{ id: "a1", file_name: "notes.txt", content_type: "text/plain" }], { [route]: file }],
    [[{ id: "a1", file_name: "notes.txt", content_type: "text/html" }], { [route]: text }]]) {
    const refused = await f.call("POST", "/api/shares", with_files(files, attachments));
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /share site takes only/);
  }
  assert.equal((await f.call("POST", "/api/shares", with_files([{ id: "a1", file_name: "notes.TXT", content_type: "text/plain" }], { [route]: text }))).status, 201);
});

test("attachments sent as files: listed with the page, uploaded exactly as listed, read by its page, gone with the version", async t => {
  const f = fixture(t), route = "/api/rooms/example/attachments/a1/content";
  const listed = [{ id:"a1", file_name:"clip.mp4", content_type:"video/mp4" }];
  const share = await f.publish(with_files(listed, undefined, { [route]:{ content_type:"video/mp4", bytes:5 } }));
  assert.ok(share.revision);
  const upload = (body, { token = share.manage_token, revision = share.revision, type = "video/mp4", file = "a1", id = share.id } = {}) =>
    worker.fetch(new Request(new URL("/api/shares/"+id+"/files/"+file+"?revision="+revision, ORIGIN), { method:"PUT", body,
      headers:{ "CF-Connecting-IP":"192.0.2.1", "Content-Type":type, "Content-Length":String(body.length), Authorization:"Bearer "+token } }), f.env, { waitUntil:p=>f.pending.push(p) });
  const read = () => f.call("GET", "/s/"+share.id+"/files/a1");
  assert.equal((await read()).status, 404, "not readable before it is uploaded");
  assert.equal((await upload(new Uint8Array(5), { token:"wrong" })).status, 403);
  assert.equal((await upload(new Uint8Array(5), { revision:"old" })).status, 409);
  assert.equal((await upload(new Uint8Array(5), { type:"text/html" })).status, 400);
  assert.equal((await upload(new Uint8Array(6))).status, 413);
  assert.equal((await upload(new Uint8Array(5), { file:"a2" })).status, 404);
  assert.equal((await upload(new Uint8Array([1,2,3,4,5]))).status, 200);
  const file = await read();
  assert.equal(file.status, 200);
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [1,2,3,4,5]);
  assert.equal(file.headers.get("Content-Disposition"), "attachment");
  assert.match(file.headers.get("Content-Security-Policy"), /^sandbox;/);
  // Review lists it and hands it over as a download.
  const detail = await (await f.call("GET", "/api/admin/shares/"+share.id, undefined, f.env.ADMIN_TOKEN)).json();
  assert.deepEqual(detail.data.attachments, [{ route, content_type:"video/mp4", bytes:5 }]);
  assert.equal((await f.call("GET", "/api/admin/shares/"+share.id+"/attachment?route="+encodeURIComponent(route), undefined, f.env.ADMIN_TOKEN)).status, 200);
  // Publishing again lists the files anew and removes the old version's.
  const again = await (await f.call("PUT", "/api/shares/"+share.id, with_files(listed, undefined, { [route]:{ content_type:"video/mp4", bytes:5 } }), share.manage_token)).json();
  await Promise.all(f.pending);
  assert.notEqual(again.revision, share.revision);
  assert.equal(f.env.FILES.objects.size, 0);
  assert.equal((await read()).status, 404);
  // More than 100 MB in all, or a file no message lists, is refused with the page.
  assert.equal((await f.call("POST", "/api/shares", with_files(listed, undefined, { [route]:{ content_type:"video/mp4", bytes:100 * 1024 * 1024 + 1 } }))).status, 413);
  assert.equal((await f.call("POST", "/api/shares", with_files([], undefined, { [route]:{ content_type:"video/mp4", bytes:5 } }))).status, 400);
  // Revoking removes the files too.
  await upload(new Uint8Array(5), { revision:again.revision });
  assert.equal(f.env.FILES.objects.size, 1);
  await f.call("DELETE", "/api/shares/"+share.id, undefined, share.manage_token);
  assert.equal(f.env.FILES.objects.size, 0);
});

test("the page and the share site take the same kinds of attachment", async () => {
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const listed = source.match(/const SHARE_SITE_FILE_TYPES = (\{[\s\S]*?\n\});/)[1];
  assert.deepEqual({ ...vm.runInNewContext("(" + listed + ")") }, { ...SHARE_FILE_TYPES });
});

test("renewal, management credentials, revocation and expiration", async t => {
  const f = fixture(t), share = await f.publish({...payload(),ttl_days:1}), path="/api/shares/"+share.id;
  const tomorrow = Date.now()+DAY;
  assert.ok(Math.abs(Date.parse(share.expires_at)-tomorrow)<3000);
  for (const method of ["PUT","DELETE"]) assert.equal((await f.call(method,path,method==="PUT"?payload():undefined,"wrong")).status,403);
  assert.equal((await f.call("PUT",path,{...payload(),ttl_days:8},share.manage_token)).status,400);
  const started = Date.now(), res = await f.call("PUT",path,{...payload("Updated"),ttl_days:7},share.manage_token);
  assert.equal(res.status,200);
  const updated = await res.json();
  assert.ok(Date.parse(updated.expires_at)>=started+7*DAY && Date.parse(updated.expires_at)<=Date.now()+7*DAY);
  assert.equal(updated.id,share.id);
  assert.match(await (await f.call("GET",share.url)).text(),/<title>Updated/);
  assert.equal((await f.call("DELETE",path,undefined,share.manage_token)).status,200);
  assert.equal((await f.call("GET",share.url)).status,404);
  const expires = await f.publish();
  f.sqlite.prepare("UPDATE shares SET expires_at=? WHERE id=?").run(new Date(Date.now()-DAY).toISOString(),expires.id);
  assert.equal((await f.call("GET",expires.url)).status,410);
  assert.equal((await f.call("PUT","/api/shares/"+expires.id,payload(),expires.manage_token)).status,410);
  await worker.scheduled({scheduledTime:Date.now()},f.env);
  assert.equal((await f.call("GET",expires.url)).status,404);
  for (const table of ["shares","share_chunks"]) assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM "+table).get().n,0);
});

test("size and source quotas reject concurrent writes without creating partial shares", async t => {
  const f = fixture(t);
  assert.equal((await f.call("POST","/api/shares",payload("Large","x".repeat(5_242_880)))).status,413);
  const results = await Promise.all(Array.from({length:22},()=>f.call("POST","/api/shares",payload())));
  assert.equal(results.filter(res=>res.status===201).length,20);
  assert.equal(results.filter(res=>res.status===429).length,2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(DISTINCT share_id) AS n FROM share_chunks").get().n,20);
  assert.equal((await f.call("POST","/api/shares",payload(),null,"192.0.2.2")).status,201);
});

test("source byte cap and site cap roll back new or enlarged shares", async t => {
  const f = fixture(t), first = await f.publish();
  const row = f.sqlite.prepare("SELECT * FROM shares WHERE id=?").get(first.id);
  const insert = f.sqlite.prepare("INSERT INTO shares(id,token_hash,source_hash,title,description,created_at,updated_at,expires_at,bytes,revision) VALUES (?,'dummy',?,'','','',?,?,?,'v')");
  for (let n=0;n<10;n++) insert.run("fixture"+n,row.source_hash,row.updated_at,row.expires_at,n===9?5_242_880-row.bytes:5_242_880);
  assert.equal((await f.call("PUT","/api/shares/"+first.id,payload("Larger","x".repeat(200)),first.manage_token)).status,429);
  assert.equal(f.sqlite.prepare("SELECT title FROM shares WHERE id=?").get(first.id).title,row.title);
  for (let remaining=5_000_000_000-52_428_800;remaining>0;remaining-=5_242_880) insert.run("extra"+remaining,"bucket"+remaining,row.updated_at,row.expires_at,Math.min(remaining,5_242_880));
  assert.equal((await f.call("POST","/api/shares",payload(),null,"192.0.2.3")).status,507);
  assert.equal((await f.call("GET",first.url)).status,200);
});

test("distinct reports suspend a share, operators can inspect, take down and restore", async t => {
  const f = fixture(t), share = await f.publish(), path="/api/shares/"+share.id, admin="/api/admin/shares";
  const report = ip=>f.call("POST",path+"/report",{reason:"Review requested"},null,ip);
  await report("192.0.2.2"); await report("192.0.2.2"); await report("192.0.2.3");
  assert.equal((await f.call("GET",share.url)).status,200);
  assert.equal((await report("192.0.2.4")).status,200);
  assert.equal((await f.call("GET",share.url)).status,410);
  assert.equal((await f.call("GET",admin,undefined,share.manage_token)).status,403);
  const list = await (await f.call("GET",admin+"?since=0&status=reported",undefined,f.env.ADMIN_TOKEN)).json();
  assert.equal(list.shares[0].id,share.id);
  assert.equal(list.shares[0].reports,3);
  assert.equal(list.shares[0].latest_report_reason,"Review requested");
  assert.equal(list.shares[0].responses,undefined);
  const detail = await (await f.call("GET",admin+"/"+share.id,undefined,f.env.ADMIN_TOKEN)).json();
  assert.equal(detail.data.title,"Shared room");
  assert.equal(detail.reports.length,3);
  const takedown = admin+"/"+share.id+"/takedown", restore = admin+"/"+share.id+"/restore";
  assert.equal((await f.call("POST",restore,undefined,share.manage_token)).status,403);
  assert.equal((await f.call("POST",takedown,{reason:"Needs review"},f.env.ADMIN_TOKEN)).status,200);
  assert.equal((await f.call("PUT",path,payload(),share.manage_token)).status,409);
  assert.equal((await f.call("POST",restore,undefined,f.env.ADMIN_TOKEN)).status,200);
  assert.equal((await f.call("GET",share.url)).status,200);
});

test("cross-origin publisher actions, private template, asset allowlist, cache visibility and rate limits", async t => {
  const f = fixture(t), entries = new Map(), original = globalThis.caches;
  globalThis.caches = {default:{match:async k=>entries.get(k.url)?.clone(),put:async(k,r)=>entries.set(k.url,r)}};
  t.after(()=>{if (original) globalThis.caches=original; else delete globalThis.caches;});
  const share = await f.publish(), path="/api/shares/"+share.id;
  assert.equal((await f.call("OPTIONS",path)).headers.get("Access-Control-Allow-Origin"),"*");
  assert.equal((await f.call("OPTIONS","/api/admin/shares")).headers.get("Access-Control-Allow-Origin"),null);
  for (const url of ["/","/index.html","/admin.js","/api/rooms"]) assert.equal((await f.call("GET",url)).status,404);
  for (const url of ["/modern.js","/katex/katex.min.css","/icons/user.svg"]) assert.equal((await f.call("GET",url)).status,200);
  await f.call("GET",share.url); await Promise.all(f.pending);
  assert.equal(entries.size,1);
  await f.call("PUT",path,payload("Revised"),share.manage_token);
  assert.match(await (await f.call("GET",share.url)).text(),/<title>Revised/);
  for (let n=0;n<10;n++) assert.equal((await f.call("POST",path+"/report",{reason:"check"})).status,200);
  assert.equal((await f.call("POST",path+"/report",{reason:"check"})).status,429);
  await f.call("DELETE",path,undefined,share.manage_token);
  assert.equal((await f.call("GET",share.url)).status,404);
});

test("the page's own publish, update and revoke work against the share site, and the published page loads the room", async t => {
  const f = fixture(t);
  f.env.ASSETS = { fetch: req => new Response(new URL(req.url).pathname === "/index.html" ? readFileSync(new URL("../web/index.html", import.meta.url), "utf8") : "asset") };
  const source = readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/\nrestore_theme\(\);[\s\S]*$/, "");
  const storage = new Map();
  let kept = null;
  const context = vm.createContext({ window: {}, document: { documentElement: { dataset: {}, classList: { toggle() {} } }, getElementById: () => null, querySelectorAll: () => [],
    createElement: () => ({}), head: { append() {} }, dispatchEvent() {} }, crypto: globalThis.crypto, URL, URLSearchParams, AbortSignal, Blob, setTimeout: () => 0, clearTimeout: () => {},
    navigator: { clipboard: { writeText: async () => {} } }, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    // The page talks to the share site; here the site is the Worker itself.
    // The page talks to the share site (here the Worker itself) and keeps the link with its room on the computer.
    fetch: async (url, options = {}) => {
      if (url === "/api/rooms/example/share-link") {
        if (options.method === "POST") kept = JSON.parse(options.body).link;
        return new Response(JSON.stringify({ link: kept }), { headers: { "Content-Type": "application/json" } });
      }
      return f.call(options.method, new URL(url).pathname, options.body ? JSON.parse(options.body) : undefined, options.headers.Authorization?.slice(7));
    } });
  vm.runInContext(`${source}\nglobalThis.set_draft = (draft) => { share_draft = draft; };`, context);
  const notes = [];
  context.notify = (level, message) => notes.push([level, message]);
  context.publish_view = () => {};
  const draft = payload("Room $& 分享", "Hello");
  context.set_draft({ ...draft, spots: [] });
  await context.share_publish(1);
  const link = kept;
  assert.deepEqual(notes.filter(([level]) => level === "error"), []);
  const page = await f.call("GET", new URL(link.url).pathname);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Room $&amp; 分享") && /window\.CODISCUSS_SHARE\s*=/.test(html), "the page carries the room and its title as written");
  context.set_draft({ ...payload("Room", "Updated"), spots: [] });
  await context.share_publish(7);
  assert.equal(kept.share_id, link.share_id, "updating keeps the same link");
  assert.match(await (await f.call("GET", new URL(link.url).pathname)).text(), /Updated/);
  await context.share_revoke("example");
  assert.equal(kept, null);
  assert.equal((await f.call("GET", new URL(link.url).pathname)).status, 404);
});

test("addresses in one IPv6 /64 count as one source, so changing address neither suspends a share nor escapes quotas", async t => {
  const f = fixture(t), share = await f.publish(), path = "/api/shares/" + share.id;
  const report = ip => f.call("POST", path + "/report", { reason: "Review requested" }, null, ip);
  // Three spellings and hosts inside 2001:db8:1:2::/64 are one source; a different /64 is another.
  await report("2001:db8:1:2::1"); await report("2001:0db8:0001:0002:ffff::9"); await report("2001:DB8:1:2:abcd:1:2:3");
  assert.equal((await f.call("GET", share.url)).status, 200, "one /64 is one report");
  await report("2001:db8:1:3::1"); await report("192.0.2.9");
  assert.equal((await f.call("GET", share.url)).status, 410, "three different networks still suspend it");
});

test("renewing gives a new lifetime without new content, and only with the share's own token", async t => {
  const f = fixture(t), share = await f.publish(), path = "/api/shares/" + share.id + "/renew";
  assert.equal((await f.call("POST", path, { ttl_days: 3 }, "wrong-token")).status, 403);
  assert.equal((await f.call("POST", path, { ttl_days: 30 }, share.manage_token)).status, 400);
  const renewed = await (await f.call("POST", path, { ttl_days: 3 }, share.manage_token)).json();
  const left = Date.parse(renewed.expires_at) - Date.now();
  assert.ok(left > 2.9 * DAY && left <= 3 * DAY, "the new lifetime counts from now");
  assert.equal((await f.call("GET", share.url)).status, 200, "the content stays as published");
});

// One normal path of "Deploy as website" on this computer: a member stages and publishes a built folder of a room whose
// launch configuration has the real shape (`cwd`, `participants` keyed by member name). The site service and the room
// website are stand-ins, so the official service code (codiscuss_site) is not needed here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { relayed_command } from "../runner/remote_launch.mjs";
import { site_command } from "../runner/site_deploy.mjs";

const ROOM = "room0001";
const SITE = "http://room.test";
const ORIGIN = "https://sites.test";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "site-deploy-"));
  const home = join(base, "home"), project = join(base, "project"), runtime = join(base, "runtime");
  for (const dir of [home, join(project, "dist", "assets"), runtime]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(project, "dist", "index.html"), "<!doctype html><title>demo</title><script src=\"/assets/app.js\"></script>");
  writeFileSync(join(project, "dist", "assets", "app.js"), "console.log(1);");
  writeFileSync(join(runtime, "task.json"), "{}");
  const config = join(base, "launch.json");
  writeFileSync(config, JSON.stringify({ room: ROOM, site: SITE, token: "owner-token", cwd: project, directory: runtime,
    participants: { Claude: { label: "Opus", project_access: "write" } } }));
  writeFileSync(join(home, "rooms.json"), JSON.stringify({ configs: [config] }));
  return { base, home, project, runtime };
}

/** Stand-ins for the site service and the room website, recording what reached each. */
function fake_network() {
  const calls = [];
  const files = new Map();
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetcher = async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    calls.push({ origin, method: init.method || "GET", path: pathname, headers: init.headers || {} });
    if (origin === SITE) return reply(pathname.endsWith("/sites") && init.method === "POST" ? { ok: true, stage_id: JSON.parse(init.body).stage_id } : { sites: [], stages: [] });
    if (pathname === "/api/devices") return reply({ device_id: "dev_1", device_token: "secret-device-token" });
    if (pathname === "/api/sites") return reply({ id: "abcdefghij", url: "https://abcdefghij.sites.test" });
    if (/\/versions$/.test(pathname)) return reply({ version: 1 });
    if (/\/files\//.test(pathname)) { files.set(decodeURIComponent(pathname.split("/files/")[1]), init.body); return reply({ ok: true }); }
    if (/\/activate$/.test(pathname)) return reply({ url: "https://abcdefghij.sites.test", current_version: 1, previous_version: 0, file_count: files.size, bytes: 40, status: "active", expires_at: new Date(Date.now() + 7 * 864e5).toISOString() });
    return reply({ error: "unexpected" }, 404);
  };
  return { fetcher, calls, files };
}

test("a member stages and publishes a built folder of its room", async () => {
  const { base, home, runtime } = setup();
  try {
    const net = fake_network();
    const options = { fetcher: net.fetcher, sites_origin: ORIGIN };
    const staged = await site_command(home, "site-stage", { room_id: ROOM, dir: "dist", member: "Claude", execution_id: 7 }, options);
    assert.equal(staged.file_count, 2);
    const published = await site_command(home, "site-publish", { room_id: ROOM, stage_id: staged.stage_id, member: "Claude", execution_id: 7 }, options);
    assert.equal(published.url, "https://abcdefghij.sites.test");
    assert.deepEqual([...net.files.keys()].sort(), ["assets/app.js", "index.html"]);
    // The room records the site with the owner's credential, never the device token.
    const room_writes = net.calls.filter((call) => call.origin === SITE && call.method === "POST");
    assert.ok(room_writes.length >= 2);
    assert.ok(room_writes.every((call) => call.headers["X-Discussion-Token"] === "owner-token"));
    // The launch's runtime folder (task files, credentials) is not something a member can publish.
    await assert.rejects(site_command(home, "site-stage", { room_id: ROOM, dir: runtime, member: "Claude" }, options));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the deploy dialog's preview stage leaves no waiting card in the room until it is published", async () => {
  const { base, home } = setup();
  try {
    const net = fake_network();
    const options = { fetcher: net.fetcher, sites_origin: ORIGIN };
    const room_writes = () => net.calls.filter((call) => call.origin === SITE && call.method === "POST").length;
    const staged = await site_command(home, "site-stage", { room_id: ROOM, dir: "dist", member: "Claude", execution_id: 7, preview: true }, options);
    assert.equal(room_writes(), 0, "only opening the dialog writes nothing to the room");
    const published = await site_command(home, "site-publish", { room_id: ROOM, stage_id: staged.stage_id, member: "Claude", execution_id: 7 }, options);
    assert.equal(published.url, "https://abcdefghij.sites.test");
    assert.ok(room_writes() >= 1, "a confirmed deploy is recorded as the answer's site");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

function diagnostic_fixture(t) {
  const { base, home } = setup();
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const id = "abcdefghij";
  const url = `https://${id}.sites.test`;
  const identity = { device_id: "diagnostic-fixture", device_token: "private-device-fixture" };
  const digest = value => createHash("sha256").update(value).digest("hex");
  const manifest_file = (path, content) => ({ path, bytes: Buffer.byteLength(content), sha256: digest(content) });
  const state = { active: 1, staged: 1, uploaded: 2, registered: 1, source_room: ROOM, wrong_asset: false, old_worker: false };
  const fetcher = async (target, { method, headers, redirect } = {}) => {
    assert.equal(method, "GET", "diagnostics may not write, register, or synchronize");
    const { origin, pathname } = new URL(target);
    const html = `<h1>v${state.active}</h1>`, script = `console.log(${state.active});`;
    if (origin === url) {
      assert.equal(headers?.Authorization, undefined);
      assert.equal(headers?.["X-Discussion-Token"], undefined);
      assert.equal(redirect, "manual");
      return new Response(pathname === "/" ? html : state.wrong_asset ? "wrong bytes" : script);
    }
    if (origin === SITE) {
      assert.equal(pathname, `/api/rooms/${ROOM}/sites`);
      assert.equal(headers["X-Discussion-Token"], undefined);
      return Response.json({ sites: state.registered ? [{ site_id: id, room_id: ROOM, current_version: state.registered,
        status: "active" }] : [], stages: [{ site_id: id, stage_id: "staged-bundle", ready: true, file_count: 2, bytes: 28 }] });
    }
    assert.equal(origin, ORIGIN);
    assert.equal(headers.Authorization, `Bearer ${identity.device_token}`);
    if (state.old_worker && pathname === "/api/sites") return Response.json({ sites: [
      { id, url, status: "active", current_version: state.active, source: { room: state.source_room } },
    ] });
    assert.equal(pathname, `/api/sites/${id}/diagnostics`);
    if (state.old_worker) return Response.json({ code: "missing" }, { status: 404 });
    return Response.json({ site_id: id, url, source_room: state.source_room, status: "active", active_version: state.active,
      manifest: { version: state.staged, status: state.staged === state.active ? "ready" : "uploading",
        file_count: 2, uploaded: state.uploaded, bytes: 28 },
      samples: { entry: manifest_file("index.html", html), asset: manifest_file("assets/app.js", script) } });
  };
  return { state, enable_identity() { writeFileSync(join(home, "site-devices.json"), JSON.stringify({ [ORIGIN]: identity })); },
    diagnose: () => site_command(home, "site-diagnose", { room_id: ROOM, site_id: id }, { fetcher, sites_origin: ORIGIN }) };
}

test("diagnostics compare two deployments, partial upload, stale registration, and inconsistent public bytes", async t => {
  const f = diagnostic_fixture(t);
  await assert.rejects(f.diagnose(), { code: "auth" });
  f.enable_identity();
  const v1 = await f.diagnose();
  assert.equal(v1.last_confirmed_stage, "public_samples_verified");
  assert.equal(v1.registration.stage.stage_id, "staged-bundle");
  assert.equal(v1.probes.entry.status, "match");
  assert.equal(v1.probes.asset.status, "match");
  assert.doesNotMatch(JSON.stringify(v1), /private-device-fixture|owner-token/);

  Object.assign(f.state, { staged: 2, uploaded: 1 });
  const partial = await f.diagnose();
  assert.equal(partial.last_confirmed_stage, "upload_partial");
  assert.equal(partial.remote.manifest.version, 2);
  assert.equal(partial.remote.active_version, 1);
  assert.deepEqual(partial.probes, v1.probes, "probe the live version while the new manifest is still uploading");
  f.state.uploaded = 2;
  assert.equal((await f.diagnose()).last_confirmed_stage, "upload_complete");

  f.state.active = 2;
  const stale = await f.diagnose();
  assert.equal(stale.last_confirmed_stage, "remote_activated");
  assert.equal(stale.registration.version, 1);
  assert.equal(stale.registration_matches_active, false);
  assert.equal(stale.probes.entry.status, "match");
  assert.notEqual(stale.probes.entry.actual_sha256, v1.probes.entry.actual_sha256);

  Object.assign(f.state, { registered: 2, wrong_asset: true });
  const mismatch = await f.diagnose();
  assert.equal(mismatch.last_confirmed_stage, "room_registered");
  assert.equal(mismatch.probes.entry.status, "match");
  assert.equal(mismatch.probes.asset.status, "mismatch");
  assert.notEqual(mismatch.probes.asset.actual_sha256, mismatch.probes.asset.expected_sha256);
  f.state.wrong_asset = false;
  assert.equal((await f.diagnose()).last_confirmed_stage, "public_samples_verified");
});

test("diagnostics preserve room scope and report unavailable manifest evidence from older Workers", async t => {
  const f = diagnostic_fixture(t);
  f.enable_identity();
  Object.assign(f.state, { registered: 0, source_room: "other-room" });
  await assert.rejects(f.diagnose(), { code: "auth" });
  Object.assign(f.state, { registered: 1, source_room: ROOM, old_worker: true });
  const report = await f.diagnose();
  assert.equal(report.remote.details_available, false);
  assert.equal(report.remote.active_version, 1);
  assert.equal(report.probes.entry.status, "unverified");
  assert.equal(report.probes.asset, null);
  assert.equal(report.last_confirmed_stage, "room_registered");
  assert.equal(relayed_command(SITE, "site-diagnose", { room_id: ROOM, site: "https://external.test" }).input.site, SITE);
});

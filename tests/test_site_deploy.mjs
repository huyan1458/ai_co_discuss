// One normal path of "Deploy as website" on this computer: a member stages and publishes a built folder of a room whose
// launch configuration has the real shape (`cwd`, `participants` keyed by member name). The site service and the room
// website are stand-ins, so the official service code (codiscuss_site) is not needed here.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

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

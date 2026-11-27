/**
 * Test fixture for external members: two computers on one machine. Computer B runs a real Python site for its rooms and
 * answers relayed requests with its own runner code; a loopback HTTP server stands in for B's online site (the Pages
 * Worker plus its relay Durable Object) and only passes ciphertext to B; computer A has its own service directory and a
 * fake AI that does nothing but run `codiscuss` commands. Only temporary directories are used; no real AI software runs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { listen_local } from './local_port.mjs';
import { software_device } from './passkey_authenticator.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CLI = join(ROOT, 'runner', 'codiscuss.mjs');
const PYTHON_START_MS = 20000;
const REQUEST_TIMEOUT_MS = 15000;
const RELAY_ROUTE = /^\/api\/machines\/([A-Za-z0-9_-]+)\/([a-z-]+)$/;

/** A fresh temporary service directory removed after the test; `local-settings.json` is written when a port is known. */
export function temp_home(t, label) {
  const home = mkdtempSync(join(tmpdir(), `codiscuss-ext-${label}-`));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 10 }));
  return home;
}

/** The Python command the tests use, the same choice setup makes. */
export function python_command() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Start a computer's local Python site on a loopback port (free by default) with its database inside `home`, and point
 * that service directory at it so runner code (relay, gateway) reaches this site; `local_launch` lets its own pages run
 * local commands, as `codiscuss local` does. Resolves to `{ port, url, logs }`.
 */
export async function start_python_site(t, home, extra_env = {}, { port: requested_port = 0, local_launch = false } = {}) {
  const database = join(home, 'site.sqlite3');
  const script = "import sys; from backend.server import DiscussionServer,init_database; init_database(sys.argv[1],seed=False); "
    + "server=DiscussionServer(('127.0.0.1',int(sys.argv[2])),sys.argv[1],local_launch=sys.argv[3]=='1'); print(server.server_port,flush=True); server.serve_forever()";
  const child = spawn(python_command(), ['-u', '-c', script, database, String(requested_port), local_launch ? '1' : '0'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DISCUSS_SERVICE_HOME: home, PYTHONDONTWRITEBYTECODE: '1', ...extra_env } });
  const logs = [];
  child.stderr.on('data', chunk => logs.push(String(chunk)));
  const closed = new Promise(done => child.once('close', done));
  t.after(async () => { child.kill(); await closed; });
  const port = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Python site did not start:\n${logs.join('')}`)), PYTHON_START_MS);
    child.stdout.once('data', chunk => { clearTimeout(timer); done(Number(String(chunk).trim())); });
    child.once('error', fail);
    child.once('close', code => fail(new Error(`Python site exited ${code}:\n${logs.join('')}`)));
  });
  const settings_path = join(home, 'local-settings.json');
  const settings = existsSync(settings_path) ? JSON.parse(readFileSync(settings_path, 'utf8')) : {};
  writeFileSync(settings_path, JSON.stringify({ ...settings, port, python: python_command() }));
  return { port, url: `http://127.0.0.1:${port}`, logs };
}

/** One JSON request; resolves to `{ status, body }` for successes and refusals alike. */
export async function site_json(base, path, { method, body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { 'X-Discussion-Token': token } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { text }; }
  return { status: response.status, body: parsed };
}

/**
 * Create a free room on B's site with a host member, returning the owner credential and helpers bound to the room:
 * `say(text, extra)` posts as the user, `view()` reads the room, `events()` reads the event log.
 */
export async function create_room(base, { title = '外部成员测试', goal = '借用另一台电脑的 AI 只读本项目', members } = {}) {
  const owner = randomUUID().replaceAll('-', '');
  const host_token = randomUUID().replaceAll('-', '');
  const created = await site_json(base, '/api/rooms', { token: owner, body: { title, goal, mode: 'free', submission_id: `ext-room-${randomUUID()}`,
    members: members ?? [{ name: 'Claude', adapter: 'claude', token: host_token }] } });
  if (created.status !== 201) throw new Error(`room not created: ${created.status} ${JSON.stringify(created.body)}`);
  const room = created.body, path = `/api/rooms/${room.id}`;
  return {
    room, owner, host_token, path,
    say: (text, extra = {}) => site_json(base, `${path}/messages`, { token: owner, body: { author: '用户', text, submission_id: randomUUID(), ...extra } }),
    view: () => site_json(base, path, { token: owner }).then(answer => answer.body),
    events: () => site_json(base, `${path}/events`, { token: owner }).then(answer => answer.body),
    messages: () => site_json(base, `${path}/messages?after=0`, { token: owner }).then(answer => answer.body.messages ?? []),
  };
}

/**
 * B's pairing with its online site, as `codiscuss` keeps it after connecting: id, token and both key pairs. On Windows
 * the file is sealed with DPAPI for the current user, as in production.
 */
export async function machine_identity(home, site) {
  const { keyed_links, machine_link } = await import('../runner/remote_launch.mjs');
  machine_link(home, site);
  return keyed_links(home).sites[new URL(site).origin];
}

/** The AES-GCM key shared with computer `public_key` from a fresh ephemeral key; mirrors `seal_relay_request` in web/app.js. */
async function ephemeral_cipher(public_key) {
  const { relay_cipher } = await import('../runner/remote_launch.mjs');
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const private_jwk = await crypto.subtle.exportKey('jwk', ephemeral.privateKey);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', ephemeral.publicKey);
  return { key: await relay_cipher(private_jwk, public_key), public_jwk: { kty, crv, x, y } };
}

/**
 * Seal one request for computer `machine` (`{ id, public_key }`) the way a browser or A's runner does: the body names the
 * computer and the send time, `signer` (a software key, see `external_signer`) signs `${id}
${body}`, and only the
 * computer can open it. `as` picks the plaintext shape: `device` (`device_id`), `external` (`external_id`, an external
 * member's registered key) or `proof` (signature only, for redemption). Without a signer the request goes unsigned.
 */
export async function seal_for_machine(machine, id, request, signer = null, as = 'device') {
  let plain;
  if (signer) {
    const sealed = await signer.seal(id, { ...request, machine: machine.id });
    plain = as === 'external' ? { body: sealed.body, external_id: sealed.device_id, signature: sealed.signature }
      : as === 'proof' ? { body: sealed.body, signature: sealed.signature } : sealed;
  } else {
    plain = { body: JSON.stringify({ ...request, machine: machine.id, sent_at: Date.now() }) };
  }
  const { key, public_jwk } = await ephemeral_cipher(machine.public_key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(id) }, key, new TextEncoder().encode(JSON.stringify(plain)));
  return { key, envelope: { key: public_jwk, iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') } };
}

/** Open the computer's sealed answer to request `id` as `{ status, body }`. */
export async function open_answer(key, id, sealed) {
  const plain = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(sealed.iv, 'base64'), additionalData: new TextEncoder().encode(`${id}:response`) },
    key, Buffer.from(sealed.data, 'base64')));
  return JSON.parse((sealed.encoding === 'gzip' ? gunzipSync(plain) : plain).toString('utf8'));
}

/**
 * An external member's (or device's) P-256 signing key, created in software: `seal(id, request)` signs a relayed request
 * like a paired browser, `public_key` is the JWK B registers and `id` its fingerprint.
 */
export function external_signer(machine_id) {
  return software_device(machine_id);
}

/**
 * Stand-in for B's online site: `POST /api/machines/<id>/<route>` with `{ id, envelope }` is handed to `deliver`, which
 * plays B's runner and returns the sealed answer envelope; the reply is `{ id, status: 'done', response }` as the Worker
 * sends it. The stand-in never holds a key, so everything it records (`frames`) is what the real site would see.
 * `admit(route, payload, request)` may refuse a request before delivery (the Worker's own checks): return a status
 * and message to refuse. `offline: true` answers `{ status: 'offline' }` as the site does when B is not connected.
 * `GET /api/guest/<id>/key` looks up the invited computer in the fixture.
 */
export async function start_fake_relay(t, { deliver = null, admit = null } = {}) {
  const state = { deliver, admit, offline: false, frames: [], refused: [], machines: [] };
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    const pathname = new URL(request.url, 'http://relay').pathname;
    if (request.method === 'GET' && pathname.startsWith('/api/guest/')) {
      const machine = state.machines.find(item => pathname === '/api/guest/' + item.id + '/key');
      return machine ? reply(200, machine) : reply(404, {});
    }
    const match = RELAY_ROUTE.exec(pathname);
    if (request.method !== 'POST' || !match) return reply(404, { error: '地址不存在' });
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: '请求格式无效' }); }
    const [, machine_id, route] = match;
    if (route === 'sync') return reply(200, { launches: [] });
    state.frames.push({ machine_id, route, raw: JSON.stringify(payload), headers: { ...request.headers } });
    const refusal = state.admit ? await state.admit(route, payload, request) : null;
    if (refusal) { state.refused.push({ route, ...refusal }); return reply(refusal.status, { error: refusal.error }); }
    if (state.offline || !state.deliver) return reply(200, { id: payload.id, status: 'offline' });
    try {
      const answer = await state.deliver({ id: payload.id, envelope: payload.envelope }, { machine_id, route, payload });
      return reply(200, { id: payload.id, status: 'done', response: answer.envelope });
    } catch (error) {
      return reply(502, { error: String(error?.message || error) });
    }
  });
  await listen_local(server);
  t.after(() => new Promise(done => { server.closeAllConnections?.(); server.close(done); }));
  return Object.assign(state, { url: `http://127.0.0.1:${server.address().port}`, server });
}

/** What B's online site shows anyone about computer `link`: name, both public keys and that it is online (worker `machine_view`). */
export function public_machine(link) {
  return { id: link.id, name: link.name, projects: [], clients: {}, public_key: link.public_key, sign_key: link.sign_public_key,
    seen_at: Math.floor(Date.now() / 1000), online: true };
}

/**
 * Register a room's private configuration in B's service directory the way a launch does (`rooms.json` lists config
 * files): site, room, owner credential and the project directories it opens. Returns the config path.
 */
export function register_room_config(home, { site, room, token, cwd, extra_directories = [] }) {
  const path = join(home, `room-${room}.json`);
  writeFileSync(path, JSON.stringify({ site, room, token, cwd, extra_directories, participants: {} }));
  const registry = join(home, 'rooms.json');
  const configs = existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')).configs ?? [] : [];
  writeFileSync(registry, JSON.stringify({ configs: [...configs.filter(item => item !== path), path] }));
  return path;
}

/**
 * Deliver relayed frames to B's runner the way its relay connection does (`answer_request` in runner/relay_channel.mjs),
 * reading B's current pairing each time. `answer` replaces the handler, e.g. with the external gateway's.
 */
export async function b_runner_delivery(home, site, { answer = null, options = {} } = {}) {
  const { answer_request } = await import('../runner/relay_channel.mjs');
  const { machine_links } = await import('../runner/remote_launch.mjs');
  const origin = new URL(site).origin;
  return async frame => {
    const link = machine_links(home).sites[origin];
    return (answer ?? answer_request)(home, origin, link, frame, options);
  };
}

/** Send one request through the stand-in site to computer `machine` and open its answer; resolves to `{ status, body }`. */
export async function relay_call(relay_url, machine, request, { signer = null, as = 'device', route = 'relay', id = randomUUID() } = {}) {
  const { key, envelope } = await seal_for_machine(machine, id, request, signer, as);
  const response = await fetch(`${relay_url}/api/machines/${encodeURIComponent(machine.id)}/${route}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, envelope }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const outer = await response.json();
  if (response.status !== 200) return { status: response.status, body: outer, relay: true };
  if (outer.status !== 'done') return { status: 503, body: outer, relay: true };
  return open_answer(key, id, outer.response);
}

/** A project directory for B to open to external members: ordinary files, a secret, an ignored file and a nested repo. */
export function sample_project(root) {
  const project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'data'), { recursive: true });
  writeFileSync(join(project, 'README.md'), '# 示例项目\n\n供外部成员只读的说明文件。\n');
  writeFileSync(join(project, 'src', 'main.js'), 'export const ANSWER = 42; // 外部成员要找到这一行\n');
  writeFileSync(join(project, '.env'), 'API_KEY=sk-should-never-leave\n');
  writeFileSync(join(project, 'id_rsa'), '-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n');
  writeFileSync(join(project, 'data', 'rooms.sqlite3'), 'private room data');
  writeFileSync(join(project, 'ignored.log'), 'ignored by git\n');
  writeFileSync(join(project, '.gitignore'), 'ignored.log\n');
  writeFileSync(join(root, 'outside.txt'), '项目目录之外的文件\n');
  const git = spawnSync('git', ['init', '-q'], { cwd: project, windowsHide: true });
  if (git.status === 0) {
    spawnSync('git', ['add', '-A'], { cwd: project, windowsHide: true });
  }
  return { project, outside: join(root, 'outside.txt'), git: git.status === 0 };
}

/**
 * Write a fake AI for computer A: it runs `codiscuss` with each argument list of `plan` in turn (placeholders `{NAME}` are
 * filled from the environment, e.g. `{CODISCUSS_FAKE_ROOM}`), and appends one JSON line per step to `log`: arguments,
 * exit code, stdout and stderr. It never reads or writes files itself. Returns `{ script, command, log }`; `command` is a
 * `.cmd` wrapper on Windows so it can stand in for an AI tool's executable.
 */
export function write_fake_ai(dir, plan, { name = 'fake-ai' } = {}) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, `${name}.log.jsonl`), script = join(dir, `${name}.mjs`);
  writeFileSync(script, `import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const plan = ${JSON.stringify(plan)};
const fill = value => value.replace(/\\{([A-Z0-9_]+)\\}/g, (_, key) => process.env[key] ?? '');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ started: true, argv: process.argv.slice(2), lockdown: process.env.CODISCUSS_TOOL_LOCKDOWN ?? null }) + '\\n');
let failed = 0;
for (const step of plan) {
  const args = step.map(fill);
  const result = spawnSync(process.execPath, [${JSON.stringify(CLI)}, ...args], { encoding: 'utf8', env: process.env, timeout: 30000, windowsHide: true });
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, status: result.status, stdout: result.stdout, stderr: result.stderr }) + '\\n');
  if (result.status !== 0) failed += 1;
}
process.exit(failed ? 1 : 0);
`);
  let command = script;
  if (process.platform === 'win32') {
    command = join(dir, `${name}.cmd`);
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  }
  return { script, command, log, steps: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [] };
}

/**
 * Run `codiscuss` with `args` for service directory `home` in a child process, without blocking this process (the
 * stand-in site and B's runner answer from here); resolves to `{ status, stdout, stderr, json }`.
 */
export function run_codiscuss(home, args, { env = {}, timeout = 60000, cwd = home, input = null } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, windowsHide: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, DISCUSS_SERVICE_HOME: home, CODISCUSS_LANG: 'zh-CN', PYTHONDONTWRITEBYTECODE: '1', ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    if (input !== null) child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
    const timer = setTimeout(() => child.kill(), timeout);
    child.once('close', status => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { /* Not every command prints JSON. */ }
      resolve({ status, stdout, stderr, json });
    });
  });
}

/**
 * The proof of an invite code for key `raw` (base64url point) at computer `machine_id` (子Task2 合同 §2.1/§4.1):
 * HMAC-SHA256 keyed by the hex sha256 of the normalised code.
 */
export function invite_proof(code, machine_id, raw) {
  const normalised = String(code).toUpperCase().replace(/[^0-9A-Z]/g, '');
  return createHmac('sha256', createHash('sha256').update(normalised).digest('hex')).update(`codiscuss-invite-v1
${machine_id}
${raw}`).digest('base64url');
}

/** sha256 hex of a string, as the site stores invite codes and credentials. */
export function sha256_hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Wait until `check()` returns a truthy value or `limit` ms pass; resolves to the value, or throws with `label`. */
export async function until(check, { limit = 10000, every = 100, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise(done => setTimeout(done, every));
  }
}

/** Run one SQL statement on B's site database (to move a clock-bound value into the past); resolves to the rows changed. */
export function site_sql(home, statement, params = []) {
  const script = 'import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); n=c.execute(sys.argv[2], json.loads(sys.argv[3])).rowcount; c.commit(); print(n)';
  const result = spawnSync(python_command(), ['-c', script, join(home, 'site.sqlite3'), statement, JSON.stringify(params)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return Number(result.stdout.trim());
}

/** Module files a scenario needs; a missing one means its provider has not landed yet. */
export function missing_modules(files) {
  return files.filter(file => !existsSync(join(ROOT, file)));
}

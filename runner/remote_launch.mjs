/**
 * Run what other devices relay through a paired website: room launches, and every other local-service operation as an
 * end-to-end encrypted command that only this computer can read; directories and credentials stay here.
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomic_json } from './discussion_adapters.mjs';
import { saved_api_keys } from './discussion_api.mjs';
import { launch_discussion, launch_projects, launch_settings, platform_of } from './discussion_launch.mjs';

const MACHINE_TOKEN_BYTES = 32;
const MACHINE_NAME_MAX = 60;
const SYNC_TIMEOUT_MS = 10000;
const LINKS_FILE = 'machine-links.json';
// The website holds a claim this long when nothing is queued, so a waiting device is answered at once.
export const COMMAND_WAIT_SECONDS = 20;
const COMMAND_REQUEST_MARGIN_MS = 10000;
// Matches LOCAL_LAUNCH_TIMEOUT in backend/server.py, which runs the same entrypoint for the local website.
const COMMAND_TIMEOUT_MS = 60000;
const RELAY_CIPHER_INFO = 'codiscuss-relay-v1';
const LAUNCH_SCRIPT = fileURLToPath(new URL('./discussion_launch.mjs', import.meta.url));
// What a connected browser may ask the local bridge for, minus the folder dialog nobody would see and pairing itself.
const RELAYED_ACTIONS = new Set(['settings', 'launch', 'room-models', 'room-member', 'room-member-access', 'room-member-allow', 'room-member-adapter',
  'room-profiles', 'room-restore', 'room-fork', 'models', 'api-key', 'api-check', 'scheduler-check', 'projects', 'presets', 'admin-account']);
const ROOM_ACTIONS = new Set(['launch', 'room-models', 'room-member', 'room-member-access', 'room-member-allow', 'room-member-adapter',
  'room-profiles', 'room-restore', 'room-fork']);

/** Read every site this computer is paired with. */
export function machine_links(home) {
  const path = join(home, LINKS_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
}

/** A P-256 key pair for relayed commands; the private half never leaves this computer. */
function command_keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { kty, crv, x, y } = publicKey.export({ format: 'jwk' });
  return { public_key: { kty, crv, x, y }, private_key: privateKey.export({ format: 'jwk' }) };
}

/** Give every paired site a command key pair, kept beside its token; older pairings gain one on first use. */
function keyed_links(home) {
  const links = machine_links(home);
  const missing = Object.values(links.sites).filter(link => !link.private_key);
  for (const link of missing) Object.assign(link, command_keys());
  if (missing.length) atomic_json(join(home, LINKS_FILE), links);
  return links;
}

/** Return this computer's identity for one site, creating it on first use; the browser then pairs it as administrator. */
export function machine_link(home, site) {
  const origin = new URL(site).origin;
  const links = machine_links(home);
  links.sites[origin] ||= { id: randomUUID().replaceAll('-', ''), token: randomBytes(MACHINE_TOKEN_BYTES).toString('hex'),
    name: (hostname() || '本机').slice(0, MACHINE_NAME_MAX), ...command_keys() };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, LINKS_FILE), links);
  // The browser forwards this to the website, so the private key stays out of it.
  const { id, token, name } = links.sites[origin];
  return { id, token, name };
}

/** Forget a site's pairing so it can no longer hand launches to this computer. */
export function unlink_machine(home, site) {
  const links = machine_links(home);
  if (!links.sites[site]) return;
  delete links.sites[site];
  atomic_json(join(home, LINKS_FILE), links);
}

/** Resolve the API key saved for a profile's base URL, as the connected browser does. */
function api_key_ref(profile, keys) {
  if (profile.api_key_ref || !profile.base_url) return profile.api_key_ref;
  try { return keys[new URL(profile.base_url).href.replace(/\/+$/, '')]; } catch { return undefined; }
}

/** Platforms this computer can wake without further setup, and the client each uses. */
export function ready_clients(home) {
  const keys = saved_api_keys(home);
  return Object.fromEntries(Object.entries(launch_settings(home).participants).filter(([, profile]) => profile.adapter === 'api'
    ? Boolean(profile.base_url && profile.api_protocol && profile.model && api_key_ref(profile, keys))
    : Boolean(profile.adapter && (profile.adapter === 'antigravity' ? profile.ipc_directory : profile.executable))).map(([name, profile]) => [name, profile.adapter]));
}

/** Turn a relayed request into the request the connected browser would send, using this computer's directory and keys. */
export function local_request(home, site, request) {
  const { local_project, ...input } = request;
  if (input.cwd || input.access_file) throw new Error('远程启动只能选择电脑上已配置的项目');
  const project = local_project ? launch_projects(home).projects.find(item => item.id === local_project) : null;
  if (local_project && !project) throw new Error('所选项目已从这台电脑移除，请重新选择');
  const keys = saved_api_keys(home), defaults = launch_settings(home).participants;
  const participants = { ...(input.participants || {}) };
  for (const member of input.room?.members || []) {
    const profile = defaults[platform_of(member.name)];
    const ref = profile?.adapter === 'api' && !participants[member.name]?.api_key_ref ? api_key_ref(profile, keys) : undefined;
    if (ref) participants[member.name] = { ...participants[member.name], api_key_ref: ref };
  }
  return { ...input, participants, site, entry: 'web', ...(project ? { cwd: project.path } : {}) };
}

async function machine_request(site, link, path, body, { timeout = SYNC_TIMEOUT_MS, signal } = {}) {
  const response = await fetch(`${site}/api/machines/${link.id}${path}`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    headers: { 'Content-Type': 'application/json', 'X-Machine-Token': link.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/** Publish projects and clients to each paired site, then run every launch it relays, one at a time. */
export async function sync_remote_launches(home, { launch = launch_discussion, log = () => {} } = {}) {
  const projects = launch_projects(home).projects.filter(project => project.id).map(({ id, name }) => ({ id, name }));
  const clients = ready_clients(home);
  for (const [site, link] of Object.entries(keyed_links(home).sites)) {
    let launches;
    try { ({ launches } = await machine_request(site, link, '/sync', { projects, clients, public_key: link.public_key })); }
    catch (error) { log(`${site}: 同步电脑状态失败：${error.message}`); continue; }
    for (const { id, request } of launches) {
      const action = body => machine_request(site, link, `/launches/${encodeURIComponent(id)}`, body);
      try {
        await action({ action: 'claim' });
        const result = await launch(home, local_request(home, site, request), { browser_request: true });
        await action({ action: 'finish', room_id: result.room.id, status: result.status });
        log(`${site}: 远程启动 ${id} 已创建房间 ${result.room.id}`);
      } catch (error) {
        log(`${site}: 远程启动 ${id} 失败：${error.message}`);
        await action({ action: 'fail', error: error.message, stage: error.launch?.stage || 'not_started',
          ...(error.launch?.room_id ? { room_id: error.launch.room_id } : {}) }).catch(() => {});
      }
    }
  }
}

/** The AES-GCM key shared with one sending device, derived from its ephemeral key and this computer's private key. */
export async function relay_cipher(private_jwk, public_jwk) {
  const curve = { name: 'ECDH', namedCurve: 'P-256' };
  const own = await crypto.subtle.importKey('jwk', private_jwk, curve, false, ['deriveBits']);
  const peer = await crypto.subtle.importKey('jwk', public_jwk, curve, false, []);
  const material = await crypto.subtle.importKey('raw', await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, own, 256), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: new TextEncoder().encode(RELAY_CIPHER_INFO) },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Encrypt a value bound to its command, so the site cannot swap one command's content into another. */
export async function seal(key, value, label) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(label) }, key, new TextEncoder().encode(JSON.stringify(value)));
  return { iv: Buffer.from(iv).toString('base64'), data: Buffer.from(data).toString('base64') };
}

/** Decrypt a value sealed for the same command label. */
export async function unseal(key, envelope, label) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode(label) },
    key, Buffer.from(envelope.data, 'base64'));
  return JSON.parse(new TextDecoder().decode(plain));
}

/** Turn a relayed action into the local entrypoint call the local website makes, pinned to the relaying site. */
export function relayed_command(site, action, payload) {
  if (!RELAYED_ACTIONS.has(action)) throw new Error('该操作不能经其他设备执行');
  if (payload === undefined ? action !== 'settings' : !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('命令内容无效');
  let input = payload;
  if (ROOM_ACTIONS.has(action)) {
    const { access_file, ...rest } = payload;
    input = { ...rest, site, entry: 'web' };
  }
  if (action === 'admin-account') input = { site, username: payload.username, password: payload.password };
  return { command: action === 'launch' ? 'start' : action, input, browser: action === 'launch' };
}

/** Run the local entrypoint as the local website does and answer in its HTTP shape. */
export function run_launch_command({ command, input, browser }) {
  return new Promise(resolve => {
    const args = [LAUNCH_SCRIPT, command, ...(browser ? ['--browser'] : []), ...(input === undefined ? [] : ['--stdin'])];
    const child = spawn(process.execPath, args, { windowsHide: true });
    let stdout = '', stderr = '', timed_out = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timed_out = true; child.kill(); }, COMMAND_TIMEOUT_MS);
    child.on('error', error => { clearTimeout(timer); resolve({ status: 400, body: { error: error.message } }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timed_out) return resolve({ status: 400, body: { error: '启动结果未确认，请核对房间状态后沿用原配置重试' } });
      try { resolve(code ? { status: 400, body: JSON.parse(stderr.trim()) } : { status: 200, body: JSON.parse(stdout) }); }
      catch { resolve({ status: 400, body: { error: stderr.trim() || '本机操作失败' } }); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
}

/** Decrypt one claimed command, run it, and return the encrypted answer to the device waiting on it. */
async function answer_command(site, link, { id, envelope }, run, log) {
  let key, request;
  try {
    key = await relay_cipher(link.private_key, envelope.key);
    request = await unseal(key, envelope, id);
  } catch { return log(`${site}: 远程命令 ${id} 无法解密，已忽略`); }
  let response;
  try { response = await run(relayed_command(site, request.action, request.payload)); }
  catch (error) { response = { status: 400, body: { error: error.message } }; }
  try { await machine_request(site, link, `/commands/${encodeURIComponent(id)}`, { envelope: await seal(key, response, `${id}:response`) }); }
  catch (error) { log(`${site}: 远程命令 ${id} 回传失败：${error.message}`); }
}

/**
 * Wait on every paired site for relayed commands and start each one; resolves once the claims return, with the commands
 * still running in `running` so a slow model list never holds up the next claim.
 */
export async function relay_commands(home, { run = run_launch_command, log = () => {}, wait = COMMAND_WAIT_SECONDS, signal, running = new Set() } = {}) {
  // Keys are created by the sync, which publishes them; a site without one yet has nothing to claim.
  await Promise.all(Object.entries(machine_links(home).sites).filter(([, link]) => link.private_key).map(async ([site, link]) => {
    let commands;
    try { ({ commands } = await machine_request(site, link, '/commands/claim', { wait }, { timeout: wait * 1000 + COMMAND_REQUEST_MARGIN_MS, signal })); }
    catch (error) { if (!signal?.aborted) log(`${site}: 领取远程命令失败：${error.message}`); return; }
    for (const command of commands) {
      const task = answer_command(site, link, command, run, log).finally(() => running.delete(task));
      running.add(task);
    }
  }));
  return running;
}

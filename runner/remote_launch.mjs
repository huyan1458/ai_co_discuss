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

import { adapter_profile } from './adapters/profiles.mjs';
import { atomic_json } from './files.mjs';
import { saved_api_keys } from './discussion_api.mjs';
import { launch_projects, launch_settings } from './discussion_launch.mjs';
import { claim_relayed_command } from './remote_policy.mjs';
import { audit, DEVICE_ACTIONS, device_command, open_signed_request } from './device_auth.mjs';

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
  'room-member-model', 'room-profiles', 'room-files', 'room-restore', 'room-fork', 'models', 'api-key', 'api-check', 'scheduler-check', 'tts-settings', 'tts', 'stt', 'projects', 'presets', 'workflows', 'room-workflow', 'browse-directory']);
export const ROOM_ACTIONS = new Set(['launch', 'room-models', 'room-member', 'room-member-access', 'room-member-allow', 'room-member-adapter',
  'room-member-model', 'room-profiles', 'room-files', 'room-restore', 'room-fork', 'room-workflow', 'workflows']);

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
  return Object.fromEntries(Object.entries(launch_settings(home).participants).filter(([, profile]) => {
    const facts = adapter_profile(profile.adapter);
    if (!facts) return false;
    // A model API needs its endpoint and key; other software needs its installed location.
    return facts.kind === 'api' ? Boolean(profile.base_url && profile.api_protocol && profile.model && api_key_ref(profile, keys))
      : Boolean(profile[facts.location]);
  }).map(([name, profile]) => [name, profile.adapter]));
}

async function machine_request(site, link, path, body, { timeout = SYNC_TIMEOUT_MS, signal } = {}) {
  const response = await fetch(`${site}/api/machines/${link.id}${path}`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    headers: { 'Content-Type': 'application/json', 'X-Machine-Token': link.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/**
 * Publish projects, clients and this computer's key to each paired site. Launch tasks a site returns are never run:
 * every remote operation must arrive as a device-signed command, and a site's own answer proves nothing.
 */
export async function sync_remote_launches(home, { log = () => {} } = {}) {
  const projects = launch_projects(home).projects.filter(project => project.id).map(({ id, name }) => ({ id, name }));
  const clients = ready_clients(home);
  for (const [site, link] of Object.entries(keyed_links(home).sites)) {
    let launches;
    try { ({ launches } = await machine_request(site, link, '/sync', { projects, clients, public_key: link.public_key })); }
    catch (error) { log(`${site}: 同步电脑状态失败：${error.message}`); continue; }
    if (launches?.length) log(`${site}: 网站返回了 ${launches.length} 个旧格式启动任务，已忽略；远程启动须由已配对设备签名`);
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
  // A path names a folder on the computer itself; another device sends the files it opened.
  if (action === 'workflows' && payload.folder) throw new Error('其他设备请选择 zip 或文件夹导入工作流');
  return { command: action === 'launch' ? 'start' : action, input, browser: action === 'launch' };
}

/** Run the local entrypoint as the local website does, under the limits for other devices, and answer in its HTTP shape. */
export function run_launch_command({ command, input, browser, device }) {
  return new Promise(resolve => {
    const args = [LAUNCH_SCRIPT, command, '--remote', ...(device ? ['--device', device] : []), ...(browser ? ['--browser'] : []),
      ...(input === undefined ? [] : ['--stdin'])];
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
async function answer_command(home, site, link, { id, envelope }, run, log) {
  let key, sealed;
  try {
    key = await relay_cipher(link.private_key, envelope.key);
    sealed = await unseal(key, envelope, id);
  } catch { return log(`${site}: 远程命令 ${id} 无法解密，已忽略`); }
  let response;
  try {
    const { request, device_id } = await open_signed_request(home, id, sealed, link.id);
    claim_relayed_command(home, id, request.sent_at);
    response = DEVICE_ACTIONS.has(request.action) ? await device_command(home, { site, machine_id: link.id, device_id }, request.action, request.payload)
      : await run({ ...relayed_command(site, request.action, request.payload), device: device_id });
    if (!DEVICE_ACTIONS.has(request.action)) audit(home, { event: 'command', action: request.action, route: '', device: device_id, status: response.status });
  }
  catch (error) { response = { status: 400, body: { error: error.message, ...(error.need ? { need: error.need } : {}) } }; }
  try { await machine_request(site, link, `/commands/${encodeURIComponent(id)}`, { envelope: await seal(key, response, `${id}:response`) }); }
  catch (error) { log(`${site}: 远程命令 ${id} 回传失败：${error.message}`); }
}

/**
 * Wait on every paired site for relayed commands and start each one; resolves once the claims return, with the commands
 * still running in `running` so a slow model list never holds up the next claim. `on_failure` hears a claim that failed,
 * so the caller can wait before retrying while a successful claim is followed at once.
 */
export async function relay_commands(home, { run = run_launch_command, log = () => {}, wait = COMMAND_WAIT_SECONDS, signal, running = new Set(), on_failure = () => {}, skip = new Set() } = {}) {
  // Keys are created by the sync, which publishes them; a site without one yet has nothing to claim. A site reached
  // through its live relay channel needs no D1 polling.
  await Promise.all(Object.entries(machine_links(home).sites).filter(([site, link]) => link.private_key && !skip.has(site)).map(async ([site, link]) => {
    let commands;
    try { ({ commands } = await machine_request(site, link, '/commands/claim', { wait }, { timeout: wait * 1000 + COMMAND_REQUEST_MARGIN_MS, signal })); }
    catch (error) { if (!signal?.aborted) { log(`${site}: 领取远程命令失败：${error.message}`); on_failure(); } return; }
    for (const command of commands) {
      // A pairing removed or replaced while the claim waited ends here, as on the live channel.
      const current = machine_links(home).sites[site];
      if (current?.token !== link.token || current?.private_key?.d !== link.private_key?.d) { log(`${site}: 配对已撤销或更换，忽略远程命令 ${command.id}`); continue; }
      const task = answer_command(home, site, link, command, run, log).finally(() => running.delete(task));
      running.add(task);
    }
  }));
  return running;
}

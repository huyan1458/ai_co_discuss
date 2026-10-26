/** Run room launches that other devices relay through a paired website; directories and credentials stay here. */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { atomic_json } from './discussion_adapters.mjs';
import { saved_api_keys } from './discussion_api.mjs';
import { launch_discussion, launch_projects, launch_settings, platform_of } from './discussion_launch.mjs';

const MACHINE_TOKEN_BYTES = 32;
const MACHINE_NAME_MAX = 60;
const SYNC_TIMEOUT_MS = 10000;
const LINKS_FILE = 'machine-links.json';

/** Read every site this computer is paired with. */
export function machine_links(home) {
  const path = join(home, LINKS_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
}

/** Return this computer's identity for one site, creating it on first use; the browser then pairs it as administrator. */
export function machine_link(home, site) {
  const origin = new URL(site).origin;
  const links = machine_links(home);
  links.sites[origin] ||= { id: randomUUID().replaceAll('-', ''), token: randomBytes(MACHINE_TOKEN_BYTES).toString('hex'),
    name: (hostname() || '本机').slice(0, MACHINE_NAME_MAX) };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(join(home, LINKS_FILE), links);
  return links.sites[origin];
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

async function machine_request(site, link, path, body) {
  const response = await fetch(`${site}/api/machines/${link.id}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'X-Machine-Token': link.token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/** Publish projects and clients to each paired site, then run every launch it relays, one at a time. */
export async function sync_remote_launches(home, { launch = launch_discussion, log = () => {} } = {}) {
  const projects = launch_projects(home).projects.filter(project => project.id).map(({ id, name }) => ({ id, name }));
  const clients = ready_clients(home);
  for (const [site, link] of Object.entries(machine_links(home).sites)) {
    let launches;
    try { ({ launches } = await machine_request(site, link, '/sync', { projects, clients })); }
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

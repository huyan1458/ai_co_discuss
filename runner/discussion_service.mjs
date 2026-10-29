/** Resident local service that dispatches registered rooms to software or configured API participants. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json } from './discussion_adapters.mjs';
import { DiscussionStore, acquire_lock, api, load_config, pause_if_running, service_drafts, validate_config } from './discussion_runner.mjs';
import { FreeRoomRunner } from './free_runner.mjs';

const POLL_MS = 2000;
// A hosted site is polled less often than a local one: every request spends its database quota.
const REMOTE_POLL_MS = 10_000;
// A hosted site is asked this often which rooms changed; an idle room is read in full only then, or at the safety interval.
const REVISION_POLL_MS = 3000;
const IDLE_REMOTE_POLL_MS = 5 * 60_000;
const REVISION_TIMEOUT_MS = 10_000;
const UPDATE_RETRY_MS = 5000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const REMOTE_SYNC_MS = 3000;
const START_WAIT_MS = 5000;
const STOP_WAIT_MS = 20_000;
const REGISTRY_WAIT_MS = 5000;
// Housekeeping: logs above the limit keep only their newest part; a launch folder no room uses is removed once it is this old.
const SWEEP_MS = 6 * 60 * 60 * 1000;
const LOG_LIMIT_BYTES = 5 * 1024 * 1024;
const LOG_KEEP_BYTES = 1024 * 1024;
const STALE_LAUNCH_MS = 7 * 24 * 60 * 60 * 1000;
const SERVICE_LOGS = ['service.log', join('local', 'website.log'), join('local', 'supervisor.log')];
const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(SCRIPT));
const SHORTCUT_NAME = 'AI CoDiscuss 讨论服务.lnk';
const TICK_STATES = { undefined: 'running', waiting: 'paused', false: 'idle' };
const STATUS_LABELS = { running: '运行中', paused: '已暂停', idle: '等待启动', error: '异常' };
const USAGE = '用法: discussion_service.mjs start|stop|status|open|run|list|add|remove|clean|shortcut|autostart [--config 私有配置.json] [on|off]';
export const CONNECTION_FIELDS = ['executable', 'ipc_directory'];

/** Read one atomic configuration version for editing and worker acknowledgement. */
export function configuration_snapshot(path) {
  const content = readFileSync(path, 'utf8');
  return { config: JSON.parse(content), version: createHash('sha256').update(content).digest('hex') };
}

/** Private per-user directory holding the registry, lock, status and log; moves the legacy AppData location once. */
export function service_home() {
  if (process.env.DISCUSS_SERVICE_HOME) return resolve(process.env.DISCUSS_SERVICE_HOME);
  const home = join(homedir(), '.codiscuss');
  const legacy = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'ai-codiscuss', 'service');
  if (existsSync(home) || !existsSync(legacy)) return home;
  return migrate_service_home(legacy, home) ? home : legacy;
}

/** Move a stopped service directory and rewrite absolute paths that pointed into it; a running one stays put. */
export function migrate_service_home(from, to) {
  if (service_pid(from) || service_pid(join(from, 'local'))) return false;
  // An MSIX-redirected view would move only the app's private copy; leave that to an ordinary terminal.
  try { assert_shared_home(from); } catch { return false; }
  try { renameSync(from, to); }
  catch { return existsSync(to); }
  try {
    const moved = new Map();
    for (const path of json_files(to)) rewrite_json(path, from, to, moved);
    for (const path of read_registry(to)) if (!inside(path, to) && existsSync(path)) rewrite_json(path, from, to, moved);
    // Drafts are keyed by the run directory, so a moved run directory needs its drafts renamed too.
    for (const [before, after] of moved) {
      const source = service_drafts(to, before), target = service_drafts(to, after);
      if (existsSync(source) && !existsSync(target)) renameSync(source, target);
    }
    process.stderr.write(`服务目录已迁移：${from} → ${to}\n`);
  } catch (error) { process.stderr.write(`服务目录已迁移到 ${to}，但部分旧路径未改写：${error.message}\n`); }
  return true;
}

/** Compare path prefixes with the platform's case rules. */
function inside(path, directory) {
  const [a, b] = process.platform === 'win32' ? [path, directory].map(item => item.replaceAll('/', '\\').toLowerCase()) : [path, directory];
  return a === b || (a.startsWith(b) && /[\\/]/.test(a[b.length]));
}

/** List JSON files under a directory, recursively. */
function json_files(directory) {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => join(entry.parentPath, entry.name));
}

/** Rewrite one JSON file's moved path strings, recording run directories whose drafts must follow. */
function rewrite_json(path, from, to, moved) {
  const replace = value => {
    if (typeof value === 'string') return inside(value, from) ? to + value.slice(from.length) : value;
    if (Array.isArray(value)) return value.map(replace);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    if (typeof value.data_directory === 'string' && result.data_directory !== value.data_directory) {
      moved.set(value.data_directory, result.data_directory);
      if (typeof result.draft_directory === 'string') result.draft_directory = service_drafts(to, result.data_directory);
    }
    return result;
  };
  let original;
  try { original = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
  const updated = replace(original);
  if (JSON.stringify(updated) !== JSON.stringify(original)) atomic_json(path, updated);
}

/** Reject an MSIX-private write view before reading shared service state or changing it. */
export function assert_shared_home(home) {
  if (process.platform !== 'win32') return;
  let directory = resolve(home);
  while (!existsSync(directory)) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`服务目录没有可访问的父目录：${home}`);
    directory = parent;
  }
  const probe = join(directory, `.codiscuss-path-${randomUUID()}`);
  closeSync(openSync(probe, 'wx', 0o600));
  try {
    const actual = realpathSync.native(probe);
    // Compare the container suffix so a short user-profile name (ADMINI~1) is not a redirect.
    const container = actual.match(/\\AppData\\Local\\Packages\\[^\\]+\\LocalCache\\(?:Local|Roaming)\\/i)?.[0];
    if (container && !probe.toLowerCase().includes(container.toLowerCase())) {
      throw new Error(`Windows MSIX 正在重定向服务目录 ${home}，实际写入 ${dirname(actual)}。`
        + '请从应用外的普通终端执行 codiscuss local start/stop；'
        + '或让所有入口使用同一个 AppData 之外的 DISCUSS_SERVICE_HOME。原数据不会自动迁移。');
    }
  } finally { unlinkSync(probe); }
}

/** Read the registered private room configuration paths. */
export function read_registry(home) {
  const path = join(home, 'rooms.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).configs || [] : [];
}

/** Read room identity independently of software validity, isolating unreadable configuration files. */
export function registered_identity(path) {
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'));
    return { site: new URL(config.site).origin, room: config.room };
  } catch { return null; }
}

/** Serialize the entire registry read-modify-write across short-lived CLI processes. */
function update_registry(home, update) {
  mkdirSync(home, { recursive: true });
  const lock = new DatabaseSync(join(home, 'registry-lock.sqlite3'));
  try {
    lock.exec(`PRAGMA busy_timeout=${REGISTRY_WAIT_MS}; BEGIN IMMEDIATE`);
    atomic_json(join(home, 'rooms.json'), { configs: update(read_registry(home)) });
    lock.exec('COMMIT');
  } finally {
    lock.close();
  }
}

/** Register a validated room once; the same site and room may not be served twice. */
export function register_room(home, config_path) {
  const path = resolve(config_path);
  const config = load_config(path);
  update_registry(home, registered => {
    const configs = registered.filter(item => item !== path);
    for (const item of configs) {
      const other = registered_identity(item);
      if (other?.site === config.site && other.room === config.room) throw new Error(`房间 ${config.room} 已由 ${item} 登记`);
    }
    return [...configs, path];
  });
  return config;
}

/** Remove one configuration path from the registry. */
export function unregister_room(home, config_path) {
  const path = resolve(config_path);
  update_registry(home, configs => {
    if (!configs.includes(path)) throw new Error('该配置未登记');
    return configs.filter(item => item !== path);
  });
}

/** One registered room: its own data-directory lock, store and dispatcher. */
class RoomWorker {
  constructor(path, create_runner, log, home) {
    this.path = path;
    this.home = home;
    this.create_runner = create_runner;
    this.log = log;
    this.state = { config: path, status: 'starting', error: '' };
    this.adopt_failed = new Set();
  }
  /** Open lazily so a busy lock or broken file is retried instead of stopping the service. */
  open() {
    const snapshot = configuration_snapshot(this.path);
    const config = validate_config(snapshot.config, dirname(this.path));
    config.draft_directory = service_drafts(this.home, config.directory);
    const release = acquire_lock(config.directory);
    try { this.store = new DiscussionStore(config.directory); }
    catch (error) { release(); throw error; }
    if (config.mode !== 'free') this.store.context(config);
    this.store.scope(config);
    this.config = config;
    this.release = release;
    this.runner = this.create_runner(config, this.store, message => this.log(`${config.room}: ${message}`));
    Object.assign(this.state, { site: config.site, room: config.room, config_version: snapshot.version });
  }
  /** Reload connection paths and credentials while retaining the exact conversation context. */
  async refresh_control() {
    const snapshot = configuration_snapshot(this.path);
    const updated = validate_config(snapshot.config, dirname(this.path));
    if (updated.site !== this.config.site || updated.room !== this.config.room || updated.directory !== this.config.directory) {
      throw new Error('已登记配置的房间或数据目录发生变化，请移除原登记后重新接入');
    }
    const codex_switches = Object.entries(this.config.participants).filter(([name, previous]) => {
      const next = updated.participants[name];
      return next && previous.adapter !== next.adapter
        && ['codex', 'codex_cli'].includes(previous.adapter) && ['codex', 'codex_cli'].includes(next.adapter);
    });
    const codex_switch = codex_switches.length > 0;
    const discussion = codex_switch ? await api(this.config, '/discussion') : null;
    if (codex_switch && discussion?.session?.status === 'active') {
      throw new Error('讨论运行中不能切换 Codex 接入方式');
    }
    if (codex_switch && this.config.mode !== 'free' && this.runner.children?.size) {
      throw new Error('等待原 CLI 进程退出后再切换 Codex 接入方式');
    }
    if (this.config.mode !== 'free') this.store.context(updated, codex_switch);
    // The runner owns all free-room and discussion requests; only connection context is adopted here.
    this.runner.adopt?.({ ...updated, draft_directory: this.config.draft_directory });
    this.config = this.runner.config || { ...updated, draft_directory: this.config.draft_directory };
    this.state.config_version = snapshot.version;
  }
  /** A manual Claude, Codex or agy expert that has registered and whose CLI reported its session is handed to the service, which resumes that session from the next turn on. */
  async adopt_manual_members() {
    // The runner has just read the room; reading it again here would double every poll.
    const members = (this.runner.room ?? await api(this.config, '')).free?.members || [];
    for (const member of members) {
      const key = `${member.name}:${member.reported_session}`;
      // A restored room keeps its Claude Code members manual so their original window stays the only writer.
      if (member.access !== 'manual' || member.status !== 'active' || !member.registered_at || !member.reported_session || this.adopt_failed.has(key)
        || this.config.keep_manual?.includes(member.name)) continue;
      try {
        const { adopt_member_profile } = await import('./discussion_launch.mjs');
        const member_token = `${randomUUID()}${randomUUID()}`;
        const adapter = adopt_member_profile(this.home, this.path, member.name, member.reported_session, member.reported_client, member_token);
        await api(this.config, `/members/${member.id}`, { action: 'adopt', adapter, session_id: member.reported_session, ...(member_token ? { token: member_token } : {}) });
        this.log(`${this.config.room}: ${member.name} 已转为本机托管`);
      } catch (error) {
        this.adopt_failed.add(key);
        this.log(`${this.config.room}: ${member.name} 未能转为托管，保持手动：${error.message}`);
      }
    }
  }
  /** Run one bounded dispatcher iteration and keep the last result for status. */
  async tick() {
    const previous_status = this.state.status;
    try {
      if (!this.runner) this.open();
      await this.refresh_control();
      const result = await this.runner.tick();
      await this.adopt_manual_members();
      Object.assign(this.state, { status: TICK_STATES[result], error: '' });
      this.idle = this.runner.idle?.() === true;
    } catch (error) {
      this.idle = false;
      if (await this.deleted(error)) { this.removed = true; return; }
      if (error.message !== this.state.error) this.log(`${this.state.room || this.path}: ${error.message}`);
      Object.assign(this.state, { status: 'error', error: error.message });
    }
    if (this.state.status !== previous_status) {
      this.log(`${this.state.site || ''}/${this.state.room || this.path}: ${STATUS_LABELS[this.state.status]}`);
    }
    this.state.checked_at = Math.floor(Date.now() / 1000);
  }
  /** Confirm a 404 against the room itself, so a room deleted on the website is told apart from a missing route. */
  async deleted(error) {
    if (!error.message.startsWith('HTTP 404')) return false;
    try {
      await api(this.config || validate_config(configuration_snapshot(this.path).config, dirname(this.path)), '');
      return false;
    } catch (failure) { return failure.message === 'HTTP 404: 房间不存在'; }
  }
  /** Stopping the service pauses its runs, so the website does not wait for absent consumers. */
  async close(pause) {
    if (!this.runner) return;
    if (pause) {
      try { await pause_if_running(this.config); }
      catch (error) { this.log(`${this.config.room}: 停止回执未确认；租约到期后拒绝写入：${error.message}`); }
    }
    this.runner.stop_children();
    this.store.close();
    this.release();
    this.runner = null;
  }
}

/** Keep workers aligned with the registry and tick each one per poll. */
export class DiscussionService {
  constructor(home, create_runner = (config, store, log) => new FreeRoomRunner(config, store, undefined, log), log = () => {}) {
    this.home = home;
    this.create_runner = create_runner;
    this.log = log;
    this.workers = new Map();
    // How often each room is checked without a push: a local site costs nothing, a hosted one spends its database quota.
    this.intervals = { local: POLL_MS, remote: REMOTE_POLL_MS, revisions: REVISION_POLL_MS, idle: IDLE_REMOTE_POLL_MS };
    // Per hosted site: when its revisions were last asked, whether a check is in flight, and whether the site offers them.
    this.revisions = new Map();
    // The resident service turns this on so a site's update stream checks its rooms at once; tests leave it off.
    this.push = false;
    this.streams = new Map();
    this.closed = false;
  }
  /**
   * Reload the registry, close removed rooms, then tick the rooms that are due. `wait: true` ticks every idle room and
   * waits for them; `wait: false` returns at once, so a slow remote site never delays the other rooms.
   */
  async tick({ wait = true } = {}) {
    const configs = read_registry(this.home);
    for (const [path, worker] of this.workers) {
      if (!configs.includes(path)) { await worker.busy; await worker.close(true); this.workers.delete(path); }
    }
    for (const path of configs) {
      if (!this.workers.has(path)) this.workers.set(path, new RoomWorker(path, this.create_runner, this.log, this.home));
      const worker = this.workers.get(path);
      if (!worker.busy && (wait || Date.now() >= (worker.next_at ?? 0))) this.start(path, worker);
    }
    if (this.push) for (const site of new Set([...this.workers.values()].map(worker => worker.state.site).filter(Boolean))) this.watch(site);
    const checks = this.check_revisions();
    if (wait) await checks;
    if (wait) await Promise.all([...this.workers.values()].map(worker => worker.busy));
    this.write_status();
  }
  /** Start one room's tick; a room asked again while busy ticks once more right after. */
  start(path, worker) {
    if (this.closed) return;
    if (worker.busy) { worker.woken = true; return; }
    // Nothing awaits this tick, so its failure is logged here instead of crashing the service.
    worker.busy = this.tick_worker(path, worker).catch(error => this.log(`${worker.state.room || path}: 检查失败：${error.message}`))
      .finally(() => {
        // Counted from the end of the tick, once the room's site is known; a slow site does not poll back to back.
        const local = !worker.state.site || LOOPBACK.has(new URL(worker.state.site).hostname);
        // An idle hosted room waits for its revision to change; a site without revisions keeps the regular interval.
        const watched = worker.idle && this.revisions.get(worker.state.site)?.supported !== false;
        worker.next_at = Date.now() + (local ? this.intervals.local : watched ? this.intervals.idle : this.intervals.remote);
        worker.busy = null;
        if (worker.woken && this.workers.get(path) === worker) { worker.woken = false; this.start(path, worker); }
      });
  }
  /**
   * Ask each hosted site which of its rooms changed since the last check and tick those at once; one small read per site
   * replaces a full read of every idle room. A room missing from the answer was deleted, and its next tick removes it.
   * A site that does not answer (404 without revisions, or an error) leaves its rooms on the regular interval and is asked
   * again after the safety interval.
   */
  async check_revisions() {
    const sites = new Map();
    for (const [path, worker] of this.workers) {
      const site = worker.state.site;
      if (site && worker.state.room && !LOOPBACK.has(new URL(site).hostname)) sites.set(site, [...(sites.get(site) || []), [path, worker]]);
    }
    const checks = [];
    for (const [site, entries] of sites) {
      const watch = this.revisions.get(site) ?? { at: 0, busy: false, supported: true };
      this.revisions.set(site, watch);
      if (this.closed || watch.busy || Date.now() - watch.at < (watch.supported ? this.intervals.revisions : this.intervals.idle)) continue;
      Object.assign(watch, { at: Date.now(), busy: true });
      const rooms = entries.map(([, worker]) => encodeURIComponent(worker.state.room)).join(',');
      checks.push(fetch(`${site}/api/revisions?rooms=${rooms}`, { redirect: 'error', signal: AbortSignal.timeout(REVISION_TIMEOUT_MS) })
        .then(async response => {
          // Without an answer (no such route, or the site failing) the rooms fall back to the regular interval at once,
          // instead of waiting out the safety interval for a revision that may not come.
          if (!response.ok) {
            if (watch.supported) for (const [, worker] of entries) worker.next_at = 0;
            watch.supported = false;
            return;
          }
          watch.supported = true;
          const revisions = (await response.json()).rooms || {};
          for (const [path, worker] of entries) {
            const revision = revisions[worker.state.room] ?? null;
            if (worker.revision !== revision) { worker.revision = revision; this.start(path, worker); }
          }
        })
        // A failed check is retried at the next interval; idle rooms still get their safety tick.
        .catch(() => {})
        .finally(() => { watch.busy = false; }));
    }
    await Promise.all(checks);
  }
  /** Check every room of a site now, as its website reported a change. */
  wake(site) {
    for (const [path, worker] of this.workers) if (worker.state.site === site) this.start(path, worker);
  }
  /**
   * Follow a site's `/api/updates` stream and wake its rooms on each change, so a message reaches the AI within
   * milliseconds instead of the next poll. A site without push (204) is left to polling; a dropped stream reconnects.
   */
  watch(site) {
    if (this.streams.has(site) || this.closed) return;
    const controller = new AbortController();
    const done = (async () => {
      while (!controller.signal.aborted) {
        try {
          const response = await fetch(`${site}/api/updates`, { signal: controller.signal, headers: { accept: 'text/event-stream' } });
          if (response.status === 204) return;
          if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
            for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
              // `ready` comes on every (re)connection, so changes missed while disconnected are picked up too.
              if (/^event: (change|ready)$/m.test(buffer.slice(0, end))) this.wake(site);
              buffer = buffer.slice(end + 2);
            }
          }
        } catch { /* Reconnect below; polling covers the gap. */ }
        await sleep(UPDATE_RETRY_MS, undefined, { signal: controller.signal }).catch(() => {});
      }
    })();
    this.streams.set(site, { controller, done });
  }
  /** Publish every room's latest state for `codiscuss status` and the website's service check. */
  write_status() {
    atomic_json(join(this.home, 'status.json'), { pid: process.pid, updated_at: Math.floor(Date.now() / 1000),
      rooms: [...this.workers.values()].map(worker => worker.state) });
  }
  /** Tick one room; a room deleted on its website is unregistered here. */
  async tick_worker(path, worker) {
    await worker.tick();
    if (!worker.removed) return this.write_status();
    // The room no longer exists on its website, so there is nothing to pause; drop the registration once.
    const directory = worker.config?.directory;
    await worker.close(false);
    this.workers.delete(path);
    try { unregister_room(this.home, path); } catch { /* Already removed by another command. */ }
    // Its runtime, task files and answer drafts serve no one now; a file still held is left to the periodic sweep.
    try { remove_room_files(this.home, path, directory); } catch (error) { this.log(`${worker.state.room || path}: 本机文件未能删除，稍后清理：${error.message}`); }
    this.log(`${worker.state.site || ''}/${worker.state.room || path}: 房间已在网站删除，已撤销登记并删除本机文件`);
  }
  /** Pause running rooms and release every lock and child process, once their current ticks finish. */
  async close() {
    this.closed = true;
    for (const stream of this.streams.values()) stream.controller.abort();
    await Promise.all([...this.streams.values()].map(stream => stream.done));
    this.streams.clear();
    await Promise.all([...this.workers.values()].map(worker => worker.busy));
    for (const worker of this.workers.values()) await worker.close(true);
    this.workers.clear();
  }
}

/** Delete one room's local files: its answer drafts, and its launch folder when the service created it under launches/. */
export function remove_room_files(home, config_path, data_directory) {
  const folder = dirname(resolve(config_path));
  for (const directory of [data_directory, folder, join(folder, 'runtime')].filter(Boolean)) {
    rmSync(service_drafts(home, directory), { recursive: true, force: true });
  }
  if (dirname(folder) === resolve(home, 'launches')) rmSync(folder, { recursive: true, force: true });
}

/** Keep only the newest part of a log that grew past the limit; writers append, so they continue at its new end. */
function trim_log(path) {
  if (!existsSync(path) || statSync(path).size <= LOG_LIMIT_BYTES) return false;
  const size = statSync(path).size, tail = Buffer.alloc(LOG_KEEP_BYTES);
  const handle = openSync(path, 'r');
  try { readSync(handle, tail, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES); } finally { closeSync(handle); }
  // Start at a whole line so the kept part does not open mid-entry.
  writeFileSync(path, tail.subarray(tail.indexOf(10) + 1));
  return true;
}

/** The newest change time of a launch folder's own records, which a pending launch still updates. */
function launch_touched(folder) {
  return Math.max(...[folder, join(folder, 'launch.json'), join(folder, 'config.json')].filter(existsSync).map(path => statSync(path).mtimeMs));
}

/**
 * Remove what no registered room uses: launch folders left by rooms deleted while the service was off, or launches
 * never confirmed, once they are a week old and no process holds them; answer drafts whose folder is gone; and the
 * oversized part of the service's logs. Registered rooms, settings and the local website's database are never touched.
 */
export function sweep_service_home(home, now = Date.now()) {
  const registered = read_registry(home).map(path => dirname(resolve(path)));
  const launches = join(home, 'launches'), removed = { launches: [], drafts: [], logs: [] };
  for (const name of existsSync(launches) ? readdirSync(launches) : []) {
    const folder = join(launches, name);
    if (registered.includes(folder) || service_pid(folder) || service_pid(join(folder, 'runtime')) || now - launch_touched(folder) < STALE_LAUNCH_MS) continue;
    try { remove_room_files(home, join(folder, 'config.json')); removed.launches.push(name); } catch { /* Still held; the next sweep retries. */ }
  }
  // A draft folder is keyed by its room's data directory; one matching no remaining folder or registered room is orphaned.
  const live = new Set();
  for (const path of read_registry(home)) {
    const folder = dirname(resolve(path));
    for (const directory of [folder, join(folder, 'runtime')]) live.add(service_drafts(home, directory));
    try { live.add(service_drafts(home, validate_config(JSON.parse(readFileSync(path, 'utf8')), folder).directory)); } catch { /* Covered by the folder keys. */ }
  }
  for (const name of existsSync(launches) ? readdirSync(launches) : []) {
    for (const directory of [join(launches, name), join(launches, name, 'runtime')]) live.add(service_drafts(home, directory));
  }
  const drafts = join(home, 'drafts');
  for (const name of existsSync(drafts) ? readdirSync(drafts) : []) {
    if (live.has(join(drafts, name))) continue;
    rmSync(join(drafts, name), { recursive: true, force: true });
    removed.drafts.push(name);
  }
  for (const log of SERVICE_LOGS) if (trim_log(join(home, log))) removed.logs.push(log);
  return removed;
}

/** Return the live service PID, or 0 when no service owns the home lock. */
export function service_pid(home) {
  const path = join(home, 'runner.lock');
  if (!existsSync(path)) return 0;
  const pid = Number(readFileSync(path, 'utf8'));
  try { process.kill(pid, 0); return pid; } catch (error) { return error.code === 'EPERM' ? pid : 0; }
}

/** Require a startup receipt from the current lock owner, not a previous process's status. */
export function service_ready(home, pid = service_pid(home)) {
  if (!pid) return false;
  try {
    const status = JSON.parse(readFileSync(join(home, 'status.json'), 'utf8'));
    return status.pid === pid && Boolean(status.updated_at) && status.ready !== false;
  } catch { return false; }
}

/** Foreground service loop; `start` runs this detached in the background. */
export async function run_service(home, output = () => {}) {
  assert_shared_home(home);
  const release = acquire_lock(home);
  const log_line = message => {
    const line = `${new Date().toISOString()} ${message}`;
    appendFileSync(join(home, 'service.log'), `${line}\n`);
    output(line);
  };
  const service = new DiscussionService(home, undefined, log_line);
  service.push = true;
  const stop_path = join(home, 'stop.request');
  if (existsSync(stop_path)) unlinkSync(stop_path);
  let stopped = false, syncing = null;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    log_line(`讨论服务已启动 pid=${process.pid}`);
    atomic_json(join(home, 'status.json'), { pid: process.pid, ready: true,
      updated_at: Math.floor(Date.now() / 1000), rooms: [] });
    // Loaded lazily: the relay runs launches, and the launch module itself depends on this one.
    const { sync_remote_launches } = await import('./remote_launch.mjs');
    let synced_at = 0, swept_at = 0;
    while (!stopped && !existsSync(stop_path)) {
      try { await service.tick({ wait: false }); } catch (error) { log_line(`服务检查失败：${error.message}`); }
      if (Date.now() - swept_at >= SWEEP_MS) {
        swept_at = Date.now();
        try {
          const removed = sweep_service_home(home);
          if (removed.launches.length || removed.drafts.length || removed.logs.length) {
            log_line(`清理本机文件：启动目录 ${removed.launches.length} 个，草稿 ${removed.drafts.length} 个，日志 ${removed.logs.join('、') || '无'}`);
          }
        } catch (error) { log_line(`清理本机文件失败：${error.message}`); }
      }
      // Runs beside the room ticks: a slow remote site must not hold up local rooms.
      if (!syncing && Date.now() - synced_at >= REMOTE_SYNC_MS) {
        synced_at = Date.now();
        syncing = sync_remote_launches(home, { log: log_line }).catch(error => log_line(`远程启动检查失败：${error.message}`))
          .finally(() => { syncing = null; });
      }
      await sleep(POLL_MS);
    }
  } finally {
    await syncing;
    await service.close();
    if (existsSync(stop_path)) unlinkSync(stop_path);
    log_line('讨论服务已停止');
    release();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Start the detached service once; an already running service is reused. */
export async function start_service(home) {
  assert_shared_home(home);
  const running = service_pid(home);
  if (service_ready(home, running)) return { running: true, ready: true, pid: running, started: false };
  mkdirSync(home, { recursive: true });
  let child, spawn_error;
  if (!running) {
    const stop_path = join(home, 'stop.request');
    if (existsSync(stop_path)) unlinkSync(stop_path);
    const log = openSync(join(home, 'service.log'), 'a');
    child = spawn(process.execPath, [SCRIPT, 'run'], { detached: true, windowsHide: true,
      stdio: ['ignore', log, log], env: { ...process.env, DISCUSS_SERVICE_HOME: home } });
    closeSync(log);
    child.once('error', error => { spawn_error = error; });
    child.unref();
  }
  for (let waited = 0; waited < START_WAIT_MS; waited += 200) {
    const pid = service_pid(home);
    if (service_ready(home, pid)) {
      if (child && pid !== child.pid && child.exitCode === null) child.kill();
      return { running: true, ready: true, pid, started: pid === child?.pid };
    }
    if (spawn_error) throw spawn_error;
    await sleep(200);
  }
  throw new Error(`讨论服务尚未确认就绪，请查看 ${join(home, 'service.log')}`);
}

/** Ask the service to pause its runs and exit, then wait for its lock to be released. */
async function stop_service(home) {
  if (!service_pid(home)) return { running: false };
  atomic_json(join(home, 'stop.request'), { requested_at: Math.floor(Date.now() / 1000) });
  for (let waited = 0; waited < STOP_WAIT_MS; waited += 500) {
    if (!service_pid(home)) return { running: false };
    await sleep(500);
  }
  throw new Error('讨论服务未在 20 秒内退出；请查看 service.log');
}

/** Report liveness with the last per-room result written by the service. */
function service_status(home) {
  const pid = service_pid(home);
  const path = join(home, 'status.json');
  const saved = pid && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const last = saved.pid === pid ? saved : {};
  return { running: Boolean(pid), ready: service_ready(home, pid), pid, home, configs: read_registry(home), updated_at: last.updated_at || 0, rooms: last.rooms || [] };
}

/** Open each registered site once in the default browser. */
function open_sites(home) {
  const sites = new Set();
  for (const path of read_registry(home)) {
    try { sites.add(load_config(path).site); } catch { /* status reports broken configs. */ }
  }
  for (const site of sites) {
    const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', site]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [site]];
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  }
  return [...sites];
}

/** Create a Windows shortcut through WScript.Shell; values pass via env to avoid quoting. */
function write_shortcut(folder, action) {
  if (process.platform !== 'win32') throw new Error('快捷方式仅支持 Windows；其他系统请直接运行 start');
  const script = "$d=[Environment]::GetFolderPath($env:SC_FOLDER); $p=Join-Path $d $env:SC_NAME;"
    + " $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath=$env:SC_TARGET;"
    + " $s.Arguments=$env:SC_ARGS; $s.WorkingDirectory=$env:SC_CWD; $s.WindowStyle=7;"
    + " $s.Description='AI CoDiscuss 讨论服务'; $s.Save(); Write-Output $p";
  return powershell(script, { SC_FOLDER: folder, SC_NAME: SHORTCUT_NAME, SC_TARGET: process.execPath,
    SC_ARGS: `"${SCRIPT}" ${action}`, SC_CWD: REPO_ROOT });
}

/** Remove the login autostart shortcut when present. */
function remove_shortcut(folder) {
  if (process.platform !== 'win32') throw new Error('开机自启仅支持 Windows');
  const script = "$p=Join-Path ([Environment]::GetFolderPath($env:SC_FOLDER)) $env:SC_NAME;"
    + " if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p }; Write-Output $p";
  return powershell(script, { SC_FOLDER: folder, SC_NAME: SHORTCUT_NAME });
}

/** Run one PowerShell snippet and return its single output line. */
function powershell(script, env) {
  const utf8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', utf8 + script],
    { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`PowerShell 执行失败：${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}

/** Dispatch one service command; installing shortcuts or registering never starts a discussion. */
export async function main(args = process.argv.slice(2), print = value => process.stdout.write(JSON.stringify(value) + '\n')) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { config: { type: 'string' } } });
  const [command, option] = positionals;
  const home = service_home();
  assert_shared_home(home);
  const require_config = () => { if (!values.config) throw new Error('请用 --config 指定私有房间配置'); return values.config; };
  switch (command) {
    case 'run': return run_service(home);
    case 'start': return print(await start_service(home));
    case 'stop': return print(await stop_service(home));
    case 'status': return print(service_status(home));
    case 'open': return print({ ...(await start_service(home)), opened: open_sites(home) });
    case 'list': return print({ home, configs: read_registry(home) });
    case 'add': { const config = register_room(home, require_config()); return print({ added: config.room, site: config.site }); }
    case 'remove': unregister_room(home, require_config()); return print({ removed: resolve(values.config) });
    case 'clean': return print(sweep_service_home(home));
    case 'shortcut': return print({ shortcut: write_shortcut('Desktop', 'open') });
    case 'autostart':
      if (option === 'on') return print({ autostart: write_shortcut('Startup', 'start') });
      if (option === 'off') return print({ removed: remove_shortcut('Startup') });
      throw new Error('用法: autostart on|off');
    default: throw new Error(USAGE);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

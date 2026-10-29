/** Shared room configuration, local bindings and the unified request runner CLI. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup_sidecar } from './discussion_adapters.mjs';
import { read_api_key } from './discussion_api.mjs';
import { access_levels, PROJECT_ACCESS, READ_RULE } from './expert_prompts.mjs';
import { validate_scheduler } from './scheduler.mjs';

const POLL_MS = 2000;
let rg_available;
/**
 * Windows PowerShell mis-decodes UTF-8 files, so point the AI at rg when its commands can run it; free rooms and
 * discussions share it. Codex CLI puts its own bundled rg on its commands' PATH (tested 0.163), even where this
 * machine's PATH has none; other software gets the rule only when rg is installed here.
 */
export function read_rule(adapter) {
  if (process.platform !== 'win32') return '';
  rg_available ??= spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  return rg_available || adapter === 'codex_cli' ? READ_RULE : '';
}

const ADAPTER_NAMES = ['codex', 'claude', 'antigravity', 'codex_cli', 'antigravity_cli', 'api'];
export const CODEX_ADAPTERS = ['codex', 'codex_cli'];
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The shared prompt for rounds bridged without named follow-ups: experts answer and question each other. */
export function peer_round_question(round) {
  return `第 ${round} 轮：先读取上一轮其他专家的最新回答，回应你不同意或需要补充的观点；被其他专家 @ 提问时优先回答，也可以 @ 某位专家提出问题。`;
}

/** Explicit per-room configuration is the only source of software paths and capabilities. */
export function load_config(path) {
  return validate_config(JSON.parse(readFileSync(path, 'utf8')), dirname(resolve(path)));
}

/** Keep service-managed answers outside all room credentials, logs and databases. */
export function service_drafts(home, directory) {
  const key = createHash('sha256').update(resolve(directory)).digest('hex');
  return join(home, 'drafts', key);
}

/** Validate a launch draft with the same rules as a registered room configuration. */
export function validate_config(input, base_directory) {
  const config = structuredClone(input);
  config.project = config.cli_project || config.project || REPO_ROOT;
  const url = new URL(config.site);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('站点必须是无路径和凭据的 HTTP(S) 根地址');
  if (!/^[A-Za-z0-9_-]+$/.test(config.room ?? '') || typeof config.token !== 'string' || config.token.length < 32) throw new Error('缺少房间及本房间凭据');
  if (!config.project || !existsSync(join(config.project, 'runner', 'discuss.py'))) throw new Error('cli_project 必须指向 AI CoDiscuss 项目；省略时默认使用本仓库');
  // A free room of manual members runs here only for smart scheduling or a preset project directory, which need no local software.
  if (!config.participants || (!Object.keys(config.participants).length && !(config.mode === 'free' && (config.scheduler || config.cwd)))) throw new Error('请配置本机参与软件');
  for (const participant of Object.values(config.participants)) {
    if (participant.adapter === 'api') {
      read_api_key(config.api_home, participant);
      for (const field of ['cwd', 'project_name', 'project_id', 'executable', 'effort']) delete participant[field];
      participant.project_access = 'read';
      continue;
    }
    participant.cwd = participant.cwd ?? config.cwd;
    participant.project_name = participant.project_name ?? config.discussion_project;
    participant.project_access = participant.project_access || config.project_access || 'read';
    // `own` is set only when the service takes over a manual member: it keeps its own session's permissions.
    if (![...PROJECT_ACCESS, 'own'].includes(participant.project_access)) throw new Error('project_access 只能为 read、write、auto 或 full');
    if (participant.project_access !== 'own' && !access_levels(participant.adapter).includes(participant.project_access)) throw new Error('agy 无人值守不支持自动档，请选只读、可写或完全放开');
    if (participant.cwd && !statSync(participant.cwd).isDirectory()) throw new Error('cwd 必须是已有本机目录');
    if (!ADAPTER_NAMES.includes(participant.adapter)) throw new Error(`适配器只能为 ${ADAPTER_NAMES.join('/')}`);
    if (participant.adapter === 'antigravity' && !participant.ipc_directory) throw new Error('缺少 Antigravity Sidecar IPC 目录');
    if (participant.adapter !== 'antigravity' && !existsSync(participant.executable ?? '')) throw new Error('请指定实际原生可执行文件');
    if (participant.adapter === 'codex' && !participant.source_thread_id && !participant.session_id) throw new Error('Codex 新建入口需要实际来源聊天 ID');
  }
  if (![undefined, 'free', 'brainstorm'].includes(config.mode)) throw new Error('房间模式只能为 free 或 brainstorm');
  if (config.mode === 'free' && Object.keys(config.participants).some(name => typeof config.members?.[name]?.token !== 'string' || config.members[name].token.length < 32)) {
    throw new Error('自由房间须为每位成员保存成员凭证');
  }
  // Smart scheduling is optional; without it every decision stays with the host.
  if (config.scheduler) config.scheduler = validate_scheduler(config.api_home, config.scheduler);
  return { ...config, site: url.origin, project: resolve(config.project), directory: resolve(config.data_directory || join(base_directory, `discussion-${config.room}`)) };
}

/** Send exactly one bounded website request; never follow redirects with a capability. */
export async function api(config, tail, body, token = config.token) {
  const response = await fetch(`${config.site}/api/rooms/${config.room}${tail}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error || '请求失败'}`);
  return result;
}

/** Persistent software bindings and room metadata; old event inbox rows are left unread. */
export class DiscussionStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'runtime.sqlite3'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings(participant TEXT PRIMARY KEY,session_id TEXT NOT NULL);`);
  }
  /** Keep local bindings in their original room, accepting its old event-run scope. */
  scope(config) {
    const scope = `${config.site}/${config.room}`;
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='scope'").get()?.value;
    if (previous && previous !== scope && !previous.startsWith(`${scope}/`)) throw new Error('数据目录已绑定另一站点或房间；请选择独立目录');
    this.db.prepare("INSERT INTO metadata VALUES ('scope',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(scope);
  }
  /** Do not silently reuse a conversation after its software project or cwd changes. */
  context(config, allow_codex_switch = false) {
    const entries = Object.entries(config.participants).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, item.adapter, item.project_id || '', item.project_name || '',
        item.cwd ? resolve(item.cwd) : '', item.workdir ? resolve(item.workdir) : '', item.session_id || '']);
    const context = JSON.stringify(entries);
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='context'").get()?.value;
    if (previous === context) return;
    if (previous && previous !== context) {
      const before = JSON.parse(previous);
      const allowed = allow_codex_switch && before.length === entries.length && before.every((item, index) => {
        const next = entries[index];
        if (JSON.stringify(item) === JSON.stringify(next)) return true;
        const session = this.binding(item[0]).session_id || item[6];
        return item[0] === next[0] && item[1] !== next[1] && CODEX_ADAPTERS.includes(item[1])
          && CODEX_ADAPTERS.includes(next[1]) && session && next[6] === session && (!item[6] || item[6] === session)
          && JSON.stringify(item.slice(2, 6)) === JSON.stringify(next.slice(2, 6));
      });
      // Experts invited during a run only add entries; every existing binding must stay as it was.
      const added = before.every(item => entries.some(next => JSON.stringify(next) === JSON.stringify(item)));
      if (!allowed && !added) throw new Error('已绑定会话的项目、cwd 或身份配置发生变化；请暂停并使用独立运行目录重新接入');
    }
    this.db.prepare("INSERT INTO metadata VALUES ('context',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(context);
  }
  /** Resolve actual session bindings without reading unrelated conversations. */
  binding(participant) { return this.db.prepare('SELECT session_id FROM bindings WHERE participant=?').get(participant) || {}; }
  /** Commit a returned session before later notifications can use it. */
  bind(participant, session_id) { this.db.prepare('INSERT INTO bindings VALUES (?,?) ON CONFLICT(participant) DO UPDATE SET session_id=excluded.session_id').run(participant, session_id); }
  /** Release this instance's database connection. */
  close() { this.db.close(); }
}

/** Hold one PID lock per runtime directory, without taking over a live owner. */
export function acquire_lock(directory) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'runner.lock');
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('此目录已有通知程序运行；不重复启动');
    unlinkSync(path);
  }
  writeFileSync(path, String(process.pid), { flag: 'wx', mode: 0o600 });
  return () => { if (existsSync(path) && readFileSync(path, 'utf8') === String(process.pid)) unlinkSync(path); };
}

/** Pause the active discussion before its local consumer exits. */
export async function pause_if_running(config) {
  const latest = await api(config, '/discussion');
  if (latest.session?.status === 'active') await api(config, '/discussion', { action: 'pause', revision: latest.revision });
}

/** Start or resume the room's discussion with a freshly read control revision. */
async function start_discussion(config, minutes_value) {
  const room = await api(config, '');
  const current = await api(config, '/discussion');
  if (current.session?.status === 'active') return;
  const minutes = Number(minutes_value ?? current.session?.limits.max_minutes ?? room.limits?.max_minutes ?? 0);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error('总时长或 --minutes 须在 [0,1440]，0 表示不限时长');
  if (!config.members?.[room.host]?.token) throw new Error('缺少主持人成员凭据；请重新接入房间后开启讨论');
  if (current.session) {
    if (minutes_value !== undefined) await api(config, '/limits', { max_minutes: minutes, revision: current.revision });
    const latest = await api(config, '/discussion');
    return api(config, '/discussion', { action: 'resume', revision: latest.revision });
  }
  return api(config, '/discussion', { action: 'start', revision: current.revision, goal: room.goal,
    named_followup: Boolean(room.named_followup), limits: { max_minutes: minutes,
      max_rounds: room.limits?.max_rounds ?? 0, execution_minutes: room.limits?.execution_minutes ?? 0 } });
}

/** Run an explicitly configured room; install and status never start a discussion. */
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, once: { type: 'boolean' }, minutes: { type: 'string' },
  } });
  if (!values.config || !['watch', 'start', 'status', 'pause', 'setup-sidecar'].includes(positionals[0])) {
    throw new Error('用法: discussion_runner.mjs watch|start|status|pause|setup-sidecar --config 私有配置.json [--minutes 60] [--once]');
  }
  const config = load_config(values.config);
  if (positionals[0] === 'setup-sidecar') {
    for (const participant of Object.values(config.participants).filter(item => item.adapter === 'antigravity')) process.stdout.write(JSON.stringify(setup_sidecar(participant)) + '\n');
    return;
  }
  const run = await api(config, '/discussion');
  if (positionals[0] === 'status') { process.stdout.write(JSON.stringify(run) + '\n'); return; }
  if (positionals[0] === 'pause') { await api(config, '/discussion', { action: 'pause', revision: run.revision }); return; }
  const release = acquire_lock(config.directory);
  const store = new DiscussionStore(config.directory);
  const { FreeRoomRunner } = await import('./free_runner.mjs');
  const runner = new FreeRoomRunner(config, store);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    store.context(config);
    store.scope(config);
    if (positionals[0] === 'start') await start_discussion(config, values.minutes);
    do {
      try { if (await runner.tick() === false) break; }
      catch (error) { process.stderr.write(JSON.stringify({ error: error.message }) + '\n'); if (values.once) throw error; }
      if (!values.once && !stopped) await sleep(POLL_MS);
    } while (!values.once && !stopped);
  } finally {
    if (stopped) {
      try { await pause_if_running(config); }
      catch (error) { process.stderr.write(`停止回执未确认；租约到期后拒绝写入：${error.message}\n`); }
    }
    runner.stop_children(); store.close(); release();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

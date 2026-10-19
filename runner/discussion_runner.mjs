/** Durable website-event delivery to existing AI software; no model API orchestration. */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json, deliver_task, setup_sidecar, sidecar_receipt, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';

const POLL_MS = 2000;
const DELIVERY_RETRY_DELAYS_MS = [2000, 4000];
const RENEW_MS = 30_000;
const ADAPTER_NAMES = ['codex', 'claude', 'antigravity', 'codex_cli', 'antigravity_cli'];
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Project files in cwd are read-only unless the launch or participant explicitly grants write. */
const PROJECT_ACCESS = ['read', 'write'];

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
  if (!config.participants || !Object.keys(config.participants).length) throw new Error('请配置本机参与软件');
  for (const participant of Object.values(config.participants)) {
    participant.cwd = participant.cwd ?? config.cwd;
    participant.project_name = participant.project_name ?? config.discussion_project;
    participant.project_access = participant.project_access || config.project_access || 'read';
    if (!PROJECT_ACCESS.includes(participant.project_access)) throw new Error('project_access 只能为 read 或 write');
    if (participant.cwd && !statSync(participant.cwd).isDirectory()) throw new Error('cwd 必须是已有本机目录');
    if (!ADAPTER_NAMES.includes(participant.adapter)) throw new Error(`适配器只能为 ${ADAPTER_NAMES.join('/')}`);
    if (participant.adapter === 'antigravity' && !participant.ipc_directory) throw new Error('缺少 Antigravity Sidecar IPC 目录');
    if (participant.adapter !== 'antigravity' && !existsSync(participant.executable ?? '')) throw new Error('请指定实际原生可执行文件');
    if (participant.adapter === 'codex' && !participant.source_thread_id && !participant.session_id) throw new Error('Codex 新建入口需要实际来源聊天 ID');
  }
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

/** Persistent inbox, cursor and bindings share one local SQLite transaction boundary. */
export class DiscussionStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'runtime.sqlite3'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,event TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
        token TEXT NOT NULL DEFAULT '',sent_at INTEGER NOT NULL DEFAULT 0,last_renew INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS bindings(participant TEXT PRIMARY KEY,session_id TEXT NOT NULL);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(inbox)').all().map(column => column.name));
    for (const [name, definition] of Object.entries({ attempts: 'INTEGER NOT NULL DEFAULT 0',
      retry_at: 'INTEGER NOT NULL DEFAULT 0', receipt: "TEXT NOT NULL DEFAULT ''" })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE inbox ADD COLUMN ${name} ${definition}`);
    }
  }
  /** Atomically receive a page before moving its cursor. */
  receive(page) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const event of page.events) this.db.prepare('INSERT OR IGNORE INTO inbox(id,event) VALUES (?,?)').run(event.id, JSON.stringify(event));
      this.db.prepare("INSERT INTO metadata VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(page.next_after));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** Return the last durably ingested sequence. */
  cursor() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='cursor'").get()?.value || 0); }
  /** Never reuse another site's cursor or a previous runtime's software binding. */
  scope(config, run_id) {
    const scope = `${config.site}/${config.room}/${run_id}`;
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='scope'").get()?.value;
    if (previous && previous !== scope) throw new Error('数据目录已绑定另一站点、房间或运行；请选择独立目录');
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('scope',?)").run(scope);
  }
  /** Do not silently reuse a conversation after its software project or cwd changes. */
  context(config) {
    const context = JSON.stringify(Object.entries(config.participants).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, item]) => [name, item.adapter, item.project_id || '', item.project_name || '',
        item.cwd ? resolve(item.cwd) : '', item.workdir ? resolve(item.workdir) : '', item.session_id || '']));
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key='context'").get()?.value;
    if (previous && previous !== context) throw new Error('已绑定会话的项目、cwd 或身份配置发生变化；请暂停并使用独立运行目录重新接入');
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('context',?)").run(context);
  }
  /** Persist only known internal fields, never dynamic SQL column names. */
  record(id, fields) {
    const allowed = ['status', 'token', 'sent_at', 'last_renew', 'error', 'attempts', 'retry_at', 'receipt'];
    const entries = Object.entries(fields);
    if (entries.some(([key]) => !allowed.includes(key))) throw new Error('无效的内部状态字段');
    this.db.prepare(`UPDATE inbox SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([, value]) => value), id);
  }
  /** Resolve actual session bindings without reading unrelated conversations. */
  binding(participant) { return this.db.prepare('SELECT session_id FROM bindings WHERE participant=?').get(participant) || {}; }
  /** Commit a returned session before later notifications can use it. */
  bind(participant, session_id) { this.db.prepare('INSERT INTO bindings VALUES (?,?) ON CONFLICT(participant) DO UPDATE SET session_id=excluded.session_id').run(participant, session_id); }
  /** List work that still needs dispatch or reconciliation. */
  pending() { return this.db.prepare("SELECT * FROM inbox WHERE status NOT IN ('completed','cancelled','failed') ORDER BY id").all(); }
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

/** Write a non-secret task separately from its CLI-only credential file. */
export function task_files(config, event, token, binding) {
  const id = `event-${event.id}`;
  const draft_directory = config.draft_directory || `${config.directory}-drafts`;
  mkdirSync(draft_directory, { recursive: true });
  const access_path = join(config.directory, `${id}.access.json`);
  const task_path = join(config.directory, `${id}.task.json`);
  atomic_json(access_path, { site: config.site, room: config.room, token, session_id: binding.session_id || '' });
  const skills = [join(config.project, '.agents/skills/discuss-participant/SKILL.md')];
  if (event.role === 'host') skills.push(join(config.project, '.agents/skills/discuss-host/SKILL.md'));
  const adapter = config.participants[event.participant];
  const skills_directory = join(config.project, '.agents', 'skills');
  const project_rule = !adapter.cwd ? '未指定讨论项目目录。'
    : adapter.project_access === 'write' ? '用户允许按议题需要修改 cwd 中的项目文件。' : 'cwd 中的项目文件只读，不修改。';
  atomic_json(task_path, { site: config.site, room: config.room, event_id: event.id, participant: event.participant,
    project_name: adapter.project_name || null, cwd: adapter.cwd || null, project_access: adapter.project_access,
    draft_directory,
    role: event.role, turn_id: event.turn_id, skills, cli: 'codiscuss', subcommands: TASK_SUBCOMMANDS, access_file: access_path,
    instructions: '读取指定技能；网站命令只用 codiscuss 的 subcommands 子命令，命令以 codiscuss 开头，不用 python discuss.py、cd、管道或其他入口；使用 codiscuss execution enter 房间 执行编号 --access-file 凭据路径 进入。凭据文件由 CLI 内部读取，不要打印或读取其 token。进入成功后才处理本次安排；每次业务写入都带 --access-file。答案草稿只保存到 draft_directory，不修改任务、凭据、日志或调度数据库；' + project_rule + '只处理本次工作，不建定时任务。主持创建下一安排或收束即结束，专家提交原文后结束。无效或已进入的任务不要重复执行。' });
  const prompt = `用户已启动此房间的全自动讨论。请以 ${event.participant} 的${event.role === 'host' ? '主持' : '专家'}职责处理本次工作。先读取任务文件：${task_path}，立即用 codiscuss execution enter 进入，再读取指定版本的技能和网站现状。本次只放行任务内 subcommands 列出的 codiscuss 子命令，命令以 codiscuss 开头，不用 python discuss.py、cd、管道或其他入口。任务内 cwd 是讨论项目目录；${project_rule}项目读写仍受软件实际权限和议题授权约束。不读取凭据内容。实际会话 ID 由接入程序写入凭据文件，尚未就绪只短暂重查，不编造。`;
  return { id, participant: event.participant, directory: config.directory, draft_directory, skills_directory, access_path, prompt };
}

/** A running dispatcher retains only the processes it created itself. */
export class DiscussionRunner {
  constructor(config, store, deliver = deliver_task) {
    this.config = config;
    this.store = store;
    this.deliver = deliver;
    this.children = new Set();
    this.exited = new Set();
  }
  /** Reserve with a durable token so a lost HTTP response can be reconciled. */
  async dispatch(row, event) {
    const token = row.token || randomUUID();
    this.store.record(row.id, { token, status: 'reserving' });
    await api(this.config, `/events/${row.id}`, { action: 'reserve', execution_token: token });
    await this.deliver_reserved({ ...row, token }, event);
  }
  /** Retry only proven non-delivery, keeping the event, token and task unchanged. */
  async deliver_reserved(row, event) {
    const adapter = this.config.participants[event.participant];
    if (!adapter) throw new Error(`未配置 ${event.participant} 的本机接入`);
    const binding = this.store.binding(event.participant);
    if (!binding.session_id && adapter.session_id) binding.session_id = adapter.session_id;
    const attempts = row.attempts + 1;
    this.store.record(row.id, { status: 'dispatching', sent_at: Date.now(), attempts, error: '', retry_at: 0 });
    let invoked = false;
    try {
      const task = task_files(this.config, event, row.token, binding);
      invoked = true;
      const result = await this.deliver(adapter, binding, { ...task,
        on_binding: session => this.store.bind(event.participant, session),
        on_process: child => { this.children.add(child); child.once('close', () => this.children.delete(child)); },
        on_output: (path, chunk) => appendFileSync(path, chunk, { mode: 0o600 }),
        on_failure: error => { try { this.store.record(row.id, { error }); } catch { /* Store may already be closed at shutdown. */ } },
        on_exit: () => this.exited.add(row.id),
      });
      if (result.session_id) this.store.bind(event.participant, result.session_id);
      this.store.record(row.id, { status: result.status, receipt: result.receipt || '' });
    } catch (error) {
      const not_sent = !invoked || error.delivery_status === 'not_sent';
      this.store.record(row.id, { status: not_sent ? 'retry_wait' : 'uncertain', error: error.message,
        retry_at: not_sent ? Date.now() + (DELIVERY_RETRY_DELAYS_MS[attempts - 1] ?? 0) : 0 });
    }
  }
  /** Reconcile business evidence; accepted delivery alone never completes a task. */
  async reconcile(row, event) {
    if (['completed', 'cancelled', 'failed'].includes(event.status)) {
      this.store.record(row.id, { status: event.status });
      return;
    }
    // No app call occurs before dispatching is persisted. Reconcile a reserve response loss safely.
    if (row.status === 'reserving') {
      if (event.status === 'pending') return this.dispatch(row, event);
      if (event.status === 'dispatched') {
        const reserved = await api(this.config, `/events/${row.id}`, { action: 'view' }, row.token);
        if (reserved.status !== 'dispatched') return this.reconcile(row, reserved);
        return this.deliver_reserved(row, reserved);
      }
    }
    if (row.status === 'retry_wait' && event.status === 'dispatched') {
      if (row.attempts > DELIVERY_RETRY_DELAYS_MS.length) return this.fail(row, `投递 ${row.attempts} 次均确认未送出：${row.error}`);
      if (Date.now() >= row.retry_at) await this.deliver_reserved(row, event);
      return;
    }
    const adapter = this.config.participants[event.participant];
    if (adapter?.adapter === 'antigravity' && event.status === 'dispatched') {
      const receipt = sidecar_receipt(adapter, `event-${row.id}`);
      if (receipt?.session_id) this.store.bind(event.participant, receipt.session_id);
      if (receipt) this.store.record(row.id, { status: receipt.status, receipt: JSON.stringify(receipt), error: receipt.error || '' });
    }
    if (row.error && ['accepted', 'started'].includes(row.status)) return this.fail(row, row.error);
    if (this.exited.has(row.id) && ['dispatched', 'started'].includes(event.status)) {
      // A business write may have just completed the task; recheck before declaring a silent exit.
      const latest = await api(this.config, `/events/${row.id}`, { action: 'view' });
      if (['dispatched', 'started'].includes(latest.status)) return this.fail(row, `${event.participant} 会话已结束，但未保存本次结果`);
      return this.reconcile(row, latest);
    }
    if (event.status === 'started' && event.lease_until <= Math.floor(Date.now() / 1000)) return this.fail(row, '执行租约到期；旧会话不能继续写入');
    if (event.status === 'started' && Date.now() - row.last_renew >= RENEW_MS) {
      try { await api(this.config, `/events/${row.id}`, { action: 'renew' }); }
      catch (error) {
        if (/HTTP (403|409)/.test(error.message)) return this.fail(row, '执行时限已到；请核对原会话');
        throw error;
      }
      this.store.record(row.id, { status: 'started', last_renew: Date.now(), error: '' });
    }
  }
  /** Preserve the cause on the website and revoke work before asking for intervention. */
  async fail(row, reason) {
    await api(this.config, `/events/${row.id}`, { action: 'fail', reason });
    this.store.record(row.id, { status: 'failed', error: reason });
    this.stop_children();
  }
  /** Process one bounded iteration without waking models for empty checks. */
  async tick() {
    this.store.context(this.config);
    let room = await api(this.config, '');
    if (room.limits?.reached && (!room.limits.closing || room.limits.reason === 'time_limit') && room.runtime.status === 'running') {
      const generation = room.runtime.generation;
      room = await api(this.config, '/limits', { actor: '用户' });
      if (room.runtime.generation !== generation) this.stop_children();
    }
    const run = room.runtime;
    if (run.run_id) this.store.scope(this.config, run.run_id);
    if (run.mode !== 'automatic' || run.status !== 'running' || run.expired) {
      this.stop_children();
      if (run.expired) await api(this.config, '/runtime', { action: 'pause', revision: run.revision });
      for (const row of this.store.pending()) {
        const event = await api(this.config, `/events/${row.id}`, { action: 'view' });
        if (['completed', 'cancelled', 'failed'].includes(event.status)) this.store.record(row.id, { status: event.status });
      }
      // A paused automatic run waits so the web restart can resume it; stop, conclusion or manual mode ends the loop.
      return run.mode === 'automatic' && (run.status === 'paused' || run.expired) ? 'waiting' : false;
    }
    this.store.receive(await api(this.config, `/events?after=${this.store.cursor()}`));
    const rows = this.store.pending();
    for (const row of rows.filter(item => item.status !== 'pending')) {
      const event = await api(this.config, `/events/${row.id}`, { action: 'view' });
      await this.reconcile(row, event);
    }
    if (this.store.pending().some(row => row.status !== 'pending')) return;
    const current = room.current_turn;
    const pending = rows.filter(row => row.status === 'pending').map(row => ({ row, event: JSON.parse(row.event) }));
    const eligible = pending.filter(({ event }) => event.generation === run.generation && event.run_id === run.run_id
      && (current && ['pending', 'notified'].includes(current.status) ? event.turn_id === current.id : event.role === 'host'));
    for (const { row, event } of pending) {
      if (event.generation !== run.generation || event.run_id !== run.run_id) this.store.record(row.id, { status: 'cancelled' });
    }
    const next = eligible.at(-1);
    if (next) {
      const fresh = await api(this.config, `/events/${next.row.id}`, { action: 'view' });
      if (fresh.status === 'pending') {
        await this.dispatch(next.row, fresh);
      }
      else this.store.record(next.row.id, { status: fresh.status });
    }
  }
  /** Stop only child processes created by this runner, never the desktop apps. */
  stop_children() { for (const child of this.children) child.kill(); }
}

/** Pause a running automatic run so the website never shows work nobody will consume. */
export async function pause_if_running(config) {
  const latest = await api(config, '/runtime');
  if (latest.status === 'running') await api(config, '/runtime', { action: 'pause', revision: latest.revision });
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
  const run = await api(config, '/runtime');
  if (positionals[0] === 'status') { process.stdout.write(JSON.stringify(run) + '\n'); return; }
  if (positionals[0] === 'pause') { await api(config, '/runtime', { action: 'pause', revision: run.revision }); return; }
  const release = acquire_lock(config.directory);
  const store = new DiscussionStore(config.directory);
  const runner = new DiscussionRunner(config, store);
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    store.context(config);
    if (run.run_id) store.scope(config, run.run_id);
    if (positionals[0] === 'start') {
      const room = await api(config, '');
      const minutes = Number(values.minutes ?? room.limits?.max_minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw new Error('请在网页设置总时长，或指定 --minutes，范围 (0,1440]');
      if (![room.host, ...Object.keys(room.experts)].every(name => config.participants[name])) throw new Error('尚未配置全部参与者的本机软件');
      await api(config, '/runtime', { action: 'start', mode: 'automatic', revision: run.revision, deadline: Math.floor(Date.now() / 1000 + minutes * 60) });
    }
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

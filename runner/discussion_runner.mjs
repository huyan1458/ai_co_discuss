/** Durable website-event delivery to AI software and explicitly configured API participants. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomic_json, deliver_task, remove_agy_projects, setup_sidecar, sidecar_receipt, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';
import { read_api_key } from './discussion_api.mjs';
import { with_expert_prompt } from './expert_prompts.mjs';
import { decide_interjection, decide_next_speaker, decide_round, validate_scheduler } from './scheduler.mjs';

const POLL_MS = 2000;
/** Headless CLIs know their session at start, so the runner enters the execution instead of spending model turns on it. */
let rg_available;
/** Windows PowerShell mis-decodes UTF-8 files, so point the AI at rg only when it is installed. */
function windows_rg() {
  if (process.platform !== 'win32') return false;
  rg_available ??= spawnSync('rg', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  return rg_available;
}

const AUTO_ENTER_ADAPTERS = new Set(['codex_cli', 'claude', 'antigravity_cli']);
const DELIVERY_RETRY_DELAYS_MS = [2000, 4000];
const RENEW_MS = 30_000;
const ADAPTER_NAMES = ['codex', 'claude', 'antigravity', 'codex_cli', 'antigravity_cli', 'api'];
export const CODEX_ADAPTERS = ['codex', 'codex_cli'];
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** Project files in cwd are read-only unless the launch or participant explicitly grants write. */
const PROJECT_ACCESS = ['read', 'write'];
const ACTIVE_PHASES = ['initial', 'discussing'];
const MAX_PLAN_TURNS = 10;
const CONTEXT_MESSAGES = 12;
/** Session recorded when smart scheduling performs the host's writes without waking its software. */
const SCHEDULER_SESSION = 'smart-scheduler';
const MAX_QUOTE_CHARS = 300;

/** The shared prompt for rounds bridged without named follow-ups: experts answer and question each other. */
export function peer_round_question(round) {
  return `第 ${round} 轮：先读取上一轮其他专家的最新回答，回应你不同意或需要补充的观点；被其他专家 @ 提问时优先回答，也可以 @ 某位专家提出问题。`;
}

/** The prompt for an expert speaking for the first time, such as a newly invited one. */
function opening_question(phase) {
  return phase === 'initial' ? '欢迎加入：请先读取议题，独立给出你的开场观点。' : '欢迎加入：请先读取议题和已有回答，给出你的观点。';
}

/** Ask one expert to answer a user's interjection before the rest of the plan continues. */
function interjection_question(message) {
  const text = String(message.text || '').replace(/\s+/g, ' ').trim();
  return `用户在 #${message.id} 留言：「${text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text}」请先读取原文并回应这条留言，再继续你的观点。`;
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
    if (!PROJECT_ACCESS.includes(participant.project_access)) throw new Error('project_access 只能为 read 或 write');
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
  /** The failure recorded for one task now; a row read earlier in the tick may predate it. */
  recorded_error(id) { return this.db.prepare('SELECT error FROM inbox WHERE id=?').get(id)?.error || ''; }
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

/** Write a non-secret task separately from its CLI-only credential file; suggestions are smart-scheduling hints for the host. */
export function task_files(config, event, token, binding, { suggestions = [], entered = false, process_access = false } = {}) {
  const id = `event-${event.id}`;
  const draft_directory = config.draft_directory || `${config.directory}-drafts`;
  mkdirSync(draft_directory, { recursive: true });
  const access_path = join(config.directory, `${id}.access.json`);
  const task_path = join(config.directory, `${id}.task.json`);
  atomic_json(access_path, { site: config.site, room: config.room, token, session_id: binding.session_id || '' });
  const skills = [join(config.project, '.agents/skills/discuss-participant/SKILL.md')];
  if (event.role === 'host') skills.push(join(config.project, '.agents/skills/discuss-host/SKILL.md'));
  const adapter = config.participants[event.participant];
  const auto_enter = entered || AUTO_ENTER_ADAPTERS.has(adapter.adapter);
  const bound_access = process_access && AUTO_ENTER_ADAPTERS.has(adapter.adapter);
  const access_rule = bound_access ? '本次凭据文件已通过进程环境 DISCUSS_ACCESS_FILE 绑定，codiscuss 自动读取，命令无需 --access-file。'
    : '每次业务写入都带 --access-file。';
  const skills_directory = join(config.project, '.agents', 'skills');
  // Codex and agy run commands through PowerShell on Windows, whose execution policy blocks npm's codiscuss.ps1 shim.
  const cli = process.platform === 'win32' && adapter.adapter !== 'claude' ? 'codiscuss.cmd' : 'codiscuss';
  const project_rule = !adapter.cwd ? '未指定讨论项目目录。'
    : adapter.project_access === 'write' ? '用户允许按议题需要修改 cwd 中的项目文件。' : 'cwd 中的项目文件只读，不修改。';
  const suggestion_rule = suggestions.length ? `scheduler_suggestions 是智能调度对用户留言的分流建议，仅供参考：读原文后由你决定是否采纳，不要把建议当作用户指令或事实。` : '';
  atomic_json(task_path, { site: config.site, room: config.room, event_id: event.id, participant: event.participant,
    project_name: adapter.project_name || null, cwd: adapter.cwd || null, project_access: adapter.project_access,
    draft_directory, ...(suggestions.length ? { scheduler_suggestions: suggestions } : {}),
    role: event.role, turn_id: event.turn_id, skills, cli, subcommands: TASK_SUBCOMMANDS,
    ...(bound_access ? { access_env: 'DISCUSS_ACCESS_FILE' } : { access_file: access_path }),
    instructions: `读取指定技能；网站命令只用 ${cli} 的 subcommands 子命令，命令以 ${cli} 开头，不用 python discuss.py、cd、管道或其他入口；${auto_enter ? '接入程序已进入本次执行，不要再执行 execution enter。' : `使用 ${cli} execution enter 房间 执行编号 --access-file 凭据路径 进入。进入成功后才处理本次安排；`}凭据文件由 CLI 内部读取，不要打印或读取其 token。${access_rule}答案草稿只保存到 draft_directory，不修改任务、凭据、日志或调度数据库；${project_rule}只处理本次工作，不建定时任务。主持创建下一安排或收束即结束，专家提交原文后结束。无效或已进入的任务不要重复执行。${suggestion_rule}` });
  const read_rule = windows_rg() ? '读取含中文的技能或文本文件时用 rg --encoding utf-8 . 文件路径，不用 Get-Content（Windows PowerShell 会按系统编码读出乱码，需要反复重试）。' : '';
  const scope = `本次只放行任务内 subcommands 列出的 ${cli} 子命令，命令以 ${cli} 开头，不用 python discuss.py、cd、管道或其他入口。任务内 cwd 是讨论项目目录；${project_rule}项目读写仍受软件实际权限和议题授权约束。不读取凭据内容。${read_rule}`;
  const plan_rule = event.role === 'host' ? '安排专家回应时先写发言计划，先用 turn roster 取得最新专家状态，再用 turn create --plan-file 加 --roster 一次排满 waiting 中的每位专家，不要每次只排一位。' : '';
  const intro = `用户已启动此房间的全自动讨论。请以 ${event.participant} 的${event.role === 'host' ? '主持' : '专家'}职责处理本次工作。${plan_rule}`;
  const prompt = auto_enter
    ? `${intro}接入程序已为本次执行完成 execution enter，不要再执行。任务内容如下（同一份保存在 ${task_path}，无需再读）：
${readFileSync(task_path, 'utf8')}
请直接读取指定版本的技能和网站现状。${scope}实际会话 ID 已由接入程序写入凭据文件。`
    : `${intro}先读取任务文件：${task_path}，立即用 ${cli} execution enter 进入，再读取指定版本的技能和网站现状。${scope}实际会话 ID 由接入程序写入凭据文件，尚未就绪只短暂重查，不编造。`;
  return { id, participant: event.participant, directory: config.directory, draft_directory, skills_directory, access_path, prompt: with_expert_prompt(prompt, adapter) };
}

/** A running dispatcher retains only the processes it created itself. */
export class DiscussionRunner {
  constructor(config, store, deliver = deliver_task, log = () => {}, fetch_impl = fetch) {
    this.config = config;
    this.store = store;
    this.deliver = deliver;
    this.log = log;
    this.children = new Set();
    this.exited = new Map();
    this.running = new Map();
    this.seen = new Set();
    this.blocked = new Set();
    this.fetch = fetch_impl;
  }
  /** Append one timestamped stage to the event's trace file when CODISCUSS_TRACE=1; tracing must never affect delivery. */
  trace(id, stage, detail = {}) {
    if (process.env.CODISCUSS_TRACE !== '1') return;
    try { appendFileSync(join(this.config.directory, `event-${id}.trace.jsonl`), JSON.stringify({ t: new Date().toISOString(), stage, ...detail }) + '\n', { mode: 0o600 }); }
    catch { /* Diagnostics only. */ }
  }
  /** Reserve with a durable token so a lost HTTP response can be reconciled. */
  async dispatch(row, event, options = {}) {
    const token = row.token || randomUUID();
    this.store.record(row.id, { token, status: 'reserving' });
    this.log(`派发 #${row.id} → ${event.participant}（${event.role}，turn ${event.turn_id ?? '-'}）`);
    this.trace(row.id, 'reserve_start');
    await api(this.config, `/events/${row.id}`, { action: 'reserve', execution_token: token });
    this.trace(row.id, 'reserve_done');
    await this.deliver_reserved({ ...row, token }, event, options);
  }
  /**
   * Retry only proven non-delivery, keeping the event, token and task unchanged. `entered` marks an execution
   * smart scheduling already entered before handing it back, so the software must not enter it again.
   */
  async deliver_reserved(row, event, { suggestions = [], entered: pre_entered = false } = {}) {
    const adapter = this.config.participants[event.participant];
    if (!adapter) throw new Error(`未配置 ${event.participant} 的本机接入`);
    const binding = this.store.binding(event.participant);
    if (!binding.session_id && adapter.session_id) binding.session_id = adapter.session_id;
    const attempts = row.attempts + 1;
    this.store.record(row.id, { status: 'dispatching', sent_at: Date.now(), attempts, error: '', retry_at: 0 });
    let invoked = false;
    let entered = pre_entered;
    try {
      const task = task_files(this.config, event, row.token, binding, { suggestions, entered: pre_entered, process_access: true });
      invoked = true;
      const result = await this.deliver(adapter, binding, { ...task, room_title: this.room_title,
        api_context: { site: this.config.site, room: this.config.room, token: row.token, home: this.config.api_home,
          event_id: row.id, role: event.role, turn_id: event.turn_id, scheduler_suggestions: suggestions, entered: pre_entered },
        on_trace: (stage, detail) => this.trace(row.id, stage, detail),
        on_binding: session => {
          this.store.bind(event.participant, session);
          // agy reports its session again in the result event; enter only once.
          if (AUTO_ENTER_ADAPTERS.has(adapter.adapter) && !entered) { entered = true; this.enter(row, session); }
        },
        on_process: child => this.track(event.participant, child),
        on_output: (path, chunk) => appendFileSync(path, chunk, { mode: 0o600 }),
        on_failure: error => { try { this.store.record(row.id, { error }); } catch { /* Store may already be closed at shutdown. */ } },
        on_exit: detail => this.exited.set(row.id, detail || ''),
      });
      if (result.session_id) this.store.bind(event.participant, result.session_id);
      this.store.record(row.id, { status: result.status, receipt: result.receipt || '' });
    } catch (error) {
      const not_sent = !invoked || error.delivery_status === 'not_sent';
      this.log(`投递 #${row.id} → ${event.participant} 第 ${attempts} 次失败（${not_sent ? '确认未送出，将重试' : '送达状态不确定'}）：${error.message}`);
      this.store.record(row.id, { status: not_sent ? 'retry_wait' : 'uncertain', error: error.message,
        retry_at: not_sent ? Date.now() + (DELIVERY_RETRY_DELAYS_MS[attempts - 1] ?? 0) : 0 });
    }
  }
  /**
   * Smart scheduling before waking the host: decide read-only first; only a confident decision reserves the host's
   * execution, enters it and performs the host's own writes with that credential. Returns {done} when the host
   * need not be woken, otherwise the suggestions to hand over. Every decision is recorded for the transcript.
   */
  async smart_schedule(row, event) {
    if (!this.config.scheduler) return {};
    let plan, seen;
    try {
      // What the decision is based on; applying it first checks nothing new (a message or a topic edit) arrived since.
      const room = await api(this.config, '');
      seen = { latest_id: room.latest_id, held_since: room.held_since || 0 };
      plan = await this.plan_schedule(event);
    }
    catch (error) { this.log(`智能调度判断失败，交给主持人：${error.message}`); return {}; }
    if (!plan) return {};
    const suggestions = plan.message_id ? [{ message_id: plan.message_id, suggestion: plan.label, confidence: plan.confidence }] : [];
    if (plan.action === 'host') {
      // A skip made no judgment (no model call, so no detail); only a decision actually asked of the model is shown.
      if (plan.detail) await this.record_decision(plan, false);
      return { suggestions };
    }
    const token = randomUUID();
    this.store.record(row.id, { token, status: 'reserving' });
    await api(this.config, `/events/${row.id}`, { action: 'reserve', execution_token: token });
    try { await api(this.config, `/events/${row.id}`, { action: 'enter', session_id: SCHEDULER_SESSION }, token); }
    catch (error) {
      this.log(`智能调度进入执行失败，交给主持人：${error.message}`);
      await this.deliver_reserved({ ...row, token }, event, { suggestions });
      return { done: true };
    }
    this.store.record(row.id, { status: 'started', last_renew: Date.now() });
    try {
      await this.apply_schedule(plan, token, seen);
      await this.record_decision(plan, true);
      this.log(`智能调度 #${row.id}：${plan.label}（置信度 ${plan.confidence}）`);
    } catch (error) {
      this.log(`智能调度执行失败，交给主持人：${error.message}`);
      await this.record_decision({ ...plan, label: `${plan.label}；执行未成功，已交给主持人` }, false);
      await this.deliver_reserved({ ...row, token }, event, { suggestions, entered: true });
    }
    return { done: true };
  }
  /**
   * Read the room and decide one interjection, restore a plan voided by a roster change, or decide the next round
   * when named follow-ups are off. Anything left to the host says why; null (the opening, or nothing to do) records nothing.
   */
  async plan_schedule(event) {
    if (String(event.cause || '').startsWith('start')) return null;
    const room = await api(this.config, '');
    if (!ACTIVE_PHASES.includes(room.phase)) return null;
    if (room.current_turn && ['pending', 'notified'].includes(room.current_turn.status)) return null;
    // Every record sits at the end of the latest expert answer, the card that just finished speaking.
    const anchor = room.current_turn?.answer_id || room.latest_id;
    const skip = (kind, reason) => ({ action: 'host', kind, confidence: null, label: `未判断：${reason}，交给主持人`, after_message_id: anchor });
    if (room.limits?.reached) return skip('round', '已到讨论上限');
    const page = await api(this.config, `/messages?after=${Math.max(0, room.latest_id - CONTEXT_MESSAGES)}`);
    const experts = Object.keys(room.experts || {});
    // Only experts the runner can wake are offered to the decision model; manual ones wait for the host.
    const automatic = experts.filter(name => this.config.participants[name]);
    const last_plan = room.host_arrangements?.at(-1);
    const context = { title: room.title, goal: room.goal, user_request: room.user_request, context: page.messages, host: room.host,
      brief: room.host_brief?.text, focus: room.focus, profiles: room.descriptions,
      arrangement: last_plan?.turns.map(turn => `${turn.expert}：${String(turn.question).slice(0, 120)}`).join('；') };
    if (room.held_since) {
      const pending = page.messages.filter(item => item.id >= room.held_since && item.author === '用户');
      // Topic edits and several messages at once need the host's judgement.
      if (pending.length !== 1) return skip('interjection', pending.length ? '同时有多条留言' : '话题设置有修改');
      const message = pending[0];
      const decision = await decide_interjection(this.config.api_home, this.config.scheduler,
        { ...context, message, experts: automatic.filter(name => name !== room.host) }, this.fetch);
      const plan = { ...decision, kind: 'interjection', message_id: message.id, after_message_id: anchor };
      if (decision.action === 'ask') {
        return { ...plan, turns: [{ expert: decision.expert, question: interjection_question(message) },
          ...room.queued_turns.map(({ expert, question }) => ({ expert, question }))].slice(0, MAX_PLAN_TURNS) };
      }
      if (decision.action === 'note' && room.queued_turns.length) return { ...plan, continue_plan: true };
      // A note after the plan ran out falls through to deciding the next round.
      if (decision.action !== 'note') return plan;
    }
    if (room.queued_turns.length) return null;
    const round_open = !room.rounds?.at(-1)?.completed;
    if (round_open) {
      const restored = await this.restore_voided_plan(room, experts, anchor);
      if (restored) return restored;
      const spoken = new Set(room.rounds?.at(-1)?.speakers || []);
      // Experts without local software cannot be woken by the runner, so only automatic ones are candidates.
      const waiting = automatic.filter(name => !spoken.has(name));
      if (!waiting.length) return skip('round', '本轮未发言的专家都是手动接入，无法自动安排');
      // An expert the user just skipped is not picked again unless nobody else is left.
      const skipped = room.current_turn?.status === 'cancelled' ? room.current_turn.expert : null;
      // Asking whether to call on the host alone is pointless: handing back already wakes it.
      if (waiting.length === 1 && waiting[0] === room.host) return skip('round', '本轮只剩主持人未发言');
      const candidates = waiting.filter(name => name !== skipped);
      return this.next_speaker_plan(room, { ...context, spoken: [...spoken] }, candidates.length ? candidates : waiting, anchor);
    }
    if (room.named_followup) return skip('round', '点名追问已开启，由主持人安排下一轮');
    const decision = await decide_round(this.config.api_home, this.config.scheduler,
      { ...context, experts: automatic, last_speaker: room.current_turn?.expert }, this.fetch);
    const plan = { ...decision, kind: 'round', after_message_id: anchor };
    if (decision.action !== 'continue') return plan;
    // Only the first speaker is arranged; each answer ends with an empty queue, so the next one is judged then.
    return { ...plan, phase: room.phase === 'initial' ? 'discussing' : undefined,
      turns: [{ expert: decision.first, question: peer_round_question(room.completed_rounds + 1) }] };
  }
  /** Ask the decision model for the next speaker among candidates; an expert who never spoke gets the opening prompt. */
  async next_speaker_plan(room, context, candidates, anchor) {
    const next = await decide_next_speaker(this.config.api_home, this.config.scheduler, { ...context, candidates }, this.fetch);
    const plan = { ...next, kind: 'round', after_message_id: anchor };
    if (next.action !== 'next') return plan;
    const has_spoken = (room.rounds || []).some(round => round.speakers.includes(next.expert));
    const question = has_spoken ? peer_round_question(room.completed_rounds + 1) : opening_question(room.phase);
    return { ...plan, turns: [{ expert: next.expert, question }] };
  }
  /**
   * A roster change voids queued turns, leaving them skipped after the last real arrangement. Put back the ones whose
   * experts are still present, then ask each expert who has not spoken this round (such as a new member) to open.
   * This needs no model: it only reinstates what the host had already planned.
   */
  async restore_voided_plan(room, experts, anchor) {
    const turns = (await api(this.config, '/turns')).turns || [];
    const last_real = Math.max(0, ...turns.filter(turn => turn.status !== 'skipped').map(turn => turn.id));
    const voided = turns.filter(turn => turn.status === 'skipped' && turn.id > last_real && experts.includes(turn.expert));
    if (!turns.some(turn => turn.status === 'skipped' && turn.id > last_real)) return null;
    const spoken = new Set(room.rounds?.at(-1)?.speakers || []);
    const planned = new Set(voided.map(turn => turn.expert));
    const joining = experts.filter(name => !spoken.has(name) && !planned.has(name));
    const opening = opening_question(room.phase);
    const plan_turns = [...voided.map(({ expert, question }) => ({ expert, question })), ...joining.map(expert => ({ expert, question: opening }))].slice(0, MAX_PLAN_TURNS);
    if (!plan_turns.length) return null;
    const label = `成员有变化：${voided.length ? `补回原计划（${voided.map(turn => turn.expert).join('、')}）` : '原计划成员已离开'}${joining.length ? `，请 ${joining.join('、')} 开场` : ''}`;
    return { action: 'restore', kind: 'round', confidence: null, label, after_message_id: anchor, turns: plan_turns };
  }
  /** Perform the host's writes for a decided plan under its own execution credential. */
  async apply_schedule(plan, token, seen) {
    const room = await api(this.config, '');
    if (room.latest_id !== seen.latest_id || (room.held_since || 0) !== seen.held_since) throw new Error('判断期间房间有新留言或用户操作，放弃应用');
    const actor = room.host;
    if (plan.phase) await api(this.config, '/topic', { actor, phase: plan.phase }, token);
    if (plan.continue_plan) await api(this.config, '/turns/continue', { actor }, token);
    else {
      // Like any host, the program asks for the latest roster right before it arranges turns.
      const { revision } = await api(this.config, '/turns/roster');
      await api(this.config, '/turns', { actor, turns: plan.turns, roster: revision, submission_id: randomUUID() }, token);
    }
  }
  /** Show the decision in the transcript; a failed record never affects the discussion. */
  async record_decision(plan, applied) {
    try {
      await api(this.config, '/scheduler-decisions', { kind: plan.kind, label: plan.label, confidence: plan.confidence ?? null,
        applied, provider: this.config.scheduler.provider, after_message_id: plan.after_message_id || 0, detail: plan.detail, input: plan.input });
    } catch (error) { this.log(`智能调度决策记录未保存：${error.message}`); }
  }
  /** Enter once per delivery; a failure is recorded so reconcile revokes the execution. */
  async enter(row, session_id) {
    try {
      this.trace(row.id, 'enter_start');
      await api(this.config, `/events/${row.id}`, { action: 'enter', session_id }, row.token);
      this.trace(row.id, 'enter_done');
    }
    catch (error) { try { this.store.record(row.id, { error: `接入程序进入执行失败：${error.message}` }); } catch { /* Store may already be closed at shutdown. */ } }
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
      // The child records its own failure just before exiting; prefer that cause over the generic one.
      const cause = row.error || this.store.recorded_error(row.id);
      if (['dispatched', 'started'].includes(latest.status) && cause) return this.fail(row, cause);
      if (['dispatched', 'started'].includes(latest.status)) return this.fail(row, `${event.participant} 会话已结束，但未保存本次结果${this.exited.get(row.id) ? `：${this.exited.get(row.id)}` : ''}；请核对原会话确认是否已有内容`);
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
    this.log(`执行 #${row.id} 失败：${reason}`);
    try { await api(this.config, `/events/${row.id}`, { action: 'fail', reason }); }
    catch (error) {
      if (!/HTTP 409/.test(error.message)) throw error;
      const latest = await api(this.config, `/events/${row.id}`, { action: 'view' });
      if (['completed', 'cancelled', 'failed'].includes(latest.status)) return this.reconcile(row, latest);
      throw error;
    }
    this.store.record(row.id, { status: 'failed', error: reason });
    this.stop_children();
  }
  /** Process one bounded iteration without waking models for empty checks. */
  async tick() {
    this.store.context(this.config);
    let room;
    try { room = await api(this.config, ''); }
    catch (error) {
      // Only a permanently deleted room drops its private agy projects; concluded or archived rooms keep them for later continuation.
      if (/^HTTP 404: 房间不存在/.test(error.message)) remove_agy_projects(this.config.directory);
      throw error;
    }
    if (room.limits?.reached && room.runtime.status === 'running') {
      const generation = room.runtime.generation;
      room = await api(this.config, '/limits', { actor: '用户' });
      if (room.runtime.generation !== generation) this.stop_children();
    }
    this.room_title = room.title;
    this.members = room.members || [];
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
      if (event.generation !== run.generation || event.run_id !== run.run_id) {
        this.log(`撤销过期事件 #${row.id}（事件代次 ${event.generation}，当前 ${run.generation}）`);
        this.store.record(row.id, { status: 'cancelled' });
      }
    }
    for (const { row, event } of pending) if (!this.seen.has(row.id)) { this.seen.add(row.id); this.trace(row.id, 'event_seen', { event_created_at: event.created_at }); }
    const next = eligible.at(-1);
    // A manual expert has no local configuration: its pending event waits for the member's own answer.
    if (next && !this.config.participants[next.event.participant]) return;
    if (next && this.running.get(next.event.participant) && !this.blocked.has(next.row.id)) {
      this.blocked.add(next.row.id);
      this.trace(next.row.id, 'blocked_by_running_process', { participant: next.event.participant });
    }
    // A host that just saved the next turn may still be exiting; the same session cannot accept a second writer yet.
    if (next && !this.running.get(next.event.participant)) {
      const fresh = await api(this.config, `/events/${next.row.id}`, { action: 'view' });
      if (fresh.status === 'pending') {
        const scheduled = fresh.role === 'host' ? await this.smart_schedule(next.row, fresh) : {};
        if (!scheduled.done) await this.dispatch(next.row, fresh, scheduled);
      }
      else this.store.record(next.row.id, { status: fresh.status });
    }
  }
  /** Count live processes per participant so a resumed session never overlaps its previous writer. */
  track(participant, child) {
    this.children.add(child);
    this.running.set(participant, (this.running.get(participant) || 0) + 1);
    child.once('close', () => {
      this.children.delete(child);
      this.running.set(participant, this.running.get(participant) - 1);
    });
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
      const minutes = Number(values.minutes ?? room.limits?.max_minutes ?? 0);
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) throw new Error('总时长或 --minutes 须在 [0,1440]，0 表示不限时长');
      if (![room.host, ...Object.keys(room.experts)].every(name => config.participants[name])) throw new Error('尚未配置全部参与者的本机软件');
      await api(config, '/runtime', { action: 'start', mode: 'automatic', revision: run.revision, deadline: minutes ? Math.floor(Date.now() / 1000 + minutes * 60) : 0 });
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

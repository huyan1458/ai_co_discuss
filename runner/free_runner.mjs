/** Free-room delivery: one live execution per member, carrying all of that member's open requests. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomic_json, deliver_task, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';
import { api } from './discussion_runner.mjs';

const RENEW_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const LIVE = ['reserving', 'delivering', 'running'];
const MAX_HASHED_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

/** Identify a working directory consistently, so executions in the same cwd can be compared. */
export function cwd_key(directory) {
  if (!directory) return '';
  const path = resolve(directory).replaceAll('\\', '/');
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * Record each changed or untracked file's Git status and content hash in a Git working tree.
 * Returns null outside Git: free rooms then provide no automatic overlap detection.
 */
export function workspace_snapshot(directory) {
  if (!directory) return null;
  const result = spawnSync('git', ['-C', directory, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return null;
  const entries = new Map();
  const fields = result.stdout.split('\0').filter(Boolean);
  for (let index = 0; index < fields.length; index++) {
    const status = fields[index].slice(0, 2), path = fields[index].slice(3);
    if (status[0] === 'R' || status[0] === 'C') index++; // The original path of a rename follows.
    let content = 'missing';
    try {
      const file = join(directory, path);
      const size = statSync(file).size;
      content = size > MAX_HASHED_BYTES ? `size:${size}` : createHash('sha256').update(readFileSync(file)).digest('hex');
    } catch { /* Deleted files keep the marker. */ }
    entries.set(path, `${status}:${content}`);
  }
  return entries;
}

/** Paths whose status or content differ between two snapshots of one working tree. */
export function changed_between(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter(path => before.get(path) !== after.get(path)).sort();
}

/** Write a non-secret task and a member-only credential file for one execution. */
export function free_task_files(config, member, execution, binding) {
  const id = `free-${execution.id}`;
  const draft_directory = config.draft_directory || `${config.directory}-drafts`;
  mkdirSync(draft_directory, { recursive: true });
  const access_path = join(config.directory, `${id}.access.json`);
  const task_path = join(config.directory, `${id}.task.json`);
  const profile = config.participants[member.name];
  atomic_json(access_path, { site: config.site, room: config.room, token: config.members[member.name].token,
    session_id: binding.session_id || '' });
  const cli = process.platform === 'win32' && profile.adapter !== 'claude' ? 'codiscuss.cmd' : 'codiscuss';
  const project_rule = !profile.cwd ? '未指定项目目录。'
    : profile.project_access === 'write' ? '用户允许按请求修改 cwd 中的项目文件。' : 'cwd 中的项目文件只读，不修改。';
  const messages = execution.requests.map(item => `#${item.message_id}`).join('、');
  // The host routes unnamed messages and receives hand-backs; it may name members in its answer.
  const host_rule = member.role === 'host'
    ? `你是本房间的主持人：purpose 为 route 的请求是用户未点名的消息，handoff 表示你派出的成员都已结束。先用 ${cli} room view ${config.room} 查看成员与状态，再决定由谁处理；需要派活时在回答中加 --to 成员名（可重复，不能点名自己），被点名的成员都结束后你会再被唤醒一次。不需要他人时不加 --to，本次即结束。只派分给各成员的文件或模块，避免多人改同一文件。`
    : '';
  atomic_json(task_path, { site: config.site, room: config.room, mode: 'free', member: member.name,
    execution_id: execution.id, request_messages: execution.requests.map(item => item.message_id),
    request_purposes: execution.requests.map(item => item.purpose || 'ask'), role: member.role || 'member',
    read_after: execution.read_until, cwd: profile.cwd || null, project_access: profile.project_access, draft_directory,
    skills: [join(config.project, '.agents/skills/discuss-participant/SKILL.md')], cli, subcommands: TASK_SUBCOMMANDS,
    access_file: access_path,
    instructions: `自由协作房间：用户点名了你（${messages}）。先用 ${cli} message list ${config.room} --after ${execution.read_until} --access-file 凭据路径 读取新消息，按时间顺序处理，后面的消息可能修正前面的，以最新指令为准。${host_rule}完成后用 ${cli} message post ${config.room} --as ${member.name} --kind chat --execution ${execution.id} --body-file 草稿 --submission-id 新UUID --access-file 凭据路径 提交一次回答。提交被拒绝说明本次执行已被打断或过期：保留草稿并结束，不要去掉 --execution 改作普通发言。草稿只写入 draft_directory；${project_rule}不读取或打印凭据内容，不建定时任务。` });
  const prompt = `用户在自由协作房间点名了你（${member.name}），对应消息 ${messages}。请先读取任务文件：${task_path}，按其中说明读取新消息、完成请求，并用 ${cli} message post 带 --execution ${execution.id} 提交一次回答后结束。命令只用任务内 subcommands 列出的 ${cli} 子命令；${project_rule}不读取凭据内容。`;
  return { id, participant: member.name, directory: config.directory, draft_directory,
    skills_directory: join(config.project, '.agents', 'skills'), access_path, prompt };
}

/** Delivers free-room requests through the same software adapters as discussions. */
export class FreeRoomRunner {
  constructor(config, store, deliver = deliver_task) {
    this.config = config;
    this.store = store;
    this.deliver = deliver;
    this.children = new Set();
    this.members = new Map();
    this.exited = new Set();
    this.snapshots = new Map();
    this.context_errors = new Map();
    this.adopt(config);
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS free_deliveries(member TEXT PRIMARY KEY, client_id TEXT NOT NULL,
      execution_id INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      started INTEGER NOT NULL DEFAULT 0, last_renew INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')`);
  }
  /** Read this member's current local delivery record. */
  row(name) { return this.store.db.prepare('SELECT * FROM free_deliveries WHERE member=?').get(name); }
  /** Persist one member's delivery state; the client id makes a lost reserve response recoverable. */
  save(name, fields) {
    const current = this.row(name) || { member: name, client_id: '', execution_id: 0, status: 'idle', attempts: 0, started: 0, last_renew: 0, error: '' };
    const next = { ...current, ...fields };
    this.store.db.prepare(`INSERT INTO free_deliveries VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(member) DO UPDATE SET
      client_id=excluded.client_id,execution_id=excluded.execution_id,status=excluded.status,attempts=excluded.attempts,
      started=excluded.started,last_renew=excluded.last_renew,error=excluded.error`)
      .run(name, next.client_id, next.execution_id, next.status, next.attempts, next.started, next.last_renew, next.error);
    return next;
  }
  /**
   * Take a changed configuration while running: new members are added, but a member whose
   * project, cwd or bound session changed is blocked instead of silently reusing its conversation.
   */
  adopt(config) {
    for (const [name, item] of Object.entries(config.participants)) {
      const context = JSON.stringify([item.adapter, item.project_id || '', item.project_name || '', cwd_key(item.cwd), cwd_key(item.workdir), item.session_id || '']);
      const key = `member-context:${name}`;
      const previous = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
      if (previous && previous !== context) this.context_errors.set(name, `${name} 已绑定会话的项目、cwd 或接入方式发生变化；请移除后重新邀请`);
      else this.store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, context);
    }
    this.config = { ...this.config, ...config, participants: config.participants, members: config.members };
  }
  /** One bounded iteration: reconcile live executions, then deliver idle members with open requests. */
  async tick() {
    const inbox = await api(this.config, '/inbox');
    const room = await api(this.config, '');
    this.room_title = room.title;
    const active = new Map(inbox.executions.map(item => [item.id, item]));
    const present = new Set(inbox.members.map(member => member.name));
    // A member sent away or removed no longer appears; its live work was already voided on the website.
    for (const row of this.store.db.prepare('SELECT * FROM free_deliveries').all()) {
      if (LIVE.includes(row.status) && !present.has(row.member)) { this.stop_member(row.member); this.save(row.member, { status: 'idle' }); }
    }
    await this.report_finished(active);
    for (const member of inbox.members) {
      const row = this.row(member.name);
      if (row && LIVE.includes(row.status)) await this.reconcile(member, row, active, inbox.execution_minutes);
      else if (!inbox.archived && member.pending.length && !this.members.get(member.name)?.size) await this.start(member, row);
    }
  }
  /** Reserve with a persisted client id before invoking any software. */
  async start(member, row) {
    const record = this.save(member.name, { client_id: randomUUID(), execution_id: 0, status: 'reserving', error: '',
      attempts: row?.attempts || 0 });
    await this.reserve(member, record);
  }
  /** A retried client id returns the original execution; a finished or refused one just goes idle. */
  async reserve(member, record) {
    let execution;
    const cwd = cwd_key(this.config.participants[member.name]?.cwd || this.config.cwd);
    try { execution = await api(this.config, '/executions', { member_id: member.id, client_id: record.client_id, cwd }); }
    catch (error) {
      if (/HTTP (404|409)/.test(error.message)) return this.save(member.name, { status: 'idle', error: '' });
      throw error;
    }
    if (!['dispatched', 'started'].includes(execution.status)) return this.save(member.name, { status: 'idle' });
    this.save(member.name, { execution_id: execution.id, status: 'delivering', started: Date.now(), last_renew: Date.now() });
    await this.invoke(member, execution);
  }
  /** Hand the execution to the member's software; only proven non-delivery is released for retry. */
  async invoke(member, execution) {
    const adapter = this.config.participants[member.name];
    if (!adapter) return this.fail(member.name, execution.id, `未配置 ${member.name} 的本机接入`);
    if (this.context_errors.has(member.name)) return this.fail(member.name, execution.id, this.context_errors.get(member.name));
    const directory = adapter.cwd || this.config.cwd;
    const before = workspace_snapshot(directory);
    if (before) this.snapshots.set(execution.id, { member: member.name, directory, before });
    const binding = this.store.binding(member.name);
    if (!binding.session_id && adapter.session_id) binding.session_id = adapter.session_id;
    let invoked = false;
    try {
      const task = free_task_files(this.config, member, execution, binding);
      invoked = true;
      const result = await this.deliver(adapter, binding, { ...task, room_title: this.room_title,
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => this.track(member.name, child),
        on_output: (path, chunk) => appendFileSync(path, chunk, { mode: 0o600 }),
        // A stopped process may report after the next execution started; only its own execution takes the result.
        on_failure: error => { try { if (this.row(member.name)?.execution_id === execution.id) this.save(member.name, { error }); } catch { /* Store may already be closed at shutdown. */ } },
        on_exit: () => this.exited.add(execution.id),
      });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      this.save(member.name, { status: 'running', attempts: 0 });
    } catch (error) {
      const attempts = (this.row(member.name)?.attempts || 0) + 1;
      if ((invoked && error.delivery_status !== 'not_sent') || attempts >= MAX_DELIVERY_ATTEMPTS) {
        return this.fail(member.name, execution.id, `投递失败：${error.message}`);
      }
      await api(this.config, `/executions/${execution.id}`, { action: 'release', reason: `确认未送达：${error.message}` });
      this.save(member.name, { status: 'idle', attempts, error: error.message });
    }
  }
  /** Follow the website's verdict; stop only this member's processes when its execution ends. */
  async reconcile(member, row, active, minutes) {
    if (row.status === 'reserving') return this.reserve(member, row);
    const execution = active.get(row.execution_id);
    if (!execution) {
      this.stop_member(member.name);
      return this.save(member.name, { status: 'idle', error: '' });
    }
    // A restart between persisting and invoking cannot prove non-delivery, so it never resends.
    if (row.status === 'delivering') return this.fail(member.name, execution.id, '上次投递结果不明，未自动重发；请核对原会话后重新发送');
    if (row.error) return this.fail(member.name, execution.id, row.error);
    if (this.exited.has(execution.id)) {
      const latest = await api(this.config, `/executions/${execution.id}`);
      if (['dispatched', 'started'].includes(latest.status)) return this.fail(member.name, execution.id, `${member.name} 会话已结束，但未提交本次回答`);
      return this.save(member.name, { status: 'idle' });
    }
    if (Date.now() >= execution.created_at * 1000 + minutes * 60_000) return this.fail(member.name, execution.id, `超过单次执行时限 ${minutes} 分钟`);
    if (Date.now() - row.last_renew >= RENEW_MS) {
      await api(this.config, `/executions/${execution.id}`, { action: 'renew' });
      this.save(member.name, { last_renew: Date.now() });
    }
  }
  /** Report observed file changes once an execution has ended and its member's processes have exited. */
  async report_finished(active) {
    for (const [execution_id, snapshot] of this.snapshots) {
      if (active.has(execution_id) || this.members.get(snapshot.member)?.size) continue;
      this.snapshots.delete(execution_id);
      const after = workspace_snapshot(snapshot.directory);
      const changes = after ? changed_between(snapshot.before, after) : [];
      if (!changes.length) continue;
      try { await api(this.config, `/executions/${execution_id}`, { action: 'report', changes: changes.slice(0, 200) }); }
      catch (error) { if (!/HTTP (404|409)/.test(error.message)) throw error; }
    }
  }
  /** Record the cause on the website, then stop this member's own processes. */
  async fail(name, execution_id, reason) {
    try { await api(this.config, `/executions/${execution_id}`, { action: 'fail', reason }); }
    catch (error) { if (!/HTTP 409/.test(error.message)) throw error; }
    this.save(name, { status: 'idle', error: reason });
    this.stop_member(name);
  }
  /** Count live processes per member so one session never has two writers. */
  track(name, child) {
    this.children.add(child);
    if (!this.members.has(name)) this.members.set(name, new Set());
    this.members.get(name).add(child);
    child.once('close', () => { this.children.delete(child); this.members.get(name).delete(child); });
  }
  /** Stop one member's processes without touching other members or desktop apps. */
  stop_member(name) { for (const child of this.members.get(name) || []) child.kill(); }
  /** Stop every process this runner created. */
  stop_children() { for (const child of this.children) child.kill(); }
}

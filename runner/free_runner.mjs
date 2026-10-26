/** Free-room delivery: one live execution per member, carrying all of that member's open requests. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { atomic_json, deliver_task, sidecar_receipt, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';
import { api } from './discussion_runner.mjs';
import { ROUTE_CONFIDENCE, ROUTE_CONTEXT_MESSAGES, ROUTE_PROMPT_VERSION, ROUTE_WIDE_CONFIDENCE, route_free_message } from './scheduler.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const RENEW_MS = 30_000;
const MAX_DELIVERY_ATTEMPTS = 3;
const LIVE = ['reserving', 'delivering', 'sidecar_pending', 'running'];
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
  const bound_access = ['claude', 'codex_cli', 'antigravity_cli'].includes(profile.adapter);
  const access_arg = bound_access ? '' : ' --access-file 凭据路径';
  const access_rule = bound_access ? '本次凭据文件已通过进程环境 DISCUSS_ACCESS_FILE 绑定，codiscuss 自动读取，命令无需 --access-file。' : '';
  const project_rule = !profile.cwd ? '未指定项目目录。'
    : profile.project_access === 'write' ? '用户允许按请求修改 cwd 中的项目文件。' : 'cwd 中的项目文件只读，不修改。';
  const messages = execution.requests.map(item => `#${item.message_id}`).join('、');
  // The host routes unnamed messages and receives hand-backs; it may name members in its answer.
  const discussion = config.mode !== 'free';
  const host_rule = member.role === 'host' && !discussion
    ? `你是本房间的主持人：purpose 为 route 的请求是用户未点名的消息，handoff 表示你派出的成员都已结束，all 表示用户请全体成员各自回应一次（其他成员已同时收到，你只回答自己的部分，不加 --to）。先用 ${cli} room view ${config.room} 查看成员与状态，再决定由谁处理；需要派活时在回答中加 --to 成员名（可重复，不能点名自己），只点名一位成员时，其回答直接面向用户，你不会再被唤醒；同时点名多位时，全部结束后你会再被唤醒一次汇总。不需要他人时不加 --to，本次即结束。只派分给各成员的文件或模块，避免多人改同一文件。`
    : '';
  atomic_json(task_path, { site: config.site, room: config.room, mode: 'free', member: member.name,
    execution_id: execution.id, request_messages: execution.requests.map(item => item.message_id),
    request_purposes: execution.requests.map(item => item.purpose || 'ask'), role: member.role || 'member',
    read_after: execution.read_until, cwd: profile.cwd || null, project_access: profile.project_access, draft_directory,
    skills: [join(config.project, '.agents/skills/discuss-participant/SKILL.md')], cli, subcommands: TASK_SUBCOMMANDS,
    ...(bound_access ? { access_env: 'DISCUSS_ACCESS_FILE' } : { access_file: access_path }),
    instructions: `${discussion ? '讨论房间：用户直接向你提问（' + messages + '）。这不是你的发言安排，不要领取发言权、不要安排他人，也不改变讨论进度，只回答这个提问。' : '自由协作房间：用户点名了你（' + messages + '）。'}${access_rule}先用 ${cli} message list ${config.room} --after ${execution.read_until}${access_arg} 读取新消息，按时间顺序处理，后面的消息可能修正前面的，以最新指令为准。${host_rule}完成后用 ${cli} message post ${config.room} --as ${member.name} --kind chat --execution ${execution.id} --body-file 草稿 --submission-id 新UUID${access_arg} 提交一次回答。提交被拒绝说明本次执行已被打断或过期：保留草稿并结束，不要去掉 --execution 改作普通发言。草稿只写入 draft_directory；${project_rule}不读取或打印凭据内容，不建定时任务。` });
  const prompt = `用户在${discussion ? '讨论' : '自由协作'}房间点名了你（${member.name}），对应消息 ${messages}。请先读取任务文件：${task_path}，按其中说明读取新消息、完成请求，并用 ${cli} message post 带 --execution ${execution.id} 提交一次回答后结束。命令只用任务内 subcommands 列出的 ${cli} 子命令；${project_rule}不读取凭据内容。`;
  return { id, participant: member.name, directory: config.directory, draft_directory,
    skills_directory: join(config.project, '.agents', 'skills'), access_path, prompt };
}

const ADAPTER_LABELS = { codex: 'Codex App', codex_cli: 'Codex CLI', claude: 'Claude Code', antigravity: 'Antigravity App',
  antigravity_cli: 'Antigravity CLI', api: '模型 API，只能读写房间消息' };

/** What a scheduler can know about a member without a role field: its software, project access and the messages it is on. */
function member_description(name, profile, work) {
  const project = profile.project_name || (profile.cwd ? basename(profile.cwd) : '');
  const access = profile.adapter === 'api' ? '' : !profile.cwd ? '，未指定项目目录'
    : profile.project_access === 'write' ? `，可修改项目 ${project} 的文件` : `，项目 ${project} 只读`;
  return `${name}（${ADAPTER_LABELS[profile.adapter] || profile.adapter}${access}${work}）`;
}

/** The other messages a member is answering or has queued, so a correction can follow the message it corrects. */
function member_work(requests, name, message_id) {
  const open = requests.filter(item => item.member === name && item.message_id !== message_id);
  const ids = status => [...new Set(open.filter(item => item.status === status).map(item => `#${item.message_id}`))].join('、');
  return [ids('delivering') && `；正在处理 ${ids('delivering')}`, ids('pending') && `；待处理 ${ids('pending')}`].filter(Boolean).join('');
}

/** Why a message stayed with the host: the scheduler chose the host, or leaned elsewhere without enough certainty. */
function route_host_label(decision, host, members) {
  if (decision.choice === '__host__' || decision.confidence === null) return `交给主持人 ${host}`;
  const lean = decision.choice === '__all__' ? '全体各自回应' : decision.choice === '__none__' ? '无需回应'
    : members.some(member => member.name === decision.choice) ? `请 ${decision.choice} 回答` : '';
  return lean ? `倾向${lean}，把握不足，交给主持人 ${host}` : `交给主持人 ${host}`;
}

/** Delivers free-room requests through the same software adapters as discussions. */
export class FreeRoomRunner {
  constructor(config, store, deliver = deliver_task, log = () => {}, fetch_impl = fetch) {
    this.config = config;
    this.store = store;
    this.deliver = deliver;
    this.log = log;
    this.fetch = fetch_impl;
    this.routed = new Set();
    this.decisions = new Set();
    // Routed requests whose decision is still pending: their host waits, so one pick replaces the host's start.
    this.routing = new Set();
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
    // Smart scheduling runs beside delivery: the host gets the message now, a recommendation may follow.
    if (this.config.scheduler && !inbox.archived) this.recommend_unnamed(inbox, room);
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
      else if (!inbox.archived && member.pending.length && !this.members.get(member.name)?.size
        && !member.pending.some(request => this.routing.has(request.id))) await this.start(member, row);
    }
  }
  /**
   * Smart scheduling: for each new unnamed message routed to the host, ask the provider whether another woken
   * member suits it better and apply a confident pick. The host waits for the answer (or its failure) before starting.
   */
  recommend_unnamed(inbox, room) {
    // Manual and online members are listed apart; they are never delivered to but may host or be recommended.
    const everyone = [...inbox.members, ...(inbox.observers || [])];
    const host = everyone.find(member => member.role === 'host');
    const waiting = host?.pending.filter(request => request.purpose === 'route' && !this.routed.has(request.id)) || [];
    for (const request of waiting) {
      this.routed.add(request.id);
      if (everyone.length < 2) continue;
      this.routing.add(request.id);
      const decision = this.mark_routing(request.message_id, true)
        .then(() => this.recommend(request, room, everyone))
        .catch(error => this.log(`智能调度 #${request.message_id} 未给出推荐：${error.message}`))
        .finally(() => { this.routing.delete(request.id); return this.mark_routing(request.message_id, false); });
      this.decisions.add(decision);
      decision.finally(() => this.decisions.delete(decision));
    }
  }
  /** Tell the website a message is being analysed so it can show the card; a failed mark never blocks routing. */
  async mark_routing(message_id, active) {
    try { await api(this.config, '/scheduler-routing', { message_id, active }); }
    catch (error) { this.log(`智能调度 #${message_id} 分析状态未上报：${error.message}`); }
  }
  /** Describe each member as the scheduler sees it: software, project access and the other messages it is on. */
  route_members(everyone, room, message_id) {
    const requests = (room.free?.requests || []).filter(item => ['pending', 'delivering'].includes(item.status));
    return everyone.map(member => {
      const work = member_work(requests, member.name, message_id);
      const profile = this.config.participants[member.name];
      return { id: member.id, name: member.name, role: member.role, description: profile ? member_description(member.name, profile, work)
        : `${member.name}（${member.access === 'online' ? '网页 AI' : '手动接入'}，由用户代为触发${work}）` };
    });
  }
  /** Decide one message and apply a confident pick: one member, everyone, or no one; otherwise the host keeps it. */
  async recommend(request, room, everyone) {
    const page = await api(this.config, `/messages?after=${Math.max(0, request.message_id - ROUTE_CONTEXT_MESSAGES - 1)}`);
    const message = page.messages.find(item => item.id === request.message_id);
    if (!message) return;
    const described = this.route_members(everyone, room, message.id);
    const host = described.find(member => member.role === 'host');
    const members = described.filter(member => member !== host);
    const decision = await route_free_message(this.config.api_home, this.config.scheduler,
      { title: room.title, goal: room.goal, context: page.messages, message, host, members }, this.fetch);
    this.log(`智能调度 #${message.id}：${decision.action}${decision.member ? ` ${decision.member}` : ''}（选择 ${decision.choice ?? '-'}，置信度 ${decision.confidence ?? '-'}）`);
    if (decision.action === 'host') return this.record_decision(message.id, decision, route_host_label(decision, host.name, members), false);
    if (decision.action !== 'member') {
      // Everyone or no one replaces the host's request in one step; a host that already started keeps the message.
      const applied = await api(this.config, `/recommendations/${message.id}`, { action: decision.action })
        .then(() => true, error => { this.log(`智能调度 #${message.id} 未能改派：${error.message}`); return false; });
      const names = described.map(member => member.name).join('、');
      const label = decision.action === 'all' ? `请全体各自回应（${names}）` : '无需回应，未唤醒任何成员';
      return this.record_decision(message.id, decision, applied ? label : `${label}（未生效，仍由主持人处理）`, applied);
    }
    await api(this.config, '/recommendations', { message_id: message.id, member_id: members.find(member => member.name === decision.member).id,
      provider: this.config.scheduler.provider, confidence: decision.confidence });
    // A confident pick is applied at once, interrupting the host; if that fails the recommendation stays for the user to adopt.
    const adopted = await api(this.config, `/recommendations/${message.id}`, { action: 'adopt', mode: 'interrupt' })
      .then(() => true, error => { this.log(`智能调度 #${message.id} 自动改派失败，保留推荐：${error.message}`); return false; });
    await this.record_decision(message.id, decision, adopted ? `改由 ${decision.member} 回答` : `建议让 ${decision.member} 回答（未能自动改派）`, adopted);
  }
  /** Show each judgment under its message so the user can rate it; a failed record never affects delivery. */
  async record_decision(message_id, decision, label, applied) {
    try {
      await api(this.config, '/scheduler-decisions', { kind: 'interjection', label, confidence: decision.confidence ?? null,
        applied, provider: this.config.scheduler.provider, after_message_id: message_id, detail: decision.detail,
        context: { model: this.config.scheduler.model, threshold: ROUTE_CONFIDENCE, wide_threshold: ROUTE_WIDE_CONFIDENCE,
          prompt: ROUTE_PROMPT_VERSION, package: PACKAGE_VERSION } });
    } catch (error) { this.log(`智能调度 #${message_id} 决策记录未保存：${error.message}`); }
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
    const profile = this.config.participants[member.name];
    const cwd = profile?.adapter === 'api' ? '' : cwd_key(profile?.cwd || this.config.cwd);
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
    const directory = adapter.adapter === 'api' ? undefined : adapter.cwd || this.config.cwd;
    const before = workspace_snapshot(directory);
    if (before) this.snapshots.set(execution.id, { member: member.name, directory, before });
    const binding = this.store.binding(member.name);
    if (!binding.session_id && adapter.session_id) binding.session_id = adapter.session_id;
    let invoked = false;
    try {
      const task = free_task_files(this.config, member, execution, binding);
      invoked = true;
      const result = await this.deliver(adapter, binding, { ...task, room_title: this.room_title,
        api_context: { site: this.config.site, room: this.config.room, token: this.config.members[member.name].token,
          home: this.config.api_home, mode: 'free', role: member.role || 'member', execution_id: execution.id,
          requests: execution.requests, read_after: execution.read_until },
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => this.track(member.name, child),
        on_output: (path, chunk) => appendFileSync(path, chunk, { mode: 0o600 }),
        // A stopped process may report after the next execution started; only its own execution takes the result.
        on_failure: error => { try { if (this.row(member.name)?.execution_id === execution.id) this.save(member.name, { error }); } catch { /* Store may already be closed at shutdown. */ } },
        on_exit: () => this.exited.add(execution.id),
      });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      this.save(member.name, { status: result.status === 'sidecar_pending' ? 'sidecar_pending' : 'running', attempts: 0 });
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
    if (row.status === 'sidecar_pending') {
      const receipt = sidecar_receipt(this.config.participants[member.name], `free-${row.execution_id}`);
      if (receipt?.status === 'accepted' && receipt.session_id) {
        this.store.bind(member.name, receipt.session_id);
        this.save(member.name, { status: 'running' });
      } else if (receipt && active.has(row.execution_id)) return this.fail(member.name, row.execution_id, receipt.error || 'Sidecar 投递结果不明，请核对原会话');
    }
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
      if (['dispatched', 'started'].includes(latest.status)) return this.fail(member.name, execution.id, `${member.name} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容`);
      return this.save(member.name, { status: 'idle' });
    }
    if (Date.now() >= execution.created_at * 1000 + minutes * 60_000) return this.fail(member.name, execution.id, `超过单次执行时限 ${minutes} 分钟；请核对原会话确认是否已有内容`);
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
      if (!after) continue;
      const changes = changed_between(snapshot.before, after);
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

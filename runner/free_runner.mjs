/** Free-room delivery: one live execution per member, carrying all of that member's open requests. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { atomic_json, claude_inbox_ready, deliver_task, SegmentLog, sidecar_receipt, TASK_SUBCOMMANDS } from './discussion_adapters.mjs';
import { api, CODEX_ADAPTERS, read_rule } from './discussion_runner.mjs';
import { free_task_text, with_expert_prompt } from './expert_prompts.mjs';
import { BRANCHABLE_ADAPTERS, branch_session, session_exists } from './session_cut.mjs';
import { ROUTE_CONFIDENCE, ROUTE_CONTEXT_MESSAGES, ROUTE_PROMPT_VERSION, ROUTE_WIDE_CONFIDENCE, decide_group_order, route_free_message } from './scheduler.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const RENEW_MS = 30_000;
/** A changed phase is reported early, but no more often than this, since each report refreshes open pages. */
const ACTIVITY_REPORT_MS = 10_000;
/** Segments and progress notes are reported quietly, waking no page, so they may go every tick. */
const PROGRESS_REPORT_MS = 2_000;
const MAX_DELIVERY_ATTEMPTS = 3;
// A manual member's session that refuses a delivery is retried in the same execution, after a wait the owner can cut short.
const MAX_DELIVERY_RETRIES = 3;
const RETRY_DELAY_SECONDS = 60;
const MAX_RETRY_REASON = 500;
const LIVE = ['reserving', 'delivering', 'sidecar_pending', 'running', 'retry_wait'];
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
  const inbox = claude_inbox_ready(profile, binding);
  const bound_access = !inbox && ['claude', 'codex_cli', 'antigravity_cli'].includes(profile.adapter);
  const messages = execution.requests.map(item => `#${item.message_id}`).join('、');
  const { instructions, prompt } = free_task_text({ name: member.name, role: member.role, discussion: config.mode !== 'free', profile, cli,
    room: config.room, messages, read_after: execution.read_until, execution_id: execution.id, task_path, draft_directory,
    access_file: bound_access ? '' : access_path, read_rule: read_rule(profile.adapter), inbox });
  atomic_json(task_path, { site: config.site, room: config.room, mode: 'free', member: member.name,
    execution_id: execution.id, request_messages: execution.requests.map(item => item.message_id),
    request_purposes: execution.requests.map(item => item.purpose || 'ask'), role: member.role || 'member',
    read_after: execution.read_until, cwd: profile.cwd || null, project_access: profile.project_access, draft_directory,
    // Each skill's core plus its free-room page; the host also gets the host skill (its development page is read on demand).
    skills: [...['discuss-participant/SKILL.md', 'discuss-participant/references/free.md'],
      ...member.role === 'host' ? ['discuss-host/SKILL.md', 'discuss-host/references/free.md'] : []].map(file => join(config.project, '.agents/skills', file)),
    cli, subcommands: TASK_SUBCOMMANDS,
    ...(bound_access ? { access_env: 'DISCUSS_ACCESS_FILE' } : { access_file: access_path }), instructions });
  return { id, participant: member.name, directory: config.directory, draft_directory,
    skills_directory: join(config.project, '.agents', 'skills'), access_path, prompt: with_expert_prompt(prompt, profile), inbox };
}

const ADAPTER_LABELS = { codex: 'Codex App', codex_cli: 'Codex CLI', claude: 'Claude Code', antigravity: 'Antigravity App',
  antigravity_cli: 'Antigravity CLI', api: '模型 API，只能读写房间消息' };

/** What a scheduler can know about a member without a role field: its software, project access and the messages it is on. */
function member_description(name, profile, work) {
  const project = profile.project_name || (profile.cwd ? basename(profile.cwd) : '');
  const access = profile.adapter === 'api' ? '' : profile.project_access === 'own' ? '，权限沿用其会话设置' : !profile.cwd ? '，未指定项目目录'
    : profile.project_access === 'read' ? `，项目 ${project} 只读` : `，可修改项目 ${project} 的文件并运行命令`;
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
    // Group requests (@全体成员) being arranged; a failed arrangement leaves the set so the next tick retries.
    this.grouped = new Set();
    this.decisions = new Set();
    // Routed requests whose decision is still pending: their host waits, so one pick replaces the host's start.
    this.routing = new Set();
    this.children = new Set();
    this.members = new Map();
    // Execution id -> why its session ended on its own, such as a command refused in unattended mode ('' when unknown).
    this.exited = new Map();
    this.snapshots = new Map();
    // Execution id -> { phase, at, sent_phase, sent_at }: what the member's software last showed it doing.
    this.activity = new Map();
    this.segments = new SegmentLog();
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
      if (previous && !this.same_context(name, previous, context)) this.context_errors.set(name, `${name} 已绑定会话的项目、cwd 或接入方式发生变化；请移除后重新邀请`);
      else this.store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, context);
    }
    this.config = { ...this.config, ...config, participants: config.participants, members: config.members };
  }
  /**
   * A Codex member switched between App and CLI keeps its conversation: the two entries count as one, and the App's
   * session may be filled in from the conversation this member is already bound to.
   */
  same_context(name, previous, current) {
    const [before, after] = [JSON.parse(previous), JSON.parse(current)];
    for (const context of [before, after]) if (CODEX_ADAPTERS.includes(context[0])) context[0] = 'codex';
    const bound = this.store.binding(name).session_id;
    if (before[5] !== after[5] && [before[5], after[5]].includes('') && [before[5], after[5]].includes(bound)) after[5] = before[5];
    return JSON.stringify(before) === JSON.stringify(after);
  }
  /** One bounded iteration: reconcile live executions, then deliver idle members with open requests. */
  async tick() {
    const inbox = await api(this.config, '/inbox');
    const room = await api(this.config, '');
    // Smart scheduling runs beside delivery: the host waits for its answer (or failure) before starting, see `routing`.
    if (this.config.scheduler && !inbox.archived) this.recommend_unnamed(inbox, room);
    if (!inbox.archived) this.arrange_groups(inbox, room);
    this.room_title = room.title;
    const active = new Map(inbox.executions.map(item => [item.id, item]));
    const present = new Set(inbox.members.map(member => member.name));
    // A member sent away or removed no longer appears; its live work was already voided on the website.
    for (const row of this.store.db.prepare('SELECT * FROM free_deliveries').all()) {
      if (LIVE.includes(row.status) && !present.has(row.member)) { this.stop_member(row.member); this.save(row.member, { status: 'idle' }); }
    }
    await this.report_finished(active);
    // Start in the room's speaking order: execution ids follow it, and the website lays out working cards by them.
    const rank = (room.speaking_order?.items || []).map(item => item.name);
    const place = name => rank.includes(name) ? rank.indexOf(name) : rank.length;
    for (const member of [...inbox.members].sort((left, right) => place(left.name) - place(right.name))) {
      const row = this.row(member.name);
      if (row && LIVE.includes(row.status)) await this.reconcile(member, row, active, inbox.execution_minutes);
      else if (!inbox.archived && member.pending.some(request => request.purpose !== 'group') && !this.members.get(member.name)?.size
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
  /** For each message naming everyone, have them answer at once, or one after another when smart scheduling says so. */
  arrange_groups(inbox, room) {
    const everyone = [...inbox.members, ...(inbox.observers || [])];
    for (const request of everyone.flatMap(member => member.pending).filter(item => item.purpose === 'group' && !this.grouped.has(item.id))) {
      this.grouped.add(request.id);
      const arranged = (this.config.scheduler ? this.mark_routing(request.message_id, true).then(() => this.order_group(request, room, everyone))
        .finally(() => this.mark_routing(request.message_id, false)) : this.apply_group(request.message_id, { action: 'all' }))
        .catch(error => { this.grouped.delete(request.id); this.log(`全体成员 #${request.message_id} 未能安排：${error.message}`); });
      this.decisions.add(arranged);
      arranged.finally(() => this.decisions.delete(arranged));
    }
  }
  /** Ask the scheduler how everyone answers; a failed call still has them answer at once. */
  async order_group(request, room, everyone) {
    // A page holds at most 20 messages, so the window must end at the message itself or the message falls off the page.
    const page = await api(this.config, `/messages?after=${Math.max(0, request.message_id - ROUTE_CONTEXT_MESSAGES)}`);
    const message = page.messages.find(item => item.id === request.message_id);
    const members = (room.speaking_order?.items || []).map(item => item.name).filter(name => everyone.some(member => member.name === name));
    const decision = await decide_group_order(this.config.api_home, this.config.scheduler,
      { title: room.title, goal: room.goal, context: page.messages, message, members: members.length ? members : everyone.map(member => member.name), profiles: room.descriptions }, this.fetch)
      .catch(error => { this.log(`智能调度 #${request.message_id} 未判断全体回答方式：${error.message}`); return { action: 'all' }; });
    await this.apply_group(request.message_id, decision);
    if (decision.detail) {
      const label = decision.action === 'sequential' ? '请全体按发言顺序依次回答' : '请全体同时回答';
      await this.record_decision(request.message_id, decision, label, true);
    }
  }
  /** Replace the host's group request with everyone's requests; a message already arranged elsewhere is left as is. */
  async apply_group(message_id, decision) {
    this.log(`全体成员 #${message_id}：${decision.action === 'sequential' ? '依次回答' : '同时回答'}`);
    await api(this.config, `/recommendations/${message_id}`, { action: decision.action }).catch(error => {
      if (!/HTTP (404|409)/.test(error.message)) throw error;
    });
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
      const described = room.descriptions?.[member.name] ? `；用户描述：${room.descriptions[member.name]}` : '';
      return { id: member.id, name: member.name, role: member.role, description: profile ? member_description(member.name, profile, `${work}${described}`)
        : `${member.name}（${member.access === 'online' ? '网页 AI' : '手动接入'}，由用户代为触发${work}${described}）` };
    });
  }
  /** Decide one message and apply a confident pick: one member, everyone, or no one; otherwise the host keeps it. */
  async recommend(request, room, everyone) {
    const page = await api(this.config, `/messages?after=${Math.max(0, request.message_id - ROUTE_CONTEXT_MESSAGES)}`);
    const message = page.messages.find(item => item.id === request.message_id);
    if (!message) throw new Error('读取不到这条消息');
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
        applied, provider: this.config.scheduler.provider, after_message_id: message_id, detail: decision.detail, input: decision.input,
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
    // A member whose session a rewind restarted is bound to '' and must not fall back to the session it was invited with.
    if (binding.session_id === undefined && adapter.session_id) binding.session_id = adapter.session_id;
    let invoked = false;
    try {
      const warning = await this.cut_rewound(member.name, adapter, binding, execution);
      const task = free_task_files(this.config, member, execution, binding);
      invoked = true;
      this.segments.start(execution.id);
      if (warning) this.note(execution.id, warning);
      const result = await this.deliver(adapter, binding, { ...task, room_title: this.room_title,
        api_context: { site: this.config.site, room: this.config.room, token: this.config.members[member.name].token,
          home: this.config.api_home, mode: 'free', role: member.role || 'member', execution_id: execution.id,
          requests: execution.requests, read_after: execution.read_until },
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => this.track(member.name, child),
        on_output: (path, chunk) => { appendFileSync(path, chunk, { mode: 0o600 }); this.touch(execution.id); this.segments.mark(execution.id); },
        on_activity: (phase, tool) => { this.touch(execution.id, phase); this.segments.mark(execution.id, phase, tool); },
        on_note: text => this.note(execution.id, text),
        // A stopped process may report after the next execution started; only its own execution takes the result.
        on_failure: error => { try { if (this.row(member.name)?.execution_id === execution.id) this.save(member.name, { error }); } catch { /* Store may already be closed at shutdown. */ } },
        on_exit: denial => this.exited.set(execution.id, denial || ''),
        // Shown beside the answer or failure so the owner can allow them; a lost report only hides the list.
        on_denials: denials => api(this.config, `/executions/${execution.id}`, { action: 'denials', denials }).catch(() => {}),
      });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      this.save(member.name, { status: result.status === 'sidecar_pending' ? 'sidecar_pending' : 'running', attempts: 0 });
    } catch (error) {
      if (adapter.project_access === 'own') return this.retry_or_fail(member.name, execution, `投递失败：${error.message}`);
      const attempts = (this.row(member.name)?.attempts || 0) + 1;
      if ((invoked && error.delivery_status !== 'not_sent') || attempts >= MAX_DELIVERY_ATTEMPTS) {
        return this.fail(member.name, execution.id, `投递失败：${error.message}`);
      }
      await api(this.config, `/executions/${execution.id}`, { action: 'release', reason: `确认未送达：${error.message}` });
      this.save(member.name, { status: 'idle', attempts, error: error.message });
    }
  }
  /**
   * Before a member works again after a rewind, branch its session before the executions the rewind took back.
   * A Claude fork happens on its next turn, so it stays pending until that session exists. Returns a warning when the
   * session could not be cut and the member continues in the old one.
   */
  async cut_rewound(name, adapter, binding, execution) {
    const key = `session-fork:${name}`;
    const pending = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    if (pending && !session_exists(adapter.adapter, binding.session_id)) { binding.fork = JSON.parse(pending); return ''; }
    if (pending) this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
    if (!binding.session_id || !execution.rewound_executions?.length || !BRANCHABLE_ADAPTERS.includes(adapter.adapter)) return '';
    try {
      const cut = await branch_session(adapter, binding.session_id, execution.rewound_executions);
      if (!cut) return '';
      if (cut.fork) this.store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(cut.fork));
      this.store.bind(name, cut.session_id);
      Object.assign(binding, cut);
      return '';
    } catch (error) { return `会话未能回退（${error.message}），本次沿用原会话，它可能仍记得已回退的内容`; }
  }
  /** Follow the website's verdict; stop only this member's processes when its execution ends. */
  async reconcile(member, row, active, minutes) {
    if (row.status === 'reserving') return this.reserve(member, row);
    if (row.status === 'sidecar_pending') {
      const receipt = sidecar_receipt(this.config.participants[member.name], `free-${row.execution_id}`);
      if (receipt?.status === 'accepted' && receipt.session_id) {
        this.store.bind(member.name, receipt.session_id);
        this.save(member.name, { status: 'running' });
      } else if (receipt && active.has(row.execution_id)) return this.retry_or_fail(member.name, active.get(row.execution_id), receipt.error || 'Sidecar 投递结果不明，请核对原会话');
    }
    const execution = active.get(row.execution_id);
    if (!execution) {
      this.activity.delete(row.execution_id);
      await this.report_segments(row.execution_id, true);
      this.stop_member(member.name);
      return this.save(member.name, { status: 'idle', error: '' });
    }
    if (row.status === 'retry_wait') {
      const retry = execution.retry;
      if (retry?.stopped) return this.fail(member.name, execution.id, `${retry.reason}（已停止自动重试）`);
      if (retry?.retry_at && Date.now() >= retry.retry_at * 1000) {
        await api(this.config, `/executions/${execution.id}`, { action: 'retry_start' });
        this.save(member.name, { status: 'delivering' });
        return this.invoke(member, await api(this.config, `/executions/${execution.id}`));
      }
    }
    // A restart between persisting and invoking cannot prove non-delivery, so it never resends.
    if (row.status === 'delivering') return this.fail(member.name, execution.id, '上次投递结果不明，未自动重发；请核对原会话后重新发送');
    if (row.error) return this.retry_or_fail(member.name, execution, row.error);
    if (this.exited.has(execution.id)) {
      const latest = await api(this.config, `/executions/${execution.id}`);
      const denial = this.exited.get(execution.id);
      if (['dispatched', 'started'].includes(latest.status)) return this.fail(member.name, execution.id, denial
        ? `${member.name} ${denial}，未提交本次回答`
        : `${member.name} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容`);
      return this.save(member.name, { status: 'idle' });
    }
    if (Date.now() >= execution.created_at * 1000 + minutes * 60_000) return this.fail(member.name, execution.id, `超过单次执行时限 ${minutes} 分钟；请核对原会话确认是否已有内容`);
    // Segments and notes go first, quietly and often, so a renewal in the same tick already shows the notes it announces.
    if (this.segments.due(execution.id, PROGRESS_REPORT_MS)) await this.report_segments(execution.id);
    const activity = this.activity.get(execution.id);
    const changed = activity && (activity.phase !== activity.sent_phase || activity.at !== activity.sent_at);
    const elapsed = Date.now() - row.last_renew;
    if (elapsed >= RENEW_MS || (changed && elapsed >= ACTIVITY_REPORT_MS)) {
      await api(this.config, `/executions/${execution.id}`, { action: 'renew',
        ...(activity ? { activity: activity.phase, activity_at: Math.floor(activity.at / 1000) } : {}) });
      if (activity) Object.assign(activity, { sent_phase: activity.phase, sent_at: activity.at });
      this.save(member.name, { last_renew: Date.now() });
    }
  }
  /** Send the execution's recorded segments and progress notes; `final` sends the rest once it has ended. */
  report_segments(execution_id, final = false) {
    return this.segments.report(execution_id, final, ({ segments, notes }) =>
      api(this.config, `/executions/${execution_id}`, { action: 'segments', segments, ...(notes.length ? { notes } : {}) }));
  }
  /** Note that the software produced output now, and its phase when the output names one. */
  touch(execution_id, phase) {
    // Updated in place: a renewal in flight marks what it sent on this same record.
    if (!this.activity.has(execution_id)) this.activity.set(execution_id, { phase: '' });
    const current = this.activity.get(execution_id);
    if (phase) current.phase = phase;
    current.at = Date.now();
  }
  /** Queue one progress note for the next progress report; numbering makes a retried report harmless. */
  note(execution_id, text) {
    this.touch(execution_id);
    this.segments.note(execution_id, text);
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
  /**
   * A manual member's session refused the delivery: keep the execution and deliver again after a wait shown on the
   * website, up to MAX_DELIVERY_RETRIES times; any other member, or the last attempt, fails as before.
   */
  async retry_or_fail(name, execution, reason) {
    const attempt = (execution.retry?.attempt || 0) + 1;
    if (this.config.participants[name]?.project_access !== 'own') return this.fail(name, execution.id, reason);
    if (attempt > MAX_DELIVERY_RETRIES) return this.fail(name, execution.id, `${reason}（已自动重试 ${MAX_DELIVERY_RETRIES} 次）`);
    this.stop_member(name);
    this.exited.delete(execution.id);
    await api(this.config, `/executions/${execution.id}`, { action: 'retry_wait', attempt,
      retry_at: Math.floor(Date.now() / 1000) + RETRY_DELAY_SECONDS, reason: reason.slice(0, MAX_RETRY_REASON) });
    this.save(name, { status: 'retry_wait', error: '' });
  }
  /** Record the cause on the website, then stop this member's own processes. */
  async fail(name, execution_id, reason) {
    this.activity.delete(execution_id);
    await this.report_segments(execution_id, true);
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

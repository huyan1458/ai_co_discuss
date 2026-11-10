/** Free-room delivery: one live execution per member, carrying all of that member's open requests. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { adapter_of, BRANCHABLE_ADAPTERS, branch_session, capabilities_of, cleanup_room, deliver_task, delivery_receipt, session_exists, stored_delivery } from './adapters/index.mjs';
import { api, overlapping_directories, read_rule } from './discussion_runner.mjs';
import { SegmentLog } from './execution_progress.mjs';
import { free_task_text, TASK_SUBCOMMANDS, with_expert_prompt } from './expert_prompts.mjs';
import { atomic_json } from './files.mjs';
import { outside_directory, room_directories } from './project_files.mjs';
import { SessionDriver } from './session_driver.mjs';
import { effective_profile, load_room_workflow, workflow_in_use, workflow_task_field } from './workflows.mjs';
import { DEFAULT_SCHEDULER_MODE, GOAL_PROMPT_VERSION, decide_goal_wake, decide_sequence_checkpoint, REVIEW_CONFIDENCE, REVIEW_PROMPT_VERSION, SEQUENCE_CONFIDENCE, SEQUENCE_PROMPT_VERSION, ROUTE_CONFIDENCE, ROUTE_CONTEXT_MESSAGES, decide_review_completion, route_free_message, route_prompt_version, scheduler_thresholds, some_members } from './scheduler.mjs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const RENEW_MS = 30_000;
/** A changed phase is reported early, but no more often than this, since each report refreshes open pages. */
const ACTIVITY_REPORT_MS = 10_000;
/** Segments and progress notes are reported quietly, waking no page, so they may go every tick. */
const PROGRESS_REPORT_MS = 2_000;
const MAX_DELIVERY_ATTEMPTS = 3;
// An idle room under an active goal waits this long before the host is woken, leaving the owner time to speak first.
// Fallback when the room's goal does not carry its own idle wait (older website).
export const GOAL_IDLE_MS = 120_000;
// A goal waiting on the owner reaches their Weixin only after this long: right after the question they may be typing.
export const PENDING_NOTICE_MS = 5 * 60_000;
// A failed Weixin notice is tried again after this long instead of on every tick.
const NOTICE_RETRY_MS = 60_000;
// Without the host's note, the notice quotes the room's latest message, up to this many characters.
const NOTICE_EXCERPT = 300;
// A manual member's session that refuses a delivery is retried in the same execution, after a wait the owner can cut short.
const MAX_DELIVERY_RETRIES = 3;
const RETRY_DELAY_SECONDS = 60;
// The cause is gone once the restarted runner is back, so its retry needs no long wait.
const RESTART_RETRY_DELAY_SECONDS = 5;
// The retry reason the site keeps for an execution a runner restart cut off; its redelivery asks to continue.
const RESTART_REASON = '本机接入程序重启或异常退出，这次执行的软件进程已结束，未提交回答';
const MAX_RETRY_REASON = 500;
const LIVE = ['reserving', 'delivering', 'sidecar_pending', 'running', 'retry_wait'];
// The longest private chat reply the site keeps.
const CHAT_REPLY_LIMIT = 20000;
const MAX_HASHED_BYTES = 5 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

/** Fingerprint configurations whose adapter can enforce project read-only access; no local paths leave this function. */
export function review_capability_version(profile, member, config) {
  if (!profile || profile.project_access !== 'read' || member.access !== 'runner' || member.session_mode !== 'new'
    || !capabilities_of(profile.adapter).enforces_read_only || profile.adapter !== member.adapter
    || !profile.cwd || profile.allowed_tools?.length) return '';
  const project = cwd_key(profile.cwd), drafts = cwd_key(config.draft_directory || `${config.directory}-drafts`);
  if (drafts === project || drafts.startsWith(`${project}/`)) return '';
  const facts = [1, profile.adapter, profile.executable || '', cwd_key(profile.cwd), cwd_key(profile.workdir),
    profile.project_id || '', profile.project_name || '', profile.session_id || '', drafts,
    cwd_key(config.directory)];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/** Whether a process with this pid exists; signal 0 only checks, and EPERM means it exists under another user. */
function process_alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

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

/**
 * The changed paths (relative, as git lists them) that the agent edited with its own tools, given the paths those tools
 * named (absolute or relative to the working directory). Matched by path suffix, so a working directory below the
 * repository root still matches; Windows paths compare case-insensitively.
 */
export function edited_changes(changes, claimed, platform = process.platform) {
  const normal = path => {
    const text = `/${String(path).replaceAll('\\', '/').replace(/^\.\//, '')}`;
    return platform === 'win32' ? text.toLowerCase() : text;
  };
  const named = [...claimed].map(normal);
  return changes.filter(path => named.some(item => item.endsWith(normal(path))));
}

/**
 * The room's project directories a member works with besides its own cwd, each `{path, access}`: a member working in
 * the room's project gets the others at its own project access (read or write); a member working outside them gets
 * them all read-only. Software without project files gets none, and a folder gone from this computer is left out.
 */
export function member_extra_directories(config, profile) {
  if (!profile || !capabilities_of(profile.adapter).project) return [];
  // '' marks a member that joined before the room had a project: it reaches every room directory at its own access.
  const cwd = profile.cwd ?? config.cwd;
  const access = outside_directory(config, profile) || profile.project_access === 'read' ? 'read' : 'write';
  return room_directories(config).filter(path => !(cwd && overlapping_directories(path, cwd)) && existsSync(path))
    .map(path => ({ path, access }));
}

/** A changed path in an extra directory, reported in full so it cannot be mistaken for one in the main directory. */
function extra_change(directory, path) {
  return `${cwd_key(directory)}/${path}`;
}

/** Write a non-secret task and a member-only credential file for one execution. */
export function free_task_files(config, member, execution, binding, { session = null, suggestions = [], reviews = [], stopped = [], process_access = true,
  workflow = null, room_members = [], goal = null } = {}) {
  const id = `free-${execution.id}`;
  const draft_directory = config.draft_directory || `${config.directory}-drafts`;
  mkdirSync(draft_directory, { recursive: true });
  const access_path = join(config.directory, `${id}.access.json`);
  const task_path = join(config.directory, `${id}.task.json`);
  // A workflow member's prompt is read from its card for this execution; everything else stays the room's setting.
  const profile = effective_profile(config.participants[member.name], member.name, workflow);
  // The host sees the workflow only while its members are here: sending them away ends it.
  const host_workflow = member.role === 'host' && workflow && !workflow.error && workflow_in_use(workflow, room_members) ? workflow : null;
  atomic_json(access_path, { site: config.site, room: config.room, member: member.name, token: config.members[member.name].token,
    session_id: binding.session_id || '', execution_id: execution.id });
  const adapter = adapter_of(profile.adapter);
  const extra_directories = member_extra_directories(config, profile);
  const cli = process.platform === 'win32' ? adapter?.windows_command || 'codiscuss.cmd' : 'codiscuss';
  const inbox = Boolean(adapter?.into_window?.(profile, binding));
  const bound_access = process_access && !inbox && Boolean(adapter?.capabilities.access_env);
  const messages = execution.requests.map(item => `#${item.message_id}`).join('、');
  const requests = execution.requests || [];
  const discussion_request = requests.find(item => item.session_request_id && ['discuss', 'discuss_host'].includes(item.purpose)) || null;
  const direct_question = Boolean(session?.status === 'active' && requests.some(item => item.purpose === 'ask'));
  const { instructions, prompt } = free_task_text({ name: member.label || member.name, role: member.role, discussion: direct_question,
    discussion_request, profile, cli,
    room: config.room, messages, read_after: execution.read_until, execution_id: execution.id, task_path,
    access_file: bound_access ? '' : access_path, read_rule: read_rule(profile.adapter), inbox, extra_directories });
  const skills = discussion_request || direct_question
    ? ['discuss-participant/SKILL.md', 'discuss-participant/references/discussion.md',
      ...member.role === 'host' ? ['discuss-host/SKILL.md', 'discuss-host/references/discussion.md'] : [],
      ...direct_question ? ['discuss-participant/references/free.md'] : []]
    : ['discuss-participant/SKILL.md', 'discuss-participant/references/free.md',
      ...member.role === 'host' ? ['discuss-host/SKILL.md', 'discuss-host/references/free.md'] : []];
  // The host works a goal while it is open, and also handles the request that opens it or the wrap-up after it ends.
  const goal_task = member.role === 'host' && (['active', 'paused'].includes(goal?.status)
    || requests.some(item => ['goal_start', 'goal_continue'].includes(item.purpose)));
  if (goal_task) skills.push('discuss-goal/SKILL.md');
  const goal_field = goal_task && goal ? { id: goal.id, objective: goal.objective, status: goal.status, continues: goal.continues,
    max_continues: goal.max_continues, elapsed_seconds: goal.elapsed_seconds, max_minutes: goal.max_minutes,
    phase: goal.phase ?? 'doing', ...(goal.phase_note ? { phase_note: goal.phase_note } : {}) } : null;
  const skills_directory = join(config.project, '.agents', 'skills');
  const workflow_field = host_workflow ? workflow_task_field(host_workflow, room_members, config.participants) : null;
  atomic_json(task_path, { site: config.site, room: config.room, mode: 'free', member: member.name,
    execution_id: execution.id, requests, request_messages: execution.requests.map(item => item.message_id),
    request_purposes: execution.requests.map(item => item.purpose || 'ask'),
    ...(discussion_request ? { discussion_request } : {}),
    ...(session ? { session: { id: session.id, status: session.status, phase: session.phase,
      goal: session.goal, named_followup: session.named_followup } } : {}),
    ...(suggestions.length ? { scheduler_suggestions: suggestions } : {}),
    ...(reviews.length ? { review_handoffs: reviews } : {}),
    ...(goal_field ? { goal: goal_field } : {}),
    ...(stopped.length ? { stopped_executions: stopped } : {}),
    role: member.role || 'member',
    read_after: execution.read_until, cwd: profile.cwd || null, project_access: profile.project_access, draft_directory,
    ...(extra_directories.length ? { extra_directories } : {}),
    skills: skills.map(file => join(config.project, '.agents/skills', file)),
    // The workflow's SKILL.md is not a skill read on every task: the host opens it when a request fits its description.
    ...(workflow_field ? { workflow: { ...workflow_field, skill_path: host_workflow.skill_path } } : {}),
    ...(member.role === 'host' && config.host_workflows ? { host_workflows: true } : {}),
    cli, subcommands: TASK_SUBCOMMANDS,
    ...(bound_access ? { access_env: 'DISCUSS_ACCESS_FILE' } : { access_file: access_path }), instructions });
  return { id, participant: member.name, directory: config.directory, draft_directory, extra_directories, ...(goal_field ? { goal: goal_field } : {}),
    skill_directories: [skills_directory, ...(host_workflow ? [host_workflow.directory] : [])], access_path, prompt: with_expert_prompt(prompt, profile), inbox,
    profile, ...(workflow_field ? { workflow: { ...workflow_field, skill: host_workflow.skill } } : {}) };
}

/**
 * The prompt that resumes an execution the owner paused from the private chat: the same task goes on in the same
 * session, steered by what the owner added. The task file and credentials are written again as at its first delivery.
 */
export function resume_prompt(execution_id, texts) {
  return `房主在私聊窗口暂停了你正在做的这次房间任务（执行 #${execution_id}，仍在进行，没有结束），并补充了下面的话。`
    + `按补充调整后接着完成原任务，已经做完的部分不必重做；完成后照常用 codiscuss 提交这次执行的回答。\n\n${texts.join('\n\n')}`;
}

/**
 * The preface of a task delivered again after the runner restarted mid-execution: the member's session usually still
 * holds the work done so far, so it continues instead of starting over. The original task follows, for a session that
 * never received it.
 */
export function restart_notice(execution_id) {
  return `本机接入程序重启或异常退出，中断了你正在做的这次房间任务（执行 #${execution_id}，仍在进行，没有结束）。`
    + '如果本会话里已经开始了它，接着完成，已经做完的部分不必重做；完成后照常用 codiscuss 提交这次执行的回答。原任务如下。\n\n';
}

// The fixed opening of a private chat turn: where the words come from and how to answer them; the owner's text follows.
const CHAT_PREAMBLE = '房主在私聊窗口直接对你说（不在房间消息流里，其他成员看不到）。像在终端里对话一样直接用文字回答，不要用 codiscuss 提交到房间，除非房主明确要求；可以照常按你的权限读写项目文件。';

/**
 * Write the member-only credential file for one private chat turn and describe it as a task: the member's own session,
 * profile and directories, with the owner's words as the prompt. No task file: the prompt is all the turn needs.
 */
export function chat_task_files(config, member, chat, binding) {
  const id = `chat-${chat.id}`;
  const draft_directory = config.draft_directory || `${config.directory}-drafts`;
  mkdirSync(draft_directory, { recursive: true });
  const access_path = join(config.directory, `${id}.access.json`);
  const profile = effective_profile(config.participants[member.name], member.name, null);
  atomic_json(access_path, { site: config.site, room: config.room, member: member.name, token: config.members[member.name].token,
    session_id: binding.session_id || '' });
  return { id, participant: member.name, directory: config.directory, draft_directory, extra_directories: member_extra_directories(config, profile),
    skill_directories: [join(config.project, '.agents', 'skills')], access_path, prompt: `${CHAT_PREAMBLE}\n\n${chat.text}`, inbox: false, profile };
}

/** What a scheduler can know about a member without a role field: its software, project access and the messages it is on. */
function member_description(name, profile, work) {
  const project = profile.project_name || (profile.cwd ? basename(profile.cwd) : '');
  const access = !capabilities_of(profile.adapter).project ? '，只能读写房间消息' : profile.project_access === 'own' ? '，权限沿用其会话设置' : !profile.cwd ? '，未指定项目目录'
    : profile.project_access === 'read' ? `，项目 ${project} 只读`
      : `，可修改项目 ${project} 的文件${capabilities_of(profile.adapter).file_tools ? '（不能运行命令）' : '并运行命令'}`;
  return `${name}（${adapter_of(profile.adapter)?.label || profile.adapter}${access}${work}）`;
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
  const group = some_members(decision.choice);
  const lean = decision.choice === '__all__' ? '全体各自回应' : decision.choice === '__all_seq__' ? '全体依次回应' : decision.choice === '__none__' ? '无需回应' : group ? `请 ${group.join('、')} 各自回应`
    : members.some(member => member.name === decision.choice) ? `请 ${decision.choice} 回答` : '';
  return lean ? `倾向${lean}，把握不足，交给主持人 ${host}` : `交给主持人 ${host}`;
}

/** Delivers free-room requests through the same software adapters as discussions. */
export class FreeRoomRunner {
  constructor(config, store, deliver = deliver_task, log = () => {}, fetch_impl = fetch, session_driver = null) {
    this.config = config;
    this.store = store;
    this.deliver = deliver;
    this.log = log;
    this.fetch = fetch_impl;
    this.session_driver = session_driver || new SessionDriver(config, log, fetch_impl, store);
    this.routed = new Set();
    // Group requests (@全体成员) being arranged; a failed arrangement leaves the set so the next tick retries.
    this.grouped = new Set();
    this.decisions = new Set();
    // Called when a scheduling decision settles; the service checks the room at once instead of waiting for the next poll.
    this.on_decided = () => {};
    // Set by the service when it can reach the owner's Weixin: { ready(), sent(key), send(notice) }.
    this.notifier = null;
    // Routed requests whose decision is still pending: their host waits, so one pick replaces the host's start.
    this.routing = new Set();
    this.children = new Set();
    // Per live execution, how to pass an interjection to its running software; and interjections already handed over.
    this.steers = new Map();
    this.interjecting = new Map();
    // Per member, the private chat turn running in its session.
    this.chat_turns = new Map();
    this.members = new Map();
    // An empty set proves every tracked handle for this execution closed; a missing set proves nothing after restart.
    this.execution_processes = new Map();
    // Marks the handles this runner process tracks (`owner:ID` in metadata), so a later runner can tell inherited executions.
    this.instance = randomUUID();
    // Execution id -> why its session ended on its own, such as a command refused in unattended mode ('' when unknown).
    this.exited = new Map();
    // Per execution, which delivery is current: a turn stopped by a pause may report its exit after the resumed one began.
    this.generations = new Map();
    // Executions whose software failed before any turn ran, as its adapter reported; safe to deliver again.
    this.not_started = new Set();
    // Executions whose software failed in a way a retry meets again (a used-up limit, a lost login), as its adapter reported.
    this.not_retryable = new Set();
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
    this.session_driver.config = this.config;
  }
  /**
   * A Codex member switched between App and CLI keeps its conversation: the two entries count as one, and the App's
   * session may be filled in from the conversation this member is already bound to.
   */
  same_context(name, previous, current) {
    const [before, after] = [JSON.parse(previous), JSON.parse(current)];
    for (const context of [before, after]) context[0] = adapter_of(context[0])?.session_family || context[0];
    const bound = this.store.binding(name).session_id;
    if (before[5] !== after[5] && [before[5], after[5]].includes('') && [before[5], after[5]].includes(bound)) after[5] = before[5];
    return JSON.stringify(before) === JSON.stringify(after);
  }
  /** One bounded iteration: reconcile live executions, then deliver idle members with open requests. */
  async tick() {
    let inbox; let room;
    // Read one after another: Node's fetch keeps one warm connection per site, and a second parallel request would pay a new
    // TLS handshake (measured 2 s against 0.4 s through a proxy to a hosted site).
    try {
      inbox = await api(this.config, '/inbox');
      room = await api(this.config, '');
    }
    catch (error) {
      if (error.message === 'HTTP 404: 房间不存在') cleanup_room(this.config.directory);
      throw error;
    }
    if (!inbox.archived) await this.sync_review_capabilities(inbox);
    if (!inbox.archived) await this.sync_member_capabilities(inbox);
    if (!inbox.archived && room.session?.status === 'active'
      && await this.session_driver.tick(room, inbox)) {
      // A scheduled plan completes the pending host request and creates a speaker request.
      inbox = await api(this.config, '/inbox');
      room = await api(this.config, '');
    }
    // Smart scheduling runs beside delivery: the host waits for its answer (or failure) before starting, see `routing`.
    if (this.config.scheduler && !inbox.archived) this.recommend_unnamed(inbox, room);
    if (this.config.scheduler && !inbox.archived) this.schedule_handoffs(inbox);
    if (!inbox.archived) this.arrange_groups(inbox);
    this.room_title = room.title;
    this.room = room;
    if (!inbox.archived) await this.continue_goal(room);
    this.inbox = inbox;
    const active = new Map(inbox.executions.map(item => [item.id, item]));
    const present = new Set(inbox.members.map(member => member.name));
    // A member sent away or removed no longer appears; its live work was already voided on the website.
    for (const row of this.store.db.prepare('SELECT * FROM free_deliveries').all()) {
      if (LIVE.includes(row.status) && !present.has(row.member)) { this.stop_member(row.member); this.save(row.member, { status: 'idle' }); }
    }
    await this.report_finished(active);
    await this.deliver_interjections(inbox.executions);
    const pending_stops = await this.report_stops(active);
    // Start in the room's speaking order: execution ids follow it, and the website lays out working cards by them.
    const rank = (room.speaking_order?.items || []).map(item => item.name);
    const place = name => rank.includes(name) ? rank.indexOf(name) : rank.length;
    for (const member of [...inbox.members].sort((left, right) => place(left.name) - place(right.name))) {
      const row = this.row(member.name);
      if (row && LIVE.includes(row.status)) await this.reconcile(member, row, active);
      // A member voided in a window or App the runner could not stop waits until that turn ends (`held_until`).
      else if (!inbox.archived && member.pending.some(request => request.purpose !== 'group') && !this.members.get(member.name)?.size
        && !pending_stops.has(member.name)
        && !member.pending.some(request => this.routing.has(request.id)) && !(member.held_until * 1000 > Date.now())) await this.start(member, row);
    }
    // Room work starts first; a private chat line waits until its member is idle.
    if (!inbox.archived) await this.run_chats(inbox.members);
  }
  /** Publish only changed local facts, using member revisions supplied by the owner's inbox. */
  async sync_review_capabilities(inbox) {
    for (const member of inbox.members) {
      const current = member.review_capability;
      if (!current) continue; // Older sites have no review protocol.
      const version = this.context_errors.has(member.name) ? ''
        : review_capability_version(this.config.participants[member.name], member, this.config);
      if ((current.capability?.config_version || '') === version) continue;
      try {
        member.review_capability = await api(this.config, `/members/${member.id}/review-capability`, {
          revision: current.revision, read_only: Boolean(version), ...(version ? { config_version: version } : {}),
        });
      } catch (error) { this.log(`只读评审能力未同步：${member.name}：${error.message}`); }
    }
  }
  /** Tell the site what a rewind does to each member's session, as its adapter says; only a change is sent. */
  async sync_member_capabilities(inbox) {
    for (const member of inbox.members) {
      const profile = this.config.participants[member.name];
      // An older site lists no effect and takes no report.
      if (member.rewind === undefined || !profile) continue;
      const rewind = capabilities_of(profile.adapter).rewind;
      if (member.rewind === rewind) continue;
      try { await api(this.config, `/members/${member.id}/capabilities`, { rewind }); member.rewind = rewind; }
      catch (error) { this.log(`成员会话能力未同步：${member.name}：${error.message}`); }
    }
  }
  /** Hold only pending hand-backs with a declared next step while it is judged: a preauthorized review, or a loop's next pass. */
  schedule_handoffs(inbox) {
    const host = inbox.members.find(member => member.role === 'host');
    if (!host || !this.config.members[host.name]?.token || inbox.executions.some(item => item.member_id === host.id)
      || LIVE.includes(this.row(host.name)?.status)) return;
    for (const request of host.pending) {
      const scene = request.review?.phase === 'handoff' ? 'review' : request.sequence?.phase === 'checkpoint' ? 'sequence' : '';
      if (!scene) continue;
      const key = `${scene}-decision:${request.id}`;
      const saved = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
      if (this.routed.has(request.id) || (saved && JSON.parse(saved).done)) continue;
      this.routed.add(request.id);
      this.routing.add(request.id);
      const judge = scene === 'review' ? () => this.judge_review(host, request) : () => this.judge_sequence(host, request);
      const pending = this.mark_routing(request.message_id, true).then(judge)
        .catch(error => {
          this.save_suggestion(request, { action: 'host', actual_action: 'host', applied: false,
            model_judgment: false, reason: `没有模型判断：${error.message}` });
          this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify({ done: true }));
          this.log(`${scene === 'review' ? '评审交接' : '循环检查点'} #${request.message_id} 交给主持人：${error.message}`);
        }).finally(() => { this.routing.delete(request.id); return this.mark_routing(request.message_id, false); });
      this.decisions.add(pending);
      pending.finally(() => { this.decisions.delete(pending); this.on_decided(); });
    }
  }
  /** Persist the complete judgment and submission before any write, so restart recovery cannot double-dispatch. */
  async judge_review(host, request) {
    const key = `review-decision:${request.id}`;
    const cached = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    let job = cached ? JSON.parse(cached) : null;
    if (!job) {
      const ready = await api(this.config, `/reviews/${request.review.batch_id}/ready`);
      const decision = await decide_review_completion(this.config.api_home, this.config.scheduler, ready, this.fetch);
      job = { decision, revision: ready.revision, submission_id: randomUUID(), profiles: JSON.stringify(this.config.participants) };
      this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(job));
    }
    const { decision } = job;
    this.save_suggestion(request, { action: decision.action, actual_action: 'unverified', applied: false,
      model_judgment: Boolean(decision.detail), reason: '自动评审交接结果尚未核验' });
    const outcome = decision.action === 'review' ? await this.apply_review(host, request, job)
      : { applied: false, actual_action: 'host', reason: decision.label };
    const label = outcome.applied ? decision.label : outcome.reason;
    const record = decision.detail ? await this.record_decision(request.message_id, decision, label, outcome.applied,
      { scene: 'review', prompt: REVIEW_PROMPT_VERSION, threshold: REVIEW_CONFIDENCE }) : null;
    this.save_suggestion(request, { action: decision.action, actual_action: outcome.actual_action, applied: outcome.applied,
      model_judgment: Boolean(decision.detail), ...(record?.id ? { decision_id: record.id } : {}), reason: label });
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify({ ...job, done: true }));
  }
  /**
   * At a loop's checkpoint, persist the judgment before writing; continuing is bound to the one checkpoint request, so a
   * restart that repeats it gets the same pass back instead of a second one.
   */
  async judge_sequence(host, request) {
    const key = `sequence-decision:${request.id}`;
    const cached = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    let job = cached ? JSON.parse(cached) : null;
    if (!job) {
      const sequence = await api(this.config, `/sequences/${request.sequence.id}`);
      job = { decision: await decide_sequence_checkpoint(this.config.api_home, this.config.scheduler, sequence, this.fetch) };
      this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify(job));
    }
    const { decision } = job;
    let outcome = { applied: false, actual_action: 'host', reason: decision.label };
    if (decision.action === 'continue') {
      try {
        await api({ ...this.config, token: this.config.members[host.name].token }, '/sequences/continue', { actor: host.name, request_id: request.id });
        outcome = { applied: true, actual_action: 'continue' };
      } catch (error) { outcome = { applied: false, actual_action: 'host', reason: `未自动开始下一圈：${error.message}` }; }
    }
    const label = outcome.applied ? decision.label : outcome.reason;
    // The decision sits under the answer it read: the last one of the pass.
    const record = decision.detail ? await this.record_decision(request.sequence.answer_id || request.message_id, decision, label, outcome.applied,
      { scene: 'sequence', prompt: SEQUENCE_PROMPT_VERSION, threshold: SEQUENCE_CONFIDENCE }) : null;
    this.save_suggestion(request, { action: decision.action, actual_action: outcome.actual_action, applied: outcome.applied,
      model_judgment: Boolean(decision.detail), ...(record?.id ? { decision_id: record.id } : {}), reason: label });
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify({ ...job, done: true }));
  }
  /** Advance only the judged revision; inspect an uncertain write using its persisted submission id. */
  async apply_review(host, request, job) {
    if (job.profiles !== JSON.stringify(this.config.participants)) return { applied: false, actual_action: 'host', reason: '本机成员配置已变化，未自动交评审' };
    try {
      await api({ ...this.config, token: this.config.members[host.name].token }, '/reviews/advance', {
        actor: host.name, batch_id: request.review.batch_id, revision: job.revision, submission_id: job.submission_id,
      });
      return { applied: true, actual_action: 'review' };
    } catch (error) {
      try {
        const state = await api(this.config, `/reviews/${request.review.batch_id}/ready`);
        if (state.plan.advance_submission === job.submission_id) return { applied: true, actual_action: 'review' };
        return { applied: false, actual_action: 'host', reason: `未自动交评审：${error.message}` };
      } catch { return { applied: false, actual_action: 'unverified', reason: `评审交接写入结果未核验：${error.message}` }; }
    }
  }
  /**
   * Whether the last tick left nothing in progress: no live delivery or process, no open request for a member this
   * runner delivers to, no pending scheduling judgement and no running discussion. An idle room changes only through its
   * website, so the service may wait for the website to report a change before ticking it again.
   */
  idle() {
    const inbox = this.inbox;
    if (!inbox || this.routing.size || [...this.members.values()].some(children => children.size)) return false;
    // A goal waiting out its idle grace still needs ticks to wake the host when it ends, and one waiting on the owner
    // needs them to send its Weixin notice on time.
    if (this.room?.goal_state?.goal?.idle) return false;
    const notice = this.pending_notice(this.room);
    if (notice && this.notifier.ready() && !this.notifier.sent(notice.key)) return false;
    if (this.room?.session?.status === 'active' || inbox.executions.length || inbox.members.some(member => member.pending.length)) return false;
    return !this.store.db.prepare('SELECT status FROM free_deliveries').all().some(row => LIVE.includes(row.status));
  }
  /**
   * Goal mode: once the room has stayed idle with the same revision for the grace period, wake the host through the
   * website, which re-checks idleness and the revision and decides between a wake-up, a wrap-up or stopping. With a
   * decision model, a room judged to be waiting for the user stands down instead (`wait`); any doubt wakes the host.
   */
  async continue_goal(room) {
    const view = room.goal_state;
    await this.notify_pending(room);
    if (!view?.goal?.idle) { this.goal_idle = null; return; }
    if (this.goal_idle?.revision !== view.revision) { this.goal_idle = { revision: view.revision, since: Date.now() }; return; }
    const grace = this.config.goal_idle_ms ?? (view.goal.idle_seconds ? view.goal.idle_seconds * 1000 : GOAL_IDLE_MS);
    if (this.goal_idle.busy || Date.now() - this.goal_idle.since < grace) return;
    this.goal_idle.busy = true;
    let decision = null;
    // A phase the host declared (waiting, pending) is its own judgement; the decision model only weighs a plain idle room.
    if (this.config.scheduler && view.goal.armed && (view.goal.phase ?? 'doing') === 'doing') {
      try { decision = await this.judge_goal(room, view.goal); }
      catch (error) { this.log(`Goal 空闲判断失败，照常唤醒主持人：${error.message}`); }
    }
    const action = decision?.action === 'wait' ? 'wait' : 'continue';
    let applied = false;
    try {
      const result = await api(this.config, '/goal', { action, revision: view.revision });
      this.room = { ...room, goal_state: result };
      applied = true;
      this.log(action === 'wait' ? 'Goal：房间在等用户，不唤醒主持人'
        : `Goal 续跑：${result.goal?.status === 'active' ? `第 ${result.goal.continues} 次` : result.goal?.status}`);
      this.on_decided();
    } catch (error) { this.log(`Goal ${action === 'wait' ? '等待' : '续跑'}未生效：${error.message}`); }
    finally { this.goal_idle = null; }
    if (decision?.detail) await this.record_decision(decision.after_message_id, decision, decision.label, applied,
      { prompt: GOAL_PROMPT_VERSION, threshold: ROUTE_CONFIDENCE, wide_threshold: ROUTE_CONFIDENCE, scene: 'goal' });
  }
  /** The Weixin notice an active goal waiting on the owner calls for, or null. */
  pending_notice(room) {
    const goal = room?.goal_state?.goal;
    if (!this.notifier || goal?.status !== 'active' || goal.phase !== 'pending') return null;
    return { key: `${this.config.site}/${this.config.room}/goal-${goal.id}-pending-${goal.phase_since}`,
      due: goal.phase_since * 1000 + PENDING_NOTICE_MS, goal };
  }
  /** Tell the owner on Weixin once the goal has waited on them a while; their reply comes back to this room. */
  async notify_pending(room) {
    const notice = this.pending_notice(room);
    if (!notice || Date.now() < notice.due || Date.now() - (this.notice_failed_at ?? 0) < NOTICE_RETRY_MS) return;
    if (!this.notifier.ready() || this.notifier.sent(notice.key)) return;
    try {
      const question = notice.goal.phase_note ? `主持人在等你确认：
${notice.goal.phase_note}` : await this.latest_excerpt(room);
      const text = `${question}

Goal：${notice.goal.objective}
直接回复这条消息，会作为你的发言发到这个房间。`;
      const result = await this.notifier.send({ key: notice.key, room: { site: this.config.site, room: this.config.room, title: room.title }, text });
      if (result.status === 'sent') this.log(`Goal 待确认已发微信通知 #${result.number}`);
    } catch (error) {
      this.notice_failed_at = Date.now();
      this.log(`Goal 待确认微信通知失败：${error.message}`);
    }
  }
  /** The room's latest message from a person or member, for a pending goal nobody wrote a note for. */
  async latest_excerpt(room) {
    const page = await api(this.config, `/messages?after=${Math.max(0, (room.latest_id || 0) - 5)}`);
    const latest = (page.messages || []).filter(message => message.author !== '系统').at(-1);
    if (!latest) return '房间在等你的决定或补充信息，详情见房间。';
    const text = latest.text.length > NOTICE_EXCERPT ? `${latest.text.slice(0, NOTICE_EXCERPT)}…` : latest.text;
    return `房间在等你回复，最近一条是 ${latest.author} 说：
${text}`;
  }
  /** Ask the decision model whether the idle goal room needs its host, from the latest messages and who is in it. */
  async judge_goal(room, goal) {
    const page = await api(this.config, `/messages?after=${Math.max(0, (room.latest_id || 0) - ROUTE_CONTEXT_MESSAGES)}`);
    const context = page.messages || [];
    const everyone = [...(this.inbox?.members || []), ...(this.inbox?.observers || [])];
    const described = this.route_members(everyone, room, (context.at(-1)?.id || 0) + 1);
    const host = described.find(member => member.role === 'host');
    const decision = await decide_goal_wake(this.config.api_home, this.config.scheduler,
      { title: room.title, objective: goal.objective, context, host: host?.name || '主持人', members: described }, this.fetch);
    return { ...decision, after_message_id: context.at(-1)?.id || 0 };
  }
  /**
   * Smart scheduling: for each new unnamed message routed to the host, ask the provider whether another woken
   * member suits it better and apply a confident pick. The host waits for the answer (or its failure) before starting.
   */
  recommend_unnamed(inbox, room) {
    // Manual members are listed apart; they are never delivered to but may host or be recommended.
    const everyone = [...inbox.members, ...(inbox.observers || [])];
    const host = everyone.find(member => member.role === 'host');
    const waiting = host?.pending.filter(request => request.purpose === 'route' && !request.group_action
      && !this.routed.has(request.id) && !this.saved_suggestion(request.id)) || [];
    for (const request of waiting) {
      this.routed.add(request.id);
      if (everyone.length < 2) continue;
      this.routing.add(request.id);
      const decision = this.mark_routing(request.message_id, true)
        .then(() => this.recommend(request, room, everyone))
        .catch(error => {
          if (!this.saved_suggestion(request.id)) this.save_suggestion(request, { action: 'host', actual_action: 'host',
            applied: false, model_judgment: false, reason: `没有模型判断：${error.message}` });
          this.log(`智能调度 #${request.message_id} 未给出推荐：${error.message}`);
        })
        .finally(() => { this.routing.delete(request.id); return this.mark_routing(request.message_id, false); });
      this.decisions.add(decision);
      decision.finally(() => { this.decisions.delete(decision); this.on_decided(); });
    }
  }
  /**
   * For each message naming everyone, have them all answer at once. @全体成员 is the user's explicit choice, so smart
   * scheduling never judges it; answering one after another has its own entry (@全体依次).
   */
  arrange_groups(inbox) {
    const everyone = [...inbox.members, ...(inbox.observers || [])];
    for (const request of everyone.flatMap(member => member.pending).filter(item => item.purpose === 'group' && !this.grouped.has(item.id))) {
      this.grouped.add(request.id);
      const arranged = this.order_group(request)
        .catch(error => { this.grouped.delete(request.id); this.log(`全体成员 #${request.message_id} 未能安排：${error.message}`); });
      this.decisions.add(arranged);
      arranged.finally(() => { this.decisions.delete(arranged); this.on_decided(); });
    }
  }
  async order_group(request) {
    const plan = await api(this.config, `/recommendations/${request.message_id}`);
    const result = await this.apply_group(request.message_id, { action: 'all' }, plan.revision);
    if (!result.applied) throw new Error(result.error);
  }
  /** Apply once with the state that was judged; distinguish conflicts from failed writes and actual success. */
  async apply_group(message_id, decision, revision) {
    try {
      await api(this.config, `/recommendations/${message_id}`, { action: decision.action, ...(revision ? { revision } : {}) });
      this.log(`全体成员 #${message_id}：${{ all: '同时回答', sequential: '依次回答', host: '交给主持人' }[decision.action]}`);
      return { status: 'applied', applied: true };
    } catch (error) {
      return { status: /HTTP (404|409)/.test(error.message) ? 'changed' : 'failed', applied: false, error: error.message };
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
      const described = room.descriptions?.[member.name] ? `；用户描述：${room.descriptions[member.name]}` : '';
      // The model and the last finished message are only read by the guided wording.
      const finished = (room.free?.requests || []).filter(item => item.member === member.name && item.status === 'completed' && item.message_id !== message_id).at(-1);
      return { id: member.id, name: member.name, role: member.role, model: profile?.model || '', finished: finished ? `#${finished.message_id}` : '',
        description: profile ? member_description(member.name, profile, `${work}${described}`)
        : `${member.name}（手动接入，由用户代为触发${work}${described}）` };
    });
  }
  /** Retain a request-bound handoff across retries and service restarts; never inline model probabilities. */
  save_suggestion(request, suggestion) {
    const entry = { request_id: request.id, message_id: request.source_message_id || request.message_id, ...suggestion };
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`scheduler-suggestion:${request.id}`, JSON.stringify(entry));
    return entry;
  }
  /** Recover the handoff for one exact request, independent of the room's recent decision window. */
  saved_suggestion(request_id) {
    const value = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`scheduler-suggestion:${request_id}`)?.value;
    return value ? JSON.parse(value) : null;
  }
  /** Save the website record id only after it is returned; failed logging never invents one. */
  async record_route(request, decision, label, applied) {
    const record = await this.record_decision(request.message_id, decision, label, applied);
    this.save_suggestion(request, { action: decision.action, actual_action: applied ? decision.action : 'host', applied,
      model_judgment: true, ...(record?.id ? { decision_id: record.id } : {}), reason: label });
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
    this.save_suggestion(request, { action: decision.action, actual_action: 'unverified', applied: false,
      model_judgment: true, reason: '判断已产生，自动动作结果尚未核验' });
    this.log(`智能调度 #${message.id}：${decision.action}${decision.member ? ` ${decision.member}` : ''}（选择 ${decision.choice ?? '-'}，置信度 ${decision.confidence ?? '-'}）`);
    if (decision.action === 'host') return this.record_route(request, decision, route_host_label(decision, host.name, members), false);
    if (decision.action !== 'member') {
      // Everyone, the named few or no one replaces the host's request in one step; a host that already started keeps the message.
      const applied = await api(this.config, `/recommendations/${message.id}`, { action: decision.action, ...(decision.members ? { members: decision.members } : {}) })
        .then(() => true, error => { this.log(`智能调度 #${message.id} 未能改派：${error.message}`); return false; });
      const names = described.map(member => member.name).join('、');
      const label = decision.action === 'all' ? `请全体各自回应（${names}）` : decision.action === 'sequential' ? '请全体按发言顺序依次回应' : decision.action === 'some' ? `请 ${decision.members.join('、')} 各自回应` : '无需回应，未唤醒任何成员';
      return this.record_route(request, decision, applied ? label : `${label}（未生效，仍由主持人处理）`, applied);
    }
    try {
      await api(this.config, '/recommendations', { message_id: message.id, member_id: members.find(member => member.name === decision.member).id,
        provider: this.config.scheduler.provider, confidence: decision.confidence });
    } catch (error) {
      await this.record_route(request, decision, `建议让 ${decision.member} 回答（推荐写入失败，未自动生效）`, false);
      throw error;
    }
    // A confident pick is applied at once, interrupting the host; if that fails the recommendation stays for the user to adopt.
    const adopted = await api(this.config, `/recommendations/${message.id}`, { action: 'adopt', mode: 'interrupt' })
      .then(() => true, error => { this.log(`智能调度 #${message.id} 自动改派失败，保留推荐：${error.message}`); return false; });
    await this.record_route(request, decision, adopted ? `改由 ${decision.member} 回答` : `建议让 ${decision.member} 回答（未能自动改派）`, adopted);
  }
  /** Show each judgment under its message so the user can rate it; a failed record never affects delivery. */
  async record_decision(message_id, decision, label, applied, context = {}) {
    const limits = scheduler_thresholds(this.config.scheduler.mode || DEFAULT_SCHEDULER_MODE);
    try {
      return await api(this.config, '/scheduler-decisions', { kind: 'interjection', label, confidence: decision.confidence ?? null,
        applied, provider: this.config.scheduler.provider, after_message_id: message_id, detail: decision.detail, input: decision.input,
        context: { model: this.config.scheduler.model, threshold: limits.member, wide_threshold: limits.wide,
          mode: this.config.scheduler.mode || DEFAULT_SCHEDULER_MODE, prompt: route_prompt_version(this.config.scheduler.mode || DEFAULT_SCHEDULER_MODE), package: PACKAGE_VERSION, ...context } });
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
    const cwd = profile && !capabilities_of(profile.adapter).project ? '' : cwd_key(profile?.cwd ?? this.config.cwd);
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
  async invoke(member, execution, { resume = '', preface = '' } = {}) {
    const adapter = this.config.participants[member.name];
    const review_request = execution.requests?.find(request => request.review?.phase === 'review');
    if (review_request) {
      try { await this.check_review_delivery(member, review_request); }
      catch (error) { return this.reject_review(member, execution, error.message); }
    }
    if (!adapter) return this.fail(member.name, execution.id, `未配置 ${member.name} 的本机接入`);
    if (this.context_errors.has(member.name)) return this.fail(member.name, execution.id, this.context_errors.get(member.name));
    const directory = capabilities_of(adapter.adapter).project ? adapter.cwd ?? this.config.cwd : undefined;
    // A read-only member's software cannot write the project, so files changing meanwhile were written by someone else.
    const before = adapter.project_access === 'read' ? null : workspace_snapshot(directory);
    // The room's other directories this member may write are watched as well; their changes are reported with full paths.
    const extras = member_extra_directories(this.config, adapter).filter(item => item.access === 'write')
      .map(item => ({ directory: item.path, before: workspace_snapshot(item.path) })).filter(item => item.before);
    // A resumed execution keeps the snapshot of its first delivery, so changes made before the pause are reported too.
    if ((before || extras.length) && !this.snapshots.has(execution.id)) this.snapshots.set(execution.id, { member: member.name, directory, before, extras });
    const generation = (this.generations.get(execution.id) || 0) + 1;
    this.generations.set(execution.id, generation);
    const current = () => this.generations.get(execution.id) === generation;
    const binding = this.store.binding(member.name);
    // A member whose session a rewind restarted is bound to '' and must not fall back to the session it was invited with.
    if (binding.session_id === undefined && adapter.session_id) binding.session_id = adapter.session_id;
    let invoked = false;
    try {
      // A resumed execution's session was already cut at its first delivery.
      const warning = resume ? '' : await this.cut_rewound(member.name, adapter, binding, execution);
      const session_request = execution.requests?.find(item => item.session_request_id && ['discuss', 'discuss_host'].includes(item.purpose));
      const session = this.room?.session ? { ...this.room.session } : null;
      const scheduler_suggestions = !this.config.scheduler || member.role !== 'host' ? []
        : session_request?.purpose === 'discuss_host' ? this.session_driver.take_suggestions(session_request.id)
          : execution.requests.map(request => this.saved_suggestion(request.id)).filter(Boolean);
      const review_handoffs = await this.review_handoffs(execution);
      // Executions the user stopped that this session may still hold; a rewind already cut its own out, and a new session holds none.
      const rewound = new Set(execution.rewound_executions || []);
      const stopped = binding.session_id ? this.stopped_executions(member.name).filter(id => !rewound.has(id)) : [];
      const workflow = load_room_workflow(this.config);
      // An unreadable workflow leaves members on their room settings; it is logged once per error, not every execution.
      if (workflow?.error && this.workflow_error !== workflow.error) this.log(`工作流 ${workflow.id} 不可用：${workflow.error}`);
      this.workflow_error = workflow?.error || '';
      const task = free_task_files(this.config, member, execution, binding, {
        session, suggestions: scheduler_suggestions, reviews: review_handoffs, stopped, workflow, room_members: this.room?.members,
        goal: this.room?.goal_state?.goal || null,
      });
      invoked = true;
      this.segments.start(execution.id);
      if (warning) this.note(execution.id, warning);
      const result = await this.deliver(review_request ? structuredClone(task.profile) : task.profile, binding, { ...task, ...(resume ? { prompt: resume } : preface ? { prompt: preface + task.prompt } : {}), room_title: this.room_title,
        ...(review_request ? { before_model_start: () => this.check_review_delivery(member, review_request) } : {}),
        api_context: { site: this.config.site, room: this.config.room, token: this.config.members[member.name].token,
          home: this.config.api_home, mode: 'free', role: member.role || 'member', execution_id: execution.id,
          cwd: directory, project_access: adapter.project_access, extra_directories: task.extra_directories,
          requests: execution.requests, read_after: execution.read_until, session, discussion_request: session_request,
          scheduler_suggestions, review_handoffs, ...(task.workflow ? { workflow: task.workflow } : {}),
          // Commands the enabled workflow registers; software with its own command line ignores them.
          ...(workflow?.commands?.length ? { commands: { directory: workflow.directory, list: workflow.commands } } : {}),
          ...(Number.isInteger(this.config.api_max_requests) ? { max_requests: this.config.api_max_requests } : {}),
          ...(task.goal ? { goal: task.goal } : {}) },
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => this.track(member.name, child, execution.id),
        on_output: (path, chunk) => { appendFileSync(path, chunk, { mode: 0o600 }); this.touch(execution.id); this.segments.mark(execution.id); },
        on_activity: (phase, tool) => { this.touch(execution.id, phase); this.segments.mark(execution.id, phase, tool); },
        on_note: text => this.note(execution.id, text),
        // Files the agent edited with its own tools, read from its events; an empty call says the list is tracked.
        on_edits: paths => {
          const snapshot = this.snapshots.get(execution.id);
          if (snapshot) paths.forEach(path => (snapshot.edited ||= new Set()).add(path));
          if (snapshot && !paths.length) snapshot.edited ||= new Set();
        },
        // A stopped process may report after the next execution started; only its own execution takes the result.
        on_failure: (error, { not_started = false, retryable = true } = {}) => {
          if (!current()) return;
          if (not_started) this.not_started.add(execution.id);
          if (!retryable) this.not_retryable.add(execution.id);
          try { if (this.row(member.name)?.execution_id === execution.id) this.save(member.name, { error }); } catch { /* Store may already be closed at shutdown. */ }
        },
        on_exit: denial => { if (current()) this.exited.set(execution.id, denial || ''); },
        // Shown beside the answer or failure so the owner can allow them; a lost report only hides the list.
        on_denials: denials => api(this.config, `/executions/${execution.id}`, { action: 'denials', denials }).catch(() => {}),
      });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      this.clear_stopped(member.name);
      this.save(member.name, { status: result.status === 'sidecar_pending' ? 'sidecar_pending' : 'running', attempts: 0 });
      if (result.steer) this.steers.set(execution.id, result.steer);
      const delivery = result.capabilities || capabilities_of(adapter.adapter).delivery;
      await this.report_delivery(execution.id, { ...delivery, steer: Boolean(result.steer),
        resume: Boolean(capabilities_of(adapter.adapter).resume && delivery.stoppable) }, member.name);
    } catch (error) {
      if (review_request && error.delivery_status === 'not_sent') return this.reject_review(member, execution, error.message);
      if (adapter.project_access === 'own') return this.retry_or_fail(member.name, execution, `投递失败：${error.message}`);
      const attempts = (this.row(member.name)?.attempts || 0) + 1;
      if ((invoked && error.delivery_status !== 'not_sent') || attempts >= MAX_DELIVERY_ATTEMPTS) {
        return this.fail(member.name, execution.id, `投递失败：${error.message}`);
      }
      await api(this.config, `/executions/${execution.id}`, { action: 'release', reason: `确认未送达：${error.message}` });
      this.save(member.name, { status: 'idle', attempts, error: error.message });
    }
  }
  /** Recheck local configuration and the site's identity binding before a review starts. */
  async check_review_delivery(member, request) {
    const proof = request.review;
    const version = review_capability_version(this.config.participants[member.name], member, this.config);
    if (!version || version !== proof.config_version || this.context_errors.has(member.name)) throw new Error('没有可核验只读的评审成员：本机配置与预授权能力版本不符');
    const current = await api(this.config, `/members/${member.id}/review-capability`);
    if (current.revision !== proof.member_revision || current.capability?.config_version !== version) throw new Error('评审者资格或能力版本已改变');
  }
  /** Cancel only this isolated review execution and leave a durable reason for its host. */
  async reject_review(member, execution, reason) {
    await api(this.config, `/executions/${execution.id}`, { action: 'reject_review', reason });
    this.save(member.name, { status: 'idle', error: reason });
    this.stop_member(member.name);
  }
  /** Attach status and read entry points, never inline the implementation context into a wake-up. */
  async review_handoffs(execution) {
    const reviews = [];
    for (const request of execution.requests || []) {
      if (request.review?.phase !== 'handoff') continue;
      const batch_id = request.review.batch_id;
      try {
        const state = await api(this.config, `/reviews/${batch_id}/ready`);
        reviews.push({ batch_id, request_id: request.id, ready: state.ready, reason: state.reason,
          reviewer: state.plan.reviewer_name, scope: state.plan.scope });
      } catch (error) { reviews.push({ batch_id, request_id: request.id, ready: false, reason: `无法读取评审推进状态：${error.message}` }); }
    }
    return reviews;
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
  async reconcile(member, row, active) {
    if (row.status === 'reserving') return this.reserve(member, row);
    if (row.status === 'sidecar_pending') {
      const receipt = delivery_receipt(this.config.participants[member.name], `free-${row.execution_id}`);
      if (receipt?.status === 'accepted' && receipt.session_id) {
        this.store.bind(member.name, receipt.session_id);
        this.save(member.name, { status: 'running' });
      } else if (receipt && active.has(row.execution_id)) return this.retry_or_fail(member.name, active.get(row.execution_id), receipt.error || 'Sidecar 投递结果不明，请核对原会话');
    }
    const execution = active.get(row.execution_id);
    if (!execution) {
      this.forget_owner(row.execution_id);
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
        // Read from the site's retry record, so a second restart during the wait still delivers it as a continuation.
        const preface = retry?.reason === RESTART_REASON ? restart_notice(execution.id) : '';
        return this.invoke(member, await api(this.config, `/executions/${execution.id}`), { preface });
      }
    }
    // A restart between persisting and invoking cannot prove non-delivery, so it never resends.
    if (row.status === 'delivering') return this.fail(member.name, execution.id, '上次投递结果不明，未自动重发；请核对原会话后重新发送');
    if (execution.paused_at) {
      // A paused turn ending is not a failure: the execution waits, renewed, for the owner's words.
      if (await this.hold_paused(member, row, execution)) return;
    } else {
      // Inherited from a runner that stopped or crashed: once its software processes are gone, no answer can come, so the
      // same execution is delivered again after the retry wait instead of handing the failure to the host.
      if (row.status === 'running' && this.orphan(execution.id)?.alive === false) {
        return this.retry_or_fail(member.name, execution, RESTART_REASON, { restarted: true });
      }
      if (row.error) return this.retry_or_fail(member.name, execution, row.error);
      if (this.exited.has(execution.id)) {
        const latest = await api(this.config, `/executions/${execution.id}`);
        const denial = this.exited.get(execution.id);
        if (['dispatched', 'started'].includes(latest.status)) return this.fail(member.name, execution.id, denial
          ? `${member.name} ${denial}，未提交本次回答`
          : `${member.name} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容`);
        return this.save(member.name, { status: 'idle' });
      }
    }
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
  /**
   * An execution the owner paused from the private chat, or that takes an interjection only by a pause: stop its
   * software turn and keep the execution live; once that turn has ended and the owner's words wait, resume the same
   * execution in the same session with them. Returns true when it resumed, so the caller does nothing more this tick.
   */
  async hold_paused(member, row, execution) {
    this.steers.delete(execution.id);
    const processes = this.execution_processes.get(execution.id);
    for (const child of processes || []) this.request_stop(child);
    this.exited.delete(execution.id);
    this.not_started.delete(execution.id);
    this.not_retryable.delete(execution.id);
    if (row.error) this.save(member.name, { error: '' });
    if (processes?.size || !execution.interjections?.length) return false;
    this.save(member.name, { status: 'delivering', error: '' });
    await api(this.config, `/executions/${execution.id}`, { action: 'resume' });
    await this.invoke(member, execution, { resume: resume_prompt(execution.id, execution.interjections.map(item => item.text)) });
    if (this.row(member.name)?.status !== 'running') return true;
    for (const interjection of execution.interjections) {
      this.interjecting.set(interjection.id, { status: 'delivered' });
      await api(this.config, `/executions/${execution.id}`, { action: 'interjection', interjection_id: interjection.id, status: 'delivered' })
        .catch(error => this.log(`插话 #${interjection.id} 的结果未能上报：${error.message}`));
    }
    return true;
  }
  /**
   * Tell the site what this delivery can do, as the adapter reported it: whether the runner can stop it and see its
   * progress. Kept locally until the execution ends so a restarted runner still knows whether it could stop it.
   * A lost report is retained for the final stop result; sites and runners must use the same capability protocol.
   */
  async report_delivery(execution_id, { stoppable, progress, steer = false, resume = false }, member) {
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`delivery:${execution_id}`, JSON.stringify({ stoppable, progress, member }));
    await api(this.config, `/executions/${execution_id}`, { action: 'delivery', stoppable, progress, steer, resume })
      .catch(error => this.log(`执行 #${execution_id} 的投递能力未能上报：${error.message}`));
  }
  /** Retry durable stop reports even after the member went idle, left, or started a later execution. */
  async report_stops(active) {
    const pending = new Set();
    for (const { key, value } of this.store.db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'delivery:%'").all()) {
      const execution_id = Number(key.slice('delivery:'.length));
      if (active.has(execution_id)) continue;
      const delivery = stored_delivery(value);
      const name = delivery.member || this.store.db.prepare('SELECT member FROM free_deliveries WHERE execution_id=?').get(execution_id)?.member;
      if (!name) continue;
      for (const child of this.execution_processes.get(execution_id) || []) this.request_stop(child);
      try { await this.report_stop(name, execution_id); }
      catch (error) { pending.add(name); this.log(`执行 #${execution_id} 的停止结果未能上报：${error.message}`); }
    }
    return pending;
  }
  /** Report observed termination, never infer it from a capability or a successfully sent kill signal. */
  async report_stop(name, execution_id) {
    const key = `delivery:${execution_id}`;
    const value = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    if (!value) return;
    const delivery = stored_delivery(value), processes = this.execution_processes.get(execution_id);
    const ended = processes ? processes.size === 0 : this.exited.has(execution_id) || this.orphan(execution_id)?.alive === false;
    const result = delivery.pending_result && delivery.pending_result !== 'unconfirmed' ? delivery.pending_result
      : !delivery.stoppable ? 'unstoppable' : ended ? 'stopped' : 'unconfirmed';
    if (delivery.stop_result === result) return;
    // An execution that left the inbox by finishing normally has no stop to report; only a voided one does.
    if (['completed', 'failed'].includes((await api(this.config, `/executions/${execution_id}`)).status)) {
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      this.execution_processes.delete(execution_id);
      return;
    }
    // Keep the observed outcome before sending: a restart after a lost response must retry the same fact.
    this.store.db.prepare('UPDATE metadata SET value=? WHERE key=?')
      .run(JSON.stringify({ ...delivery, member: name, pending_result: result }), key);
    try { await api(this.config, `/executions/${execution_id}`, { action: 'stopped', result }); }
    catch (error) {
      if (!/HTTP 409:/.test(error.message)) throw error;
      const latest = await api(this.config, `/executions/${execution_id}`);
      // A conflict is not necessarily normal completion: keep cancelled reports until an idempotent receipt arrives.
      if (!['completed', 'failed'].includes(latest.status)) throw error;
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
      this.execution_processes.delete(execution_id);
      return;
    }
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)')
      .run(`stopped:${name}`, JSON.stringify([...new Set([...this.stopped_executions(name), execution_id])]));
    if (result === 'unconfirmed') {
      this.store.db.prepare('UPDATE metadata SET value=? WHERE key=?')
        .run(JSON.stringify({ ...delivery, member: name, pending_result: result, stop_result: result }), key);
      // The site's bounded hold now controls the next delivery; retain handles to observe and retry termination.
      for (const child of processes || []) this.members.get(name)?.delete(child);
    }
    else { this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key); this.execution_processes.delete(execution_id); this.forget_owner(execution_id); }
  }
  /**
   * An execution whose handles an earlier runner process tracked and this one does not: `{alive}` says whether any of its
   * recorded software processes still runs. A handle without a pid lived inside that runner, so it ended with it.
   */
  orphan(execution_id) {
    if (this.execution_processes.has(execution_id)) return null;
    const saved = JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`owner:${execution_id}`)?.value || 'null');
    if (!saved || saved.instance === this.instance) return null;
    return { alive: saved.pids.some(process_alive) };
  }
  /** Record that this runner process tracks a handle of the execution, with its pid when it is a separate process. */
  record_owner(execution_id, pid) {
    const key = `owner:${execution_id}`;
    const saved = JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value || 'null');
    const pids = saved?.instance === this.instance ? saved.pids : [];
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid);
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, JSON.stringify({ instance: this.instance, pids }));
  }
  forget_owner(execution_id) { this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`owner:${execution_id}`); }
  /** Once a new task received the stop reminders, retire acknowledged unconfirmed reports for its old turns. */
  clear_stopped(name) {
    for (const id of this.stopped_executions(name)) {
      const key = `delivery:${id}`, value = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
      if (value && stored_delivery(value).stop_result === 'unconfirmed') {
        this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
        this.execution_processes.delete(id);
      }
    }
    this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`stopped:${name}`);
  }
  /** Executions the user stopped since this member's last delivered task. */
  stopped_executions(name) {
    return JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`stopped:${name}`)?.value || '[]');
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
      if (active.has(execution_id) || this.execution_processes.get(execution_id)?.size) continue;
      this.snapshots.delete(execution_id);
      const after = snapshot.before ? workspace_snapshot(snapshot.directory) : null;
      if (!after && !snapshot.extras?.length) continue;
      const extra = (snapshot.extras || []).flatMap(item => {
        const current = workspace_snapshot(item.directory);
        return current ? changed_between(item.before, current).map(path => extra_change(item.directory, path)) : [];
      });
      const changes = [...(after ? changed_between(snapshot.before, after) : []), ...extra].slice(0, 200);
      // `edited` is sent only when the adapter tracked edits; without it the site cannot tell who wrote a shared file.
      const edited = snapshot.edited ? { edited: edited_changes(changes, snapshot.edited) } : {};
      try { await api(this.config, `/executions/${execution_id}`, { action: 'report', changes, ...edited }); }
      catch (error) { if (!/HTTP (404|409)/.test(error.message)) throw error; }
    }
  }
  /**
   * A manual member's session refused the delivery, or the software failed before any turn ran: keep the execution and
   * deliver again after a wait shown on the website, up to MAX_DELIVERY_RETRIES times; so is an execution whose software
   * ended with the previous runner process (`restarted`). Anything else, or the last attempt, fails as before.
   */
  async retry_or_fail(name, execution, reason, { restarted = false } = {}) {
    const attempt = (execution.retry?.attempt || 0) + 1;
    const not_started = this.not_started.delete(execution.id);
    if (this.not_retryable.delete(execution.id)) return this.fail(name, execution.id, reason);
    if (!restarted && this.config.participants[name]?.project_access !== 'own' && !not_started) return this.fail(name, execution.id, reason);
    if (attempt > MAX_DELIVERY_RETRIES) return this.fail(name, execution.id, `${reason}（已自动重试 ${MAX_DELIVERY_RETRIES} 次）`);
    this.stop_member(name);
    this.exited.delete(execution.id);
    await api(this.config, `/executions/${execution.id}`, { action: 'retry_wait', attempt,
      retry_at: Math.floor(Date.now() / 1000) + (restarted ? RESTART_RETRY_DELAY_SECONDS : RETRY_DELAY_SECONDS), reason: reason.slice(0, MAX_RETRY_REASON) });
    this.save(name, { status: 'retry_wait', error: '' });
  }
  /** Record the cause on the website, then stop this member's own processes. */
  async fail(name, execution_id, reason) {
    this.activity.delete(execution_id);
    this.not_started.delete(execution_id);
    this.not_retryable.delete(execution_id);
    await this.report_segments(execution_id, true);
    try { await api(this.config, `/executions/${execution_id}`, { action: 'fail', reason }); }
    catch (error) { if (!/HTTP 409/.test(error.message)) throw error; }
    this.save(name, { status: 'idle', error: reason });
    this.stop_member(name);
    this.forget_owner(execution_id);
  }
  /**
   * Hand the owner's pending interjections to the software running each execution, in order, through the steer handle
   * its delivery returned; report each as delivered or failed. A handle is dropped once its execution is no longer live.
   */
  async deliver_interjections(executions) {
    const live = new Set(executions.map(item => item.id));
    for (const id of this.steers.keys()) if (!live.has(id)) this.steers.delete(id);
    for (const execution of executions) {
      // A paused execution hears its interjections when it resumes (hold_paused).
      if (execution.paused_at) continue;
      for (const interjection of execution.interjections || []) {
        // An interjection is handed over once; a lost report is sent again with the same outcome.
        let report = this.interjecting.get(interjection.id);
        if (!report) {
          const steer = this.steers.get(execution.id);
          report = { status: 'failed', reason: '本次投递不支持执行中插话' };
          if (steer) {
            try { report = await steer(interjection.text) ? { status: 'delivered' } : { status: 'failed', reason: '它已结束本轮，插话未送达' }; }
            catch (error) { report = { status: 'failed', reason: String(error.message).slice(0, 400) }; }
          }
          this.interjecting.set(interjection.id, report);
        }
        try { await api(this.config, `/executions/${execution.id}`, { action: 'interjection', interjection_id: interjection.id, ...report }); }
        catch (error) { this.log(`插话 #${interjection.id} 的结果未能上报：${error.message}`); }
      }
    }
  }
  /**
   * The owner's private chat lines (backend/private_chat.py), each run as a turn of its member's own session once the
   * member is idle, the reply taken from the software's last remark. A line sent while a chat turn runs goes into it
   * as an interjection; a running line the owner stopped ends its process; one the runner lost at a restart fails.
   */
  async run_chats(members) {
    for (const member of members) {
      const chats = member.chats || [];
      const live = this.chat_turns.get(member.name);
      if (live && !chats.some(chat => chat.id === live.id && chat.status === 'running')) {
        if (live.child) this.request_stop(live.child);
        continue;
      }
      for (const chat of chats) {
        if (chat.status === 'running' && chat.id !== live?.id) await this.chat_report(chat.id, { action: 'fail', reason: '本机服务重启，这轮私聊已中断' });
        else if (chat.status === 'pending' && live?.steer && !live.steered.has(chat.id)) {
          live.steered.add(chat.id);
          if (await live.steer(chat.text)) await this.chat_report(chat.id, { action: 'steered' });
        }
      }
      const next = chats.find(chat => chat.status === 'pending' && !live?.steered.has(chat.id));
      const row = this.row(member.name);
      if (next && !live && !this.members.get(member.name)?.size && !(row && LIVE.includes(row.status))) await this.start_chat(member, next);
    }
  }
  /** Start one chat line as its own turn; the turn reports its reply or failure when it ends, without holding the tick. */
  async start_chat(member, chat) {
    const profile = this.config.participants[member.name];
    const binding = this.store.binding(member.name) || {};
    const adapter = profile && adapter_of(profile.adapter);
    if (!adapter || !capabilities_of(profile.adapter).chat || (!adapter.chat && adapter.into_window?.(profile, binding))) {
      return this.chat_report(chat.id, { action: 'fail', reason: '这位成员的接入方式看不到它的输出，暂不支持私聊窗；可在它自己的窗口里对话' });
    }
    if (!await this.chat_report(chat.id, { action: 'start' })) return;
    const turn = { id: chat.id, child: null, steer: null, steered: new Set() };
    this.chat_turns.set(member.name, turn);
    const notes = [];
    let settle;
    const ended = new Promise(resolve => { settle = resolve; });
    try {
      const task = chat_task_files(this.config, member, chat, binding);
      // Software without its own session (the model API) takes the earlier lines as its context.
      const history = (await api(this.config, `/members/${member.id}/chat`).catch(() => ({ chats: [] }))).chats
        .filter(item => item.id !== chat.id && item.status === 'answered').map(item => ({ text: item.text, reply: item.reply }));
      const result = await this.deliver(task.profile, binding, { ...task, room_title: this.room_title, chat: true, chat_history: history,
        api_context: { site: this.config.site, room: this.config.room, token: this.config.members[member.name].token,
          home: this.config.api_home, mode: 'free', role: member.role || 'member', cwd: task.profile.cwd || this.config.cwd,
          project_access: task.profile.project_access, ...(Number.isInteger(this.config.api_max_requests) ? { max_requests: this.config.api_max_requests } : {}) },
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => { turn.child = child; this.track(member.name, child, `chat-${chat.id}`); },
        on_output: (path, chunk) => appendFileSync(path, chunk, { mode: 0o600 }),
        on_activity: () => {}, on_note: text => notes.push(text), on_edits: () => {},
        on_failure: error => settle({ error }), on_exit: () => settle({}), on_denials: () => {} });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      turn.steer = result.steer || null;
    } catch (error) { settle({ error: error.message }); }
    ended.then(async ({ error }) => {
      this.chat_turns.delete(member.name);
      const reply = notes.at(-1);
      await this.chat_report(chat.id, !error && reply ? { action: 'reply', text: reply.slice(0, CHAT_REPLY_LIMIT) }
        : { action: 'fail', reason: String(error || '它没有给出文字回复').slice(0, 400) });
    });
  }
  /** Tell the site how one chat line went; false when the site refused it (the owner already stopped it). */
  async chat_report(chat_id, payload) {
    try { await api(this.config, `/chats/${chat_id}`, payload); return true; }
    catch (error) { this.log(`私聊 #${chat_id} ${payload.action} 未能上报：${error.message}`); return false; }
  }
  /** Count live processes per member so one session never has two writers. */
  track(name, child, execution_id = this.row(name)?.execution_id) {
    this.children.add(child);
    if (!this.members.has(name)) this.members.set(name, new Set());
    this.members.get(name).add(child);
    if (!this.execution_processes.has(execution_id)) this.execution_processes.set(execution_id, new Set());
    const processes = this.execution_processes.get(execution_id);
    processes.add(child);
    // A handle only the owner may stop keeps running in the user's software, so a later runner must not fail it.
    if (Number.isInteger(execution_id) && child.stop_on_shutdown !== false) this.record_owner(execution_id, child.pid);
    child.once('close', () => { processes.delete(child); this.children.delete(child); this.members.get(name).delete(child); });
  }
  /** Request termination; only a later close event proves it happened. */
  request_stop(child) { try { child.kill(); } catch { /* The stop report remains unconfirmed. */ } }
  /** Stop one member's processes without touching other members or desktop apps. */
  stop_member(name) { for (const child of this.members.get(name) || []) this.request_stop(child); }
  /**
   * Stop every process this runner created, except a handle whose stop only the owner asks for (`stop_on_shutdown:
   * false`, e.g. a stop that changes the user's App): that turn runs on in the software and is not reported.
   */
  stop_children() { for (const child of this.children) if (child.stop_on_shutdown !== false) this.request_stop(child); }
}

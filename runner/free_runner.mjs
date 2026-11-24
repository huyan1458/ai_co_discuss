/** Free-room delivery: one live execution per member, carrying all of that member's open requests. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { adapter_of, BRANCHABLE_ADAPTERS, branch_session, capabilities_of, chosen_settings, cleanup_room, deliver_task, delivery_receipt, recover_turn, session_exists, session_settings, stored_delivery, takes_images } from './adapters/index.mjs';
import { api as raw_api, overlapping_directories, read_rule } from './discussion_runner.mjs';
import { SegmentLog } from './execution_progress.mjs';
import { capture_base, file_diffs } from './file_diff.mjs';
import { correctable_refusals, free_task_text, MAX_REFUSAL_RETRIES, refusal_retry_prompt, restart_resume_prompt, TASK_SUBCOMMANDS, with_expert_prompt } from './expert_prompts.mjs';
import { entry_access, site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { image_settings } from './image_service.mjs';
import { outside_directory, room_directories } from './project_files.mjs';
import { SessionDriver } from './session_driver.mjs';
import { slash_names } from './slash_names.mjs';
import { effective_profile, load_room_workflow, member_knowledge, workflow_directory, workflow_execution_binding, workflow_in_use, workflow_task_field } from './workflows.mjs';
import { GOAL_CONFIDENCE, GOAL_PROMPT_VERSION, decide_goal_wake, decide_sequence_checkpoint, REVIEW_CONFIDENCE, REVIEW_PROMPT_VERSION, SEQUENCE_CONFIDENCE, SEQUENCE_PROMPT_VERSION, ROUTE_CONFIDENCE, ROUTE_CONTEXT_MESSAGES, ROUTE_GUIDED_PROMPT_VERSION, ROUTE_WIDE_CONFIDENCE, SCHEDULER_MODE, decide_review_completion, route_free_message, some_members } from './scheduler.mjs';
import { room_text, room_payload } from './room_text.mjs';
import { question_notice } from './question_weixin.mjs';
import { host_permissions } from './host_permissions.mjs';
const api = (config, path, payload, ...options) => raw_api(config, path, room_payload(payload), ...options);

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const RENEW_MS = 30_000;
/** A changed phase is reported early, but no more often than this, since each report refreshes open pages. */
const ACTIVITY_REPORT_MS = 10_000;
/** Segments and progress notes are reported quietly, waking no page, so they may go every tick. */
const PROGRESS_REPORT_MS = 2_000;
const MAX_DELIVERY_ATTEMPTS = 3;
// The website's message limit: a longer remark is not captured, never cut short.
const MAX_CAPTURED_REPLY = 32000;
// An idle room under an active goal waits this long before the host is woken, leaving the owner time to speak first.
// Fallback when the room's goal does not carry its own idle wait (older website).
export const GOAL_IDLE_MS = 120_000;
// A goal waiting on the owner reaches their Weixin only after this long: right after the question they may be typing.
// How long the owner is left waiting (a goal's pending phase, a blocking question) before Weixin tells them.
export const PENDING_NOTICE_MS = 5 * 60_000;
// A failed Weixin notice is tried again after this long instead of on every tick.
const NOTICE_RETRY_MS = 60_000;
// Without the host's note, the notice quotes the room's latest message, up to this many characters.
const NOTICE_EXCERPT = 300;
// A manual member's session that refuses a delivery is retried in the same execution, after a wait the owner can cut short.
const MAX_DELIVERY_RETRIES = 3;
const MAX_DIAGNOSTIC_RETRIES = 30;
const RETRY_DELAY_SECONDS = 60;
const NETWORK_RETRY_SECONDS = [10, 30, 60];
// How long a voided turn the runner cannot stop is still watched for its end: a little past the site's 600-second hold.
const UNSTOPPABLE_FOLLOW_MS = 15 * 60_000;
// The failure classes an adapter may report (adapter contract `on_failure(reason, {failure_class, ...})`).
const FAILURE_CLASSES = ['quota', 'auth', 'output_truncated', 'compaction_failed', 'policy_blocked'];
const RESTART_REASON = room_text("重启后无法确认上次执行结果");
// Recognize older versions' pending restart retries so upgrading cannot redeliver them.
const RESTART_REASON_CODE = 'runner_restarted';
const MAX_RETRY_REASON = 500;
const LIVE = ['reserving', 'delivering', 'sidecar_pending', 'running', 'retry_wait'];
// The longest private chat reply the site keeps.
const CHAT_REPLY_LIMIT = 20000;
const MAX_HASHED_BYTES = 5 * 1024 * 1024;
// Attachments of the messages that woke an execution are fetched before delivery; one slow file fails alone.
const ATTACHMENT_TIMEOUT_MS = 60_000;
const MAX_MESSAGE_FILES = 10;
// The image types the site accepts that a model reads as an image; other files go to the member by path only.
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const GIT_TIMEOUT_MS = 15_000;
// How much of the room's goal or original request a host task quotes; the rest is read from the room.
const ROOM_GOAL_CHARS = 500;

/** Fingerprint configurations whose adapter can enforce project read-only access; no local paths leave this function. */
export function review_capability_version(profile, member, config) {
  if (!profile || profile.project_access !== 'read' || member.access !== 'runner' || member.session_mode !== 'new'
    || !capabilities_of(profile.adapter).enforces_read_only || profile.adapter !== member.adapter
    || !profile.cwd || profile.allowed_tools?.length) return '';
  const project = cwd_key(profile.cwd), drafts = cwd_key(member_drafts(config, member.name));
  if (drafts === project || drafts.startsWith(`${project}/`)) return '';
  const facts = [1, profile.adapter, profile.executable || '', cwd_key(profile.cwd), cwd_key(profile.workdir),
    profile.project_id || '', profile.project_name || '', profile.session_id || '', drafts,
    cwd_key(config.directory)];
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

/**
 * One member's own drafts folder inside the room's: unsubmitted answers of different members never share a folder, and
 * the folder the member's software is allowed to edit (and, for file tools, to read) is only its own (必 10).
 */
export function member_drafts(config, name) {
  const base = config.draft_directory || `${config.directory}-drafts`;
  return join(base, createHash('sha256').update(String(name)).digest('hex').slice(0, 16));
}

// The file name of a taken-over member's proactive credential inside its runtime folder; mirrored in runner/discuss.py.
export const PROACTIVE_ACCESS_FILE = 'proactive.access.json';

/**
 * One member's own folder in the room's runtime directory, holding its credential and task files and the attachment
 * copies of its tasks. Adapters grant a member's software only this folder, never the runtime directory, so software
 * whose file reads follow that grant cannot read another member's credential (凭据文件隔离).
 */
export function member_runtime(config, name) {
  const directory = join(config.directory, 'members', createHash('sha256').update(String(name)).digest('hex').slice(0, 16));
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** The member runtime folders a room's runtime directory holds now. */
export function member_folders(directory) {
  try { return readdirSync(join(directory, 'members')).map(name => join(directory, 'members', name)); } catch { return []; }
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
/** `[图片 #n]` / `[文件 #n]`: how an attachment is named in its message's text and in the task, as on the page; n is its
 * room-wide number from the site (files are numbered across the room), else its place in the message for an older site. */
export function attachment_placeholder(file, number) {
  return `[${IMAGE_TYPES.has(file.content_type) ? '图片' : '文件'} #${number}]`;
}

/** The text of the user's own messages among those that woke this execution; an unreadable one is skipped. */
export async function user_request_texts(config, execution) {
  const message_ids = [...new Set((execution.requests || []).map(item => item.message_id).filter(Number.isInteger))];
  const texts = [];
  for (const message_id of message_ids) {
    try {
      const message = await api(config, `/messages/${message_id}`);
      if (message.author === '用户' && message.text) texts.push(message.text);
    } catch { /* The host still reads the message itself. */ }
  }
  return texts;
}

/**
 * The workflows and sub-workflows the user named with "/" for the host: a sub-workflow of the workflow in use, or a
 * workflow in this computer's library other than that one. The task carries them, so the host never has to recognise
 * the syntax. Other "/" words are left to the message. Null when nothing was named.
 */
export function named_workflows(texts, { sub_workflows = [], current = '', in_library = () => false } = {}) {
  const named = { workflows: [], sub_workflows: [] };
  for (const name of new Set(texts.flatMap(slash_names))) {
    if (sub_workflows.includes(name)) named.sub_workflows.push(name);
    else if (name !== current && in_library(name)) named.workflows.push(name);
  }
  const kept = Object.fromEntries(Object.entries(named).filter(([, names]) => names.length));
  return Object.keys(kept).length ? kept : null;
}

/** Whether this computer's workflow library has a workflow with this ID. */
function library_has(config, id) {
  try { return Boolean(config.api_home) && existsSync(join(workflow_directory(config.api_home, id), 'SKILL.md')); }
  catch { return false; }
}

/**
 * Download the attachments of the messages that woke this execution into its own folder, checked against their SHA-256,
 * so the member reads local copies and software that takes images gets them with the task. A file that cannot be fetched
 * keeps an empty path and its reason; the member can still fetch it with `attachment download`.
 *
 * @returns {Promise<Array<{message_id: number, number: number, placeholder: string, file_name: string,
 *   content_type: string, size: number, id: string, path: string, error?: string}>>}
 */
export async function request_attachments(config, execution, member_directory = config.directory) {
  const message_ids = [...new Set((execution.requests || []).map(item => item.message_id).filter(Number.isInteger))];
  const result = [];
  for (const message_id of message_ids) {
    let files = [];
    try { files = (await api(config, `/attachments?message_id=${message_id}`)).attachments || []; }
    catch { continue; }
    for (const [index, file] of files.slice(0, MAX_MESSAGE_FILES).entries()) {
      const number = Number.isInteger(file.number) ? file.number : index + 1;
      const entry = { message_id, number, placeholder: attachment_placeholder(file, number), file_name: file.file_name,
        content_type: file.content_type, size: file.size, id: file.id, path: '' };
      try { entry.path = await save_attachment(config, member_directory, execution.id, message_id, entry, file.sha256); }
      catch (error) { entry.error = error.message; }
      result.push(entry);
    }
  }
  return result;
}

async function save_attachment(config, directory, execution_id, message_id, entry, sha256) {
  const response = await site_fetch(`${config.site}/api/rooms/${config.room}/attachments/${entry.id}/content`, {
    redirect: 'error', signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS), headers: { 'X-Discussion-Token': config.token } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('下载内容与 SHA-256 不符');
  const folder = join(directory, `free-${execution_id}-files`);
  mkdirSync(folder, { recursive: true });
  const safe_name = basename(entry.file_name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-120) || 'file';
  const path = join(folder, `${message_id}-${entry.number}-${safe_name}`);
  writeFileSync(path, data, { mode: 0o600 });
  return path;
}

/**
 * The room's overall task for the host, so a host taken over mid-way or one whose Goal just finished still knows what the
 * room is for (COVERAGE 3③): the owner's goal, the original request, and the owner's first message to read when neither
 * says it. Null when the room view has none of them.
 */
/** How a member's configured model and effort read in a change notice: "默认" stands for the software's own choice. */
export function model_label(profile) {
  return [profile.model || '默认', profile.effort].filter(Boolean).join(' · ');
}

export function room_goal(room) {
  if (!room) return null;
  const text = value => String(value || '').trim().slice(0, ROOM_GOAL_CHARS) || null;
  const goal = text(room.goal), request = text(room.user_request), first = room.first_user_message_id || null;
  if (!goal && !request && !first) return null;
  return { goal, user_request: request, first_user_message_id: first,
    note: '这是整个房间的任务；一次 Goal 或讨论结束不等于它完成。Goal 完成后对照这里判断还剩什么，没有目标文字时读首条用户消息。' };
}

export function free_task_files(config, member, execution, binding, { session = null, suggestions = [], reviews = [], stopped = [], process_access = true,
  workflow = null, room_members = [], goal = null, attachments = [], room = null, model_change = null, request_texts = [] } = {}) {
  const id = `free-${execution.id}`;
  const draft_directory = member_drafts(config, member.name);
  mkdirSync(draft_directory, { recursive: true });
  const member_directory = member_runtime(config, member.name);
  const access_path = join(member_directory, `${id}.access.json`);
  const task_path = join(member_directory, `${id}.task.json`);
  // A workflow member's prompt is read from its card for this execution; everything else stays the room's setting.
  const profile = effective_profile(config.participants[member.name], member.name, workflow);
  // The host sees the workflow only while its members are here: sending them away ends it.
  const host_workflow = member.role === 'host' && workflow && !workflow.error && workflow_in_use(workflow, room_members) ? workflow : null;
  atomic_json(access_path, { ...entry_access(), site: config.site, room: config.room, member: member.name, token: config.members[member.name].token,
    session_id: binding.session_id || '', execution_id: execution.id });
  const adapter = adapter_of(profile.adapter);
  const extra_directories = member_extra_directories(config, profile);
  // The expert this member plays keeps its own knowledge, which only it may write (its project access stays as set).
  const knowledge_directory = member_knowledge(config.api_home, member.name, workflow);
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
    access_file: bound_access ? '' : access_path, read_rule: read_rule(profile.adapter), inbox, extra_directories, attachments, requests, workflow: Boolean(host_workflow),
    knowledge: Boolean(knowledge_directory) });
  // Software that declares it takes images gets them with the prompt, like a screenshot pasted into its own window.
  const images = takes_images(profile) && !inbox
    ? attachments.filter(item => item.path && IMAGE_TYPES.has(item.content_type)).map(item => ({ path: item.path, content_type: item.content_type, size: item.size }))
    : [];
  const skills = discussion_request || direct_question
    ? ['discuss-participant/SKILL.md', 'discuss-session/SKILL.md',
      ...member.role === 'host' ? ['discuss-host/SKILL.md', 'discuss-session/references/host.md'] : [],
      ...direct_question ? ['discuss-participant/references/room.md'] : []]
    : ['discuss-participant/SKILL.md', 'discuss-participant/references/room.md',
      ...member.role === 'host' ? ['discuss-host/SKILL.md', 'discuss-host/references/room.md', 'discuss-host/references/members.md'] : []];
  // The host works a goal while it is open, and also handles the request that opens it or the wrap-up after it ends.
  const goal_task = member.role === 'host' && (['active', 'paused'].includes(goal?.status)
    || requests.some(item => ['goal_start', 'goal_continue'].includes(item.purpose)));
  if (goal_task) {
    skills.push('discuss-goal/SKILL.md');
    // Opening a goal and ending one happen once each: their pages come only with the request or status that calls for them.
    if (requests.some(item => item.purpose === 'goal_start')) skills.push('discuss-goal/references/start.md');
    if (['budget_limited', 'paused'].includes(goal?.status)) skills.push('discuss-goal/references/finish.md');
  }
  // A discussion host's occasional pages follow what woke it (`cause_kind`): the opening, a changed roster or a failed
  // request, and the wrap-up once a round is complete or a limit is reached.
  if (member.role === 'host' && discussion_request?.purpose === 'discuss_host') {
    const cause = discussion_request.cause_kind;
    if (cause === 'session_started') skills.push('discuss-session/references/host-opening.md');
    if (['member_change', 'request_failed'].includes(cause)) skills.push('discuss-session/references/host-roster.md');
    if (cause === 'round_complete' || room?.limits?.reached) skills.push('discuss-session/references/host-closing.md');
  }
  const goal_of_room = member.role === 'host' ? room_goal(room) : null;
  const goal_field = goal_task && goal ? { id: goal.id, objective: goal.objective, status: goal.status, continues: goal.continues,
    max_continues: goal.max_continues, elapsed_seconds: goal.elapsed_seconds, max_minutes: goal.max_minutes,
    phase: goal.phase ?? 'doing', ...(goal.phase_note ? { phase_note: goal.phase_note } : {}),
    // Handed over with the host seat: a goal its former host's spent quota paused waits for a resume, not a new start.
    ...(goal.status === 'paused' && goal.quota_paused_by ? { pause_note: `Goal #${goal.id} 因前任主持人 ${goal.quota_paused_by} 额度用尽而暂停；有主持人完整权限时可用 host-control goal --do resume 恢复，否则请用户恢复` } : {}) } : null;
  const skills_directory = join(config.project, '.agents', 'skills');
  const workflow_field = host_workflow ? workflow_task_field(host_workflow, room_members, config.participants) : null;
  const image = config.image_generation && image_settings(config.api_home).configured ? image_settings(config.api_home) : null;
  // Relay, question and image rules are read only when the task carries them, keeping the everyday path short.
  if (image || requests.some(item => item.sequence || item.question || item.question_needed)) skills.push('discuss-participant/references/situations.md');
  const named = member.role === 'host' ? named_workflows(request_texts, { sub_workflows: host_workflow?.sub_workflows.map(sub => sub.id) || [],
    current: host_workflow?.id || '', in_library: id => library_has(config, id) }) : null;
  // The host's occasional pages likewise: relays and question cards, room control on a notice, the workflow (also when
  // the user named one to enable), pre-set reviews.
  if (member.role === 'host') {
    if (requests.some(item => item.sequence || item.question?.task || item.question_needed)) skills.push('discuss-host/references/relay.md');
    // A notice, or a hand-back where someone failed or was cancelled, is what calls for diagnosing and recovering.
    if (requests.some(item => item.purpose === 'notice' || (item.outcome || []).some(entry => ['failed', 'cancelled'].includes(entry.status)))) {
      skills.push('discuss-host/references/control.md');
    }
    if (workflow_field || named?.workflows) skills.push('discuss-host/references/workflow.md');
    if (reviews.length) skills.push('discuss-host/references/dev-flow.md');
  }
  atomic_json(task_path, { site: config.site, room: config.room, mode: 'free', member: member.name,
    execution_id: execution.id, requests, request_messages: execution.requests.map(item => item.message_id),
    ...(attachments.length ? { attachments } : {}),
    request_purposes: execution.requests.map(item => item.purpose || 'ask'),
    ...(discussion_request ? { discussion_request } : {}),
    ...(session ? { session: { id: session.id, status: session.status, phase: session.phase,
      goal: session.goal, named_followup: session.named_followup } } : {}),
    ...(suggestions.length ? { scheduler_suggestions: suggestions } : {}),
    ...(reviews.length ? { review_handoffs: reviews } : {}),
    ...(goal_field ? { goal: goal_field } : {}),
    ...(goal_of_room ? { room_goal: goal_of_room } : {}),
    ...(model_change ? { model_change: { ...model_change, note: `你的模型已从 ${model_change.from} 换为 ${model_change.to}；不要按之前的自述判断自己用的是哪个模型。` } } : {}),
    // What became of the @s in this member's previous answer: quoted, waiting, queued for the host or picked up.
    ...(execution.mentions?.length ? { mentions: execution.mentions } : {}),
    // The host's view of lines the owner opened by naming members directly: who works on which message, so it keeps clear of them.
    ...(execution.branches?.length ? { branches: execution.branches } : {}),
    ...(named ? { named_workflows: named } : {}),
    ...(stopped.length ? { stopped_executions: stopped } : {}),
    role: member.role || 'member',
    // Only where the adapter declares capture: without it, only a submitted answer is saved, as the skill already says.
    ...(adapter?.capabilities.capture ? { answer_capture: '正常结束且本次没有提交时，你最后一段文字收为本次回答（标自动收录，不派活）；已提交或被拒则不收录' } : {}),
    read_after: execution.read_until, cwd: profile.cwd || null, project_access: profile.project_access, draft_directory,
    ...(knowledge_directory ? { knowledge_directory } : {}),
    ...(extra_directories.length ? { extra_directories } : {}),
    skills: skills.map(file => join(config.project, '.agents/skills', file)),
    // The workflow's SKILL.md is not a skill read on every task: the host opens it when a request fits its description.
    ...(workflow_field ? { workflow: { ...workflow_field, skill_path: host_workflow.skill_path } } : {}),
    ...(member.role === 'host' && config.host_workflows ? { host_workflows: true, host_permissions: host_permissions(config).items } : {}),
    // Present only while the owner has drawing on and this computer has an image service.
    ...(image ? { image: { model: image.model, command: `${cli} launch image --file REQUEST.json` } } : {}),
    cli, subcommands: TASK_SUBCOMMANDS,
    ...(bound_access ? { access_env: 'DISCUSS_ACCESS_FILE' } : { access_file: access_path }), instructions });
  return { id, participant: member.name, directory: config.directory, member_directory, task_path, draft_directory, extra_directories,
    ...(knowledge_directory ? { knowledge_directory } : {}), ...(goal_field ? { goal: goal_field } : {}),
    ...(goal_of_room ? { room_goal: goal_of_room } : {}),
    // Every member may read the folder of the room's workflow (templates, tools, a review of the workflow itself), also
    // while its members are away and the host no longer follows it; only the host's task names it.
    skill_directories: [skills_directory, ...(workflow && !workflow.error ? [workflow.directory] : [])], access_path, prompt: with_expert_prompt(prompt, profile), inbox, images,
    profile, ...(workflow_field ? { workflow: { ...workflow_field, skill: host_workflow.skill, ...api_sub_workflows(workflow_field, host_workflow) } } : {}) };
}

/** An API host cannot open files outside the project, so its sub-workflows carry their text instead of a path. */
function api_sub_workflows(field, workflow) {
  if (!field.sub_workflows) return {};
  return { sub_workflows: field.sub_workflows.map(({ skill_path: ignored, ...sub }) => ({ ...sub,
    skill: workflow.sub_workflows.find(item => item.id === sub.id)?.skill || '' })) };
}

/**
 * The prompt that resumes an execution the owner paused from the private chat: the same task goes on in the same
 * session, steered by what the owner added. The task file and credentials are written again as at its first delivery.
 */
export function resume_prompt(execution_id, texts) {
  return `你正在做的这次房间任务（执行 #${execution_id}，仍在进行，没有结束）被暂停，插入了下面的话（每条开头注明是用户还是主持人说的）。`
    + `按补充调整后接着完成原任务，已经做完的部分不必重做；完成后照常用 codiscuss 提交这次执行的回答。\n\n${texts.join('\n\n')}`;
}

/**
 * What a member hears of one interjection: who said it, then the words. The host's (sent through host-control) is
 * marked as the host's, so the member does not take it for the owner's; adapters pass the text on unchanged.
 */
export function interjection_text(item) {
  return item.author ? `主持人 ${item.author} 插话：${item.text}` : `用户插话：${item.text}`;
}

// The fixed opening of a private chat turn: where the words come from and how to answer them; the owner's text follows.
const CHAT_PREAMBLE = '房主在私聊窗口直接对你说（不在房间消息流里，其他成员看不到）。像在终端里对话一样直接用文字回答，不要用 codiscuss 提交到房间，除非房主明确要求；可以照常按你的权限读写项目文件。';

/**
 * Write the member-only credential file for one private chat turn and describe it as a task: the member's own session,
 * profile and directories, with the owner's words as the prompt. No task file: the prompt is all the turn needs.
 */
export function chat_task_files(config, member, chat, binding) {
  const id = `chat-${chat.id}`;
  const draft_directory = member_drafts(config, member.name);
  mkdirSync(draft_directory, { recursive: true });
  const member_directory = member_runtime(config, member.name);
  const access_path = join(member_directory, `${id}.access.json`);
  const profile = effective_profile(config.participants[member.name], member.name, null);
  atomic_json(access_path, { ...entry_access(), site: config.site, room: config.room, member: member.name, token: config.members[member.name].token,
    session_id: binding.session_id || '' });
  return { id, participant: member.name, directory: config.directory, member_directory, draft_directory, extra_directories: member_extra_directories(config, profile),
    skill_directories: [join(config.project, '.agents', 'skills')], access_path, prompt: `${CHAT_PREAMBLE}\n\n${chat.text}`, inbox: false, profile };
}

/**
 * Write the credential a manual member taken over by this service uses for proactive messages from its own window,
 * where no task has handed it one yet: no execution, so the room applies its proactive rules (`message post
 * --proactive`). It sits beside the member's task credentials; `runner/discuss.py` finds it by name for the error
 * that refuses the member's old manual credential. Returns its path.
 */
export function write_proactive_access(config, name, token, session_id) {
  const path = join(member_runtime(config, name), PROACTIVE_ACCESS_FILE);
  atomic_json(path, { ...entry_access(), site: config.site, room: config.room, member: name, token, session_id: session_id || '' });
  return path;
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
    // Set by the service of a hosted account's instance: told of every execution this runner judged failed.
    this.on_failed = null;
    // Routed requests whose decision is still pending: their host waits, so one pick replaces the host's start.
    this.routing = new Set();
    this.children = new Set();
    // Per live execution, how to pass an interjection to its running software; and interjections already handed over.
    this.steers = new Map();
    this.interjecting = new Map();
    // Queued requests already pointed out to the member running beside them (queued_notice), by request id.
    this.queued_noticed = new Set();
    // Per member, the private chat turn running in its session.
    this.chat_turns = new Map();
    this.members = new Map();
    // An empty set proves every tracked handle for this execution closed; a missing set proves nothing after restart.
    this.execution_processes = new Map();
    // Marks the handles this runner process tracks (`owner:ID` in metadata), so a later runner can tell inherited executions.
    this.instance = randomUUID();
    // Execution id -> why its session ended on its own, such as a command refused in unattended mode ('' when unknown).
    this.exited = new Map();
    // Execution id -> the software's last full remark once it began working: its reply, kept for an execution that ends unsubmitted.
    this.replies = new Map();
    // Executions whose software reported refused operations; their last remark is not captured.
    this.denied = new Set();
    // Execution id -> its last turn's refusals the member can correct (`correctable_refusals`), and per execution how
    // often it was resumed with them and every such refusal so far; past MAX_REFUSAL_RETRIES it fails as before.
    this.refusal_hints = new Map();
    this.refusal_retries = new Map();
    // Per execution, which delivery is current: a turn stopped by a pause may report its exit after the resumed one began.
    this.generations = new Map();
    // Executions whose software failed before any turn ran, as its adapter reported; safe to deliver again.
    this.not_started = new Set();
    // Executions whose software failed in a way a retry meets again (a used-up limit, a lost login), as its adapter reported.
    this.not_retryable = new Set();
    // Executions whose turn an adapter that cannot stop it saw end (`on_turn_end`); only a voided one's stop report reads it.
    this.turn_ended = new Set();
    this.failure_classes = new Map();
    this.snapshots = new Map();
    // Execution id -> { phase, at, sent_phase, sent_at }: what the member's software last showed it doing.
    this.activity = new Map();
    this.diagnostics = new Map();
    // Execution id -> until when its completed software may still record its receipt (0: stop it now), see `closing`.
    this.closed_at = new Map();
    this.segments = new SegmentLog();
    // Execution id -> the execution its software turn moved onto when its host dispatched with keep_working.
    this.continued = new Map();
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
   * Drop what this machine kept under a member name (its session binding, context and delivery record), for a new
   * member that took over the name of a removed one: the old conversation must neither be resumed nor block it.
   */
  forget_member(name) {
    this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`member-context:${name}`);
    this.store.db.prepare('DELETE FROM bindings WHERE participant=?').run(name);
    this.store.db.prepare('DELETE FROM free_deliveries WHERE member=?').run(name);
    this.context_errors.delete(name);
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
      if ((error.status || Number(/^HTTP (\d{3})\b/.exec(error.message)?.[1])) === 404) cleanup_room(this.config.directory);
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
    if (!inbox.archived) await this.notify_questions(room);
    if (!inbox.archived) await this.continue_goal(room);
    this.inbox = inbox;
    const active = new Map(inbox.executions.map(item => [item.id, item]));
    // Before anything treats the answered execution as ended (and stops its software), move a turn its host kept working in.
    for (const next of inbox.executions) {
      const row = next.continues ? this.row(next.member) : null;
      if (row && row.execution_id === next.continues && LIVE.includes(row.status)) await this.carry_on(next.member, next.continues, next.id);
    }
    const present = new Set(inbox.members.map(member => member.name));
    // A member sent away or removed no longer appears; its live work was already voided on the website.
    for (const row of this.store.db.prepare('SELECT * FROM free_deliveries').all()) {
      if (LIVE.includes(row.status) && !present.has(row.member)) { this.stop_member(row.member); this.save(row.member, { status: 'idle' }); }
    }
    await this.report_finished(active);
    this.sweep_attachments();
    await this.deliver_interjections(inbox.executions);
    await this.notice_queued(inbox);
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
  /**
   * Tell the site what each member can do, as its adapter says: what a rewind does to its session, so the host and every
   * reader of the room see it. Only a change is sent.
   */
  async sync_member_capabilities(inbox) {
    for (const member of inbox.members) {
      const profile = this.config.participants[member.name];
      // An older site lists no effect and takes no report.
      if (member.rewind === undefined || !profile) continue;
      const rewind = capabilities_of(profile.adapter).rewind;
      // Members no longer draw with an image model of their own (drawing is the room's switch); an old report is cleared.
      const report = { rewind, ...(member.image_model ? { image_model: '' } : {}) };
      if (member.rewind === rewind && report.image_model === undefined) continue;
      try { await api(this.config, `/members/${member.id}/capabilities`, report); Object.assign(member, report); }
      catch (error) { this.log(`成员能力未同步：${member.name}：${error.message}`); }
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
            model_judgment: false, reason: room_text("没有模型判断：{value1}", { value1: error.message }) });
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
      model_judgment: Boolean(decision.detail), reason: room_text("自动评审交接结果尚未核验") });
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
      } catch (error) { outcome = { applied: false, actual_action: 'host', reason: room_text("未自动开始下一圈：{value1}", { value1: error.message }) }; }
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
    if (job.profiles !== JSON.stringify(this.config.participants)) return { applied: false, actual_action: 'host', reason: room_text("本机成员配置已变化，未自动交评审") };
    try {
      await api({ ...this.config, token: this.config.members[host.name].token }, '/reviews/advance', {
        actor: host.name, batch_id: request.review.batch_id, revision: job.revision, submission_id: job.submission_id,
      });
      return { applied: true, actual_action: 'review' };
    } catch (error) {
      try {
        const state = await api(this.config, `/reviews/${request.review.batch_id}/ready`);
        if (state.plan.advance_submission === job.submission_id) return { applied: true, actual_action: 'review' };
        return { applied: false, actual_action: 'host', reason: room_text("未自动交评审：{value1}", { value1: error.message }) };
      } catch { return { applied: false, actual_action: 'unverified', reason: room_text("评审交接写入结果未核验：{value1}", { value1: error.message }) }; }
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
    // A blocking question waiting on the owner needs ticks too, so its Weixin notice goes out on time.
    if (this.notifier?.ready() && this.question_notices(this.room).some(item => !this.notifier.sent(item.key))) return false;
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
      { prompt: GOAL_PROMPT_VERSION, threshold: GOAL_CONFIDENCE, wide_threshold: GOAL_CONFIDENCE, scene: 'goal' });
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
      // Weixin folds single line breaks, so each part is its own paragraph.
      const question = notice.goal.phase_note ? ['主持人在等你确认：', notice.goal.phase_note] : await this.latest_excerpt(room);
      const paragraphs = [...question, `目标：${notice.goal.objective}`, '直接回复这条消息，会作为你的发言发回这个房间。'];
      const result = await this.notifier.send({ key: notice.key, room: { site: this.config.site, room: this.config.room, title: room.title }, paragraphs });
      if (result.status === 'sent') this.log(`Goal 待确认已发微信通知 #${result.number}`);
    } catch (error) {
      this.notice_failed_at = Date.now();
      this.log(`Goal 待确认微信通知失败：${error.message}`);
    }
  }
  /**
   * The Weixin notices blocking questions call for: one per question and version that waits on the owner (a host's
   * recommendation makes a new version, which is told again), due once it has waited `PENDING_NOTICE_MS`.
   */
  question_notices(room) {
    if (!this.notifier) return [];
    return (room?.free?.questions || []).filter(question => question.blocking && question.status === 'waiting_user')
      .map(question => ({ key: `${this.config.site}/${this.config.room}/question-${question.id}-v${question.version}`,
        due: question.waiting_since * 1000 + PENDING_NOTICE_MS, question }));
  }
  /** Tell the owner on Weixin about a blocking question left waiting; a reply of its option numbers answers it. */
  async notify_questions(room) {
    if (Date.now() - (this.notice_failed_at ?? 0) < NOTICE_RETRY_MS || !this.notifier?.ready()) return;
    const labels = Object.fromEntries((room.members || room.free?.members || []).map(member => [member.name, member.label || member.name]));
    for (const notice of this.question_notices(room)) {
      if (Date.now() < notice.due || this.notifier.sent(notice.key)) continue;
      const { question } = notice;
      try {
        const result = await this.notifier.send({ key: notice.key, room: { site: this.config.site, room: this.config.room, title: room.title },
          question: { id: question.id, version: question.version }, paragraphs: question_notice(question, labels[question.asker] || question.asker) });
        if (result.status === 'sent') this.log(`问题 #${question.id} 第 ${question.version} 版已发微信通知 #${result.number}`);
      } catch (error) {
        this.notice_failed_at = Date.now();
        this.log(`问题 #${question.id} 微信通知失败：${error.message}`);
        return;
      }
    }
  }
  /** The room's latest message from a person or member, for a pending goal nobody wrote a note for. */
  async latest_excerpt(room) {
    const page = await api(this.config, `/messages?after=${Math.max(0, (room.latest_id || 0) - 5)}`);
    const latest = (page.messages || []).filter(message => message.author !== '系统').at(-1);
    if (!latest) return ['房间在等你的决定或补充信息，详情见房间。'];
    const text = latest.text.length > NOTICE_EXCERPT ? `${latest.text.slice(0, NOTICE_EXCERPT)}…` : latest.text;
    return [`房间在等你回复。最近一条是 ${latest.author} 说：`, text];
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
        .catch(async error => {
          if (!this.saved_suggestion(request.id)) {
            const reason = room_text("没有模型判断：{value1}", { value1: error.message.slice(0, 180) });
            const record = await this.record_decision(request.message_id, {}, reason, false, { model_judgment: false });
            this.save_suggestion(request, { action: 'host', actual_action: 'host', applied: false,
              model_judgment: false, ...(record?.id ? { decision_id: record.id } : {}), reason });
          }
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
      model_judgment: true, reason: room_text("判断已产生，自动动作结果尚未核验") });
    this.log(`智能调度 #${message.id}：${decision.action}${decision.member ? ` ${decision.member}` : ''}（选择 ${decision.choice ?? '-'}，置信度 ${decision.confidence ?? '-'}）`);
    if (decision.action === 'host') return this.record_route(request, decision, route_host_label(decision, host.name, members), false);
    if (decision.action !== 'member') {
      // Everyone, the named few or no one replaces the host's request in one step; a host that already started keeps the message.
      const applied = await api(this.config, `/recommendations/${message.id}`, { action: decision.action, ...(decision.members ? { members: decision.members } : {}) })
        .then(() => true, error => { this.log(`智能调度 #${message.id} 未能改派：${error.message}`); return false; });
      const names = described.map(member => member.name).join('、');
      const label = decision.action === 'all' ? room_text('请全体各自回应（{names}）', { names }) : decision.action === 'sequential' ? room_text('请全体按发言顺序依次回应') : decision.action === 'some' ? room_text('请 {names} 各自回应', { names: decision.members.join('、') }) : room_text('无需回应，未唤醒任何成员');
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
    try {
      return await api(this.config, '/scheduler-decisions', { kind: 'interjection', label, confidence: decision.confidence ?? null,
        applied, provider: this.config.scheduler.provider, after_message_id: message_id, detail: decision.detail, input: decision.input,
        context: { model: this.config.scheduler.model, threshold: ROUTE_CONFIDENCE, wide_threshold: ROUTE_WIDE_CONFIDENCE,
          mode: SCHEDULER_MODE, prompt: ROUTE_GUIDED_PROMPT_VERSION, package: PACKAGE_VERSION, ...context } });
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
  async invoke(member, execution, { resume = '', network_binding = '' } = {}) {
    const adapter = this.config.participants[member.name];
    const review_request = execution.requests?.find(request => request.review?.phase === 'review');
    if (review_request) {
      try { await this.check_review_delivery(member, review_request); }
      catch (error) { return this.reject_review(member, execution, error.message); }
    }
    if (!adapter) return this.fail(member.name, execution.id, room_text("未配置 {value1} 的本机接入", { value1: member.name }));
    if (this.context_errors.has(member.name)) return this.fail(member.name, execution.id, this.context_errors.get(member.name));
    const directory = capabilities_of(adapter.adapter).project ? adapter.cwd ?? this.config.cwd : undefined;
    // A read-only member's software cannot write the project, so files changing meanwhile were written by someone else.
    const before = adapter.project_access === 'read' ? null : workspace_snapshot(directory);
    // The room's other directories this member may write are watched as well; their changes are reported with full paths.
    const extras = member_extra_directories(this.config, adapter).filter(item => item.access === 'write')
      .map(item => ({ directory: item.path, before: workspace_snapshot(item.path) })).filter(item => item.before);
    // A resumed execution keeps the snapshot of its first delivery, so changes made before the pause are reported too.
    // One with nothing to watch (read-only, no git) is still tracked, so its end reports an empty list and the page stops
    // waiting for one (user 2026-11-20, #5956).
    if (!this.snapshots.has(execution.id)) {
      // The text of files already changed, so the card's line counts cover only what this execution did to them.
      this.snapshots.set(execution.id, { member: member.name, directory, before, extras, base: capture_base(directory, before) });
    }
    const generation = (this.generations.get(execution.id) || 0) + 1;
    this.generations.set(execution.id, generation);
    // The turn's events follow it when a keep_working dispatch moves it onto a new execution.
    const live = () => this.live_id(execution.id);
    const current = () => this.generations.get(live()) === generation;
    const binding = this.store.binding(member.name);
    let invoked = false;
    // Remarks before the software shows any work (an adapter's own "not started yet") are never its reply.
    let worked = false;
    try {
      // A member whose session a rewind restarted is bound to '' and must not fall back to the session it was invited with.
      await this.bind_invited(member.name, adapter, binding);
      // A resumed execution's session was already cut at its first delivery.
      const warning = resume ? '' : await this.cut_rewound(member.name, adapter, binding, execution);
      const session_request = execution.requests?.find(item => item.session_request_id && ['discuss', 'discuss_host'].includes(item.purpose));
      // The room view keeps the discussion's phase beside its session; the task carries both together, and an ended
      // discussion not at all, so a member is not steered by a session that no longer runs (F5).
      const session = ['active', 'paused'].includes(this.room?.session?.status) ? { ...this.room.session, phase: this.room.phase } : null;
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
      const attachments = await request_attachments(this.config, execution, member_runtime(this.config, member.name));
      const request_texts = member.role === 'host' ? await user_request_texts(this.config, execution) : [];
      const model_change = this.model_change(member.name);
      const task = free_task_files(this.config, member, execution, binding, {
        session, suggestions: scheduler_suggestions, reviews: review_handoffs, stopped, workflow, room_members: this.room?.members,
        goal: this.room?.goal_state?.goal || null, attachments, room: this.room, model_change, request_texts,
      });
      this.store.db.prepare('DELETE FROM metadata WHERE key IN (?,?)').run(`recovery:${execution.id}`, `recovery-denied:${execution.id}`);
      invoked = true;
      this.segments.start(execution.id);
      this.record_diagnostics(execution.id, { workflow: workflow_execution_binding(workflow, member, Boolean(task.workflow)) });
      if (warning) this.note(execution.id, warning);
      const result = await this.deliver(review_request ? structuredClone(task.profile) : task.profile, binding, { ...task, ...(resume ? { prompt: resume, images: [] } : {}), room_title: this.room_title,
        ...(review_request || network_binding ? { before_model_start: async () => {
          if (review_request) await this.check_review_delivery(member, review_request);
          if (network_binding) {
            const latest = await api(this.config, `/executions/${execution.id}`);
            if (!['dispatched', 'started'].includes(latest.status) || latest.retry?.stopped) throw new Error(room_text("送达前本次执行已结束"));
          }
        } } : {}),
        api_context: { site: this.config.site, room: this.config.room, token: this.config.members[member.name].token,
          home: this.config.api_home, mode: 'free', role: member.role || 'member', execution_id: execution.id,
          // An API member reads its knowledge through the file tools; writing it waits for per-directory write access.
          cwd: directory, project_access: adapter.project_access,
          extra_directories: [...(task.extra_directories || []), ...(task.knowledge_directory ? [{ path: task.knowledge_directory, access: 'read' }] : [])],
          requests: execution.requests, read_after: execution.read_until, session, discussion_request: session_request,
          ...(attachments.length ? { attachments: attachments.map(({ path, error, ...item }) => item) } : {}),
          scheduler_suggestions, review_handoffs, ...(task.workflow ? { workflow: task.workflow } : {}),
          // Commands the enabled workflow registers; software with its own command line ignores them.
          ...(workflow?.commands?.length ? { commands: { directory: workflow.directory, list: workflow.commands } } : {}),
          ...(Number.isInteger(this.config.api_max_requests) ? { max_requests: this.config.api_max_requests } : {}),
          ...(this.config.image_generation ? { image_generation: true } : {}),
          ...(task.goal ? { goal: task.goal } : {}), ...(task.room_goal ? { room_goal: task.room_goal } : {}) },
        on_recovery: record => {
          if (current()) this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)')
            .run(`recovery:${live()}`, JSON.stringify({ adapter: task.profile.adapter, record }));
        },
        on_binding: session => this.store.bind(member.name, session),
        on_process: child => this.track(member.name, child, live()),
        on_output: (path, chunk) => { appendFileSync(path, chunk, { mode: 0o600 }); this.touch(live()); this.segments.mark(live()); },
        on_activity: (phase, tool, call, { synthetic = false } = {}) => {
          if (!current()) return;
          worked = true;
          this.touch(live(), phase);
          this.segments.mark(live(), phase, tool, call);
          if (!synthetic && phase !== 'waiting') this.record_diagnostics(live(), { last_activity_at: Date.now() });
        },
        on_diagnostic: facts => {
          if (facts.interjection_confirmed) return this.confirm_interjection(facts.interjection_confirmed);
          if (current()) this.record_diagnostics(live(), facts);
        },
        on_note: text => {
          this.note(live(), text);
          if (worked && current()) this.replies.set(live(), text);
        },
        // Files the agent edited with its own tools, read from its events; an empty call says the list is tracked.
        on_edits: paths => {
          const snapshot = this.snapshots.get(live());
          if (snapshot) paths.forEach(path => (snapshot.edited ||= new Set()).add(path));
          if (snapshot && !paths.length) snapshot.edited ||= new Set();
        },
        // A stopped process may report after the next execution started; only its own execution takes the result.
        on_failure: (error, { not_started = false, retryable = true, failure_class = '', resets = '', reset_at = 0, resume_session = '' } = {}) => {
          if (!current()) return;
          if (not_started) this.not_started.add(live());
          if (!retryable) this.not_retryable.add(live());
          // The adapter's classification goes to the site with the failure: `quota` holds the member until it resets,
          // `auth` asks for signing in again, `output_truncated` states where the model's reply was cut.
          if (FAILURE_CLASSES.includes(failure_class)) this.failure_classes.set(live(), { failure_class, ...(resets ? { resets: String(resets) } : {}),
            ...(Number.isSafeInteger(reset_at) && reset_at > 0 ? { reset_at } : {}) });
          try {
            if (this.row(member.name)?.execution_id !== live()) return;
            const retry_binding = resume_session ? `network:${adapter.adapter}:${resume_session}` : not_started && network_binding;
            if (retry_binding) this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`retry-reason:${live()}`, retry_binding);
            this.save(member.name, { error });
          } catch { /* Store may already be closed at shutdown. */ }
        },
        // The turn was seen to end in a window or App the runner cannot stop; unlike on_exit it says nothing about an answer.
        on_turn_end: () => { if (current()) this.turn_ended.add(live()); },
        on_exit: denial => {
          if (!current()) return;
          this.exited.set(live(), denial || '');
          if (denial) this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`recovery-denied:${live()}`, '1');
        },
        // Shown beside the answer or failure so the owner can allow them; a lost report only hides the list.
        on_denials: denials => {
          // A refused operation means the turn may be unfinished: its last remark is never captured as the answer.
          if (denials?.length && current()) {
            this.denied.add(live());
            this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`recovery-denied:${live()}`, '1');
            // What the adapter says the member can correct itself; the turn's end resumes it with these.
            const refusals = correctable_refusals(denials);
            if (refusals.length) this.refusal_hints.set(live(), refusals);
          }
          api(this.config, `/executions/${live()}`, { action: 'denials', denials }).catch(() => {});
        },
      });
      if (result.session_id) this.store.bind(member.name, result.session_id);
      this.clear_stopped(member.name);
      this.save(member.name, { status: result.status === 'sidecar_pending' ? 'sidecar_pending' : 'running', attempts: 0 });
      if (result.steer) this.steers.set(execution.id, result.steer);
      const delivery = result.capabilities || capabilities_of(adapter.adapter).delivery;
      await this.report_delivery(execution.id, { ...delivery, steer: Boolean(result.steer),
        resume: Boolean(capabilities_of(adapter.adapter).resume && delivery.stoppable) }, member.name);
      // A task posted into the member's own open window runs with that window's model, so the card's choice is not applied;
      // a started process is, and the card's "applies next time" mark ends here.
      if (!task.inbox) {
        this.report_model(execution.id, chosen_settings(task.profile));
        this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`settings-applied:${member.name}`, String(Date.now()));
      }
    } catch (error) {
      if (review_request && error.delivery_status === 'not_sent') return this.reject_review(member, execution, error.message);
      if (network_binding) return this.fail(member.name, execution.id, room_text("投递失败：{value1}", { value1: error.message }));
      if (adapter.project_access === 'own') return this.retry_or_fail(member.name, execution, `投递失败：${error.message}`);
      const attempts = (this.row(member.name)?.attempts || 0) + 1;
      if ((invoked && error.delivery_status !== 'not_sent') || attempts >= MAX_DELIVERY_ATTEMPTS) {
        return this.fail(member.name, execution.id, room_text("投递失败：{value1}", { value1: error.message }));
      }
      await api(this.config, `/executions/${execution.id}`, { action: 'release', reason: room_text("确认未送达：{value1}", { value1: error.message }) });
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
      } catch (error) { reviews.push({ batch_id, request_id: request.id, ready: false, reason: room_text("无法读取评审推进状态：{value1}", { value1: error.message }) }); }
    }
    return reviews;
  }
  /**
   * Before a member works again after a rewind, branch its session before the executions the rewind took back.
   * A Claude fork happens on its next turn, so it stays pending until that session exists. Returns a warning when the
   * session could not be cut and the member continues in the old one.
   */
  async cut_rewound(name, adapter, binding, execution) {
    if (this.pending_fork(name, adapter, binding)) return '';
    if (!binding.session_id || !execution.rewound_executions?.length || !BRANCHABLE_ADAPTERS.includes(adapter.adapter)) return '';
    try {
      const cut = await branch_session(adapter, binding.session_id, execution.rewound_executions);
      if (!cut) return '';
      this.rebind(name, binding, cut);
      return '';
    } catch (error) { return `会话未能回退（${error.message}），本次沿用原会话，它可能仍记得已回退的内容`; }
  }
  /** Ask a fork that has not happened yet (a Claude fork happens on its next turn) again; true while it is pending. */
  pending_fork(name, adapter, binding) {
    const key = `session-fork:${name}`;
    const pending = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    if (pending && !session_exists(adapter.adapter, binding.session_id)) { binding.fork = JSON.parse(pending); return true; }
    if (pending) this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(key);
    return false;
  }
  /** Bind a member to a branch of its session, keeping a fork its software makes on the next turn pending. */
  rebind(name, binding, branch) {
    if (branch.fork) this.store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`session-fork:${name}`, JSON.stringify(branch.fork));
    this.store.bind(name, branch.session_id);
    Object.assign(binding, branch);
  }
  /**
   * A member not yet bound starts in the conversation it was invited with. Where the adapter declares `copy_bound`, its
   * first turn works in a copy of that conversation instead, so the original, possibly still open in a window, is never
   * written; a taken-over manual member (`own`) keeps its original.
   */
  async bind_invited(name, adapter, binding) {
    if (binding.session_id !== undefined || !adapter.session_id) return;
    if (adapter.project_access === 'own' || !adapter_of(adapter.adapter)?.copy_bound) { binding.session_id = adapter.session_id; return; }
    try { this.rebind(name, binding, await branch_session(adapter, adapter.session_id, [], { always: true })); }
    catch (error) { throw Object.assign(new Error(`未能复制历史会话：${error.message}`), { delivery_status: 'not_sent' }); }
  }
  /**
   * After an execution completed normally, its software may run on for the close window its adapter declares, so the
   * receipt of the answer it just submitted is recorded in its own session before it is stopped (spec #3262 item 8:
   * Codex CLI was stopped about 0.1 s before recording one, 必 5a). Any other end (stopped, failed, withdrawn) stops it at
   * once, and so does an adapter that declares no window. True while the window is open; the member stays busy meanwhile.
   */
  async closing(member, row) {
    if (!this.members.get(member.name)?.size) { this.closed_at.delete(row.execution_id); return false; }
    if (!this.closed_at.has(row.execution_id)) {
      const grace = capabilities_of(this.config.participants[member.name]?.adapter).close_grace_ms || 0;
      const ended = grace ? await api(this.config, `/executions/${row.execution_id}`).catch(() => null) : null;
      this.closed_at.set(row.execution_id, ended?.status === 'completed' ? Date.now() + grace : 0);
    }
    if (Date.now() < this.closed_at.get(row.execution_id)) return true;
    this.closed_at.delete(row.execution_id);
    return false;
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
      if (await this.closing(member, row)) return;
      this.forget_owner(row.execution_id);
      this.activity.delete(row.execution_id);
      await this.report_segments(row.execution_id, true);
      this.stop_member(member.name);
      return this.save(member.name, { status: 'idle', error: '' });
    }
    if (row.status === 'retry_wait') {
      const reason_code = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`retry-reason:${execution.id}`)?.value;
      if (reason_code === RESTART_REASON_CODE) return this.recover_orphan(member, row, execution);
      const retry = execution.retry;
      if (retry?.stopped) return this.fail(member.name, execution.id, room_text("{value1}（已停止自动重试）", { value1: retry.reason }));
      // retry_at is already zero if the site received retry_start but its response was lost.
      // The local retry_wait row proves this runner has not begun the next delivery.
      if (!execution.paused_at && retry && Date.now() >= retry.retry_at * 1000) {
        const network_binding = reason_code?.startsWith('network:') ? reason_code : '';
        const latest = await api(this.config, `/executions/${execution.id}`, { action: 'retry_start',
          diagnostics: { retry: { layer: 'runner', state: 'started', attempt: retry.attempt, mode: network_binding ? 'resume' : 'redeliver' } } });
        if (latest.retry?.stopped) return this.fail(member.name, execution.id, room_text("{value1}（已停止自动重试）", { value1: retry.reason }));
        if (network_binding && network_binding !== `network:${this.config.participants[member.name]?.adapter}:${this.store.binding(member.name).session_id}`) {
          return this.fail(member.name, execution.id, room_text("原会话绑定已改变，无法继续本次执行"));
        }
        this.save(member.name, { status: 'delivering' });
        this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`retry-reason:${execution.id}`);
        return this.invoke(member, latest, { network_binding, resume: network_binding ? restart_resume_prompt(execution.id, 'network') : '' });
      }
    }
    // A restart between persisting and invoking cannot prove non-delivery, so it never resends.
    if (row.status === 'delivering') return this.fail(member.name, execution.id, room_text("上次投递结果不明，未自动重发；请核对原会话后重新发送"));
    if (execution.paused_at) {
      // A paused turn ending is not a failure: the execution waits, renewed, for the owner's words.
      if (await this.hold_paused(member, row, execution)) return;
    } else {
      // A dead inherited process is never redelivered: reconcile its exact recorded turn first.
      if (row.status === 'running' && this.orphan(execution.id)?.alive === false) {
        return this.recover_orphan(member, row, execution);
      }
      if (row.error) return this.retry_or_fail(member.name, execution, row.error);
      if (this.exited.has(execution.id)) {
        const latest = await api(this.config, `/executions/${execution.id}`);
        const denial = this.exited.get(execution.id);
        const refusals = this.refusal_hints.get(execution.id);
        this.refusal_hints.delete(execution.id);
        const tried = this.refusal_retries.get(execution.id) || { attempts: 0, refusals: [] };
        // A command refused for something the member can correct (shell symbols in an inline answer): resume the same
        // session with what to change, up to MAX_REFUSAL_RETRIES times, rather than fail a turn whose answer was nearly sent.
        if (['dispatched', 'started'].includes(latest.status) && refusals && tried.attempts < MAX_REFUSAL_RETRIES) {
          const next = { attempts: tried.attempts + 1, refusals: [...tried.refusals, ...refusals] };
          this.refusal_retries.set(execution.id, next);
          this.exited.delete(execution.id);
          this.replies.delete(execution.id);
          this.denied.delete(execution.id);
          this.save(member.name, { status: 'delivering', error: '' });
          return this.invoke(member, latest, { resume: refusal_retry_prompt(execution.id, next.refusals, next.attempts) });
        }
        // Program notices alone (failure reminder, timed check) need no reply: with nothing to handle the turn just ends.
        if (['dispatched', 'started'].includes(latest.status) && !denial && latest.requests?.length
          && latest.requests.every(item => item.purpose === 'notice')) return this.end_quiet(member.name, execution.id);
        if (['dispatched', 'started'].includes(latest.status) && !denial && await this.capture_reply(member.name, execution.id, latest)) {
          return this.save(member.name, { status: 'idle' });
        }
        if (['dispatched', 'started'].includes(latest.status)) return this.fail(member.name, execution.id, denial ? room_text("{value1} {value2}，未提交本次回答", { value1: member.name, value2: denial }) : room_text("{value1} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容", { value1: member.name }));
        return this.save(member.name, { status: 'idle' });
      }
    }
    // Segments and notes go first, quietly and often, so a renewal in the same tick already shows the notes it announces.
    if (this.segments.due(execution.id, PROGRESS_REPORT_MS)) await this.report_segments(execution.id);
    const activity = this.activity.get(execution.id);
    const changed = activity && (activity.phase !== activity.sent_phase || activity.at !== activity.sent_at);
    const elapsed = Date.now() - row.last_renew;
    if (elapsed >= RENEW_MS || (changed && elapsed >= ACTIVITY_REPORT_MS)) {
      const renew = phase => api(this.config, `/executions/${execution.id}`, { action: 'renew',
        diagnostics: this.diagnostics.get(execution.id),
        ...(activity ? { activity: phase, activity_at: Math.floor(activity.at / 1000) } : {}) });
      try { await renew(activity?.phase); }
      catch (error) {
        // A website older than this runner refuses a phase it does not know yet: renew without the phase rather than lose the lease.
        if (activity?.phase !== 'waiting' || !/^HTTP 400\b/.test(error.message)) throw error;
        await renew('');
      }
      if (activity) Object.assign(activity, { sent_phase: activity.phase, sent_at: activity.at });
      this.save(member.name, { last_renew: Date.now() });
    }
  }
  /** The execution a turn delivered as `id` now belongs to, following keep_working moves. */
  live_id(id) {
    while (this.continued.has(id)) id = this.continued.get(id);
    return id;
  }
  /**
   * The host answered with keep_working and its software turn goes on: move that turn, with what this runner keeps for
   * it, onto the execution the website opened, instead of stopping it. The answered execution reports its file changes
   * and progress as they stand; the new one watches from now.
   */
  async carry_on(name, old, id) {
    this.continued.set(old, id);
    for (const map of [this.generations, this.steers, this.activity, this.replies, this.exited, this.execution_processes, this.refusal_hints, this.refusal_retries]) {
      if (map.has(old)) { map.set(id, map.get(old)); map.delete(old); }
    }
    for (const set of [this.denied, this.not_started, this.not_retryable, this.turn_ended]) if (set.delete(old)) set.add(id);
    if (this.failure_classes.has(old)) { this.failure_classes.set(id, this.failure_classes.get(old)); this.failure_classes.delete(old); }
    const snapshot = this.snapshots.get(old);
    const moved_before = snapshot?.before ? workspace_snapshot(snapshot.directory) : null;
    if (snapshot) this.snapshots.set(id, { member: snapshot.member, directory: snapshot.directory,
      before: moved_before, base: capture_base(snapshot.directory, moved_before),
      extras: (snapshot.extras || []).map(item => ({ directory: item.directory, before: workspace_snapshot(item.directory) })),
      ...(snapshot.edited ? { edited: new Set() } : {}) });
    for (const prefix of ['owner', 'delivery']) {
      const value = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`${prefix}:${old}`)?.value;
      if (!value) continue;
      this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`${prefix}:${id}`, value);
      this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`${prefix}:${old}`);
    }
    const workflow = this.diagnostics.get(old)?.workflow;
    await this.report_segments(old, true);
    if (workflow) this.record_diagnostics(id, { workflow });
    this.segments.start(id);
    this.save(name, { execution_id: id, last_renew: 0 });
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
    this.replies.delete(execution.id);
    this.denied.delete(execution.id);
    this.not_started.delete(execution.id);
    this.not_retryable.delete(execution.id);
    if (row.error) this.save(member.name, { error: '' });
    if (processes?.size || !execution.interjections?.length) return false;
    this.save(member.name, { status: 'delivering', error: '' });
    await api(this.config, `/executions/${execution.id}`, { action: 'resume' });
    await this.invoke(member, execution, { resume: resume_prompt(execution.id, execution.interjections.map(interjection_text)) });
    if (this.row(member.name)?.status !== 'running') return true;
    for (const interjection of execution.interjections) {
      this.interjecting.set(interjection.id, { status: 'delivered' });
      await api(this.config, `/executions/${execution.id}`, { action: 'interjection', interjection_id: interjection.id, status: 'delivered',
        diagnostics: { transport: 'resumed_turn', confirmed_at: null } })
        .catch(error => this.log(`插话 #${interjection.id} 的结果未能上报：${error.message}`));
    }
    return true;
  }
  /**
   * Tell the site what this delivery can do, as the adapter reported it: whether the runner can stop it and see its
   * progress. Kept locally until the execution ends so a restarted runner still knows whether it could stop it.
   * A lost report is retained for the final stop result; sites and runners must use the same capability protocol.
   */
  async report_delivery(execution_id, { stoppable, progress, ends = false, steer = false, resume = false }, member) {
    // `ends`: the adapter cannot stop or follow this turn but reports when it ends (`on_turn_end`); kept locally only.
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(`delivery:${execution_id}`, JSON.stringify({ stoppable, progress, ends, member }));
    await api(this.config, `/executions/${execution_id}`, { action: 'delivery', stoppable, progress, steer, resume,
      diagnostics: this.diagnostics.get(execution_id) })
      .catch(error => this.log(`执行 #${execution_id} 的投递能力未能上报：${error.message}`));
  }
  /** Tell the site which model and effort an execution ran with, for its card; a lost report only leaves the card without it. */
  report_model(execution_id, { model, effort }) {
    if (!model && !effort) return;
    api(this.config, `/executions/${execution_id}`, { action: 'model', model, effort })
      .catch(error => this.log(`执行 #${execution_id} 的模型未能上报：${error.message}`));
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
    // A turn this runner could not stop but follows (`progress`) or hears end (`ends`) is still watched: once it ends, in
    // its window or App by the owner or on its own, `stopped` lifts the site's hold on the next delivery.
    const followed = Boolean(delivery.progress || delivery.ends);
    const seen_end = ended || this.turn_ended.has(execution_id);
    const result = delivery.pending_result && !['unconfirmed', 'unstoppable'].includes(delivery.pending_result) ? delivery.pending_result
      : !delivery.stoppable ? (followed && seen_end ? 'stopped' : 'unstoppable') : ended ? 'stopped' : 'unconfirmed';
    if (delivery.stop_result === result) {
      // Past the site's hold (HOLD_SECONDS in backend/free_room.py) an unstoppable turn's end changes nothing.
      if (result === 'unstoppable' && Date.now() - (delivery.reported_at || 0) > UNSTOPPABLE_FOLLOW_MS) this.forget_stop(execution_id);
      return;
    }
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
    if (result === 'unconfirmed' || (result === 'unstoppable' && followed)) {
      this.store.db.prepare('UPDATE metadata SET value=? WHERE key=?')
        .run(JSON.stringify({ ...delivery, member: name, pending_result: result, stop_result: result, reported_at: Date.now() }), key);
      // The site's bounded hold now controls the next delivery; retain handles to observe and retry termination.
      for (const child of processes || []) this.members.get(name)?.delete(child);
    }
    else this.forget_stop(execution_id);
  }
  /** Drop what this runner keeps for one voided execution's stop report. */
  forget_stop(execution_id) {
    this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`delivery:${execution_id}`);
    this.execution_processes.delete(execution_id);
    this.turn_ended.delete(execution_id);
    this.forget_owner(execution_id);
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
  /** Drop the records an ended execution leaves: its process owners and whether a restart already resumed it. */
  forget_owner(execution_id) {
    this.store.db.prepare('DELETE FROM metadata WHERE key IN (?,?,?)').run(`owner:${execution_id}`, `restart-resumed:${execution_id}`, `retry-reason:${execution_id}`);
  }
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
  async report_segments(execution_id, final = false) {
    const diagnostics = this.diagnostics.get(execution_id);
    await this.segments.report(execution_id, final, ({ segments, notes }) =>
      api(this.config, `/executions/${execution_id}`, { action: 'segments', diagnostics, segments, ...(notes.length ? { notes } : {}) }));
    if (final) {
      const snapshot = this.snapshots.get(execution_id);
      if (snapshot) snapshot.diagnostics = this.diagnostics.get(execution_id);
      this.diagnostics.delete(execution_id);
    }
  }
  /** Record adapter evidence without carrying output text, tool arguments, or session credentials. */
  record_diagnostics(execution_id, { retry, ...facts }) {
    const previous = this.diagnostics.get(execution_id);
    const retries = retry ? [...(previous?.retries || []), { ...retry, at: Date.now() }].slice(-MAX_DIAGNOSTIC_RETRIES) : null;
    this.diagnostics.set(execution_id, { ...previous, ...facts, ...(retries ? { retries } : {}) });
  }
  /** Keep software confirmation bound to the original interjection even if the turn has continued onto another execution. */
  confirm_interjection(interjection_id) {
    const report = this.interjecting.get(interjection_id);
    if (report?.status !== 'delivered' || !report.execution_id) return;
    const execution_id = report.execution_id;
    report.confirmed_at ||= Date.now();
    return this.report_interjection(execution_id, interjection_id, report)
      .catch(error => this.log(`插话 #${interjection_id} 的确认未能上报：${error.message}`));
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
  /**
   * The software ended normally without submitting: save its last remark as this execution's answer, marked as
   * captured (`source: auto`), under the member's own credential. It dispatches nothing. Only a delivery whose adapter
   * declares `capture` is captured, and only while the service holds no answer and no refused submit for the execution
   * (`latest.delivery.last_submission`, spec #3262 item 7): a submit that went wrong is reported, never replaced by other
   * text. Returns false when there is no usable remark or the website refused it, so the caller reports the missing
   * answer as before.
   */
  async capture_reply(name, execution_id, latest = {}) {
    const text = this.replies.get(execution_id)?.trim() || '';
    this.replies.delete(execution_id);
    if (this.denied.delete(execution_id)) return false;
    if (!capabilities_of(this.config.participants?.[name]?.adapter).capture) return false;
    if (['accepted', 'rejected'].includes(latest.delivery?.last_submission?.outcome)) return false;
    const token = this.config.members?.[name]?.token;
    if (!text || text === '(pass)' || text.length > MAX_CAPTURED_REPLY || !token) return false;
    try {
      await api(this.config, '/messages', { author: name, submitted_by: name, source: 'auto', kind: 'chat', text,
        execution_id, submission_id: `auto-capture-${execution_id}` }, token);
      return true;
    } catch (error) {
      this.log(`${name} 执行 #${execution_id} 的回答未能自动收录：${error.message}`);
      return false;
    }
  }
  /**
   * Report observed file changes once an execution has ended. Its software is often still closing its turn then (the
   * answer is posted from inside it), so what has changed so far is reported at once as provisional, for the answer's
   * card to list without the wait (user 2026-11-19, #5669); the report after its processes have exited replaces it.
   */
  async report_finished(active) {
    for (const [execution_id, snapshot] of this.snapshots) {
      if (active.has(execution_id)) continue;
      const running = this.execution_processes.get(execution_id)?.size > 0;
      if (running && snapshot.reported_early) continue;
      if (running) snapshot.reported_early = true;
      else {
        this.snapshots.delete(execution_id);
        // Once the turn is over the software's session log says what really ran (a default model, or one the App chose).
        const profile = this.config.participants[snapshot.member];
        if (profile) this.report_model(execution_id, session_settings(profile.adapter, this.store.binding(snapshot.member).session_id));
      }
      const after = snapshot.before ? workspace_snapshot(snapshot.directory) : null;
      let workspace_observed = Boolean(after);
      const extra = (snapshot.extras || []).flatMap(item => {
        const current = workspace_snapshot(item.directory);
        if (current) workspace_observed = true;
        return current ? changed_between(item.before, current).map(path => extra_change(item.directory, path)) : [];
      });
      if (!workspace_observed) continue;
      const own = after ? changed_between(snapshot.before, after) : [];
      const changes = [...own, ...extra].slice(0, 200);
      // `edited` is sent only when the adapter tracked edits; without it the site cannot tell who wrote a shared file.
      const edited = snapshot.edited ? { edited: edited_changes(changes, snapshot.edited) } : {};
      const diagnostics = { ...(this.diagnostics.get(execution_id) || snapshot.diagnostics),
        file_attribution: { tracked: Boolean(snapshot.edited), provisional: running,
          omitted: Math.max(0, own.length + extra.length - changes.length) } };
      // Line counts and patches of the files in the member's own working tree, for the card's "edited N files".
      let diffs = [];
      if (own.length) try { diffs = file_diffs(snapshot.directory, own.slice(0, 200), snapshot.base); } catch { /* The card then lists names only. */ }
      try { await api(this.config, `/executions/${execution_id}`, { action: 'report', ...(running ? { provisional: true } : {}),
        changes, ...edited, ...(diffs.length ? { diffs } : {}), diagnostics }); }
      catch (error) { if (!/HTTP (404|409)/.test(error.message)) throw error; }
    }
  }
  /**
   * Check the website before reading local evidence. Recovery never sends the task again or schedules a retry; a turn
   * that did not end on its own may only go on in its session (resume_after_restart).
   */
  async recover_orphan(member, row, execution) {
    const latest = await api(this.config, `/executions/${execution.id}`);
    if (!['dispatched', 'started'].includes(latest.status)) {
      this.forget_owner(execution.id);
      return this.save(member.name, { status: 'idle', error: '' });
    }
    const submitted = ['accepted', 'rejected'].includes(latest.delivery?.last_submission?.outcome);
    if (submitted) return this.fail(member.name, execution.id, room_text("{value1} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容", { value1: member.name }));
    let saved;
    try { saved = JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`recovery:${execution.id}`)?.value || 'null'); }
    catch { /* Invalid or old local records cannot identify a turn. */ }
    const result = !row.error && saved?.adapter === this.config.participants[member.name]?.adapter
      ? await recover_turn(saved.adapter, saved.record) : { status: 'unknown' };
    if (result.status === 'completed' && result.exact) {
      this.replies.set(execution.id, result.text || '');
      if (result.denied
        || this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`recovery-denied:${execution.id}`)) this.denied.add(execution.id);
      if (await this.capture_reply(member.name, execution.id, latest)) {
        this.forget_owner(execution.id);
        return this.save(member.name, { status: 'idle', error: '' });
      }
      return this.fail(member.name, execution.id, room_text("{value1} 会话已结束，但未提交本次回答；请核对原会话确认是否已有内容", { value1: member.name }));
    }
    if (!row.error && result.status !== 'failed' && await this.resume_after_restart(member, latest)) return;
    return this.fail(member.name, execution.id, RESTART_REASON);
  }
  /**
   * A turn a restart ended midway goes on once in its own session, told to check the workspace first, instead of
   * failing (user 2026-11-23, #8366); the task is never sent again whole, since part of it may already have run.
   * Only software that can resume a session, and only a member already bound to one.
   */
  async resume_after_restart(member, execution) {
    const key = `restart-resumed:${execution.id}`;
    if (!capabilities_of(this.config.participants[member.name]?.adapter).resume || !this.store.binding(member.name).session_id
      || this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)) return false;
    this.store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key, '1');
    this.store.db.prepare('DELETE FROM metadata WHERE key=?').run(`retry-reason:${execution.id}`);
    this.save(member.name, { status: 'delivering', error: '' });
    await this.invoke(member, execution, { resume: restart_resume_prompt(execution.id) });
    return true;
  }
  /** Redeliver an unstarted or manual task, or resume the session named by a transient network failure. */
  async retry_or_fail(name, execution, reason) {
    // Recover a retry_wait acknowledged by the site before the local row was saved.
    if (execution.retry?.retry_at) return this.save(name, { status: 'retry_wait', error: '' });
    const attempt = (execution.retry?.attempt || 0) + 1;
    const not_started = this.not_started.delete(execution.id);
    if (this.not_retryable.delete(execution.id)) return this.fail(name, execution.id, reason);
    const retry_reason = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`retry-reason:${execution.id}`)?.value;
    const network = retry_reason?.startsWith('network:');
    if (!network && this.config.participants[name]?.project_access !== 'own' && !not_started) return this.fail(name, execution.id, reason);
    if (attempt > MAX_DELIVERY_RETRIES) return this.fail(name, execution.id, room_text("{value1}（已自动重试 {value2} 次）", { value1: reason, value2: MAX_DELIVERY_RETRIES }));
    this.stop_member(name);
    this.exited.delete(execution.id);
    this.replies.delete(execution.id);
    this.denied.delete(execution.id);
    const delay = network ? NETWORK_RETRY_SECONDS[attempt - 1] : RETRY_DELAY_SECONDS;
    await api(this.config, `/executions/${execution.id}`, { action: 'retry_wait', attempt,
      retry_at: Math.floor(Date.now() / 1000) + delay, reason: reason.slice(0, MAX_RETRY_REASON),
      diagnostics: { retry: { layer: 'runner', state: 'waiting', attempt, mode: network ? 'resume' : 'redeliver' } } });
    this.save(name, { status: 'retry_wait', error: '' });
  }
  /**
   * The model and effort this member is delivered with now against its previous delivery, as `{from, to}` when they
   * changed (COVERAGE 9), else null; the current one is remembered for the next delivery.
   */
  model_change(name) {
    const profile = this.config.participants[name] || {};
    const current = model_label(profile), key = `delivered-model:${name}`;
    const previous = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value;
    this.store.db.prepare('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, current);
    return previous !== undefined && previous !== current ? { from: previous, to: current } : null;
  }
  /** Record the cause on the website, then stop this member's own processes. */
  /** End an execution that carried only program notices and left no answer: completed, no message posted. */
  async end_quiet(name, execution_id) {
    this.activity.delete(execution_id);
    this.replies.delete(execution_id);
    await this.report_segments(execution_id, true);
    try { await api(this.config, `/executions/${execution_id}`, { action: 'quiet' }); }
    catch (error) { if (!/HTTP 409/.test(error.message)) throw error; }
    this.save(name, { status: 'idle', error: '' });
  }
  async fail(name, execution_id, reason) {
    const diagnostics = this.diagnostics.get(execution_id);
    this.activity.delete(execution_id);
    this.not_started.delete(execution_id);
    this.not_retryable.delete(execution_id);
    const failure_class = this.failure_classes.get(execution_id) || {};
    this.failure_classes.delete(execution_id);
    await this.report_segments(execution_id, true);
    let recorded = true;
    try { await api(this.config, `/executions/${execution_id}`, { action: 'fail', reason, ...failure_class, diagnostics }); }
    catch (error) { if (!/HTTP 409/.test(error.message)) throw error; recorded = false; }
    if (recorded && this.on_failed) {
      try { this.on_failed({ member: name, execution_id, reason, room: this.config.room, title: this.room_title || '' }); }
      catch (error) { this.log(`失败通知未记录：${error.message}`); }
    }
    this.save(name, { status: 'idle', error: reason });
    this.stop_member(name);
    this.forget_owner(execution_id);
  }
  /**
   * Hand the owner's pending interjections to the software running each execution, in order, through the steer handle
   * its delivery returned; report each as delivered or failed. A handle is dropped once its execution is no longer live.
   */
  /** Remove the attachment copies of executions that are no longer live; a live one may still be reading them. */
  sweep_attachments() {
    // Copies sit in each member's runtime folder (older versions put them in the runtime directory itself).
    const folders = [this.config.directory, ...member_folders(this.config.directory)];
    const names = folders.flatMap(folder => { try { return readdirSync(folder).filter(name => /^free-\d+-files$/.test(name)).map(name => [folder, name]); } catch { return []; } });
    if (!names.length) return;
    const live = new Set(this.store.db.prepare('SELECT * FROM free_deliveries').all()
      .filter(row => LIVE.includes(row.status)).map(row => `free-${row.execution_id}-files`));
    for (const [folder, name] of names) if (!live.has(name)) rmSync(join(folder, name), { recursive: true, force: true });
  }
  /**
   * A request that queued for a member while it works is pointed out to it once, through the same channel as an
   * interjection, so it may deliver both in one answer (应 2); software that cannot take it mid-turn is not told, and
   * the request simply follows when this turn ends.
   */
  async notice_queued(inbox) {
    for (const execution of inbox.executions || []) {
      const steer = this.steers.get(execution.id);
      const member = (inbox.members || []).find(item => item.name === execution.member);
      if (!steer || execution.paused_at || !member) continue;
      const fresh = (member.pending || []).filter(item => ['ask', 'route', 'all'].includes(item.purpose) && !item.session_request_id && !item.batch_id
        && !this.queued_noticed.has(item.id));
      if (!fresh.length) continue;
      for (const item of fresh) this.queued_noticed.add(item.id);
      const listed = fresh.map(item => `#${item.id}（消息 #${item.message_id}）`).join('、');
      await Promise.resolve(steer(`房间提示：又有请求 ${listed} 在排队等你。和本次任务相关、能一并处理的，可在本次回答里一起交付`
        + `（CLI 加 --also-request 请求编号，API 填 also_request_ids）；不相关的不用管，本次答完后会再交给你。`)).catch(() => {});
    }
  }
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
          report = { status: 'failed', reason: room_text("本次投递不支持执行中插话") };
          if (steer) {
            try { report = await steer(interjection_text(interjection), interjection.id) ? { status: 'delivered' } : { status: 'failed', reason: room_text("它已结束本轮，插话未送达") }; }
            catch (error) { report = { status: 'failed', reason: String(error.message).slice(0, 400) }; }
          }
          Object.assign(report, { execution_id: execution.id, confirmed_at: null });
          this.interjecting.set(interjection.id, report);
        }
        try { await this.report_interjection(execution.id, interjection.id, report); }
        catch (error) { this.log(`插话 #${interjection.id} 的结果未能上报：${error.message}`); }
      }
    }
  }
  /** Report transport status and the optional matching software receipt as independent facts. */
  report_interjection(execution_id, interjection_id, { status, reason, confirmed_at = null }) {
    return api(this.config, `/executions/${execution_id}`, { action: 'interjection', interjection_id, status, reason,
      diagnostics: { transport: 'steer', confirmed_at } });
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
        if (chat.status === 'running' && chat.id !== live?.id) await this.chat_report(chat.id, { action: 'fail', reason: room_text("本机服务重启，这轮私聊已中断") });
        else if (chat.status === 'pending' && live?.steer && !live.steered.has(chat.id)) {
          live.steered.add(chat.id);
          if (await live.steer(interjection_text({ text: chat.text }))) await this.chat_report(chat.id, { action: 'steered' });
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
      return this.chat_report(chat.id, { action: 'fail', reason: room_text("这位成员的接入方式看不到它的输出，暂不支持私聊窗；可在它自己的窗口里对话") });
    }
    if (!await this.chat_report(chat.id, { action: 'start' })) return;
    const turn = { id: chat.id, child: null, steer: null, steered: new Set() };
    this.chat_turns.set(member.name, turn);
    const notes = [];
    let settle;
    const ended = new Promise(resolve => { settle = resolve; });
    try {
      await this.bind_invited(member.name, profile, binding);
      this.pending_fork(member.name, profile, binding);
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
        : { action: 'fail', reason: String(error || room_text('它没有给出文字回复')).slice(0, 400) });
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

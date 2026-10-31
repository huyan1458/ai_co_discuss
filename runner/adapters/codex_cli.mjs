/**
 * Codex CLI adapter: one headless `codex exec` turn per execution resuming the bound thread, under a per-run permission
 * profile. Its rollout files and app server also serve the Codex App adapter for sessions and models.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { cli_delivery } from './cli.mjs';
import { CALL_TIMEOUT_MS, launch_directory, log_entries, marked, model_entry, json_line, newest_record, not_sent,
  project_directory, prompt_text, query_catalog } from './common.mjs';

/** Codex exec may linger after its final event; the finished turn is already saved, so stop it to free the session. */
const CLI_EXIT_GRACE_MS = 1500;
const CODEX_PERMISSIONS_MIN_MINOR = 163;
const FORK_TIMEOUT_MS = 60_000;

/** Build a per-invocation profile without inheriting a user's custom profile of the same name. */
export function codex_permissions(config, task, platform = process.platform) {
  // 全放开 runs without approval or sandbox, so there is no profile to build or check.
  if (config.project_access === 'full') return { name: '', args: ['--dangerously-bypass-approvals-and-sandbox'] };
  const name = `codiscuss-${randomUUID()}`;
  // A taken-over manual member writes like 可写: its own config may sandbox read-only and then could not save its answer draft.
  const base = ['auto', 'own'].includes(config.project_access) || (project_directory(config) && config.project_access === 'write')
    ? ':workspace' : ':read-only';
  const drafts = resolve(task.draft_directory).replaceAll('\\', '/');
  const filesystem = { ':root': 'read', [resolve(task.directory).replaceAll('\\', '/')]: 'read', [drafts]: 'write' };
  const rules = Object.entries(filesystem).map(([path, access]) => `${JSON.stringify(path)}=${JSON.stringify(access)}`).join(',');
  const profile = `{extends=${JSON.stringify(base)},filesystem={${rules}},network={enabled=true}}`;
  // The Windows sandbox account cannot write the user's TEMP, so PowerShell starts in ConstrainedLanguage and Codex's
  // UTF-8 output setup fails silently, garbling Chinese; a TEMP inside the writable drafts keeps FullLanguage.
  const temp = platform === 'win32' ? ['-c', `shell_environment_policy.set.TEMP=${JSON.stringify(drafts)}`,
    '-c', `shell_environment_policy.set.TMP=${JSON.stringify(drafts)}`] : [];
  // 自动 is what `codex exec --approve-for-me` sets (that flag is missing on `exec resume`): the model asks to escalate
  // and Codex's automatic review answers instead of a person (tested 0.163).
  const approval = config.project_access === 'auto' ? ['-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"']
    : ['-c', 'approval_policy="never"'];
  return { name, args: ['-c', `default_permissions=${JSON.stringify(name)}`, '-c', `permissions.${name}=${profile}`, ...approval, ...temp] };
}

/** Read effective Codex config through its local CLI; no thread or model is started. */
function read_codex_config(config, task, permissions, spawn_process) {
  return new Promise((resolve_config, reject) => {
    const child = spawn_process(config.executable, ['app-server', ...permissions.args], {
      cwd: launch_directory(config, task), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    task.on_process(child);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); lines.close();
      const complete = () => error ? reject(not_sent(error)) : resolve_config(value);
      if (child.exitCode !== null || child.signalCode !== null) complete();
      else { child.once('close', complete); child.kill(); }
    };
    const timer = setTimeout(() => finish(new Error('Codex 权限配置检查超时，未交付讨论任务')), CALL_TIMEOUT_MS);
    const send = (id, method, params) => child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    child.once('error', error => finish(error));
    child.once('close', () => finish(new Error('Codex 无法读取权限配置，请使用支持 permission profiles 的 CLI')));
    child.stdin.on('error', error => finish(error));
    child.stderr.resume();
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (![1, 2].includes(response.id)) return;
      if (response.error) return finish(new Error(`Codex 权限配置检查失败：${response.error.message}`));
      if (response.id === 1) {
        const version = response.result?.userAgent?.match(/\/(\d+)\.(\d+)\.\d+\b/);
        if (!version || (Number(version[1]) === 0 && Number(version[2]) < CODEX_PERMISSIONS_MIN_MINOR)) {
          return finish(new Error('本次权限配置需要 Codex CLI 0.163.0 或更新版本，未交付讨论任务'));
        }
        send(2, 'config/read', { cwd: launch_directory(config, task), includeLayers: false });
      }
      else finish(null, response.result?.config);
    });
    send(1, 'initialize', { clientInfo: { name: 'codiscuss', version: '0.1.0' } });
  });
}

/** Reject legacy overrides that would silently replace the requested filesystem policy. */
async function check_codex_permissions(config, task, permissions, spawn_process) {
  const effective = await read_codex_config(config, task, permissions, spawn_process).catch(error => { throw not_sent(error); });
  if (effective?.sandbox_mode != null || effective?.sandbox_workspace_write != null) {
    throw not_sent(new Error('Codex 配置含旧 sandbox_mode / sandbox_workspace_write，会覆盖本次权限；请移除旧配置后重试，未交付讨论任务'));
  }
  if (effective?.default_permissions !== permissions.name || !effective?.permissions?.[permissions.name]) {
    throw not_sent(new Error('Codex 未采用本次 permission profile，未交付讨论任务；请更新 CLI'));
  }
}

/** Native `codex exec` arguments; every continuation names the exact bound thread. */
function invocation(config, binding, task) {
  const permissions = codex_permissions(config, task);
  const args = ['exec', '--cd', launch_directory(config, task)];
  if (binding.session_id) args.push('resume', binding.session_id);
  args.push(...permissions.args, '--json', '--skip-git-repo-check', ...(config.model ? ['-m', config.model] : []),
    ...(config.effort ? ['-c', `model_reasoning_effort="${config.effort}"`] : []), '-');
  return { args, input: task.prompt,
    ...(permissions.name ? { check: spawn_process => check_codex_permissions(config, task, permissions, spawn_process) } : {}) };
}

/** Keep the actual resume failure even when later model-refresh logs replace the diagnostic tail. */
function remember_writer_conflict(state, diagnostic) {
  if (/thread-store conflict:[\s\S]*already has an active writer/.test(diagnostic)) state.writer_conflict = true;
}

/** Consume only documented lifecycle events, not text produced by agent tools. */
function lifecycle(state, event, task, bind) {
  if (event.type === 'thread.started') bind(event.thread_id);
  if (event.type === 'turn.completed') { state.completed = true; state.finish_timer = setTimeout(() => { state.finished = true; task.on_trace?.('kill_after_completed'); state.child.kill(); }, CLI_EXIT_GRACE_MS); }
  if (event.type === 'turn.failed') state.error = event.error?.message || 'Codex CLI 执行失败';
  if (event.type === 'error') state.diagnostic = event.message || 'Codex CLI 返回错误';
  remember_writer_conflict(state, state.error || state.diagnostic);
}

/** A thread another process writes to cannot be resumed here; retrying does not release it. */
function exit_error(state) {
  return state.writer_conflict ? `Codex 会话 ${state.session_id} 已被另一进程持有（active writer），CLI 无法接管。若为 App 中的聊天，请使用 Codex App 接入；独立 CLI 须使用未被占用的会话。重复点击重试不会解除占用` : '';
}

/** What `codex exec --json` events say the agent is doing, which tool it starts, and text it wrote to the user. */
const events = {
  phase(event) {
    if (event.type === 'turn.started') return 'thinking';
    const kind = event.item?.type;
    if (event.type === 'item.started') {
      return { command_execution: 'command', file_change: 'editing', mcp_tool_call: 'tool', web_search: 'tool', reasoning: 'thinking' }[kind] || '';
    }
    if (event.type === 'item.completed') return kind === 'agent_message' ? 'writing' : 'thinking';
    return '';
  },
  tool(event) {
    if (event.type !== 'item.started') return '';
    return event.item?.type === 'mcp_tool_call' ? String(event.item.tool || '') : event.item?.type === 'web_search' ? 'web_search' : '';
  },
  note(event) { return event.type === 'item.completed' && event.item?.type === 'agent_message' ? String(event.item.text || '').trim() : ''; },
};

/** Where Codex keeps one thread's rollout, or '' when this machine has none by that ID; shared by the App adapter. */
export function session_path(session_id, env = process.env, home = homedir()) {
  const sessions = join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
  if (!existsSync(sessions)) return '';
  const found = readdirSync(sessions, { recursive: true }).map(String).find(path => path.endsWith(`-${session_id}.jsonl`));
  return found ? join(sessions, found) : '';
}

/** Codex turns in order, and the index of the first turn whose user prompt carries a marker (-1 when none does). */
function codex_turns(file, markers) {
  const turns = [];
  let cut = -1;
  for (const entry of log_entries(file)) {
    const payload = entry.payload || {};
    if (entry.type === 'event_msg' && payload.type === 'task_started' && payload.turn_id) turns.push(payload.turn_id);
    else if (cut < 0 && turns.length && entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user'
      && marked(prompt_text(payload.content), markers)) cut = turns.length - 1;
  }
  return { turns, cut };
}

/** Ask Codex's app server to fork a thread, through `last_turn` when given; returns the new thread's ID. */
function codex_fork(profile, thread_id, last_turn, spawn_process) {
  return new Promise((resolve_fork, reject) => {
    const child = spawn_process(profile.executable, ['app-server'], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolve_fork(value);
    };
    const timer = setTimeout(() => finish(new Error('Codex 分叉会话超时')), FORK_TIMEOUT_MS);
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.once('error', error => finish(error));
    child.once('close', () => finish(new Error('Codex app-server 未完成分叉就退出了')));
    child.stdin.on('error', error => finish(error));
    child.stderr.resume();
    lines.on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply.error && [1, 2].includes(reply.id)) return finish(new Error(`Codex 分叉会话失败：${reply.error.message}`));
      if (reply.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'thread/fork', params: { threadId: thread_id, excludeTurns: true, ...(last_turn ? { lastTurnId: last_turn } : {}) } });
      } else if (reply.id === 2) {
        const id = reply.result?.thread?.id;
        finish(id ? null : new Error('Codex 分叉会话没有返回新会话 ID'), id);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codiscuss', version: '0.1.0' } } });
  });
}

/** Fork through the turn before the first marked one; a cut at the first turn starts anew. Shared by the App adapter. */
export async function branch(profile, session_id, markers, { always, env, home, spawn_process = spawn }) {
  const file = session_path(session_id, env, home);
  if (!file) throw new Error(`本机找不到 Codex 会话 ${session_id}`);
  const { turns, cut } = codex_turns(file, markers);
  if (cut < 0 && !always) return null;
  if (cut === 0) return { session_id: '' };
  return { session_id: await codex_fork(profile, session_id, cut > 0 ? turns[cut - 1] : '', spawn_process) };
}

/** Whether a stored thread was started in the Codex desktop, which resumes it through the App rather than the CLI. */
export function desktop_thread(session_id, options = {}) {
  const file = session_path(session_id, options.env, options.home);
  return Boolean(file) && /"originator":"Codex Desktop"/.test(readFileSync(file, 'utf8').split('\n', 1)[0]);
}

/** Whether Codex stored a thread by that ID on this machine. */
export function session_exists(session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(session_id, env, home));
}

/** The model and effort a thread last ran with, from its rollout; no turn is started. Shared by the App adapter. */
export function session_settings(session_id, { env = process.env, home = homedir() } = {}) {
  const file = session_path(session_id, env, home);
  if (!file) return null;
  return newest_record(file, '"turn_context"', record => record.type === 'turn_context' && typeof record.payload?.model === 'string'
    ? { model: record.payload.model, effort: String(record.payload.effort || record.payload.collaboration_mode?.settings?.reasoning_effort || '') } : null);
}

/** Read the string keys of a TOML file by table; Codex settings need nothing richer. */
function toml_strings(text) {
  const tables = { '': {} };
  let table = '';
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/);
    if (header) { table = header[1].replaceAll('"', ''); tables[table] ||= {}; continue; }
    const pair = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/);
    if (pair) tables[table][pair[1]] = pair[2];
  }
  return tables;
}

/** Codex's user config: what it runs with when the card leaves model or effort empty. */
function defaults(profile, { env = process.env, home = homedir() } = {}) {
  try {
    const tables = toml_strings(readFileSync(join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8'));
    const top = tables[''], chosen = top.profile ? tables[`profiles.${top.profile}`] || {} : {};
    return { model: chosen.model || top.model || '', effort: chosen.model_reasoning_effort || top.model_reasoning_effort || '' };
  } catch { return { model: '', effort: '' }; }
}

/** Codex's catalog is paginated; initialize before querying and never create a thread or turn. */
function models(profile, options) {
  return query_catalog(profile, ['app-server', '--listen', 'stdio://'], (send, finish) => {
    const list = [];
    let request_id = 1;
    return {
      start: () => send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codiscuss', title: 'AI CoDiscuss', version: '0.2.1' } } }),
      line: line => {
        const reply = json_line(line);
        if (!reply || (reply.id !== 0 && reply.id !== request_id)) return;
        if (reply.error) return finish(new Error('Codex 模型目录查询失败，请检查 CLI 版本与登录'));
        if (reply.id === 0) {
          send({ method: 'initialized', params: {} });
          send({ id: request_id, method: 'model/list', params: { limit: 100, includeHidden: false } });
          return;
        }
        for (const model of reply.result?.data || []) {
          if (!model.hidden) list.push(model_entry(model.model || model.id, model.displayName,
            model.supportedReasoningEfforts?.map(item => item.reasoningEffort)));
        }
        const cursor = reply.result?.nextCursor;
        if (cursor) send({ id: ++request_id, method: 'model/list', params: { limit: 100, includeHidden: false, cursor } });
        else finish(null, list);
      },
    };
  }, options);
}

/** Codex CLI's behaviour; its static facts are in profiles.mjs. */
export const codex_cli = {
  id: 'codex_cli', catalog_source: 'codex-app-server',
  deliver: (config, binding, task, spawn_process, user_home) => cli_delivery(codex_cli, config, binding, task, spawn_process, user_home),
  invocation, lifecycle, exit_error, events,
  on_stderr: remember_writer_conflict,
  session: { path: session_path, exists: session_exists, owns: (id, options) => session_exists(id, options) && !desktop_thread(id, options),
    branch, settings: session_settings },
  models: { list: models, defaults },
};

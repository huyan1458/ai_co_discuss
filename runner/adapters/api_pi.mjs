/**
 * The Pi harness (`@earendil-works/pi-coding-agent`) that runs model API members. Each execution starts one
 * `pi --mode rpc` process: Pi owns the agent loop, the provider protocols, retries, compaction and a persistent session;
 * our extension (api_pi_extension.mjs) gives it the room, project file, command and image tools and nothing else (no
 * built-in tools, no shell). codiscuss installs and updates Pi itself (pi_runtime.mjs); the runner only spawns it (red line 7).
 *
 * Facts measured on Pi 1.5.2 (2026-11-11), see Ref_外部软件通信.md:
 * - `--session-id` finds a session only from the directory it was made in and silently starts an empty one with the same
 *   ID elsewhere, so an existing session is always opened by its file (`--session PATH`).
 * - `steer` reaches the model after the current tool batch; once the answer is saved the queue is cleared.
 * - `abort` stops a request in flight, but one sent between two requests can be missed: a stop also ends the process.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked, prompt_text, tree_killable } from './common.mjs';
import { WRITE_TOOLS } from './api_files.mjs';
import { adapter_profile } from './profiles.mjs';

// The provider our extension registers; the model ID is passed to Pi unchanged.
export const PI_PROVIDER = 'codiscuss';
const EXTENSION = fileURLToPath(new URL('./api_pi_extension.mjs', import.meta.url));
// Our wire protocols and the Pi API that speaks each one.
const PI_APIS = { responses: 'openai-responses', chat: 'openai-completions', anthropic: 'anthropic-messages', gemini: 'google-generative-ai' };
// Output cap sent with each request: protocols that need an explicit one used this before, and some models reject more.
const MAX_OUTPUT_TOKENS = 8192;
const CONTEXT_WINDOW = 128_000;
const STOP_GRACE_MS = 3000;
const EXIT_GRACE_MS = 5000;
// A long tool (an image request) shows no events; the runner still hears from it at its lease-renewal pace.
const TOOL_HEARTBEAT_MS = 30_000;
const DIAGNOSTIC_CHARS = 1200;
const REPLY_EXCERPT_CHARS = 300;
export const NO_TOOL_REMINDER = '普通文本不会被保存。请调用写入工具提交真实结果；确实无法继续才不调用工具直接结束。';
const API_CALL = { stoppable: true, progress: true };

/** Pi's private directories under the service directory: its config (kept apart from the user's own Pi) and sessions. */
export function pi_home(service_home) {
  const root = join(service_home, 'pi');
  return { agent: join(root, 'agent'), sessions: join(root, 'sessions') };
}

/**
 * The thinking level Pi is started with: the member's effort when it is one the API profile offers, else '' so no
 * reasoning parameter is sent and the provider's own default applies. Pi maps the level to each protocol's parameter.
 */
export function pi_thinking(profile) {
  return adapter_profile('api').efforts.includes(profile.effort) ? profile.effort : '';
}

/** The provider our extension registers for one member: its Base URL, protocol and model, its key from the environment. */
export function pi_provider(profile, base_url) {
  const api = PI_APIS[profile.api_protocol];
  if (!api) throw new Error('不支持的 API 请求协议');
  // Pi's Anthropic SDK adds /v1 itself; the other protocols take the root including the version, as we store it.
  const url = profile.api_protocol === 'anthropic' ? base_url.replace(/\/v1$/, '') : base_url;
  // Pi drops the thinking level for a model not marked as reasoning, so only a chosen effort marks it.
  return { name: 'CoDiscuss', baseUrl: url, apiKey: '$CODISCUSS_PI_KEY', api, models: [{ id: profile.model, name: profile.model,
    reasoning: Boolean(pi_thinking(profile)), input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: CONTEXT_WINDOW,
    maxTokens: MAX_OUTPUT_TOKENS }] };
}

/** The file holding one Pi session in a sessions directory, or '' when there is none by that ID. */
function session_file(sessions, session_id) {
  if (!session_id || !existsSync(sessions)) return '';
  const name = readdirSync(sessions).filter(file => file.endsWith(`_${session_id}.jsonl`)).sort().at(-1);
  return name ? join(sessions, name) : '';
}

/** The file holding one Pi session of this user's service directory, or '' when this machine has none by that ID. */
export function session_path(session_id, { home = homedir() } = {}) {
  return session_file(pi_home(join(home, '.codiscuss')).sessions, session_id);
}

/** Whether Pi stored a session by that ID. */
function session_exists(session_id, options = {}) {
  return Boolean(session_path(session_id, options));
}

function json(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** The model a session last ran with, from its newest model change. */
function session_settings(session_id, options = {}) {
  const file = session_path(session_id, options);
  if (!file) return null;
  const change = readFileSync(file, 'utf8').split('\n').map(json).filter(entry => entry?.type === 'model_change').at(-1);
  return change ? { model: String(change.modelId || ''), effort: '' } : null;
}

/** Pi's timestamped session file name. */
function session_file_name(session_id) {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}_${session_id}.jsonl`;
}

/**
 * Copy a session up to the user prompt of the first marked execution into a new session; the original stays. Entries
 * form one chain (runner sessions never branch in place), so the copy's last entry is its leaf. A cut before any
 * prompt starts anew; a session this machine lacks (bound before Pi ran API members) starts anew when copying.
 */
function branch(profile, session_id, markers, { always, home = homedir() }) {
  const file = session_path(session_id, { home });
  if (!file) return always ? { session_id: '' } : null;
  const lines = readFileSync(file, 'utf8').split('\n').filter(line => line.trim());
  const cut = lines.findIndex((line, index) => {
    const entry = index > 0 && json(line);
    return entry?.type === 'message' && entry.message?.role === 'user' && marked(prompt_text(entry.message.content), markers);
  });
  if (cut < 0 && !always) return null;
  const kept = lines.slice(1, cut < 0 ? undefined : cut);
  if (!kept.some(line => json(line)?.message?.role === 'user')) return { session_id: '' };
  const id = randomUUID();
  const header = { ...json(lines[0]), id, timestamp: new Date().toISOString(), parentSession: file };
  writeFileSync(join(dirname(file), session_file_name(id)), `${[JSON.stringify(header), ...kept].join('\n')}\n`, { mode: 0o600 });
  return { session_id: id };
}

export const session = { path: session_path, exists: session_exists, branch, settings: session_settings };

/** Text of a tool result's content blocks. */
function result_text(result) {
  return (result?.content || []).filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
}

/** One logged Pi event as execution-detail entries; a tool call keeps its id so its end fills in its start. */
function pi_detail(event) {
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    const parts = event.message.content || [];
    const entries = parts.flatMap(part => part?.type === 'thinking' && part.thinking ? [{ kind: 'thinking', body: String(part.thinking) }]
      : part?.type === 'text' && part.text?.trim() ? [{ kind: 'message', body: String(part.text) }] : []);
    if (event.message.stopReason === 'error') entries.push({ kind: 'error', body: String(event.message.errorMessage || '模型请求失败') });
    return entries;
  }
  const id = `tool-${event.toolCallId}`;
  const kind = WRITE_TOOLS.includes(event.toolName) ? 'edit' : 'tool';
  if (event.type === 'tool_execution_start') return [{ id, kind, title: `${event.toolName} ${JSON.stringify(event.args ?? {})}`, state: 'running' }];
  if (event.type === 'tool_execution_end') return [{ id, kind, state: event.isError ? 'failed' : 'done', body: result_text(event.result) }];
  if (event.type === 'auto_retry_start') return [{ kind: 'error', body: `模型请求失败，自动重试（第 ${event.attempt}/${event.maxAttempts} 次）：${event.errorMessage || ''}` }];
  return [];
}

export const events = { detail: pi_detail };

/** Split stdout into records on LF only: Pi's JSON may hold U+2028, which a generic line reader also splits on. */
function on_records(stream, handle) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) handle(line);
    }
  });
}

/**
 * Start one execution in Pi and follow it until the answer is saved, the process ends or the owner stops it.
 *
 * @param {object} run `cli` (the Pi CLI script), `profile`, `key`, `binding`, `task`, `context_file` (what the extension reads), `system_file`,
 *   `prompt`, `max_requests` (0 for no limit), `project_root` (where relative edit paths resolve, or ''),
 *   `service_home` (the service directory, whose `pi` folder holds Pi's config and sessions), `spawn_process`.
 * @returns {{status: string, session_id: string, capabilities: object, steer: function}}
 */
export function pi_delivery({ cli, profile, key, binding, task, context_file, system_file, prompt, max_requests, project_root, service_home, spawn_process = spawn }) {
  const dirs = pi_home(service_home);
  for (const path of Object.values(dirs)) mkdirSync(path, { recursive: true });
  const existing = session_file(dirs.sessions, binding.session_id);
  const session_id = existing ? binding.session_id : randomUUID();
  const args = [cli, '--mode', 'rpc', '--no-builtin-tools', '--no-context-files', '--no-skills', '--no-prompt-templates',
    '--no-themes', '--no-mcp', '--no-approve', '-e', EXTENSION, '--session-dir', dirs.sessions,
    ...(existing ? ['--session', existing] : ['--session-id', session_id]),
    '--provider', PI_PROVIDER, '--model', profile.model, ...(pi_thinking(profile) ? ['--thinking', pi_thinking(profile)] : []),
    '--system-prompt', system_file];
  // Pi tells the model its working directory, so it is the project root our file tools resolve relative paths against;
  // without a project, Pi's own directory. Never the room's: Windows cannot remove a running process's directory.
  const child = tree_killable(spawn_process(process.execPath, args, { cwd: project_root || dirs.agent, windowsHide: true, shell: false,
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PI_CODING_AGENT_DIR: dirs.agent, PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0', PI_OFFLINE: '1', CODISCUSS_PI_CONTEXT: context_file, CODISCUSS_PI_KEY: key } }));
  const log_path = resolve(task.directory, `api-${task.id}.log`);
  const redact = text => (key ? String(text).replaceAll(key, '[已隐藏]') : String(text));
  // An upstream error can echo the key back and the log is shown to the owner, so it never holds the key. A room
  // deleted while Pi still writes takes its directory along; that output is dropped.
  const log = text => {
    try { task.on_output?.(log_path, redact(text)); } catch { /* The room's directory is gone. */ }
  };
  const state = { running: true, terminal: false, stopped: false, failure: '', reminded: false, used_tools: false,
    turns: 0, last_text: '', last_error: '', diagnostic: '', tools: new Map() };
  const handle = new EventEmitter();
  const send = value => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(value)}\n`); };
  const finish = () => {
    child.stdin.end();
    setTimeout(() => child.kill(), EXIT_GRACE_MS).unref();
  };
  const fail = reason => { if (!state.failure) state.failure = reason; };
  handle.kill = () => {
    state.stopped = true;
    send({ type: 'abort' });
    setTimeout(() => child.kill(), STOP_GRACE_MS).unref();
    return true;
  };
  const heartbeat = setInterval(() => {
    const running = [...state.tools.values()].at(-1);
    if (running) task.on_activity?.(WRITE_TOOLS.includes(running.name) ? 'editing' : 'tool', running.name);
  }, TOOL_HEARTBEAT_MS);
  heartbeat.unref();
  on_records(child.stdout, line => {
    const event = json(line);
    if (!event) return;
    if (event.type !== 'message_update') log(`${line}\n`);
    handle_event(event);
  });
  function handle_event(event) {
    if (event.type === 'response' && event.success === false) fail(`Pi 拒绝了 ${event.command} 命令：${event.error || ''}`);
    else if (event.type === 'turn_start') {
      state.turns += 1;
      if (max_requests && state.turns > max_requests) {
        fail(`API 执行超过 ${max_requests} 次模型请求，已停止并保留原文；可在「成员与设置 → 协作设置」调高上限`);
        send({ type: 'abort' });
      } else task.on_activity?.('thinking');
    } else if (event.type === 'tool_execution_start') {
      state.used_tools = true;
      state.tools.set(event.toolCallId, { name: String(event.toolName || ''), args: event.args || {} });
      task.on_activity?.(WRITE_TOOLS.includes(event.toolName) ? 'editing' : 'tool', String(event.toolName || ''));
    } else if (event.type === 'tool_execution_end') {
      const call = state.tools.get(event.toolCallId);
      state.tools.delete(event.toolCallId);
      const outcome = event.result?.details?.codiscuss || {};
      if (outcome.fatal) fail(outcome.fatal);
      if (outcome.terminal && !state.terminal) {
        state.terminal = true;
        // An interjection still queued would make the model answer again after its answer was saved.
        send({ type: 'clear_queue' });
      }
      if (call && WRITE_TOOLS.includes(call.name) && !event.isError && typeof call.args.file_path === 'string' && project_root) {
        task.on_edits?.([resolve(project_root, call.args.file_path)]);
      }
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const text = (event.message.content || []).filter(part => part?.type === 'text').map(part => part.text || '').join('').trim();
      if (text) { state.last_text = text; task.on_note?.(text); }
      state.last_error = event.message.stopReason === 'error' ? String(event.message.errorMessage || '模型请求失败') : '';
    } else if (event.type === 'agent_settled') settled(event);
  }
  function settled(event) {
    if (event.aborted || state.terminal || state.failure) return finish();
    if (state.last_error) { fail(`模型请求失败：${state.last_error}`); return finish(); }
    // Some models answer in plain text mid-run; one reminder avoids pausing on a recoverable slip.
    if (!state.reminded) {
      state.reminded = true;
      return send({ type: 'prompt', message: NO_TOOL_REMINDER });
    }
    const reply = state.last_text.slice(0, REPLY_EXCERPT_CHARS);
    fail(state.used_tools ? `模型未提交结果就结束了本次执行，可能在等你决定或补充${reply ? `。模型说明：${reply}` : ''}`
      : `模型未调用房间工具保存结果，请核对模型是否支持工具调用${reply ? `（其回复：${reply}）` : ''}`);
    finish();
  }
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    state.diagnostic = (state.diagnostic + chunk).slice(-DIAGNOSTIC_CHARS);
    log(chunk);
  });
  child.stdin.on('error', () => { /* The process has gone; its close reports why. */ });
  child.once('error', error => fail(`无法启动 Pi：${error.message}`));
  child.once('close', code => {
    clearInterval(heartbeat);
    state.running = false;
    if (!state.stopped && !state.terminal && !state.failure) fail(`Pi 未保存回答就退出了（退出码 ${code}）：${state.diagnostic.trim()}`);
    if (state.failure && !state.stopped) task.on_failure?.(redact(state.failure));
    handle.emit('close', 0);
    task.on_exit?.();
  });
  task.on_binding?.(session_id);
  task.on_process?.(handle);
  send({ type: 'prompt', message: prompt });
  const steer = text => {
    if (!state.running || state.terminal) return false;
    send({ type: 'steer', message: `用户插话：${text}` });
    return true;
  };
  return { status: 'accepted', session_id, capabilities: API_CALL, steer };
}

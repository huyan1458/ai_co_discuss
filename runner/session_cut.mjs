/**
 * Branch a member's software session so a rewound or forked room continues from an earlier point. The original
 * session is never changed: Claude forks through its own CLI on the next turn (--fork-session), Codex through its app
 * server's thread/fork, and agy by copying its conversation database. Each execution's prompt names its task file
 * (`free-<id>.task.json`), which marks where that execution entered the session.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

const FORK_TIMEOUT_MS = 60_000;
// Software whose session this machine can branch; the website lists taken-back executions only for these members.
export const BRANCHABLE_ADAPTERS = ['claude', 'codex', 'codex_cli', 'antigravity_cli'];

/** The task file name an execution's prompt carries. */
export const execution_marker = id => `free-${id}.task.json`;

/** Where each software keeps one session, or '' when this machine has none by that ID. */
function session_path(adapter, session_id, env, home) {
  if (adapter === 'claude') {
    const projects = join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects');
    if (!existsSync(projects)) return '';
    return readdirSync(projects).map(dir => join(projects, dir, `${session_id}.jsonl`)).find(existsSync) || '';
  }
  if (adapter === 'codex_cli') {
    const sessions = join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
    if (!existsSync(sessions)) return '';
    const found = readdirSync(sessions, { recursive: true }).map(String).find(path => path.endsWith(`-${session_id}.jsonl`));
    return found ? join(sessions, found) : '';
  }
  const file = join(home, '.gemini', 'antigravity-cli', 'conversations', `${session_id}.db`);
  return existsSync(file) ? file : '';
}

/** Whether a session exists on this machine, e.g. to tell if a pending Claude fork already happened. */
export function session_exists(adapter, session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(adapter, session_id, env, home));
}

/** JSON lines of a session log; lines the software wrote in another shape are skipped. */
function log_entries(file) {
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** The text of a prompt as the software stored it: a string, or text parts (tool results carry no prompt). */
function prompt_text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => ['text', 'input_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
}

const marked = (text, markers) => markers.some(marker => text.includes(marker));

/** Claude: fork on the next turn at the last answer before the first marked prompt; a cut before any answer starts anew. */
function claude_branch(session_id, markers, always, env, home) {
  const file = session_path('claude', session_id, env, home);
  if (!file) throw new Error(`本机找不到 Claude 会话 ${session_id}`);
  const entries = log_entries(file);
  const index = entries.findIndex(entry => entry.type === 'user' && marked(prompt_text(entry.message?.content), markers));
  if (index < 0) return always ? { session_id: randomUUID(), fork: { from: session_id, at: '' } } : null;
  const at = entries.slice(0, index).findLast(entry => entry.type === 'assistant' && entry.uuid)?.uuid;
  return at ? { session_id: randomUUID(), fork: { from: session_id, at } } : { session_id: '' };
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

/** Codex: fork through the turn before the first marked one; a cut at the first turn starts anew. */
async function codex_branch(profile, session_id, markers, always, env, home, spawn_process) {
  const file = session_path('codex_cli', session_id, env, home);
  if (!file) throw new Error(`本机找不到 Codex 会话 ${session_id}`);
  const { turns, cut } = codex_turns(file, markers);
  if (cut < 0 && !always) return null;
  if (cut === 0) return { session_id: '' };
  return { session_id: await codex_fork(profile, session_id, cut > 0 ? turns[cut - 1] : '', spawn_process) };
}

/** agy: copy the conversation database under a new ID, without the steps from the first marked one on. */
function agy_branch(session_id, markers, always, home) {
  const file = session_path('antigravity_cli', session_id, process.env, home);
  if (!file) throw new Error(`本机找不到 agy 会话 ${session_id}`);
  const encoded = markers.map(marker => Buffer.from(marker, 'utf8'));
  const source = new DatabaseSync(file, { readOnly: true });
  const target = join(file, '..', `${randomUUID()}.db`);
  let cut;
  try {
    // The prompt is stored inside the step's protobuf payload, as UTF-8 text.
    cut = source.prepare('SELECT idx,step_payload FROM steps ORDER BY idx').all()
      .find(row => row.step_payload && encoded.some(marker => Buffer.from(row.step_payload).includes(marker)))?.idx;
    if (cut === undefined && !always) return null;
    if (cut === 0) return { session_id: '' };
    source.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally { source.close(); }
  const id = target.slice(-39, -3);
  const copy = new DatabaseSync(target);
  try {
    if (cut !== undefined) copy.prepare('DELETE FROM steps WHERE idx>=?').run(cut);
    copy.prepare('UPDATE trajectory_meta SET cascade_id=?').run(id);
  } finally { copy.close(); }
  return { session_id: id };
}

/**
 * Branch a session before the first of some taken-back executions it contains, leaving the original untouched.
 *
 * @param {object} profile The member's local software profile (`adapter`, `executable`).
 * @param {string} session_id The session the member is bound to.
 * @param {number[]} executions Execution IDs whose turns the branch must not contain.
 * @param {object} options `always` branches even when none of them is in the session (a forked room needs its own copy).
 * @returns {Promise<null|{session_id: string, fork?: {from: string, at: string}}>} null when nothing needs cutting;
 *   an empty session_id starts a new conversation; `fork` asks Claude's next turn to fork into session_id.
 */
export async function branch_session(profile, session_id, executions, { always = false, env = process.env, home = homedir(), spawn_process = spawn } = {}) {
  const markers = executions.map(execution_marker);
  if (profile.adapter === 'claude') return claude_branch(session_id, markers, always, env, home);
  // A Codex App chat is stored like a CLI one; the App loads the fork when the first message is sent to it.
  if (['codex', 'codex_cli'].includes(profile.adapter)) return codex_branch(profile, session_id, markers, always, env, home, spawn_process);
  if (profile.adapter === 'antigravity_cli') return agy_branch(session_id, markers, always, home);
  throw new Error(`${profile.adapter} 的会话不能由本机截断`);
}

/**
 * Antigravity App adapter: each task is written as a request file for the CoDiscuss Sidecar the App runs
 * (`antigravity_sidecar.mjs`), which starts the turn in the App; its receipt is read back on a later check. The turn runs
 * inside the App, so the runner can neither stop it nor see its progress. Conversations are read through the agy adapter.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic_json } from '../files.mjs';
import { antigravity_project, database_settings } from './antigravity_cli.mjs';
import { bind_access, not_sent } from './common.mjs';

const IN_APP = { stoppable: false, progress: false };

/** Queue one immutable request for the official App-managed Sidecar. */
async function deliver(config, binding, task) {
  if (!task.id.startsWith('free-')) throw new Error('Sidecar 只支持自由协作执行请求，旧讨论事件已停用');
  const directory = resolve(config.ipc_directory);
  try {
    mkdirSync(directory, { recursive: true });
    const ready = JSON.parse(readFileSync(join(directory, 'ready.json'), 'utf8'));
    // Only a new conversation is created in the Sidecar's project; an existing one is reached from any project.
    if (!binding.session_id && (config.project_id || config.project_name || config.cwd)) {
      const project = antigravity_project(config);
      if (ready.project_id !== project.id) throw new Error('Sidecar 所属项目与配置不符，请先运行 setup-sidecar');
    }
    try { process.kill(ready.pid, 0); } catch { throw new Error('Antigravity Sidecar 尚未运行'); }
    if (binding.session_id) bind_access(task.access_path, binding.session_id);
  } catch (error) { throw not_sent(error); }
  const path = join(directory, `${task.id}.request.json`);
  if (existsSync(path)) throw new Error('Sidecar 请求已存在；必须核对回执，不自动重复发送');
  atomic_json(path, { id: task.id, mode: 'free',
    event_id: Number(task.id.replace(/^free-/, '')), prompt: task.prompt,
    session_id: binding.session_id || '', access_path: task.access_path });
  return { session_id: binding.session_id || '', status: 'sidecar_pending', capabilities: IN_APP };
}

/** The App keeps its own conversation store, apart from agy's. */
function session_path(session_id, env = process.env, home = homedir()) {
  const file = join(home, '.gemini', 'antigravity', 'conversations', `${session_id}.db`);
  return existsSync(file) ? file : '';
}

/** Whether the App stored a conversation by that ID on this machine. */
function session_exists(session_id, { env = process.env, home = homedir() } = {}) {
  return Boolean(session_id && session_path(session_id, env, home));
}

/** Read a Sidecar's durable receipt for one task without resubmitting an uncertain request; null until it answers. */
function receipt(config, id) {
  const path = join(resolve(config.ipc_directory), `${id}.result.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Explicitly install an App-managed Sidecar; preserve unrelated application settings. */
export function setup_sidecar(config, root = join(homedir(), '.gemini', 'config')) {
  const project = antigravity_project(config, root);
  const directory = resolve(config.ipc_directory);
  mkdirSync(directory, { recursive: true });
  const id = `codiscuss-${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`;
  const sidecar = join(root, 'sidecars', id);
  mkdirSync(sidecar, { recursive: true });
  // Installed Sidecars keep this entry path, so it stays at runner/discussion_sidecar.mjs.
  atomic_json(join(sidecar, 'sidecar.json'), { command: process.execPath,
    args: [fileURLToPath(new URL('../discussion_sidecar.mjs', import.meta.url))], restart_policy: 'on-failure',
    display_name: 'CoDiscuss', env: { CODISCUSS_IPC_DIRECTORY: directory } });
  const path = join(root, 'config.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // App 2.23 upgrades legacy entries by cloning their project. Use its observed current
  // schema so the explicitly selected existing project remains the actual destination.
  atomic_json(path, { ...current, sidecars: { ...current.sidecars,
    [id]: { ...current.sidecars?.[id], enabled: true, projectId: project.id, schemaVersion: 1 } } });
  return { sidecar_id: id, project_id: project.id, cwd: config.cwd || null };
}

/** Antigravity App's behaviour; its static facts are in profiles.mjs. */
export const antigravity = {
  id: 'antigravity',
  validate(participant) {
    if (!participant.ipc_directory) throw new Error('缺少 Antigravity Sidecar IPC 目录');
  },
  // Explicit install of the Sidecar the App runs for this member (the setup-sidecar command).
  setup: setup_sidecar,
  deliver, receipt,
  // The App's conversations are read like agy's for the model they ran with; they cannot be branched from here.
  session: { path: session_path, exists: session_exists, owns: session_exists, branch: null,
    settings: (id, { env = process.env, home = homedir() } = {}) => database_settings(session_path(id, env, home)) },
  models: null,
};

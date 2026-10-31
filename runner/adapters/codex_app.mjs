/**
 * Codex App adapter: tasks go into a chat of the running Codex desktop, through its app-tools pipe or `codex queue`.
 * The turn runs inside the App, so the runner can neither stop it nor see its progress. Threads are stored like the
 * CLI's, so sessions and models come from the Codex CLI adapter.
 */
import { CodexAppClient } from './codex_app_client.mjs';
import { branch, desktop_thread, session_exists, session_path, session_settings } from './codex_cli.mjs';
import { bind_access, CALL_TIMEOUT_MS, not_sent, run_program, same_path } from './common.mjs';

// The desktop has no stop or interrupt tool (its tool list, checked 2026-10-30), and the turn's output stays in the App.
const IN_APP = { stoppable: false, progress: false };

/** Match the real saved project and its directory; a prompt cannot grant file access. */
export async function codex_target(app, config) {
  if (!config.project_id && !config.project_name && !config.cwd) return { type: 'projectless' };
  const projects = (await app.list_projects(config.source_thread_id)).filter(item => item.hostId === 'local');
  const matching = projects.filter(item => (!config.project_id || item.projectId === config.project_id)
    && (!config.project_name || item.label === config.project_name)
    && (!config.cwd || same_path(item.path, config.cwd)));
  if (matching.length !== 1) throw new Error('Codex 项目与 cwd 无法唯一匹配；请先在 App 添加该目录，核对 project_id/project_name/cwd');
  return { type: 'project', projectId: matching[0].projectId, environment: { type: 'local' } };
}

/** Whether the running App has not loaded a chat; when the App cannot tell, the queue is used as before. */
async function unloaded(config, thread_id) {
  const app = new CodexAppClient(config.pipe_path);
  try { await app.open(); return await app.thread_status(thread_id) === 'notLoaded'; }
  catch { return false; }
  finally { app.close(); }
}

/** Deliver one task to Codex's real App, with the original chat reused afterward. */
async function deliver(config, binding, task) {
  if (binding.session_id) {
    try { bind_access(task.access_path, binding.session_id); }
    catch (error) { throw not_sent(error); }
    // `codex queue` reaches only a chat the App has loaded; a fork made after a rewind, or a chat after the App restarted,
    // is not loaded until a message is sent through the App itself (tested on App tools, 2026-10).
    if (await unloaded(config, binding.session_id)) {
      const app = new CodexAppClient(config.pipe_path);
      try { await app.open(); await app.send_message(binding.session_id, task.prompt); }
      finally { app.close(); }
      return { session_id: binding.session_id, status: 'accepted', capabilities: IN_APP };
    }
    const receipt = await run_program(config.executable, ['queue', '--thread', binding.session_id, '--message', task.prompt], { timeout: CALL_TIMEOUT_MS });
    return { session_id: binding.session_id, status: 'accepted', receipt, capabilities: IN_APP };
  }
  const app = new CodexAppClient(config.pipe_path);
  try {
    let target;
    try { await app.open(); target = await codex_target(app, config); }
    catch (error) { throw not_sent(error); }
    const result = await app.create_thread(config.source_thread_id, task.prompt, `CoDiscuss · ${task.participant}`, target);
    task.on_binding(result.thread_id);
    bind_access(task.access_path, result.thread_id);
    return { session_id: result.thread_id, status: 'accepted', capabilities: IN_APP };
  } finally { app.close(); }
}

/** Codex App's behaviour; its static facts are in profiles.mjs. */
export const codex = {
  id: 'codex',
  /** A new chat is created from an actual source chat in the App. */
  validate(participant) {
    if (!participant.source_thread_id && !participant.session_id) throw new Error('Codex 新建入口需要实际来源聊天 ID');
  },
  deliver,
  session: { path: session_path, exists: session_exists, owns: desktop_thread, branch, settings: session_settings },
  models: null,
};

/**
 * The adapter layer's only entry for the rest of the runner. Each supported software has two parts:
 *
 * - its static facts in `profiles.mjs` (label, platform, config fields, efforts, access levels, capabilities), plain data
 *   the web page reads as well;
 * - its behaviour in its own module, a descriptor with the same shape for every software:
 *   - `deliver(config, binding, task, spawn_process, user_home)` → `{session_id, status, capabilities}`, where
 *     `capabilities` `{stoppable, progress}` says what this one delivery can do;
 *   - `session`: `{path, exists, branch, settings}` for the software's own session store, or null;
 *   - `models`: `{list, effort?, defaults}` read from the installed software, or null when it is chosen inside the App;
 *   - optional `receipt(config, id)` for deliveries confirmed later (`status: 'sidecar_pending'`),
 *     `into_window(profile, binding)` (this delivery goes into the member's own open window) and `cleanup(directory)`
 *     (remove what a deleted room left in the software).
 *
 * `adapter_of` merges the two. The room runner, launch settings and the website use these, never a software name
 * (AGENTS.md red line 9).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { antigravity } from './antigravity_app.mjs';
import { antigravity_cli } from './antigravity_cli.mjs';
import { api } from './api.mjs';
import { claude } from './claude.mjs';
import { codex } from './codex_app.mjs';
import { codex_cli } from './codex_cli.mjs';
import { execution_marker, MODEL_PATTERN } from './common.mjs';
import { adapter_capabilities, adapter_profile, ADAPTER_IDS } from './profiles.mjs';

export { execution_marker };
export { adapter_capabilities as capabilities_of };

export const ADAPTERS = Object.fromEntries([codex_cli, codex, claude, antigravity_cli, antigravity, api]
  .map(behaviour => [behaviour.id, { ...adapter_profile(behaviour.id), ...behaviour }]));
const SESSION_PATTERN = /^[0-9A-Za-z_-]{8,128}$/;

/** The descriptor of a configured adapter, or null for a value this version does not support. */
export function adapter_of(id) { return ADAPTERS[id] || null; }

/**
 * Which adapter holds an existing conversation of the software a manual member registered with (`client`): the one
 * whose store owns it, else the CLI that would resume it. '' when no adapter takes over that software.
 */
export function adoption_adapter(client, session_id, options = {}) {
  const candidates = Object.values(ADAPTERS).filter(adapter => adapter.client === client && adapter.adopt);
  return (candidates.find(adapter => adapter.session?.owns?.(session_id, options))
    || candidates.find(adapter => adapter.kind === 'cli') || candidates[0])?.id || '';
}

/** Check one configured software member: a supported adapter, its installed software located, and what it alone requires. */
export function validate_participant(participant) {
  const adapter = adapter_of(participant.adapter);
  if (!adapter) throw new Error(`适配器只能为 ${ADAPTER_IDS.join('/')}`);
  if (adapter.location === 'executable' && !existsSync(participant.executable ?? '')) throw new Error('请指定实际原生可执行文件');
  adapter.validate?.(participant);
}

/** Remove what a deleted room's members left inside their software, e.g. agy's private projects. */
export function cleanup_room(directory) {
  for (const adapter of Object.values(ADAPTERS)) adapter.cleanup?.(directory);
}

/** Deliver one task through its member's adapter; only allowlisted adapters run. */
export async function deliver_task(config, binding, task, spawn_process = spawn, user_home = homedir()) {
  const adapter = adapter_of(config.adapter);
  if (!adapter) throw new Error('不支持的软件适配器');
  return adapter.deliver(config, binding, task, spawn_process, user_home);
}

/** A delivery's later receipt (`status: 'sidecar_pending'`), or null while none has arrived. */
export function delivery_receipt(config, id) {
  return adapter_of(config.adapter)?.receipt?.(config, id) ?? null;
}

/** Read a persisted delivery, including the delivery names written by the pre-capability runner. */
export function stored_delivery(value) {
  const legacy = { process: { stoppable: true, progress: true }, api: { stoppable: true, progress: true },
    window: { stoppable: false, progress: false }, app: { stoppable: false, progress: false }, sidecar: { stoppable: false, progress: false } };
  return Object.hasOwn(legacy, value) ? legacy[value] : JSON.parse(value);
}

/** Adapters whose sessions this machine can cut or branch; the website lists taken-back executions only for these. */
export const BRANCHABLE_ADAPTERS = Object.values(ADAPTERS).filter(adapter => adapter.session?.branch).map(adapter => adapter.id);

/** Whether a session exists on this machine, e.g. to tell if a pending Claude fork already happened. */
export function session_exists(adapter_id, session_id, options = {}) {
  return Boolean(adapter_of(adapter_id)?.session?.exists(session_id, options));
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
  const branch = adapter_of(profile.adapter)?.session?.branch;
  if (!branch) throw new Error(`${profile.adapter} 的会话不能由本机截断`);
  return branch(profile, session_id, executions.map(execution_marker), { always, env, home, spawn_process });
}

/**
 * The model and effort a session last ran with, read from the software's own session store; no AI turn is started.
 * These are each software's internal formats, so anything unreadable yields empty strings rather than an error.
 */
export function session_settings(adapter_id, session_id, options = {}) {
  const none = { model: '', effort: '' };
  if (typeof session_id !== 'string' || !SESSION_PATTERN.test(session_id)) return none;
  try { return adapter_of(adapter_id)?.session?.settings(session_id, options) || none; }
  catch { return none; }
}

/** Public model metadata only; failures leave the original-software default available to the UI. */
export async function software_models(profile, options = {}) {
  const adapter = adapter_of(profile.adapter);
  const result = { adapter: profile.adapter, models: [], source: adapter?.catalog_source || 'original-software' };
  if (!adapter?.models) return { ...result, error: '此入口的模型在原软件内设置' };
  if (typeof profile.executable !== 'string' || !isAbsolute(profile.executable)) return { ...result, error: '请先配置 CLI 的完整路径，再读取模型列表' };
  try {
    const models = (await adapter.models.list(profile, options)).filter(Boolean);
    result.models = [...new Map(models.map(model => [model.id, model])).values()];
    if (!result.models.length) result.error = '软件未返回可选模型，请检查版本、登录与网络；仍可使用软件默认模型';
  } catch (error) { result.error = error.message; }
  return result;
}

/** The effort levels the software offers for the selected model, where it can tell without an agent turn. */
export async function software_effort(profile, options = {}) {
  const effort = adapter_of(profile.adapter)?.models?.effort;
  if (!effort || !isAbsolute(profile.executable || '') || (profile.model && !MODEL_PATTERN.test(profile.model))) return { error: '无法读取所选模型的思考档位' };
  try { return { levels: await effort(profile, options) }; }
  catch { return { error: '无法读取原生思考档位；保留 CLI 默认值，或检查软件版本后重试' }; }
}

/** What a CLI runs with when the card leaves model or effort empty. */
export async function software_defaults(profile, options = {}) {
  return (await adapter_of(profile.adapter)?.models?.defaults(profile, options)) || { model: '', effort: '' };
}

/** What a destroyed room leaves on this computer: its members' AI sessions, removed through the adapters, and the report. */
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { account_space } from './account_space.mjs';
import { remove_session, session_holder } from './adapters/index.mjs';

/**
 * The draft folder made for a room when it was created without a project (a folder directly in the account's draft
 * space, named after the room), or '' when the room works in a project, which is the user's and stays.
 */
export function room_draft_space(home, config) {
  const cwd = config?.cwd ? resolve(config.cwd) : '';
  return cwd && dirname(cwd) === resolve(account_space(home).workspace) ? cwd : '';
}

/**
 * Remove a destroyed room's own draft folder unless another room
 * registered here still works in it. Returns receipt items (none when the room had no draft folder).
 *
 * @param {string} home The service home.
 * @param {object} config The room's configuration (`cwd`).
 * @param {Set<string>} used Folders (resolved) other registered rooms work in.
 */
export function destroy_draft_space(home, config, used) {
  const folder = room_draft_space(home, config);
  if (!folder || !existsSync(folder)) return [];
  if (used.has(folder)) return [{ kind: 'draft_space', state: 'kept', detail: 'shared' }];
  try { rmSync(folder, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Checked below. */ }
  return [{ kind: 'draft_space', state: existsSync(folder) ? 'failed' : 'deleted' }];
}

/** The session each member of a room was bound to, from the room's runtime records; empty when it never ran here. */
export function room_bindings(directory) {
  const file = join(directory || '', 'runtime.sqlite3');
  if (!directory || !existsSync(file)) return {};
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bindings'").get()) return {};
    return Object.fromEntries(db.prepare('SELECT participant,session_id FROM bindings').all().map(row => [row.participant, row.session_id]));
  } finally { db.close(); }
}

/**
 * Remove the AI sessions a destroyed room created on this computer and describe the result as receipt items.
 *
 * A session the member was invited with (borrowed from the user), one another registered room still uses, or one the
 * software's own window owns is kept and counted as kept: it was never only this room's. Each session is removed by the
 * software that actually holds it, so a member whose software changed, or one removed from the room, is covered too;
 * a removed member that joined with a session of the user's keeps all of them, as its original can no longer be told apart.
 *
 * @param {object} config The room's validated configuration (`participants`, `directory`).
 * @param {Set<string>} used Session IDs other registered rooms on this computer use.
 * @param {object} options `env` and `home` of the software's user, for tests.
 * @param {{name: string, ids: string[], borrowed: boolean, removed: boolean}[]} executed Every session ID each member
 *   (one entry per member, so a removed member and a newcomer of the same name stay apart) ran in, from the website
 *   (a rewind rebinds a member to a new session and leaves the earlier one behind), whether it joined with a session of
 *   the user's, and whether it was removed.
 * @returns {object[]} Receipt items `{kind, state, adapter?, count?, detail?}` for the website.
 */
export function destroy_room_sessions(config, used, options = {}, executed = []) {
  const bound = room_bindings(config.directory);
  const by_adapter = new Map(), stores = new Set();
  let kept = 0;
  const participants = config.participants || {};
  // The present members' bindings, then each member's executed sessions; a removed member answers to no profile.
  const candidates = [...Object.entries(participants).filter(([name]) => bound[name]).map(([name, profile]) => ({ profile, session_id: bound[name], borrowed: false })),
    ...(Array.isArray(executed) ? executed : []).flatMap(entry => entry.ids.map(session_id =>
      ({ profile: entry.removed ? undefined : participants[entry.name], session_id, borrowed: entry.removed && entry.borrowed })))];
  const seen = new Set();
  for (const { profile, session_id, borrowed } of candidates) {
    if (seen.has(session_id)) continue;
    seen.add(session_id);
    const adapter = session_holder(session_id, profile?.adapter, options);
    if (!adapter) continue;
    // A removed member that joined with the user's session may have worked in that original itself: all of it stays.
    if (session_id === profile?.session_id || used.has(session_id) || borrowed) { kept += 1; continue; }
    const result = remove_session(adapter, session_id, options);
    if (result.state === 'kept' || result.state === 'unsupported') { kept += 1; continue; }
    // A session that never reached this computer, or is already gone, has nothing to count.
    if (result.state === 'deleted' && !result.removed) continue;
    const entry = by_adapter.get(adapter) || { deleted: 0, failed: 0 };
    entry[result.state === 'failed' ? 'failed' : 'deleted'] += 1;
    by_adapter.set(adapter, entry);
    for (const store of result.kept || []) stores.add(`${adapter}:${store}`);
  }
  const items = [...by_adapter].map(([adapter, entry]) => ({ kind: 'sessions', adapter, state: entry.failed ? 'failed' : 'deleted',
    count: entry.deleted }));
  if (kept) items.push({ kind: 'kept_sessions', state: 'kept', count: kept });
  for (const store of stores) {
    const [adapter, detail] = store.split(':');
    items.push({ kind: 'software_stores', adapter, state: 'kept', detail });
  }
  return items;
}

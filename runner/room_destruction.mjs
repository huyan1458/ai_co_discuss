/** What a destroyed room leaves on this computer: its members' AI sessions, removed through the adapters, and the report. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { remove_session } from './adapters/index.mjs';

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
 * software's own window owns is kept and counted as kept: it was never only this room's.
 *
 * @param {object} config The room's validated configuration (`participants`, `directory`).
 * @param {Set<string>} used Session IDs other registered rooms on this computer use.
 * @param {object} options `env` and `home` of the software's user, for tests.
 * @param {Object<string, string[]>} executed Every session ID each member ran in, from the website: a rewind rebinds a
 *   member to a new session and leaves the earlier one behind.
 * @returns {object[]} Receipt items `{kind, state, adapter?, count?, detail?}` for the website.
 */
export function destroy_room_sessions(config, used, options = {}, executed = {}) {
  const bound = room_bindings(config.directory);
  const by_adapter = new Map(), stores = new Set();
  let kept = 0;
  const candidates = Object.entries(config.participants || {}).flatMap(([name, profile]) =>
    [...new Set([bound[name], ...(executed[name] || [])].filter(Boolean))].map(session_id => [profile, session_id]));
  for (const [profile, session_id] of candidates) {
    if (!profile?.adapter) continue;
    if (session_id === profile.session_id || used.has(session_id)) { kept += 1; continue; }
    const result = remove_session(profile.adapter, session_id, options);
    if (result.state === 'kept' || result.state === 'unsupported') { kept += 1; continue; }
    // A session that never reached this computer, or is already gone, has nothing to count.
    if (result.state === 'deleted' && !result.removed) continue;
    const entry = by_adapter.get(profile.adapter) || { deleted: 0, failed: 0 };
    entry[result.state === 'failed' ? 'failed' : 'deleted'] += 1;
    by_adapter.set(profile.adapter, entry);
    for (const store of result.kept || []) stores.add(`${profile.adapter}:${store}`);
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

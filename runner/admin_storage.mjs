/** Storage details and explicit scratch cleanup for the computer's administrator. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { drafts_root } from './account_space.mjs';
import { DatabaseSync } from 'node:sqlite';
import { service_drafts } from './discussion_runner.mjs';
import { read_registry } from './discussion_service.mjs';
import { t } from './i18n.mjs';
import { member_drafts, reclaim_failed_scratch } from './free_runner.mjs';
import { speech_model_directories } from './speech_directories.mjs';
import { storage_disk, measure, DRAFT_LIMIT, HOME_LIMIT, HOME_WARN, LOG_TAIL, MAX_SCAN_FILES,
  ROOM_DRAFT_LIMIT, SCRATCH_PRESSURE_RATIO } from './storage_guard.mjs';

function registered_rooms(home) {
  const rooms = new Map();
  let unreadable = 0;
  for (const path of read_registry(home)) {
    try {
      const config = JSON.parse(readFileSync(path, 'utf8'));
      const directory = resolve(config.data_directory || join(dirname(path), 'discussion-' + config.room));
      const draft_directory = service_drafts(home, directory);
      const members = new Map(Object.keys(config.members || config.participants || {}).map(name =>
        [basename(member_drafts({ draft_directory }, name)), config.participants?.[name]?.label || name]));
      rooms.set(basename(draft_directory), { room_id: config.room, site: config.site, directory, draft_directory, members });
    } catch { unreadable++; }
  }
  return { rooms, unreadable };
}

/** Index only durable cleanup receipts. Directory names alone never establish eligibility. */
function candidates(registry) {
  const paths = new Map();
  for (const config of registry.rooms.values()) {
    const database = join(config.directory, 'runtime.sqlite3');
    if (!existsSync(database)) continue;
    let db;
    try {
      db = new DatabaseSync(database, { readOnly: true });
      for (const row of db.prepare("SELECT key,value FROM metadata WHERE key LIKE 'failed-scratch:%'").all()) {
        const { member, id } = JSON.parse(row.value);
        if (typeof member !== 'string' || !Number.isSafeInteger(id) || id <= 0) continue;
        const directory = member_drafts(config, member);
        paths.set(join(directory, '.scratch', String(id)), { key: row.key, config, member: basename(directory), bytes: 0 });
      }
    } catch { registry.unreadable++; }
    finally { db?.close(); }
  }
  return paths;
}

/** Report logical byte counts, including unmatched historic room/member keys without reading any draft content. */
export async function storage_details(home) {
  const registry = registered_rooms(home);
  const locations = speech_model_directories(home);
  const scratch = candidates(registry);
  const drafts = drafts_root(home);
  const snapshot = await measure(home, { members: true, drafts_root: drafts, scratch, exclude_paths: locations.map(item => item.path) });
  for (const item of scratch.values()) {
    const usage = item.config.cleanable ||= new Map();
    usage.set(item.member, (usage.get(item.member) || 0) + item.bytes);
  }
  const models = [];
  for (const location of locations) {
    const result = await measure(location.path, { model_dirs: [] });
    models.push({ ...location, name: location.program, bytes: result.total_bytes, truncated: result.truncated, unreadable: result.unreadable });
  }
  const rooms = [...new Set([...registry.rooms.keys(), ...Object.keys(snapshot.rooms)])].map(key => {
    const config = registry.rooms.get(key);
    const totals = snapshot.members?.[key] || {};
    const members = [...new Set([...(config?.members.keys() || []), ...Object.keys(totals)])].map(key =>
      ({ key, name: config?.members.get(key) || key, bytes: totals[key] || 0, scratch_bytes: config?.cleanable?.get(key) || 0 }));
    return { key, room_id: config?.room_id || '', site: config?.site || '', bytes: snapshot.rooms[key] || 0,
      scratch_bytes: members.reduce((sum, member) => sum + member.scratch_bytes, 0),
      unreadable: snapshot.room_unreadable?.[key] || 0, members };
  });
  return { total_bytes: snapshot.total_bytes, draft_bytes: snapshot.draft_bytes, local_bytes: snapshot.local_bytes || 0, rooms, models,
    model_bytes: models.reduce((sum, model) => sum + model.bytes, 0), disk: storage_disk(home, drafts),
    limits: { home_limit_bytes: HOME_LIMIT, home_warn_bytes: HOME_WARN, draft_bytes: DRAFT_LIMIT, room_draft_bytes: ROOM_DRAFT_LIMIT,
      warn_ratio: SCRATCH_PRESSURE_RATIO, log_bytes: LOG_TAIL, max_scan_files: MAX_SCAN_FILES },
    unreadable: snapshot.unreadable + registry.unreadable + models.reduce((sum, model) => sum + model.unreadable, 0),
    truncated: snapshot.truncated || models.some(model => model.truncated) };
}

/** Drain the same confirmed-ended records as pressure cleanup. Never infer eligibility from an on-disk name. */
export async function clean_storage(home, filter = {}) {
  const registry = registered_rooms(home);
  if (!filter || typeof filter !== 'object' || Array.isArray(filter) ||
      Object.entries(filter).some(([key, value]) => !['room_id', 'room_key'].includes(key) || typeof value !== 'string' || !value))
    throw new Error(t('存储清理范围无效'));
  for (const [key, config] of registry.rooms) {
    if ((filter.room_key && filter.room_key !== key) || (filter.room_id && filter.room_id !== config.room_id)) registry.rooms.delete(key);
  }
  const scratch = candidates(registry);
  if (scratch.size) await measure(drafts_root(home), { model_dirs: [], scratch });
  let removed = 0, freed_bytes = 0, failed = registry.unreadable;
  for (const item of scratch.values()) {
    let db;
    try {
      db = new DatabaseSync(join(item.config.directory, 'runtime.sqlite3'));
      db.exec('PRAGMA busy_timeout=1000');
      if (reclaim_failed_scratch(db, item.config, item.key)) { removed++; freed_bytes += item.bytes; }
    } catch { failed++; }
    finally { db?.close(); }
  }
  return { removed, freed_bytes, failed };
}

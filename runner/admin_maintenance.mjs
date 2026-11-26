import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storage_details, clean_storage } from './admin_storage.mjs';
import { execution_file_protection, read_registry, sweep_service_home } from './discussion_service.mjs';
import { t } from './i18n.mjs';
import { with_directory_breakdown } from './storage_guard.mjs';

function local_database(home, action) {
  const path = join(home, 'local', 'discuss.sqlite3');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try { action(db); } finally { db.close(); }
}

function matches_site(site, local) {
  const url = new URL(site);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.href === new URL(local).href;
}

/** Return management-panel usage with disjoint directory totals and local room titles. */
export async function panel_storage(home, local) {
  const report = await with_directory_breakdown(() => storage_details(home));
  try {
    local_database(home, db => {
      const title = db.prepare('SELECT title FROM rooms WHERE id=?');
      for (const room of report.rooms) if (room.site && matches_site(room.site, local)) room.title = title.get(room.room_id)?.title;
    });
  } catch { /* A room ID remains available when titles cannot be read. */ }
  return report;
}

function account_file(path, apply, result) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1) return;
  if (apply) unlinkSync(path);
  result.removed++;
  result.freed_bytes += stat.size;
}

function room_files(config, folder, ended, options, result) {
  const root = resolve(config.data_directory || join(folder, 'discussion-' + config.room));
  if (relative(root, realpathSync.native(root)) || !existsSync(join(root, 'runtime.sqlite3'))) { result.failed++; return; }
  const protected_files = execution_file_protection(root, options.db, config.room);
  const ids = new Set(ended.all(config.room, options.cutoff).map(row => row.id));
  for (const id of protected_files.ids) ids.delete(id);
  const members = join(root, 'members'), folders = [root];
  if (lstatSync(members, { throwIfNoEntry: false })?.isDirectory())
    for (const entry of readdirSync(members, { withFileTypes: true })) if (entry.isDirectory() && !protected_files.members.has(entry.name)) folders.push(join(members, entry.name));
  for (const dir of folders) for (const name of readdirSync(dir)) {
    const match = /^(?:[a-z_0-9]+-)?free-(\d+)\.(log|task\.json|access\.json)$/.exec(name);
    if (!match || !ids.has(Number(match[1])) || (options.logs && match[2] !== 'log')) continue;
    try { account_file(join(dir, name), options.apply, result); } catch { result.failed++; }
  }
}

function finished_files(home, local, logs, apply) {
  const result = { removed: 0, freed_bytes: 0, failed: 0 };
  const cutoff = Math.floor(Date.now() / 1000) - (logs ? 0 : 86400);
  local_database(home, db => {
    const ended = db.prepare("SELECT id FROM member_executions WHERE room_id=? AND status IN ('completed','failed','cancelled') AND finished_at BETWEEN 1 AND ?");
    for (const path of read_registry(home)) {
      try {
        const config = JSON.parse(readFileSync(path, 'utf8'));
        if (matches_site(config.site, local)) room_files(config, dirname(path), ended, { cutoff, logs, apply, db }, result);
      } catch { result.failed++; }
    }
  });
  return result;
}

/** Clean confirmed temporary files globally, retaining scoped scratch cleanup for a single room. */
export async function panel_clean(home, local, filter = {}) {
  const result = await clean_storage(home, filter);
  if (filter.room_id || filter.room_key) return result;
  const files = finished_files(home, local, false, true);
  for (const key of Object.keys(result)) result[key] += files[key];
  const orphans = sweep_service_home(home, Date.now(), undefined, true);
  result.removed += orphans.launches.length + orphans.drafts.length;
  result.failed += orphans.failures;
  result.freed_bytes += orphans.freed_bytes;
  const cache = join(home, 'tts-cache');
  if (lstatSync(cache, { throwIfNoEntry: false })?.isDirectory())
    for (const name of readdirSync(cache)) if (/^[a-f0-9]{64}\.json$/.test(name)) {
      try { account_file(join(cache, name), true, result); } catch { result.failed++; }
    }
  return result;
}

/** Preview or explicitly confirm the removal of finished execution logs. */
export function panel_repair(home, local, body) {
  if (Object.keys(body).length && !(body.logs === true && body.confirm === true)) throw new Error(t('深度修理须同时指定 logs 与 confirm。'));
  return finished_files(home, local, true, body.confirm === true);
}

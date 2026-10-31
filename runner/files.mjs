/** Small private files the runner keeps on this machine. */
import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

/** Persist small private state atomically without logging its contents. */
export function atomic_json(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

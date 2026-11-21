/** Small private files the runner keeps on this machine. */
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

// On Windows a rename over a file another process has open (a reader polling it, an exiting service) fails for a moment
// with EPERM, EACCES or EBUSY; retry that briefly instead of failing the caller (it once stopped a hosted instance).
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_TRIES = 20;
const RENAME_WAIT_MS = 50;

/** Persist small private state atomically without logging its contents. */
export function atomic_json(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 1; ; attempt += 1) {
    try { return renameSync(temporary, path); }
    catch (error) {
      if (!RENAME_BUSY.has(error.code) || attempt >= RENAME_TRIES) {
        rmSync(temporary, { force: true });
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAIT_MS);
    }
  }
}

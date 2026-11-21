/** The admin panel's bounded restart policy for hosted instances. Times in the journal are Unix milliseconds. */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

const WINDOW_MS = 600_000, BASE_DELAY_MS = 60_000, MAX_ATTEMPTS = 3;
const JOURNAL = 'instance-recovery.json';
const refused = () => ({ template: '实例端口拒绝连接', params: {} });

function read(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function save(path, name, row) {
  const records = read(path);
  if (row) records[name] = row;
  else delete records[name];
  atomic_json(path, records);
}
function log(data, name, at, message) {
  appendFileSync(join(data, 'admin-panel.log'), `${new Date(at).toISOString()} [${name}] ${message}\n`, { mode: 0o600 });
}

/** Track one in-flight operation per account and keep restart budgets across panel restarts. */
export function instance_recovery(data, { wanted, probe, start, on_block, now = Date.now }) {
  const path = join(data, JOURNAL), pending = new Map(), manual = new Map();
  async function inspect(name) {
    const port = wanted(name), row = read(path)[name] || {};
    if (!port) return;
    if (row.blocked) { on_block?.(name); return; }
    if (await probe(port) !== 'down' || manual.has(name) || wanted(name) !== port) return;
    const at = now(), attempts = (row.attempts || []).filter(time => at - time < WINDOW_MS);
    if (attempts.length >= MAX_ATTEMPTS) {
      save(path, name, { ...row, blocked: true, error: refused() });
      log(data, name, now(), t('实例再次退出，自动重启已达上限。'));
      on_block?.(name);
      return;
    }
    if (attempts.length && at - attempts.at(-1) < BASE_DELAY_MS * 2 ** (attempts.length - 1)) return;
    attempts.push(at);
    const attempt = { attempts, at, reason: refused(), result: 'starting', blocked: false };
    save(path, name, attempt);
    log(data, name, now(), t('实例端口拒绝连接，正在自动重启（第 {count} 次）。', { count: attempts.length }));
    try {
      await start(name);
      attempt.result = 'started';
    } catch (error) {
      attempt.error = error.error_text || { template: error.message, params: {} };
      attempt.result = 'failed';
      attempt.blocked = attempts.length === MAX_ATTEMPTS;
    }
    save(path, name, attempt);
    if (attempt.blocked) on_block?.(name);
    log(data, name, now(), attempt.error ? t('自动重启失败：{reason}', { reason: t(attempt.error.template, attempt.error.params) }) : t('实例已自动重启。'));
  }
  return {
    status() { return read(path); },
    check(name) {
      if (!pending.has(name) && !manual.has(name)) {
        pending.set(name, inspect(name).finally(() => pending.delete(name)));
      }
      return pending.get(name);
    },
    manage(name, action, run) {
      const preceding = manual.get(name) || pending.get(name);
      const operation = Promise.resolve(preceding).catch(() => {}).then(async () => {
        const previous = read(path)[name];
        if (['start', 'stop'].includes(action) && previous) save(path, name, { ...previous, attempts: [], blocked: false });
        const result = await run();
        if (action === 'remove') save(path, name, null);
        return result;
      }).finally(() => { if (manual.get(name) === operation) manual.delete(name); });
      manual.set(name, operation);
      return operation;
    },
  };
}

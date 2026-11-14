#!/usr/bin/env node
/**
 * Install a new codiscuss version for the management panel's update button, from outside the package folder.
 *
 * npm replaces a global package by renaming its folder, which Windows refuses (EBUSY) while any process runs from it,
 * the panel included. So the panel stops what runs from the package, copies this file into the service directory, starts
 * it from there and exits. This waits for the panel to exit, installs, records the result in the update record and starts
 * the installed panel, which finishes the remaining steps. Only Node built-ins and no imports of the package: the package
 * folder is replaced while this runs.
 *
 * Usage: node panel_updater.mjs --data DIR --pid PANEL_PID --panel ADMIN_PANEL_SCRIPT --port PORT
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

// Shared with admin_panel.mjs (this file cannot import it).
const JOB_FILE = 'panel-update.json';
const NPM_PACKAGE = 'ai_co_discuss';
const EXIT_WAIT_MS = 30_000;
const POLL_MS = 300;
// Windows may keep a folder busy a moment after its last process exits (an antivirus scan, for one).
const INSTALL_ATTEMPTS = 3;
const RETRY_MS = 3000;
const OUTPUT_LIMIT = 4000;

const sleep = ms => new Promise(done => setTimeout(done, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Run npm to its end; fails with the last lines of its output. */
function npm(args, cwd) {
  return new Promise((done, fail) => {
    // npm is a .cmd on Windows, which only a shell runs.
    const child = spawn('npm', args, { cwd, shell: process.platform === 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-OUTPUT_LIMIT); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-OUTPUT_LIMIT); });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`npm ${args.join(' ')} 失败（退出码 ${code}）：${output.trim().split(/\r?\n/).slice(-3).join(' ')}`)));
  });
}

async function main() {
  const { values } = parseArgs({ options: { data: { type: 'string' }, pid: { type: 'string' }, panel: { type: 'string' }, port: { type: 'string' } } });
  const job_path = join(values.data, JOB_FILE);
  const job = JSON.parse(readFileSync(job_path, 'utf8'));
  const save = change => writeFileSync(job_path, JSON.stringify(Object.assign(job, change)), { mode: 0o600 });
  for (let waited = 0; waited < EXIT_WAIT_MS && alive(Number(values.pid)); waited += POLL_MS) await sleep(POLL_MS);
  let failure = null;
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    // --prefer-online: the version was just read from the registry, while npm's cached package list may predate it
    // (a fresh release fails with "notarget" until the cache expires).
    try { await npm(['install', '--global', '--prefer-online', `${NPM_PACKAGE}@${job.version}`], values.data); failure = null; break; }
    catch (error) { failure = error; if (attempt < INSTALL_ATTEMPTS) await sleep(RETRY_MS); }
  }
  save(failure ? { status: 'install_failed', steps: [...job.steps, `安装失败：${failure.message}`] }
    : { status: 'installed', steps: [...job.steps, `已安装 v${job.version}`] });
  // The installed panel (the old one when npm failed) takes over the open window's key and sessions from the environment.
  spawn(process.execPath, [values.panel, 'start', '--data', values.data, '--port', values.port],
    { cwd: values.data, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

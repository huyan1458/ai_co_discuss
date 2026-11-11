/**
 * The Pi harness that runs model API members (adapters/api_pi.mjs), kept by codiscuss itself in the service directory
 * so the user never installs it. The release is the one this codiscuss version was tested with: package.json pins it as
 * the dev dependency the tests run, so upgrading Pi is changing that one version and releasing codiscuss (2026-11-11,
 * the user chose a pinned release over following Pi's latest). `setup` installs it, the service installs it when a
 * codiscuss upgrade pins another, and the first API execution installs it if neither could. A release becomes current
 * only after it starts and answers in RPC mode; otherwise the one in use stays. Pi is a separate program the runner
 * spawns, never imported (AGENTS.md red line 7), and it is not part of the codiscuss package.
 *
 * Layout: `<service home>/pi/runtime/<version>/` holds one npm install; `current.json` names the release in use.
 * `CODISCUSS_PI_CLI` overrides all of it (tests, a hand-built Pi).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic_json } from './files.mjs';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
const CLI_PATH = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'];
// The tested release; the only place its version is written.
export const PI_VERSION = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).devDependencies[PI_PACKAGE];
const NPM_TIMEOUT_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 30_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const runtime_root = home => join(home, 'pi', 'runtime');
const current_file = home => join(runtime_root(home), 'current.json');
const cli_of = directory => join(directory, ...CLI_PATH);

function read_current(home) {
  try { return JSON.parse(readFileSync(current_file(home), 'utf8')); } catch { return {}; }
}

/** The npm CLI script of this Node, run with this Node so no shell or Windows `.cmd` shim is involved. */
function npm_entry() {
  const entry = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    .find(path => path && /\.(?:c?js|mjs)$/.test(path) && existsSync(path));
  if (!entry) throw new Error('未找到随 Node.js 安装的 npm，无法安装 Pi');
  return entry;
}

/** Run npm without lifecycle scripts and return its standard output; an abort ends it. */
function run_npm(args, signal) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [npm_entry(), ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', fail);
    child.on('close', code => { clearTimeout(timer); code === 0 ? done(stdout.trim()) : fail(new Error(stderr.trim().split('\n').at(-1) || `npm 退出码 ${code}`)); });
  });
}

/** Start a Pi release in RPC mode, as API executions do, and require it to report its version and answer `get_state`. */
function check_release(cli, version, home) {
  return new Promise((done, fail) => {
    const agent = join(home, 'pi', 'agent');
    mkdirSync(agent, { recursive: true });
    const child = spawn(process.execPath, [cli, '--mode', 'rpc', '--no-session', '--no-builtin-tools', '--no-context-files', '--no-skills',
      '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve'], { cwd: agent, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' } });
    let output = '', answered = false;
    const timer = setTimeout(() => { child.kill(); }, CHECK_TIMEOUT_MS);
    child.stdout.on('data', data => {
      output += data;
      if (!answered && output.split('\n').some(line => { try { const reply = JSON.parse(line); return reply.id === 'check' && reply.success === true; } catch { return false; } })) {
        answered = true;
        child.stdin.end();
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', fail);
    child.on('close', () => {
      clearTimeout(timer);
      answered ? done() : fail(new Error(`Pi ${version} 没有以 RPC 方式应答，不予切换`));
    });
    child.stdin.write(`${JSON.stringify({ id: 'check', type: 'get_state' })}\n`);
  });
}

/** The Pi CLI script in use: `CODISCUSS_PI_CLI`, else the current managed release; '' when none is installed. */
export function current_pi(home, env = process.env) {
  if (env.CODISCUSS_PI_CLI) return env.CODISCUSS_PI_CLI;
  const { version } = read_current(home);
  const cli = version && VERSION.test(version) ? cli_of(join(runtime_root(home), version)) : '';
  return cli && existsSync(cli) ? cli : '';
}

/**
 * Install the pinned Pi release (or `version`) beside the current one and switch to it once it passes the check; the
 * previous release is kept for one more change, older ones removed. A failure leaves the current release in use and is
 * thrown. `npm` and `check` are replaceable for tests; `signal` ends a run in progress (the service stopping).
 * @returns {Promise<{version: string, cli: string, updated: boolean}>}
 */
export async function install_pi(home, { version = PI_VERSION, npm = run_npm, check = check_release, signal } = {}) {
  if (!VERSION.test(version || '')) throw new Error(`package.json 没有固定 Pi 的版本：${version}`);
  const root = runtime_root(home);
  mkdirSync(root, { recursive: true });
  const current = read_current(home);
  const directory = join(root, version);
  if (current.version === version && current_pi(home, {})) return { version, cli: cli_of(directory), updated: false };
  try {
    if (!existsSync(cli_of(directory))) {
      await npm(['install', '--prefix', directory, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', `${PI_PACKAGE}@${version}`], signal);
    }
    signal?.throwIfAborted();
    await check(cli_of(directory), version, home);
  } catch (error) {
    // A release that cannot run must not stay around to be picked up later.
    if (version !== current.version) rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  atomic_json(current_file(home), { version, previous: current.version || '' });
  for (const name of readdirSync(root)) {
    if (VERSION.test(name) && ![version, current.version].includes(name)) rmSync(join(root, name), { recursive: true, force: true });
  }
  return { version, cli: cli_of(directory), updated: true };
}

/** Whether the release in use differs from the one this codiscuss version pins (none installed counts). */
export function pi_outdated(home) {
  return read_current(home).version !== PI_VERSION || !current_pi(home, {});
}

let installing = null;

/** The Pi CLI script to run, installing the pinned release first when none is installed yet (once at a time). */
export async function ensure_pi(home, env = process.env) {
  const cli = current_pi(home, env);
  if (cli) return cli;
  installing ||= install_pi(home).finally(() => { installing = null; });
  try { return (await installing).cli; }
  catch (error) { throw new Error(`Pi 安装失败（API 成员由它运行）：${error.message}；请检查网络与 npm 后重试`); }
}

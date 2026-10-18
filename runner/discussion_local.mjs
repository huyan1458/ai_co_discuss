/** Own the local website and only the discussion service started by this supervisor. */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { atomic_json } from './discussion_adapters.mjs';
import { acquire_lock } from './discussion_runner.mjs';
import { main as service_main, service_home, service_pid, service_ready, start_service } from './discussion_service.mjs';
import { detect_python, local_settings } from './discussion_setup.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SERVER = fileURLToPath(new URL('../server.py', import.meta.url));
const START_WAIT_MS = 15000;
const STOP_WAIT_MS = 25000;
const POLL_MS = 200;

/** Read the website supervisor's lock and last startup receipt. */
export function local_status(home = service_home()) {
  const directory = join(home, 'local');
  const pid = service_pid(directory);
  const path = join(directory, 'status.json');
  const status = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const website_running = Boolean(pid && pid === status.pid && status.ready);
  const service = service_pid(home);
  return { ...status, website_running, running: website_running && service_ready(home, service), service_pid: service,
    service_error: service ? undefined : status.service_error, pid, home };
}

/** Wait for this Python child to bind, rather than trusting another process on the same port. */
async function wait_website(child, progress, url) {
  for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
    if (progress.error) throw progress.error;
    if (child.exitCode !== null || child.signalCode) throw new Error('本机网站启动失败，请查看 local/website.log（可能端口已占用）');
    if (progress.ready) {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok && (await response.json()).ok) return;
    }
    await sleep(POLL_MS);
  }
  throw new Error('本机网站未在 15 秒内就绪，请查看 local/website.log');
}

/** Launch the website using the configured Python and explicit package-external database. */
function website_process(home, settings, url) {
  const python = detect_python(settings.python);
  const database = join(home, 'local', 'discuss.sqlite3');
  const child = spawn(python, ['-u', SERVER, '--host', '127.0.0.1', '--port', String(settings.port || 8765),
    '--database', database, '--no-demo', '--local-launch'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PATH: `${dirname(process.execPath)}${delimiter}${dirname(python)}${delimiter}${process.env.PATH || ''}` } });
  const progress = { ready: false, error: null };
  let recent = '';
  const log = data => {
    appendFileSync(join(home, 'local', 'website.log'), data);
    recent = (recent + data.toString()).slice(-4096);
    if (recent.includes(`AI CoDiscuss ready at ${url}`)) progress.ready = true;
  };
  child.stdout.on('data', log);
  child.stderr.on('data', log);
  child.on('error', error => { progress.error = error; });
  return { child, progress, database };
}

/** Stop an owned Python child and release only the service acquired by this supervisor. */
async function close_owned(child, owned_service, home) {
  try {
    if (owned_service?.started && service_pid(home) === owned_service.pid) await service_main(['stop'], () => {});
  } finally {
    if (child?.pid && child.exitCode === null && !child.signalCode) {
      const exited = new Promise(done => child.once('exit', done));
      child.kill();
      await exited;
    }
  }
}

/** Handle explicit restart requests in the supervisor so replacement service ownership stays local. */
async function requested_service(home, status, owned_service) {
  const path = join(home, 'local', 'start.request');
  if (!existsSync(path)) return owned_service;
  unlinkSync(path);
  const status_path = join(home, 'local', 'status.json');
  try {
    const service = await start_service(home);
    if (service.started || service.pid !== owned_service?.pid) owned_service = service;
    atomic_json(status_path, { ...status, service_pid: service.pid, service_checked_at: Date.now() });
  } catch (error) {
    atomic_json(status_path, { ...status, service_error: error.message, service_checked_at: Date.now() });
  }
  return owned_service;
}

/** Run one supervisor, recording readiness and handling an explicit local stop request. */
async function supervise(home) {
  const directory = join(home, 'local');
  const release = acquire_lock(directory);
  const status_path = join(directory, 'status.json');
  const stop_path = join(directory, 'stop.request');
  const settings = local_settings(home);
  const url = `http://127.0.0.1:${settings.port || 8765}`;
  const status = { pid: process.pid, ready: false, url };
  if (existsSync(stop_path)) unlinkSync(stop_path);
  atomic_json(status_path, status);
  let website, owned_service, stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    website = website_process(home, settings, url);
    await wait_website(website.child, website.progress, url);
    owned_service = await start_service(home);
    const ready = { ...status, ready: true, database: website.database, website_pid: website.child.pid };
    atomic_json(status_path, { ...ready, service_pid: owned_service.pid });
    while (!stopped && !existsSync(stop_path) && website.child.exitCode === null && !website.child.signalCode) {
      owned_service = await requested_service(home, ready, owned_service);
      await sleep(POLL_MS);
    }
  } catch (error) { atomic_json(status_path, { ...status, error: error.message }); throw error; }
  finally {
    try { await close_owned(website?.child, owned_service, home); }
    finally {
      if (existsSync(stop_path)) unlinkSync(stop_path);
      release();
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

/** Start once in the background and return only after the website is ready. */
async function start_local(home) {
  const current = local_status(home);
  if (current.website_running && current.url !== `http://127.0.0.1:${local_settings(home).port || 8765}`) {
    throw new Error('网站端口配置已改变；请先 codiscuss local stop，再 codiscuss local open。');
  }
  if (current.running) return current;
  const directory = join(home, 'local');
  mkdirSync(directory, { recursive: true });
  const requested_at = Date.now();
  if (current.website_running) atomic_json(join(directory, 'start.request'), { requested_at });
  let spawned_pid = 0;
  if (!current.pid) {
    const log = openSync(join(directory, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [SCRIPT, 'run'], { detached: true, windowsHide: true,
      stdio: ['ignore', log, log], env: { ...process.env, DISCUSS_SERVICE_HOME: home } });
    closeSync(log);
    child.unref();
    spawned_pid = child.pid;
  }
  for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
    const status = local_status(home);
    if (status.running) return status;
    if (status.service_error && status.service_checked_at >= requested_at) throw new Error(status.service_error);
    if (status.error && (!spawned_pid || JSON.parse(readFileSync(join(directory, 'status.json'), 'utf8')).pid === spawned_pid)) throw new Error(status.error);
    await sleep(POLL_MS);
  }
  throw new Error(`本机启动未完成，请查看 ${join(directory, 'supervisor.log')}`);
}

/** Ask the owned supervisor to stop, retaining its database and user configuration. */
async function stop_local(home) {
  if (!local_status(home).pid) return local_status(home);
  const path = join(home, 'local', 'stop.request');
  atomic_json(path, { requested_at: Date.now() });
  for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_MS) {
    if (!local_status(home).pid) return local_status(home);
    await sleep(POLL_MS);
  }
  throw new Error('本机服务尚未停止，请查看 local/supervisor.log');
}

/** Open only the loopback URL returned by this website supervisor. */
function open_site(url) {
  const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  const child = spawn(command, args, { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', error => process.stderr.write(`无法打开浏览器：${error.message}；请访问 ${url}\n`));
  child.unref();
}

/** Manage local website lifecycle without changing discussion launch semantics. */
export async function local_main(args, output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const [command = 'open'] = args;
  const home = service_home();
  if (['help', '--help', '-h'].includes(command)) return output('用法：codiscuss local open|start|status|stop；数据保留在服务目录的 local/ 中。');
  if (args.length > 1 || !['open', 'start', 'status', 'stop'].includes(command)) throw new Error('用法：codiscuss local open|start|status|stop');
  const result = command === 'status' ? local_status(home) : command === 'stop' ? await stop_local(home) : await start_local(home);
  if (command === 'open') open_site(result.url);
  output(result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const operation = process.argv[2] === 'run' ? supervise(service_home()) : local_main(process.argv.slice(2));
  operation.catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

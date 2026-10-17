/** Run ONLY inside an Antigravity-managed Sidecar configured for one IPC directory. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomic_json } from './discussion_adapters.mjs';

const directory = resolve(process.env.CODISCUSS_IPC_DIRECTORY || process.cwd());
const agentapi = process.env.ANTIGRAVITY_AGENTAPI_EXE;
if (!agentapi) throw new Error('此程序必须由 Antigravity App Sidecar 启动');

/** Consume each request once; a crash after claim leaves an explicit uncertain result. */
async function process_request(name) {
  const request = JSON.parse(readFileSync(join(directory, name), 'utf8'));
  if (!/^[a-zA-Z0-9_-]+$/.test(request.id) || name !== `${request.id}.request.json`) return;
  const claim = join(directory, `${request.id}.claimed`);
  const receipt = join(directory, `${request.id}.result.json`);
  if (existsSync(claim) || existsSync(receipt)) return;
  writeFileSync(claim, String(process.pid), { flag: 'wx', mode: 0o600 });
  try {
    const access = JSON.parse(readFileSync(request.access_path, 'utf8'));
    const response = await fetch(`${access.site}/api/rooms/${access.room}/events/${request.event_id}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', 'X-Discussion-Token': access.token },
      body: JSON.stringify({ action: 'view' }),
    });
    const event = await response.json();
    if (!response.ok || event.status !== 'dispatched') throw new Error('请求已撤销或状态不明，未调用软件');
    const runtime_response = await fetch(`${access.site}/api/rooms/${access.room}/runtime`, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    const runtime = await runtime_response.json();
    if (!runtime_response.ok || runtime.status !== 'running' || runtime.deadline <= Math.floor(Date.now() / 1000)
      || event.run_id !== runtime.run_id || event.generation !== runtime.generation) throw new Error('运行已停止或到期，未调用软件');
    const args = request.session_id ? ['send-message', request.session_id, request.prompt] : ['new-conversation', request.prompt];
    const raw = execFileSync(agentapi, ['agentapi', ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    const result = JSON.parse(raw);
    const session_id = request.session_id || result.response?.newConversation?.conversationId;
    if (!session_id) throw new Error('未取得真实 conversation ID；创建结果待核对');
    atomic_json(request.access_path, { ...access, session_id });
    atomic_json(receipt, { id: request.id, session_id, status: 'accepted' });
  } catch (error) {
    atomic_json(receipt, { id: request.id, status: 'uncertain', error: String(error.message).slice(0, 500) });
  }
}

/** Scan only our own private IPC directory; this performs no model polling. */
async function scan_requests() {
  for (const name of readdirSync(directory).filter(name => name.endsWith('.request.json'))) {
    try { await process_request(name); } catch (error) { process.stderr.write(`${error.message}\n`); }
  }
}

atomic_json(join(directory, 'ready.json'), { pid: process.pid, ready_at: Date.now(), project_id: process.env.ANTIGRAVITY_PROJECT_ID || '' });
scan_requests();
setInterval(scan_requests, 1000);

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { add_account, account_home, instance_home, read_accounts } from '../gateway/gateway.mjs';
import { admin_cli } from '../runner/admin_cli.mjs';
import { create_panel } from '../runner/admin_panel.mjs';
import { grant_admin_storage } from '../runner/object_storage_signer.mjs';
import { listen_local } from './local_port.mjs';

const exec_file = promisify(execFile);
const TOKEN = 'ab'.repeat(32);
const OWNER_KEY = 'administrator-key-not-for-tenants';
const LIMIT = 1024 ** 2;
const TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function fake_center(clock) {
  const objects = new Map(), requests = [];
  let active_key = OWNER_KEY;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = data => response.end(JSON.stringify({ succeed: true, data }));
    if (request.headers['x-api-key'] !== active_key) {
      response.writeHead(403).end('{}');
      return;
    }
    requests.push(url.pathname);
    if (url.pathname === '/upload-credential') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { fileName, maxSizeBytes } = JSON.parse(Buffer.concat(chunks));
      const key = 'bound/' + fileName;
      const policy = Buffer.from(JSON.stringify({ expiration: new Date(clock() + TTL_MS).toISOString(),
        conditions: [{ key }, ['content-length-range', 1, maxSizeBytes + Number(fileName.endsWith('/unsafe'))]] })).toString('base64');
      send({ key, policy, url: 'https://cos.example.test', qAk: 'cos-account',
        qKeyTime: 'key-time', qSignature: 'signature', qSignAlgorithm: 'sha1' });
      return;
    }
    const name = url.searchParams.get('fileName');
    if (url.pathname === '/file') { objects.delete(name); send(null); return; }
    if (!objects.has(name)) { response.writeHead(404).end('{}'); return; }
    send(url.pathname === '/file-info' ? { size: objects.get(name), extra: OWNER_KEY }
      : { url: 'https://cos.example.test/download', expiresAt: 'soon', extra: OWNER_KEY });
  });
  return { server, objects, requests, rotate_key: value => { active_key = value; } };
}

async function setup(t) {
  const data = mkdtempSync(join(tmpdir(), 'storage-signer-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  mkdirSync(join(data, 'local'), { recursive: true });
  writeFileSync(join(data, 'local-settings.json'), '{"hosting":true}');
  add_account(data, 'demo');
  t.after(() => rmSync(account_home(data, 'demo'), { recursive: true, force: true }));
  const time = { now: Date.now() };
  const clock = () => time.now;
  const storage = fake_center(clock);
  await listen_local(storage.server);
  t.after(() => storage.server.close());
  const options = { data, key: 'panel-key', port: 0,
    ops: { storage_isolated: () => true, storage_token: () => TOKEN, now: clock } };
  const panel = await listen_local(create_panel(options));
  t.after(() => panel.close());
  const url = 'http://127.0.0.1:' + storage.server.address().port;
  const bind_key = async (api_key, base_url = url) => {
    const { api_key_ref } = await panel.api('POST', '/api/owner/keys', { base_url, api_key });
    await panel.api('POST', '/api/storage/object', { base_url, api_key_ref });
  };
  await bind_key(OWNER_KEY);
  const settings = await admin_cli(['storage', 'object', '--data', data, '--account', 'demo', '--use-admin', '--quota-mib', '1'], {
    client: async () => (route, body) => panel.api(body ? 'POST' : 'GET', '/api/' + route, body),
    print: output => assert.ok(!output.includes(OWNER_KEY)),
  });
  assert.equal(settings.mode, 'admin');
  assert.equal(settings.configured, true);
  assert.equal(settings.api_key_ref, '');
  assert.ok(!readFileSync(join(instance_home(data, 'demo'), 'object-storage-settings.json'), 'utf8').includes(OWNER_KEY));
  return { ...storage, options, panel, time, bind_key, url, home: instance_home(data, 'demo') };
}

async function request(panel, action, name, options = {}) {
  const { token = TOKEN, size = LIMIT, origin, account = 'demo' } = options;
  const response = await fetch('http://127.0.0.1:' + panel.address().port + '/internal/object-storage/' + action, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ account, name, size, content_type: 'application/octet-stream' }),
  });
  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes(OWNER_KEY));
  return { status: response.status, body };
}

test('administrator signer denies wrong tokens, other namespaces and unconstrained upload policies', async t => {
  const { panel, requests } = await setup(t);
  const name = 'codiscuss/demo/cloud/id/unsafe';
  assert.equal((await request(panel, 'upload-credential', name, { token: 'cd'.repeat(32) })).status, 403);
  assert.equal((await request(panel, 'upload-credential', name, { origin: 'http://evil.test' })).status, 403);
  for (const invalid of ['codiscuss/other/cloud/id/file', 'codiscuss/demo/../other/file', 'codiscuss/demo/%2e%2e/other/file',
    'codiscuss/demo//中文.txt', 'codiscuss/demo/中\\文.txt', 'codiscuss/demo/中\u0085文.txt']) {
    for (const action of ['upload-credential', 'file-info', 'presigned-download-url', 'file']) {
      assert.equal((await request(panel, action, invalid)).status, 403);
    }
  }
  assert.deepEqual(requests, []);
  assert.equal((await request(panel, 'upload-credential', name)).status, 503);
  assert.deepEqual(requests, ['/upload-credential']);
  assert.equal((await request(panel, 'upload-credential', 'codiscuss/demo/cloud/id/safe')).status, 200);
  await panel.api('POST', '/api/accounts/demo/object-storage', { mode: 'own' });
  assert.equal((await request(panel, 'file-info', name)).status, 403);
});

test('administrator signing preserves Unicode object keys in all storage operations', async t => {
  const { panel, objects } = await setup(t);
  const path = 'codiscuss/demo/cloud/id/项目 初稿 🧪 100%.pdf';
  const upload = await request(panel, 'upload-credential', path);
  assert.equal(upload.status, 200);
  assert.equal(upload.body.data.key, 'bound/' + path);
  objects.set(path, LIMIT);
  assert.deepEqual((await request(panel, 'file-info', path)).body.data, { size: LIMIT });
  assert.equal((await request(panel, 'presigned-download-url', path)).status, 200);
  assert.equal((await request(panel, 'file', path)).status, 200);
  assert.equal(objects.has(path), false);
});

test('administrator quota serializes concurrent reservations and retains signed capacity across restarts', async t => {
  const { panel, options, time, objects } = await setup(t);
  const left = 'codiscuss/demo/cloud/id/left', right = 'codiscuss/demo/cloud/id/right';
  const outcomes = await Promise.all([request(panel, 'upload-credential', left), request(panel, 'upload-credential', right)]);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  const accepted = outcomes[0].status === 200 ? left : right;
  const refused = accepted === left ? right : left;
  const restarted = await listen_local(create_panel(options));
  t.after(() => restarted.close());
  assert.equal((await request(restarted, 'upload-credential', refused)).status, 409);
  objects.set(accepted, LIMIT);
  assert.deepEqual((await request(restarted, 'file-info', accepted)).body.data, { size: LIMIT });
  assert.equal((await request(restarted, 'presigned-download-url', accepted)).body.data.expiresAt, 'soon');
  assert.equal((await request(restarted, 'file', accepted)).status, 200);
  assert.equal((await request(restarted, 'upload-credential', refused)).status, 409);
  objects.set(accepted, LIMIT); // A still-valid POST credential can recreate the object.
  time.now += TTL_MS + 1;
  await restarted.sweep_object_storage();
  assert.equal(objects.has(accepted), false);
  assert.equal((await request(restarted, 'upload-credential', refused)).status, 200);
  assert.equal((await request(restarted, 'file-info', refused)).status, 404);
  assert.equal((await request(restarted, 'upload-credential', accepted)).status, 409);
  time.now += DAY_MS;
  await restarted.sweep_object_storage();
  assert.equal((await request(restarted, 'upload-credential', accepted)).status, 200);
});

test('administrator Key rotation at the same address preserves upload access and occupied quota', async t => {
  const { panel, bind_key, rotate_key, url, requests, objects } = await setup(t);
  const original = 'codiscuss/demo/cloud/id/original', next = 'codiscuss/demo/cloud/id/next';
  const half = LIMIT / 2;
  assert.equal((await request(panel, 'upload-credential', original, { size: half })).status, 200);
  objects.set(original, half);
  assert.equal((await request(panel, 'file-info', original)).status, 200);

  const new_key = 'rotated-owner-key';
  rotate_key(new_key);
  await bind_key(new_key);
  assert.equal((await request(panel, 'presigned-download-url', original)).status, 200);
  assert.equal((await request(panel, 'upload-credential', next, { size: half })).status, 200);
  const over = await request(panel, 'upload-credential', 'codiscuss/demo/cloud/id/over', { size: 1 });
  assert.equal(over.status, 409);
  assert.equal(over.body.error_text.params.used, LIMIT);

  await bind_key(new_key, url + '/other');
  const count = requests.length;
  assert.equal((await request(panel, 'upload-credential', next, { size: half })).status, 503);
  assert.equal(requests.length, count);
});

test('the cloud storage namespace is reserved for both new accounts and legacy signer access', async t => {
  const { panel, options: { data }, requests } = await setup(t);
  const reserved = error => error.error_text?.params.name === 'cloud';
  assert.throws(() => add_account(data, 'cloud'), reserved);
  const accounts = read_accounts(data);
  writeFileSync(join(data, 'gateway-accounts.json'), JSON.stringify({ ...accounts, cloud: accounts.demo }));
  await assert.rejects(panel.api('POST', '/api/accounts/cloud/object-storage', { mode: 'admin' }), reserved);
  grant_admin_storage(data, 'cloud', true);
  assert.equal((await request(panel, 'file', 'codiscuss/cloud/id/original', { account: 'cloud' })).status, 403);
  assert.deepEqual(requests, []);
});

test('Python administrator client reports exhausted quota and a stopped signer', async t => {
  const { home, panel } = await setup(t);
  const file = join(home, 'test-token.json');
  writeFileSync(file, JSON.stringify({ account: 'demo', token: TOKEN, port: panel.address().port }));
  const script = [
    'from backend.object_storage import configured_storage, storage_http_error, StorageUnavailable',
    'client = configured_storage("rooms.sqlite")',
    'for label in ["first", "next"]:',
    '    try:',
    '        print(client.upload("codiscuss/cloud/id/" + label, 1048576, "application/octet-stream")["fields"]["key"])',
    '    except StorageUnavailable as error:',
    '        response = storage_http_error(error)',
    '        print(response.status, str(response) if response.status == 503 else "", sep=":")',
  ].join('\n');
  const env = { ...process.env, PYTHONIOENCODING: 'utf8', PYTHONDONTWRITEBYTECODE: '1',
    DISCUSS_SERVICE_HOME: home, DISCUSS_OBJECT_STORAGE_ADMIN_FILE: file };
  const run = () => exec_file(process.env.PYTHON || 'python', ['-c', script], { env, windowsHide: true });
  assert.deepEqual((await run()).stdout.trim().split(/\r?\n/), ['bound/codiscuss/demo/cloud/id/first', '409:']);
  await new Promise(resolve => panel.close(resolve));
  assert.deepEqual((await run()).stdout.trim().split(/\r?\n/),
    Array(2).fill('503:云空间暂不可用（管理员服务未运行）'));
});

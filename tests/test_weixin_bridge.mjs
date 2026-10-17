import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as create_pipe_server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CodexAppClient } from '../message_bridge.mjs';
import { dispatch_answers, flush_command_replies, flush_outbox, format_notice, process_weixin, send_notification,
  weixin_text, WeixinStore } from '../weixin_bridge.mjs';
import {
  acquire_account_lock, begin_login, complete_login, IlinkClient, IlinkError,
  load_account, parse_ilink_json, read_json, save_json, validate_base_url,
} from '../weixin_client.mjs';

const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = { account_id: 'test@im.bot', owner_id: 'owner', token: 'FAKE-TOKEN',
  base_url: 'https://ilinkai.weixin.qq.com' };
const MODULE_URL = new URL('../weixin_client.mjs', import.meta.url).href;
const PROJECTS = [
  { projectId: 'project-room', label: '灵感盒', projectKind: 'local', hostId: 'local', path: 'D:/room' },
  { projectId: 'project-discuss', label: 'ai_co_discuss', projectKind: 'local', hostId: 'local', path: 'D:/discuss' },
  { projectId: 'project-cloud', label: '云端项目', projectKind: 'chatgpt', hostId: null },
  { projectId: 'project-remote', label: '远端项目', projectKind: 'local', hostId: 'remote-host' },
];

/** Create temporary state and remove only the resolved test-owned directory. */
function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), 'weixin-bridge-test-'));
  const path = join(directory, 'state.sqlite3');
  const account_path = join(directory, 'account.json');
  const stores = [];
  const open = () => { const store = new WeixinStore(path); stores.push(store); return store; };
  context.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    if (dirname(resolve(directory)) !== resolve(tmpdir())
        || !basename(directory).startsWith('weixin-bridge-test-')) throw new Error('临时目录越界');
    rmSync(directory, { recursive: true, force: true });
  });
  return { store: open(), open, directory, path, account_path };
}

/** Build a native iLink text event. */
function incoming(id = '1', text = '中文“引号”😀\n请处理') {
  return { message_id: id, from_user_id: ACCOUNT.owner_id, to_user_id: ACCOUNT.account_id,
    message_type: 1, message_state: 2, context_token: 'FAKE-CONTEXT',
    item_list: [{ type: 1, text_item: { text } }] };
}

/** Receive a page through the same transactional entry point used by the poller. */
function receive(store, messages, cursor = 'cursor-1') {
  return store.receive(ACCOUNT, { msgs: messages, get_updates_buf: cursor });
}

/** Select no project immediately when arranging existing post-selection routing tests. */
function receive_new_messages(store, response) {
  for (const message of response.msgs) {
    store.receive_answers(ACCOUNT, { ...response, msgs: [message] });
    const picker = store.project_list(ACCOUNT);
    if (!picker || picker.raw_id !== String(message.message_id) || picker.status !== 'received') continue;
    store.save_project_list(ACCOUNT, picker.id, []);
    const notice = store.pending_outbox(ACCOUNT).find(row => JSON.parse(row.group_key)[2] === `command:${picker.id}`);
    store.claim_outbox(notice.id); store.finish_outbox(notice.id, 'api_accepted');
    store.receive_answers(ACCOUNT, { msgs: [incoming(`${message.message_id}-project-choice`, '0')] });
  }
}

/** Simulate desktop tools while retaining selected targets and operation order for assertions. */
function fake_desktop() {
  return {
    projects: structuredClone(PROJECTS), calls: [], creations: [],
    async open() {}, close() {},
    async list_projects(source) { this.calls.push(['list', source]); return this.projects; },
    async create_thread(source, prompt, title, target) {
      this.calls.push(['create', source]);
      this.creations.push({ source, prompt, title, target });
      return { thread_id: OTHER_THREAD, title };
    },
  };
}

/** Substitute only Codex execution, preserving the actual durable inbox and history matching. */
function fake_codex(reply = '已处理😀') {
  return {
    submissions: [], turns: [],
    async queue(message) {
      this.submissions.push(message);
      this.turns.unshift({ id: `turn-${this.submissions.length}`, status: 'completed', completedAt: 100,
        items: [{ type: 'userMessage', content: [{ type: 'text', text: message.prompt }] },
          { type: 'agentMessage', phase: 'commentary', text: '不能当最终回复' },
          { type: 'agentMessage', phase: 'final_answer', text: reply }] });
      return 'accepted';
    },
    async list_turns() { return { data: this.turns }; },
  };
}

/** Use real local HTTP while keeping production URL validation and request construction intact. */
async function http_fixture(context, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const record = { path: request.url, headers: request.headers, body: body ? JSON.parse(body) : null };
    requests.push(record);
    const result = handler(record, requests.length);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(typeof result === 'string' ? result : JSON.stringify(result));
  });
  await new Promise(resolve_ready => server.listen(0, '127.0.0.1', resolve_ready));
  context.after(() => new Promise(resolve_closed => { server.closeAllConnections(); server.close(resolve_closed); }));
  const local = `http://127.0.0.1:${server.address().port}`;
  const fetch_local = (url, options) => {
    assert.equal(new URL(url).hostname.endsWith('.weixin.qq.com'), true);
    assert.equal(options.redirect, 'error');
    return fetch(`${local}${new URL(url).pathname}${new URL(url).search}`, options);
  };
  return { requests, client: new IlinkClient(ACCOUNT, { fetch: fetch_local }), fetch: fetch_local };
}

test('HTTP 收件 → 持久投递 → 同轮最终回复 → HTTP 回信，正文和认证正确', async context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, '测试', THREAD, true);
  const http = await http_fixture(context, request => request.path.endsWith('/getupdates')
    ? { ret: 0, msgs: [incoming()], get_updates_buf: 'http-cursor' } : { ret: 0 });
  store.receive(ACCOUNT, await http.client.updates(store.cursor(ACCOUNT.account_id)));
  const codex = fake_codex();
  await process_weixin(store, codex, ACCOUNT);
  await flush_outbox(store, http.client, ACCOUNT);
  assert.equal(codex.submissions.length, 1);
  assert.equal(codex.submissions[0].text, incoming().item_list[0].text_item.text);
  assert.match(codex.submissions[0].prompt, /已绑定微信用户转发/);
  assert.equal(store.cursor(ACCOUNT.account_id), 'http-cursor');
  assert.equal(http.requests.length, 3);
  for (const request of http.requests) assert.equal(request.headers.authorization, 'Bearer FAKE-TOKEN');
  const final = http.requests[2].body.msg;
  assert.equal(final.to_user_id, ACCOUNT.owner_id);
  assert.equal(final.context_token, 'FAKE-CONTEXT');
  assert.equal(final.item_list[0].text_item.text, '[Codex #1 测试]\n已处理😀');
  assert.equal(store.status(ACCOUNT).outbox.every(row => row.status === 'api_accepted'), true);
});

test('未知用户、群聊、机器人、自身消息及未完成片段均不触发 Codex', context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const changes = [{ from_user_id: 'stranger' }, { group_id: 'group' }, { message_type: 2 },
    { to_user_id: 'other@im.bot' }, { message_state: 1 }];
  const count = receive(store, changes.map((change, index) => ({ ...incoming(String(index)), ...change })));
  assert.equal(count, 0);
  assert.equal(store.list().length, 0);
  assert.equal(store.pending_outbox(ACCOUNT).length, 0);
  assert.equal(store.cursor(ACCOUNT.account_id), 'cursor-1');
});

test('别名、编号和引用固定回到原聊天；未知引用不回落默认聊天', context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'first', THREAD, true);
  store.bind(ACCOUNT, 'second', OTHER_THREAD);
  receive(store, [incoming('1', '#first 开始')]);
  store.bind(ACCOUNT, 'second', OTHER_THREAD, true);
  receive(store, [incoming('2', '#1 继续')]);
  const quote = incoming('3', '补充');
  quote.item_list[0].ref_msg = { message_item: { type: 1, text_item: { text: '[Codex #1 first]\n之前回复' } } };
  receive(store, [quote]);
  quote.message_id = '4';
  quote.item_list[0].ref_msg = { svr_id: 'unknown' };
  receive(store, [quote]);
  assert.deepEqual(store.channel_messages(ACCOUNT).map(row => row.thread_id), [THREAD, THREAD, THREAD]);
  assert.equal(store.channel_messages(ACCOUNT)[2].text, '补充');
  assert.equal(store.list().some(row => row.text.includes('之前回复')), false);
});

test('没有绑定、未知别名、空路由指令和媒体只回操作提示，不调用模型', context => {
  const { store } = fixture(context);
  receive(store, [incoming('1', '无默认目标')]);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const media = incoming('4');
  media.item_list.push({ type: 2, image_item: {} });
  receive(store, [incoming('2', '#other 内容'), incoming('3', '#test'), media]);
  assert.equal(store.list().length, 0);
  assert.equal(store.pending_outbox(ACCOUNT).length, 4);
});

test('解除绑定撤销后续引用路由；重新扫码为其他用户不继承聊天授权', context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming('1', '首次')]);
  store.unbind(ACCOUNT, 'test');
  receive(store, [incoming('2', '#1 再次')]);
  assert.equal(store.list().length, 1);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const other = { ...ACCOUNT, owner_id: 'different-scanner' };
  assert.deepEqual(store.bindings(other), []);
  assert.deepEqual(store.channel_messages(other), []);
});

test('重复收件及数据库重开不重复投递或回信，游标与关联保持', async context => {
  const { store, open } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming()]);
  const codex = fake_codex();
  await process_weixin(store, codex, ACCOUNT);
  const sends = [];
  await flush_outbox(store, { async send(value) { sends.push(value); } }, ACCOUNT);
  store.close();
  const restarted = open();
  assert.equal(receive(restarted, [incoming()], 'cursor-2'), 0);
  await process_weixin(restarted, codex, ACCOUNT);
  await flush_outbox(restarted, { async send(value) { sends.push(value); } }, ACCOUNT);
  assert.equal(codex.submissions.length, 1);
  assert.equal(sends.length, 2);
  assert.equal(restarted.cursor(ACCOUNT.account_id), 'cursor-2');
});

test('批次中途落库失败，来信、回信与游标一起回滚', context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const original_enqueue = store.enqueue.bind(store);
  let calls = 0;
  store.enqueue = message => {
    if (++calls === 2) throw new Error('模拟磁盘写入失败');
    return original_enqueue(message);
  };
  assert.throws(() => receive(store, [incoming('1'), incoming('2')]), /写入失败/);
  assert.equal(store.cursor(ACCOUNT.account_id), '');
  assert.equal(store.list().length, 0);
  assert.equal(store.pending_outbox(ACCOUNT).length, 0);
  store.enqueue = original_enqueue;
  assert.equal(receive(store, [incoming('1'), incoming('2')]), 2);
});

test('并行数据库收件和发送的原子领取只允许一次', async context => {
  const { store, open } = fixture(context);
  const competing = open();
  store.bind(ACCOUNT, 'test', THREAD, true);
  assert.equal(receive(store, [incoming()]), 1);
  assert.equal(receive(competing, [incoming()]), 0);
  let calls = 0;
  const client = { async send() { calls++; } };
  await Promise.all([flush_outbox(store, client, ACCOUNT), flush_outbox(competing, client, ACCOUNT)]);
  assert.equal(calls, 1);
});

test('微信已收请求但回执丢失：重启保留 uncertain，绝不自动重发', async context => {
  const { store, open } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming()]);
  let calls = 0;
  const client = { async send() { calls++; throw new Error('丢失回执，FAKE-TOKEN'); } };
  await flush_outbox(store, client, ACCOUNT);
  store.close();
  const restarted = open();
  await flush_outbox(restarted, client, ACCOUNT);
  assert.equal(calls, 1);
  assert.equal(restarted.status(ACCOUNT).outbox[0].status, 'uncertain');
  assert.equal(JSON.stringify(restarted.status(ACCOUNT)).includes('FAKE-TOKEN'), false);
});

test('缺失上下文时等待，新来信恢复最新 token；显式登录过期可在重登后继续', async context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const message = incoming();
  delete message.context_token;
  receive(store, [message]);
  assert.equal(store.pending_outbox(ACCOUNT).length, 0);
  receive(store, [{ ...message, context_token: 'NEW-CONTEXT' }]);
  await assert.rejects(flush_outbox(store, { async send() { throw new IlinkError('过期', -14); } }, ACCOUNT), /过期/);
  assert.equal(store.status(ACCOUNT).outbox[0].status, 'pending');
  const sent = [];
  await flush_outbox(store, { async send(value) { sent.push(value); } }, ACCOUNT);
  assert.equal(sent[0].context_token, 'NEW-CONTEXT');
  assert.equal(store.status(ACCOUNT).outbox[0].status, 'api_accepted');
});

test('长回复按 Unicode 分段且每段带归属；首段不确定时后段不会乱序发送', async context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming()]);
  const reply = '中文😀'.repeat(1_000);
  await process_weixin(store, fake_codex(reply), ACCOUNT);
  const sent = [];
  const sender = { async send(value) { sent.push(value); } };
  while (store.pending_outbox(ACCOUNT).length) await flush_outbox(store, sender, ACCOUNT);
  const final = sent.slice(1);
  assert.equal(final.map(value => value.text.replace(/^\[Codex #1 test\]\n/, '')).join(''), reply);
  assert.equal(final.every(value => Buffer.byteLength(value.text) <= 3_500 && value.text.startsWith('[Codex #1 test]')), true);
  store.add_outbox(ACCOUNT, 'extra-long', reply);
  let attempts = 0;
  const failing = { async send() { attempts++; throw new Error('network'); } };
  await flush_outbox(store, failing, ACCOUNT);
  await flush_outbox(store, failing, ACCOUNT);
  assert.equal(attempts, 1);
});

test('接收 uint64 消息编号不舍入，独立长编号不会互相误去重', context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  const one = parse_ilink_json('{"message_id":9007199254740992}');
  const two = parse_ilink_json('{"message_id":9007199254740993}');
  assert.equal(two.message_id, '9007199254740993');
  receive(store, [incoming(one.message_id), incoming(two.message_id)]);
  assert.equal(store.list().length, 2);
});

test('入队后迟迟未开始仅提醒一次，后续完成仍能回信，不重投队列', async context => {
  const { store } = fixture(context);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming()]);
  const message = store.channel_messages(ACCOUNT)[0];
  store.claim(message.message_id, null);
  store.accepted(message.message_id, 'queue-receipt');
  store.db.prepare('UPDATE bridge_messages SET updated_at=? WHERE message_id=?')
    .run(Date.now() - 61_000, message.message_id);
  store.prepare_replies(ACCOUNT);
  store.prepare_replies(ACCOUNT);
  assert.equal(store.pending_outbox(ACCOUNT).length, 2);
  assert.match(store.pending_outbox(ACCOUNT)[1].text, /尚未观察到开始/);
  const codex = fake_codex('最终完成');
  await codex.queue(message);
  codex.submissions.length = 0;
  await process_weixin(store, codex, ACCOUNT);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.pending_outbox(ACCOUNT).length, 3);
  assert.match(store.pending_outbox(ACCOUNT)[2].text, /最终完成/);
});

test('请求拒绝不泄露服务端正文；未知成功格式保留待核查', async context => {
  const http = await http_fixture(context, () => ({ ret: -2, errmsg: 'FAKE-TOKEN must never log' }));
  await assert.rejects(http.client.send({ peer_id: 'owner', client_id: 'id', text: '文字', context_token: 'ctx' }), error => {
    assert.equal(error.code, -2);
    assert.equal(error.message.includes('FAKE-TOKEN'), false);
    return true;
  });
  const empty = new IlinkClient(ACCOUNT, { fetch: async () => new Response('{}') });
  await assert.rejects(empty.send({}), /明确成功回执/);
});

test('微信真实成功格式仅返回 message_id 时确认受理；非零错误仍优先拒绝', async context => {
  const http = await http_fixture(context, () => '{"message_id":9007199254740993}');
  const result = await http.client.send({ peer_id: 'owner', client_id: 'id', text: '文字', context_token: 'ctx' });
  assert.equal(result.message_id, '9007199254740993');
  const failure = new IlinkClient(ACCOUNT, { fetch: async () => new Response('{"ret":-2,"message_id":"id"}') });
  await assert.rejects(failure.send({}), error => error.code === -2);
});

test('登录生成本地 PNG，支持手机验证码和重启后继续，不输出凭据', async context => {
  const { account_path } = fixture(context);
  const started = await begin_login(account_path, { client: { async create_qr() {
    return { qrcode: 'FAKE-QR', qrcode_img_content: 'https://example.test/scan' };
  } } });
  assert.equal(readFileSync(started.qr_path).subarray(1, 4).toString(), 'PNG');
  assert.equal(existsSync(account_path), false);
  const waiting = await complete_login(account_path, { client: { async qr_status() {
    return { status: 'need_verifycode' };
  } } });
  assert.equal(waiting.status, 'need_verifycode');
  const confirmed = await complete_login(account_path, { verify_code: '123456', client: { async qr_status(login, code) {
    assert.equal(login.qrcode, 'FAKE-QR');
    assert.equal(code, '123456');
    return { status: 'confirmed', bot_token: ACCOUNT.token, ilink_bot_id: ACCOUNT.account_id,
      ilink_user_id: ACCOUNT.owner_id, baseurl: ACCOUNT.base_url };
  } } });
  assert.equal(confirmed.status, 'connected');
  assert.equal(JSON.stringify(confirmed).includes(ACCOUNT.token), false);
  assert.deepEqual(load_account(account_path), ACCOUNT);
});

test('登录没有扫码身份不启用；恶意重定向不会携带 token 访问其他主机', async context => {
  const { account_path } = fixture(context);
  save_json(`${account_path}.login.json`, { qrcode: 'qr', base_url: ACCOUNT.base_url, created_at: Date.now() });
  await assert.rejects(complete_login(account_path, { client: { async qr_status() {
    return { status: 'confirmed', bot_token: 'secret', ilink_bot_id: ACCOUNT.account_id };
  } } }), /扫码用户/);
  assert.equal(existsSync(account_path), false);
  await assert.rejects(complete_login(account_path, { client: { async qr_status() {
    return { status: 'scaned_but_redirect', redirect_host: 'attacker.test' };
  } } }), /受信任/);
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://localhost', 'https://ilinkai.weixin.qq.com.evil.test',
    'https://secret@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com/path']) {
    assert.throws(() => validate_base_url(url));
  }
});

test('QR 首次请求不带 Authorization，查询正确保留验证码参数', async context => {
  const http = await http_fixture(context, () => ({ status: 'wait' }));
  await http.client.create_qr('PREVIOUS-FAKE-TOKEN');
  await http.client.qr_status({ qrcode: 'a+b&c', base_url: ACCOUNT.base_url }, '1234');
  assert.equal(http.requests[0].headers.authorization, undefined);
  assert.equal(http.requests[0].path, '/ilink/bot/get_bot_qrcode?bot_type=3');
  assert.deepEqual(http.requests[0].body.local_token_list, ['PREVIOUS-FAKE-TOKEN']);
  const query = new URL(http.requests[1].path, ACCOUNT.base_url).searchParams;
  assert.equal(query.get('qrcode'), 'a+b&c');
  assert.equal(query.get('verify_code'), '1234');
});

test('操作系统锁拒绝第二个进程，持有者异常退出后能恢复', context => {
  const { account_path } = fixture(context);
  const unlock = acquire_account_lock(account_path);
  const script = `import {acquire_account_lock} from ${JSON.stringify(MODULE_URL)};
    try {acquire_account_lock(process.argv[1]);process.stdout.write('acquired');}
    catch {process.stdout.write('locked');}`;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '-e', script, account_path], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(run().stdout, 'locked');
  unlock();
  assert.equal(run().stdout, 'acquired');
  const recovered = acquire_account_lock(account_path);
  recovered();
});

test('独立 CLI 状态查询不输出账号 token 或上下文凭据，原模拟表仍可读取', context => {
  const { store, path, account_path } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.bind(ACCOUNT, 'test', THREAD, true);
  receive(store, [incoming()]);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../weixin_bridge.mjs', import.meta.url)),
    'status', '--state', path, '--account', account_path], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('FAKE-TOKEN'), false);
  assert.equal(result.stdout.includes('FAKE-CONTEXT'), false);
  assert.equal(JSON.parse(result.stdout).inbox.length, 1);
  assert.equal(read_json(account_path).token, 'FAKE-TOKEN');
});

test('主动通知无需绑定聊天，只发指定正文，不处理旧回信或 Codex 历史', async context => {
  const { store } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  store.add_outbox(ACCOUNT, 'old-pending', '不能补发的旧回信');
  const http = await http_fixture(context, () => ({ message_id: 'notice-receipt' }));
  const request = { message_id: 'notice-0001', text: '任务完成\n中文“引号”😀 & $()' };
  const result = await send_notification(store, http.client, ACCOUNT, request);
  assert.equal(result.status, 'api_accepted');
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].body.msg.to_user_id, ACCOUNT.owner_id);
  assert.equal(http.requests[0].body.msg.item_list[0].text_item.text, request.text);
  assert.equal(store.bindings(ACCOUNT).length, 0);
  assert.equal(store.list().length, 0);
  assert.equal(store.pending_outbox(ACCOUNT).length, 1);
  assert.equal(JSON.stringify(result).includes('FAKE-'), false);
});

test('通知按编号去重且持久化；并行、重启和重复调用只发送一次', async context => {
  const { store, open } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const competing = open();
  let calls = 0;
  const client = { async send() { calls++; } };
  const request = { message_id: 'notice-0002', text: '只通知一次' };
  await Promise.all([send_notification(store, client, ACCOUNT, request),
    send_notification(competing, client, ACCOUNT, request)]);
  store.close();
  const restarted = open();
  assert.equal((await send_notification(restarted, client, ACCOUNT, request)).status, 'api_accepted');
  await assert.rejects(send_notification(restarted, client, ACCOUNT, { ...request, text: '不同正文' }), /正文不同/);
  assert.equal(calls, 1);
});

test('通知回执丢失不会在再次调用或重启后自动重发', async context => {
  const { store, open } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  let calls = 0;
  const client = { async send() { calls++; throw new Error('FAKE-TOKEN 连接断开'); } };
  const request = { message_id: 'notice-0003', text: '不确定结果' };
  assert.equal((await send_notification(store, client, ACCOUNT, request)).status, 'uncertain');
  store.close();
  const result = await send_notification(open(), client, ACCOUNT, request);
  assert.equal(result.status, 'uncertain');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result).includes('FAKE-TOKEN'), false);
});

test('通知上下文只接受扫码用户；一次同步不路由或执行来信', async context => {
  const { store } = fixture(context);
  const request = { message_id: 'notice-0004', text: '等待上下文' };
  const sent = [];
  const client = { async send(message) { sent.push(message); } };
  assert.equal((await send_notification(store, client, ACCOUNT, request)).status, 'waiting_context');
  const changes = [{ from_user_id: 'stranger' }, { group_id: 'group' }, { message_type: 2 },
    { message_state: 1 }, { to_user_id: 'another-bot' }, { context_token: '' }];
  store.receive_context(ACCOUNT, { msgs: changes.map(change => ({ ...incoming(), ...change })) });
  assert.equal(store.notification_status(ACCOUNT).context_available, false);
  store.receive_context(ACCOUNT, { msgs: [incoming('fresh', '#测试 不可执行')], get_updates_buf: 'fresh-cursor' });
  assert.equal((await send_notification(store, client, ACCOUNT, request)).status, 'api_accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].context_token, 'FAKE-CONTEXT');
  assert.equal(store.cursor(ACCOUNT.account_id), 'fresh-cursor');
  assert.equal(store.list().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_inbox').get().count, 0);
  assert.equal(store.notification_status({ ...ACCOUNT, owner_id: 'other-user' }).context_available, false);
});

test('明确拒绝保留 failed；登录过期可在恢复后沿用编号重试', async context => {
  const { store } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const request = { message_id: 'notice-0005', text: '恢复测试' };
  let calls = 0;
  const rejected = { async send() { calls++; throw new IlinkError('拒绝', -2); } };
  assert.equal((await send_notification(store, rejected, ACCOUNT, request)).status, 'failed');
  await send_notification(store, rejected, ACCOUNT, request);
  assert.equal(calls, 1);
  const other = { ...request, message_id: 'notice-0006' };
  const expired = { async send() { throw new IlinkError('过期', -14); } };
  assert.equal((await send_notification(store, expired, ACCOUNT, other)).status, 'pending');
  const accepted = { async send() { calls++; } };
  assert.equal((await send_notification(store, accepted, ACCOUNT, other)).status, 'api_accepted');
  assert.equal(calls, 2);
});

test('通知输入校验在发送前完成，UTF-8上限不截断正文', async context => {
  const { store } = fixture(context);
  const client = { async send() { assert.fail('无效输入不能发送'); } };
  for (const text of ['', '  ', '😀'.repeat(876)]) {
    await assert.rejects(send_notification(store, client, ACCOUNT, { message_id: 'notice-0007', text }), /正文/);
  }
  await assert.rejects(send_notification(store, client, ACCOUNT, { message_id: 'short', text: '内容' }), /message-id/);
  store.prepare_notification(ACCOUNT, 'notice-0007', '😀'.repeat(875));
  assert.equal(Buffer.byteLength(store.notification(ACCOUNT, 'notice-0007').text), 3500);
});

test('收件进程持锁时通知 CLI 仍能发送UTF-8文件并退出，无需 Codex', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  store.db.prepare("INSERT INTO weixin_listeners VALUES (?,?,'running')").run(ACCOUNT.account_id, process.pid);
  const release_receiver = acquire_account_lock(account_path);
  const text_path = join(directory, '通知 正文.txt');
  const captured_path = join(directory, 'request.json');
  const text = '任务完成\n中文“引号”😀 & $()';
  writeFileSync(text_path, `\uFEFF${text}`, 'utf8');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    globalThis.fetch=async (url,options)=>{
      if(!url.endsWith('/sendmessage')) throw new Error('意外请求');
      writeFileSync(process.argv[2],options.body);
      return new Response('{"message_id":"accepted"}');
    };
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const args = ['notify', '--account', account_path, '--state', path, '--message-id', 'notice-cli-001',
    '--text-file', text_path, '--title', '测试通知', '--codex', join(directory, 'must-not-start.exe')];
  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args), captured_path],
      { encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, CODEX_THREAD_ID: THREAD } });
  } finally { release_receiver(); }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'api_accepted');
  assert.equal(read_json(captured_path).msg.item_list[0].text_item.text, `💬 Codex（测试通知）：\n\n${text}`);
  assert.equal(result.stdout.includes('FAKE-'), false);
});

test('发送无需收件锁，但 sync 仍拒绝第二个收件者', context => {
  const { path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  const release_receiver = acquire_account_lock(account_path);
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const script = `import {main} from ${JSON.stringify(module_url)};
    globalThis.fetch=async()=>{process.stdout.write('unexpected_network'); throw new Error('意外请求');};
    try {await main(JSON.parse(process.argv[1])); process.exitCode=1;}
    catch(error) {process.stdout.write(error.message);}`;
  const args = ['sync', '--account', account_path, '--state', path,
    '--codex', join(directory, 'must-not-start.exe')];
  let result;
  try {
    result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } finally { release_receiver(); }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /已有/);
  assert.equal(result.stdout.includes('unexpected_network'), false);
});

/** Prepare one sent question without a network call. */
function sent_question(store, message_id = 'question-0001', thread_id = THREAD) {
  const title = thread_id === THREAD ? '测试聊天' : '另一个聊天';
  const text = store.prepare_question(ACCOUNT, { message_id, thread_id, title, text: '请选择下一步。' });
  const notice = store.notification(ACCOUNT, message_id);
  store.claim_outbox(notice.id);
  store.finish_outbox(notice.id, 'api_accepted');
  return text;
}

test('skill 提问经 HTTP 发出，微信正文只经 queue 返回来源聊天，不读取历史', async context => {
  const { store } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const text = store.prepare_question(ACCOUNT, { message_id: 'question-http', thread_id: THREAD, text: '继续吗？' });
  const http = await http_fixture(context, request => request.path.endsWith('/getupdates')
    ? { ret: 0, msgs: [incoming('reply-http', '继续\n保留“中文”😀 & $()')], get_updates_buf: 'reply-cursor' }
    : { message_id: 'accepted-question' });
  assert.equal((await send_notification(store, http.client, ACCOUNT, { message_id: 'question-http', text })).status,
    'api_accepted');
  store.receive_answers(ACCOUNT, await http.client.updates(store.cursor(ACCOUNT.account_id)));
  const queued = [];
  await dispatch_answers(store, { async queue(message) { queued.push(message); return 'native-queue-receipt'; } }, ACCOUNT);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].thread_id, THREAD);
  assert.equal(queued[0].prompt, '[微信] 请用 $weixin-notify 回复。\n\n继续\n保留“中文”😀 & $()');
  assert.equal(store.reply_status(ACCOUNT).replies[0].status, 'queued');
  assert.equal(store.cursor(ACCOUNT.account_id), 'reply-cursor');
  assert.equal(store.list().length, 0);
});

test('普通回复回最近问题，引用旧问题返回原聊天；未知引用不回落默认', async context => {
  const { store } = fixture(context);
  const first = sent_question(store);
  sent_question(store, 'question-0002', OTHER_THREAD);
  const quoted = incoming('old-reply', '只回答第一题');
  quoted.item_list[0].ref_msg = { message_item: { text_item: { text: first } }, title: '不可执行的引文' };
  const unknown = incoming('bad-reply', '不要猜测归属');
  unknown.item_list[0].ref_msg = { title: '其他消息' };
  store.receive_answers(ACCOUNT, { msgs: [incoming('latest', '第二题回答'), quoted, unknown] });
  const queued = [];
  await dispatch_answers(store, { async queue(message) { queued.push(message); return 'ok'; } }, ACCOUNT);
  assert.deepEqual(queued.map(message => message.thread_id), [OTHER_THREAD, THREAD]);
  assert.equal(queued.some(message => message.prompt.includes('不可执行的引文')), false);
  assert.equal(store.reply_status(ACCOUNT).replies[0].status, 'ignored');
});

test('回复只接受扫码用户完整私聊文字；未发送的问题不能作为路由', async context => {
  const { store } = fixture(context);
  store.prepare_question(ACCOUNT, { message_id: 'pending-question', thread_id: THREAD, text: '未发送' });
  store.receive_answers(ACCOUNT, { msgs: [incoming('early')] });
  sent_question(store);
  const media = incoming('media');
  media.item_list.push({ type: 2 });
  store.receive_answers(ACCOUNT, { msgs: [
    { ...incoming('stranger'), from_user_id: 'stranger' }, { ...incoming('group'), group_id: 'group' },
    { ...incoming('partial'), message_state: 1 }, { ...incoming('echo'), message_type: 2 }, media,
  ] });
  await dispatch_answers(store, { queue() { assert.fail('这些消息不得投递'); } }, ACCOUNT);
  assert.deepEqual(store.reply_status(ACCOUNT).replies.map(row => row.status), ['ignored', 'ignored']);
});

test('同一来信持久去重，并行领取和恢复只投递一次；未知回执绝不自动重投', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const page = { msgs: [incoming('dedup', '回复')], get_updates_buf: 'dedup-cursor' };
  store.receive_answers(ACCOUNT, page);
  const reopened = open();
  reopened.receive_answers(ACCOUNT, page);
  let calls = 0;
  const lost_receipt = { async queue() { calls++; throw new Error('accepted then connection lost'); } };
  await Promise.all([dispatch_answers(store, lost_receipt, ACCOUNT), dispatch_answers(reopened, lost_receipt, ACCOUNT)]);
  await dispatch_answers(open(), lost_receipt, ACCOUNT);
  assert.equal(calls, 1);
  assert.equal(store.reply_status(ACCOUNT).replies.length, 1);
  assert.equal(store.reply_status(ACCOUNT).replies[0].status, 'uncertain');
});

test('回复入库与游标同事务；失败后不会跳过整批来信', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.db.exec("CREATE TRIGGER reject_answer BEFORE INSERT ON weixin_answers BEGIN SELECT RAISE(ABORT,'test'); END;");
  assert.throws(() => store.receive_answers(ACCOUNT, { msgs: [incoming()], get_updates_buf: 'must-not-advance' }), /test/);
  assert.equal(store.cursor(ACCOUNT.account_id), '');
  assert.equal(store.reply_status(ACCOUNT).replies.length, 0);
});

test('问题编号不可换目标或覆盖普通通知，非法输入不留下路由', context => {
  const { store } = fixture(context);
  sent_question(store);
  assert.throws(() => store.prepare_question(ACCOUNT,
    { message_id: 'question-0001', thread_id: OTHER_THREAD, text: '请选择下一步。' }), /其他聊天/);
  store.prepare_notification(ACCOUNT, 'plain-notice', '普通通知');
  assert.throws(() => store.prepare_question(ACCOUNT,
    { message_id: 'plain-notice', thread_id: THREAD, text: '问题' }), /其他正文/);
  for (const request of [
    { message_id: 'bad-thread', thread_id: 'not-a-thread', text: '问题' },
    { message_id: 'bad-length', thread_id: THREAD, text: '😀'.repeat(875) },
  ]) assert.throws(() => store.prepare_question(ACCOUNT, request));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_questions').get().count, 1);
});

test('listen --once CLI 在同一轮直接发回项目列表，不创建聊天也不启动 queue', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  sent_question(store);
  const captured_path = join(directory, 'project-menu.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const codex_url = new URL('../message_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    import {CodexAppClient,CodexClient} from ${JSON.stringify(codex_url)};
    CodexAppClient.prototype.open=async()=>{};
    CodexAppClient.prototype.list_projects=async()=>${JSON.stringify(PROJECTS)};
    CodexAppClient.prototype.create_thread=()=>{throw new Error('禁止未选项目就创建');};
    CodexClient.prototype.queue=()=>{throw new Error('禁止转发旧聊天');};
    globalThis.fetch=async(url,options)=>{
      if(url.endsWith('/sendmessage')){writeFileSync(process.argv[2],options.body);return new Response('{"ret":0}');}
      return new Response(JSON.stringify({ret:0,msgs:[${JSON.stringify(incoming('cli-project-new', '/new 你好'))}]}));
    };
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    'listen', '--once', '--account', account_path, '--state', path, '--codex', join(directory, 'must-not-run.exe'),
  ]), captured_path], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(read_json(captured_path).msg.item_list[0].text_item.text.includes('1 · 灵感盒'));
  assert.equal(store.project_list(ACCOUNT).status, 'choosing');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
});

test('旧库新增项目选择表及字段时保留已创建请求，旧请求仍按无项目处理', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('legacy-new-before-projects', '/new 原请求')] });
  const original = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.db.exec('DROP TABLE weixin_project_lists; ALTER TABLE weixin_new_requests DROP COLUMN project_id;');
  const upgraded = open();
  assert.equal(upgraded.project_list(ACCOUNT), undefined);
  const claim = upgraded.claim_new_request(ACCOUNT, original.id, THREAD);
  assert.equal(claim.claimed, true);
  assert.deepEqual(claim.target, { type: 'projectless' });
  assert.ok(claim.prompt.endsWith('原请求'));
});

test('listen --once CLI 仅调用 queue，不启动 App Server，不回收旧桥接任务', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  sent_question(store);
  const captured_path = join(directory, 'queue.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const codex_url = new URL('../message_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    import {CodexClient} from ${JSON.stringify(codex_url)};
    CodexClient.prototype.open=()=>{throw new Error('禁止启动读取程序');};
    CodexClient.prototype.queue=async message=>{writeFileSync(process.argv[2],JSON.stringify(message));return 'queued';};
    globalThis.fetch=async()=>new Response(JSON.stringify({ret:0,msgs:[${JSON.stringify(incoming('cli-reply', '继续操作'))}]}));
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    'listen', '--once', '--account', account_path, '--state', path, '--codex', join(directory, 'fake.exe'),
  ]), captured_path], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read_json(captured_path).thread_id, THREAD);
  assert.equal(read_json(captured_path).prompt, '[微信] 请用 $weixin-notify 回复。\n\n继续操作');
  assert.equal(JSON.parse(result.stdout).running, false);
  assert.equal(result.stdout.includes('FAKE-'), false);
});

for (const command of ['ask', 'notify']) test(`${command} 记录当前来源并确保收件器运行，发送带名称的消息`, context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  store.db.prepare("INSERT INTO weixin_listeners VALUES (?,?,'running')").run(ACCOUNT.account_id, process.pid);
  const captured_path = join(directory, 'question.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    globalThis.fetch=async(url,options)=>{
      if(!url.endsWith('/sendmessage'))throw new Error('禁止读取微信或聊天历史');
      writeFileSync(process.argv[2],options.body);return new Response('{"ret":0}');};
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    command, '--account', account_path, '--state', path, '--message-id', 'ask-env-0001', '--text', '接着做吗？',
    '--title', '测试聊天', '--codex', join(directory, 'must-not-start.exe'),
  ]), captured_path], { encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...process.env, CODEX_THREAD_ID: THREAD } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).thread_id, THREAD);
  assert.equal(JSON.parse(result.stdout).listener_pid, process.pid);
  assert.equal(read_json(captured_path).msg.item_list[0].text_item.text, '💬 Codex（测试聊天）：\n\n接着做吗？');
  assert.equal(store.db.prepare('SELECT thread_id FROM weixin_questions').get().thread_id, THREAD);
  assert.equal(store.db.prepare('SELECT mode FROM weixin_questions').get().mode, command);
});

test('微信展示去掉常见 Markdown，保留链接地址、代码与中文段落', () => {
  const text = '# 结果\n\n**完成**，~~旧方案~~。\n- [文档](https://example.com/docs)\n'
    + '\n`snake_case * literal`\n```js\nconst result = a * b; // **keep**\n```';
  const result = format_notice('桥接优化', text);
  assert.ok(result.startsWith('💬 Codex（桥接优化）：\n\n结果\n\n完成，旧方案。'));
  assert.ok(result.includes('• 文档（https://example.com/docs）'));
  assert.ok(result.includes('snake_case * literal'));
  assert.ok(result.includes('const result = a * b; // **keep**'));
  assert.equal(result.includes('```'), false);
  assert.equal(weixin_text('| 名称 | 状态 |\n| --- | --- |\n| 收件 | 正常 |'), '名称；状态\n\n收件；正常');
});

test('消息标题不暴露内部编号；同一编号重试仍使用原正文，重命名不重发', context => {
  const { store } = fixture(context);
  const request = { message_id: 'human-title-001', thread_id: THREAD, title: '中文聊天名称', text: '**完成**' };
  const first = store.prepare_question(ACCOUNT, request);
  assert.equal(first, '💬 Codex（中文聊天名称）：\n\n完成');
  assert.equal(first.includes(request.message_id), false);
  assert.equal(store.prepare_question(ACCOUNT, { ...request, title: '重命名后' }), first);
  assert.throws(() => store.prepare_question(ACCOUNT, { ...request, text: '改过的正文' }), /其他正文/);
});

test('引用微信服务器消息 ID 准确回到旧聊天，服务端 uint64 编号原样保留', async context => {
  const { store } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const request = { message_id: 'quote-by-id-01', thread_id: THREAD, title: '旧聊天', text: '问题' };
  const text = store.prepare_question(ACCOUNT, request);
  await send_notification(store, { async send() { return { message_id: '7516559228621446792' }; } }, ACCOUNT,
    { message_id: request.message_id, text });
  sent_question(store, 'newer-question', OTHER_THREAD);
  const reply = incoming('server-id-answer', '回答旧问题');
  reply.item_list[0].ref_msg = { svr_id: '7516559228621446792' };
  store.receive_answers(ACCOUNT, { msgs: [reply] });
  const queued = [];
  await dispatch_answers(store, { async queue(message) { queued.push(message); return 'ok'; } }, ACCOUNT);
  assert.equal(queued[0].thread_id, THREAD);
  assert.equal(store.notification(ACCOUNT, request.message_id).server_id, '7516559228621446792');
});

test('重名且同文的聊天引用不猜测；旧编号头仍可准确路由', context => {
  const { store } = fixture(context);
  let body;
  for (const [id, thread] of [['same-one', THREAD], ['same-two', OTHER_THREAD]]) {
    body = store.prepare_question(ACCOUNT, { message_id: id, thread_id: thread, title: '同名', text: '同文' });
    const notice = store.notification(ACCOUNT, id);
    store.claim_outbox(notice.id); store.finish_outbox(notice.id, 'api_accepted');
  }
  assert.equal(store.quoted_target(ACCOUNT, { message_item: { text_item: { text: body } } }), undefined);
  assert.equal(store.quoted_target(ACCOUNT, { title: '[Codex 提问 same-one]\n旧版' }).thread_id, THREAD);
  assert.equal(store.quoted_target(ACCOUNT, { title: 'Codex（同名）：' }), undefined);
});

test('/new 先列本机项目，跨重启按原编号创建，首条问题和创建后的补充保持归属', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const desktop = fake_desktop();
  const codex = fake_codex();
  store.receive_answers(ACCOUNT, { msgs: [incoming('project-new', '/new 中文“问题”\n第二行')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(desktop.creations.length, 0);
  assert.equal(codex.submissions.length, 0);
  const menus = [];
  await flush_command_replies(store, { async send(message) { menus.push(message.text); } }, ACCOUNT);
  assert.equal(menus.length, 1);
  assert.ok(menus[0].includes('0 · 无项目\n\n1 · 灵感盒\n\n2 · ai_co_discuss'));
  assert.equal(/D:\/|云端项目|远端项目|project-discuss/.test(menus[0]), false);
  desktop.projects.reverse();
  const choice = incoming('project-choice', '2');
  open().receive_answers(ACCOUNT, { msgs: [choice, incoming('project-held', '后续补充')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.deepEqual(desktop.creations[0].target, { type: 'project', projectId: 'project-discuss', environment: { type: 'local' } });
  assert.ok(desktop.creations[0].prompt.endsWith('中文“问题”\n第二行'));
  assert.deepEqual(desktop.calls.map(call => call[0]), ['list', 'list', 'create']);
  assert.equal(codex.submissions[0].thread_id, OTHER_THREAD);
  assert.ok(codex.submissions[0].prompt.endsWith('后续补充'));
  open().receive_answers(ACCOUNT, { msgs: [choice] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(desktop.creations.length, 1);
});

test('/new 选 0 创建无项目聊天；选择完后的数字恢复普通消息', async context => {
  const { store } = fixture(context);
  sent_question(store);
  const desktop = fake_desktop();
  const codex = fake_codex();
  store.receive_answers(ACCOUNT, { msgs: [incoming('no-project-new', '/new')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  store.receive_answers(ACCOUNT, { msgs: [incoming('no-project-choice', '0')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.deepEqual(desktop.creations[0].target, { type: 'projectless' });
  assert.equal(store.project_list(ACCOUNT), undefined);
  store.receive_answers(ACCOUNT, { msgs: [incoming('plain-number-after-project', '3')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.ok(codex.submissions[0].prompt.endsWith('3'));
  assert.deepEqual(desktop.calls.map(call => call[0]), ['list', 'create']);
});

test('项目未选定时无效数字和普通文字只提示；陌生人不选项目，明确引用仍回原聊天', async context => {
  const { store } = fixture(context);
  const original = sent_question(store);
  const desktop = fake_desktop();
  const codex = fake_codex();
  store.receive_answers(ACCOUNT, { msgs: [incoming('invalid-project-new', '/new 问题'), incoming('before-project-list', '1')] });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  const quoted = incoming('quoted-project-number', '1');
  quoted.item_list[0].ref_msg = { message_item: { text_item: { text: original } } };
  store.receive_answers(ACCOUNT, { msgs: [incoming('bad-project-number', '99'), incoming('bad-project-text', '先聊聊'),
    { ...incoming('stranger-project', '1'), from_user_id: 'stranger' }, quoted] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(desktop.creations.length, 0);
  assert.equal(codex.submissions.length, 1);
  assert.equal(codex.submissions[0].thread_id, THREAD);
  assert.ok(store.project_list(ACCOUNT));
  assert.equal(store.project_list({ ...ACCOUNT, owner_id: 'stranger' }), undefined);
});

test('项目与会话选号不混用；新的 /new 替换未确认列表，迟到读取及旧来信不覆盖新列表', async context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'other-before-picker', OTHER_THREAD);
  const desktop = fake_desktop();
  const codex = fake_codex();
  const first = incoming('first-picker', '/new 旧问题');
  store.receive_answers(ACCOUNT, { msgs: [incoming('resume-before-picker', '/resume'), first] });
  const old_picker = store.project_list(ACCOUNT);
  store.receive_answers(ACCOUNT, { msgs: [incoming('second-picker', '/new 新问题')] });
  store.save_project_list(ACCOUNT, old_picker.id, PROJECTS);
  assert.equal(store.project_list(ACCOUNT).choices, null);
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  store.receive_answers(ACCOUNT, { msgs: [first] });
  assert.equal(store.project_list(ACCOUNT).text, '新问题');
  store.receive_answers(ACCOUNT, { msgs: [incoming('resume-cancels-picker', '/resume'), incoming('resume-after-picker', '2')] });
  assert.equal(store.project_list(ACCOUNT), undefined);
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  assert.equal(store.pending_outbox(ACCOUNT).some(row => row.text.includes('请选择新聊天所在的项目')), false);
});

test('项目列表及选择失败完整回滚，游标与选择原文不丢失', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('rollback-project-new', '/new 原问题')] });
  const picker = store.project_list(ACCOUNT);
  const add_outbox = store.add_outbox;
  store.add_outbox = () => { throw new Error('模拟列表落库失败'); };
  assert.throws(() => store.save_project_list(ACCOUNT, picker.id, PROJECTS), /模拟/);
  assert.equal(store.project_list(ACCOUNT).choices, null);
  assert.equal(store.project_list(ACCOUNT).status, 'received');
  store.add_outbox = add_outbox;
  store.save_project_list(ACCOUNT, picker.id, PROJECTS);
  const receive_new_request = store.receive_new_request;
  store.receive_new_request = function (...args) { receive_new_request.apply(this, args); throw new Error('模拟选择失败'); };
  assert.throws(() => store.receive_answers(ACCOUNT, { msgs: [incoming('rollback-project-choice', '1')],
    get_updates_buf: 'not-committed' }), /模拟选择失败/);
  assert.equal(store.project_list(ACCOUNT).status, 'choosing');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  assert.equal(store.cursor(ACCOUNT.account_id), '');
});

test('读取项目列表失败可恢复；所选项目已删除时不创建也不回落无项目', async context => {
  const { store } = fixture(context);
  sent_question(store);
  const desktop = fake_desktop();
  const codex = fake_codex();
  const list_projects = desktop.list_projects;
  desktop.list_projects = async () => { throw new Error('offline'); };
  store.receive_answers(ACCOUNT, { msgs: [incoming('deleted-project-new', '/new 问题')] });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(store.project_list(ACCOUNT).status, 'received');
  desktop.list_projects = list_projects;
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  store.receive_answers(ACCOUNT, { msgs: [incoming('deleted-project-choice', '2'), incoming('deleted-project-held', '补充')] });
  desktop.projects = [];
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(desktop.creations.length, 0);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.db.prepare('SELECT status FROM weixin_new_requests').get().status, 'failed');
  assert.equal(store.active_chat(ACCOUNT).pending_request, null);
  assert.equal(store.pending_outbox(ACCOUNT).filter(row => row.text.includes('所选项目已不可用')).length, 1);
});

test('/new 由脚本直接创建，后续消息暂存，新窗口登记后切换而不继承旧问答', async context => {
  const { store } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('new-command', '/new 聊聊建筑摄影'), incoming('after-new', '偏好黑白')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  const queued = [];
  const codex = { async queue(message) { queued.push(message); return 'ok'; } };
  const desktop = {
    async open() {}, close() {},
    async create_thread(source, prompt, title) {
      assert.equal(source, THREAD);
      assert.ok(prompt.includes('聊聊建筑摄影'));
      assert.equal(prompt.includes('请选择下一步'), false);
      assert.equal(store.reply_status(ACCOUNT).replies[0].status, 'waiting_new');
      assert.equal(store.claim_new_request(ACCOUNT, request.id, THREAD).claimed, false);
      return { thread_id: OTHER_THREAD, title };
    },
  };
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].thread_id, OTHER_THREAD);
  assert.ok(queued[0].prompt.endsWith('偏好黑白'));
  assert.equal(store.db.prepare("SELECT status FROM weixin_answers WHERE kind='new'").get().status, 'created');
  store.receive_answers(ACCOUNT, { msgs: [incoming('next', '继续')] });
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(queued[1].thread_id, OTHER_THREAD);
});

test('/new 桌面离线时保留待创建，恢复后直接创建，不转发旧窗口', async context => {
  const { store } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('offline-new', '/new'), incoming('offline-followup', '后续问题')] });
  const codex = fake_codex();
  let offline = true;
  const desktop = { async open() { if (offline) throw new Error('offline'); }, close() {},
    async create_thread(source, prompt, title) { return { thread_id: OTHER_THREAD, title }; } };
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(store.db.prepare('SELECT status FROM weixin_new_requests').get().status, 'pending');
  assert.equal(codex.submissions.length, 0);
  offline = false;
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  assert.equal(codex.submissions.length, 1);
  assert.equal(codex.submissions[0].thread_id, OTHER_THREAD);
});

test('/new 创建回执不明时不重建、不转发；新聊天自行登记可恢复', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('uncertain-new', '/new 新话题'), incoming('held-new', '补充')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  let calls = 0;
  const desktop = { async open() {}, close() {}, async create_thread() { calls++; throw new Error('lost'); } };
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  await dispatch_answers(open(), codex, ACCOUNT, desktop);
  assert.equal(calls, 1);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.db.prepare("SELECT status FROM weixin_answers WHERE kind='new'").get().status, 'uncertain');
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '新话题' });
  await dispatch_answers(store, codex, ACCOUNT, desktop);
  assert.equal(calls, 1);
  assert.equal(codex.submissions[0].thread_id, OTHER_THREAD);
  assert.equal(store.db.prepare("SELECT last_error FROM weixin_answers WHERE kind='new'").get().last_error, null);
});

test('/new 并发领取与重复来信只创建一次，迟到回执不覆盖期间的新通知绑定', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const page = { msgs: [incoming('parallel-new', '/new 任务')] };
  receive_new_messages(store, page);
  receive_new_messages(open(), page);
  let calls = 0;
  const desktop = { async open() {}, close() {}, async create_thread(source, prompt, title) {
    calls++;
    sent_question(store, 'newer-during-create', THREAD);
    return { thread_id: OTHER_THREAD, title };
  } };
  const codex = fake_codex();
  await Promise.all([dispatch_answers(store, codex, ACCOUNT, desktop), dispatch_answers(open(), codex, ACCOUNT, desktop)]);
  assert.equal(calls, 1);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
});

/** Serve the actual desktop framing protocol on a test-owned local pipe. */
async function desktop_fixture(context) {
  const { directory } = fixture(context);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\weixin-test-${randomUUID()}` : join(directory, 'app.sock');
  const calls = [];
  let creation = { threadId: OTHER_THREAD, hostId: 'local' };
  const server = create_pipe_server(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const request = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
        buffer = buffer.subarray(length + 4);
        calls.push(request);
        const data = request.params?.tool === 'list_projects' ? { projects: PROJECTS } : creation;
        const result = request.method === 'tools/list'
          ? { tools: ['create_thread', 'list_projects'].map(name => ({ name, namespace: 'desktop_namespace' })) }
          : { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        const frame = Buffer.alloc(payload.length + 4);
        frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
        socket.write(frame.subarray(0, 3));
        setImmediate(() => socket.write(frame.subarray(3)));
      }
    });
  });
  await new Promise(resolve_ready => server.listen(pipe, resolve_ready));
  const desktop = new CodexAppClient(pipe);
  context.after(() => { desktop.close(); return new Promise(resolve_closed => server.close(resolve_closed)); });
  return { desktop, calls, set_creation(value) { creation = value; } };
}

test('桌面管道真实分帧往返：直接创建 projectless，原文与来源正确且不指定模型', async context => {
  const { desktop, calls, set_creation } = await desktop_fixture(context);
  await desktop.open();
  const result = await desktop.create_thread(THREAD, '中文“引号”\n$() `原文`', '建筑摄影');
  assert.deepEqual(result, { thread_id: OTHER_THREAD, title: '建筑摄影' });
  assert.equal(calls[1].params.threadId, THREAD);
  assert.equal(calls[1].params.namespace, 'desktop_namespace');
  assert.deepEqual(calls[1].params.arguments, { prompt: '中文“引号”\n$() `原文`', title: '建筑摄影', target: { type: 'projectless' } });
  set_creation({ clientThreadId: 'pending-setup' });
  await assert.rejects(desktop.create_thread(THREAD, '问题', '名称'), /实际 threadId/);
  desktop.close();
  await desktop.open();
  set_creation({ threadId: OTHER_THREAD });
  assert.equal((await desktop.create_thread(THREAD, '下一次', '名称')).thread_id, OTHER_THREAD);
  assert.deepEqual(await desktop.list_projects(THREAD), PROJECTS);
  const target = { type: 'project', projectId: PROJECTS[0].projectId, environment: { type: 'local' } };
  await desktop.create_thread(THREAD, '项目问题', '项目聊天', target);
  assert.equal(calls.at(-2).params.tool, 'list_projects');
  assert.deepEqual(calls.at(-1).params.arguments.target, target);
});

test('普通正文和引文中的 /new 不创建聊天，明确命令可覆盖无效引用', context => {
  const { store } = fixture(context);
  sent_question(store);
  const quoted = incoming('quoted-new', '我只是引用这条消息');
  quoted.item_list[0].ref_msg = { title: '/new 不应该执行' };
  store.receive_answers(ACCOUNT, { msgs: [incoming('embedded', '请说明 /new 的用法'), incoming('prefix', '/newspaper'), quoted] });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  const explicit = incoming('explicit', '/new 新问题');
  explicit.item_list[0].ref_msg = { title: '未知引用' };
  receive_new_messages(store, { msgs: [explicit] });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 1);
});

test('/new 去重、领取和重新登记幂等；不接受旧线程冒充新聊天', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const page = { msgs: [incoming('new-once', '/new 你好')] };
  receive_new_messages(store, page);
  receive_new_messages(open(), page);
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 1);
  assert.throws(() => store.claim_new_request(ACCOUNT, request.id, OTHER_THREAD), /不匹配/);
  assert.equal(store.claim_new_request(ACCOUNT, request.id, THREAD).claimed, true);
  assert.equal(open().claim_new_request(ACCOUNT, request.id, THREAD).claimed, false);
  assert.throws(() => store.complete_new_request(ACCOUNT, request.id, { thread_id: THREAD, title: '旧聊天' }), /独立聊天/);
  const target = { thread_id: OTHER_THREAD, title: '新聊天' };
  store.complete_new_request(ACCOUNT, request.id, target);
  store.complete_new_request(ACCOUNT, request.id, target);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
});

test('新聊天完成后，下一条已发送通知更新默认目标，明确引用仍回原聊天', context => {
  const { store } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('new-active', '/new 切换')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '新聊天' });
  const body = sent_question(store, 'new-chat-notice', OTHER_THREAD);
  sent_question(store, 'late-old-question', THREAD);
  assert.equal(store.answer_target(ACCOUNT, { references: [], text: '继续' }).thread_id, THREAD);
  assert.equal(store.answer_target(ACCOUNT, { references: [{ message_item: { text_item: { text: body } } }], text: '回复' })
    .thread_id, OTHER_THREAD);
});

test('多个 /new 的登记乱序时，较早请求不会覆盖最新选择', context => {
  const { store } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('new-first', '/new 第一件事'), incoming('new-second', '/new 第二件事')] });
  const requests = store.db.prepare('SELECT * FROM weixin_new_requests ORDER BY created_at,rowid').all();
  requests.forEach(request => store.claim_new_request(ACCOUNT, request.id, THREAD));
  store.complete_new_request(ACCOUNT, requests[0].id, { thread_id: OTHER_THREAD, title: '第一件事' });
  assert.equal(store.active_chat(ACCOUNT).pending_request, requests[1].id);
});

test('新聊天 CLI 用当前来源领取请求，再用实际返回的目标登记，不启动模型或读取历史', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('cli-new', '/new 一个新话题')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  const executable = fileURLToPath(new URL('../weixin_bridge.mjs', import.meta.url));
  const common = ['--account', account_path, '--state', path, '--request-id', request.id,
    '--codex', join(directory, 'must-not-start.exe')];
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, CODEX_THREAD_ID: THREAD } };
  const claimed = spawnSync(process.execPath, [executable, 'new-claim', ...common], options);
  assert.equal(claimed.status, 0, claimed.stderr);
  const payload = JSON.parse(claimed.stdout);
  assert.equal(payload.claimed, true);
  assert.ok(payload.prompt.endsWith('一个新话题'));
  const completed = spawnSync(process.execPath, [executable, 'new-complete', ...common,
    '--thread', OTHER_THREAD, '--title', '新话题'], options);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).thread_id, OTHER_THREAD);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
});

test('微信帮助无需已有聊天，不进模型队列，回信重启后只发送一次且不发送其他积压', async context => {
  const { store, open } = fixture(context);
  store.prepare_notification(ACCOUNT, 'unrelated-backlog', '不应自动补发');
  const page = { msgs: [incoming('help-command', '/help')], get_updates_buf: 'help-cursor' };
  store.receive_answers(ACCOUNT, page);
  open().receive_answers(ACCOUNT, page);
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  const sent = [];
  const client = { async send(message) { sent.push(message); return { message_id: 'reply-server-id' }; } };
  await flush_command_replies(store, client, ACCOUNT);
  await flush_command_replies(open(), client, ACCOUNT);
  assert.equal(codex.submissions.length, 0);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.startsWith('🔔 系统通知：\n\n'));
  assert.ok(sent[0].text.includes('/resume'));
  assert.equal(sent[0].text.includes('help-command'), false);
  assert.equal(store.notification(ACCOUNT, 'unrelated-backlog').status, 'pending');
  assert.equal(store.cursor(ACCOUNT.account_id), 'help-cursor');
});

test('聊天目录仅含已联系的聊天，内部标识跨重启不变、展示编号从一开始', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const first = store.known_chats(ACCOUNT)[0];
  assert.ok(store.resume_chat(ACCOUNT, String(first.id)).includes('未找到'));
  sent_question(store, 'other-contact', OTHER_THREAD);
  store.db.prepare('UPDATE weixin_questions SET created_at=created_at+100 WHERE thread_id=?').run(OTHER_THREAD);
  const chats = open().known_chats(ACCOUNT);
  assert.equal(chats[0].thread_id, OTHER_THREAD);
  assert.equal(chats.find(chat => chat.thread_id === THREAD).id, first.id);
  assert.equal(store.known_chats({ ...ACCOUNT, owner_id: 'stranger' }).length, 0);
  const fresh = fixture(context).store;
  fresh.prepare_question(ACCOUNT, { message_id: 'unsent-source', thread_id: THREAD, title: '未发', text: '问题' });
  assert.equal(fresh.known_chats(ACCOUNT).length, 0);
  store.receive_answers(ACCOUNT, { msgs: [incoming('list-command', '/sessions')] });
  const body = store.pending_outbox(ACCOUNT).at(-1).text;
  assert.ok(body.includes('当前：\n\n1 · 另一个聊天'));
  assert.equal(body.includes(THREAD), false);
  assert.equal(body.includes(OTHER_THREAD), false);
});

test('目录同时覆盖普通通知和未发首条通知的新聊天，长目录有界并保留当前目标', context => {
  const { store } = fixture(context);
  sent_question(store);
  for (let index = 0; index < 12; index++) {
    const message_id = `catalog-notice-${index}`;
    const thread_id = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
    store.prepare_question(ACCOUNT, { message_id, thread_id, title: '长标题'.repeat(40), text: '通知', mode: 'notify' });
    const notice = store.notification(ACCOUNT, message_id);
    store.claim_outbox(notice.id); store.finish_outbox(notice.id, 'api_accepted');
  }
  receive_new_messages(store, { msgs: [incoming('new-for-list', '/new')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.claim_new_request(ACCOUNT, request.id, request.source_thread_id);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '刚建立的聊天' });
  assert.equal(store.known_chats(ACCOUNT).length, 14);
  const list = store.chat_list_text(ACCOUNT);
  const numbers = list.split('\n').map(line => line.match(/^(?:当前：)?(\d+) · /)?.[1]).filter(Boolean);
  assert.deepEqual(numbers, Array.from({ length: 10 }, (_, index) => String(index + 1)));
  assert.ok(list.startsWith('当前：'));
  assert.ok(list.includes('刚建立的聊天'));
  assert.ok(Buffer.byteLength(list) < 3500);
});

test('无参数 /resume 与 /sessions、/rusume 返回同一列表，不改路由、不入模型队列', async context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'alias-other-chat', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  store.resume_chat(ACCOUNT, '2');
  store.receive_answers(ACCOUNT, { msgs: [incoming('original-list', '/sessions'),
    incoming('alias-list', '/rusume'), incoming('alias-paste', ' /RUSUME\u200B\u200B'),
    incoming('resume-list', '/resume'), incoming('resume-list-spaces', '/resume \n\t'),
    incoming('resume-list-paste', ' /RESUME\u200B\u200B'),
    incoming('alias-invalid', '/rusume 2')] });
  const replies = store.pending_outbox(ACCOUNT);
  assert.equal(replies.length, 7);
  assert.ok(replies.slice(0, 6).every(reply => reply.text === replies[0].text));
  assert.ok(replies[6].text.includes('/rusume 不需要参数'));
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(codex.submissions.length, 0);
});

test('列表编号按最近一次展示选择，通知和重启不改映射、旧列表重放不覆盖新列表', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  sent_question(store, 'snapshot-second', OTHER_THREAD);
  const original = incoming('snapshot-list', '/sessions');
  store.receive_answers(ACCOUNT, { msgs: [original] });
  assert.equal(store.pending_outbox(ACCOUNT).at(-1).text,
    '🔔 系统通知：\n\n当前：\n\n1 · 另一个聊天（当前绑定）\n\n2 · 测试聊天\n\n切换：直接回复序号，或 /resume 序号');
  const third_thread = '00000000-0000-0000-0000-000000000003';
  sent_question(store, 'snapshot-third', third_thread);
  store.chat_status_text(ACCOUNT);
  const reopened = open();
  reopened.receive_answers(ACCOUNT, { msgs: [incoming('snapshot-pick', '/resume 2')] });
  assert.equal(reopened.active_chat(ACCOUNT).thread_id, THREAD);
  reopened.receive_answers(ACCOUNT, { msgs: [incoming('snapshot-refreshed', '/resume')] });
  const refreshed = reopened.last_chat_list(ACCOUNT);
  reopened.receive_answers(ACCOUNT, { msgs: [original] });
  assert.deepEqual(reopened.last_chat_list(ACCOUNT), refreshed);
  reopened.receive_answers(ACCOUNT, { msgs: [incoming('snapshot-pick-new', '/resume 2')] });
  assert.equal(reopened.active_chat(ACCOUNT).thread_id, third_thread);
});

test('列表快照隔离账号、无当前对话时从一开始，回信失败保留之前的编号映射', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'snapshot-rollback-other', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const previous = store.last_chat_list(ACCOUNT);
  const stranger = { ...ACCOUNT, owner_id: 'stranger' };
  assert.equal(store.chat_list_text(stranger), '暂无可用对话。先从 Codex 向微信发送一条消息。');
  assert.deepEqual(store.last_chat_list(ACCOUNT), previous);
  store.resume_chat(ACCOUNT, '2');
  const add_outbox = store.add_outbox.bind(store);
  store.add_outbox = () => { throw new Error('模拟列表回信落库失败'); };
  assert.throws(() => store.receive_answers(ACCOUNT, { msgs: [incoming('snapshot-failed', '/sessions')] }), /模拟/);
  assert.deepEqual(store.last_chat_list(ACCOUNT), previous);
  store.add_outbox = add_outbox;
  store.db.prepare('UPDATE weixin_active_chats SET thread_id=NULL').run();
  const list = store.chat_list_text(ACCOUNT);
  assert.ok(list.startsWith('请选择对话：\n\n1 · '));
  assert.ok(list.includes('\n\n2 · '));
});

for (const command of ['/resume', '/sessions', '/rusume']) test(`${command} 后单独回复 3 按原列表切换，重启和新通知不改变选项`, async context => {
  const { store, open } = fixture(context);
  const third_thread = '00000000-0000-0000-0000-000000000003';
  sent_question(store);
  sent_question(store, 'numeric-second', OTHER_THREAD);
  sent_question(store, 'numeric-third', third_thread);
  store.receive_answers(ACCOUNT, { msgs: [incoming('numeric-list', command)] });
  const listed = store.last_chat_list(ACCOUNT);
  const selected = store.known_chats(ACCOUNT).find(chat => chat.id === listed[2]);
  const body = store.pending_outbox(ACCOUNT).at(-1).text;
  assert.equal(body.split('（当前绑定）').length - 1, 1);
  assert.ok(body.includes('1 · 另一个聊天（当前绑定）'));
  sent_question(store, 'numeric-notice-after-list', OTHER_THREAD);
  const restarted = open();
  restarted.receive_answers(ACCOUNT, { msgs: [incoming('numeric-choice', ' 3 ')] });
  assert.equal(restarted.active_chat(ACCOUNT).thread_id, selected.thread_id);
  const selection = store.db.prepare("SELECT * FROM weixin_answers WHERE raw_id='numeric-choice'").get();
  assert.equal(selection.kind, 'command');
  assert.equal(selection.status, 'handled');
  sent_question(store, 'numeric-latest-notice', third_thread);
  restarted.receive_answers(ACCOUNT, { msgs: [incoming('ordinary-number-after-choice', '3')] });
  const codex = fake_codex();
  await dispatch_answers(restarted, codex, ACCOUNT);
  assert.equal(codex.submissions.length, 1);
  assert.equal(codex.submissions[0].thread_id, third_thread);
  assert.ok(codex.submissions[0].prompt.endsWith('\n\n3'));
  assert.ok(store.chat_list_text(ACCOUNT).startsWith('当前：\n\n1 · 另一个聊天（当前绑定）'));
});

test('选号期间无效数字只提示，成功选定后或未打开列表时数字按正文处理', async context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'numeric-invalid-other', OTHER_THREAD);
  store.receive_answers(ACCOUNT, { msgs: [incoming('number-without-list', '3'), incoming('invalid-number-list', '/resume'),
    incoming('number-zero', '0'), incoming('number-too-large', '999'), incoming('number-valid', '2'),
    incoming('number-after-selected', '2')] });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.deepEqual(codex.submissions.map(message => message.thread_id), [OTHER_THREAD, THREAD]);
  assert.ok(store.pending_outbox(ACCOUNT).some(message => message.text.includes('未找到该序号')));
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE kind='command'").get().count, 4);
});

test('普通正文或引用结束选号，引用中的数字不触发切换', async context => {
  const { store } = fixture(context);
  const old = sent_question(store);
  sent_question(store, 'quoted-number-other', OTHER_THREAD);
  const quoted = incoming('quoted-number', '2');
  quoted.item_list[0].ref_msg = { message_item: { text_item: { text: old } } };
  store.receive_answers(ACCOUNT, { msgs: [incoming('quoted-number-list', '/sessions'), quoted,
    incoming('after-quoted-number', '2'), incoming('normal-number-list', '/resume'),
    incoming('ordinary-message-cancels-choice', '继续当前任务'), incoming('after-ordinary-message', '2')] });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.deepEqual(codex.submissions.map(message => message.thread_id), [THREAD, OTHER_THREAD, OTHER_THREAD, OTHER_THREAD]);
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
});

test('数字选号回信落库失败全部回滚，重放旧数字不消费新的选号状态', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  sent_question(store, 'numeric-rollback-other', OTHER_THREAD);
  store.receive_answers(ACCOUNT, { msgs: [incoming('numeric-rollback-list', '/resume')] });
  const choice = incoming('numeric-rollback-choice', '2');
  const add_outbox = store.add_outbox.bind(store);
  store.add_outbox = () => { throw new Error('模拟回信失败'); };
  assert.throws(() => store.receive_answers(ACCOUNT, { msgs: [choice], get_updates_buf: 'not-saved' }), /模拟/);
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
  assert.equal(store.cursor(ACCOUNT.account_id), '');
  assert.equal(store.numeric_chat_command(ACCOUNT, { text: '2', references: [] })[1], 'resume');
  store.add_outbox = add_outbox;
  store.receive_answers(ACCOUNT, { msgs: [choice, incoming('numeric-new-list', '/resume')] });
  open().receive_answers(ACCOUNT, { msgs: [choice] });
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  assert.ok(store.numeric_chat_command(ACCOUNT, { text: '2', references: [] }));
  store.receive_answers(ACCOUNT, { msgs: [incoming('numeric-new-choice', '2')] });
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
});

test('旧列表迁移保留编号映射，不把历史列表当作正在选号', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  sent_question(store, 'legacy-list-other', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const listed = store.last_chat_list(ACCOUNT);
  store.db.exec('ALTER TABLE weixin_chat_lists DROP COLUMN awaiting_selection');
  const upgraded = open();
  assert.deepEqual(upgraded.last_chat_list(ACCOUNT), listed);
  assert.equal(upgraded.numeric_chat_command(ACCOUNT, { text: '2', references: [] }), null);
  upgraded.receive_answers(ACCOUNT, { msgs: [incoming('legacy-list-new-command', '/resume'), incoming('legacy-list-pick', '2')] });
  assert.equal(upgraded.active_chat(ACCOUNT).thread_id, THREAD);
});

test('/resume 即时切换，之后新通知更新目标，明确引用和已保存消息仍回各自聊天', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const body = sent_question(store, 'before-switch', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const quote = incoming('quoted-after-switch', '答旧问题');
  quote.item_list[0].ref_msg = { message_item: { text_item: { text: body } } };
  store.receive_answers(ACCOUNT, { msgs: [incoming('saved-before', '原聊天处理'),
    incoming('resume-command', '/resume 2'), incoming('plain-after', '当前聊天处理'), quote] });
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
  const list = store.last_chat_list(ACCOUNT);
  sent_question(store, 'late-question', OTHER_THREAD);
  const restarted = open();
  assert.equal(restarted.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
  assert.deepEqual(restarted.last_chat_list(ACCOUNT), list);
  restarted.receive_answers(ACCOUNT, { msgs: [incoming('after-new-notice', '回复最新通知')] });
  const codex = fake_codex();
  await dispatch_answers(restarted, codex, ACCOUNT);
  assert.deepEqual(codex.submissions.map(message => message.thread_id), [OTHER_THREAD, THREAD, OTHER_THREAD, OTHER_THREAD]);
  assert.equal(store.db.prepare("SELECT status FROM weixin_answers WHERE raw_id='resume-command'").get().status, 'handled');
});

test('/resume 重复收件不再次切换，非法参数或其他用户序号不能改路由', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  sent_question(store, 'resume-other', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const first = 2;
  const second = 1;
  const original = incoming('resume-once', `/resume ${first}`);
  store.receive_answers(ACCOUNT, { msgs: [original, incoming('resume-again', `/resume ${second}`)] });
  open().receive_answers(ACCOUNT, { msgs: [original] });
  store.receive_answers(ACCOUNT, { msgs: ['0', '1e2', '999999', THREAD, `${first}继续`]
    .map((argument, index) => incoming(`bad-resume-${index}`, `/resume ${argument}`)) });
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  assert.ok(store.resume_chat({ ...ACCOUNT, owner_id: 'stranger' }, String(first)).includes('未找到'));
  assert.equal(store.active_chat({ ...ACCOUNT, owner_id: 'stranger' }), undefined);
});

test('/resume 序号加正文按最近列表投递，原文保留、引用不抢目标、重放不重复切换或发送', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  sent_question(store, 'resume-text-other', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const body = '你是窗口几？\n第二行 /new 不创建\u200b  ';
  const command = incoming('resume-with-body', ` /RESUME\u200b 2 ${body}`);
  command.item_list[0].ref_msg = { title: '未知引用不改变明确的切换目标' };
  store.receive_answers(ACCOUNT, { msgs: [command] });
  const saved = store.db.prepare("SELECT * FROM weixin_answers WHERE raw_id='resume-with-body'").get();
  assert.equal(saved.text, body);
  assert.equal(saved.thread_id, THREAD);
  assert.equal(saved.status, 'received');
  assert.equal(saved.kind, 'reply');
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  store.receive_answers(ACCOUNT, { msgs: [incoming('switch-after-body', '/resume 1')] });
  const reopened = open();
  reopened.receive_answers(ACCOUNT, { msgs: [command] });
  await dispatch_answers(reopened, codex, ACCOUNT);
  assert.equal(reopened.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  assert.equal(codex.submissions.length, 1);
  assert.equal(codex.submissions[0].thread_id, THREAD);
  assert.ok(codex.submissions[0].prompt.endsWith(body));
  assert.equal(codex.submissions[0].prompt.includes('/RESUME'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  const sent = [];
  await flush_command_replies(reopened, { async send(message) { sent.push(message.text); } }, ACCOUNT);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], '🔔 系统通知：\n\n已切换：2 · 测试聊天');
});

test('/resume 带正文但序号无效或尚未查看列表时不切换、不回落旧聊天，空正文只切换', async context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'invalid-resume-text', OTHER_THREAD);
  store.receive_answers(ACCOUNT, { msgs: [incoming('resume-no-list', '/resume 2 不应投递')] });
  store.chat_list_text(ACCOUNT);
  const commands = ['/resume 0 问题', '/resume 999 问题', '/resume 2问题', '/resume -1 问题', '/resume 问题'];
  store.receive_answers(ACCOUNT, { msgs: commands.map((text, index) => incoming(`resume-invalid-body-${index}`, text)) });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(store.active_chat(ACCOUNT), undefined);
  assert.equal(codex.submissions.length, 0);
  store.receive_answers(ACCOUNT, { msgs: [incoming('resume-blank-body', '/resume 2 \n\t')] });
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  assert.equal(codex.submissions.length, 0);
});

test('/resume 附带正文直接交给选中聊天，之前等待创建的消息仍交给新聊天', async context => {
  const { store } = fixture(context);
  sent_question(store);
  store.chat_list_text(ACCOUNT);
  receive_new_messages(store, { msgs: [incoming('new-before-resume-text', '/new'),
    incoming('held-before-resume-text', '交给新聊天'), incoming('resume-text-during-new', '/resume 1 交给旧聊天')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '迟到的新聊天' });
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  const old_reply = codex.submissions.find(message => message.prompt.endsWith('交给旧聊天'));
  const new_reply = codex.submissions.find(message => message.prompt.endsWith('交给新聊天'));
  assert.equal(old_reply.thread_id, THREAD);
  assert.equal(new_reply.thread_id, OTHER_THREAD);
});

test('新聊天创建期间可明确切回旧聊天，迟到登记不覆盖选择且旧暂存消息不改投', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.chat_list_text(ACCOUNT);
  receive_new_messages(store, { msgs: [incoming('pending-new', '/new'), incoming('held-before-switch', '交给新聊天'),
    incoming('switch-pending', '/resume 1'), incoming('after-resume', '交给旧聊天')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '迟到的新聊天' });
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  const targets = store.db.prepare("SELECT thread_id FROM weixin_answers WHERE raw_id IN ('held-before-switch','after-resume') ORDER BY id").all();
  assert.deepEqual(targets.map(row => row.thread_id), [OTHER_THREAD, THREAD]);
});

test('/clear 不再新建聊天，拒绝参数，普通提及和引用文字不触发清理', context => {
  const { store } = fixture(context);
  const body = sent_question(store);
  const quote = incoming('quoted-command', '请继续');
  quote.item_list[0].ref_msg = { message_item: { text_item: { text: body } }, title: '/clear' };
  store.receive_answers(ACCOUNT, { msgs: [incoming('mention-command', '解释 /clear'), quote,
    incoming('clear-command', '/CLEAR 新问题'), incoming('after-clear', '补充')] });
  const requests = store.db.prepare('SELECT * FROM weixin_new_requests').all();
  assert.equal(requests.length, 0);
  assert.equal(store.db.prepare("SELECT status FROM weixin_answers WHERE raw_id='after-clear'").get().status, 'received');
  assert.ok(store.pending_outbox(ACCOUNT).at(-1).text.includes('/clear 不需要参数'));
  assert.equal(store.known_chats(ACCOUNT).length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_questions').get().count, 1);
});

test('/clear 保留当前对话，清理后重启不恢复旧列表，引用与去重记录仍有效', async context => {
  const { store, open } = fixture(context);
  const old_body = sent_question(store);
  sent_question(store, 'clear-current', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const clear = incoming('clear-once', ' \n/CLEAR');
  store.receive_answers(ACCOUNT, { msgs: [clear] });
  const reopened = open();
  assert.deepEqual(reopened.known_chats(ACCOUNT).map(chat => chat.thread_id), [OTHER_THREAD]);
  assert.equal(reopened.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
  assert.ok(reopened.resume_chat(ACCOUNT, '2').includes('未找到'));
  assert.deepEqual(reopened.last_chat_list(ACCOUNT), []);
  assert.equal(reopened.chat_list_text(ACCOUNT), '当前：\n\n1 · 另一个聊天（当前绑定）');
  const quote = incoming('quote-cleared', '回答旧窗口');
  quote.item_list[0].ref_msg = { message_item: { text_item: { text: old_body } } };
  reopened.receive_answers(ACCOUNT, { msgs: [quote, incoming('plain-after-clear', '当前窗口处理'), clear] });
  const codex = fake_codex();
  await dispatch_answers(reopened, codex, ACCOUNT);
  assert.deepEqual(codex.submissions.map(message => message.thread_id), [THREAD, OTHER_THREAD]);
  await send_notification(reopened, { send() { assert.fail('清理不能导致旧通知重发'); } }, ACCOUNT,
    { message_id: 'question-0001', text: old_body });
  assert.equal(reopened.known_chats(ACCOUNT).length, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM weixin_questions').get().count, 2);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE kind='command'").get().count, 1);
});

test('清理后只有新发通知恢复旧窗口及内部标识，重复清理来信不隐藏新增联系', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const request = { message_id: 'prepared-before-clear', thread_id: THREAD, title: '再次联系', text: '新通知' };
  store.prepare_question(ACCOUNT, request);
  sent_question(store, 'same-time-source', THREAD);
  store.db.prepare('UPDATE weixin_questions SET created_at=100').run();
  sent_question(store, 'keep-current', OTHER_THREAD);
  const original = store.known_chats(ACCOUNT).find(chat => chat.thread_id === THREAD);
  const clear = incoming('clear-directory', '/clear');
  store.receive_answers(ACCOUNT, { msgs: [clear] });
  assert.equal(open().known_chats(ACCOUNT).length, 1);
  assert.equal(open().known_chats(ACCOUNT).length, 1);
  const notice = store.notification(ACCOUNT, request.message_id);
  store.claim_outbox(notice.id); store.finish_outbox(notice.id, 'api_accepted');
  const restored = store.known_chats(ACCOUNT).find(chat => chat.thread_id === THREAD);
  assert.equal(restored.id, original.id);
  assert.equal(restored.title, request.title);
  open().receive_answers(ACCOUNT, { msgs: [clear] });
  assert.equal(store.known_chats(ACCOUNT).length, 2);
});

test('清理列表不影响创建中的聊天和暂存消息；新建完成仍正常切换', context => {
  const { store } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('new-before-clear', '/new 新话题'),
    incoming('held-before-clear', '第一条补充'), incoming('clear-pending-new', '/clear'),
    incoming('held-after-clear', '第二条补充')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  assert.equal(store.active_chat(ACCOUNT).pending_request, request.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE status='waiting_new'").get().count, 2);
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '新话题' });
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  assert.ok(store.chat_list_text(ACCOUNT).split('\n\n')[1].includes('新话题'));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE raw_id LIKE 'held-%' AND thread_id=?")
    .get(OTHER_THREAD).count, 2);
});

test('清理列表隔离账号且与回信同事务，失败回滚，空列表也能处理', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'clear-isolation', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  const snapshot = store.last_chat_list(ACCOUNT);
  const stranger = { ...ACCOUNT, owner_id: 'stranger' };
  store.db.prepare(`INSERT INTO weixin_chat_choices(account_id,peer_id,thread_id,title,last_seen)
    VALUES (?,?,?,?,?)`).run(ACCOUNT.account_id, stranger.owner_id, THREAD, '其他用户', 1);
  const add_outbox = store.add_outbox.bind(store);
  store.add_outbox = () => { throw new Error('模拟回信落库失败'); };
  assert.throws(() => store.receive_answers(ACCOUNT, { msgs: [incoming('rollback-clear', '/clear')] }), /模拟/);
  assert.equal(store.known_chats(ACCOUNT).length, 2);
  assert.deepEqual(store.last_chat_list(ACCOUNT), snapshot);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_answers').get().count, 0);
  store.add_outbox = add_outbox;
  store.receive_answers(ACCOUNT, { msgs: [incoming('successful-clear', '/clear')] });
  assert.deepEqual(store.last_chat_list(ACCOUNT), []);
  assert.equal(store.known_chats(stranger).length, 1);
  const empty = fixture(context).store;
  empty.receive_answers(ACCOUNT, { msgs: [incoming('empty-clear', '/clear')] });
  assert.ok(empty.pending_outbox(ACCOUNT)[0].text.includes('已清理对话列表'));
  assert.equal(empty.active_chat(ACCOUNT), undefined);
});

test('精简会话列表省略旧未命名记录，当前窗口只出现一次、展示编号连续', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'named-current', OTHER_THREAD);
  const body = store.chat_list_text(ACCOUNT);
  assert.equal(body.split('另一个聊天').length - 1, 1);
  assert.ok(body.startsWith('当前：\n\n1 · 另一个聊天（当前绑定）\n\n'));
  assert.ok(body.includes('2 · 测试聊天'));
  store.db.prepare("UPDATE weixin_questions SET title='未命名聊天' WHERE thread_id=?").run(THREAD);
  assert.equal(store.chat_list_text(ACCOUNT), '当前：\n\n1 · 另一个聊天（当前绑定）');
  store.db.prepare("UPDATE weixin_questions SET title='' WHERE thread_id=?").run(OTHER_THREAD);
  assert.equal(store.chat_list_text(ACCOUNT), '当前：\n\n1（当前绑定）');
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
});

test('状态只报告实际桥接状态和待投递数，不把 queued 当作模型运行中', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('already-queued', '已入队')] });
  store.db.prepare("UPDATE weixin_answers SET status='queued'").run();
  receive_new_messages(store, { msgs: [incoming('new-status', '/new'), incoming('held-status', '补充')] });
  const text = store.chat_status_text(ACCOUNT);
  assert.ok(text.includes('收件器：未运行'));
  assert.ok(text.includes('待投递：1；等待新聊天：1；投递待核查：0'));
  assert.ok(text.includes('不代表 Codex 已开始或完成'));
  assert.equal(text.includes(THREAD), false);
});

test('命令只接受绑定用户完整私聊；未知命令和参数错误直接回复且不入模型队列', async context => {
  const { store } = fixture(context);
  sent_question(store);
  const changes = [{ from_user_id: 'stranger' }, { group_id: 'group' }, { message_type: 2 },
    { message_state: 1 }, { to_user_id: 'other-account' }, { item_list: [{ type: 2 }] }];
  store.receive_answers(ACCOUNT, { msgs: changes.map((change, index) => ({ ...incoming(`invalid-${index}`, '/clear'), ...change })) });
  store.receive_answers(ACCOUNT, { msgs: [incoming('unknown-command', '/stop'), incoming('bad-status', '/status extra'),
    incoming('status-command', '/status')] });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  const pending = store.pending_outbox(ACCOUNT);
  assert.equal(pending.length, 3);
  assert.ok(pending[0].text.includes('未支持'));
  assert.ok(pending[1].text.includes('不需要参数'));
});

test('任何斜杠开头的无效命令都直接提示，不回落上一个 AI 聊天', async context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const commands = ['/', '/ 中文', '/未知', '/123', '/newspaper', '/new?', '/new/abc',
    '/clear!', '/resume/2', '//help', '/?', ' \t/unknown', '\n /', '/help\n/new 不执行'];
  const messages = commands.map((text, index) => incoming(`strict-command-${index}`, text));
  messages[0].item_list[0].ref_msg = { title: '未知引用也不能绕过命令入口' };
  const page = { msgs: messages };
  store.receive_answers(ACCOUNT, page);
  open().receive_answers(ACCOUNT, page);
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(codex.submissions.length, 0);
  assert.equal(store.active_chat(ACCOUNT), undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  const answers = store.db.prepare('SELECT kind,status FROM weixin_answers').all();
  assert.equal(answers.length, commands.length);
  assert.ok(answers.every(answer => answer.kind === 'command' && answer.status === 'handled'));
  const sent = [];
  await flush_command_replies(store, { async send(message) { sent.push(message.text); } }, ACCOUNT);
  assert.equal(sent.length, commands.length);
  assert.ok(sent.every(text => text.includes('未支持此命令') || text.includes('不需要参数')));
});

test('命令忽略前置空白，正文和网址里的斜杠保持普通消息原文', async context => {
  const { store } = fixture(context);
  sent_question(store);
  const ordinary = ['介绍 /help 的用法', 'https://example.com/docs/help', '路径 a/b', '  普通消息 /status'];
  store.receive_answers(ACCOUNT, { msgs: [incoming('leading-help', ' \t\n/HELP'),
    ...ordinary.map((text, index) => incoming(`ordinary-slash-${index}`, text))] });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(codex.submissions.length, ordinary.length);
  assert.ok(codex.submissions.every((message, index) => message.prompt.endsWith(ordinary[index])));
  assert.ok(store.pending_outbox(ACCOUNT)[0].text.includes('微信便捷命令'));
  receive_new_messages(store, { msgs: [incoming('leading-new', ' \n/NEW 新话题'), incoming('invalid-pending', ' /未知')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  assert.equal(request.text, '新话题');
  assert.equal(store.db.prepare("SELECT kind FROM weixin_answers WHERE raw_id='invalid-pending'").get().kind, 'command');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE status='waiting_new'").get().count, 0);
});

test('微信复制命令残留的边界零宽空格不影响 /clear、/resume 和查询命令', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'zero-width-current', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  store.receive_answers(ACCOUNT, { msgs: [incoming('zero-width-resume', '\u200b \n/resume\u200b 1'),
    incoming('zero-width-clear', '/clear\u200b\u200b'), incoming('zero-width-help', '\u200b/HELP\u200b'),
    incoming('zero-width-status', '/status\u200b'), incoming('zero-width-sessions', '/sessions\u200b')] });
  assert.deepEqual(store.known_chats(ACCOUNT).map(chat => chat.thread_id), [OTHER_THREAD]);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 0);
  assert.ok(store.db.prepare('SELECT kind,status FROM weixin_answers').all()
    .every(answer => answer.kind === 'command' && answer.status === 'handled'));
  assert.ok(store.pending_outbox(ACCOUNT).every(message => !message.text.includes('未支持')));
  assert.ok(store.pending_outbox(ACCOUNT)[1].text.includes('已清理旧对话列表'));
});

test('零宽空格不拼接错误命令名，普通正文和 /new 问题原样保留', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'zero-width-other', OTHER_THREAD);
  const ordinary = ' \u200b正文\u200b里提到 /clear';
  store.receive_answers(ACCOUNT, { msgs: [incoming('ordinary-zero-width', ordinary),
    incoming('split-command-name', '/cl\u200bear'), incoming('invalid-command-tail', '/clear\u200bmore'),
    incoming('clear-has-argument', '/clear\u200b 参数')] });
  assert.equal(store.known_chats(ACCOUNT).length, 2);
  assert.equal(store.db.prepare("SELECT text FROM weixin_answers WHERE raw_id='ordinary-zero-width'").get().text, ordinary);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM weixin_answers WHERE kind='command'").get().count, 3);
  const question = '第一\u200b条问题\u200b';
  receive_new_messages(store, { msgs: [incoming('new-zero-width', `\u200b /new\u200b ${question}`)] });
  assert.equal(store.db.prepare('SELECT text FROM weixin_new_requests').get().text, question);
});

test('命令回信落库失败时路由、收件、序号目录与游标一起回滚', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'rollback-switch', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  store.add_outbox = () => { throw new Error('模拟落库失败'); };
  assert.throws(() => store.receive_answers(ACCOUNT, {
    msgs: [incoming('rollback-command', '/resume 2 测试正文')], get_updates_buf: 'must-rollback',
  }), /模拟落库失败/);
  assert.equal(store.active_chat(ACCOUNT), undefined);
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
  assert.equal(store.cursor(ACCOUNT.account_id), '');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_answers').get().count, 0);
});

test('命令回信结果不明时重启不自动重发', async context => {
  const { store, open } = fixture(context);
  store.receive_answers(ACCOUNT, { msgs: [incoming('uncertain-help', '/help')] });
  let calls = 0;
  const client = { async send() { calls++; throw new Error('连接断开'); } };
  await flush_command_replies(store, client, ACCOUNT);
  await flush_command_replies(open(), client, ACCOUNT);
  assert.equal(calls, 1);
  assert.equal(store.db.prepare('SELECT status FROM weixin_outbox').get().status, 'uncertain');
});

test('listen --once 直接回复便捷命令，禁止启动 Codex 或发送旧通知积压', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.prepare_notification(ACCOUNT, 'listener-backlog', '不应补发');
  const captured_path = join(directory, 'command-sent.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const command = { ...incoming('local-help', '/help\u200b\u200b'), create_time_ms: 1_790_000_000_000 };
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    globalThis.fetch=async(url,options)=>{
      if(url.endsWith('/getupdates'))return new Response(JSON.stringify({ret:0,msgs:[${JSON.stringify(command)}]}));
      if(!url.endsWith('/sendmessage'))throw new Error('禁止其他网络请求');
      writeFileSync(process.argv[2],options.body);return new Response('{"ret":0}');};
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    'listen', '--once', '--account', account_path, '--state', path, '--codex', join(directory, 'must-not-start.exe'),
  ]), captured_path], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(read_json(captured_path).msg.item_list[0].text_item.text.includes('/resume'));
  assert.equal(store.notification(ACCOUNT, 'listener-backlog').status, 'pending');
  const events = result.stderr.trim().split('\n').map(line => JSON.parse(line));
  const received = events.find(event => event.event === 'command_received');
  const sent = events.find(event => event.event === 'command_reply');
  assert.equal(received.source_created_at, command.create_time_ms);
  assert.equal(sent.answer_id, received.answer_id);
  assert.equal(sent.status, 'api_accepted');
  assert.ok(received.processing_ms >= 0 && sent.local_wait_ms >= 0 && sent.send_ms >= 0);
  assert.ok(Number.isFinite(Date.parse(sent.time)));
  assert.equal(result.stderr.includes('FAKE-'), false);
  assert.equal(result.stderr.includes('/help'), false);
});

for (const mode of ['empty', 'command', 'failure']) test(`收件间隔：${mode} 仅故障退避，正常返回立即续收`, context => {
  const { path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  const captured_path = join(directory, 'poll-times.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    const mode=process.argv[3], polls=[], sends=[];
    globalThis.fetch=async(url)=>{
      if(url.endsWith('/sendmessage')){sends.push(Date.now());return new Response('{"ret":0}');}
      if(!url.endsWith('/getupdates'))throw new Error('禁止其他网络请求');
      polls.push(Date.now());
      if(polls.length===2){writeFileSync(process.argv[2],JSON.stringify({polls,sends}));
        process.emit('SIGTERM');return new Response('{"msgs":[]}');}
      if(mode==='failure')throw new Error('模拟网络故障');
      return new Response(JSON.stringify({msgs:mode==='command'?[${JSON.stringify(incoming('fast-command', '/sessions'))}]:[]}));
    };
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    'listen', '--account', account_path, '--state', path, '--codex', join(directory, 'must-not-start.exe'),
  ]), captured_path, mode], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const timing = read_json(captured_path);
  const interval = timing.polls[1] - timing.polls[0];
  if (mode === 'failure') assert.ok(interval >= 1_800, `故障仍需退避，实际 ${interval}ms`);
  else assert.ok(interval < 1_000, `正常收件不应再固定等待 2 秒，实际 ${interval}ms`);
  assert.equal(timing.sends.length, mode === 'command' ? 1 : 0);
});

test('长轮询自然超时立即续收；停止、网络错误及发送超时仍向上传递', async () => {
  const timeout = new DOMException('模拟长轮询截止', 'TimeoutError');
  const client = new IlinkClient(ACCOUNT, { fetch: async () => { throw timeout; } });
  assert.deepEqual(await client.updates('saved-cursor'), { msgs: [] });
  await assert.rejects(client.send({}), error => error === timeout);
  const controller = new AbortController();
  controller.abort();
  const stopped = new IlinkClient(ACCOUNT, { signal: controller.signal, fetch: async () => { throw timeout; } });
  await assert.rejects(stopped.updates('saved-cursor'), error => error === timeout);
  const failure = new Error('网络故障');
  const broken = new IlinkClient(ACCOUNT, { fetch: async () => { throw failure; } });
  await assert.rejects(broken.updates('saved-cursor'), error => error === failure);
});

test('旧聊天 ask 后另一个窗口 notify hi，微信直接回复准确回发 hi 的窗口', async context => {
  const { store } = fixture(context);
  const old_body = sent_question(store);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const request = { message_id: 'hi-from-other-chat', thread_id: OTHER_THREAD, title: '用微信发个 hi', text: 'hi', mode: 'notify' };
  const text = store.prepare_question(ACCOUNT, request);
  await send_notification(store, { async send() { return { message_id: 'hi-server-id' }; } }, ACCOUNT,
    { message_id: request.message_id, text });
  const quoted = incoming('reply-to-old-window', '回答旧问题');
  quoted.item_list[0].ref_msg = { message_item: { text_item: { text: old_body } } };
  store.receive_answers(ACCOUNT, { msgs: [incoming('who-are-you', '你是谁'), quoted] });
  const codex = fake_codex();
  await dispatch_answers(store, codex, ACCOUNT);
  assert.deepEqual(codex.submissions.map(message => message.thread_id), [OTHER_THREAD, THREAD]);
  assert.ok(codex.submissions[0].prompt.endsWith('你是谁'));
  assert.equal(store.db.prepare("SELECT question_id FROM weixin_answers WHERE raw_id='who-are-you'").get().question_id,
    request.message_id);
});

test('默认来源跟随发送完成顺序，未发送和明确失败的通知不抢目标，旧通知重试也不切回', async context => {
  const { store, open } = fixture(context);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const first = { message_id: 'prepared-first', thread_id: THREAD, title: '先准备后发送', text: 'A', mode: 'notify' };
  const second = { message_id: 'prepared-second', thread_id: OTHER_THREAD, title: '后准备先发送', text: 'B', mode: 'notify' };
  const first_text = store.prepare_question(ACCOUNT, first);
  const second_text = store.prepare_question(ACCOUNT, second);
  const client = { async send() { return {}; } };
  await send_notification(store, client, ACCOUNT, { message_id: second.message_id, text: second_text });
  await send_notification(store, client, ACCOUNT, { message_id: first.message_id, text: first_text });
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
  assert.ok(store.notification(ACCOUNT, first.message_id).sent_order > store.notification(ACCOUNT, second.message_id).sent_order);
  await send_notification(open(), client, ACCOUNT, { message_id: second.message_id, text: second_text });
  store.prepare_question(ACCOUNT, { ...second, message_id: 'unsent-recent-notice' });
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
  const failed = store.notification(ACCOUNT, 'unsent-recent-notice');
  store.claim_outbox(failed.id); store.finish_outbox(failed.id, 'failed');
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
});

test('手动目标只被本用户成功的新通知更新，失败、不确定、系统回执及旧通知重试不改路由', async context => {
  const { store, open } = fixture(context);
  const old_body = sent_question(store);
  sent_question(store, 'another-chat', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  store.receive_answers(ACCOUNT, { msgs: [incoming('choose-old-chat', '/resume 2')] });
  const request = { message_id: 'next-notification', thread_id: OTHER_THREAD, title: '新通知', text: '内容', mode: 'notify' };
  store.prepare_question(ACCOUNT, request);
  const notice = store.notification(ACCOUNT, request.message_id);
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  store.claim_outbox(notice.id);
  store.finish_outbox(notice.id, 'uncertain');
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  store.finish_outbox(notice.id, 'failed');
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  const stranger = { ...ACCOUNT, owner_id: 'someone-else' };
  store.prepare_question(stranger, request);
  const other_notice = store.notification(stranger, request.message_id);
  store.claim_outbox(other_notice.id); store.finish_outbox(other_notice.id, 'api_accepted');
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
  sent_question(store, 'accepted-next-notice', OTHER_THREAD);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  const client = { async send() { return {}; } };
  await flush_command_replies(store, client, ACCOUNT);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  await send_notification(open(), { send() { assert.fail('不能重发旧通知'); } }, ACCOUNT,
    { message_id: 'question-0001', text: old_body });
  store.finish_outbox(store.notification(ACCOUNT, 'question-0001').id, 'api_accepted');
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
});

test('创建期间新通知也更新绑定，之前暂存消息仍交给新聊天，迟到登记不覆盖最新通知', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  receive_new_messages(store, { msgs: [incoming('start-pending-chat', '/new 创建')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.receive_answers(ACCOUNT, { msgs: [incoming('held-before-notice', '给新聊天')] });
  const held = store.db.prepare("SELECT * FROM weixin_answers WHERE raw_id='held-before-notice'").get();
  assert.equal(held.status, 'waiting_new');
  assert.equal(held.request_id, request.id);
  sent_question(store, 'notice-during-creation', OTHER_THREAD);
  assert.equal(open().active_chat(ACCOUNT).pending_request, null);
  assert.equal(store.active_chat(ACCOUNT).thread_id, OTHER_THREAD);
  store.receive_answers(ACCOUNT, { msgs: [incoming('reply-after-notice', '回复最新通知')] });
  const latest = store.db.prepare("SELECT * FROM weixin_answers WHERE raw_id='reply-after-notice'").get();
  assert.equal(latest.status, 'received');
  assert.equal(latest.thread_id, OTHER_THREAD);
  assert.equal(latest.request_id, null);
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  const new_thread = '00000000-0000-0000-0000-000000000003';
  store.complete_new_request(ACCOUNT, request.id, { thread_id: new_thread, title: '新聊天' });
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, OTHER_THREAD);
  sent_question(store, 'notice-after-registration', THREAD);
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
  assert.equal(store.db.prepare('SELECT thread_id FROM weixin_answers WHERE id=?').get(held.id).thread_id, new_thread);
});

test('通知成功回执和目标更新同事务，路由写入失败不留下半成功状态', context => {
  const { store } = fixture(context);
  sent_question(store);
  sent_question(store, 'transaction-other', OTHER_THREAD);
  store.chat_list_text(ACCOUNT);
  store.receive_answers(ACCOUNT, { msgs: [incoming('transaction-switch', '/resume 2')] });
  store.prepare_question(ACCOUNT, { message_id: 'transaction-notice', thread_id: OTHER_THREAD, title: '通知', text: '内容' });
  const notice = store.notification(ACCOUNT, 'transaction-notice');
  store.claim_outbox(notice.id);
  store.db.exec(`CREATE TRIGGER fail_route BEFORE UPDATE ON weixin_active_chats
    BEGIN SELECT RAISE(ABORT, '模拟路由落库失败'); END`);
  assert.throws(() => store.finish_outbox(notice.id, 'api_accepted'), /模拟路由落库失败/);
  assert.equal(store.notification(ACCOUNT, 'transaction-notice').status, 'uncertain');
  assert.equal(store.notification(ACCOUNT, 'transaction-notice').sent_order, null);
  assert.equal(store.active_chat(ACCOUNT).thread_id, THREAD);
});

test('首次聊天没有标题时不发送未命名通知；命名后沿用原编号发送且只查本聊天元数据', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  store.db.prepare("INSERT INTO weixin_listeners VALUES (?,?,'running')").run(ACCOUNT.account_id, process.pid);
  const captured_path = join(directory, 'named-notice.json');
  const module_url = new URL('../weixin_bridge.mjs', import.meta.url).href;
  const codex_url = new URL('../message_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    import {CodexClient} from ${JSON.stringify(codex_url)};
    CodexClient.prototype.metadata=async id=>{if(id!==process.env.CODEX_THREAD_ID)throw new Error('错误来源');
      return {name:process.argv[3]||null};};
    globalThis.fetch=async(url,options)=>{if(!url.endsWith('/sendmessage'))throw new Error('禁止其他请求');
      writeFileSync(process.argv[2],options.body);return new Response('{"ret":0}');};
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const args = ['--input-type=module', '-e', script, JSON.stringify([
    'notify', '--account', account_path, '--state', path, '--message-id', 'first-title-notice', '--text', 'hi',
    '--codex', join(directory, 'must-not-start.exe'),
  ]), captured_path];
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5000, env: { ...process.env, CODEX_THREAD_ID: THREAD } };
  const unnamed = spawnSync(process.execPath, [...args, ''], options);
  assert.equal(unnamed.status, 1);
  assert.ok(unnamed.stderr.includes('set_thread_title'));
  assert.equal(existsSync(captured_path), false);
  assert.equal(store.notification(ACCOUNT, 'first-title-notice'), undefined);
  const named = spawnSync(process.execPath, [...args, '微信问候'], options);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(read_json(captured_path).msg.item_list[0].text_item.text, '💬 Codex（微信问候）：\n\nhi');
  assert.equal(store.answer_target(ACCOUNT, { references: [] }).thread_id, THREAD);
});

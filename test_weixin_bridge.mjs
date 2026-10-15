import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatch_answers, flush_outbox, format_notice, process_weixin, send_notification,
  weixin_text, WeixinStore } from './weixin_bridge.mjs';
import {
  acquire_account_lock, begin_login, complete_login, IlinkClient, IlinkError,
  load_account, parse_ilink_json, read_json, save_json, validate_base_url,
} from './weixin_client.mjs';

const THREAD = '01a13ecf-eb91-75f1-972f-45d338554e5b';
const OTHER_THREAD = '01a13e92-92ea-7923-8d46-cba0552b6db7';
const ACCOUNT = { account_id: 'test@im.bot', owner_id: 'owner', token: 'FAKE-TOKEN',
  base_url: 'https://ilinkai.weixin.qq.com' };
const MODULE_URL = new URL('./weixin_client.mjs', import.meta.url).href;

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
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./weixin_bridge.mjs', import.meta.url)),
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
  const release_receiver = acquire_account_lock(account_path);
  const text_path = join(directory, '通知 正文.txt');
  const captured_path = join(directory, 'request.json');
  const text = '任务完成\n中文“引号”😀 & $()';
  writeFileSync(text_path, `\uFEFF${text}`, 'utf8');
  const module_url = new URL('./weixin_bridge.mjs', import.meta.url).href;
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
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  } finally { release_receiver(); }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'api_accepted');
  assert.equal(read_json(captured_path).msg.item_list[0].text_item.text, `Codex（测试通知）：\n${text}`);
  assert.equal(result.stdout.includes('FAKE-'), false);
});

test('发送无需收件锁，但 sync 仍拒绝第二个收件者', context => {
  const { path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  const release_receiver = acquire_account_lock(account_path);
  const module_url = new URL('./weixin_bridge.mjs', import.meta.url).href;
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
  assert.ok(queued[0].prompt.endsWith('继续\n保留“中文”😀 & $()'));
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

test('listen --once CLI 仅调用 queue，不启动 App Server，不回收旧桥接任务', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  sent_question(store);
  const captured_path = join(directory, 'queue.json');
  const module_url = new URL('./weixin_bridge.mjs', import.meta.url).href;
  const codex_url = new URL('./message_bridge.mjs', import.meta.url).href;
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
  assert.ok(read_json(captured_path).prompt.endsWith('继续操作'));
  assert.equal(JSON.parse(result.stdout).running, false);
  assert.equal(result.stdout.includes('FAKE-'), false);
});

test('ask 从当前 CODEX_THREAD_ID 记录来源，复用收件器并发送带聊天名称的问题', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  store.receive_context(ACCOUNT, { msgs: [incoming()] });
  store.db.prepare("INSERT INTO weixin_listeners VALUES (?,?,'running')").run(ACCOUNT.account_id, process.pid);
  const captured_path = join(directory, 'question.json');
  const module_url = new URL('./weixin_bridge.mjs', import.meta.url).href;
  const script = `import {writeFileSync} from 'node:fs';
    import {main} from ${JSON.stringify(module_url)};
    globalThis.fetch=async(url,options)=>{
      if(!url.endsWith('/sendmessage'))throw new Error('禁止读取微信或聊天历史');
      writeFileSync(process.argv[2],options.body);return new Response('{"ret":0}');};
    process.exitCode=await main(JSON.parse(process.argv[1]));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([
    'ask', '--account', account_path, '--state', path, '--message-id', 'ask-env-0001', '--text', '接着做吗？',
    '--title', '测试聊天', '--codex', join(directory, 'must-not-start.exe'),
  ]), captured_path], { encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...process.env, CODEX_THREAD_ID: THREAD } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).thread_id, THREAD);
  assert.equal(read_json(captured_path).msg.item_list[0].text_item.text, 'Codex（测试聊天）：\n接着做吗？');
  assert.equal(store.db.prepare('SELECT thread_id FROM weixin_questions').get().thread_id, THREAD);
});

test('微信展示去掉常见 Markdown，保留链接地址、代码与中文段落', () => {
  const text = '# 结果\n\n**完成**，~~旧方案~~。\n- [文档](https://example.com/docs)\n'
    + '\n`snake_case * literal`\n```js\nconst result = a * b; // **keep**\n```';
  const result = format_notice('桥接优化', text);
  assert.ok(result.startsWith('Codex（桥接优化）：\n结果\n\n完成，旧方案。'));
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
  assert.equal(first, 'Codex（中文聊天名称）：\n完成');
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

test('/new 只在新正文开头触发，后续消息暂存，新窗口登记后切换而不继承旧问答', async context => {
  const { store } = fixture(context);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('new-command', '/new 聊聊建筑摄影'), incoming('after-new', '偏好黑白')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  const queued = [];
  const codex = { async queue(message) { queued.push(message); return 'ok'; } };
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].thread_id, THREAD);
  assert.ok(queued[0].prompt.includes('create_thread'));
  assert.ok(queued[0].prompt.endsWith('/new 聊聊建筑摄影'));
  assert.equal(store.reply_status(ACCOUNT).replies[0].status, 'waiting_new');
  const claim = store.claim_new_request(ACCOUNT, request.id, THREAD);
  assert.equal(claim.claimed, true);
  assert.ok(claim.prompt.includes('聊聊建筑摄影'));
  assert.equal(claim.prompt.includes('请选择下一步'), false);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '建筑摄影' });
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(queued[1].thread_id, OTHER_THREAD);
  assert.ok(queued[1].prompt.endsWith('偏好黑白'));
  store.receive_answers(ACCOUNT, { msgs: [incoming('next', '继续')] });
  await dispatch_answers(store, codex, ACCOUNT);
  assert.equal(queued[2].thread_id, OTHER_THREAD);
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
  store.receive_answers(ACCOUNT, { msgs: [explicit] });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM weixin_new_requests').get().count, 1);
});

test('/new 去重、领取和重新登记幂等；不接受旧线程冒充新聊天', context => {
  const { store, open } = fixture(context);
  sent_question(store);
  const page = { msgs: [incoming('new-once', '/new 你好')] };
  store.receive_answers(ACCOUNT, page);
  open().receive_answers(ACCOUNT, page);
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

test('新聊天已经切换时，迟到的旧问题不改变默认目标，明确引用仍回旧聊天', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('new-active', '/new 切换')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  store.claim_new_request(ACCOUNT, request.id, THREAD);
  store.complete_new_request(ACCOUNT, request.id, { thread_id: OTHER_THREAD, title: '新聊天' });
  const body = sent_question(store, 'late-old-question', THREAD);
  assert.equal(store.answer_target(ACCOUNT, { references: [], text: '继续' }).thread_id, OTHER_THREAD);
  assert.equal(store.answer_target(ACCOUNT, { references: [{ message_item: { text_item: { text: body } } }], text: '回复' })
    .thread_id, THREAD);
});

test('多个 /new 的登记乱序时，较早请求不会覆盖最新选择', context => {
  const { store } = fixture(context);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('new-first', '/new 第一件事'), incoming('new-second', '/new 第二件事')] });
  const requests = store.db.prepare('SELECT * FROM weixin_new_requests ORDER BY created_at,rowid').all();
  requests.forEach(request => store.claim_new_request(ACCOUNT, request.id, THREAD));
  store.complete_new_request(ACCOUNT, requests[0].id, { thread_id: OTHER_THREAD, title: '第一件事' });
  assert.equal(store.active_chat(ACCOUNT).pending_request, requests[1].id);
});

test('新聊天 CLI 用当前来源领取请求，再用实际返回的目标登记，不启动模型或读取历史', context => {
  const { store, path, account_path, directory } = fixture(context);
  save_json(account_path, ACCOUNT);
  sent_question(store);
  store.receive_answers(ACCOUNT, { msgs: [incoming('cli-new', '/new 一个新话题')] });
  const request = store.db.prepare('SELECT * FROM weixin_new_requests').get();
  const executable = fileURLToPath(new URL('./weixin_bridge.mjs', import.meta.url));
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

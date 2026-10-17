import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { find_message_turn, MessageStore, process_message } from '../message_bridge.mjs';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_THREAD = '22222222-2222-4222-8222-222222222222';
const CLI_PATH = fileURLToPath(new URL('../message_bridge.mjs', import.meta.url));

/** Create an isolated SQLite store and register safe cleanup for its temporary directory. */
function test_store(context) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-bridge-test-'));
  const path = join(directory, 'state.sqlite3');
  const stores = [];
  const open = () => { const store = new MessageStore(path); stores.push(store); return store; };
  context.after(() => {
    for (const store of stores) { try { store.close(); } catch {} }
    if (dirname(resolve(directory)) !== resolve(tmpdir())
        || !basename(directory).startsWith('codex-bridge-test-')) throw new Error('临时目录越界');
    rmSync(directory, { recursive: true, force: true });
  });
  return { store: open(), open, path };
}

/** Build a mock incoming message with the same contract as the local CLI. */
function incoming(message_id = 'test-001', text = '只回复测试完成') {
  return { message_id, thread_id: THREAD_ID, text };
}

/** Build a native-shaped turn containing an exact input, commentary and final reply. */
function reply_turn(message, status = 'completed') {
  return {
    id: `turn-${message.message_id}`, status,
    startedAt: 100, completedAt: status === 'inProgress' ? null : 101,
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: message.prompt }] },
      { type: 'agentMessage', phase: 'commentary', text: '这是进度，不是最终回复' },
      { type: 'agentMessage', phase: 'final_answer', text: `回复:${message.message_id}` },
    ],
  };
}

/** Simulate only the Codex boundary; all persistence uses real temporary SQLite. */
function fake_client() {
  return {
    submissions: [], turns: [],
    async queue(message) {
      this.submissions.push(message);
      this.turns.unshift(reply_turn(message));
      return `Queued ${message.message_id}`;
    },
    async list_turns() { return { data: this.turns, nextCursor: null }; },
  };
}

test('相同编号去重、正文原样保存，跨内容或目标复用编号被拒绝', context => {
  const { store } = test_store(context);
  const message = incoming('unicode-001', ' 中文“引号” 😀\n$() `x` & | \\尾部 ');
  const first = store.enqueue(message);
  const duplicate = store.enqueue(message);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message.prompt, first.message.prompt);
  assert.equal(duplicate.message.text, message.text);
  assert.throws(() => store.enqueue({ ...message, text: '不同正文' }), /不同/);
  assert.throws(() => store.enqueue({ ...message, thread_id: OTHER_THREAD }), /不同/);
  assert.equal(store.list().length, 1);
});

test('完成一轮只返回最终回复，重复处理不再次投递', async context => {
  const { store } = test_store(context);
  const client = fake_client();
  store.enqueue(incoming());
  const first = await process_message(store, client, 'test-001');
  const second = await process_message(store, client, 'test-001');
  assert.equal(first.status, 'completed');
  assert.equal(first.reply, '回复:test-001');
  assert.equal(first.turn_id, 'turn-test-001');
  assert.equal(second.reply, first.reply);
  assert.equal(client.submissions.length, 1);
});

test('两个数据库连接并行处理同一条消息时只领取和发送一次', async context => {
  const { store, open } = test_store(context);
  const competing_store = open();
  const client = fake_client();
  const original_queue = client.queue;
  client.queue = async function queue(message) {
    await sleep(10);
    return original_queue.call(this, message);
  };
  store.enqueue(incoming());
  await Promise.all([
    process_message(store, client, 'test-001'),
    process_message(competing_store, client, 'test-001'),
  ]);
  assert.equal(client.submissions.length, 1);
  assert.equal(store.get('test-001').status, 'completed');
});

test('已入队后退出，重新打开数据库能读回结果且不重投', async context => {
  const { store, open } = test_store(context);
  const { message } = store.enqueue(incoming());
  store.claim(message.message_id, 'older-turn');
  store.accepted(message.message_id, 'accepted-before-exit');
  store.close();
  const restarted = open();
  const client = fake_client();
  client.turns = [reply_turn(message), { id: 'older-turn', items: [] }];
  const result = await process_message(restarted, client, message.message_id);
  assert.equal(result.status, 'completed');
  assert.equal(client.submissions.length, 0);
  assert.equal(result.queue_receipt, 'accepted-before-exit');
});

test('queue 已接受但回执丢失时通过精确输入对账恢复', async context => {
  const { store } = test_store(context);
  const client = fake_client();
  client.queue = async function queue(message) {
    this.submissions.push(message);
    this.turns = [reply_turn(message)];
    throw new Error('回执丢失');
  };
  store.enqueue(incoming());
  const result = await process_message(store, client, 'test-001');
  assert.equal(result.status, 'completed');
  assert.equal(result.last_error, '');
  assert.equal(client.submissions.length, 1);
});

test('领取后崩溃且找不到消息时保持待核查，不自动补发', async context => {
  const { store, open } = test_store(context);
  store.enqueue(incoming());
  store.claim('test-001', null);
  store.close();
  const restarted = open();
  const client = fake_client();
  await process_message(restarted, client, 'test-001');
  await process_message(restarted, client, 'test-001');
  assert.equal(restarted.get('test-001').status, 'uncertain');
  assert.match(restarted.get('test-001').last_error, /核查/);
  assert.equal(client.submissions.length, 0);
});

test('跨历史分页定位原始输入，忽略其他轮次、引文和中间回复', async context => {
  const { store } = test_store(context);
  const { message } = store.enqueue(incoming());
  store.claim(message.message_id, 'anchor');
  store.accepted(message.message_id, 'receipt');
  const requested = [];
  const client = {
    async list_turns(thread_id, options) {
      assert.equal(thread_id, THREAD_ID);
      requested.push(options.cursor);
      if (options.cursor) return { data: [reply_turn(message), { id: 'anchor', items: [] }] };
      return { data: [
        { id: 'quote', items: [{ type: 'agentMessage', text: message.prompt, phase: 'final_answer' }] },
        { id: 'prefix', items: [{ type: 'userMessage', content: [{ type: 'text', text: `引用:${message.prompt}` }] }] },
      ], nextCursor: 'page-2' };
    },
  };
  const result = await process_message(store, client, message.message_id);
  assert.deepEqual(requested, [undefined, 'page-2']);
  assert.equal(result.reply, '回复:test-001');
  assert.equal(result.turn_id, 'turn-test-001');
});

test('只接受匹配轮次的完成状态；中断保留错误且不重投', async context => {
  const { store } = test_store(context);
  const { message } = store.enqueue(incoming());
  store.claim(message.message_id, null);
  store.accepted(message.message_id, 'receipt');
  const client = fake_client();
  client.turns = [reply_turn(message, 'inProgress')];
  let result = await process_message(store, client, message.message_id);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reply, null);
  client.turns[0].status = 'interrupted';
  client.turns[0].completedAt = 101;
  result = await process_message(store, client, message.message_id);
  assert.equal(result.status, 'failed');
  assert.match(result.last_error, /interrupted/);
  await process_message(store, client, message.message_id);
  assert.equal(client.submissions.length, 0);
});

test('投递前读取失败不领取消息，修复读取后可正常发送', async context => {
  const { store } = test_store(context);
  store.enqueue(incoming());
  const client = fake_client();
  const original_read = client.list_turns;
  client.list_turns = async () => { throw new Error('读取暂时断线'); };
  await assert.rejects(process_message(store, client, 'test-001'), /断线/);
  assert.equal(store.get('test-001').status, 'received');
  assert.equal(client.submissions.length, 0);
  client.list_turns = original_read;
  assert.equal((await process_message(store, client, 'test-001')).status, 'completed');
});

test('独立读取暂现 interrupted 但没有结束时间时继续等待真实完成', async context => {
  const { store } = test_store(context);
  const { message } = store.enqueue(incoming());
  store.claim(message.message_id, null);
  store.accepted(message.message_id, 'receipt');
  const client = fake_client();
  client.turns = [{ ...reply_turn(message, 'interrupted'), completedAt: null }];
  let result = await process_message(store, client, message.message_id);
  assert.equal(result.status, 'waiting');
  assert.equal(result.reply, null);
  client.turns = [reply_turn(message)];
  result = await process_message(store, client, message.message_id);
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, '回复:test-001');
  assert.equal(client.submissions.length, 0);
});

test('投递后的读取失败保留队列状态，恢复读取不会重复发送', async context => {
  const { store } = test_store(context);
  const { message } = store.enqueue(incoming());
  store.claim(message.message_id, null);
  store.accepted(message.message_id, 'receipt');
  const client = fake_client();
  const original_read = client.list_turns;
  client.list_turns = async () => { throw new Error('读取连接关闭'); };
  await assert.rejects(process_message(store, client, message.message_id), /关闭/);
  assert.equal(store.get(message.message_id).status, 'queued');
  client.list_turns = original_read;
  client.turns = [reply_turn(message)];
  assert.equal((await process_message(store, client, message.message_id)).status, 'completed');
  assert.equal(client.submissions.length, 0);
});

test('遇到投递前历史锚点停止检索，不读取更早页面', async context => {
  const { store } = test_store(context);
  const { message } = store.enqueue(incoming());
  let reads = 0;
  const client = { async list_turns() {
    reads += 1;
    return { data: [{ id: 'anchor', items: [] }], nextCursor: 'must-not-read' };
  } };
  const result = await find_message_turn(client, { ...message, anchor_turn_id: 'anchor' });
  assert.equal(result, null);
  assert.equal(reads, 1);
});

test('较晚的旧状态不能覆盖已保存的最终回复', context => {
  const { store } = test_store(context);
  store.enqueue(incoming());
  store.record('test-001', { status: 'completed', reply: '最终回复', turn_id: 'final-turn' });
  store.record('test-001', { status: 'waiting', last_error: '过期错误' });
  store.accepted('test-001', '过期回执');
  assert.equal(store.get('test-001').status, 'completed');
  assert.equal(store.get('test-001').reply, '最终回复');
  assert.equal(store.get('test-001').last_error, '');
});

test('独立 CLI 进程模拟收件、去重、状态查询，Unicode 和换行原样保存', context => {
  const { path } = test_store(context);
  const text = '中文😀\n"引号" \'单引号\' $() `反引号` & |';
  const args = [CLI_PATH, 'send', '--thread', THREAD_ID, '--message-id', 'cli-001',
    '--text', text, '--state', path, '--enqueue-only'];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).duplicate, false);
  assert.equal(JSON.parse(first.stdout).message.text, text);
  const second = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).duplicate, true);
  const status = spawnSync(process.execPath, [CLI_PATH, 'status', '--state', path], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(status.status, 0, status.stderr);
  const messages = JSON.parse(status.stdout).messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, 'received');
});

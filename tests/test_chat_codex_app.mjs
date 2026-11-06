import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapter_of } from '../runner/adapters/index.mjs';
import { codex_chat } from '../runner/adapters/codex_app.mjs';

const THREAD = 'thread-1';
const PROMPT = '私聊开头\n\n请看一下 a < b & c';

/** The App's wrapping of a delivered message, with its text XML-escaped as the App writes it. */
function delegation(id, text) {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return { type: 'functionCallOutput', id, name: 'send_message_to_thread', output: { text: `<codex_delegation>\n  <source_thread_id>${THREAD}</source_thread_id>\n  <input>${escaped}</input>\n</codex_delegation>`, truncated: false } };
}

/** A stand-in for the App: `script(reads)` gives the chat's state on each read after the line was sent. */
class FakeApp {
  constructor(script, calls) { this.script = script; this.calls = calls; }
  async read_thread(thread_id, options) {
    this.calls.push(['read', thread_id, options.turnLimit]);
    if (!this.calls.some(call => call[0] === 'send')) return { thread: { status: { type: 'idle' } }, turns: [{ id: 'old', status: 'completed', items: [delegation('old-in', PROMPT)] }] };
    return this.script(this.calls.filter(call => call[0] === 'read').length);
  }
  async send_message(thread_id, text) { this.calls.push(['send', thread_id, text]); }
  async set_archived(thread_id, archived) { this.calls.push(['archive', thread_id, archived]); }
  close() {}
}

function chat_task(directory, events) {
  let settle;
  const done = new Promise(resolve => { settle = resolve; });
  const task = { id: 'chat-7', chat: true, prompt: PROMPT, directory,
    on_note: text => events.notes.push(text), on_exit: () => settle({}), on_failure: reason => settle({ reason }),
    on_process: handle => { events.handle = handle; },
    on_output: (path, line) => events.lines.push([path, JSON.parse(line)]) };
  return { task, done };
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-chat-codex-'));
  return { directory, calls: [], events: { notes: [], lines: [] }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

const running_turn = items => ({ id: 'new', status: 'inProgress', items: [delegation('in', PROMPT), ...items] });

test('Codex App private chat sends into the member chat, logs its steps and reports the final answer', async () => {
  const { directory, calls, events, cleanup } = setup();
  const commentary = { type: 'agentMessage', id: 'm1', phase: 'commentary', text: '先看一下目录。' };
  const command = { type: 'commandExecution', id: 'c1', command: '"pwsh.exe" -Command \'Get-ChildItem\'', status: 'completed', exitCode: 0, output: { text: 'a.txt' } };
  const search = { type: 'webSearch', id: 's1', query: 'binary search' };
  const edit = { type: 'fileChange', id: 'e1', status: 'completed', changes: [{ path: 'note.txt', kind: { type: 'add' }, diff: { text: '+hello' } }] };
  const final = { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: '看完了，**有 a.txt**。' };
  const script = reads => reads < 4 ? { thread: { status: { type: 'active' } }, turns: [running_turn(reads < 3 ? [commentary] : [commentary, command]), { id: 'old', status: 'completed', items: [] }] }
    : { thread: { status: { type: 'idle' } }, turns: [{ ...running_turn([commentary, command, search, edit, final]), status: 'completed' }] };
  const { task, done } = chat_task(directory, events);
  assert.equal(typeof adapter_of('codex').chat, 'function', 'a private chat turn reaches this adapter through deliver_task');
  const result = await codex_chat({}, { session_id: THREAD }, task, { connect: async () => new FakeApp(script, calls), poll_ms: 1 });
  assert.equal(result.status, 'accepted');
  assert.equal(result.session_id, THREAD);
  assert.deepEqual(result.capabilities, { stoppable: true, progress: true });
  assert.deepEqual(await done, {});
  assert.deepEqual(events.notes, ['看完了，**有 a.txt**。']);
  assert.deepEqual(calls.find(call => call[0] === 'send'), ['send', THREAD, PROMPT]);
  assert.ok(events.lines.every(([path]) => path === join(directory, 'codex-chat-7.log')));
  const entries = new Map(events.lines.map(([, line]) => [line.entry.id, line.entry]));
  assert.equal(events.lines.filter(([, line]) => line.entry.id === 'm1').length, 1, 'an unchanged entry is written once');
  assert.deepEqual([...entries.values()].map(entry => [entry.kind, entry.title ?? entry.body, entry.state]), [
    ['message', '先看一下目录。', 'done'], ['command', 'Get-ChildItem', 'done'], ['search', 'binary search', 'done'], ['edit', 'note.txt', 'done']]);
  cleanup();
});

test('Codex App private chat reports a turn that ended without a reply, or was interrupted in the App', async () => {
  for (const [status, items, reason] of [['completed', [], '它没有给出文字回复'], ['interrupted', [], '这一轮在 Codex App 中被中断']]) {
    const { directory, calls, events, cleanup } = setup();
    const { task, done } = chat_task(directory, events);
    const script = () => ({ thread: { status: { type: 'idle' } }, turns: [{ ...running_turn(items), status }] });
    await codex_chat({}, { session_id: THREAD }, task, { connect: async () => new FakeApp(script, calls), poll_ms: 1 });
    assert.deepEqual(await done, { reason });
    assert.deepEqual(events.notes, []);
    cleanup();
  }
});

test('Codex App private chat stops waiting at its time limit and when the App cannot be read', async () => {
  const { directory, calls, events, cleanup } = setup();
  const { task, done } = chat_task(directory, events);
  const script = () => ({ thread: { status: { type: 'active' } }, turns: [running_turn([])] });
  await codex_chat({}, { session_id: THREAD }, task, { connect: async () => new FakeApp(script, calls), poll_ms: 1, timeout_ms: 30 });
  assert.match((await done).reason, /等待上限/);
  const lost = chat_task(directory, events);
  const failing = () => { throw new Error('桌面连接已关闭'); };
  const lost_calls = [];
  await codex_chat({}, { session_id: THREAD }, lost.task, { connect: async () => new FakeApp(failing, lost_calls), poll_ms: 1 });
  assert.match((await lost.done).reason, /读取 Codex App 会话失败：桌面连接已关闭/);
  cleanup();
});

test('Codex App private chat fails before sending without a chat, and kill() archives then restores the chat', async () => {
  const { directory, calls, events, cleanup } = setup();
  const { task, done } = chat_task(directory, events);
  await assert.rejects(codex_chat({}, {}, task, { connect: async () => new FakeApp(() => null, calls) }), error => error.delivery_status === 'not_sent');
  let archived = false;
  const app = new FakeApp(() => ({ thread: { status: { type: archived ? 'notLoaded' : 'active' } }, turns: [{ ...running_turn([]), status: archived ? 'interrupted' : 'inProgress' }] }), calls);
  app.set_archived = async (thread_id, value) => { calls.push(['archive', thread_id, value]); if (value) archived = true; };
  const result = await codex_chat({}, { session_id: THREAD }, task, { connect: async () => app, poll_ms: 1 });
  assert.equal(await result.steer('再补一句'), true, 'a running turn takes an interjection');
  events.handle.kill();
  assert.deepEqual(await done, { reason: '已停止' });
  assert.deepEqual(calls.filter(call => call[0] === 'archive'), [['archive', THREAD, true], ['archive', THREAD, false]]);
  assert.deepEqual(calls.filter(call => call[0] === 'send').map(call => call[2]), [PROMPT, '再补一句']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await result.steer('太晚了'), false, 'an ended turn refuses interjections');
  cleanup();
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adapter_of, execution_details } from '../runner/adapters/index.mjs';
import { codex_chat, watch_room_turn } from '../runner/adapters/codex_app.mjs';
import { SegmentLog } from '../runner/execution_progress.mjs';

const THREAD = 'thread-1';
const PROMPT = '私聊开头\n\n请看一下 a < b & c';
const ROOM_PROMPT = '主持人给你安排了一项请求，先读任务文件 free-42.task.json 并提交回答。';

/** The App's wrapping of a delivered message, with its text XML-escaped as the App writes it. */
function delegation(id, text, name = 'send_message_to_thread') {
  const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return { type: 'functionCallOutput', id, name, output: { text: `<codex_delegation>\n  <source_thread_id>${THREAD}</source_thread_id>\n  <input>${escaped}</input>\n</codex_delegation>`, truncated: false } };
}

/** A `codex queue` or user-typed input item in `read_thread`. */
function user_message(id, text) {
  return { type: 'userMessage', id, content: [{ type: 'text', text }] };
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

test('a Codex App room turn matches only this task prompt and ignores earlier or private turns', async () => {
  const { directory, cleanup } = setup();
  const states = [
    { thread: { status: { type: 'active' } }, turns: [
      { id: 'private-1', status: 'inProgress', items: [
        user_message('priv-in', '这是用户在 App 里手打的私人消息'),
        { type: 'agentMessage', id: 'priv-note', phase: 'commentary', text: '私人回复不应该串入房间' },
        { type: 'commandExecution', id: 'priv-cmd', command: '"pwsh.exe" -Command "echo secret > secret.txt"', status: 'completed', exitCode: 0, output: { text: 'secret' } },
      ] },
      { id: 'old', status: 'completed', items: [user_message('old-in', ROOM_PROMPT)] },
    ] },
    { thread: { status: { type: 'active' } }, turns: [
      { id: 'room', status: 'inProgress', items: [user_message('room-in', ROOM_PROMPT)] },
      { id: 'private-1', status: 'completed', items: [
        user_message('priv-in', '这是用户在 App 里手打的私人消息'),
        { type: 'fileChange', id: 'priv-fc', status: 'completed', changes: [{ path: 'private.md' }] },
      ] },
    ] },
    { thread: { status: { type: 'active' } }, turns: [
      { id: 'private-after', status: 'inProgress', items: [
        user_message('priv-after-in', '下一条私人对话'),
        { type: 'commandExecution', id: 'priv-after-cmd', command: '"pwsh.exe" -Command "dir"', status: 'completed', exitCode: 0, output: { text: 'private-list' } },
      ] },
      { id: 'room', status: 'interrupted', items: [user_message('room-in', ROOM_PROMPT)] },
    ] },
  ];
  let reads = 0, ended = 0;
  const lines = [], notes = [], activities = [], edits = [];
  const app = { async read_thread() { return states[Math.min(reads++, states.length - 1)]; }, close() {} };
  await watch_room_turn({}, THREAD, { turns: new Set(['old']), items: new Set(['old-in']) },
    { id: 'free-42', directory, prompt: ROOM_PROMPT,
      on_output: (path, line) => lines.push([path, JSON.parse(line)]),
      on_activity: (phase, tool, call) => activities.push([phase, tool, call]),
      on_note: text => notes.push(text),
      on_edits: paths => edits.push(paths),
      on_turn_end: () => { ended++; } },
    { connect: async () => app, poll_ms: 1 });
  assert.equal(ended, 1);
  assert.equal(reads, 3, 'private turns before and after do not count; the matched room turn ending does');
  assert.deepEqual(notes, [], 'private commentary never leaks into room notes');
  assert.deepEqual(edits, [[]], 'private file edits never leak into room edits');
  assert.deepEqual(activities, [['thinking', undefined, undefined]], 'private commands never enter room timeline');
  const parsed = execution_details('codex', lines.map(([, entry]) => JSON.stringify(entry)).join('\n'));
  assert.deepEqual(parsed.entries.map(entry => [entry.kind, entry.state]), [['error', 'failed']], 'an interrupted room turn logs only its own error');
  reads = 0; ended = 0;
  const failing = { async read_thread() { throw new Error('pipe closed'); }, close() {} };
  await watch_room_turn({}, THREAD, { turns: new Set(), items: new Set() }, { prompt: ROOM_PROMPT, on_turn_end: () => { ended++; } }, { connect: async () => failing, poll_ms: 1 });
  assert.equal(ended, 0, 'an unreadable App gives up quietly');
  cleanup();
});

test('a Codex App room turn lists the schedules set for its own chat during the turn, and ends one once paused', async () => {
  const { directory, cleanup } = setup();
  const home = join(directory, 'home');
  const automation = (id, fields) => {
    mkdirSync(join(home, '.codex', 'automations', id), { recursive: true });
    const lines = Object.entries({ version: 1, id, kind: 'heartbeat', prompt: '跟进 "进度"', ...fields }).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    writeFileSync(join(home, '.codex', 'automations', id, 'automation.toml'), `${lines.join('\n')}\n`);
  };
  // Set before the turn, or for another chat: neither is this turn's own.
  automation('older', { name: '旧的', status: 'ACTIVE', rrule: 'FREQ=HOURLY;INTERVAL=1', target_thread_id: THREAD, created_at: 1 });
  const running = { thread: { status: { type: 'active' } }, turns: [{ id: 'room', status: 'inProgress', items: [user_message('room-in', ROOM_PROMPT)] }] };
  const states = [
    () => {
      automation('own', { name: '每 5 分钟检查', status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=5', target_thread_id: THREAD, created_at: Date.now() });
      automation('other', { name: '别的会话', status: 'ACTIVE', rrule: 'FREQ=MINUTELY;INTERVAL=5', target_thread_id: 'thread-2', created_at: Date.now() });
      return running;
    },
    () => { automation('own', { name: '每 5 分钟检查', status: 'PAUSED', rrule: 'FREQ=MINUTELY;INTERVAL=5', target_thread_id: THREAD, created_at: Date.now() }); return running; },
    () => ({ thread: { status: { type: 'idle' } }, turns: [{ id: 'room', status: 'completed', items: [user_message('room-in', ROOM_PROMPT)] }] }),
  ];
  let reads = 0;
  const lists = [];
  const app = { async read_thread() { return states[Math.min(reads++, states.length - 1)](); }, close() {} };
  await watch_room_turn({}, THREAD, { turns: new Set(), items: new Set() },
    { id: 'free-43', directory, prompt: ROOM_PROMPT, on_background_tasks: list => lists.push(list.map(({ id, kind, title, state, schedule }) => ({ id, kind, title, state, schedule }))) },
    { connect: async () => app, poll_ms: 1, home });
  assert.deepEqual(lists, [
    [{ id: 'automation:own', kind: 'schedule', title: '每 5 分钟检查', state: 'running', schedule: 'FREQ=MINUTELY;INTERVAL=5' }],
    [{ id: 'automation:own', kind: 'schedule', title: '每 5 分钟检查', state: 'stopped', schedule: 'FREQ=MINUTELY;INTERVAL=5' }],
  ]);
  cleanup();
});

test('a Codex App room turn logs steps, deduplicates timeline and edits across polls, and survives prompt scroll-off', async () => {
  const { directory, cleanup } = setup();
  const commentary = { type: 'agentMessage', id: 'm1', phase: 'commentary', text: '先检查代码再修改。' };
  const fc_run = { type: 'fileChange', id: 'fc-run', status: 'inProgress', changes: [{ path: 'src/pending.js' }] };
  const fc_ok = { type: 'fileChange', id: 'fc-ok', status: 'completed', changes: [{ path: 'src/app-edited.js', diff: { text: '+ok' } }] };
  const fc_fail = { type: 'fileChange', id: 'fc-fail', status: 'failed', changes: [{ path: 'src/failed.js' }] };
  const cmd_run = { type: 'commandExecution', id: 'cmd-ok', status: 'inProgress', command: '"pwsh.exe" -Command "cp src/in.js out/copied.js"' };
  const cmd_done = { ...cmd_run, status: 'completed', exitCode: 0, output: { text: 'copied' } };
  const cmd_fail = { type: 'commandExecution', id: 'cmd-fail', status: 'completed', exitCode: 1, command: '"pwsh.exe" -Command "echo x > out/failed.js"', output: { text: 'boom' } };
  const search = { type: 'webSearch', id: 'ws-1', query: 'codex app tools' };
  const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'lookup', status: 'completed' };
  const states = [
    { thread: { status: { type: 'active' } }, turns: [
      { id: 'room', status: 'inProgress', items: [user_message('room-in', ROOM_PROMPT), commentary, fc_run, fc_ok, fc_fail, cmd_run] },
      { id: 'old', status: 'completed', items: [{ type: 'fileChange', id: 'fc-old', status: 'completed', changes: [{ path: 'src/earlier.js' }] }] },
    ] },
    // Repeated identical snapshot: must produce zero duplicate log lines, segments, notes or edits.
    { thread: { status: { type: 'active' } }, turns: [
      { id: 'room', status: 'inProgress', items: [user_message('room-in', ROOM_PROMPT), commentary, fc_run, fc_ok, fc_fail, cmd_run] },
    ] },
    // Later poll where the initial prompt scrolled off the 32-item page cap while items finish and new ones arrive.
    { thread: { status: { type: 'idle' } }, turns: [
      { id: 'room', status: 'completed', items: [
        { ...fc_run, status: 'declined' }, fc_ok, cmd_done, cmd_fail, search, mcp,
        { type: 'agentMessage', id: 'm2', phase: 'final_answer', text: '已提交 #9399' },
      ] },
      { id: 'old', status: 'completed', items: [{ type: 'fileChange', id: 'fc-old', status: 'completed', changes: [{ path: 'src/earlier.js' }] }] },
    ] },
  ];
  let reads = 0, ended = 0, clock = 1000;
  const edits = [], notes = [], lines = [];
  const segments = new SegmentLog(() => (clock += 50));
  segments.start(42);
  const app = { async read_thread() { return states[Math.min(reads++, states.length - 1)]; }, close() {} };
  await watch_room_turn({}, THREAD, { turns: new Set(['old']), items: new Set() },
    { id: 'free-42', directory, prompt: ROOM_PROMPT,
      on_output: (path, line) => { lines.push([path, line]); segments.mark(42); },
      on_activity: (phase, tool, call) => segments.mark(42, phase, tool, call),
      on_note: text => { notes.push(text); segments.note(42, text); },
      on_edits: paths => edits.push(paths),
      on_turn_end: () => { ended++; } },
    { connect: async () => app, poll_ms: 1 });
  assert.equal(ended, 1);
  assert.deepEqual(edits, [[], ['src/app-edited.js'], ['out/copied.js']]);
  assert.deepEqual(notes, ['先检查代码再修改。']);
  assert.ok(lines.every(([path]) => path === join(directory, 'codex-free-42.log')));
  const batch = segments.batch(42, true);
  assert.equal(batch.segments.filter(item => item.phase === 'command').length, 2, 'cmd-ok transitioning inProgress -> completed is counted once alongside cmd-fail');
  assert.equal(batch.segments.filter(item => item.phase === 'editing').length, 3, 'each fileChange item is counted once across polls');
  assert.deepEqual(batch.segments.filter(item => item.phase === 'tool').map(item => item.tool), ['web_search', 'lookup']);
  const details = execution_details('codex', lines.map(([, line]) => line).join(''));
  assert.deepEqual(details.entries.map(entry => [entry.id, entry.kind, entry.state]), [
    ['m1', 'message', 'done'], ['fc-run', 'edit', 'failed'], ['fc-ok', 'edit', 'done'], ['fc-fail', 'edit', 'failed'],
    ['cmd-ok', 'command', 'done'], ['cmd-fail', 'command', 'failed'], ['ws-1', 'search', 'done'], ['mcp-1', 'tool', 'done'],
  ]);
  assert.equal(details.entries.find(entry => entry.id === 'cmd-ok').body, 'copied', 'completed output replaces the inProgress entry in place');
  cleanup();
});

test('Codex App deliver reports progress when readable (queue, notLoaded, create_thread) and degrades when unreadable', async () => {
  const { directory, cleanup } = setup();
  const access_path = join(directory, 'free-77.access.json');
  writeFileSync(access_path, JSON.stringify({ token: 't', session_id: '' }));

  // 1. Readable loaded thread via `codex queue`: progress=true, steer logs interjection, steps reach codex-free-77.log.
  let poll = 0, ended_resolve;
  const ended = new Promise(resolve => { ended_resolve = resolve; });
  const queue_calls = [], log_lines = [];
  const loaded_app = {
    async read_thread(_id, opts) {
      if (opts.turnLimit === 1) return { thread: { status: { type: 'active' } }, turns: [] };
      poll++;
      if (poll === 1) return { thread: { status: { type: 'idle' } }, turns: [{ id: 'old', status: 'completed', items: [user_message('old-1', 'earlier')] }] };
      return { thread: { status: { type: 'idle' } }, turns: [
        { id: 'room-1', status: 'completed', items: [
          user_message('u-77', ROOM_PROMPT),
          { type: 'commandExecution', id: 'c-77', status: 'completed', exitCode: 0, command: '"pwsh.exe" -Command "git status"', output: { text: 'clean' } },
        ] },
      ] };
    },
    async send_message(id, text) { queue_calls.push(['send', id, text]); },
    close() {},
  };
  const task = { id: 'free-77', participant: 'Codex', directory, access_path, prompt: ROOM_PROMPT,
    on_output: (_path, line) => log_lines.push(line),
    on_turn_end: () => ended_resolve(),
    on_edits: () => {} };
  const result = await adapter_of('codex').deliver({ adapter: 'codex', executable: 'codex.exe' }, { session_id: THREAD }, task, undefined, undefined, {
    connect: async () => loaded_app,
    run: async (_exe, args) => { queue_calls.push(['queue', args]); return 'ok'; },
    poll_ms: 1,
  });
  assert.deepEqual(result.capabilities, { stoppable: false, progress: true, ends: true });
  assert.equal(await result.steer('顺便跑下测试'), true);
  await ended;
  assert.equal(queue_calls[0][0], 'queue');
  const parsed = execution_details('codex', log_lines.join(''));
  assert.ok(parsed.entries.some(entry => entry.kind === 'interjection' && entry.body === '顺便跑下测试'));
  assert.ok(parsed.entries.some(entry => entry.kind === 'command' && entry.title === 'git status' && entry.body === 'clean'));

  // 2. Unreadable App before delivery: falls back to `codex queue` and degrades to progress=false with no edits/log.
  let degraded_edits = 0, degraded_logs = 0;
  const degraded = await adapter_of('codex').deliver({ adapter: 'codex', executable: 'codex.exe' }, { session_id: THREAD },
    { id: 'free-78', participant: 'Codex', directory, access_path, prompt: ROOM_PROMPT,
      on_output: () => { degraded_logs++; }, on_edits: () => { degraded_edits++; } },
    undefined, undefined, {
      connect: async () => { throw new Error('pipe unavailable'); },
      run: async () => 'queued',
      poll_ms: 1,
    });
  assert.deepEqual(degraded.capabilities, { stoppable: false, progress: false });
  assert.equal(degraded_edits, 0, 'degraded delivery keeps file attribution unknown');
  assert.equal(degraded_logs, 0, 'degraded delivery writes no process log');

  // 3. `notLoaded` thread via `send_message_to_thread` and new thread via `create_thread` both match delegation items.
  let nl_poll = 0, nl_done;
  const nl_ended = new Promise(resolve => { nl_done = resolve; });
  const nl_app = {
    async read_thread() {
      nl_poll++;
      if (nl_poll === 1) return { thread: { status: { type: 'notLoaded' } }, turns: [] };
      return { thread: { status: { type: 'idle' } }, turns: [{ id: 'nl-1', status: 'completed', items: [delegation('d-1', ROOM_PROMPT)] }] };
    },
    async send_message() {},
    close() {},
  };
  const nl = await adapter_of('codex').deliver({ adapter: 'codex', executable: 'codex.exe' }, { session_id: THREAD },
    { id: 'free-79', participant: 'Codex', directory, access_path, prompt: ROOM_PROMPT, on_turn_end: () => nl_done() },
    undefined, undefined, { connect: async () => nl_app, poll_ms: 1 });
  assert.deepEqual(nl.capabilities, { stoppable: false, progress: true, ends: true });
  await nl_ended;

  let cr_done;
  const cr_ended = new Promise(resolve => { cr_done = resolve; });
  const cr_logs = [];
  const cr_app = {
    async read_thread() {
      return { thread: { status: { type: 'idle' } }, turns: [{ id: 'cr-1', status: 'completed', items: [
        delegation('c-in', ROOM_PROMPT, 'create_thread'),
        { type: 'agentMessage', id: 'cr-m', phase: 'commentary', text: '新建会话已开始' },
      ] }] };
    },
    async create_thread() { return { thread_id: 'created-1', title: 'CoDiscuss · Codex' }; },
    async set_archived() {},
    close() {},
  };
  const prev_home = process.env.DISCUSS_SERVICE_HOME;
  process.env.DISCUSS_SERVICE_HOME = directory;
  try {
    const cr = await adapter_of('codex').deliver({ adapter: 'codex', source_thread_id: 'src-1' }, {},
      { id: 'free-80', participant: 'Codex', directory, access_path, prompt: ROOM_PROMPT,
        on_binding: () => {}, on_output: (_p, l) => cr_logs.push(l), on_turn_end: () => cr_done() },
      undefined, directory, { connect: async () => cr_app, poll_ms: 1 });
    assert.deepEqual(cr.capabilities, { stoppable: false, progress: true, ends: true });
    await cr_ended;
    assert.equal(execution_details('codex', cr_logs.join('')).entries[0].body, '新建会话已开始');
  } finally {
    if (prev_home === undefined) delete process.env.DISCUSS_SERVICE_HOME;
    else process.env.DISCUSS_SERVICE_HOME = prev_home;
  }
  cleanup();
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { creation_source, source_file } from '../runner/adapters/codex_app.mjs';

const CONFIGURED = 'user-chat';

/** A stand-in for the App that knows a set of chats and records what the runner did to them. */
class FakeApp {
  constructor(chats = {}) { this.chats = chats; this.calls = []; }
  async read_thread(thread_id) {
    this.calls.push(['read', thread_id]);
    if (!this.chats[thread_id]) throw new Error('Codex app tool request failed');
    return { thread: { status: { type: 'notLoaded' } }, turns: this.chats[thread_id] };
  }
  async create_thread(source, prompt, title, target) {
    this.calls.push(['create', source, target.type]);
    const thread_id = `made-${this.calls.length}`;
    this.chats[thread_id] = [];
    return { thread_id, title };
  }
  async set_archived(thread_id, archived) { this.calls.push(['archive', thread_id, archived]); }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'codiscuss-codex-source-'));
  return { file: join(directory, 'codex-app-source.json'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test('Codex App source chat lives in the local service directory', () => {
  assert.equal(source_file({}, 'H:/home'), join('H:/home', '.codiscuss', 'codex-app-source.json'));
  assert.equal(source_file({ DISCUSS_SERVICE_HOME: join(tmpdir(), 'svc') }, 'H:/home'), join(tmpdir(), 'svc', 'codex-app-source.json'));
});

test('Codex App makes its own archived source chat once, so member chats never copy the user\'s chat', async () => {
  const { file, cleanup } = setup();
  const app = new FakeApp();
  const source = await creation_source(app, { source_thread_id: CONFIGURED }, file);
  assert.deepEqual(app.calls, [['create', CONFIGURED, 'projectless'], ['archive', source, true]]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { thread_id: source });
  app.calls = [];
  assert.equal(await creation_source(app, { source_thread_id: CONFIGURED }, file), source, 'the saved source is reused');
  assert.deepEqual(app.calls.map(call => call[0]), ['read'], 'reusing it touches no chat of the user');
  cleanup();
});

test('Codex App replaces a source chat that was deleted or that someone typed in', async () => {
  for (const chats of [{}, { saved: [{ items: [{ type: 'userMessage', id: 'u1' }] }] }]) {
    const { file, cleanup } = setup();
    writeFileSync(file, JSON.stringify({ thread_id: 'saved' }));
    const app = new FakeApp(chats);
    const source = await creation_source(app, { source_thread_id: CONFIGURED }, file);
    assert.notEqual(source, 'saved');
    assert.deepEqual(app.calls.slice(1), [['create', CONFIGURED, 'projectless'], ['archive', source, true]]);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).thread_id, source);
    cleanup();
  }
});

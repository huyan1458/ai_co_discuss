import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { save_api_key } from '../runner/discussion_api.mjs';
import { decide_group_message, decide_group_output, GROUP_PROMPT_VERSION, SCHEDULER_PROVIDERS } from '../runner/scheduler.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'codiscuss-group-decision-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const base_url = SCHEDULER_PROVIDERS.jev.base_url;
  return [home, { provider: 'jev', model: 'test', base_url, ...save_api_key(home, { base_url, api_key: 'test' }) }];
}

const predicate = noul => ({ type: 'noul', noul });
const answer = answers => async () => ({ ok: true, json: async () => ({ answers }) });
const input = { title: 'Group', moss_name: 'MOSS', message: { external: { sender_name: 'Alex', owner: false, mentioned: true }, text: 'Hello' } };

test('MOSS group decisions use the chosen probability, independent expression predicates and trusted owner identity', async t => {
  const scope = fixture(t);
  const asked = (choice, share) => answer({ group_reply: { type: 'choice', choice, confidence: 1,
    probabilities: share === null ? {} : { [choice]: share } }, requests_work: predicate(0.8), needs_ack: predicate(0.6),
    explicit_detail: predicate(0.79), costly: predicate(0.7) });
  const decide = (choice, share) => decide_group_message(...scope, input, asked(choice, share));
  assert.equal((await decide('respond', 0.69)).action, 'note');
  assert.equal((await decide('respond', null)).action, 'note', 'self-reported confidence never substitutes for the option probability');
  const result = await decide('respond', 0.7);
  assert.deepEqual(result.reply, { audience: 'Alex', purpose: 'work', detail: 'brief', acknowledge: true });
  assert.equal(result.prompt_version, GROUP_PROMPT_VERSION);
  assert.equal(result.detail.length, 5);
  assert.equal(result.costly, true);
  assert.equal(result.costly_prompt_version, 1);
  assert.equal(JSON.parse(result.input.state).message.owner, false);
  assert.equal((await decide('owner_private', 0.79)).action, 'note');
  assert.equal((await decide('owner_private', 0.8)).visibility, 'private');
  assert.equal((await decide('owner', 0.8)).visibility, 'group');
  let calls = 0;
  const offline = async () => { calls++; throw new Error('offline'); };
  assert.equal((await decide_group_message(...scope, input, offline)).action, 'note');
  assert.ok(calls >= 1, 'a stranger message consults the decision model, including its connection retries');
  const before = calls;
  const owner = { ...input, message: { ...input.message, external: { ...input.message.external, owner: true } } };
  assert.equal((await decide_group_message(...scope, owner, offline)).action, 'respond');
  assert.equal(calls, before, 'the owner bypasses the decision model');
});

test('MOSS group output checks only when there are new messages and suppresses either high-probability predicate', async t => {
  const scope = fixture(t);
  const output = { ...input, reply: 'draft', new_messages: [{ id: 4, text: 'new' }] };
  const check = (obsolete, duplicate) => decide_group_output(...scope, output, answer({ obsolete: predicate(obsolete), duplicate: predicate(duplicate) }));
  let calls = 0;
  const offline = async () => { calls++; throw new Error('offline'); };
  assert.equal((await decide_group_output(...scope, { ...output, new_messages: [] }, offline)).send, true);
  assert.equal(calls, 0);
  assert.equal((await check(0.94, 0.94)).send, true);
  assert.equal((await check(0.95, 0.01)).send, false);
  assert.equal((await check(0.01, 0.95)).send, false);
  assert.equal((await check(0.01, undefined)).send, false);
  assert.equal((await decide_group_output(...scope, output, offline)).send, false);
});

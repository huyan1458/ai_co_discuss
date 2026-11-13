import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const AGENT = fileURLToPath(new URL('../runner/cli_login_agent.mjs', import.meta.url));
const folders = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

/** Run the sign-in agent with a temporary home folder; the programs do not exist, so only its file writes are exercised. */
function agent(home, action, request) {
  const job = mkdtempSync(join(tmpdir(), 'login-job-'));
  folders.push(job);
  const missing = join(home, 'missing.exe');
  writeFileSync(join(job, 'request.json'), JSON.stringify({ ...request, executables: { claude: missing, codex: missing, agy: missing } }));
  const result = spawnSync(process.execPath, [AGENT, action, job], { encoding: 'utf8', env: { ...process.env, USERPROFILE: home, HOME: home } });
  assert.ok(!existsSync(join(job, 'request.json')), 'the request (which may carry a secret) is deleted once read');
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

function home_with(files) {
  const home = mkdtempSync(join(tmpdir(), 'login-home-'));
  folders.push(home);
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(home, path, '..'), { recursive: true }); writeFileSync(join(home, path), text); }
  return home;
}

test('a Claude Code sign-in replaces only sign-in settings and keeps the user\'s own', () => {
  const original = { permissions: { allow: ['Bash(git status)'] }, env: { ANTHROPIC_API_KEY: 'sk-old', MY_OWN: 'kept' }, apiKeyHelper: 'old-helper', model: 'opus' };
  const home = home_with({ '.claude/settings.json': JSON.stringify(original) });
  const settings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(agent(home, 'apply', { cli: 'claude', method: 'third_party', base_url: 'https://api.deepseek.com/anthropic', token: 'sk-new', model: 'm' }), { ok: true });
  const written = settings();
  assert.deepEqual(written.permissions, original.permissions);
  assert.equal(written.model, 'opus');
  assert.equal(written.apiKeyHelper, undefined);
  assert.deepEqual(written.env, { MY_OWN: 'kept', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-new',
    ANTHROPIC_MODEL: 'm', ANTHROPIC_DEFAULT_OPUS_MODEL: 'm', ANTHROPIC_DEFAULT_SONNET_MODEL: 'm', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'm' });
  // The first rewrite keeps the original file once.
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.claude', 'settings.json.codiscuss-backup'), 'utf8')), original);
  assert.match(agent(home, 'apply', { cli: 'claude', method: 'setup_token', token: 'not-a-token' }).error, /sk-ant-oat/);
  agent(home, 'logout', { cli: 'claude' });
  assert.deepEqual(settings(), { permissions: original.permissions, model: 'opus', env: { MY_OWN: 'kept' } });
});

test('Codex keeps one provider id across the official sign-in and a third party, touching nothing else in config.toml', () => {
  // The owner's own layout: everything under "custom", which official sign-in and third parties share so conversations
  // stay listed and resumable across switches.
  const original = 'model = "gpt-5"\napproval_policy = "never"\nmodel_provider = "custom"\n\n[features]\nweb_search = true\n\n'
    + '[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\nsupports_websockets = true\nwire_api = "responses"\nhttp_headers = { "X-Mine" = "1" }\n\n'
    + '[model_providers.mine]\nname = "mine"\nbase_url = "https://mine.example/v1"\n';
  const home = home_with({ '.codex/config.toml': original });
  const config = () => readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  const table = () => config().split('[model_providers.custom]')[1].split('\n[')[0];
  agent(home, 'apply', { cli: 'codex', method: 'third_party', base_url: 'https://example.invalid/v1', key: 'sk-x', model: 'their-model' });
  const written = config();
  assert.ok(written.startsWith('model_provider = "custom"\nmodel = "their-model" # 共议：第三方 API 的模型\n'), 'top-level keys come before every table');
  assert.equal((written.match(/^model\s*=/gm) || []).length, 1, 'the model given replaces the old one');
  assert.equal((written.match(/^model_provider\s*=/gm) || []).length, 1);
  assert.match(table(), /name = "第三方 API"\nbase_url = "https:\/\/example\.invalid\/v1"\nexperimental_bearer_token = "sk-x"/);
  assert.doesNotMatch(table(), /requires_openai_auth/, 'the ChatGPT sign-in is never sent to a third party');
  assert.match(table(), /supports_websockets = true\nwire_api = "responses"\nhttp_headers = \{ "X-Mine" = "1" \}/, 'keys the panel does not own stay');
  assert.match(written, /\[features\]\nweb_search = true/);
  assert.match(written, /\[model_providers\.mine\]\nname = "mine"/);
  assert.equal((written.match(/\[model_providers\.custom\]/g) || []).length, 1);
  // Signing out returns to the official form under the same id, with the third party's key gone.
  agent(home, 'logout', { cli: 'codex' });
  assert.match(config(), /^model_provider = "custom"$/m);
  assert.doesNotMatch(config(), /^model\s*=/m, 'the third party\'s model does not follow to OpenAI');
  assert.match(table(), /^\nname = "OpenAI"\nrequires_openai_auth = true\n/);
  assert.doesNotMatch(config(), /sk-x|example\.invalid/);
  assert.match(table(), /http_headers/);
  assert.match(config(), /approval_policy = "never"/);
  assert.equal(readFileSync(join(home, '.codex', 'config.toml.codiscuss-backup'), 'utf8'), original);
});

test('Codex without a config.toml gets exactly the recommended setup', () => {
  const home = home_with({});
  agent(home, 'logout', { cli: 'codex' });
  assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8'),
    'model_provider = "custom"\n\n[model_providers.custom]\nname = "OpenAI"\nrequires_openai_auth = true\n');
});

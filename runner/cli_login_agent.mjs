/**
 * Sign the AI command-line programs (Claude Code, Codex, Antigravity) in and out for the Windows user this runs as.
 *
 * The management panel runs this script as the computer owner, or as a hosted account's own Windows user (copied into a
 * job folder that user may read), so every file it touches is that user's own. It uses only Node built-ins and nothing
 * else from this package, because it runs from that job folder. Only each program's own sign-in is used: this script
 * writes the documented configuration (settings.json, config.toml) or runs the program's own login command.
 *
 * Usage: node cli_login_agent.mjs <status|apply|logout|login> <job folder>
 *   The job folder holds request.json (deleted once read, as it may carry a secret). status, apply and logout print one
 *   JSON line. login runs the program's sign-in with its screen in screen.txt, types what appears in input.txt, stops on
 *   cancel.txt, and writes its exit code to exit.txt.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = homedir();
const CLAUDE_SETTINGS = join(HOME, '.claude', 'settings.json');
const CODEX_CONFIG = join(HOME, '.codex', 'config.toml');
const AGY_FILES = [join(HOME, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), join(HOME, '.gemini', 'jetski-standalone-oauth-token')];
const AGY_CREDENTIAL = 'gemini:antigravity';
// The sign-in keys a Claude Code provider owns in settings.json env; switching providers clears them all first, so one
// left behind cannot outrank the new one. Every other key is the user's and is left alone.
const CLAUDE_KEYS = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_|CLAUDE_CODE_USE_|AWS_BEARER_TOKEN_BEDROCK$|CLOUD_ML_REGION$)/;
// The one provider id every way of signing in shares (the recommended setup, see edit_codex).
const CODEX_PROVIDER = 'custom';
const CODEX_TABLE = `[model_providers.${CODEX_PROVIDER}]`;
const CODEX_MODEL_MARK = '# 共议：第三方 API 的模型';
const POLL_MS = 300;
const COMMAND_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

// ---- Files ----

function read_json(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '') || '{}');
}

/** Write a file in one step, after keeping the original once as <name>.codiscuss-backup. */
function write_kept(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !existsSync(`${path}.codiscuss-backup`)) copyFileSync(path, `${path}.codiscuss-backup`);
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

function run(file, args, input) {
  const result = spawnSync(file, args, { input, encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT_MS });
  return { code: result.status, text: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

// ---- Claude Code ----

/** Put the given sign-in keys in settings.json env, after clearing every sign-in key and apiKeyHelper. */
function set_claude(values = {}, helper = '') {
  const settings = read_json(CLAUDE_SETTINGS);
  const env = Object.fromEntries(Object.entries(settings.env || {}).filter(([key]) => !CLAUDE_KEYS.test(key)));
  Object.assign(env, Object.fromEntries(Object.entries(values).filter(([, value]) => String(value || '').trim()).map(([key, value]) => [key, String(value).trim()])));
  const { apiKeyHelper, env: old, ...rest } = settings;
  const next = { ...rest, ...(Object.keys(env).length ? { env } : {}), ...(helper ? { apiKeyHelper: helper } : {}) };
  write_kept(CLAUDE_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
  // An older setup kept the token as a user environment variable, which would outrank a subscription sign-in. The
  // registry is this Windows user's, so it is only touched when the home being edited is that user's own.
  if (HOME === userInfo().homedir) spawnSync('reg', ['delete', 'HKCU\\Environment', '/v', 'CLAUDE_CODE_OAUTH_TOKEN', '/f'], { windowsHide: true });
}

function claude_status(exe) {
  const { code, text } = run(exe, ['auth', 'status']);
  let status = {};
  try { status = JSON.parse(text.slice(text.indexOf('{'))); } catch { return { installed: true, signed_in: false, error: text.slice(0, 200) }; }
  const env = read_json(CLAUDE_SETTINGS).env || {};
  // A third-party address reports as a token sign-in; settings.json tells it apart.
  const method = env.ANTHROPIC_BASE_URL ? 'third_party' : { 'claude.ai': 'subscription', oauth_token: 'setup_token' }[status.authMethod] || status.authMethod;
  return { installed: true, signed_in: code === 0 && Boolean(status.loggedIn), method: status.loggedIn ? method : 'none',
    detail: env.ANTHROPIC_BASE_URL || '', expires: status.loginExpiresAt || null };
}

function apply_claude(exe, request) {
  const { method } = request;
  if (method === 'setup_token') {
    if (!/^sk-ant-oat\d+-[\w-]{20,}$/.test(String(request.token || '').trim())) throw new Error('请粘贴 claude setup-token 生成的令牌（以 sk-ant-oat 开头）');
    // A stored subscription sign-in can override the token on Windows, so it goes first.
    run(exe, ['auth', 'logout']);
    return set_claude({ CLAUDE_CODE_OAUTH_TOKEN: request.token });
  }
  if (method === 'api_key') return set_claude({ ANTHROPIC_API_KEY: required(request.key, 'API 密钥') });
  if (method === 'third_party') {
    const model = String(request.model || '').trim(), small = String(request.small_model || '').trim() || model;
    return set_claude({ ANTHROPIC_BASE_URL: required(request.base_url, '接口地址'), ANTHROPIC_AUTH_TOKEN: required(request.token, '密钥'),
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: small });
  }
  if (method === 'env') return set_claude(parse_env(request.env));
  throw new Error(`Claude Code 不支持这种方式：${method}`);
}

// ---- Codex ----

/**
 * Point Codex at the provider "custom" for every way of signing in, editing only the given keys of its table in the
 * global config.toml. This is the recommended setup (user, 2026-11-13): Codex files each conversation under its provider
 * id and lists it only under that id, so with one fixed id switching accounts or methods keeps every conversation listed,
 * and each is read with whatever sign-in is current. Other top-level keys and other keys of the table stay.
 */
function edit_codex(set, remove, model = '') {
  const lines = (existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '').split(/\r?\n/);
  const id = CODEX_PROVIDER, table = CODEX_TABLE;
  let first = lines.findIndex(line => /^\s*\[/.test(line));
  if (first < 0) first = lines.length;
  // Top-level keys must come before every table. A third party's model carries a mark, so returning to the official
  // sign-in drops it (OpenAI would not know it) while a model the user set stays.
  const ours = line => line.includes(CODEX_MODEL_MARK);
  const top = [`model_provider = "${id}"`, ...(model ? [`model = ${JSON.stringify(model)} ${CODEX_MODEL_MARK}`] : []),
    ...lines.slice(0, first).filter(line => !/^\s*model_provider\s*=/.test(line) && !((model || ours(line)) && /^\s*model\s*=/.test(line)))];
  const rest = lines.slice(first);
  let start = rest.findIndex(line => line.trim() === table);
  if (start < 0) { rest.push('', table); start = rest.length - 1; }
  let end = rest.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  if (end < 0) end = rest.length;
  const kept = rest.slice(start + 1, end).filter(line => {
    const key = line.match(/^\s*([\w-]+)\s*=/)?.[1];
    return !key || (!(key in set) && !remove.includes(key));
  });
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  const written = Object.entries(set).map(([key, value]) => `${key} = ${typeof value === 'boolean' ? value : JSON.stringify(value)}`);
  rest.splice(start + 1, end - start - 1, ...written, ...kept, ...(end < rest.length ? [''] : []));
  write_kept(CODEX_CONFIG, `${[...top, ...rest].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
}

/** The official sign-in (ChatGPT, API key, access token): the recommended table, with nothing of a third party left. */
function use_codex_official() {
  edit_codex({ name: 'OpenAI', requires_openai_auth: true }, ['base_url', 'experimental_bearer_token', 'env_key']);
}

/** A third party under the same id; without requires_openai_auth, so the ChatGPT sign-in is never sent to it. */
function use_codex_third_party(request) {
  edit_codex({ name: '第三方 API', base_url: required(request.base_url, '接口地址'), experimental_bearer_token: required(request.key, 'API 密钥') },
    ['requires_openai_auth', 'env_key'], String(request.model || '').trim());
}

/** Whether config.toml points at "custom", and that table's address and whether it uses the official sign-in. */
function codex_table() {
  const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '';
  const body = text.split(CODEX_TABLE)[1]?.split(/\n\s*\[/)[0] || '';
  return { uses: new RegExp(`^\\s*model_provider\\s*=\\s*"${CODEX_PROVIDER}"`, 'm').test(text),
    base_url: body.match(/^\s*base_url\s*=\s*"([^"]*)"/m)?.[1] || '', official: /^\s*requires_openai_auth\s*=\s*true/m.test(body) };
}

function codex_status(exe) {
  const table = codex_table();
  if (table.uses && table.base_url && !table.official) return { installed: true, signed_in: true, method: 'third_party', detail: table.base_url };
  const { code, text } = run(exe, ['login', 'status']);
  const method = /ChatGPT/i.test(text) ? 'chatgpt' : /API key/i.test(text) ? 'api_key' : /access token/i.test(text) ? 'access_token' : 'none';
  return { installed: true, signed_in: code === 0, method: code === 0 ? method : 'none', detail: '' };
}

function apply_codex(exe, request) {
  const { method } = request;
  if (method === 'third_party') return use_codex_third_party(request);
  const flag = { api_key: '--with-api-key', access_token: '--with-access-token' }[method];
  if (!flag) throw new Error(`Codex 不支持这种方式：${method}`);
  use_codex_official();
  const { code, text } = run(exe, ['login', flag], `${required(request.key, method === 'api_key' ? 'API 密钥' : '访问令牌')}\n`);
  if (code !== 0) throw new Error(text || 'Codex 登录失败');
}

// ---- Antigravity ----

function agy_signed_in() {
  // Credential Manager's entry is where agy keeps its Google sign-in; cmdkey lists it by name.
  const listed = run('cmdkey', [`/list:${AGY_CREDENTIAL}`]).text;
  return listed.includes(AGY_CREDENTIAL) && !/\*\s*NONE\s*\*/i.test(listed) && /(Target|目标)/i.test(listed);
}

function agy_status() {
  return { installed: true, signed_in: agy_signed_in(), method: agy_signed_in() ? 'google' : 'none', detail: '' };
}

// ---- Shared ----

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`请填写${label}`);
  return text;
}

/** KEY=VALUE lines (blank lines and # comments skipped) into an object. */
function parse_env(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/).map(item => item.trim()).filter(item => item && !item.startsWith('#'))) {
    const at = line.indexOf('=');
    if (at < 1) throw new Error(`无法识别：${line}（应为 名称=值）`);
    values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  if (!Object.keys(values).length) throw new Error('请至少填写一行 名称=值');
  return values;
}

function status(request) {
  const exes = request.executables;
  const each = (key, check) => existsSync(exes[key]) ? (() => { try { return check(exes[key]); } catch (error) { return { installed: true, signed_in: false, error: error.message }; } })() : { installed: false, signed_in: false };
  return { claude: each('claude', claude_status), codex: each('codex', codex_status), agy: each('agy', agy_status) };
}

function apply(request) {
  const exe = request.executables[request.cli];
  if (request.cli === 'claude') apply_claude(exe, request);
  else if (request.cli === 'codex') apply_codex(exe, request);
  else throw new Error('Antigravity 只支持在它自己的窗口里用 Google 账号登录');
  return { ok: true };
}

function logout(request) {
  const exe = request.executables[request.cli];
  if (request.cli === 'claude') { run(exe, ['auth', 'logout']); set_claude(); }
  // The official form stays under the same id, so its conversations keep showing; no third-party key is left behind.
  if (request.cli === 'codex') { run(exe, ['logout']); use_codex_official(); }
  if (request.cli === 'agy') { run('cmdkey', [`/delete:${AGY_CREDENTIAL}`]); for (const path of AGY_FILES) rmSync(path, { force: true }); }
  return { ok: true };
}

/** Run a program's own sign-in with its screen in screen.txt and its keyboard fed from input.txt. */
function login(job, request) {
  // Codex's own sign-in goes with the official form of the shared provider.
  if (request.cli === 'codex') use_codex_official();
  const child = spawn(request.executables[request.cli], request.args, { cwd: HOME, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const screen = join(job, 'screen.txt'), typed = join(job, 'input.txt');
  writeFileSync(screen, '');
  child.stdout.on('data', chunk => appendFileSync(screen, chunk));
  child.stderr.on('data', chunk => appendFileSync(screen, chunk));
  let sent = 0;
  const poll = setInterval(() => {
    if (existsSync(join(job, 'cancel.txt'))) { child.kill(); return; }
    if (!existsSync(typed)) return;
    const all = readFileSync(typed);
    if (all.length > sent) { child.stdin.write(all.subarray(sent)); sent = all.length; }
  }, POLL_MS);
  // A sign-in nobody finishes ends on its own.
  const limit = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);
  const finish = code => { clearInterval(poll); clearTimeout(limit); writeFileSync(join(job, 'exit.txt'), String(code ?? 1)); };
  child.on('error', error => { appendFileSync(screen, `\n${error.message}\n`); finish(1); });
  child.on('exit', finish);
}

function main() {
  const [action, job] = process.argv.slice(2);
  const path = join(job, 'request.json'), request = JSON.parse(readFileSync(path, 'utf8'));
  rmSync(path, { force: true });
  if (action === 'login') return login(job, request);
  try {
    const result = { status, apply, logout }[action]?.(request);
    if (!result) throw new Error(`未知操作：${action}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); }
}

main();

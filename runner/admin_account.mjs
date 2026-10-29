/** Site administrator setup from the deploying computer: a one-time registration token and the saved account. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { atomic_json } from './discussion_adapters.mjs';
import { service_home } from './discussion_service.mjs';

const DEFAULT_CONFIG = join('.wrangler', 'deploy', 'wrangler.jsonc');
const ACCOUNTS_FILE = 'admin-accounts.json';
const TOKEN_BYTES = 32;
const HELP = `用法：codiscuss admin token [--config WRANGLER_CONFIG]

token  生成一次性管理员注册令牌，经 wrangler 把它的哈希写入线上 D1，立即生效。
       在线上网页左下角注册管理员时填入；注册成功即作废，重新运行会替换旧令牌。
       需要这台电脑已 wrangler login；--config 默认为当前目录的 ${DEFAULT_CONFIG}。

在已用 codiscuss local connect 连上本机服务的网页注册后，账号与密码保存在 ~/.codiscuss/${ACCOUNTS_FILE}。
`;

/** Write a fresh token's hash to the deployed D1 and return the token; the raw value is never stored. */
export function create_admin_token(config, run = run_wrangler) {
  const path = resolve(config || DEFAULT_CONFIG);
  if (!existsSync(path)) throw new Error(`找不到部署配置 ${path}；请在项目目录运行，或用 --config 指定 wrangler.jsonc`);
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  const hashed = createHash('sha256').update(token).digest('hex');
  // --command uses the ordinary query API; --file goes through D1's upload-based import, which fails behind some networks.
  run(['d1', 'execute', 'DB', '--remote', '--config', path, '--command',
    `INSERT OR REPLACE INTO admin_setup (id,token_hash,created_at) VALUES (1,'${hashed}',${Math.floor(Date.now() / 1000)})`]);
  return { token, config: path };
}

/** Run wrangler through npx; arguments are quoted because Windows needs a shell for npx.cmd. */
function run_wrangler(args) {
  const quoted = ['wrangler', ...args].map(arg => `"${arg.replaceAll('"', '\\"')}"`).join(' ');
  const result = spawnSync(`npx ${quoted}`, { shell: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`wrangler 写入线上数据库失败：${(result.stderr || result.error?.message || '').trim().slice(-800)}`);
}

/** Keep the account registered from this computer's browser, one entry per site, in the private service directory. */
export function save_admin_account(home, { site, username, password }) {
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) throw new Error('缺少管理员用户名或密码');
  const origin = new URL(site).origin;
  const path = join(home, ACCOUNTS_FILE);
  const accounts = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { sites: {} };
  accounts.sites[origin] = { username: username.trim(), password, saved_at: new Date().toISOString() };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  atomic_json(path, accounts);
  return { saved: path };
}

/** `codiscuss admin ...` */
export function admin_main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals[0] !== 'token') return process.stdout.write(HELP);
  const { token } = create_admin_token(values.config);
  process.stdout.write(`管理员注册令牌（一次性）：\n${token}\n\n在线上网页左下角注册管理员时填入。注册成功后作废；账号密码在已连接本机服务的网页注册时保存到 ${join(service_home(), ACCOUNTS_FILE)}。\n`);
}

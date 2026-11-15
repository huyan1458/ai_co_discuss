/** Website setup from the deploying computer: a one-time token that binds a computer to the online website. */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { t } from './i18n.mjs';

const DEFAULT_CONFIG = join('.wrangler', 'deploy', 'wrangler.jsonc');
// Older versions kept the administrator password here in plain text; it is deleted and never written again.
const LEGACY_ACCOUNTS_FILE = 'admin-accounts.json';
const TOKEN_BYTES = 32;
const HELP = t(`用法：codiscuss token [--config WRANGLER_CONFIG]

生成一次性绑定令牌，经 wrangler 把它的哈希写入线上 D1，立即生效。
在要绑定的电脑上执行 codiscuss local connect 网站地址 --setup-key 令牌；绑定成功即作废，重新运行会替换旧令牌。
在部署网站的电脑上直接运行 codiscuss local connect 时会自动生成，无须本命令。
需要这台电脑已 wrangler login；--config 默认为当前目录的 {value1}。网站不设账号和密码。
`, { value1: DEFAULT_CONFIG });

/** Write a fresh token's hash to the deployed D1 and return the token; the raw value is never stored. */
export function create_admin_token(config, run = run_wrangler) {
  const path = resolve(config || DEFAULT_CONFIG);
  if (!existsSync(path)) throw new Error(t('找不到部署配置 {value1}；请在项目目录运行，或用 --config 指定 wrangler.jsonc', { value1: path }));
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
  if (result.status !== 0) throw new Error(t('wrangler 写入线上数据库失败：{value1}', { value1: (result.stderr || result.error?.message || '').trim().slice(-800) }));
}

/** Delete the plain-text administrator password an older version saved; returns whether a file was removed. */
export function remove_legacy_admin_accounts(home) {
  const path = join(home, LEGACY_ACCOUNTS_FILE);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** `codiscuss token [--config FILE]` */
export function admin_main(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    config: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || positionals.length) return process.stdout.write(HELP);
  const { token } = create_admin_token(values.config);
  process.stdout.write(t(`绑定令牌（一次性）：
{value1}

在要绑定的电脑上执行 codiscuss local connect 网站地址 --setup-key 令牌。绑定成功后作废。
`, { value1: token }));
}

/**
 * What `codiscuss setup --hosting` does beyond turning hosting on, so a computer is ready to host accounts: the entry's
 * port and start with the panel, the optional outside address (a Cloudflare tunnel from the owner's own domain, see
 * hosting_tunnel.mjs), starting with Windows, then a restart of the panel so it runs the entry and tunnel as set, and a
 * check that the entry answers here and outside. Safe to run again: what is already done is kept.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { entry_settings, save_entry_settings } from '../gateway/gateway.mjs';
import { prepare_tunnel, remove_legacy_tunnel_start, tunnel_host, tunnel_log_tail } from './hosting_tunnel.mjs';
import { launcher_path, set_autostart } from './launcher.mjs';

const PANEL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'admin_panel.mjs');
const LOGIN_PATH = '/_entry/login';
const LOCAL_WAIT_MS = 60_000;
// A new tunnel's host name can take a minute or two to resolve.
const PUBLIC_WAIT_MS = 120_000;
const PROBE_MS = 3000;
const PROBE_TIMEOUT_MS = 10_000;

/** Whether this run should set hosting up: asked for with --hosting or one of the entry's options, on Windows. */
export function hosting_requested(options, hosting_on) {
  return process.platform === 'win32' && hosting_on && Boolean(options.hosting || options['public-host'] || options['entry-port']);
}

/**
 * Save the entry's settings and prepare the outside address, before the service starts. Returns { lines, issues }:
 * what was set, and what is left for the owner.
 */
export function configure_hosting(home, options, { interactive = Boolean(process.stdin.isTTY), say = () => {} } = {}) {
  const lines = [], issues = [];
  const changes = { running: true };
  if (options['entry-port']) changes.port = Number(options['entry-port']);
  if (options['public-host']) {
    try {
      const host = tunnel_host(options['public-host']);
      const tunnel = prepare_tunnel({ host, name: options['tunnel-name'], interactive, say });
      Object.assign(changes, { public_url: `https://${host}`, tunnel });
      lines.push(`外网地址 https://${host}，经 Cloudflare 隧道 ${tunnel.name} 转到登录入口；隧道独立运行，由管理面板按设置维持`);
      if (remove_legacy_tunnel_start()) lines.push('已移除旧的“CoDiscuss Tunnel”开机任务，改由管理面板运行隧道');
    } catch (error) { issues.push(`外网地址没有设好：${error.message}`); }
  }
  const saved = save_entry_settings(home, changes);
  lines.unshift(`登录入口：本机 ${saved.port} 端口，随管理面板启动`);
  if (!saved.tunnel && !options['public-host']) lines.push('未设外网地址，仅本机可访问；有托管在 Cloudflare 的域名时，加 --public-host 域名 重新运行');
  if (existsSync(launcher_path(home))) { set_autostart(true, home); lines.push('已开启登录 Windows 时自动启动'); }
  else issues.push('还没有“共议”程序，没有开启登录自启：重新运行 setup 并勾选创建桌面快捷方式');
  return { lines, issues };
}

async function answers(url, wait_ms) {
  for (let waited = 0; waited < wait_ms; waited += PROBE_MS) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })).ok) return true; } catch { /* not yet */ }
    await new Promise(done => setTimeout(done, PROBE_MS));
  }
  return false;
}

/**
 * After the service started: restart the panel, which starts the entry and brings the tunnel in line with the settings
 * (its config follows the entry port) when it starts, then check the entry here and, with an outside address, from
 * outside. Returns { lines, issues }.
 */
export async function finish_hosting(home) {
  const lines = [], issues = [];
  spawnSync(process.execPath, [PANEL_SCRIPT, 'stop', '--data', home], { stdio: 'ignore', windowsHide: true });
  const started = spawnSync(process.execPath, [PANEL_SCRIPT, 'start', '--data', home], { encoding: 'utf8', windowsHide: true });
  if (started.status !== 0) {
    issues.push(`管理面板没有启动：${String(started.stderr || '').trim() || `退出码 ${started.status}`}`);
    return { lines, issues };
  }
  const { port, public_url, tunnel } = entry_settings(home);
  if (await answers(`http://127.0.0.1:${port}${LOGIN_PATH}`, LOCAL_WAIT_MS)) lines.push(`本机入口 http://127.0.0.1:${port} 正常`);
  else {
    issues.push(`本机入口 ${LOCAL_WAIT_MS / 1000} 秒内没有打开：在管理面板“概览”页“托管”下的“登录入口”点“启动”，看提示的原因`);
    return { lines, issues };
  }
  if (!tunnel || !public_url) return { lines, issues };
  if (await answers(`${public_url}${LOGIN_PATH}`, PUBLIC_WAIT_MS)) lines.push(`外网入口 ${public_url} 正常`);
  else {
    const tail = tunnel_log_tail(home);
    issues.push(`外网地址 ${PUBLIC_WAIT_MS / 1000} 秒内没有打开。依次检查：Cloudflare DNS 里 ${tunnel.host} 是否是指向隧道的 CNAME（被别的记录占用要先删掉）；代理软件是否放行了 *.cloudflare.com、*.argotunnel.com（Clash 需开 TUN）；管理面板“概览”页“登录入口”一行的隧道状态${tail ? `。隧道日志：${tail}` : ''}`);
  }
  return { lines, issues };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function https_origin(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url.origin : '';
}

/** Use a saved public entry address rather than a Host or Origin supplied by a browser. */
export function hosted_cloud_base(data, settings, account) {
  const tunnel = settings.tunnel_enabled && https_origin(settings.public_url);
  if (tunnel) return tunnel + '/cloud-share/' + account;
  const relay = settings.relay_enabled && https_origin(settings.relay_url);
  if (!relay) return '';
  try {
    const { sites, relay_site } = JSON.parse(readFileSync(join(data, 'site-connections.json'), 'utf8'));
    const machine = sites?.[relay_site]?.machine_id;
    return /^[0-9a-f]{32}$/.test(machine) ? relay + '/cloud-share/' + machine + '/' + account : '';
  } catch { return ''; }
}

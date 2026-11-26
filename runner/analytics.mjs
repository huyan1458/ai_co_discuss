import { parseArgs } from 'node:util';

import { local_settings } from './discussion_setup.mjs';
import { site_fetch } from './entry_client.mjs';
import { t } from './i18n.mjs';

/** Read the local administrator's analytics snapshot and print its summary or complete JSON. */
export async function analytics_cli(args) {
  const { values } = parseArgs({ args, options: {
    range: { type: 'string' }, scope: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
  } });
  if (values.help) return console.log(t('用法：codiscuss analytics [--range today|7d|30d|all] [--scope all|current] [--from YYYY-MM-DD --to YYYY-MM-DD] [--json]'));
  if (process.env.DISCUSS_ACCESS_FILE) throw new Error(t('需要管理员身份'));
  const url = new URL('/api/analytics', 'http://127.0.0.1:' + (local_settings().port || 8765));
  for (const key of ['range', 'from', 'to', 'scope']) if (values[key] !== undefined) url.searchParams.set(key, values[key]);
  url.searchParams.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const response = await site_fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  const report = await response.json();
  if (!response.ok) throw new Error(t(report.error || '读取统计失败'));
  if (values.json) return console.log(JSON.stringify(report, null, 2));
  console.log(t('统计期间 {from} 至 {to}（结束日不含），含 {rooms} 个现存房间和 {sealed} 个已销毁房间。', { ...report.range, rooms: report.scope.rooms, sealed: report.scope.sealed_rooms }));
  console.log(t('发起 {initiated} 次，其中 {answered} 次已获回复。免介入 {unassisted} 条，已结束 {ended} 条。', report.overview));
  console.log(t('最高同时运行 {rooms} 个房间、{members} 位专家，当前排队 {count} 条。', { rooms: report.time.peak.rooms, members: report.time.peak.members ?? 0, count: report.time.queue.count }));
}

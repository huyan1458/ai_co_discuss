/** Describe a relay observation in the reader's language (panel or CLI). */
export function relay_health_text(site, row, t) {
  if (!site) return { label: t('未绑定'), detail: '', tone: 'is-gray' };
  if (!row || row.state === 'unknown') return {
    label: t('状态未知'), tone: 'is-gray', detail: row?.reason === 'stopped'
      ? t('共议服务未运行，无法确认中转状态。') : row?.reason === 'unavailable'
        ? t('暂时无法读取管理面板的最新状态。') : t('没有当前服务的近期中转记录。'),
  };
  const host = new URL(site).host;
  const failure = row.last_failure;
  const reason = failure_reason(failure, t);
  const retries = row.retries;
  const count = row.http_failures;
  const http_reason = count ? failure_reason({ kind: row.http_reason }, t) : '';
  if (row.state === 'failed' || row.state === 'reconnecting') {
    const label = row.state === 'failed' ? t('中转异常') : t('中转重连中');
    const detail = count
      ? t('与 {host} 的中转连接失败（{reason}），已重试 {retries} 次，HTTP 请求也已连续失败 {count} 次（{http_reason}）。', { host, reason, retries, count, http_reason })
      : t('与 {host} 的中转连接失败（{reason}），已重试 {retries} 次。', { host, reason, retries });
    return { label, tone: 'is-amber', detail };
  }
  if (row.state === 'connected' && row.http_failures) return {
    label: t('网站请求异常'), tone: 'is-amber', detail: t('中转心跳正常，但向 {host} 发出的 HTTP 请求已连续失败 {count} 次（{reason}）。',
      { host, count, reason: http_reason }),
  };
  if (row.state === 'connected') return { label: t('中转已连接'), tone: 'is-green', detail: '' };
  if (count) return { label: t('中转连接中'), tone: 'is-amber', detail:
    t('正在等待 {host} 确认中转，HTTP 请求已连续失败 {count} 次（{reason}）。', { host, count, reason: http_reason }) };
  return { label: t('中转连接中'), tone: 'is-amber', detail: retries && failure
    ? t('正在等待 {host} 确认连接，上次失败原因是{reason}，已重试 {retries} 次。', { host, reason, retries })
    : row.state === 'confirming' ? t('连接已打开，正在等待网站回应心跳。') : t('正在连接 {host}。', { host }) };
}

function failure_reason(failure, t) {
  switch (failure?.kind) {
    case 'heartbeat': return t('心跳超过 {seconds} 秒未回应', { seconds: failure.seconds });
    case 'closed': return t('连接已断开，关闭代码 {code}', { code: failure.code });
    case 'reset': return t('连接被重置，请检查本机网络或代理');
    case 'timeout': return t('连接超时，请检查本机网络或代理');
    case 'dns': return t('无法解析网站域名');
    case 'refused': return t('连接被拒绝');
    default: return /^HTTP \d{3}$/.test(failure?.kind) ? failure.kind : t('无法连接网站，请检查本机网络或代理');
  }
}

// Only these public URL shapes may reach an account's anonymous cloud share endpoint.
export const RELAY_HOSTED_CLOUD_SHARE = /^\/cloud-share\/([0-9a-f]{32})\/([a-z0-9][a-z0-9_-]{1,31})\/([0-9a-f]{64})(?:\/([0-9A-Za-z]{4}))?$/;
export const HOSTED_CLOUD_SHARE = /^\/cloud-share\/([a-z0-9][a-z0-9_-]{1,31})\/([0-9a-f]{64})(?:\/([0-9A-Za-z]{4}))?$/;
export const LOCAL_CLOUD_SHARE = /^\/_cloud-share\/([0-9a-f]{64})(?:\/([0-9A-Za-z]{4}))?$/;
export const CLOUD_SHARE_TOKEN = /^[0-9a-f]{64}$/;
export const CLOUD_SHARE_CODE = /^[0-9A-Za-z]{4}$/;
export const CLOUD_SHARE_BASE_HEADER = 'x-codiscuss-cloud-base';

/** Build the internal path from the validated token and optional code. */
export function local_cloud_share(token, code) {
  return '/_cloud-share/' + token + (code ? '/' + code : '');
}

export function cloud_share_not_found() {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

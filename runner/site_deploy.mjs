/**
 * Local website staging, publishing, renewal, rollback, revocation and `codiscuss site` CLI.
 * Uses only Node.js built-in modules; `device_token` stays exclusively inside the local private service directory.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { drafts_root } from './account_space.mjs';
import { parseArgs } from 'node:util';

import { configuration_snapshot, read_registry, service_home } from './discussion_service.mjs';
import { site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';

export const SITES_DOMAIN = 'bimcanvas.com';

export const LOCAL_SITE_LIMITS = {
  max_site_bytes: 100 * 1024 * 1024,
  max_site_files: 2000,
  max_scan_file_bytes: 2 * 1024 * 1024,
};

const DEVICES_FILE = 'site-devices.json';
const STAGES_FILE = 'site-stages.json';
const MAX_LOCAL_STAGES = 200;
const SITE_ID_PATTERN = /^[a-z2-7]{10}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DIAGNOSTIC_TIMEOUT_MS = 10_000;
const SKIP_DIRECTORIES = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.wrangler']);
const SKIP_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const DENIED_EXTENSIONS = new Set([
  'exe', 'msi', 'dmg', 'pkg', 'apk', 'bat', 'cmd', 'ps1', 'vbs', 'scr',
  'jar', 'sh', 'com', 'dll', 'so', 'dylib', 'appimage', 'deb', 'rpm', 'iso',
  'pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'kdbx',
]);

const SITE_MIME_TYPES = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  cjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  vtt: 'text/vtt; charset=utf-8',
  pdf: 'application/pdf',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'text/plain; charset=utf-8',
  mtl: 'text/plain; charset=utf-8',
  bin: 'application/octet-stream',
  hdr: 'application/octet-stream',
  ktx2: 'image/ktx2',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
};

const TEXT_SCAN_EXTENSIONS = new Set([
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'json', 'webmanifest', 'map',
  'svg', 'txt', 'md', 'xml', 'csv', 'tsv', 'vtt', 'yaml', 'yml',
]);

const SENSITIVE_PATTERNS = [
  { kind: 'api_key', pattern: /\bsk[-_](?:live_|proj_)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { kind: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'gitlab_token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'google_key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'package_token', pattern: /\b(?:hf|npm)_[A-Za-z0-9]{30,}/g },
  { kind: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g },
  { kind: 'secret_assignment', pattern: /\b(?:api[_-]?key|secret|access_token|private_key|password)\s*[:=]\s*["']?[^\s"'`]{12,}/gi },
  { kind: 'url_credentials', pattern: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/g },
];

export class SiteCommandError extends Error {
  constructor(message, { code = 'invalid', http_status = 400, ...details } = {}) {
    super(message);
    this.code = code;
    this.http_status = http_status;
    this.details = details;
  }
}

export function sites_origin(override = '') {
  const custom = override || process.env.CODISCUSS_SITES_ORIGIN || '';
  if (custom) return custom.replace(/\/+$/, '');
  const domain = (process.env.CODISCUSS_SITES_DOMAIN || SITES_DOMAIN).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  return `https://${domain}`;
}

function read_json_file(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function inside_directory(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function inspect_local_path(rel_path) {
  if (!rel_path || rel_path.length > 512 || rel_path.startsWith('/') || rel_path.includes('\\') || rel_path.includes('\0')) {
    return { ok: false, reason: 'invalid_path' };
  }
  const segments = rel_path.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') return { ok: false, reason: 'invalid_path' };
    const lower = seg.toLowerCase();
    if (lower === '.env' || lower.startsWith('.env.')) return { ok: false, reason: 'sensitive_filename' };
    if (lower === 'id_rsa' || lower.startsWith('id_rsa.') || lower === 'id_ed25519' || lower.startsWith('id_ed25519.')) {
      return { ok: false, reason: 'sensitive_filename' };
    }
  }
  const filename = segments.at(-1).toLowerCase();
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  if (DENIED_EXTENSIONS.has(ext)) return { ok: false, reason: 'denied_extension' };
  if (!Object.hasOwn(SITE_MIME_TYPES, ext)) return { ok: false, reason: 'unsupported_extension' };
  return { ok: true, content_type: SITE_MIME_TYPES[ext], ext };
}

function mask_match(text, index, length) {
  const snippet_chars = 16;
  const from = Math.max(0, index - snippet_chars);
  const to = Math.min(text.length, index + length + snippet_chars);
  const raw_match = text.slice(index, index + length);
  const masked = raw_match.length <= 8 ? '****' : `${raw_match.slice(0, 4)}…${raw_match.slice(-3)}`;
  const prefix = text.slice(from, index);
  const suffix = text.slice(index + length, to);
  return `${from ? '…' : ''}${prefix}${masked}${suffix}${to < text.length ? '…' : ''}`.replace(/\s+/g, ' ');
}

function scan_text_spots(rel_path, content) {
  const spots = [];
  for (const { kind, pattern } of SENSITIVE_PATTERNS) {
    let count = 0;
    let first_text = '';
    for (const match of content.matchAll(pattern)) {
      count += 1;
      if (!first_text) first_text = mask_match(content, match.index, match[0].length);
    }
    if (count) spots.push({ path: rel_path, kind, count, text: first_text });
  }
  return spots;
}

/** Find the local room configuration for `room_id`, if registered on this computer. */
function find_room_config(home, room_id, site = '') {
  if (!room_id) return null;
  const normalized_site = site ? site.replace(/\/+$/, '') : '';
  for (const config_path of read_registry(home)) {
    try {
      const { config } = configuration_snapshot(config_path);
      if (config.room !== room_id) continue;
      if (normalized_site && config.site && config.site.replace(/\/+$/, '') !== normalized_site) continue;
      return config;
    } catch { /* ignore unreadable configs */ }
  }
  return null;
}

// Launch configs store the room's project directory as `cwd` (see adapters/common.mjs project_directory).
function room_project_directory(config) {
  return config?.cwd || config?.workdir || '';
}

function room_allowed_roots(config, home) {
  const roots = [];
  const add = (dir) => {
    if (!dir) return;
    try {
      const real = realpathSync(dir);
      if (statSync(real).isDirectory() && !roots.includes(real)) roots.push(real);
    } catch { /* ignore missing dir */ }
  };
  if (config) {
    add(room_project_directory(config));
    for (const extra of config.extra_directories || []) add(extra);
    // Not `config.directory`: that is the launch's runtime folder, holding task files and member credentials.
  }
  // Draft directory for member-generated HTML files
  add(drafts_root(home));
  return roots;
}

function resolve_target_path(home, config, input) {
  const raw = input.dir || input.file || input.path || '';
  if (!raw || typeof raw !== 'string') {
    throw new SiteCommandError(t('请指定要发布的目录（dir）或 HTML 文件（file）'), { code: 'invalid', http_status: 400 });
  }
  const roots = config ? room_allowed_roots(config, home) : [];
  let candidate;
  if (isAbsolute(raw)) {
    candidate = resolve(raw);
  } else if (config) {
    const root_index = Number.isInteger(input.root) ? input.root : 0;
    const base_dir = (root_index === 0 ? room_project_directory(config) : (config.extra_directories || [])[root_index - 1])
      || room_project_directory(config);
    if (!base_dir) {
      throw new SiteCommandError(t('房间未设置项目目录，无法解析相对路径'), { code: 'invalid_path', http_status: 400 });
    }
    candidate = resolve(base_dir, raw);
  } else {
    candidate = resolve(process.cwd(), raw);
  }

  let real_target;
  try {
    real_target = realpathSync(candidate);
  } catch {
    throw new SiteCommandError(t('目标目录或文件不存在：{path}', { path: raw }), { code: 'missing', http_status: 404 });
  }

  // Enforce room directory boundary when a room config is present (and verify member read permission).
  if (config) {
    if (input.member) {
      // `participants` is an object keyed by member name in launch configs.
      const member_cfg = Object.entries(config.participants || {})
        .find(([name, p]) => name === input.member || p?.label === input.member)?.[1];
      if (member_cfg && member_cfg.project_access === 'none') {
        throw new SiteCommandError(t('成员 {member} 无权读取该项目目录', { member: input.member }), { code: 'auth', http_status: 403 });
      }
    }
    if (!roots.some((root) => inside_directory(root, real_target))) {
      throw new SiteCommandError(t('目标路径超出本房间允许的项目目录范围'), { code: 'auth', http_status: 403 });
    }
  }

  const stat = statSync(real_target);
  const kind = stat.isDirectory() ? 'directory' : 'file';
  let display_dir = basename(real_target);
  if (room_project_directory(config)) {
    try {
      const real_project = realpathSync(room_project_directory(config));
      if (inside_directory(real_project, real_target)) {
        display_dir = relative(real_project, real_target).replaceAll('\\', '/') || '.';
      }
    } catch { /* keep basename */ }
  }
  return { real_target, kind, display_dir };
}

/** Collect manifest entries, rejected files and sensitive text spots for a directory or single HTML file. */
export function scan_site_source(real_target, kind, exclude = []) {
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map((p) => String(p).replaceAll('\\', '/').replace(/^\/+/, '')));
  const files = [];
  const rejected_files = [];
  const spots = [];

  if (kind === 'file') {
    const name = basename(real_target);
    const ext = extname(name).slice(1).toLowerCase();
    if (ext !== 'html' && ext !== 'htm') {
      rejected_files.push({ path: name, bytes: statSync(real_target).size, reason: 'single_file_must_be_html' });
    } else {
      const buf = readFileSync(real_target);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      files.push({ path: 'index.html', abs_path: real_target, bytes: buf.byteLength, sha256, content_type: SITE_MIME_TYPES.html });
      if (buf.byteLength <= LOCAL_SITE_LIMITS.max_scan_file_bytes) {
        spots.push(...scan_text_spots('index.html', buf.toString('utf8')));
      }
    }
  } else {
    const walk = (dir, prefix) => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(lower)) continue;
          walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          continue;
        }
        if (SKIP_FILES.has(lower)) continue;
        const full = join(dir, entry.name);
        let real_file;
        try {
          real_file = realpathSync(full);
          if (!inside_directory(real_target, real_file)) continue;
          if (!statSync(real_file).isFile()) continue;
        } catch {
          continue;
        }
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (excluded.has(rel)) continue;
        const stat = statSync(real_file);
        const inspected = inspect_local_path(rel);
        if (!inspected.ok) {
          rejected_files.push({ path: rel, bytes: stat.size, reason: inspected.reason });
          continue;
        }
        const buf = readFileSync(real_file);
        const sha256 = createHash('sha256').update(buf).digest('hex');
        files.push({ path: rel, abs_path: real_file, bytes: buf.byteLength, sha256, content_type: inspected.content_type });
        if (TEXT_SCAN_EXTENSIONS.has(inspected.ext) && buf.byteLength <= LOCAL_SITE_LIMITS.max_scan_file_bytes) {
          spots.push(...scan_text_spots(rel, buf.toString('utf8')));
        }
      }
    };
    walk(real_target, '');
  }

  const total_bytes = files.reduce((sum, item) => sum + item.bytes, 0);
  const quota_issues = [];
  if (files.length > LOCAL_SITE_LIMITS.max_site_files) {
    quota_issues.push({
      code: 'file_count_limit',
      limit: LOCAL_SITE_LIMITS.max_site_files,
      total: files.length,
      files: files.slice(LOCAL_SITE_LIMITS.max_site_files).map((f) => ({ path: f.path, bytes: f.bytes, reason: 'file_count_limit' })),
    });
  }
  if (total_bytes > LOCAL_SITE_LIMITS.max_site_bytes) {
    quota_issues.push({
      code: 'site_size_limit',
      limit: LOCAL_SITE_LIMITS.max_site_bytes,
      bytes: total_bytes,
      files: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 20)
        .map((f) => ({ path: f.path, bytes: f.bytes, reason: 'site_size_limit' })),
    });
  }
  const has_index = files.some((f) => f.path === 'index.html');
  return {
    files,
    public_files: files.map(({ path, bytes, sha256, content_type }) => ({ path, bytes, sha256, content_type })),
    rejected_files,
    spots,
    quota_issues,
    file_count: files.length,
    bytes: total_bytes,
    has_index,
    ready: files.length > 0 && rejected_files.length === 0 && quota_issues.length === 0 && spots.length === 0,
  };
}

/** Annotate transport failures without exposing credentials or query parameters. */
async function deployment_fetch(fetcher, url, init) {
  try {
    return await fetcher(url, init);
  } catch (error) {
    const target = new URL(url);
    const address = target.origin + target.pathname;
    const code = error.cause?.code || error.cause?.errors?.find(item => item.code)?.code || error.code;
    if (!code && error.message !== 'fetch failed') throw error;
    throw new SiteCommandError(t('请求 {address} 失败（{code}）', { address, code: code || 'NETWORK_ERROR' }), {
      code: 'network_error', http_status: 503,
    });
  }
}

/** Keep private device_token exclusively inside `~/.codiscuss/site-devices.json` (mode 0600). */
async function ensure_device_identity(home, origin, fetcher = fetch) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, DEVICES_FILE);
  const store = read_json_file(file, {});
  if (store[origin]?.device_id && store[origin]?.device_token) {
    return store[origin];
  }
  const res = await deployment_fetch(fetcher, `${origin}/api/devices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
    body: '{}',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.device_id || !body.device_token) {
    throw new SiteCommandError(body.error || t('注册本机发布身份失败（HTTP {status}）', { status: res.status }), {
      code: body.code || 'busy', http_status: res.status || 503,
    });
  }
  const identity = { device_id: body.device_id, device_token: body.device_token, created_at: body.created_at || new Date().toISOString() };
  store[origin] = identity;
  atomic_json(file, store);
  return identity;
}

function get_saved_device_identity(home, origin) {
  const store = read_json_file(join(home, DEVICES_FILE), {});
  return store[origin]?.device_id && store[origin]?.device_token ? store[origin] : null;
}

function save_local_stage(home, stage_id, record) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, STAGES_FILE);
  const store = read_json_file(file, {});
  store[stage_id] = record;
  const keys = Object.keys(store);
  if (keys.length > MAX_LOCAL_STAGES) {
    keys.sort((a, b) => String(store[a]?.created_at || '').localeCompare(String(store[b]?.created_at || '')))
      .slice(0, keys.length - MAX_LOCAL_STAGES)
      .forEach((k) => delete store[k]);
  }
  atomic_json(file, store);
}

function load_local_stage(home, stage_id) {
  const store = read_json_file(join(home, STAGES_FILE), {});
  return store[stage_id] || null;
}

async function room_api_request(site, path, { method = 'GET', token = '', body = undefined, fetcher = fetch, signal } = {}) {
  if (!site) return null;
  const headers = { 'Accept-Language': 'zh-CN' };
  if (token) headers['X-Discussion-Token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // A protected local site only accepts requests that pass the entry handshake (entry_client.mjs).
  const send = fetcher === fetch ? site_fetch : fetcher;
  const res = await deployment_fetch(send, `${site.replace(/\/+$/, '')}${path}`, {
    method,
    headers,
    signal,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SiteCommandError(parsed.error || `HTTP ${res.status}`, { code: 'room_sync_failed', http_status: res.status });
  }
  return parsed;
}

async function worker_api(origin, path, { method = 'GET', token = '', body = undefined, raw_body = undefined, content_type = '', fetcher = fetch, signal } = {}) {
  const headers = { 'Accept-Language': 'zh-CN' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (raw_body !== undefined) {
    headers['Content-Type'] = content_type || 'application/octet-stream';
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await deployment_fetch(fetcher, `${origin}${path}`, {
    method,
    headers,
    signal,
    ...(raw_body !== undefined ? { body: raw_body } : body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SiteCommandError(parsed.error || t('站点服务返回错误（HTTP {status}）', { status: res.status }), {
      code: parsed.code || 'worker_error',
      http_status: res.status,
      ...(parsed.files ? { files: parsed.files } : {}),
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.bytes !== undefined ? { bytes: parsed.bytes } : {}),
    });
  }
  return parsed;
}

function resolve_room_connection(home, input) {
  const room_id = input.room_id || input.room || '';
  const config = find_room_config(home, room_id, input.site || '');
  const site = (input.site || config?.site || '').replace(/\/+$/, '');
  // Use the room's local owner/control token when writing site metadata back to Python.
  const write_token = config?.token || input.token || '';
  return { room_id, config, site, write_token };
}

async function write_stage_record(home, { room_id, site, write_token }, { real_target, kind, display_dir }, scan, input, fetcher) {
  const stage_id = input.stage_id || randomBytes(6).toString('hex');
  const title = (input.title || display_dir || '未命名站点').slice(0, 200);
  const payload = {
    action: 'stage',
    stage_id,
    execution_id: input.execution_id ?? null,
    message_id: input.message_id ?? null,
    member: input.member || '',
    title,
    directory: display_dir,
    kind,
    file_count: scan.file_count,
    bytes: scan.bytes,
    files: scan.public_files.map(({ path, bytes, content_type }) => ({ path, bytes, content_type })),
    spots: scan.spots,
    rejected_files: scan.rejected_files,
    ready: scan.ready,
  };
  save_local_stage(home, stage_id, {
    stage_id, room_id, local_path: real_target, kind, directory: display_dir, title,
    exclude: Array.isArray(input.exclude) ? input.exclude : [], created_at: new Date().toISOString(),
  });
  // The owner's deploy dialog stages a file only to show what would go public (`preview`): the stage stays on this
  // computer, so no "待部署" card appears under the answer unless it is published (user 2026-11-25, #12748).
  if (room_id && site && !input.preview) {
    await room_api_request(site, `/api/rooms/${encodeURIComponent(room_id)}/sites`, {
      method: 'POST', token: write_token, body: payload, fetcher,
    });
  }
  return {
    stage_id, room_id, title, directory: display_dir, kind,
    file_count: scan.file_count, bytes: scan.bytes, ready: scan.ready,
    has_index: scan.has_index,
    files: payload.files, spots: scan.spots, rejected_files: scan.rejected_files,
  };
}

/** Query the owned-site endpoint, with version-only evidence from older Workers. */
async function remote_diagnostics(origin, site_id, token, fetcher) {
  const options = () => ({ token, fetcher, signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS) });
  try {
    const remote = await worker_api(origin, `/api/sites/${site_id}/diagnostics`, options());
    return { ...remote, details_available: true };
  } catch (error) {
    if (error.http_status !== 404) throw error;
    const { sites } = await worker_api(origin, '/api/sites', options());
    const site = sites?.find(item => item.id === site_id);
    if (!site) throw error;
    return { status: site.status, url: site.url, source_room: site.source?.room,
      active_version: site.status === 'active' ? site.current_version || null : null,
      manifest: null, samples: null, details_available: false };
  }
}

/** Read the room's own version and linked stage without the synchronization performed by site-list. */
async function read_registration(conn, site_id, fetcher) {
  if (!conn.site) return { state: 'unavailable' };
  const path = conn.room_id ? `/api/rooms/${encodeURIComponent(conn.room_id)}/sites` : '/api/sites';
  try {
    const data = await room_api_request(conn.site, path, { fetcher, signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS) });
    const record = data?.sites?.find(item => item.site_id === site_id);
    const linked = data?.stages?.find(item => item.site_id === site_id);
    const stage = linked ? { stage_id: linked.stage_id, ready: linked.ready, file_count: linked.file_count, bytes: linked.bytes } : null;
    return { state: record ? 'observed' : 'missing', room_id: record?.room_id || conn.room_id || null,
      version: record?.current_version ?? null, status: record?.status ?? null, stage };
  } catch {
    return { state: 'unavailable' };
  }
}

/** Only use the public hostname corresponding to this ID and hosting service. */
function public_site_origin(origin, site_id, url) {
  try {
    const public_url = new URL(url);
    if (public_url.protocol === 'https:' && !public_url.port && !public_url.username && !public_url.password
        && public_url.hostname === `${site_id}.${new URL(origin).hostname}`) return public_url.origin;
  } catch { /* the address could not be verified */ }
  return '';
}

/** Hash the anonymous response in a bounded stream and discard the body. */
async function check_public_file(origin, path, digest, fetcher) {
  const checked = { path, expected_sha256: SHA256_PATTERN.test(digest || '') ? digest : null,
    actual_sha256: null, http_status: null, status: 'unavailable' };
  if (!origin) return checked;
  try {
    const response = await fetcher(origin + path, { method: 'GET', redirect: 'manual', cache: 'no-store',
      signal: AbortSignal.timeout(DIAGNOSTIC_TIMEOUT_MS) });
    checked.http_status = response.status;
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ...checked, status: 'http_error' };
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.byteLength;
      if (bytes > LOCAL_SITE_LIMITS.max_site_bytes) return { ...checked, status: 'too_large' };
      hash.update(chunk);
    }
    checked.actual_sha256 = hash.digest('hex');
    checked.status = !checked.expected_sha256 ? 'unverified'
      : checked.expected_sha256 === checked.actual_sha256 ? 'match' : 'mismatch';
  } catch { /* no result if the request or response stream failed */ }
  return checked;
}

/** Determine the furthest confirmed step for the pending manifest or the active version. */
function confirmed_stage(remote, registration_matches, probes) {
  const manifest = remote.manifest;
  if (manifest?.status === 'uploading' && manifest.version > (remote.active_version || 0)) {
    if (manifest.uploaded === manifest.file_count) return 'upload_complete';
    return manifest.uploaded ? 'upload_partial' : 'manifest_registered';
  }
  if (!remote.active_version) return 'inactive';
  if (!registration_matches) return 'remote_activated';
  if (probes.entry?.status === 'match' && (!probes.asset || probes.asset.status === 'match')) return 'public_samples_verified';
  return 'room_registered';
}

/** Compare independently observed deployment records and anonymous public responses. */
async function diagnose_site(home, conn, site_id, { origin, token, fetcher }) {
  const remote = await remote_diagnostics(origin, site_id, token, fetcher);
  const target = conn.room_id ? conn : resolve_room_connection(home, { room_id: remote.source_room, site: conn.site });
  const registration = await read_registration(target, site_id, fetcher);
  if (conn.room_id && remote.source_room !== conn.room_id && registration.state !== 'observed') {
    throw new SiteCommandError(t('站点不属于当前房间'), { code: 'auth', http_status: 403 });
  }
  const public_origin = public_site_origin(origin, site_id, remote.url);
  const asset_path = remote.samples?.asset?.path;
  const [entry, asset] = remote.active_version ? await Promise.all([
    check_public_file(public_origin, '/', remote.samples?.entry?.sha256, fetcher),
    typeof asset_path === 'string' && inspect_local_path(asset_path).ok
      ? check_public_file(public_origin, '/' + asset_path.split('/').map(encodeURIComponent).join('/'),
        remote.samples.asset.sha256, fetcher) : null,
  ]) : [null, null];
  const probes = { entry, asset };
  const registration_matches_active = remote.active_version && registration.state === 'observed'
    ? registration.version === remote.active_version && registration.status === 'active' : null;
  return { site_id, url: public_origin || null, registration, remote: { status: remote.status, active_version: remote.active_version,
    manifest: remote.manifest, details_available: remote.details_available }, registration_matches_active, probes,
    last_confirmed_stage: confirmed_stage(remote, registration_matches_active, probes) };
}

/** Execute a local site command. */
export async function site_command(home, command, input = {}, { fetcher = fetch, sites_origin: origin_override = '' } = {}) {
  const origin = sites_origin(origin_override || input.sites_origin || '');
  const conn = resolve_room_connection(home, input);

  if (command === 'site-stage') {
    const target = resolve_target_path(home, conn.config, input);
    const scan = scan_site_source(target.real_target, target.kind, input.exclude);
    return write_stage_record(home, conn, target, scan, input, fetcher);
  }

  if (command === 'site-publish') {
    let target;
    let effective_exclude = Array.isArray(input.exclude) ? input.exclude : [];
    let effective_title = input.title || '';
    if (input.stage_id) {
      const staged = load_local_stage(home, input.stage_id);
      if (!staged) throw new SiteCommandError(t('待部署记录不存在或已失效，请重新生成'), { code: 'missing', http_status: 404 });
      if (conn.room_id && staged.room_id && staged.room_id !== conn.room_id) {
        throw new SiteCommandError(t('待部署记录不属于当前房间'), { code: 'auth', http_status: 403 });
      }
      if (!existsSync(staged.local_path)) {
        throw new SiteCommandError(t('待部署的本地目录或文件已不存在'), { code: 'missing', http_status: 404 });
      }
      target = { real_target: staged.local_path, kind: staged.kind, display_dir: staged.directory };
      if (!effective_exclude.length && Array.isArray(staged.exclude)) effective_exclude = staged.exclude;
      if (!effective_title) effective_title = staged.title;
    } else {
      target = resolve_target_path(home, conn.config, input);
    }

    const scan = scan_site_source(target.real_target, target.kind, effective_exclude);
    if (!scan.file_count && !scan.rejected_files.length) {
      throw new SiteCommandError(t('目录为空，没有可发布的静态文件'), { code: 'invalid', http_status: 400 });
    }
    if (scan.rejected_files.length) {
      const staged = await write_stage_record(home, conn, target, scan, { ...input, title: effective_title, exclude: effective_exclude }, fetcher);
      throw new SiteCommandError(t('包含不允许发布的文件类型或敏感文件，请排除后再发布'), {
        code: 'file_type', http_status: 400, files: scan.rejected_files, stage_id: staged.stage_id,
      });
    }
    if (scan.quota_issues.length) {
      const issue = scan.quota_issues[0];
      const staged = await write_stage_record(home, conn, target, scan, { ...input, title: effective_title, exclude: effective_exclude }, fetcher);
      throw new SiteCommandError(
        issue.code === 'file_count_limit' ? t('文件数超过 2000 上限') : t('站点总大小超过 100 MiB 上限'),
        { code: issue.code, http_status: 413, files: issue.files, limit: issue.limit, bytes: scan.bytes, stage_id: staged.stage_id },
      );
    }
    if (scan.spots.length && input.ignore_spots !== true) {
      const staged = await write_stage_record(home, conn, target, scan, { ...input, title: effective_title, exclude: effective_exclude }, fetcher);
      throw new SiteCommandError(t('扫描到疑似敏感内容，已转为待部署状态，请核对或用 exclude 排除后再发布'), {
        code: 'sensitive_content',
        http_status: 400,
        spots: scan.spots,
        files: scan.spots.map((s) => ({ path: s.path, reason: s.kind, text: s.text })),
        stage_id: staged.stage_id,
      });
    }

    const identity = await ensure_device_identity(home, origin, fetcher);
    const title = (effective_title || target.display_dir || '未命名站点').slice(0, 200);
    let site_id = input.site_id || '';
    if (site_id) {
      if (!SITE_ID_PATTERN.test(site_id)) throw new SiteCommandError(t('站点编号格式不正确'), { code: 'invalid', http_status: 400 });
    } else {
      const created = await worker_api(origin, '/api/sites', {
        method: 'POST',
        token: identity.device_token,
        body: { title, source: { room: conn.room_id, message: input.message_id ?? '', member: input.member || '' } },
        fetcher,
      });
      site_id = created.id;
    }

    const version_res = await worker_api(origin, `/api/sites/${site_id}/versions`, {
      method: 'POST',
      token: identity.device_token,
      body: { title, files: scan.public_files },
      fetcher,
    });
    const version = version_res.version;

    for (const file of scan.files) {
      const encoded_path = file.path.split('/').map(encodeURIComponent).join('/');
      const data = readFileSync(file.abs_path);
      await worker_api(origin, `/api/sites/${site_id}/versions/${version}/files/${encoded_path}`, {
        method: 'PUT',
        token: identity.device_token,
        raw_body: data,
        content_type: file.content_type,
        fetcher,
      });
    }

    const activated = await worker_api(origin, `/api/sites/${site_id}/versions/${version}/activate`, {
      method: 'POST',
      token: identity.device_token,
      body: {},
      fetcher,
    });

    const version_entry = {
      version: activated.current_version,
      file_count: activated.file_count,
      bytes: activated.bytes,
      message_id: input.message_id ?? null,
      member: input.member || '',
      created_at: new Date().toISOString(),
    };
    let existing_versions = [];
    if (conn.room_id && conn.site) {
      try {
        const room_sites = await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(conn.room_id)}/sites`, {
          method: 'GET', token: conn.write_token, fetcher,
        });
        const prev = (room_sites?.sites || []).find((s) => s.site_id === site_id);
        if (prev && Array.isArray(prev.versions)) existing_versions = prev.versions;
      } catch { /* ignore read failure */ }
    }
    const versions = [version_entry, ...existing_versions.filter((v) => v.version !== version_entry.version)].slice(0, 10);
    const public_files = scan.public_files.map(({ path, bytes, content_type }) => ({ path, bytes, content_type }));

    if (conn.room_id && conn.site) {
      await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(conn.room_id)}/sites`, {
        method: 'POST',
        token: conn.write_token,
        body: {
          action: 'upsert',
          site_id,
          url: activated.url,
          title,
          directory: target.display_dir,
          message_id: input.message_id ?? null,
          execution_id: input.execution_id ?? null,
          member: input.member || '',
          current_version: activated.current_version,
          previous_version: activated.previous_version,
          file_count: activated.file_count,
          bytes: activated.bytes,
          status: activated.status,
          expires_at: activated.expires_at,
          versions,
          files: public_files,
          stage_id: input.stage_id || '',
        },
        fetcher,
      });
    }

    return {
      site_id,
      url: activated.url,
      room_id: conn.room_id,
      title,
      directory: target.display_dir,
      current_version: activated.current_version,
      previous_version: activated.previous_version,
      file_count: activated.file_count,
      bytes: activated.bytes,
      status: activated.status,
      expires_at: activated.expires_at,
      versions,
      files: public_files,
    };
  }

  if (command === 'site-list') {
    let remote_sites = null;
    const identity = get_saved_device_identity(home, origin);
    if (identity && input.sync !== false) {
      try {
        const listed = await worker_api(origin, '/api/sites', { method: 'GET', token: identity.device_token, fetcher });
        remote_sites = listed.sites || [];
      } catch { /* offline fallback to local database */ }
    }
    if (conn.site) {
      const path = conn.room_id ? `/api/rooms/${encodeURIComponent(conn.room_id)}/sites` : '/api/sites';
      const local_data = await room_api_request(conn.site, path, { method: 'GET', token: conn.write_token, fetcher });
      if (remote_sites && local_data?.sites) {
        const by_id = new Map(remote_sites.map((s) => [s.id, s]));
        for (const site_row of local_data.sites) {
          const remote = by_id.get(site_row.site_id);
          if (!remote) continue;
          if (remote.status !== site_row.status || remote.expires_at !== site_row.expires_at || remote.current_version !== site_row.current_version) {
            site_row.status = remote.status;
            site_row.expires_at = remote.expires_at;
            site_row.current_version = remote.current_version;
            site_row.previous_version = remote.previous_version;
            const target_room = site_row.room_id || conn.room_id;
            const target_cfg = find_room_config(home, target_room, conn.site);
            await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(target_room)}/sites`, {
              method: 'POST',
              token: target_cfg?.token || conn.write_token,
              body: {
                action: 'update_status',
                site_id: site_row.site_id,
                status: remote.status,
                expires_at: remote.expires_at,
                current_version: remote.current_version,
                previous_version: remote.previous_version,
              },
              fetcher,
            }).catch(() => {});
          }
        }
      }
      return local_data;
    }
    // Same field name as the room records (`site_id`), whichever source answered.
    return { sites: (remote_sites || []).map(({ id, ...site }) => ({ site_id: id, ...site })) };
  }

  const site_id = input.site_id || input.id || '';
  if (!SITE_ID_PATTERN.test(site_id)) {
    throw new SiteCommandError(t('请提供有效的 10 位站点编号（site_id）'), { code: 'invalid', http_status: 400 });
  }
  const identity = get_saved_device_identity(home, origin);
  if (!identity) {
    throw new SiteCommandError(t('本机尚未注册发布身份，无法操作该站点'), { code: 'auth', http_status: 403 });
  }

  if (command === 'site-diagnose') {
    return diagnose_site(home, conn, site_id, { origin, token: identity.device_token, fetcher });
  }

  if (command === 'site-renew') {
    const body = input.days !== undefined ? { days: Number(input.days) } : {};
    // Renewing is idempotent, so a dropped connection (ECONNRESET through a proxy) is retried once.
    const renew = () => worker_api(origin, `/api/sites/${site_id}/renew`, { method: 'POST', token: identity.device_token, body, fetcher });
    const res = await renew().catch(error => (error.code === 'network_error' ? renew() : Promise.reject(error)));
    if (conn.room_id && conn.site) {
      await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(conn.room_id)}/sites`, {
        method: 'POST',
        token: conn.write_token,
        body: { action: 'update_status', site_id, status: res.status, expires_at: res.expires_at },
        fetcher,
      }).catch(() => {});
    }
    return { site_id, url: res.url, expires_at: res.expires_at, status: res.status };
  }

  if (command === 'site-rollback') {
    const body = input.version !== undefined ? { version: Number(input.version) } : {};
    const res = await worker_api(origin, `/api/sites/${site_id}/rollback`, {
      method: 'POST', token: identity.device_token, body, fetcher,
    });
    if (conn.room_id && conn.site) {
      await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(conn.room_id)}/sites`, {
        method: 'POST',
        token: conn.write_token,
        body: {
          action: 'update_status',
          site_id,
          status: res.status,
          current_version: res.current_version,
          previous_version: res.previous_version,
          file_count: res.file_count,
          bytes: res.bytes,
        },
        fetcher,
      }).catch(() => {});
    }
    return {
      site_id, url: res.url, current_version: res.current_version, previous_version: res.previous_version,
      file_count: res.file_count, bytes: res.bytes, status: res.status, expires_at: res.expires_at,
    };
  }

  if (command === 'site-revoke') {
    await worker_api(origin, `/api/sites/${site_id}`, {
      method: 'DELETE', token: identity.device_token, fetcher,
    });
    if (conn.room_id && conn.site) {
      await room_api_request(conn.site, `/api/rooms/${encodeURIComponent(conn.room_id)}/sites`, {
        method: 'POST',
        token: conn.write_token,
        body: { action: 'update_status', site_id, status: 'revoked' },
        fetcher,
      }).catch(() => {});
    }
    return { ok: true, site_id, status: 'revoked' };
  }

  throw new SiteCommandError(t('未知的站点命令：{command}', { command }), { code: 'invalid', http_status: 400 });
}

const SITE_CLI_HELP = () => t(`AI CoDiscuss 网站部署

注意：发布到公网须有用户在本房间的明确授权；未经用户明确要求发布时，仅使用 stage 在本机预检登记。

用法：
  codiscuss site stage (--dir 目录 | --file 文件.html) [--room 房间] [--title 标题] [--exclude 路径]
  codiscuss site publish (--dir 目录 | --file 文件.html | --stage 编号) [--site 站点编号] [--room 房间] [--title 标题] [--exclude 路径]
  codiscuss site list [--room 房间]
  codiscuss site diagnose <站点编号> [--room 房间]
  codiscuss site renew <站点编号> [--days 1|3|7] [--room 房间]
  codiscuss site rollback <站点编号> [--version 版本号] [--room 房间]
  codiscuss site revoke <站点编号> [--room 房间]

选项：
  --access-file FILE    任务凭据文件（默认读取 DISCUSS_ACCESS_FILE）
  --room ROOM           房间编号（凭据绑定时自动补齐）
  --url SITE            本机/房间网站地址（凭据绑定时自动补齐）
  --dir PATH            要发布的本机构建目录
  --file PATH           要发布的单个 HTML 文件
  --stage ID            对已预检的待部署编号执行发布
  --site ID             更新已有 10 位站点编号
  --title TEXT          站点标题
  --exclude PATH        排除的相对文件路径（可重复传多次）
  --version N           回滚目标版本号（省略则回滚到上一版）
  --days N              续期天数，从现在起算（1、3 或 7，默认 7）
  --json                以 JSON 输出（默认）
  -h, --help            显示帮助
`);

function read_access_file(explicit_path = '') {
  const path = explicit_path || process.env.DISCUSS_ACCESS_FILE || '';
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/** CLI entrypoint for `codiscuss site <subcommand>`. Delegates directly to `site_command`. */
export async function site_cli(args, { home = service_home(), fetcher = fetch } = {}) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'access-file': { type: 'string' },
      room: { type: 'string' },
      url: { type: 'string' },
      dir: { type: 'string' },
      file: { type: 'string' },
      stage: { type: 'string' },
      site: { type: 'string' },
      title: { type: 'string' },
      exclude: { type: 'string', multiple: true },
      version: { type: 'string' },
      days: { type: 'string' },
      'sites-origin': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const sub = positionals[0] || '';
  if (values.help || !sub || sub === 'help') {
    process.stdout.write(SITE_CLI_HELP());
    return;
  }
  const map = {
    stage: 'site-stage',
    publish: 'site-publish',
    list: 'site-list',
    diagnose: 'site-diagnose',
    renew: 'site-renew',
    rollback: 'site-rollback',
    revoke: 'site-revoke',
  };
  const command = map[sub];
  if (!command) {
    throw new Error(t('未知子命令：{sub}；运行 codiscuss site --help 查看用法', { sub }));
  }
  const access = read_access_file(values['access-file']);
  const input = {
    room_id: values.room || access.room || '',
    site: values.url || access.site || process.env.DISCUSS_URL || '',
    token: access.token || '',
    member: access.member || '',
    execution_id: access.execution_id ?? null,
    dir: values.dir || undefined,
    file: values.file || undefined,
    stage_id: values.stage || undefined,
    site_id: values.site || (['diagnose', 'renew', 'rollback', 'revoke'].includes(sub) ? positionals[1] : undefined),
    title: values.title || undefined,
    exclude: values.exclude || undefined,
    version: values.version !== undefined ? Number(values.version) : undefined,
    days: values.days !== undefined ? Number(values.days) : undefined,
    sites_origin: values['sites-origin'] || undefined,
  };
  try {
    if (sub === 'diagnose' && access.room && (input.room_id !== access.room
        || (values.url && values.url.replace(/\/+$/, '') !== access.site?.replace(/\/+$/, '')))) {
      throw new SiteCommandError(t('站点诊断须使用凭据绑定的房间和网站'), { code: 'auth', http_status: 403 });
    }
    const result = await site_command(home, command, input, { fetcher });
    process.stdout.write(`${JSON.stringify({ ok: true, data: result }, null, 2)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        message: error.message,
        code: error.code || 'error',
        ...(error.details || {}),
      },
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}

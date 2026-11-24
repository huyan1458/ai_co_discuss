/**
 * Share-card tools for room AI members: `codiscuss share-card materials` (shareable-scope collaboration metrics,
 * concurrency curve and material index) and `codiscuss share-card render` (local static HTML → PNG via an isolated,
 * sandboxed local Chromium/Edge browser controlled over private process pipes). Uses only Node.js built-in modules.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { drafts_root } from './account_space.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { kill_process_tree } from './adapters/common.mjs';
import { adapter_capabilities } from './adapters/profiles.mjs';
import { configuration_snapshot, read_registry, service_home } from './discussion_service.mjs';
import { local_settings } from './discussion_setup.mjs';
import { site_fetch } from './entry_client.mjs';
import { t } from './i18n.mjs';
import {
  create_share_core,
  is_share_question_receipt,
  SHARE_FILE_KINDS,
  SHARE_HOME_FOLDERS,
  SHARE_SENSITIVE_PATTERNS,
} from './share_shared.mjs';
import { collaboration_metrics, format_duration } from './timeline_metrics.mjs';

export const SHARE_CARD_COVER_SPEC = Object.freeze({
  width_css_px: 750,
  scale: 2,
  export_width_px: 1500,
  recommended_height_css_px: [560, 1100],
  min_height_css_px: 200,
  max_height_css_px: 1500,
  max_aspect_ratio: '2:1',
  format: 'png',
  accepted_image_formats: ['png', 'jpg', 'jpeg', 'webp'],
  default_background: '#12141c',
});

const READ_ONLY_HEADER = 'X-Discussion-Read-Only';
const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_TIMELINE_PAGES = 20;
const MAX_MESSAGE_PAGES = 50;
const MESSAGES_PER_PAGE = 200;
const DEFAULT_HIGHLIGHTS = 12;
const DEFAULT_CURVE_STEPS = 240;
const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
const MIN_WIDTH_PX = 320;
const MAX_WIDTH_PX = 1500;
const HARD_MAX_HEIGHT_PX = 2400;
const HEX_COLOR = /^#([0-9a-fA-F]{6})$/;
const SLASH_COMMAND = /^\/(?:goal|discuss)\b/i;
const SHORT_ACK = /^(?:继续|好的?|行|ok|yes|收到|同意|开始|可以|确认|嗯|明白|go|continue)[。！!.,，\s]*$/iu;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SANDBOX_ERROR_PATTERN = /no usable sandbox|running as root without --no-sandbox|zygote.*sandbox|suid sandbox|user namespace|clone.*eperm|setuid_sandbox/i;

const STATIC_ASSET_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
});

// Strict CSP: zero JavaScript execution, zero external network or cross-port requests, local static assets & data URLs only.
export const RENDER_CSP = "sandbox allow-same-origin; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'self'";

const SHARE_CORE = create_share_core({
  t,
  display_name: (name) => name,
  collapse_visual_fences: (text, label) => String(text || '').replace(/```visual\b[\s\S]*?(?:```|$)/g, `[${label}]`),
  is_text_attachment: () => false,
});

export class ShareCardError extends Error {
  constructor(message, { code = 'invalid', ...details } = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Refuse share-card commands in tool-lockdown / external runs so restricted members cannot read local files or start browsers. */
export function assert_share_card_allowed(access = {}, env = process.env) {
  if (env.CODISCUSS_TOOL_LOCKDOWN === '1' || access?.tool_lockdown || access?.transport === 'external') {
    throw new ShareCardError(t('本次运行已收窄，不能使用 share-card 命令'), { code: 'lockdown' });
  }
}

function read_access_file(explicit_path = '', env = process.env) {
  const path = explicit_path || env.DISCUSS_ACCESS_FILE || '';
  if (path) {
    if (!existsSync(path)) {
      throw new ShareCardError(t('凭据文件不存在：{path}', { path }), { code: 'auth' });
    }
    try {
      const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
      return value;
    } catch {
      throw new ShareCardError(t('凭据文件不是有效的 JSON 对象'), { code: 'auth' });
    }
  }
  const inline = String(env.DISCUSS_ACCESS || '').trim();
  if (!inline) return {};
  try {
    const value = JSON.parse(inline);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value;
  } catch {
    throw new ShareCardError(t('DISCUSS_ACCESS 不是有效的 JSON 对象'), { code: 'auth' });
  }
}

function has_task_credential(access) {
  return Boolean(access && (access.site || access.token || access.room || access.member));
}

function normalize_site_url(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch {
    throw new ShareCardError(t('站点地址无效，请使用 http(s)://主机[:端口]，不带路径、凭据或查询'), { code: 'invalid_site' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new ShareCardError(t('站点地址无效，请使用 http(s)://主机[:端口]，不带路径、凭据或查询'), { code: 'invalid_site' });
  }
  return parsed.origin;
}

/**
 * Resolve target site and auth headers for `share-card materials`, matching `runner/discuss.py`:
 * - When a task credential is present, the target site MUST match the credential's bound site.
 * - Same room sends `X-Discussion-Token`; another room on the same bound site omits the token and sends `X-Discussion-Read-Only: 1`.
 */
export function resolve_materials_auth({ explicit_site = '', room_id = '', access = {}, env = process.env } = {}) {
  const bound = has_task_credential(access);
  const bound_site = access.site ? normalize_site_url(access.site) : '';
  const requested_raw = explicit_site || env.DISCUSS_URL || access.site || (!bound ? `http://127.0.0.1:${local_settings().port || 8765}` : '');
  const site = normalize_site_url(requested_raw);
  if (!site) {
    throw new ShareCardError(t('请用 --site、DISCUSS_URL 或任务凭据指定目标站点'), { code: 'invalid_site' });
  }
  if (!bound) return { site, headers: {}, cross_room: false };
  if (!bound_site || bound_site !== site) {
    throw new ShareCardError(t('凭据文件不属于本次站点'), { code: 'auth' });
  }
  if (access.room && room_id && room_id !== access.room) {
    return { site, headers: { [READ_ONLY_HEADER]: '1' }, cross_room: true };
  }
  const token = access.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new ShareCardError(t('凭据文件中的 token 无效'), { code: 'auth' });
  }
  return { site, headers: { 'X-Discussion-Token': token }, cross_room: false };
}

async function room_json(site, path, headers, fetcher) {
  const response = await fetcher(`${site}${path}`, { method: 'GET', headers, redirect: 'error' });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new ShareCardError(detail.error || t('读取房间数据失败（HTTP {status}）', { status: response.status }), {
      code: 'http_error', http_status: response.status, path,
    });
  }
  return response.json();
}

function compile_project_patterns(folders = []) {
  const known = [...new Set(folders.filter((item) => typeof item === 'string' && item.trim()))]
    .sort((a, b) => b.length - a.length);
  return known.map((folder) => SHARE_CORE.share_folder_pattern(folder)).filter(Boolean);
}

function collect_known_folders(room_entry, raw_objects = [], extra_folders = []) {
  const known = new Set(extra_folders.filter((item) => typeof item === 'string' && item.trim()));
  const config = room_entry?.config;
  if (config) {
    for (const dir of [config.cwd, config.workdir, ...(config.extra_directories || [])]) {
      if (typeof dir === 'string' && dir.trim()) known.add(dir);
    }
    for (const profile of Object.values(config.participants || {})) {
      if (typeof profile?.cwd === 'string' && profile.cwd.trim()) known.add(profile.cwd);
    }
  }
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cwd' && typeof item === 'string' && item.trim()) known.add(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  for (const obj of raw_objects) visit(obj);
  return [...known];
}

function scrub_paths(text, project_patterns = []) {
  const collapsed = String(text || '').replace(/```visual\b[\s\S]*?(?:```|$)/g, `[${t('交互式可视化')}]`);
  const without_project = project_patterns.reduce(
    (value, pattern) => value.replace(pattern, (match, separator) => (separator ? '' : t('项目目录'))),
    collapsed,
  );
  return SHARE_HOME_FOLDERS.reduce((value, pattern) => value.replace(pattern, () => '~'), without_project);
}

function plain_excerpt(text, limit = 240, project_patterns = []) {
  const cleaned = scrub_paths(text, project_patterns)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]+|~~+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function has_sensitive_text(text, project_patterns = []) {
  const value = scrub_paths(text, project_patterns);
  if (!value) return false;
  return SHARE_SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function file_kind(file_name) {
  return SHARE_FILE_KINDS.find(([, pattern]) => pattern.test(file_name || ''))?.[0] || 'text';
}

function safe_dest_filename(file_name) {
  const cleaned = basename(String(file_name || 'image.png'))
    .replace(/[^\p{L}\p{M}\p{N} ._-]/gu, '_')
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'image.png';
}

/** Pick the first substantive user request, reusing `is_share_question_receipt`; returns null when only receipts exist. */
function pick_opening_request(user_messages, project_patterns = []) {
  const substantive = user_messages.find((message) => {
    if (is_share_question_receipt(message.text)) return false;
    const body = plain_excerpt(message.text, 400, project_patterns);
    if (!body || SLASH_COMMAND.test(body)) return false;
    return !SHORT_ACK.test(body);
  });
  return substantive || null;
}

function build_curve_steps(steps, start_ms, span_ms, label_of, max_steps) {
  if (!steps.length || !span_ms) return { sampled: false, steps: [] };
  const map_step = (step) => ({
    start_ms: step.start,
    end_ms: step.end,
    from: Number(((step.start - start_ms) / span_ms).toFixed(5)),
    to: Number(((step.end - start_ms) / span_ms).toFixed(5)),
    total: step.total,
    members: step.members.map((entry) => ({ name: entry.member, label: label_of(entry.member), count: entry.count })),
  });
  if (steps.length <= max_steps) return { sampled: false, steps: steps.map(map_step) };
  // Bucket long multi-day rooms cleanly while preserving the peak concurrent member count per bucket.
  const bucket_ms = span_ms / max_steps;
  const sampled = [];
  for (let index = 0; index < max_steps; index += 1) {
    const b_start = Math.round(start_ms + index * bucket_ms);
    const b_end = index + 1 === max_steps ? start_ms + span_ms : Math.round(start_ms + (index + 1) * bucket_ms);
    let peak_step = null;
    for (const step of steps) {
      if (step.end <= b_start || step.start >= b_end) continue;
      if (!peak_step || step.total > peak_step.total) peak_step = step;
    }
    sampled.push({
      start_ms: b_start,
      end_ms: b_end,
      from: Number(((b_start - start_ms) / span_ms).toFixed(5)),
      to: Number(((b_end - start_ms) / span_ms).toFixed(5)),
      total: peak_step ? peak_step.total : 0,
      members: peak_step ? peak_step.members.map((entry) => ({ name: entry.member, label: label_of(entry.member), count: entry.count })) : [],
    });
  }
  return { sampled: true, steps: sampled };
}

function pick_highlights(messages, max_highlights) {
  const candidates = messages.filter((message) => message.kind !== 'system' && message.kind !== 'notice' && message.source !== 'notice' && message.text);
  if (candidates.length <= max_highlights) return candidates;
  const head_count = Math.max(2, Math.floor(max_highlights / 3));
  const tail_count = max_highlights - head_count;
  const head = candidates.slice(0, head_count);
  const tail = candidates.slice(-tail_count);
  const seen = new Set(head.map((item) => item.id));
  return [...head, ...tail.filter((item) => !seen.has(item.id))];
}

/**
 * Read shareable-scope collaboration metrics, concurrency curve, and material index for a room.
 *
 * @param {object} options Connection and shaping parameters.
 * @returns {Promise<object>} Structured share-card material bundle.
 */
export async function share_card_materials({
  site = '',
  room_id = '',
  token = '',
  access = {},
  headers = null,
  home = service_home(),
  folders = [],
  max_highlights = DEFAULT_HIGHLIGHTS,
  max_steps = DEFAULT_CURVE_STEPS,
  max_message_pages = MAX_MESSAGE_PAGES,
  max_timeline_pages = MAX_TIMELINE_PAGES,
  fetcher = site_fetch,
  env = process.env,
} = {}) {
  assert_share_card_allowed(access, env);
  const target_room = room_id || access?.room || '';
  if (!target_room || !/^[A-Za-z0-9_-]+$/.test(target_room)) {
    throw new ShareCardError(t('请提供有效的房间编号（可经 --room 或任务凭据自动补齐）'), { code: 'invalid_room' });
  }
  let resolved_site;
  let request_headers;
  if (has_task_credential(access)) {
    const auth = resolve_materials_auth({ explicit_site: site, room_id: target_room, access, env });
    resolved_site = auth.site;
    request_headers = auth.headers;
  } else {
    resolved_site = normalize_site_url(site || env.DISCUSS_URL || `http://127.0.0.1:${local_settings().port || 8765}`);
    request_headers = headers || (token ? { 'X-Discussion-Token': token } : {});
  }
  const base = `/api/rooms/${encodeURIComponent(target_room)}`;
  const room = await room_json(resolved_site, base, request_headers, fetcher);

  // Only executions whose linked messages appear in the visible transcript can contribute to the card.
  const visible_messages = [];
  const visible_ids = new Set();
  let messages_truncated = false;
  for (let after = 0, page = 0; ; page += 1) {
    if (page >= max_message_pages) { messages_truncated = true; break; }
    const query = new URLSearchParams({ limit: String(MESSAGES_PER_PAGE), cards: '1', after: String(after) });
    const batch = await room_json(resolved_site, `${base}/messages?${query}`, request_headers, fetcher);
    const items = batch.messages || [];
    for (const message of items) {
      if (message.withdrawn) continue;
      visible_messages.push(message);
      visible_ids.add(message.id);
    }
    if (!batch.has_more) break;
    const next_after = batch.next_after ?? items.at(-1)?.id;
    if (!items.length || !next_after || next_after <= after) { messages_truncated = true; break; }
    after = next_after;
  }
  visible_messages.sort((a, b) => a.id - b.id);

  // Read execution timeline (paginating backwards via `before` when `earlier` is true, up to `max_timeline_pages`).
  const by_exec_key = new Map();
  let now_ms = Date.now();
  let timeline_truncated = false;
  let timeline_pages_read = 0;
  for (let before = 0, page = 0; ; page += 1) {
    if (page >= max_timeline_pages) { timeline_truncated = true; break; }
    const query = new URLSearchParams({ segments: '0', ...(before ? { before: String(before) } : {}) });
    const timeline = await room_json(resolved_site, `${base}/timeline?${query}`, request_headers, fetcher);
    timeline_pages_read += 1;
    if (page === 0 && timeline.now) now_ms = timeline.now * 1000;
    const rows = timeline.executions || [];
    let min_id = Infinity;
    for (const execution of rows) {
      if (execution.source === 'external') continue;
      if (execution.id < min_id) min_id = execution.id;
      const linked_ids = [execution.task_id, execution.request_message_id, execution.answer_id].filter(Boolean);
      if (linked_ids.some(id => !visible_ids.has(id)) || (messages_truncated && !linked_ids.length)) continue;
      const key = `${execution.source}:${execution.id}`;
      if (!by_exec_key.has(key)) by_exec_key.set(key, execution);
    }
    if (!timeline.earlier || !rows.length || !Number.isFinite(min_id) || (before && min_id >= before)) break;
    before = min_id;
  }

  let sites = [];
  try {
    const site_data = await room_json(resolved_site, `${base}/sites`, request_headers, fetcher);
    sites = (site_data.sites || [])
      .filter((item) => item.status === 'active')
      .map((item) => ({ site_id: item.site_id, title: item.title || '', url: item.url, status: item.status, expires_at: item.expires_at || '' }));
  } catch { /* Sites endpoint is optional on older or minimal servers. */ }

  let share_link = null;
  try {
    const directory = await room_json(resolved_site, '/api/rooms', request_headers, fetcher);
    const listed = (directory.rooms || []).find((item) => item.id === target_room);
    if (listed?.share_link?.url) {
      share_link = { url: listed.share_link.url, expires_at: listed.share_link.expires_at || '' };
    }
  } catch { /* Directory lookup is optional when reading minimal endpoints. */ }

  const room_entry = find_room_config(home, target_room, resolved_site);
  const project_patterns = compile_project_patterns(collect_known_folders(room_entry, [room, [...by_exec_key.values()]], folders));

  const members = (room.members || []).filter((member) => member.status !== 'removed');
  const label_map = new Map(members.map((member) => [member.name, member.label || member.name]));
  const role_map = new Map(members.map((member) => [member.name, member.role || 'member']));
  const label_of = (name) => label_map.get(name) || name;

  const executions = [...by_exec_key.values()];
  const collab = collaboration_metrics(executions, now_ms);
  const { model } = collab;
  const span_ms = collab.span_ms;
  const { sampled, steps } = build_curve_steps(model.steps, model.start, span_ms, label_of, max_steps);

  const user_messages = visible_messages.filter((message) => message.author === '用户' && message.text);
  const opening = pick_opening_request(user_messages, project_patterns);
  const latest_user = user_messages.at(-1) || null;
  const format_user_msg = (message) => {
    if (!message) return null;
    const sensitive = has_sensitive_text(message.text, project_patterns);
    return {
      id: message.id,
      created_at: message.created_at || '',
      sensitive_flagged: sensitive,
      text: sensitive ? '' : plain_excerpt(message.text, 360, project_patterns),
    };
  };

  const highlights = pick_highlights(visible_messages, max_highlights).map((message) => {
    const raw_text = message.text || '';
    const raw_summary = message.summary || '';
    const sensitive = has_sensitive_text(raw_text, project_patterns) || has_sensitive_text(raw_summary, project_patterns);
    return {
      id: message.id,
      author: message.author,
      author_label: message.author_label || label_of(message.author),
      role: message.author === '用户' ? 'user' : (role_map.get(message.author) || 'member'),
      created_at: message.created_at || '',
      sensitive_flagged: sensitive,
      summary: sensitive ? '' : plain_excerpt(raw_summary, 200, project_patterns),
      excerpt: sensitive ? '' : plain_excerpt(raw_text, 280, project_patterns),
      attachment_count: (message.attachments || []).length,
    };
  });

  const attachments = [];
  const images = [];
  const kind_counts = new Map();
  for (const message of visible_messages) {
    for (const file of message.attachments || []) {
      const kind = file_kind(file.file_name);
      const size = Number(file.size) || 0;
      const entry = {
        id: file.id,
        message_id: message.id,
        author: message.author_label || label_of(message.author),
        created_at: message.created_at || '',
        file_name: file.file_name,
        kind,
        size,
        content_type: String(file.content_type || '').split(';')[0].trim(),
      };
      attachments.push(entry);
      const group = kind_counts.get(kind) || { kind, count: 0, bytes: 0 };
      group.count += 1;
      group.bytes += size;
      kind_counts.set(kind, group);
      if (kind === 'image' || entry.content_type.startsWith('image/')) {
        const dest_name = safe_dest_filename(file.file_name);
        images.push({
          ...entry,
          suggested_file_name: dest_name,
          download_command: /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(file.id)
            ? `codiscuss attachment download ${target_room} ${file.id} --dest "./${dest_name}"` : null,
        });
      }
    }
  }
  images.sort((a, b) => b.message_id - a.message_id);

  return {
    room: {
      id: room.id || target_room,
      title: room.title || '',
      goal: has_sensitive_text(room.goal, project_patterns) ? '' : plain_excerpt(room.goal || '', 360, project_patterns),
      created_at: room.created_at || '',
      message_count: visible_messages.length,
      members: members.map((member) => ({
        name: member.name,
        label: member.label || member.name,
        role: member.role || 'member',
        adapter: member.adapter || '',
      })),
    },
    scope: {
      shareable_only: true,
      withdrawn_excluded: true,
      external_executions_excluded: true,
      messages_truncated,
      timeline_truncated,
      truncated: messages_truncated || timeline_truncated,
      curve_sampled: sampled,
      timeline_pages_read,
      max_messages: max_message_pages * MESSAGES_PER_PAGE,
      max_timeline_pages,
      note: t('统计按可分享范围计算：排除已撤回消息及其关联执行和外部执行，并按分页回溯历史时间线；网页“并发全景”默认仅展示最近 100 次且不剔除撤回执行，两者数字可能略有差异。'),
    },
    metrics: {
      span_ms: collab.span_ms,
      span_text: collab.span_text,
      busy_ms: collab.busy_ms,
      busy_text: collab.busy_text,
      busy_percent: collab.busy_percent,
      idle_ms: collab.idle_ms,
      idle_text: collab.idle_text,
      runs: collab.runs,
      self_started: collab.self_started,
      self_started_percent: collab.self_started_percent,
      peak_concurrency: collab.peak_concurrency,
      unattended: collab.unattended,
      active_members: collab.member_totals.map((entry) => ({
        name: entry.member,
        label: label_of(entry.member),
        runs: entry.runs,
        work_ms: entry.work_ms,
        work_text: entry.work_text,
      })),
    },
    concurrency_curve: {
      start_ms: model.start,
      end_ms: model.end,
      span_ms,
      peak: model.peak,
      sampled,
      members: model.members.map((name, index) => ({ name, label: label_of(name), color_index: index })),
      steps,
      idle_gaps: model.idle.map((gap) => ({
        start_ms: gap.start,
        end_ms: gap.end,
        from: span_ms ? Number(((gap.start - model.start) / span_ms).toFixed(5)) : 0,
        to: span_ms ? Number(((gap.end - model.start) / span_ms).toFixed(5)) : 0,
        duration_ms: gap.end - gap.start,
        duration_text: format_duration(gap.end - gap.start),
      })),
      tasks: model.tasks.map((task) => ({
        key: task.key,
        label: has_sensitive_text(task.task, project_patterns) ? '' : plain_excerpt(task.task, 120, project_patterns),
        opened: task.opened,
        start_ms: task.start,
        end_ms: task.end,
        from: span_ms ? Number(((task.start - model.start) / span_ms).toFixed(5)) : 0,
        to: span_ms ? Number(((task.end - model.start) / span_ms).toFixed(5)) : 0,
        duration_ms: task.end - task.start,
        duration_text: format_duration(task.end - task.start),
      })),
    },
    materials: {
      opening_request: format_user_msg(opening),
      latest_user_message: format_user_msg(latest_user),
      total_messages: visible_messages.length,
      highlights,
      images,
      attachments_by_kind: [...kind_counts.values()],
      attachments,
      sites,
      share_link,
    },
    cover_spec: {
      ...SHARE_CARD_COVER_SPEC,
      note: t('分享面板会自动在封面下方拼接统一的扫码底栏（二维码、域名和最新有效期），并可吸取封面底边颜色；封面 HTML 中请勿绘制二维码、分享链接或有效期。'),
    },
    copy_spec: {
      fence: 'share-copy',
      share_url_placeholder: '{{share_url}}',
      note: t('在提交封面 PNG 的同一条消息里，用 ```share-copy 代码块附上配套社交平台分享文案（标题、正文亮点、已上线产品链接、完整协作记录链接和标签）。若 share_link 为空，用 {{share_url}} 占位，分享面板选中该封面时会自动填入真实分享链接。'),
    },
  };
}

// ---- Member file-permission boundaries for `share-card render` ----

function normalize_for_compare(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function is_same_or_inside(root_dir, target_path) {
  const root = normalize_for_compare(root_dir);
  const target = normalize_for_compare(target_path);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function overlapping_dirs(left, right) {
  if (!left || !right) return false;
  return is_same_or_inside(left, right) || is_same_or_inside(right, left);
}

/** Resolve a path that may not exist yet by calling `realpathSync` on its nearest existing ancestor. */
function resolve_future_real_path(target_path) {
  const abs = resolve(target_path);
  if (existsSync(abs)) return realpathSync(abs);
  const parts = [];
  let current = abs;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return abs;
    parts.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...parts);
}

function find_room_config(home, room_id, site = '') {
  if (!room_id || !home) return null;
  const normalized_site = site ? site.replace(/\/+$/, '') : '';
  for (const config_path of read_registry(home)) {
    try {
      const { config } = configuration_snapshot(config_path);
      if (config.room !== room_id) continue;
      if (normalized_site && config.site && config.site.replace(/\/+$/, '') !== normalized_site) continue;
      return { config, config_path };
    } catch { /* Ignore unreadable configs. */ }
  }
  return null;
}

function member_hash_dir(name) {
  return createHash('sha256').update(String(name)).digest('hex').slice(0, 16);
}

function service_drafts_dir(home, runtime_dir) {
  const key = createHash('sha256').update(resolve(runtime_dir)).digest('hex');
  return join(drafts_root(home), key);
}

function push_real_dir(list, dir) {
  if (!dir) return;
  try {
    const real = existsSync(dir) ? realpathSync(dir) : resolve_future_real_path(dir);
    if (existsSync(real) && !statSync(real).isDirectory()) return;
    if (!list.some((item) => normalize_for_compare(item) === normalize_for_compare(real))) list.push(real);
  } catch { /* Ignore invalid directory. */ }
}

/**
 * Resolve the allowed read and write roots for a member task calling `share-card render`, using the real on-disk
 * launch config format (`data_directory`, stable participant key, and effective `project_access` including `auto`).
 * Returns `null` only when no task credential is present (plain manual CLI invocation by the computer owner).
 */
export function resolve_member_render_roots(access = {}, home = service_home()) {
  if (!has_task_credential(access)) return null;
  const read_roots = [];
  const write_roots = [];
  const found = find_room_config(home, access.room, access.site);
  if (!found) {
    if (access.draft_directory) {
      push_real_dir(read_roots, access.draft_directory);
      push_real_dir(write_roots, access.draft_directory);
      return { read_roots, write_roots };
    }
    throw new ShareCardError(t('无法确认成员的文件权限，已拒绝渲染'), { code: 'auth' });
  }

  const { config, config_path } = found;
  const member_name = typeof access.member === 'string' ? access.member : '';
  const participants = config.participants || {};
  if (member_name && !Object.hasOwn(participants, member_name)) {
    throw new ShareCardError(t('凭据中的成员不在房间配置内，已拒绝渲染'), { code: 'auth' });
  }
  const profile = member_name ? participants[member_name] : null;

  // Match runner/discussion_runner.mjs:96: real configs store `data_directory` (with `directory` only added in memory).
  const runtime_dir = resolve(config.data_directory || config.directory || join(dirname(resolve(config_path)), `discussion-${config.room}`));

  // Every member may read/write inside its own drafts folder, and read (not write) its own runtime folder (attachments).
  if (member_name) {
    const hash = member_hash_dir(member_name);
    const draft_bases = [config.draft_directory || (home ? service_drafts_dir(home, runtime_dir) : `${runtime_dir}-drafts`)];
    const legacy_drafts = `${runtime_dir}-drafts`;
    if (!config.draft_directory && existsSync(legacy_drafts)) draft_bases.push(legacy_drafts);
    for (const draft_base of draft_bases) {
      const own_drafts = join(draft_base, hash);
      push_real_dir(read_roots, own_drafts);
      push_real_dir(write_roots, own_drafts);
    }
    const own_runtime = join(runtime_dir, 'members', hash);
    if (existsSync(own_runtime)) push_real_dir(read_roots, own_runtime);
  } else if (access.draft_directory) {
    push_real_dir(read_roots, access.draft_directory);
    push_real_dir(write_roots, access.draft_directory);
  }

  // Project directories obey effective `project_access` (read | write | auto | full | own | none) and adapter capability.
  const project_access = profile?.project_access || config.project_access || 'read';
  const adapter_allows_project = !profile?.adapter || adapter_capabilities(profile.adapter).project !== false;
  if (project_access !== 'none' && adapter_allows_project) {
    const room_cwd = config.cwd || config.workdir || '';
    const member_cwd = profile?.cwd ?? room_cwd;
    const can_write_main = ['write', 'auto', 'full', 'own'].includes(project_access);
    if (member_cwd && existsSync(member_cwd)) {
      push_real_dir(read_roots, member_cwd);
      if (can_write_main) push_real_dir(write_roots, member_cwd);
    }
    const outside_room = Boolean(room_cwd && member_cwd && !overlapping_dirs(room_cwd, member_cwd));
    const can_write_extra = !outside_room && can_write_main;
    const all_room_dirs = [room_cwd, ...(config.extra_directories || [])].filter(Boolean);
    for (const dir of all_room_dirs) {
      if ((member_cwd && overlapping_dirs(dir, member_cwd)) || !existsSync(dir)) continue;
      push_real_dir(read_roots, dir);
      if (can_write_extra) push_real_dir(write_roots, dir);
    }
  }

  if (!read_roots.length || !write_roots.length) {
    throw new ShareCardError(t('无法确认成员的文件权限，已拒绝渲染'), { code: 'auth' });
  }
  return { read_roots, write_roots };
}

function assert_path_within(roots, target_path, message) {
  if (!roots) return;
  if (!roots.some((root) => is_same_or_inside(root, target_path))) {
    throw new ShareCardError(message, { code: 'auth' });
  }
}

// ---- Trusted local Chromium-family browser discovery ----

/**
 * Locate an installed Chromium-family browser (Edge / Chrome / Chromium / Brave) strictly from trusted OS installation
 * locations — never from user-supplied CLI flags, `PATH`, or user-writable AppData folders.
 *
 * @param {object} [options] Optional platform/env/fs overrides for unit tests.
 * @returns {string} Absolute path to a trusted installed browser, or '' when none is found.
 */
export function find_browser({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  is_file = (path) => { try { return statSync(path).isFile(); } catch { return false; } },
} = {}) {
  const candidates = platform === 'win32' ? [
    join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.ProgramFiles || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ] : platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ] : [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
    '/usr/lib/chromium/chromium',
    '/usr/lib/chromium-browser/chromium-browser',
  ];
  for (const path of candidates) {
    if (path && exists(path) && is_file(path)) return path;
  }
  return '';
}

/** Build Chromium launch arguments: private `--remote-debugging-pipe` (zero TCP port), OS sandbox kept, profile isolated. */
export function browser_render_args(profile_dir, { scale = 2 } = {}) {
  return [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--mute-audio',
    `--user-data-dir=${profile_dir}`,
    `--force-device-scale-factor=${scale}`,
    '--remote-debugging-pipe',
    'about:blank',
  ];
}

function parse_hex_color(value) {
  const match = HEX_COLOR.exec(String(value || '').trim());
  if (!match) {
    throw new ShareCardError(t('背景色必须是 6 位十六进制颜色，例如 #12141c'), { code: 'invalid_option', option: 'background' });
  }
  const hex = match[1];
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
}

function parse_png_dimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ShareCardError(t('浏览器未输出有效的 PNG 图片'), { code: 'render_failed' });
  }
  return { width_px: buffer.readUInt32BE(16), height_px: buffer.readUInt32BE(20) };
}

function is_inside_dir(base_dir, target_path) {
  const rel = relative(base_dir, target_path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Serve one local static HTML file and allowlisted static assets inside its own directory over loopback with strict CSP.
 */
async function start_static_render_server(html_file, read_roots = null) {
  const html_real = realpathSync(html_file);
  const base_dir = realpathSync(dirname(html_real));
  const html_body = readFileSync(html_real);
  const token = randomBytes(16).toString('hex');
  const prefix = `/${token}/`;
  const headers_base = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  const server = createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, headers_base); res.end(); return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400, headers_base); res.end(); return;
      }
      if (!pathname.startsWith(prefix)) {
        res.writeHead(404, headers_base); res.end(); return;
      }
      const rel = pathname.slice(prefix.length);
      if (!rel || rel === 'index.html') {
        res.writeHead(200, { ...headers_base, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': RENDER_CSP });
        res.end(req.method === 'HEAD' ? undefined : html_body);
        return;
      }
      if (rel.includes('\0') || rel.startsWith('/') || rel.split('/').includes('..')) {
        res.writeHead(403, headers_base); res.end(); return;
      }
      const ext = extname(rel).toLowerCase();
      const mime = STATIC_ASSET_TYPES[ext];
      if (!mime) {
        res.writeHead(403, headers_base); res.end(); return;
      }
      const candidate = resolve(base_dir, rel);
      if (!existsSync(candidate)) {
        res.writeHead(404, headers_base); res.end(); return;
      }
      let resolved_asset;
      try { resolved_asset = realpathSync(candidate); } catch { res.writeHead(404, headers_base); res.end(); return; }
      if (!is_inside_dir(base_dir, resolved_asset) || !statSync(resolved_asset).isFile()) {
        res.writeHead(403, headers_base); res.end(); return;
      }
      if (read_roots && !read_roots.some((root) => is_same_or_inside(root, resolved_asset))) {
        res.writeHead(403, headers_base); res.end(); return;
      }
      res.writeHead(200, { ...headers_base, 'Content-Type': mime });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(resolved_asset));
    } catch {
      if (!res.headersSent) res.writeHead(500, headers_base);
      res.end();
    }
  });
  await new Promise((resolve_ready, reject_ready) => {
    server.once('error', reject_ready);
    server.listen(0, '127.0.0.1', resolve_ready);
  });
  const { port } = server.address();
  const prefix_url = `http://127.0.0.1:${port}${prefix}`;
  return {
    prefix_url,
    url: `${prefix_url}index.html`,
    close: () => new Promise((done) => server.close(() => done())),
  };
}

/** Check whether a request URL inside the headless render page stays within the ephemeral static server or inline data. */
export function is_allowed_render_url(url, prefix_url) {
  const value = String(url || '');
  return value === 'about:blank' || value.startsWith(prefix_url) || value.startsWith('data:');
}

/** Translate Chromium startup/exit diagnostics into a clear error, explicitly surfacing OS sandbox unavailability. */
export function classify_browser_exit_error(code, stderr_text = '') {
  if (SANDBOX_ERROR_PATTERN.test(stderr_text)) {
    return new ShareCardError(
      t('本机浏览器的操作系统沙箱不可用（例如 Linux 以 root 运行或禁用了 user namespace），出于安全要求不会关闭沙箱；请改用启用沙箱的普通用户重试，或直接提供 PNG/JPG/WebP 图片。'),
      { code: 'browser_sandbox_unavailable', stderr: stderr_text.slice(-400) },
    );
  }
  return new ShareCardError(t('本地浏览器提前退出（退出码 {code}）', { code: code ?? t('未知') }), {
    code: 'browser_launch_failed',
    stderr: stderr_text.slice(-400),
  });
}

/** Process-private CDP JSON-RPC transport over Chromium's `--remote-debugging-pipe` (fd 3 write, fd 4 read, NUL-delimited). */
class CdpPipeSession {
  constructor(writer, reader, timeout_ms) {
    this.writer = writer;
    this.reader = reader;
    this.timeout_ms = timeout_ms;
    this.next_id = 1;
    this.pending = new Map();
    this.waiters = new Set();
    this.listeners = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    this.reader.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const zero = this.buffer.indexOf(0);
        if (zero < 0) break;
        const raw = this.buffer.subarray(0, zero).toString('utf8');
        this.buffer = this.buffer.subarray(zero + 1);
        this.handle_message(raw);
      }
    });
    this.writer.on('error', () => {});
    this.reader.on('error', () => {});
  }

  handle_message(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new ShareCardError(msg.error.message || t('浏览器渲染命令失败'), { code: 'render_failed' }));
      else entry.resolve(msg.result || {});
    } else if (msg.method && this.listeners.has(msg.method)) {
      for (const handler of [...this.listeners.get(msg.method)]) handler(msg.params || {}, msg.sessionId || '');
    }
  }

  send(method, params = {}, session_id = '') {
    if (this.closed) return Promise.reject(new ShareCardError(t('浏览器连接已关闭'), { code: 'render_failed' }));
    const id = this.next_id++;
    return new Promise((resolve_cmd, reject_cmd) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject_cmd(new ShareCardError(t('浏览器渲染步骤超时：{method}', { method }), { code: 'render_timeout' }));
      }, this.timeout_ms);
      timer.unref();
      this.pending.set(id, { resolve: resolve_cmd, reject: reject_cmd, timer });
      const payload = session_id ? { id, method, params, sessionId: session_id } : { id, method, params };
      try {
        this.writer.write(`${JSON.stringify(payload)}\0`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject_cmd(new ShareCardError(t('向本地浏览器发送渲染指令失败：{reason}', { reason: error.message }), { code: 'render_failed' }));
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.listeners.get(method)?.delete(handler);
  }

  wait_for(method, expected_session = '') {
    if (this.closed) return Promise.reject(new ShareCardError(t('浏览器连接已关闭'), { code: 'render_failed' }));
    return new Promise((resolve_evt, reject_evt) => {
      const cleanup = () => {
        clearTimeout(timer);
        off();
        this.waiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject_evt(new ShareCardError(t('等待页面加载完成超时'), { code: 'render_timeout' }));
      }, this.timeout_ms);
      timer.unref();
      const off = this.on(method, (params, session_id) => {
        if (expected_session && session_id !== expected_session) return;
        cleanup();
        resolve_evt(params);
      });
      const waiter = { reject: (error) => { cleanup(); reject_evt(error); } };
      this.waiters.add(waiter);
    });
  }

  fail_all(error) {
    this.closed = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of [...this.waiters]) waiter.reject(error);
    this.waiters.clear();
  }

  close() {
    this.fail_all(new ShareCardError(t('浏览器连接已关闭'), { code: 'render_failed' }));
    try { this.writer.end(); } catch { /* Already closed. */ }
    try { this.reader.destroy(); } catch { /* Already closed. */ }
  }
}

async function wait_child_exit(child, timeout_ms = 2000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done) => {
    const timer = setTimeout(done, timeout_ms);
    timer.unref();
    child.once('close', () => { clearTimeout(timer); done(); });
  });
}

async function remove_dir_quiet(path) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(path, { recursive: true, force: true }); return; }
    catch { await delay(80 * (attempt + 1)); }
  }
}

/**
 * Render a local static HTML file into a PNG cover image via a sandboxed, profile-isolated trusted local browser
 * controlled over process-private `--remote-debugging-pipe` (zero TCP listening port).
 *
 * @param {object} options Rendering parameters.
 * @returns {Promise<object>} Export receipt with output path, CSS/pixel dimensions, byte size, and browser path.
 */
export async function render_share_card_html({
  html_path,
  out_path,
  width = SHARE_CARD_COVER_SPEC.width_css_px,
  height = null,
  max_height = SHARE_CARD_COVER_SPEC.max_height_css_px,
  scale = SHARE_CARD_COVER_SPEC.scale,
  background = SHARE_CARD_COVER_SPEC.default_background,
  access = {},
  home = service_home(),
  timeout_ms = DEFAULT_RENDER_TIMEOUT_MS,
  env = process.env,
  spawner = spawn,
  browser_resolver = () => find_browser({ env }),
  capture_override = null,
} = {}) {
  assert_share_card_allowed(access, env);
  if (!html_path) throw new ShareCardError(t('请指定要导出的本地 HTML 文件路径'), { code: 'invalid_option' });
  if (!out_path) throw new ShareCardError(t('请通过 --out 指定输出 PNG 文件路径'), { code: 'invalid_option' });

  const member_roots = resolve_member_render_roots(access, home);
  const resolved_html = resolve(html_path);
  if (!existsSync(resolved_html) || !statSync(resolved_html).isFile()) {
    throw new ShareCardError(t('HTML 文件不存在：{path}', { path: html_path }), { code: 'file_not_found' });
  }
  const real_html = realpathSync(resolved_html);
  assert_path_within(member_roots?.read_roots, real_html, t('无权读取该 HTML 文件：路径超出成员允许的目录范围'));

  const resolved_out = resolve_future_real_path(out_path);
  assert_path_within(member_roots?.write_roots, resolved_out, t('无权写入该输出路径：请输出到成员有写权限的目录或自己的草稿目录'));

  const file_size = statSync(real_html).size;
  if (file_size > MAX_HTML_BYTES) {
    throw new ShareCardError(t('HTML 文件超过 10 MiB 上限，无法导出'), { code: 'file_too_large' });
  }

  const parsed_width = Number(width);
  const parsed_max_height = Number(max_height);
  const parsed_scale = Number(scale);
  const parsed_height = height === null || height === undefined || height === '' ? null : Number(height);
  if (!Number.isInteger(parsed_width) || parsed_width < MIN_WIDTH_PX || parsed_width > MAX_WIDTH_PX) {
    throw new ShareCardError(t('宽度须为 {min}–{max} 之间的整数像素', { min: MIN_WIDTH_PX, max: MAX_WIDTH_PX }), { code: 'invalid_option' });
  }
  if (!Number.isInteger(parsed_max_height) || parsed_max_height < SHARE_CARD_COVER_SPEC.min_height_css_px || parsed_max_height > HARD_MAX_HEIGHT_PX) {
    throw new ShareCardError(t('最大高度须为 {min}–{max} 之间的整数像素', { min: SHARE_CARD_COVER_SPEC.min_height_css_px, max: HARD_MAX_HEIGHT_PX }), { code: 'invalid_option' });
  }
  if (parsed_height !== null && (!Number.isInteger(parsed_height) || parsed_height < SHARE_CARD_COVER_SPEC.min_height_css_px || parsed_height > parsed_max_height)) {
    throw new ShareCardError(t('高度须为 {min}–{max} 之间的整数像素', { min: SHARE_CARD_COVER_SPEC.min_height_css_px, max: parsed_max_height }), { code: 'invalid_option' });
  }
  if (!Number.isFinite(parsed_scale) || parsed_scale < 1 || parsed_scale > 3) {
    throw new ShareCardError(t('缩放倍率（--scale）须在 1 到 3 之间'), { code: 'invalid_option' });
  }
  const bg_color = parse_hex_color(background);

  const browser_path = browser_resolver();
  if (!browser_path) {
    throw new ShareCardError(t('未在系统可信安装位置找到可用的本地浏览器（Edge / Chrome / Chromium），无法将 HTML 导出为 PNG。请安装 Edge、Chrome 或 Chromium；也可以直接提供 PNG/JPG/WebP 图片。'), {
      code: 'browser_missing',
    });
  }

  const work_dir = mkdtempSync(join(tmpdir(), 'codiscuss-share-card-'));
  const profile_dir = join(work_dir, 'profile');
  let server = null;
  let child = null;
  let pipe = null;
  try {
    mkdirSync(profile_dir, { recursive: true, mode: 0o700 });
    server = await start_static_render_server(real_html, member_roots?.read_roots || null);
    const args = browser_render_args(profile_dir, { scale: parsed_scale });
    let png_buffer;
    let final_height;
    let measured_height;
    if (capture_override) {
      const captured = await capture_override({
        browser_path, args, profile_dir, url: server.url, prefix_url: server.prefix_url,
        width: parsed_width, height: parsed_height, max_height: parsed_max_height, scale: parsed_scale, bg_color,
      });
      png_buffer = captured.png;
      measured_height = captured.measured_height;
      final_height = captured.final_height;
    } else {
      let stderr_buf = '';
      child = spawner(browser_path, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      });
      child.stderr?.on('data', (chunk) => {
        stderr_buf = (stderr_buf + chunk.toString('utf8')).slice(-4096);
      });
      pipe = new CdpPipeSession(child.stdio[3], child.stdio[4], timeout_ms);
      child.once('error', (error) => {
        pipe.fail_all(new ShareCardError(t('无法启动本地浏览器：{reason}', { reason: error.message }), { code: 'browser_launch_failed' }));
      });
      child.once('close', (code) => {
        if (!pipe.closed) pipe.fail_all(classify_browser_exit_error(code, stderr_buf));
      });

      const { targetId } = await pipe.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await pipe.send('Target.attachToTarget', { targetId, flatten: true });
      await pipe.send('Page.enable', {}, sessionId);
      // Intercept every request (including top-level navigations such as meta refresh) and allow only our static token URL or data:.
      await pipe.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);
      pipe.on('Fetch.requestPaused', (params, event_session) => {
        if (event_session !== sessionId) return;
        const req_url = params.request?.url || '';
        if (is_allowed_render_url(req_url, server.prefix_url)) {
          pipe.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => {});
        } else {
          pipe.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {});
        }
      });

      const initial_height = parsed_height || Math.min(900, parsed_max_height);
      await pipe.send('Emulation.setDeviceMetricsOverride', {
        width: parsed_width, height: initial_height, deviceScaleFactor: parsed_scale, mobile: false,
      }, sessionId);
      await pipe.send('Emulation.setDefaultBackgroundColorOverride', { color: bg_color }, sessionId);

      const loaded = pipe.wait_for('Page.loadEventFired', sessionId);
      loaded.catch(() => {});
      await pipe.send('Page.navigate', { url: server.url }, sessionId);
      await loaded;

      const metrics = await pipe.send('Page.getLayoutMetrics', {}, sessionId);
      measured_height = Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || initial_height);
      final_height = parsed_height ?? Math.min(parsed_max_height, Math.max(SHARE_CARD_COVER_SPEC.min_height_css_px, measured_height));
      if (final_height !== initial_height) {
        await pipe.send('Emulation.setDeviceMetricsOverride', {
          width: parsed_width, height: final_height, deviceScaleFactor: parsed_scale, mobile: false,
        }, sessionId);
      }
      const shot = await pipe.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        clip: { x: 0, y: 0, width: parsed_width, height: final_height, scale: 1 },
      }, sessionId);
      png_buffer = Buffer.from(shot.data || '', 'base64');

      await pipe.send('Browser.close').catch(() => {});
      await wait_child_exit(child, 2000);
    }

    const { width_px, height_px } = parse_png_dimensions(png_buffer);
    mkdirSync(dirname(resolved_out), { recursive: true });
    writeFileSync(resolved_out, png_buffer);

    return {
      output: resolved_out,
      width_css_px: parsed_width,
      height_css_px: final_height,
      measured_height_css_px: measured_height,
      width_px,
      height_px,
      scale: parsed_scale,
      bytes: png_buffer.length,
      clipped: parsed_height === null && measured_height > parsed_max_height,
      browser: browser_path,
    };
  } finally {
    pipe?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      kill_process_tree(child, () => { try { child.kill(); } catch { /* Already exited. */ } });
      await wait_child_exit(child, 1500);
    }
    await server?.close().catch(() => {});
    await remove_dir_quiet(work_dir);
  }
}

export const SHARE_CARD_CLI_HELP = () => t(`AI CoDiscuss 分享卡封面工具

用法：
  codiscuss share-card materials [房间ID] [--site URL] [--access-file FILE] [--max-highlights N] [--max-steps N]
  codiscuss share-card render <HTML文件> --out <PNG文件> [--width 750] [--height N] [--max-height 1500] [--scale 2] [--background #12141c]

子命令：
  materials             按可分享范围读取房间的协作指标、并发曲线与必要素材索引（排除已撤回消息、私聊与敏感片段，输出截断标记）
  render                使用系统可信安装位置的隔离沙箱浏览器（进程私有控制通道、无 TCP 调试端口）将本地静态 HTML 导出为高清 PNG 封面图

选项：
  --room ROOM           目标房间编号（省略时取凭据绑定的房间；传其他房间编号可跨房间只读取材）
  --site, --url SITE    站点地址（带任务凭据时须与凭据绑定站点一致）
  --access-file FILE    任务凭据文件（默认读取 DISCUSS_ACCESS_FILE）
  --max-highlights N    返回的代表发言索引上限（默认 12）
  --max-steps N         并发曲线最大时间步数（默认 240，超出时按峰值采样）
  --out, -o FILE        render 输出的 PNG 路径（持任务凭据时须在允许写入的目录或自己的草稿目录内；本机房主手动运行时沿用当前账号文件权限）
  --width N             render CSS 宽度（像素，默认 750，范围 320–1500）
  --height N            render 固定 CSS 高度（省略时按内容自适应）
  --max-height N        render 最大 CSS 高度（默认 1500，范围 200–2400）
  --scale N             render 像素倍率（默认 2，750×2 = 1500px 宽）
  --background HEX      render 默认底色（默认 #12141c）
  --json                以 JSON 输出（默认）
  -h, --help            显示帮助
`);

/** CLI entrypoint for `codiscuss share-card <subcommand>`. */
export async function share_card_cli(args, { home = service_home(), fetcher = site_fetch, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        room: { type: 'string' },
        site: { type: 'string' },
        url: { type: 'string' },
        'access-file': { type: 'string' },
        'max-highlights': { type: 'string' },
        'max-steps': { type: 'string' },
        file: { type: 'string' },
        out: { type: 'string', short: 'o' },
        width: { type: 'string' },
        height: { type: 'string' },
        'max-height': { type: 'string' },
        scale: { type: 'string' },
        background: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (error) {
    stderr.write(`${JSON.stringify({ ok: false, error: { message: error.message, code: 'invalid_option' } }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const sub = positionals[0] || '';
  if (values.help || !sub || sub === 'help') {
    stdout.write(SHARE_CARD_CLI_HELP());
    return;
  }
  try {
    const access = read_access_file(values['access-file'], env);
    assert_share_card_allowed(access, env);
    let data;
    if (sub === 'materials') {
      const room_id = values.room || positionals[1] || access.room || '';
      const max_highlights = values['max-highlights'] ? Math.max(1, Math.min(100, Number(values['max-highlights']) || DEFAULT_HIGHLIGHTS)) : DEFAULT_HIGHLIGHTS;
      const max_steps = values['max-steps'] ? Math.max(10, Math.min(1000, Number(values['max-steps']) || DEFAULT_CURVE_STEPS)) : DEFAULT_CURVE_STEPS;
      data = await share_card_materials({
        site: values.site || values.url || '',
        room_id,
        access,
        home,
        max_highlights,
        max_steps,
        fetcher,
        env,
      });
    } else if (sub === 'render') {
      const html_path = values.file || positionals[1] || '';
      data = await render_share_card_html({
        html_path,
        out_path: values.out || '',
        width: values.width ?? SHARE_CARD_COVER_SPEC.width_css_px,
        height: values.height ?? null,
        max_height: values['max-height'] ?? SHARE_CARD_COVER_SPEC.max_height_css_px,
        scale: values.scale ?? SHARE_CARD_COVER_SPEC.scale,
        background: values.background ?? SHARE_CARD_COVER_SPEC.default_background,
        access,
        home,
        env,
      });
    } else {
      throw new ShareCardError(t('未知子命令：{sub}；运行 codiscuss share-card --help 查看用法', { sub }), { code: 'unknown_subcommand' });
    }
    stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  } catch (error) {
    const payload = {
      ok: false,
      error: {
        message: error.message,
        code: error.code || 'error',
        ...(error.details || {}),
      },
    };
    stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  }
}

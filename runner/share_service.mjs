/** Durable share jobs owned by the existing local discussion service. Only summaries leave the computer. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, watch } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { t as translate } from './i18n.mjs';
import { project_media, room_directories } from './project_files.mjs';
import { create_share_core, share_fingerprint, SHARE_DAYS, SHARE_DEFAULT_DAYS, SHARE_FORMAT, SHARE_MAX_BYTES, SHARE_SITE, SHARE_SITE_FILE_MAX_BYTES,
  SHARE_SITE_FILES_MAX_BYTES, SHARE_UPLOAD_CONCURRENCY, TEXT_ATTACHMENT } from './share_shared.mjs';
import { service_pid, service_ready, read_registry, configuration_snapshot } from './discussion_service.mjs';
import { local_settings } from './discussion_setup.mjs';

const JOB_RETENTION_MS = 7 * 86400_000;
const INBOX_RETENTION_MS = 60000;
const INBOX_POLL_MS = 1200;
const SWEEP_MS = 3600000;
const PROGRESS_SAVE_MS = 300;
const RECEIPT_TIMEOUT_MS = 10000;
const ACTIVE = new Set(['preparing', 'publishing']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ID = /^[\w-]{22}$/;
const instances = new Map();
const job_locale = new AsyncLocalStorage();
const t = (source, params) => translate(source, params, job_locale.getStore());
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const now = () => new Date().toISOString();
const progress = step => ({ step, done: 0, total: 0, bytes_done: 0, bytes_total: 0 });
// Use the shipped Markdown parser so list items, quotes and unclosed visual fences are cleaned exactly as in the browser.
let markdown;
function collapse_visual_fences(text, label) {
  markdown ??= runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8') + ';discuss_markdown');
  return markdown.collapse_visual_fences(text, label);
}
const core = create_share_core({ t, display_name: name => name, is_text_attachment: f => TEXT_ATTACHMENT.test(f.file_name), collapse_visual_fences });
function origin(home) { return 'http://127.0.0.1:' + (local_settings(home).port || 8765); }

function room_config(home, room, token) {
  const site = origin(home);
  for (const path of read_registry(home)) {
    const config = configuration_snapshot(path)?.config;
    if (config?.room !== room) continue;
    const url = new URL(config.site);
    if (url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname) && url.port === new URL(site).port)
      return { site, token: config.token, roots: room_directories(config) };
  }
  return { site, token: token || '', roots: [] };
}

async function checked(response) {
  if (response.ok) return response;
  const detail = await response.json().catch(() => ({}));
  throw Object.assign(new Error(detail.error || t('分享请求失败（HTTP {status}）', { status: response.status })), { status: response.status });
}

async function local_read(config, path, signal, body) {
  return checked(await site_fetch(new URL(path, config.site), { method: body ? 'POST' : 'GET', redirect: 'error', signal,
    headers: { 'X-Discussion-Token': config.token, ...(body ? { 'Content-Type':'application/json' } : {}) }, body: body && JSON.stringify(body) }));
}

function bounded_paths(files, room) {
  return files.every(f => /^[\w-]+$/.test(f.id) && f.room_id === room && f.route === '/api/rooms/' + room + '/attachments/' + f.id + '/content');
}

async function file_source(config, file, signal) {
  if (!file.project) return (await local_read(config, file.route, signal)).body;
  const { path, root } = file.project;
  const media = project_media(config.roots[root], path, { download: true });
  if (media.size !== file.size) throw new Error(t('附件大小已变化，请重新整理分享'));
  return createReadStream(media.file, { signal });
}

async function prepare(config, room, signal) {
  const responses = {};
  const keep = async path => (responses[path] = await (await local_read(config, path, signal)).json());
  const history = (id, query, after) => '/api/rooms/' + id + '/messages?' + new URLSearchParams({ q: query, withdrawn: 'include', limit: '200', cards: '1', after });
  const runs = await core.share_collect_reads(room, history, keep);
  const clean = core.share_payload(responses, room, config.roots);
  const with_files = core.share_payload(responses, room, config.roots, { attachments: true });
  const delivered = await core.share_find_delivered(with_files, room, config.roots, items => items.map(({ root, path }) => {
    try { const { size, modified_at } = project_media(config.roots[root], path, { download: true }); return { kind: 'file', size, modified_at }; }
    catch { return null; }
  }));
  const files = core.share_files(with_files, room).map(file => ({ ...file, project: delivered.get(file.route) }));
  if (!bounded_paths(files, room)) throw new Error(t('分享上传清单无效'));
  const file_spots = await core.share_scan_files(files, async file => {
    const chunks = []; let size = 0;
    for await (const chunk of await file_source(config, file, signal)) {
      size += chunk.length;
      if (size > file.size) throw new Error(t('附件大小已变化，请重新整理分享'));
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  });
  signal.throwIfAborted();
  const info = clean['/api/rooms/' + room];
  const members = (info.members || []).filter(m => m.status !== 'removed').map(m => m.label || m.name);
  const linked = Boolean((await (await local_read(config, '/api/rooms/' + room + '/share-link', signal)).json()).link);
  return { summary: { title: info.title, description: t('{members} 在同一个房间协作 · {messages} 条消息 · {runs} 次执行', { members: members.join('、'), messages: info.message_count, runs }),
    fingerprint: await share_fingerprint(clean, with_files), exported_at: now(), files, spots: core.share_sensitive_spots(clean), file_spots, linked, runs,
    materials: core.share_card_materials_info(clean) },
    payload: { responses: clean, responses_with_files: with_files } };
}

function snapshot(job, payload, selection) {
  const draft = { ...payload, ...job.summary, room_id: job.room_id, include_files: selection.include_files, left_files: new Set(selection.left_files) };
  const files = core.share_carried_files(draft, true);
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  if (files.some(f => f.size > SHARE_SITE_FILE_MAX_BYTES)) throw new Error(t('单个分享附件最多 100 MiB'));
  if (bytes > SHARE_SITE_FILES_MAX_BYTES) throw new Error(t('分享附件合计最多 300 MiB'));
  const body = { format: SHARE_FORMAT, room_id: job.room_id, title: draft.title, description: draft.description, exported_at: draft.exported_at,
    ttl_days: selection.days, responses: core.share_responses(draft, true) };
  if (files.length) body.files = Object.fromEntries(files.map(f => [f.route,{ content_type: f.site_type, bytes: f.size }]));
  if (Buffer.byteLength(JSON.stringify(body)) > SHARE_MAX_BYTES) throw new Error(t('分享正文最多 5 MiB，请下载网页文件'));
  return { draft, files, bytes, body };
}

const UPLOAD_ATTEMPTS = 3;
const UPLOAD_RETRY_BASE_MS = 250;

function format_network_error(error) {
  const cause = error?.cause?.message;
  if (!cause || String(error.message || '').includes(cause)) return error;
  return Object.assign(new Error(`${error.message}: ${cause}`), { status: error.status, permanent: error.permanent });
}

function is_retryable(error, signal) {
  return !signal.aborted && !error?.permanent && (!error?.status || error.status === 429 || error.status >= 500);
}

async function send_snapshot(path, method, body, token, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(SHARE_SITE + path, { method, body: JSON.stringify(body), redirect: 'error', signal,
        headers: { 'Content-Type':'application/json', ...(token ? { Authorization:'Bearer ' + token } : {}) } });
      return (await checked(response)).json();
    } catch (raw) {
      const error = format_network_error(raw);
      if (attempt >= 2 || !is_retryable(error, signal)) throw error;
      await delay(attempt * UPLOAD_RETRY_BASE_MS, undefined, { signal });
    }
  }
}

/** Stream one selected file via fetch (reusing undici's pooled TLS/proxy transport). */
async function send_file(url, headers, source, signal) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
  let response;
  try {
    response = await fetch(url, { method: 'PUT', headers: normalized, body: Readable.toWeb(Readable.from(source)),
      duplex: 'half', redirect: 'error', signal });
  } catch (error) {
    throw format_network_error(error);
  }
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw Object.assign(new Error(t('上传分享附件失败（HTTP {status}）', { status: response.status })), { status: response.status });
}

async function publish(config, job, plan, signal, transport, update) {
  const route = '/api/rooms/' + job.room_id + '/share-link';
  const prior = (await (await local_read(config, route, signal)).json()).link;
  let result, updated = false;
  if (prior && ID.test(prior.share_id)) {
    try { result = await transport.snapshot('/api/shares/' + prior.share_id, 'PUT', plan.body, prior.manage_token, signal); updated = true; }
    catch (error) { if (![404,410].includes(error.status)) throw error; }
  }
  if (!result) result = await transport.snapshot('/api/shares', 'POST', plan.body, '', signal);
  const link = { share_id: result.id || prior?.share_id, manage_token: result.manage_token || prior?.manage_token, url: result.url || prior?.url, expires_at: result.expires_at };
  if (!ID.test(link.share_id) || !/^[\w-]{43}$/.test(link.manage_token) || (plan.files.length && !ID.test(result.revision))
      || link.url !== SHARE_SITE + '/s/' + link.share_id) throw new Error(t('分享站返回了无效的链接'));
  const card = core.share_card(plan.draft, link);
  card.publication = { revision: result.revision, total: plan.files.length, ...(plan.files.length ? {} : { done: 0 }) };
  await local_read(config, route, signal, { link: { ...link, card } }).then(r => r.json());
  if (plan.files.length) {
    update(0, 0, result.revision);
    try { await publish_attachments(plan.files, { link, card, config, signal, transport, update }); }
    finally {
      const { revision, done } = card.publication;
      await local_read(config, '/api/rooms/' + job.room_id + '/share-card', signal,
        { share_id: link.share_id, publication: { revision, done } }).catch(() => {});
    }
  }
  return { url: link.url, expires_at: link.expires_at, updated, card };
}

async function publish_attachments(files, { link, card, config, signal, transport, update }) {
  const group = new AbortController(), active = AbortSignal.any([signal, group.signal]);
  const { revision } = card.publication;
  card.publication.done = 0;
  await core.share_parallel(files, SHARE_UPLOAD_CONCURRENCY, async file => {
    for (let attempt = 1; ; attempt++) {
      let sent = 0;
      try {
        const input = await file_source(config, file, active);
        async function* measured() {
          let size = 0;
          for await (const chunk of input) {
            active.throwIfAborted(); size += chunk.length;
            if (size > file.size) throw Object.assign(new Error(t('附件大小已变化，请重新整理分享')), { permanent: true });
            yield chunk;
            sent += chunk.length;
            update(0, chunk.length);
          }
          if (size !== file.size) throw Object.assign(new Error(t('附件大小已变化，请重新整理分享')), { permanent: true });
        }
        await transport.file(SHARE_SITE + '/api/shares/' + link.share_id + '/files/' + file.id + '?revision=' + revision,
          { Authorization: 'Bearer ' + link.manage_token, 'Content-Type': file.site_type, 'Content-Length': file.size }, measured(), active);
        card.publication.done++;
        update(1, 0);
        break;
      } catch (error) {
        if (sent) update(0, -sent);
        if (attempt >= UPLOAD_ATTEMPTS || !is_retryable(error, active)) { group.abort(error); throw error; }
        await delay(attempt * UPLOAD_RETRY_BASE_MS, undefined, { signal: active });
      }
    }
  });
}


function brief(job) {
  const { summary, selection, ...info } = job;
  return { ...info, adjustable: Boolean(summary) };
}

function selection_for(job, value = job.selection) {
  const excluded = new Set(Array.isArray(value.left_files) ? value.left_files : []);
  return { include_files: value.include_files === true, days: SHARE_DAYS.includes(value.days) ? value.days : SHARE_DEFAULT_DAYS,
    left_files: job.summary.files.filter(file => excluded.has(file.route)).map(file => file.route) };
}

/** One private store and one cancellation controller for each active job in a discussion service. */
class ShareManager {
  constructor(home, transport, report) {
    this.home = home;
    this.transport = transport;
    this.report = report;
    this.jobs = new Map();
    this.running = new Map();
    this.dir = join(home, 'share-jobs');
    this.inbox = join(this.dir, 'inbox');
    mkdirSync(this.inbox, { recursive: true, mode: 0o700 });
    this.restore();
    const read = () => { try { this.drain(); } catch (error) { report(error); } };
    this.watcher = watch(this.inbox, (_, name) => { if (!name || String(name).startsWith('req-')) read(); });
    this.watcher.on('error', report);
    this.poll = setInterval(read, INBOX_POLL_MS);
    this.cleanup = setInterval(() => { try { this.sweep(); } catch (error) { report(error); } }, SWEEP_MS);
    atomic_json(join(this.dir, 'service.json'), { pid: process.pid });
  }

  file(job, name) { return join(this.dir, job.id, name); }

  save(job) {
    job.updated_at = now();
    atomic_json(this.file(job, 'state.json'), job);
  }
  remove(job) {
    rmSync(join(this.dir, job.id), { recursive: true, force: true });
    this.jobs.delete(job.id);
  }
  sweep() {
    for (const job of this.jobs.values()) if (!ACTIVE.has(job.phase) && Date.parse(job.updated_at) < Date.now() - JOB_RETENTION_MS) this.remove(job);
    for (const name of readdirSync(this.inbox)) {
      const path = join(this.inbox, name);
      try { if (statSync(path).mtimeMs < Date.now() - INBOX_RETENTION_MS) unlinkSync(path); } catch { /* Caller already removed its receipt. */ }
    }
  }
  restore() {
    for (const id of readdirSync(this.dir).filter(id => UUID.test(id))) {
      let job;
      try { job = json(join(this.dir, id, 'state.json')); } catch { continue; }
      if (job.id !== id) continue;
      this.jobs.set(id, job);
      if (ACTIVE.has(job.phase)) {
        job.phase = 'failed'; job.error = translate('服务已重启，请重试', undefined, job.locale); this.save(job);
      }
    }
    this.sweep();
  }
  start(job, config, plan) {
    const controller = new AbortController(), signal = controller.signal;
    this.running.set(job.id, controller);
    job.phase = plan ? 'publishing' : 'preparing';
    job.error = '';
    job.progress = { ...progress(job.phase), total: plan?.files.length || 0, bytes_total: plan?.bytes || 0 };
    this.save(job);
    let last_save = Date.now();
    const update = (count, bytes, revision) => {
      signal.throwIfAborted();
      job.progress.step = 'uploading'; job.progress.done += count; job.progress.bytes_done += bytes;
      if (revision) job.progress.revision = revision;
      if (Date.now() - last_save > PROGRESS_SAVE_MS) { this.save(job); last_save = Date.now(); }
    };
    (async () => {
      if (plan) {
        const result = await publish(config, job, plan, signal, this.transport, update);
        signal.throwIfAborted();
        job.result = result; job.phase = 'published';
      } else {
        const { summary, payload } = await prepare(config, job.room_id, signal);
        signal.throwIfAborted();
        atomic_json(this.file(job, 'payload.json'), payload);
        job.summary = summary; job.room_title = summary.title; job.phase = 'ready';
      }
    })().catch(error => {
      if (!signal.aborted) { job.phase = 'failed'; job.error = String(error.message).slice(0, 500); }
    }).finally(() => {
      if (this.running.get(job.id) === controller) { this.running.delete(job.id); this.save(job); }
    }).catch(error => {
      job.phase = 'failed'; job.error = error.message; this.report(error);
    });
  }
  command(input) {
    const locale = this.jobs.get(input.id)?.locale || (['en','zh-CN'].includes(input.locale) ? input.locale : undefined);
    return job_locale.run(locale, () => this.apply(input));
  }

  apply({ op, room_id, room_title, id, selection, token }) {
    if (op === 'list') return { enabled: true, jobs: [...this.jobs.values()].sort((a,b) => b.created_at.localeCompare(a.created_at)).map(brief) };
    if (!/^[A-Za-z0-9_-]+$/.test(room_id || '')) throw new Error(t('房间编号无效'));
    const config = () => room_config(this.home, room_id, token);
    if (op === 'prepare') {
      const prior = [...this.jobs.values()].find(j => j.room_id === room_id && (ACTIVE.has(j.phase) || j.phase === 'ready'));
      if (prior) return { enabled: true, job: brief(prior) };
      const job = { id: randomUUID(), room_id, room_title: String(room_title || room_id).slice(0, 200), created_at: now(),
        locale: job_locale.getStore(), summary: null, selection: { include_files: false, left_files: [], days: SHARE_DEFAULT_DAYS }, result: null };
      mkdirSync(join(this.dir, job.id), { mode: 0o700 });
      this.jobs.set(job.id, job); this.start(job, config());
      return { enabled: true, job: brief(job) };
    }
    const job = this.jobs.get(id);
    if (!job || job.room_id !== room_id) throw new Error(t('分享任务不存在'));
    if (op === 'get') return { enabled: true, job: { ...brief(job), summary: job.summary, selection: job.selection } };
    if (op === 'cancel' && (ACTIVE.has(job.phase) || job.phase === 'ready')) {
      this.running.get(id)?.abort(); this.running.delete(id);
      job.phase = 'cancelled'; this.save(job);
    } else if (op === 'dismiss' && !ACTIVE.has(job.phase)) {
      this.remove(job); return { enabled: true, id };
    } else if (op === 'select' && job.summary && ['ready','failed','cancelled'].includes(job.phase)) {
      job.selection = selection_for(job, selection); this.save(job);
    } else if (op === 'publish' && job.phase === 'publishing') {
      return { enabled: true, job: brief(job) };
    } else if ((op === 'publish' && job.summary && ['ready','failed','cancelled'].includes(job.phase))
        || (op === 'retry' && ['failed','cancelled'].includes(job.phase))) {
      if (job.summary && (op === 'publish' || job.progress.step !== 'preparing')) {
        if ([...this.jobs.values()].some(other => other.id !== id && other.room_id === room_id && other.phase === 'publishing'))
          throw new Error(t('这个房间已有分享正在发布'));
        job.selection = selection_for(job, selection); this.save(job);
        this.start(job, config(), snapshot(job, json(this.file(job, 'payload.json')), job.selection));
      } else if (job.summary) { job.phase = 'ready'; this.save(job); }
      else this.start(job, config());
    } else throw new Error(t('当前分享任务不能执行此操作'));
    return { enabled: true, job: brief(job) };
  }
  drain() {
    for (const name of readdirSync(this.inbox)) {
      if (!name.startsWith('req-') || !name.endsWith('.json') || !UUID.test(name.slice(4,-5))) continue;
      const path = join(this.inbox,name), ack = join(this.inbox,'ack-' + name.slice(4));
      let answer;
      try { const input = json(path); unlinkSync(path); answer = { value: this.command(input) }; }
      catch (error) { if (error.code === 'ENOENT') continue; answer = { error: error.message }; }
      atomic_json(ack, answer);
    }
  }

  close() {
    this.watcher.close();
    clearInterval(this.poll);
    clearInterval(this.cleanup);
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    instances.delete(this.home);
    rmSync(join(this.dir, 'service.json'), { force: true });
  }
}

/** Attach the durable job store and inbox to the running discussion service. */
export function start_share_manager(home, { transport = { snapshot: send_snapshot, file: send_file }, report = error => console.error(error.message) } = {}) {
  const manager = new ShareManager(home, transport, report);
  instances.set(home, manager);
  return manager;
}

/** Whether this computer currently has a ready discussion service with share-job support. */
export function sharing_available(home) {
  if (instances.has(home)) return true;
  try { const pid = service_pid(home); return pid === json(join(home,'share-jobs','service.json')).pid && service_ready(home, pid); } catch { return false; }
}

/** Paired commands execute in memory. Local Python launch commands wake the same worker by atomic inbox delivery. */
export async function request_share_job(home, input) {
  if (instances.has(home)) return instances.get(home).command(input);
  if (!sharing_available(home)) return { enabled: false };
  const inbox = join(home,'share-jobs','inbox'), id = randomUUID();
  const path = join(inbox,'req-' + id + '.json'), ack = join(inbox,'ack-' + id + '.json');
  atomic_json(path, input);
  try {
    const until = Date.now() + RECEIPT_TIMEOUT_MS;
    while (!existsSync(ack) && Date.now() < until) await delay(25);
    if (!existsSync(ack)) throw new Error(t('分享服务未及时响应，请重试'));
    const result = json(ack);
    if (result.error) throw new Error(result.error);
    return result.value;
  } finally { rmSync(path, { force: true }); rmSync(ack, { force: true }); }
}

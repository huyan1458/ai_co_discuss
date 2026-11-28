import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, lstatSync, mkdirSync, openAsBlob, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDeflateRaw, crc32 } from 'node:zlib';

import { site_fetch } from './entry_client.mjs';
import { atomic_json } from './files.mjs';
import { t } from './i18n.mjs';
import { project_path, project_root } from './project_files.mjs';
import { check_name, place_project_download } from './project_manage.mjs';

const MAX_BYTES = 2 * 1024 ** 3;
const MAX_ZIP_ENTRIES = 65534;
const ZIP_FLAGS = 0x0808; // UTF-8 names and streaming data descriptors.
const ZIP_DEFLATE = 8;
const STORAGE_TIMEOUT = 60 * 60_000;
const SITE_TIMEOUT = 30_000;
const SCRIPT = fileURLToPath(import.meta.url);
const TASK_ID = /^[a-f0-9]{32}$/;
const jobs_path = home => join(home, 'project-cloud-jobs');
const cloud_error = template => Object.assign(new Error(t(template)), { error_text: { template, params: {} } });
const size_error = () => cloud_error('云空间单个文件最多 2 GiB');

function zip_header(entry, central = false) {
  const header = Buffer.alloc(central ? 46 : 30);
  header.writeUInt32LE(central ? 0x02014b50 : 0x04034b50);
  if (central) header.writeUInt16LE(20, 4);
  const base = central ? 6 : 4;
  header.writeUInt16LE(20, base);
  header.writeUInt16LE(ZIP_FLAGS, base + 2);
  header.writeUInt16LE(entry.method, base + 4);
  header.writeUInt16LE(0x21, base + 8); // DOS date 1980-01-01.
  header.writeUInt16LE(entry.name.length, base + 22);
  if (central) {
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.compressed, 20);
    header.writeUInt32LE(entry.size, 24);
    if (!entry.method) header.writeUInt32LE(16, 38);
    header.writeUInt32LE(entry.offset, 42);
  }
  return header;
}

function* zip_paths(root, path = '') {
  const directory = project_path(root, path);
  const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const child of children) {
    const relative = path ? `${path}/${child.name}` : child.name;
    const target = join(directory, child.name);
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) throw cloud_error('不能将含链接或特殊文件的文件夹存入云空间');
    if (info.size > MAX_BYTES) throw size_error();
    yield { path: relative, folder: info.isDirectory() };
    if (info.isDirectory()) yield* zip_paths(root, relative);
  }
}

function project_source_version(file, kind) {
  const version = path => {
    const { size, mtimeNs } = statSync(path, { bigint: true });
    return `${size}:${mtimeNs}`;
  };
  if (kind === 'file') return version(file);
  const hash = createHash('sha256');
  for (const item of zip_paths(file)) hash.update(JSON.stringify([item.path, item.folder, version(project_path(file, item.path))]));
  return hash.digest('hex');
}

async function* zip_contents(file, entry) {
  for await (const chunk of createReadStream(file)) {
    entry.size += chunk.length;
    if (entry.size > MAX_BYTES) throw size_error();
    entry.crc = crc32(chunk, entry.crc);
    yield chunk;
  }
}

async function zip_entry(root, item, output) {
  const name = Buffer.from(`${item.path}${item.folder ? '/' : ''}`);
  if (name.length > 65535 || item.path.includes('\\')) throw cloud_error('云空间 ZIP 内的路径无效');
  const entry = { name, offset: output.offset, method: item.folder ? 0 : ZIP_DEFLATE, crc: 0, compressed: 0, size: 0 };
  await output.write(zip_header(entry), name);
  if (!item.folder) {
    const stream = Readable.from(zip_contents(project_path(root, item.path), entry));
    const deflate = createDeflateRaw();
    stream.on('error', error => deflate.destroy(error));
    try {
      for await (const chunk of stream.pipe(deflate)) {
        entry.compressed += chunk.length;
        await output.write(chunk);
      }
    } finally { stream.destroy(); deflate.destroy(); }
  }
  const footer = Buffer.alloc(16);
  [0x08074b50, entry.crc, entry.compressed, entry.size].forEach((value, index) => footer.writeUInt32LE(value, index * 4));
  await output.write(footer);
  return entry;
}

/** Stream a ZIP with classic offsets. Its 2 GiB cap keeps every offset in range. */
export async function zip_cloud_folder(root, destination) {
  const fd = await open(destination, 'wx', 0o600), entries = [];
  const output = { offset: 0, async write(...buffers) {
    for (const bytes of buffers) {
      if (output.offset + bytes.length > MAX_BYTES) throw size_error();
      for (let end = 0; end < bytes.length;) {
        const { bytesWritten } = await fd.write(bytes, end, bytes.length - end);
        end += bytesWritten;
      }
      output.offset += bytes.length;
    }
  } };
  try {
    for (const item of zip_paths(root)) {
      if (entries.length >= MAX_ZIP_ENTRIES) throw cloud_error('文件夹包含太多条目，无法打包为 ZIP');
      entries.push(await zip_entry(root, item, output));
    }
    const offset = output.offset;
    for (const entry of entries) await output.write(zip_header(entry, true), entry.name);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(output.offset - offset, 12); end.writeUInt32LE(offset, 16);
    await output.write(end);
  } finally { await fd.close(); }
}

/** Validate the chosen relative project entry without ever accepting a caller-provided absolute path. */
export function cloud_project_source(directory, path, kind) {
  const base = project_root(directory);
  const target = project_path(base, path);
  const info = statSync(target);
  const actual = info.isFile() ? 'file' : info.isDirectory() ? 'folder' : '';
  if (!actual || kind && kind !== actual) throw cloud_error('云空间来源须为指定类型的普通文件或文件夹');
  if (actual === 'file' && info.size > MAX_BYTES) throw size_error();
  return { base, kind: actual, path, name: basename(path.replaceAll('\\', '/')) || basename(target) };
}

async function project_cloud_request(url, body, fetcher, headers) {
  const response = await fetcher(url, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(SITE_TIMEOUT),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || t('无法将文件存到云空间')), {
    error_text: data.error_text, status: response.status, http_status: response.status, code: 'cloud_request_failed', details: {},
  });
  return data;
}

const room_cloud_request = (request, path, body, fetcher) => project_cloud_request(`${request.site}/api/rooms/${request.room}${path}`, body, fetcher,
  { 'X-Discussion-Token': request.token });
const cloud_request = (request, suffix, body, fetcher) => room_cloud_request(request, `/cloud-files${suffix}`, body, fetcher);

/** Resolve the requested folder and rule out a read-only project even if reached through another root. */
export function cloud_landing_target(directory, path, readonly) {
  const base = project_root(directory);
  const folder = project_path(base, path);
  if (!statSync(folder).isDirectory()) throw cloud_error('目标不是文件夹');
  const inside = (parent, child) => {
    const rest = relative(parent, child);
    return !isAbsolute(rest) && rest !== '..' && !rest.startsWith('..' + sep);
  };
  for (const read of readonly) {
    let root;
    try { root = realpathSync(read); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (root && (inside(root, base) || inside(root, folder))) throw cloud_error('项目目录只读');
  }
  return { base, folder, path: path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.').join('/'), readonly };
}

const inbound_file = (home, id) => join(jobs_path(home), `inbound-${id}.json`);

/** Read the target bound to the original reservation, not a path supplied on completion. */
export function read_cloud_inbound(home, { site, room, task_id }) {
  if (typeof task_id !== 'string' || !TASK_ID.test(task_id)) throw cloud_error('没有这项云空间上传任务');
  let saved;
  try { saved = JSON.parse(readFileSync(inbound_file(home, task_id), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved?.site !== site || saved.room !== room) throw cloud_error('没有这项云空间上传任务');
  return saved;
}

/** Reserve an inbound upload and persist only its validated target, never its credential or signed form. */
export async function reserve_cloud_inbound(home, request, { fetch_site = site_fetch } = {}) {
  const { site, room, root, target, size, content_type, submission_id } = request;
  const name = check_name(request.name);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) throw size_error();
  const source_ref = `${root}:${[target.path, name].filter(Boolean).join('/')}`;
  const { cloud_file, upload } = await cloud_request(request, '', { file_name: name, size, content_type,
    source_kind: 'project_file', source_ref, submission_id, purpose: 'inbound' }, fetch_site);
  if (!TASK_ID.test(cloud_file?.id || '')) throw cloud_error('对象存储凭证响应无效');
  mkdirSync(jobs_path(home), { recursive: true, mode: 0o700 });
  const saved = { site, room, root, path: target.path, base: target.base, folder: target.folder, name, size };
  const record = inbound_file(home, cloud_file.id);
  try { writeFileSync(record, JSON.stringify(saved), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = read_cloud_inbound(home, { site, room, task_id: cloud_file.id });
    if (Object.keys(saved).some(key => previous[key] !== saved[key])) throw cloud_error('云空间上传的目标文件夹已改变');
  }
  return { task_id: cloud_file.id, upload };
}

async function claim_landing_source(request, fetcher) {
  const { site, room, attachment_room, attachment_id, attachment_grant, cloud_file_id } = request;
  const origin = new URL(site);
  if (typeof attachment_grant !== 'string' || !/^[a-f0-9]{64}$/.test(attachment_grant) || origin.protocol !== 'http:'
      || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || !/^[A-Za-z0-9_-]{1,64}$/.test(room))
    throw cloud_error('需要管理员登录');
  const url = new URL(`/api/rooms/${room}/cloud-land/redeem`, origin);
  const target = cloud_file_id ? { cloud_file_id } : { attachment_room, attachment_id };
  const { attachment: meta, cloud_file, link } = await project_cloud_request(url.href, { ...target, grant: attachment_grant }, fetcher);
  if (cloud_file_id) {
    if (cloud_file?.id !== cloud_file_id || !cloud_file.stored || cloud_file.cleared_at) throw cloud_error('对象存储凭证响应无效');
    return { meta: cloud_file, link };
  }
  if (meta?.id !== attachment_id || meta.room_id !== attachment_room || meta.storage !== 'object' || !meta.message_id || !meta.stored || meta.cleared_at)
    throw cloud_error('只能取回已发送且仍在云空间的附件');
  return { meta, link };
}

async function landing_link(request, fetcher) {
  if (request.cloud_file_id || (request.attachment_room && request.attachment_room !== request.room)) return claim_landing_source(request, fetcher);
  if (request.attachment_id) {
    const path = `/attachments/${request.attachment_id}`;
    const meta = await room_cloud_request(request, path, undefined, fetcher);
    if (meta.storage !== 'object' || !meta.message_id || !meta.stored || meta.cleared_at) throw cloud_error('只能取回已发送且仍在云空间的附件');
    return { meta, link: await room_cloud_request(request, `${path}/content?link=1`, undefined, fetcher) };
  }
  const path = `/${request.inbound_id}`, { cloud_file: meta } = await cloud_request(request, `${path}/complete`, {}, fetcher);
  if (meta?.purpose !== 'inbound' || meta.file_name !== request.original.name || meta.size !== request.original.size)
    throw cloud_error('对象存储凭证响应无效');
  return { meta, link: await cloud_request(request, `${path}/content?link=1`, undefined, fetcher) };
}

async function stream_landing(link, size, fd, { fetch_cos, progress }) {
  let url;
  try { url = new URL(link?.url); } catch { /* Invalid links are refused below. */ }
  if (url?.protocol !== 'https:' || url.username || url.password || link.size !== size) throw cloud_error('对象存储凭证响应无效');
  const response = await fetch_cos(url.href, { redirect: 'error', signal: AbortSignal.timeout(STORAGE_TIMEOUT) });
  if (!response.ok || (!response.body && size !== 0)) { await response.body?.cancel(); throw cloud_error('无法从云空间取回文件'); }
  let received = 0, last_progress = -1;
  for await (const chunk of response.body ?? []) {
    received += chunk.length;
    if (received > size) throw cloud_error('云空间文件大小不符，未保存到项目');
    for (let offset = 0; offset < chunk.length;) offset += (await fd.write(chunk, offset, chunk.length - offset)).bytesWritten;
    const percent = size === 0 ? 80 : Math.floor(received * 80 / size);
    if (percent > last_progress) { progress('downloading', (10 + percent) / 100); last_progress = percent; }
  }
  if (received !== size) throw cloud_error('云空间文件大小不符，未保存到项目');
}

/** Download without room credentials and publish only a full file. An inbound object is released after local success. */
export async function land_cloud_project(request, { fetch_site = site_fetch, fetch_cos = fetch, progress = () => {} } = {}) {
  const { target, conflict, inbound_id } = request;
  progress('verifying', 0.05);
  const { meta, link } = await landing_link(request, fetch_site);
  const name = check_name(meta.file_name), size = meta.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES) throw size_error();
  const validate = () => {
    if (cloud_landing_target(target.base, target.path, target.readonly).folder !== target.folder) throw cloud_error('云空间上传的目标文件夹已改变');
  };
  validate();
  const temporary = join(target.folder, `.${name}.${request.id}.part`);
  const fd = await open(temporary, 'wx', 0o600);
  let path;
  try {
    try { await stream_landing(link, size, fd, { fetch_cos, progress }); }
    finally { await fd.close(); }
    validate();
    progress('landing', 0.95);
    path = place_project_download({ root: target.base, path: target.path, name, temporary, conflict });
  } finally { await rm(temporary, { force: true }); }
  if (inbound_id) {
    try { await cloud_request(request, `/${inbound_id}/release`, {}, fetch_site); }
    catch { return { path, release_pending: true }; }
  }
  return { path };
}

async function upload_form(upload, file, name, content_type, fetcher) {
  let url;
  try { url = new URL(upload?.url); } catch { /* Rejected below. */ }
  if (url?.protocol !== 'https:' || url.username || url.password || !upload.fields || Object.entries(upload.fields).some(([key, value]) => key === 'file' || typeof value !== 'string'))
    throw cloud_error('对象存储凭证响应无效');
  const form = new FormData();
  for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
  form.append('file', await openAsBlob(file, { type: content_type }), name);
  const result = await fetcher(url.href, { method: 'POST', body: form, redirect: 'error', signal: AbortSignal.timeout(STORAGE_TIMEOUT) });
  await result.body?.cancel();
  if (!result.ok) throw cloud_error('无法将文件存到云空间');
}

/** Reserve, send bytes directly to COS without room credentials, and only then complete. */
export async function upload_cloud_project(home, request, { progress = () => {}, fetch_site = site_fetch, fetch_cos = fetch } = {}) {
  const { base, path, kind, name } = request.source;
  let archive, file = project_path(base, path);
  const original = file, outbound = request.purpose === 'outbound';
  const source_path = outbound ? relative(base, original) : path;
  const source_ref = `${request.root}:${source_path.replaceAll('\\', '/')}`;
  const source_version = outbound ? project_source_version(original, kind) : null;
  const submission_id = outbound ? createHash('sha256').update(JSON.stringify([original, source_ref, source_version])).digest('hex') : request.id;
  const file_name = kind === 'folder' ? `${name}.zip` : name;
  const content_type = kind === 'folder' ? 'application/zip' : 'application/octet-stream';
  try {
    const info = statSync(file);
    if (kind === 'folder' ? !info.isDirectory() : !info.isFile()) throw cloud_error('云空间来源须为指定类型的普通文件或文件夹');
    if (kind === 'folder') {
      progress('packing', 0.05);
      archive = await mkdtemp(join(home, 'project-cloud-zip-'));
      await zip_cloud_folder(realpathSync(file), file = join(archive, 'project.zip'));
    }
    const size = statSync(file).size;
    if (size > MAX_BYTES) throw size_error();
    if (outbound && project_source_version(original, kind) !== source_version) throw cloud_error('项目文件已改变，请重新下载');
    progress('uploading', 0.25);
    const metadata = { file_name, size, content_type, source_kind: kind === 'folder' ? 'project_folder' : 'project_file',
      source_ref, submission_id, ...(outbound ? { purpose: 'outbound', source_version } : {}) };
    const { cloud_file, upload } = await cloud_request(request, '', metadata, fetch_site);
    if (!TASK_ID.test(cloud_file?.id || '')) throw cloud_error('对象存储凭证响应无效');
    if (outbound && kind === 'file' && project_source_version(original, kind) !== source_version) throw cloud_error('项目文件已改变，请重新下载');
    if (!upload) return cloud_file;
    await upload_form(upload, file, file_name, content_type, fetch_cos);
    progress('verifying', 0.9);
    const completed = await cloud_request(request, `/${cloud_file.id}/complete`, {}, fetch_site);
    return completed.cloud_file ?? completed;
  } finally { if (archive) await rm(archive, { recursive: true, force: true }); }
}

function save_status(home, task_id, fields) {
  atomic_json(join(jobs_path(home), task_id + '.json'), { task_id, ...fields });
}

/** Read this computer's task receipt. Never return source paths, owner credentials or signed uploads. */
export function project_cloud_status(home, task_id) {
  if (typeof task_id !== 'string' || !TASK_ID.test(task_id)) return null;
  try { return JSON.parse(readFileSync(join(jobs_path(home), task_id + '.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

/** Start an isolated upload worker that outlives the short HTTP command process. */
export async function start_project_cloud(home, request) {
  mkdirSync(jobs_path(home), { recursive: true, mode: 0o700 });
  const id = request.inbound_id || randomUUID().replaceAll('-', '');
  const pending = { status: 'running', stage: 'queued', progress: 0 };
  if (request.inbound_id) {
    try { writeFileSync(join(jobs_path(home), id + '.json'), JSON.stringify({ task_id: id, ...pending }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code === 'EEXIST') return project_cloud_status(home, id); throw error; }
  } else save_status(home, id, pending);
  const child = spawn(process.execPath, [SCRIPT, 'worker'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.stdin.end(JSON.stringify({ home, request: { ...request, id } }), resolve);
  }).catch(error => { save_status(home, id, { status: 'failed', error: t('无法将文件存到云空间') }); throw error; });
  child.unref();
  return { task_id: id, ...pending };
}

async function run_worker() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const { home, request } = JSON.parse(Buffer.concat(chunks));
  try {
    const progress = (stage, value) => save_status(home, request.id, { status: 'running', stage, progress: value });
    const result = request.target ? await land_cloud_project(request, { progress }) : { cloud_file: await upload_cloud_project(home, request, { progress }) };
    save_status(home, request.id, { status: 'completed', progress: 1, ...result });
  } catch (error) {
    const fallback = request.target ? '无法从云空间取回文件' : '无法将文件存到云空间';
    const error_text = error.error_text || { template: fallback, params: {} };
    save_status(home, request.id, { status: 'failed', error: error.status || error.error_text ? error.message : t(fallback), error_text });
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url && process.argv[2] === 'worker') await run_worker();

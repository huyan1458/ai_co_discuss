/** Filesystem phase of a hosted project move. Isolated accounts run this file as their own OS user. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, rename, rmdir, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

async function info(path) {
  try { return await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path)) hash.update(block);
  return hash.digest('hex');
}

async function copy_verified(source, target) {
  const from = await info(source), to = await info(target);
  if (from?.isDirectory() && (!to || to.isDirectory())) {
    if (!to) await mkdir(target);
    const names = (await readdir(source)).sort();
    for (const name of names) await copy_verified(join(source, name), join(target, name));
    for (const folder of [source, target]) {
      if (JSON.stringify(names) !== JSON.stringify((await readdir(folder)).sort())) throw new Error('目录内容已变化 / Directory contents changed: ' + folder);
    }
    return;
  }
  if (!from?.isFile() || (to && (!to.isFile() || to.nlink !== 1))) throw new Error('无法迁移链接或特殊文件 / Unsupported link or special file: ' + source);
  // Create the file under the destination ACL. Files from the old volume may have explicit grants.
  await pipeline(createReadStream(source), createWriteStream(target, { flags: to ? 'w' : 'wx', mode: from.mode & 0o700 }));
  if (await digest(source) !== await digest(target)) throw new Error('文件校验失败 / File verification failed: ' + source);
  await utimes(target, from.atime, from.mtime);
}

/** Resume from deterministic backups after interruption. Prior absolute room paths resolve through directory junctions. */
export function migration_folders({ service, previous, target, id }) {
  return ['projects', 'workspace', 'drafts'].map(name => {
    const source = join(previous || (name === 'drafts' ? service : dirname(service)), name);
    // Keep all backups beside the running service, including legacy member drafts.
    const backup = join(previous || dirname(service), name + '.before-' + id);
    return { name, source, backup, destination: join(target, name) };
  });
}

export async function move_project_files(job) {
  const { service, target } = job;
  const settings_file = join(service, 'local-settings.json');
  const settings = JSON.parse(readFileSync(settings_file, 'utf8'));
  const folders = migration_folders(job);
  const old_drafts_backup = folders[2].source + '.before-' + job.id;
  if (relative(old_drafts_backup, folders[2].backup) && await info(old_drafts_backup)) {
    throw new Error('发现未登记的旧备份，请人工核对 / Older backup requires manual review: ' + old_drafts_backup);
  }
  if (relative(settings.projects_root, folders[0].source) || relative(settings.workspace, folders[1].source)) {
    if (settings.project_data_root && !relative(settings.project_data_root, target)) return migration_receipts(folders);
    throw Object.assign(new Error('账号配置与迁移记录不符 / Unexpected account paths'), { rolled_back: true });
  }
  try {
    await switch_folders(folders);
    const receipts = await migration_receipts(folders);
    const temp = join(service, 'local-settings.' + randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify({ ...settings, project_data_root: target, workspace: join(target, 'workspace'), projects_root: join(target, 'projects') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, settings_file);
    return receipts;
  } catch (error) {
    for (const { source, backup, destination } of folders.reverse()) {
      const old = await info(source);
      if (old?.isSymbolicLink() && !relative(await realpath(source), destination)) await unlink(source);
      if (!(await info(source)) && await info(backup)) await rename(backup, source);
    }
    error.rolled_back = true;
    throw error;
  }
}

async function switch_folders(folders) {
  for (const { source, backup, destination } of folders) {
    const old = await info(source), saved = await info(backup);
    if (old?.isSymbolicLink() && !relative(await realpath(source), destination)) continue;
    if (old && (!old.isDirectory() || saved)) throw new Error('源目录冲突 / Source folder conflict: ' + source);
    if (old) await rename(source, backup);
    if (old || saved) await copy_verified(backup, destination);
    else if (!(await info(destination))) await mkdir(destination);
    await symlink(destination, source, 'junction');
  }
}

async function checked_root(path) {
  if (relative(await realpath(path), resolve(path))) throw new Error('目录路径已重定向 / Directory redirected: ' + path);
}

async function inventory(root, hash_files) {
  await checked_root(root);
  const entries = [];
  async function visit(key) {
    const path = join(root, key), stat = await lstat(path, { bigint: true });
    if (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) throw new Error('备份含链接或特殊文件 / Link or special file: ' + path);
    const folder = stat.isDirectory();
    entries.push({ key, identity: stat.dev + '/' + stat.ino, folder, bytes: folder ? 0 : Number(stat.size),
      ...(!hash_files && !folder && stat.blocks !== undefined ? { allocated: Number(stat.blocks) * 512 } : {}),
      ...(hash_files && !folder ? { hash: await digest(path) } : {}) });
    if (folder) for (const child of (await readdir(path)).sort()) await visit(join(key, child));
  }
  await visit('');
  return entries;
}

function require_match(actual, expected, subset = false) {
  const by_key = new Map(expected.map(entry => [entry.key, entry]));
  if ((!subset && actual.length !== expected.length) || actual.some(entry => JSON.stringify(entry) !== JSON.stringify(by_key.get(entry.key)))) {
    throw new Error('目录与迁移校验记录不一致，已保留 / Directory differs from the migration record');
  }
}

async function check_link({ source, destination }) {
  if (!(await info(source))?.isSymbolicLink() || relative(await realpath(source), destination)) {
    throw new Error('旧房间联接已变化 / Room directory junction changed: ' + source);
  }
}

/** Node hashes the default data stream. Keep Windows originals containing any additional streams. */
function windows_stream_bytes(root, entries, inspecting = false) {
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class BackupStreams {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct StreamInfo { public long size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=296)] public string name; }
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr FindFirstStreamW(string path, int level, out StreamInfo item, int flags);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool FindNextStreamW(IntPtr handle, out StreamInfo item);
  [DllImport("kernel32")] static extern bool FindClose(IntPtr handle);
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle file, int kind, IntPtr buffer, uint size);
  static long Allocation(string path) {
    using (var file = CreateFileW(path, 128, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var buffer = Marshal.AllocHGlobal(24);
      try {
        if (!GetFileInformationByHandleEx(file, 1, buffer, 24)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return Marshal.ReadInt64(buffer);
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
  public static long Check(string path, bool inspecting) {
    long bytes = 0;
    StreamInfo item;
    IntPtr handle = FindFirstStreamW(path, 0, out item, 0);
    if (handle != new IntPtr(-1)) {
      try {
        do {
          if (item.name != "::$DATA" && !inspecting) throw new Exception("Named data stream: " + path);
          if (inspecting) bytes += Allocation(item.name == "::$DATA" ? path : path + item.name);
        } while (FindNextStreamW(handle, out item));
        int end = Marshal.GetLastWin32Error();
        if (end != 38) throw new Win32Exception(end);
      } finally { FindClose(handle); }
    } else {
      int error = Marshal.GetLastWin32Error();
      if (error != 38) throw new Win32Exception(error);
    }
    return bytes;
  }
}
'@
try {
  [long]$bytes = 0
  foreach ($path in (ConvertFrom-Json ([Console]::In.ReadToEnd()))) { $bytes += [BackupStreams]::Check($path, ${inspecting ? '$true' : '$false'}) }
  [Console]::WriteLine($bytes)
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, input: JSON.stringify(entries.map(entry => join(root, entry.key))), encoding: 'utf8' });
  if (result.status !== 0) throw new Error('无法验证 Windows 数据流，备份已保留 / Cannot certify Windows streams: ' + (result.error?.message || result.stderr));
  return Number(result.stdout.trim());
}

async function migration_receipts(folders) {
  const receipts = {};
  for (const folder of folders) {
    if (!await info(folder.backup)) continue;
    await check_link(folder);
    const backup = await inventory(folder.backup, true), target = await inventory(folder.destination, true);
    const content = rows => rows.map(({ identity, ...rest }) => rest);
    require_match(content(backup), content(target));
    receipts[folder.name] = { backup, target };
  }
  return receipts;
}

/** Operate on one owner-recorded backup. A partially released tree may only contain original verified entries. */
export async function backup_operation(request) {
  const { record, kind, action, releasing } = request;
  const folder = migration_folders(request).find(item => item.name === kind);
  if (!folder || !record?.backup?.length) throw new Error('缺少迁移记录 / Missing migration record');
  const { backup, destination } = folder;
  if (action !== 'list') {
    await check_link(folder);
    await checked_root(destination);
    const root = await lstat(destination, { bigint: true }), receipt = record.target?.[0];
    if (receipt?.key !== '' || receipt.folder !== true || !root.isDirectory() || receipt.identity !== root.dev + '/' + root.ino) {
      throw new Error('目标目录身份已变化 / Destination directory identity changed');
    }
  }
  await checked_root(dirname(backup));
  const present = await info(backup);
  if (!present && releasing) return { bytes: 0, allocated_bytes: 0, path: backup };
  if (!present) throw new Error('找不到已登记的备份 / Recorded backup missing: ' + backup);
  const entries = await inventory(backup, action !== 'list');
  if (entries[0].identity !== record.backup[0].identity) throw new Error('备份目录身份已变化 / Backup directory identity changed');
  if (action === 'list') return { path: backup, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    allocated_bytes: windows_stream_bytes(backup, entries, true) ?? entries.reduce((sum, entry) => sum + (entry.allocated || 0), 0) };
  require_match(entries, record.backup, releasing);
  windows_stream_bytes(backup, entries);
  if (action === 'release' && releasing) {
    for (const entry of entries.reverse()) {
      const path = join(backup, entry.key);
      await checked_root(path);
      const current = await lstat(path, { bigint: true });
      if (entry.identity !== current.dev + '/' + current.ino || (!entry.folder && entry.hash !== await digest(path))) {
        throw new Error('备份已变化 / Backup changed: ' + path);
      }
      if (entry.folder) await rmdir(path);
      else await unlink(path);
    }
  }
  return { path: backup };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const request = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify({ result: request.action ? await backup_operation(request) : await move_project_files(request) }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, rolled_back: error.rolled_back === true }));
    process.exitCode = 1;
  }
}

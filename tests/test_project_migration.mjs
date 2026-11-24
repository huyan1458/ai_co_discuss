import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { add_account, account_home, instance_home, mark_backup_release, read_accounts } from '../gateway/gateway.mjs';
import { list_migration_backups, migrate_account_data, release_migration_backup } from '../runner/admin_panel.mjs';
import { measure } from '../runner/storage_guard.mjs';
import { move_project_files } from '../runner/project_migration.mjs';

// Exercise stop, copy and registry switching independently of the sandbox's Windows ACL privileges.
function reserve_fixture(_data, _name, target) {
  mkdirSync(target);
  return target;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codiscuss-move-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, 'owner'), target = join(root, 'new'), name = 'tenant';
  add_account(data, name, 56439);
  const home = account_home(data, name), service = instance_home(data, name);
  await writeFile(join(home, 'projects', 'old.txt'), 'old room');
  return { data, target, home, service, name };
}

test('a stopped account resumes after source rename and its old absolute room path remains writable', async t => {
  const { home, service } = await fixture(t);
  const target = await mkdtemp(join(process.cwd(), '.migration-test-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await rename(join(home, 'projects'), join(home, 'projects.before-test'));
  await move_project_files({ service, previous: '', target, id: 'test' });
  await writeFile(join(home, 'projects', 'old.txt'), 'continued');
  assert.equal(await readFile(join(target, 'projects', 'old.txt'), 'utf8'), 'continued');
  assert.equal(await readFile(join(home, 'projects.before-test', 'old.txt'), 'utf8'), 'old room');
  assert.equal(JSON.parse(await readFile(join(service, 'local-settings.json'))).project_data_root, target);
});

test('nested links stop the migration and restore previous directories and settings', async t => {
  const { home, service, target } = await fixture(t);
  await mkdir(target);
  await symlink(service, join(home, 'workspace', 'outside'), 'junction');
  await assert.rejects(move_project_files({ service, previous: '', target, id: 'test' }), error => error.rolled_back);
  assert.equal((await lstat(join(home, 'projects'))).isSymbolicLink(), false);
  assert.equal(await readFile(join(home, 'projects', 'old.txt'), 'utf8'), 'old room');
  assert.equal(JSON.parse(await readFile(join(service, 'local-settings.json'))).project_data_root, undefined);
});

test('account migration never stops or copies into a sibling account', async t => {
  const { data, name } = await fixture(t);
  add_account(data, 'sibling');
  await assert.rejects(migrate_account_data(data, name, join(account_home(data, 'sibling'), 'new'), { stop: assert.fail }), /overlaps/);
  assert.equal(read_accounts(data)[name].project_migration, undefined);
});

test('administrator registry switches after a verified move and repeat submission is idempotent', async t => {
  const { data, target, name } = await fixture(t);
  let stops = 0;
  const stop = async () => {
    assert.equal(read_accounts(data)[name].project_migration.target, target);
    stops++;
  };
  await migrate_account_data(data, name, target, { stop, reserve: reserve_fixture });
  await migrate_account_data(data, name, target, { stop, reserve: reserve_fixture });
  assert.equal(stops, 1);
  assert.equal(read_accounts(data)[name].project_data_root, target);
  assert.equal(read_accounts(data)[name].project_migration, undefined);
});

test('a service process still holding the account lock prevents switching its data path', async t => {
  const { data, name, target, service, home } = await fixture(t);
  await writeFile(join(service, 'runner.lock'), String(process.pid));
  await assert.rejects(migrate_account_data(data, name, target, { stop: async () => {}, reserve: reserve_fixture }), /still running/);
  assert.equal(read_accounts(data)[name].project_data_root, undefined);
  assert.equal(read_accounts(data)[name].project_migration, undefined);
  assert.equal((await lstat(join(home, 'projects'))).isSymbolicLink(), false);
});

test('draft backup is inventoried outside the quota, lookalikes count, confirmed release resumes and preserves the junction', async t => {
  const { data, name, service, target } = await fixture(t);
  const drafts = join(service, 'drafts');
  await mkdir(drafts);
  await writeFile(join(drafts, 'one'), 'one');
  await writeFile(join(drafts, 'two'), 'two');
  const stop = async () => {};
  await migrate_account_data(data, name, target, { reserve: reserve_fixture, stop });
  const row = (await list_migration_backups(data, name)).find(item => item.kind === 'drafts');
  assert.equal(row.bytes, 6);
  assert.ok(Number.isSafeInteger(row.allocated_bytes) && row.allocated_bytes >= 0);
  const check = () => measure(service, { drafts_root: join(target, 'drafts') });
  const before = await check();
  await mkdir(join(service, 'drafts.before-lookalike'));
  await writeFile(join(service, 'drafts.before-lookalike', 'one'), 'counted');
  assert.equal((await check()).total_bytes - before.total_bytes, 7);
  await assert.rejects(release_migration_backup(data, name, row, assert.fail), /confirm/);
  mark_backup_release(data, name, row.id, row.kind, false);
  await rm(join(row.path, 'one'));
  await writeFile(join(drafts, 'two'), 'new');
  assert.equal((await list_migration_backups(data, name)).find(item => item.kind === 'drafts').bytes, 3);
  await release_migration_backup(data, name, { ...row, confirm: true }, stop);
  assert.equal((await check()).total_bytes, before.total_bytes + 7);
  assert.equal(await readFile(join(drafts, 'one'), 'utf8'), 'one');
  assert.equal(await readFile(join(drafts, 'two'), 'utf8'), 'new');
  assert.equal((await list_migration_backups(data, name)).some(item => item.kind === 'drafts'), false);
});

test('release preserves new, removed and edited files in the active project', async t => {
  const { data, name, target, home } = await fixture(t), stop = async () => {};
  const projects = join(home, 'projects');
  await writeFile(join(projects, 'remove.txt'), 'old');
  await migrate_account_data(data, name, target, { reserve: reserve_fixture, stop });
  const row = (await list_migration_backups(data, name)).find(item => item.kind === 'projects');
  await writeFile(join(projects, 'old.txt'), 'modified');
  await rm(join(projects, 'remove.txt'));
  await writeFile(join(projects, 'new.txt'), 'new');
  await release_migration_backup(data, name, { ...row, confirm: true }, stop);
  await assert.rejects(lstat(row.path), { code: 'ENOENT' });
  await assert.rejects(lstat(join(projects, 'remove.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(join(projects, 'new.txt'), 'utf8'), 'new');
  assert.equal(await readFile(join(target, 'projects', 'old.txt'), 'utf8'), 'modified');
});

test('release refuses a replaced target directory, altered backup contents or a substituted backup root', async t => {
  const { data, name, target } = await fixture(t), stop = async () => {};
  await migrate_account_data(data, name, target, { reserve: reserve_fixture, stop });
  const row = (await list_migration_backups(data, name)).find(item => item.kind === 'projects');
  const release = () => release_migration_backup(data, name, { ...row, confirm: true }, stop);
  const destination = join(target, 'projects');
  await rename(destination, destination + '.saved');
  await mkdir(destination);
  await assert.rejects(release(), /Destination directory identity/);
  await rename(destination, destination + '.replacement');
  await rename(destination + '.saved', destination);
  await writeFile(join(row.path, 'old.txt'), 'tampered');
  await assert.rejects(release(), /differs/);
  assert.equal(await readFile(join(row.path, 'old.txt'), 'utf8'), 'tampered');
  await rename(row.path, row.path + '.saved');
  await mkdir(row.path);
  await writeFile(join(row.path, 'old.txt'), 'old room');
  await assert.rejects(release(), /identity/);
  assert.equal(await readFile(join(row.path, 'old.txt'), 'utf8'), 'old room');
});

test('release keeps Windows named streams that were not copied into the active project', { skip: process.platform !== 'win32' }, async t => {
  const { data, name, target } = await fixture(t), stop = async () => {};
  await migrate_account_data(data, name, target, { reserve: reserve_fixture, stop });
  const row = (await list_migration_backups(data, name)).find(item => item.kind === 'projects');
  const stream = join(row.path, 'old.txt') + ':notes';
  await writeFile(stream, 'preserve');
  await assert.rejects(release_migration_backup(data, name, { ...row, confirm: true }, stop), /streams/);
  assert.equal(await readFile(stream, 'utf8'), 'preserve');
});

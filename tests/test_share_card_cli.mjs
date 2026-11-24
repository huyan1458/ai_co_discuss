import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { realtime_model, timeline_segments } from '../frontend/timeline-model.js';
import { TASK_SUBCOMMANDS } from '../runner/expert_prompts.mjs';
import english from '../runner/i18n_en.mjs';
import {
  browser_render_args,
  classify_browser_exit_error,
  find_browser,
  is_allowed_render_url,
  RENDER_CSP,
  render_share_card_html,
  resolve_materials_auth,
  resolve_member_render_roots,
  share_card_cli,
  share_card_materials,
} from '../runner/share_card.mjs';
import { collaboration_metrics } from '../runner/timeline_metrics.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'runner', 'codiscuss.mjs');

// Minimal valid 1x1 PNG (67 bytes) for deterministic tests without relying on external assets.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function member_dir(base, name) {
  return join(base, createHash('sha256').update(String(name)).digest('hex').slice(0, 16));
}

function service_drafts_dir(home, data_dir) {
  return join(home, 'drafts', createHash('sha256').update(resolve(data_dir)).digest('hex'));
}

test('shared timeline_metrics matches frontend timeline-model exports and calculations', () => {
  const executions = [
    { source: 'free', id: 1, member: 'Claude', state: 'done', task_id: 10, task_author: '用户', task: '做个官网', queued_at: 1000, dispatched_at: 1005, finished_at: 1065, segments: [] },
    { source: 'free', id: 2, member: 'Codex', state: 'done', task_id: 11, task_author: 'Claude', task: '写前端', queued_at: 1065, dispatched_at: 1065, finished_at: 1185 },
    { source: 'free', id: 3, member: 'Gemini', state: 'done', task_id: 11, task_author: 'Claude', task: '配图', queued_at: 1065, dispatched_at: 1065, finished_at: 1125 },
  ];
  const now_ms = 2000 * 1000;
  const from_frontend = realtime_model(timeline_segments(executions, now_ms));
  const metrics = collaboration_metrics(executions, now_ms);

  assert.equal(metrics.runs, from_frontend.runs);
  assert.equal(metrics.runs, 3);
  assert.equal(metrics.self_started, 2);
  assert.equal(metrics.self_started_percent, 67);
  assert.equal(metrics.peak_concurrency, 2);
  assert.equal(metrics.busy_ms, from_frontend.busy_ms);
  assert.equal(metrics.busy_percent, 100);
  assert.equal(metrics.unattended.duration_ms, from_frontend.unattended.end - from_frontend.unattended.start);
  assert.deepEqual(metrics.model.steps, from_frontend.steps);
});

test('share_card_materials enforces bound site matching and read-only cross-room rules without leaking tokens', async () => {
  const access = { site: 'http://room.test', room: 'r1', member: 'Gemini', token: 'secret-room1-token-abcdefghijklmnopqrstuvwxyz' };

  const same = resolve_materials_auth({ room_id: 'r1', access });
  assert.equal(same.site, 'http://room.test');
  assert.equal(same.cross_room, false);
  assert.deepEqual(same.headers, { 'X-Discussion-Token': access.token });

  const cross = resolve_materials_auth({ room_id: 'r2', access });
  assert.equal(cross.site, 'http://room.test');
  assert.equal(cross.cross_room, true);
  assert.deepEqual(cross.headers, { 'X-Discussion-Read-Only': '1' });
  assert.equal(cross.headers['X-Discussion-Token'], undefined);

  let fetched = 0;
  const spy_fetch = async () => { fetched += 1; throw new Error('must not fetch'); };
  await assert.rejects(
    share_card_materials({ site: 'https://evil.example', room_id: 'r1', access, fetcher: spy_fetch }),
    (error) => error.code === 'auth',
  );
  await assert.rejects(
    share_card_materials({ room_id: 'r1', access, env: { DISCUSS_URL: 'https://evil.example' }, fetcher: spy_fetch }),
    (error) => error.code === 'auth',
  );
  assert.equal(fetched, 0, 'no network request may fire when site mismatches task credential');

  const seen_headers = [];
  const cross_fetcher = async (url, init) => {
    seen_headers.push(init.headers);
    const pathname = new URL(url).pathname;
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/rooms/r2') return reply({ id: 'r2', title: 'Other', members: [] });
    if (pathname === '/api/rooms/r2/messages') return reply({ messages: [], has_more: false });
    if (pathname === '/api/rooms/r2/timeline') return reply({ now: 1000, earlier: false, executions: [] });
    return reply({ sites: [] });
  };
  const cross_data = await share_card_materials({ room_id: 'r2', access, fetcher: cross_fetcher });
  assert.equal(cross_data.room.id, 'r2');
  assert.ok(seen_headers.length >= 3);
  assert.ok(seen_headers.every((h) => h['X-Discussion-Read-Only'] === '1' && !h['X-Discussion-Token']));
});

test('share_card_materials filters withdrawn items, rewrites project paths, skips question receipts, quotes filenames, and flags truncation', async () => {
  const calls = [];
  const fetcher = async (url) => {
    const parsed = new URL(url);
    calls.push(`${parsed.pathname}${parsed.search}`);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (parsed.pathname === '/api/rooms/r1') {
      return reply({
        id: 'r1',
        title: '拾光咖啡',
        goal: '在 D:\\WorkSpace\\coffee_app 里做出完整的品牌上线材料',
        created_at: '2026-11-23T00:00:00Z',
        members: [
          { name: 'Claude', label: 'Claude', role: 'host', status: 'active', adapter: 'claude' },
          { name: 'Codex', label: 'Codex', role: 'member', status: 'active', adapter: 'codex_cli' },
          { name: 'OldAI', label: 'OldAI', role: 'member', status: 'removed', adapter: 'api' },
        ],
      });
    }
    if (parsed.pathname === '/api/rooms/r1/messages') {
      const after = Number(parsed.searchParams.get('after') || 0);
      if (after === 0) {
        return reply({
          messages: [
            { id: 1, author: '用户', text: '回答问题 #9：选 A', created_at: '2026-11-23T01:00:00Z' },
            { id: 2, author: '用户', text: '请主持人先讨论并给推荐（问题 #10）', created_at: '2026-11-23T01:00:10Z' },
            { id: 3, author: '用户', text: '交给主持人决定（问题 #11）', created_at: '2026-11-23T01:00:20Z' },
            { id: 4, author: '用户', text: '帮我们从零做出拾光咖啡官网和宣传海报', created_at: '2026-11-23T01:01:00Z' },
            { id: 5, author: 'Claude', text: '已撤回的草稿，不应出现', withdrawn: 'retracted', created_at: '2026-11-23T01:02:00Z' },
          ],
          has_more: true,
          next_after: 5,
        });
      }
      return reply({
        messages: [
          { id: 6, author: 'Claude', summary: '包含敏感 key sk-live_1234567890abcdefghijklmnop', text: 'secret sk-live_1234567890abcdefghijklmnop', created_at: '2026-11-23T01:05:00Z' },
          {
            id: 7,
            author: 'Codex',
            summary: '已生成 D:\\WorkSpace\\coffee_app\\dist\\index.html 和海报',
            text: '项目路径 D:\\WorkSpace\\coffee_app\\src\\home.vue 与 C:\\Users\\Alice\\demo 已清理',
            created_at: '2026-11-23T01:10:00Z',
            attachments: [
              { id: 'att-img', file_name: 'final poster 100%.png', size: 102400, content_type: 'image/png' },
              { id: 'att-zip', file_name: 'bundle.zip', size: 512000, content_type: 'application/zip' },
            ],
          },
        ],
        has_more: false,
      });
    }
    if (parsed.pathname === '/api/rooms/r1/timeline') {
      const before = Number(parsed.searchParams.get('before') || 0);
      if (!before) {
        return reply({
          now: 2000,
          earlier: true,
          executions: [
            { source: 'free', id: 20, member: 'Codex', state: 'done', task_id: 4, task_author: 'Claude', answer_id: 7, queued_at: 1060, dispatched_at: 1060, finished_at: 1180 },
            // Touches withdrawn message #5 -> excluded from metrics and curve.
            { source: 'free', id: 19, member: 'Claude', state: 'done', task_id: 4, task_author: '用户', answer_id: 5, queued_at: 1020, dispatched_at: 1020, finished_at: 1050 },
            { source: 'external', id: 18, member: 'Ext', state: 'done', task_id: 4, task_author: 'Claude', queued_at: 1060, dispatched_at: 1060, finished_at: 1100 },
          ],
        });
      }
      return reply({
        now: 2000,
        earlier: true, // Still more pages -> verifies timeline_truncated when capped at 2 pages.
        executions: [
          { source: 'free', id: 10, member: 'Claude', state: 'done', task_id: 4, task_author: '用户', answer_id: 6, queued_at: 1000, dispatched_at: 1000, finished_at: 1080 },
        ],
      });
    }
    if (parsed.pathname === '/api/rooms/r1/sites') {
      return reply({
        sites: [
          { site_id: 'abcdefghij', title: '拾光咖啡官网', url: 'https://abcdefghij.bimcanvas.com', status: 'active', expires_at: '2026-11-30T00:00:00Z' },
          { site_id: 'zzzzzzzzzz', title: '旧版', url: 'https://zzzzzzzzzz.bimcanvas.com', status: 'revoked' },
        ],
      });
    }
    if (parsed.pathname === '/api/rooms') {
      return reply({
        rooms: [
          { id: 'r1', title: '拾光咖啡', share_link: { url: 'https://share.codiscuss.com/s/FEyQ_JE1_Pn5emRPvotRnA', expires_at: '2026-11-30T17:17:00Z' } },
        ],
      });
    }
    return reply({ error: 'not found' }, 404);
  };

  const data = await share_card_materials({
    site: 'http://room.test',
    room_id: 'r1',
    token: 'member-tok',
    folders: ['D:\\WorkSpace\\coffee_app'],
    max_timeline_pages: 2,
    fetcher,
  });
  assert.equal(data.room.title, '拾光咖啡');
  assert.ok(!data.room.goal.includes('D:\\WorkSpace\\coffee_app'), 'project folder in goal must be rewritten');
  assert.deepEqual(data.room.members.map((m) => m.label), ['Claude', 'Codex']);
  assert.equal(data.metrics.runs, 2);
  assert.equal(data.metrics.self_started, 1);
  assert.equal(data.metrics.peak_concurrency, 2);
  assert.equal(data.scope.timeline_truncated, true);
  assert.equal(data.scope.messages_truncated, false);
  assert.equal(data.scope.truncated, true);
  // Skipped all three question receipts (#1, #2, #3) and picked #4.
  assert.equal(data.materials.opening_request.id, 4);
  assert.ok(!data.materials.highlights.some((m) => m.id === 5));
  const flagged = data.materials.highlights.find((m) => m.id === 6);
  assert.equal(flagged.sensitive_flagged, true);
  assert.equal(flagged.excerpt, '');
  assert.equal(flagged.summary, '');
  const clean_msg = data.materials.highlights.find((m) => m.id === 7);
  assert.ok(!clean_msg.excerpt.includes('D:\\WorkSpace\\coffee_app'), 'project path in excerpt must be rewritten');
  assert.ok(clean_msg.excerpt.includes('src\\home.vue'));
  assert.ok(clean_msg.summary.includes('dist\\index.html'));
  assert.ok(clean_msg.excerpt.includes('~\\demo') || clean_msg.excerpt.includes('~/demo'));
  assert.equal(data.materials.images.length, 1);
  assert.equal(data.materials.images[0].file_name, 'final poster 100%.png');
  assert.equal(data.materials.images[0].suggested_file_name, 'final poster 100_.png');
  assert.ok(data.materials.images[0].download_command.includes('--dest "./final poster 100_.png"'));
  assert.equal(data.materials.sites.length, 1);
  assert.equal(data.materials.share_link?.url, 'https://share.codiscuss.com/s/FEyQ_JE1_Pn5emRPvotRnA');
  assert.equal(data.copy_spec?.fence, 'share-copy');
  assert.equal(data.copy_spec?.share_url_placeholder, '{{share_url}}');
  assert.ok(calls.some((path) => path.includes('before=19')));

  const partial = await share_card_materials({ site: 'http://room.test', room_id: 'r1', max_message_pages: 1, fetcher });
  assert.equal(partial.scope.messages_truncated, true);
  assert.equal(partial.metrics.runs, 0, 'runs linked to an unread answer cannot be confirmed shareable');

  // Room containing ONLY question receipts must omit opening_request (return null).
  const receipts_only_fetcher = async (url) => {
    const pathname = new URL(url).pathname;
    const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (pathname === '/api/rooms/r-only') return reply({ id: 'r-only', title: 'Only Receipts', members: [] });
    if (pathname === '/api/rooms/r-only/messages') {
      return reply({
        messages: [
          { id: 1, author: '用户', text: '回答问题 #1：B' },
          { id: 2, author: '用户', text: '交给主持人决定（问题 #2）' },
        ],
        has_more: false,
      });
    }
    if (pathname === '/api/rooms/r-only/timeline') return reply({ now: 1000, earlier: false, executions: [] });
    return reply({ sites: [] });
  };
  const receipts_only = await share_card_materials({ site: 'http://room.test', room_id: 'r-only', fetcher: receipts_only_fetcher });
  assert.equal(receipts_only.materials.opening_request, null);
});

test('find_browser uses trusted OS install locations, browser_render_args uses private pipe with no TCP debug port, and sandbox error is classified', () => {
  assert.equal(find_browser({ platform: 'linux', env: { CODISCUSS_BROWSER: '/tmp/evil' }, exists: (p) => p === '/tmp/evil', is_file: () => true }), '');
  assert.equal(
    find_browser({
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Alice\\AppData\\Local' },
      exists: (p) => p.includes('AppData\\Local'),
      is_file: () => true,
    }),
    '',
  );
  assert.equal(
    find_browser({
      platform: 'darwin',
      env: {},
      exists: (path) => path === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      is_file: () => true,
    }),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  );

  const args = browser_render_args('/tmp/isolated-profile', { scale: 2 });
  assert.ok(!args.includes('--no-sandbox'), 'sandbox must stay enabled');
  assert.ok(!args.some((flag) => flag.startsWith('--remote-debugging-port')), 'must not expose a TCP debugging port');
  assert.ok(args.includes('--remote-debugging-pipe'), 'must use process-private debugging pipe');
  assert.ok(args.includes('--user-data-dir=/tmp/isolated-profile'));
  assert.ok(args.includes('--headless=new'));

  assert.equal(is_allowed_render_url('http://127.0.0.1:4444/tok/index.html', 'http://127.0.0.1:4444/tok/'), true);
  assert.equal(is_allowed_render_url('data:image/png;base64,AAA', 'http://127.0.0.1:4444/tok/'), true);
  assert.equal(is_allowed_render_url('http://127.0.0.1:8765/api/rooms', 'http://127.0.0.1:4444/tok/'), false);
  assert.equal(is_allowed_render_url('https://example.com', 'http://127.0.0.1:4444/tok/'), false);
  assert.equal(is_allowed_render_url('file:///etc/passwd', 'http://127.0.0.1:4444/tok/'), false);

  const sandbox_err = classify_browser_exit_error(1, 'ERROR:zygote_host_impl_linux.cc(100)] Running as root without --no-sandbox is not supported.');
  assert.equal(sandbox_err.code, 'browser_sandbox_unavailable');
  assert.match(sandbox_err.message, /沙箱|sandbox/i);
  const generic_err = classify_browser_exit_error(null, 'crash');
  assert.equal(generic_err.code, 'browser_launch_failed');
});

test('render_share_card_html uses real data_directory config, stable member keys, auto access, and own runtime read access', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'share-card-perm-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const project = join(base, 'project');
  const extra = join(base, 'extra');
  const outside = join(base, 'outside');
  const data_dir = join(base, 'launches', 'roomhash', 'runtime');
  const derived_drafts_base = service_drafts_dir(home, data_dir);

  const reader_drafts = member_dir(derived_drafts_base, 'Claude');
  const auto_drafts = member_dir(derived_drafts_base, 'Antigravity');
  const none_drafts = member_dir(derived_drafts_base, 'Isolated');
  const reader_runtime = member_dir(join(data_dir, 'members'), 'Claude');
  const auto_runtime = member_dir(join(data_dir, 'members'), 'Antigravity');
  for (const dir of [home, project, extra, outside, reader_drafts, auto_drafts, none_drafts, reader_runtime, auto_runtime]) {
    mkdirSync(dir, { recursive: true });
  }

  // Real on-disk launch config shape: `data_directory` (no `directory`), `draft_directory` omitted to test derivation,
  // member `Antigravity` with display label `Gemini` and `project_access: 'auto'`.
  const config_path = join(base, 'launch.json');
  writeFileSync(config_path, JSON.stringify({
    room: 'room1',
    site: 'http://room.test',
    cwd: project,
    extra_directories: [extra],
    data_directory: data_dir,
    participants: {
      Claude: { label: 'ReaderLabel', adapter: 'claude', project_access: 'read' },
      Antigravity: { label: 'Gemini', adapter: 'antigravity_cli', project_access: 'auto' },
      Isolated: { label: 'Isolated', adapter: 'claude', project_access: 'none' },
    },
  }));
  writeFileSync(join(home, 'rooms.json'), JSON.stringify({ configs: [config_path] }));

  const html_in_project = join(project, 'cover.html');
  const html_in_outside = join(outside, 'secret.html');
  const html_in_reader_runtime = join(reader_runtime, 'task-copy.html');
  const html_in_other_runtime = join(auto_runtime, 'other-copy.html');
  const html_in_reader_drafts = join(reader_drafts, 'mine.html');
  const html_in_none_drafts = join(none_drafts, 'mine.html');
  for (const file of [html_in_project, html_in_outside, html_in_reader_runtime, html_in_other_runtime, html_in_reader_drafts, html_in_none_drafts]) {
    writeFileSync(file, '<!doctype html><html><body>Hi</body></html>');
  }

  const stub_capture = async () => ({ png: TINY_PNG, measured_height: 500, final_height: 500 });
  const stub_browser = () => '/usr/bin/chromium';

  const reader_access = { site: 'http://room.test', room: 'room1', member: 'Claude', token: 't1' };
  const auto_access = { site: 'http://room.test', room: 'room1', member: 'Antigravity', token: 't2' };
  const label_spoof_access = { site: 'http://room.test', room: 'room1', member: 'Gemini', token: 't2' };
  const none_access = { site: 'http://room.test', room: 'room1', member: 'Isolated', token: 't3' };

  // Stable member key check: display label ("Gemini") must NOT match participant key ("Antigravity").
  assert.throws(() => resolve_member_render_roots(label_spoof_access, home), (error) => error.code === 'auth');

  // Read-only member can read its OWN runtime dir (from `data_directory`) and write to its derived drafts dir.
  const ok_runtime = await render_share_card_html({
    html_path: html_in_reader_runtime,
    out_path: join(reader_drafts, 'from-runtime.png'),
    access: reader_access,
    home,
    browser_resolver: stub_browser,
    capture_override: stub_capture,
  });
  assert.equal(existsSync(ok_runtime.output), true);

  // Read-only member CANNOT write into its runtime dir, project dir, or read another member's runtime dir.
  for (const [src, dst] of [
    [html_in_reader_drafts, join(reader_runtime, 'no-write.png')],
    [html_in_reader_drafts, join(project, 'blocked.png')],
    [html_in_other_runtime, join(reader_drafts, 'blocked.png')],
    [html_in_outside, join(reader_drafts, 'blocked.png')],
  ]) {
    await assert.rejects(
      render_share_card_html({ html_path: src, out_path: dst, access: reader_access, home, browser_resolver: stub_browser, capture_override: stub_capture }),
      (error) => error.code === 'auth',
    );
  }

  // `project_access: 'auto'` member CAN write to project and extra dirs, NOT outside.
  const ok_auto = await render_share_card_html({
    html_path: html_in_project,
    out_path: join(extra, 'auto-cover.png'),
    access: auto_access,
    home,
    browser_resolver: stub_browser,
    capture_override: stub_capture,
  });
  assert.equal(existsSync(ok_auto.output), true);
  await assert.rejects(
    render_share_card_html({ html_path: html_in_project, out_path: join(outside, 'escape.png'), access: auto_access, home, browser_resolver: stub_browser, capture_override: stub_capture }),
    (error) => error.code === 'auth',
  );

  // `project_access: 'none'` member CANNOT read project HTML, CAN render inside its own drafts.
  await assert.rejects(
    render_share_card_html({ html_path: html_in_project, out_path: join(none_drafts, 'blocked.png'), access: none_access, home, browser_resolver: stub_browser, capture_override: stub_capture }),
    (error) => error.code === 'auth',
  );
  const ok_none = await render_share_card_html({
    html_path: html_in_none_drafts,
    out_path: join(none_drafts, 'ok.png'),
    access: none_access,
    home,
    browser_resolver: stub_browser,
    capture_override: stub_capture,
  });
  assert.equal(existsSync(ok_none.output), true);
});

test('render_share_card_html handles % filenames, malformed percent-escapes, failure cleanup, CSP, and missing browser', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'share-card-unit-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const html = join(work, 'cover.html');
  const pct_png = join(work, '100%.png');
  const sibling_js = join(work, 'evil.js');
  const out = join(work, 'out', 'cover.png');
  writeFileSync(html, '<!doctype html><html><body><h1>Hi</h1><img src="100%25.png"></body></html>');
  writeFileSync(pct_png, TINY_PNG);
  writeFileSync(sibling_js, 'alert(1)');

  await assert.rejects(
    render_share_card_html({ html_path: html, out_path: out, browser_resolver: () => '' }),
    (error) => error.code === 'browser_missing' && /浏览器|browser/i.test(error.message),
  );

  let captured_profile = '';
  const receipt = await render_share_card_html({
    html_path: html,
    out_path: out,
    browser_resolver: () => '/usr/bin/chromium',
    capture_override: async ({ args, profile_dir, url, prefix_url }) => {
      captured_profile = profile_dir;
      assert.ok(existsSync(profile_dir));
      assert.ok(args.includes('--remote-debugging-pipe'));
      const root_res = await fetch(url);
      assert.equal(root_res.status, 200);
      assert.equal(root_res.headers.get('content-security-policy'), RENDER_CSP);
      // Valid percent-encoded filename containing '%' works (200), malformed '%ZZ' returns 400 without crashing server!
      assert.equal((await fetch(`${prefix_url}100%25.png`)).status, 200);
      assert.equal((await fetch(`${prefix_url}100%.png`)).status, 400);
      assert.equal((await fetch(`${prefix_url}bad%ZZ.png`)).status, 400);
      assert.equal((await fetch(`${prefix_url}evil.js`)).status, 403);
      assert.equal((await fetch(`${prefix_url}../secret.txt`)).status, 404);
      // Server still alive and responsive after malformed escape requests.
      assert.equal((await fetch(url)).status, 200);
      return { png: TINY_PNG, measured_height: 640, final_height: 640 };
    },
  });
  assert.equal(existsSync(captured_profile), false, 'temporary browser profile must be cleaned up on success');
  assert.equal(receipt.output, out);

  // Failed render must still clean up temporary profile directory and close the static server.
  let failed_profile = '';
  let failed_url = '';
  await assert.rejects(
    render_share_card_html({
      html_path: html,
      out_path: out,
      browser_resolver: () => '/usr/bin/chromium',
      capture_override: async ({ profile_dir, url }) => {
        failed_profile = profile_dir;
        failed_url = url;
        throw new Error('simulated render crash');
      },
    }),
    /simulated render crash/,
  );
  assert.equal(existsSync(failed_profile), false, 'temporary browser profile must be cleaned up on failure');
  await assert.rejects(fetch(failed_url), 'ephemeral static server must be closed after render failure');
});

test('share_card_cli blocks restricted runs, rejects --browser, has complete English translations, and exposes bilingual help', async () => {
  assert.ok(TASK_SUBCOMMANDS.includes('share-card'), 'member TASK_SUBCOMMANDS must include share-card');

  // Verify every t(...) literal in runner/share_card.mjs and runner/codiscuss.mjs has an English entry in runner/i18n_en.mjs.
  const call_pattern = /(?<![\w.$])t\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  const missing = [];
  for (const rel of ['runner/share_card.mjs', 'runner/codiscuss.mjs']) {
    const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
    for (const match of src.matchAll(call_pattern)) {
      if (match[1] === '`' && match[2].includes('${')) continue;
      const key = match[2].replace(/\\(["'`\\])/g, '$1').replace(/\\n/g, '\n');
      if (!english[key]) missing.push(`${rel}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], `Missing English CLI translations: ${missing.join(', ')}`);

  let err_out = '';
  const prev_exit = process.exitCode;
  await share_card_cli(['materials', 'room1'], {
    env: { CODISCUSS_TOOL_LOCKDOWN: '1' },
    stdout: { write() {} },
    stderr: { write(chunk) { err_out += chunk; } },
  });
  process.exitCode = prev_exit;
  assert.equal(JSON.parse(err_out).error.code, 'lockdown');

  let flag_err = '';
  await share_card_cli(['render', 'a.html', '--out', 'b.png', '--browser', 'cmd.exe'], {
    env: {},
    stdout: { write() {} },
    stderr: { write(chunk) { flag_err += chunk; } },
  });
  process.exitCode = prev_exit;
  assert.equal(JSON.parse(flag_err).ok, false);
  assert.equal(JSON.parse(flag_err).error.code, 'invalid_option');

  const zh_help = spawnSync(process.execPath, [CLI, 'share-card', '--help'], { encoding: 'utf8', env: { ...process.env, CODISCUSS_LANG: 'zh-CN' } });
  assert.equal(zh_help.status, 0, zh_help.stderr);
  assert.match(zh_help.stdout, /share-card materials/);
  assert.match(zh_help.stdout, /share-card render/);
  assert.doesNotMatch(zh_help.stdout, /--browser/);

  const en_help = spawnSync(process.execPath, [CLI, 'share-card', '--help'], { encoding: 'utf8', env: { ...process.env, CODISCUSS_LANG: 'en' } });
  assert.equal(en_help.status, 0, en_help.stderr);
  assert.match(en_help.stdout, /Share-Card Cover Tool/);
  assert.match(en_help.stdout, /private process pipe/i);
  assert.doesNotMatch(en_help.stdout, /--browser/);

  const main_en = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env: { ...process.env, CODISCUSS_LANG: 'en' } });
  assert.equal(main_en.status, 0, main_en.stderr);
  assert.match(main_en.stdout, /share-card COMMAND/);
});

test('real local browser renders static HTML + SVG + % image via private pipe while blocking meta refresh navigation', async (t) => {
  const browser = find_browser();
  if (!browser) {
    t.skip('No local Chromium/Edge browser installed in trusted locations');
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'share-card-e2e-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const html = join(work, 'cover.html');
  const out = join(work, 'cover.png');
  writeFileSync(join(work, '100%.png'), TINY_PNG);
  let navigations = 0;
  const destination = createServer((_request, response) => {
    navigations++;
    response.end('Another page');
  });
  await new Promise(resolve => destination.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => destination.close(resolve)));
  writeFileSync(
    html,
    `<!doctype html>
    <html lang="zh-CN"><head><meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=http://127.0.0.1:${destination.address().port}/another-page">
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 48px; width: 750px; background: #12141c; color: #f1f3f8; font-family: "Microsoft YaHei", sans-serif; }
      h1 { margin: 0 0 16px; font-size: 40px; }
      .card { min-height: 920px; padding: 24px; border-radius: 16px; background: #1c2235; border: 1px solid #8791ff44; }
      svg { display: block; width: 100%; height: 90px; margin-top: 20px; }
    </style></head><body>
      <h1>拾光咖啡 · 多 AI 协作战报</h1>
      <div class="card">
        <p>自动执行 1h 33m · 无需介入 92% · 最多同时 3 位</p>
        <img src="100%25.png" width="24" height="24" alt="dot" />
        <svg viewBox="0 0 600 90"><rect x="0" y="30" width="200" height="60" fill="#8791ff"/><rect x="210" y="10" width="390" height="80" fill="#4fb286"/></svg>
      </div>
    </body></html>`,
  );

  const run = await promisify(execFile)(process.execPath, [CLI, 'share-card', 'render', html, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, CODISCUSS_LANG: 'zh-CN', DISCUSS_ACCESS_FILE: '', DISCUSS_ACCESS: '' },
  });
  assert.equal(navigations, 0, 'the destination must never receive the navigation');
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.data.width_css_px, 750);
  assert.equal(receipt.data.width_px, 1500);
  assert.ok(receipt.data.height_px >= 2000 && receipt.data.height_px <= 3000, `unexpected height_px: ${receipt.data.height_px}`);
  assert.equal(receipt.data.clipped, false);
  assert.equal(existsSync(out), true);
  const png = readFileSync(out);
  assert.equal(png.readUInt32BE(16), 1500);
  assert.equal(png.readUInt32BE(20), receipt.data.height_px);
});

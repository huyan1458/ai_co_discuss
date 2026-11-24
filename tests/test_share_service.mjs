import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { room_share_job } from '../runner/discussion_launch.mjs';
import { request_share_job, start_share_manager } from '../runner/share_service.mjs';
import { SHARE_SITE } from '../runner/share_shared.mjs';

async function wait_for(read, predicate) {
  for (let i = 0; i < 200; i++) { const value = read(); if (predicate(value)) return value; await delay(10); }
  assert.fail('Job did not reach its expected phase');
}

test('managed shares preserve the reviewed snapshot, selections and room boundary across cancel, retry and restart', async () => {
  const saved_entry_key = process.env.DISCUSS_ENTRY_KEY_FILE;
  delete process.env.DISCUSS_ENTRY_KEY_FILE;
  const home = mkdtempSync(join(tmpdir(), 'share-job-')), project = join(home,'project');
  mkdirSync(project); writeFileSync(join(project,'report.md'),'delivered'); writeFileSync(join(home,'private.md'),'private');
  const room = 'testroom', path = '/api/rooms/' + room, token = 'owner';
  const text = 'person@example.org'; let question = 'question';
  const files = Array.from({ length: 7 }, (_, i) => ({ room_id: room, id: 'file'+i, file_name: 'file'+i+'.txt', size: text.length, content_type: 'text/plain' }));
  const info = { id: room, title:'Review', members: [], message_count: 2, free: { executions: [{ id: 4, created_at: 1 }] } };
  let link = null, notes = 0, secret_read = false;
  const server = createServer(async (req,res) => {
    const send = data => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(data)); };
    if (req.headers['x-discussion-token'] !== token) { res.statusCode=403; return send({ error:'wrong owner' }); }
    if (req.url === '/api/rooms') return send({ rooms: [info] });
    if (req.url === path) return send(info);
    if (req.url === path+'/inbox') return send({});
    if (req.url.startsWith(path+'/messages?')) return send({ messages: [
      { id: 1, author:'Owner', text:question, attachments: files },
      { id: 2, author:'Agent', execution_id: 4, text:'[report](report.md) [private](../private.md)' }], cards:{ executions:[{ id:4, notes:1 }] } });
    if (req.url.endsWith('/notes')) { notes++; return send({ notes:[] }); }
    if (req.url.endsWith('/timeline')) return send({ executions:[] });
    if (req.url === path+'/share-link') {
      if (req.method === 'POST') { let body=''; for await (const part of req) body+=part; link=JSON.parse(body).link; }
      return send({ link });
    }
    if (req.url.startsWith(path+'/attachments/file')) { return res.end(text); }
    secret_read = true; res.statusCode=404; send({});
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port, site = 'http://127.0.0.1:'+port;
  const config = join(home,'room.json'), json = (path, value) => writeFileSync(path, JSON.stringify(value));
  json(config,{ room, site, token, cwd:project }); json(join(home,'rooms.json'), { configs:[config] }); json(join(home,'local-settings.json'),{port});
  let active = 0, peak = 0, fail = false, transient = 0, slow = true, gone = true;
  const methods = [], bodies = [];
  const transport = {
    snapshot: async (path, method, body) => {
      methods.push(method); bodies.push(body);
      if (method === 'PUT' && gone) { gone = false; throw Object.assign(new Error('expired'), { status:410 }); }
      return { id:'S'.repeat(22), url:SHARE_SITE+'/s/'+'S'.repeat(22), manage_token:'T'.repeat(43), revision:'R'.repeat(22), expires_at:new Date(Date.now()+86400000).toISOString() };
    },
    file: async (url, headers, source, signal) => {
      assert.equal(new URL(url).origin, SHARE_SITE);
      peak=Math.max(peak,++active);
      try {
        let transferred=0;
        for await (const chunk of source) transferred+=chunk.length;
        assert.equal(transferred,headers['Content-Length']);
        await delay(slow ? 2000 : 20,undefined,{signal});
        if (transient > 0) { transient--; throw new Error('Client network socket disconnected before secure TLS connection was established'); }
        if (fail) throw new Error('receipt unavailable');
      } finally { active--; }
    }
  };
  let manager = start_share_manager(home,{transport});
  try {
    const prepare = { op:'prepare', room_id:room, room_title:'Review', locale:'zh-CN', token, site };
    await assert.rejects(room_share_job(home,{ ...prepare, token:'other' }), /wrong owner/);
    assert.deepEqual(await room_share_job(home,{ ...prepare, site:'https://different.test' }), {enabled:false});
    const id = (await room_share_job(home,prepare)).job.id;
    assert.equal(manager.command(prepare).job.id,id);
    const op=(op,fields={}) => manager.command({ op, id, room_id:room,...fields }).job;
    const ready=await wait_for(()=>op('get'),j=>j.phase==='ready');
    assert.equal(ready.summary.files.length,8); assert.equal(notes,1); assert.equal(ready.summary.file_spots.length,7);
    assert.ok(!JSON.stringify(ready).includes('responses')); assert.ok(!JSON.stringify(ready).includes(home.replaceAll('\\','\\\\')));
    assert.ok(!JSON.stringify(manager.command({op:'list'})).includes('file_name'));
    assert.throws(()=>op('get',{room_id:'other'}));
    const stored=join(home,'share-jobs',id,'payload.json'), raw=readFileSync(stored,'utf8');
    const selection={include_files:true,days:3,left_files:[ready.summary.files[0].route]};
    op('select',{selection}); op('publish');
    await wait_for(()=>active,v=>v===6);
    op('cancel'); await wait_for(()=>active,v=>v===0); assert.equal(op('get').phase,'cancelled');
    slow=false; fail=true; op('retry');
    const failed=await wait_for(()=>op('get'),j=>j.phase==='failed');
    assert.match(failed.error,/receipt/); assert.deepEqual(failed.selection,selection);
    assert.deepEqual(methods.slice(0,3),['POST','PUT','POST']); assert.equal(notes,1);
    assert.equal(Object.keys(bodies.at(-1).files).length,7); assert.equal(readFileSync(stored,'utf8'),raw);
    fail=false; slow=true; op('retry'); await wait_for(()=>active,v=>v===6); manager.close();
    await wait_for(()=>active,v=>v===0); manager=start_share_manager(home,{transport}); assert.equal(op('get').phase,'failed');
    assert.equal(op('get').error,'服务已重启，请重试');
    slow=false; transient=1; op('retry'); const done=await wait_for(()=>op('get'),j=>j.phase==='published');
    assert.equal(transient,0); assert.equal(peak,6); assert.equal(done.progress.done,7); assert.equal(done.progress.bytes_done,done.progress.bytes_total);
    assert.ok(done.result.updated); assert.equal(done.result.card.url,link.url); assert.ok(!JSON.stringify(done).includes(link.manage_token)); assert.equal(secret_read,false);
    op('dismiss'); assert.deepEqual(manager.command({op:'list'}).jobs,[]);

    // Imported rooms may not have a runner configuration. They can use room attachments, with no project directories.
    json(join(home,'rooms.json'), { configs:[] });
    files[0].size = 101 * 1024 * 1024;
    let next = (await room_share_job(home,prepare)).job.id;
    const apply = (op, selection) => manager.command({ op, id: next, room_id: room, token, selection }).job;
    const large = await wait_for(()=>apply('get'), j=>j.phase==='ready');
    assert.equal(large.summary.files.length,7);
    const published = methods.length;
    assert.throws(()=>apply('publish',{include_files:true}),/100 MiB/);
    apply('dismiss');
    for (const file of files) file.size = 50 * 1024 * 1024;
    next = (await room_share_job(home,prepare)).job.id;
    await wait_for(()=>apply('get'), j=>j.phase==='ready');
    assert.throws(()=>apply('publish',{include_files:true}),/300 MiB/);
    apply('dismiss'); question = 'x'.repeat(5 * 1024 * 1024);
    next = (await room_share_job(home,prepare)).job.id;
    await wait_for(()=>apply('get'), j=>j.phase==='ready');
    assert.throws(()=>apply('publish',{include_files:false}),/5 MiB/);
    assert.equal(methods.length,published,'size refusal precedes all public traffic');
    apply('dismiss');
    next = (await room_share_job(home,prepare)).job.id;
    manager.close(); manager = start_share_manager(home,{transport});
    assert.equal(apply('get').error,'服务已重启，请重试');
    apply('dismiss');
  } finally {
    if (saved_entry_key === undefined) delete process.env.DISCUSS_ENTRY_KEY_FILE; else process.env.DISCUSS_ENTRY_KEY_FILE = saved_entry_key;
    manager.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); rmSync(home,{recursive:true,force:true});
  }
  assert.deepEqual(await request_share_job(home,{op:'list'}),{enabled:false});
});


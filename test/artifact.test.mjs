import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, mkdir, readFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessBridge } from '../index.mjs';

// This native-CLI stand-in transfers an actual file written by the shipped
// observer. It verifies our producer/download seam, not upstream Docker/TG.
async function fixture(t, mode = 'ok') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote'); await mkdir(remote);
  const observer = (await readFile(new URL('../examples/groupweave/deploy/dsh/result-export.mjs', import.meta.url), 'utf8'))
    .replaceAll('/workspace/exports', remote);
  await writeFile(path.join(root, 'observer.mjs'), observer);
  const script = `#!${process.execPath}
import fs from 'node:fs';
import { apply } from './observer.mjs';
const root=${JSON.stringify(root)}, remote=${JSON.stringify(remote)}, mode=${JSON.stringify(mode)};
const a=process.argv.slice(2), i=a.indexOf('sandbox'), op=a[i+1];
fs.appendFileSync(root+'/calls.jsonl',JSON.stringify(a.slice(i))+'\\n');
const state=root+'/state.json';
let s=fs.existsSync(state)?JSON.parse(fs.readFileSync(state)):{phase:'empty'};
const save=()=>fs.writeFileSync(state,JSON.stringify(s));
if(op==='create') {const labels={};a.forEach((v,j)=>{if(v==='--label'){const [k,...vs]=a[j+1].split('=');labels[k]=vs.join('=')}});s={id:'native-1',name:a[a.indexOf('--name')+1],workspace:'default',phase:'running',labels};save();console.log(JSON.stringify(s));}
else if(op==='get') console.log(JSON.stringify(s));
else if(op==='upload') {}
else if(op==='exec') {
  let listener; apply({on(event,fn){if(event==='session/event')listener=fn;}});
  const session={};listener(session,{type:'turn/start'});
  listener(session,{type:'assistant/message',data:{message:{content:[{type:'text',text:'# Real producer output'}]}}});
  listener(session,{type:'turn/end',data:{reason:{kind:'completed'}}});
  if(mode==='oversize') fs.writeFileSync(remote+'/result.md','x'.repeat(64001));
  if(mode==='mismatch') fs.writeFileSync(remote+'/result.md','another task');
  if(mode==='symlink'){fs.renameSync(remote+'/result.md',remote+'/other');fs.symlinkSync(remote+'/other',remote+'/result.md');}
  if(mode==='identity'){s.id='replacement';save();}
  console.log(JSON.stringify({type:'session',sessionId:'session-1'}));
  console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}}));
  console.log(JSON.stringify({type:'final',text:'# Real producer output'}));
}
else if(op==='download') {
  if(a[i+3]!=='/workspace/exports/result.md')process.exit(3);
  if(mode==='missing')process.exit(1);
  if(mode==='symlink')fs.symlinkSync(remote+'/result.md',a[i+4]);
  else fs.copyFileSync(remote+'/result.md',a[i+4]);
}
else if(op==='stop'){s.phase='stopped';save();}
else if(op==='delete'){s.phase='deleted';save();}
else if(op==='list')console.log(JSON.stringify({sandboxes:s.phase==='deleted'?[]:[s],next_page_token:''}));
else process.exit(2);
`;
  const cliPath = path.join(root, 'openshell.mjs'); await writeFile(cliPath, script); await chmod(cliPath, 0o700);
  const patchPath = path.join(root, 'patch.json'); await writeFile(patchPath, '[]');
  const authorizations = [];
  const bridge = createHarnessBridge({ native: { cliPath, workspace: 'default', image: 'test', policyPath: patchPath, home: root, xdgConfigHome: root },
    dsh: { patchPath, downloadResult: true },
    authorizeAdmission() {},
    authorizeNativeCall(ctx) {authorizations.push(ctx.operation);if(mode==='denied'&&ctx.operation==='download')throw Error('revoked');},
    authorizeResult(ctx) { if(mode==='release-denied')throw Error('revoked'); },
  });
  const request = { taskId: 'task-1', tenantId: 'tenant-1', actorId: 'actor-1', prompt: 'export final response' };
  return { root, authorizations, result: await bridge.execute(request), calls: JSON.parse('['+(await readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').join(',')+']') };
}

test('actual trusted observer file is natively downloaded before stop/delete and released as bytes', async t => {
  const f = await fixture(t);
  assert.equal(f.result.status, 'completed');
  assert.equal(f.result.artifact.name, 'result.md');
  assert.equal(f.result.artifact.mediaType, 'text/markdown');
  assert.equal(Buffer.from(f.result.artifact.data).toString(), '# Real producer output');
  const download = f.calls.find(x => x[1] === 'download');
  assert.equal(download[3], '/workspace/exports/result.md');
  assert.ok(f.calls.findIndex(x => x[1] === 'download') < f.calls.findIndex(x => x[1] === 'stop'));
  assert.ok(f.authorizations.includes('download'));
  await assert.rejects(access(path.dirname(download[4])));
});

for (const mode of ['missing', 'oversize', 'symlink', 'mismatch', 'denied', 'release-denied']) {
  test(`${mode} export fails closed and still cleans sandbox/local files`, async t => {
    const f = await fixture(t, mode);
    assert.notEqual(f.result.status, 'completed');
    assert.equal(f.result.artifact, undefined);
    assert.equal(f.result.output, undefined);
    assert.equal(f.result.cleanup.status, 'verified');
    assert.ok(f.calls.some(x => x[1] === 'delete'));
    const download = f.calls.find(x => x[1] === 'download');
    if(download)await assert.rejects(access(path.dirname(download[4])));
  });
}

test('replaced sandbox identity blocks download', async t => {
  const f = await fixture(t, 'identity');
  assert.equal(f.result.status, 'blocked');
  assert.equal(f.result.artifact, undefined);
  assert.equal(f.calls.some(x => x[1] === 'download'), false);
});

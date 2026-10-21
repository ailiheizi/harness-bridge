import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessBridge } from '../index.mjs';

async function identityFixture(t, { authorizeAdmission, authorizeNativeCall, authorizeResult }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-acceptance-20261015-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state.json');
  const calls = path.join(root, 'calls.jsonl');
  const stdinPath = path.join(root, 'stdin.txt');
  const cli = path.join(root, 'fake-openshell.mjs');
  const impl = `${cli}-impl.mjs`;
  await writeFile(impl, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), base=args.indexOf('sandbox'), op=args[base+1], name=args[base+2];
const statePath=${JSON.stringify(state)}, callsPath=${JSON.stringify(calls)};
fs.appendFileSync(callsPath, JSON.stringify(args.slice(base))+'\\n');
let item=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null;
if(op==='create'){
 const labels={}; for(let i=0;i<args.length;i++) if(args[i]==='--label'){const [k,...v]=args[++i].split('=');labels[k]=v.join('=')}
 item={id:'native-acceptance',name:args[args.indexOf('--name')+1],workspace:'default',phase:'running',labels};
 fs.writeFileSync(statePath,JSON.stringify(item)); console.log(JSON.stringify(item)); process.exit(0);
}
if(op==='get'){if(!item||item.phase==='deleted')process.exit(1);console.log(JSON.stringify(item));process.exit(0)}
if(op==='list'){console.log(JSON.stringify({sandboxes:item&&item.phase!=='deleted'?[item]:[],next_page_token:''}));process.exit(0)}
if(op==='upload')process.exit(0);
if(op==='exec'){
 fs.writeFileSync(${JSON.stringify(stdinPath)},fs.readFileSync(0,'utf8'));
 console.log(JSON.stringify({type:'session',sessionId:'session-acceptance'}));
 console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}}));
 console.log(JSON.stringify({type:'final',text:'accepted'})); process.exit(0);
}
if(op==='stop'){item.phase='stopped';fs.writeFileSync(statePath,JSON.stringify(item));process.exit(0)}
if(op==='delete'){item.phase='deleted';fs.writeFileSync(statePath,JSON.stringify(item));process.exit(0)}
process.exit(2);
`);
  await writeFile(cli, `#!${process.execPath}\nimport ${JSON.stringify(impl)};\n`);
  await chmod(cli, 0o755);
  const policyPath = path.join(root, 'policy.yaml'); await writeFile(policyPath, 'fixture');
  const patchPath = path.join(root, 'patch.yml'); await writeFile(patchPath, 'fixture');
  const home = path.join(root, 'home'); await mkdir(home);
  const xdg = path.join(root, 'xdg'); await mkdir(xdg);
  const bridge = createHarnessBridge({
    native: { cliPath: cli, workspace: 'default', image: 'fixture:pinned', policyPath, home, xdgConfigHome: xdg },
    dsh: { patchPath },
    limits: { totalTimeoutMs: 20_000, commandTimeoutMs: 5000, maxOutputBytes: 16_384 },
    authorizeAdmission,
    authorizeNativeCall,
    authorizeResult,
  });
  return { bridge, readStdin: () => import('node:fs/promises').then(({ readFile }) => readFile(stdinPath, 'utf8')) };
}

test('tenant and actor identity cannot change while admission authorization is pending', async (t) => {
  let enteredAdmission;
  const entered = new Promise((resolve) => { enteredAdmission = resolve; });
  let releaseAdmission;
  const gate = new Promise((resolve) => { releaseAdmission = resolve; });
  const observed = { admission: [], native: [], result: [] };
  const fixture = await identityFixture(t, {
    authorizeAdmission: async ({ request }) => {
      observed.admission.push([request.tenantId, request.actorId]);
      enteredAdmission();
      await gate;
    },
    authorizeNativeCall: async ({ tenantId, actorId }) => observed.native.push([tenantId, actorId]),
    authorizeResult: async ({ request: authorizedRequest }) => observed.result.push([authorizedRequest.tenantId, authorizedRequest.actorId]),
  });
  const request = { taskId: 'task-stable', tenantId: 'tenant-alpha', actorId: 'actor-alpha', prompt: 'ordinary request' };
  const resultPromise = fixture.bridge.execute(request);
  await entered;
  request.tenantId = 'tenant-beta';
  request.actorId = 'actor-beta';
  request.prompt = 'changed while authorization is pending';
  releaseAdmission();
  const result = await resultPromise;
  assert.equal(result.status, 'completed', JSON.stringify({ result, observed }));
  assert.deepEqual(observed.admission, [['tenant-alpha', 'actor-alpha']]);
  assert.ok(observed.native.length > 0);
  assert.ok(observed.native.every(([tenant, actor]) => tenant === 'tenant-alpha' && actor === 'actor-alpha'));
  assert.deepEqual(observed.result, [['tenant-alpha', 'actor-alpha']]);
  assert.equal(await fixture.readStdin(), 'ordinary request');
});

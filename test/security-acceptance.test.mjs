import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessBridge } from '../index.mjs';

async function securityFixture(t, { onAuthorization = async () => {}, stopDelayMs = 0, gatewayEndpoint } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-security-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-openshell.mjs');
  const implementation = `${bin}-impl.mjs`;
  const state = path.join(root, 'sandboxes.json');
  const callsPath = path.join(root, 'calls.jsonl');
  const uploadsPath = path.join(root, 'uploads.jsonl');
  const probePath = path.join(root, 'probe.jsonl');
  const execInputPath = path.join(root, 'exec-input.txt');
  const program = `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2), base=a.indexOf('sandbox'), op=a[base+1], name=a[base+2];
const statePath=${JSON.stringify(state)}, callsPath=${JSON.stringify(callsPath)};
let all=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{};
fs.appendFileSync(callsPath,JSON.stringify(a.slice(base))+'\\n');
fs.appendFileSync(${JSON.stringify(probePath)},JSON.stringify({endpoint:process.env.OPENSHELL_GATEWAY_ENDPOINT??null,args:a.slice(base)})+'\\n');
if(op==='create'){
 const n=a[a.indexOf('--name')+1], labels={};
 for(let i=0;i<a.length;i++) if(a[i]==='--label'){const [k,...v]=a[++i].split('=');labels[k]=v.join('=')}
 all[n]={id:'native-'+Object.keys(all).length,name:n,workspace:'default',phase:'running',labels};
 fs.writeFileSync(statePath,JSON.stringify(all)); console.log(JSON.stringify(all[n])); process.exit(0);
}
if(op==='get'){
 const s=all[name]; if(!s||s.phase==='deleted'){console.error('sandbox not found');process.exit(1)}
 console.log(JSON.stringify(s));process.exit(0);
}
if(op==='list'){
 console.log(JSON.stringify({sandboxes:Object.values(all).filter(s=>s.phase!=='deleted'),next_page_token:''}));process.exit(0);
}
if(op==='upload'){fs.appendFileSync(${JSON.stringify(uploadsPath)},JSON.stringify(a.slice(base))+'\\n');process.exit(0)}
if(op==='exec'){
 fs.writeFileSync(${JSON.stringify(execInputPath)},fs.readFileSync(0,'utf8'));
 console.log(JSON.stringify({type:'session',sessionId:'synthetic-session'}));
 console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}}));
 console.log(JSON.stringify({type:'final',text:'synthetic result'}));process.exit(0);
}
if(op==='stop'){
 ${stopDelayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${stopDelayMs});` : ''}
 if(all[name]){all[name].phase='stopped';fs.writeFileSync(statePath,JSON.stringify(all))}process.exit(0);
}
if(op==='delete'){if(all[name]){all[name].phase='deleted';fs.writeFileSync(statePath,JSON.stringify(all))}process.exit(0)}
process.exit(2);
`;
  await writeFile(implementation, program);
  await writeFile(bin, `#!${process.execPath}\nimport ${JSON.stringify(implementation)};\n`);
  await chmod(bin, 0o755);
  const policyPath = path.join(root, 'policy.yaml'); await writeFile(policyPath, 'synthetic policy');
  const patchPath = path.join(root, 'patch.yml'); await writeFile(patchPath, 'synthetic patch');
  const home = path.join(root, 'home'); await mkdir(home);
  const xdg = path.join(root, 'xdg'); await mkdir(xdg);
  const auth = [];
  const bridge = createHarnessBridge({
    native: { cliPath: bin, workspace: 'default', image: 'fixture:pinned', policyPath, home, xdgConfigHome: xdg, ...(gatewayEndpoint ? { gatewayEndpoint } : {}) },
    dsh: { patchPath },
    limits: { totalTimeoutMs: 10_000, commandTimeoutMs: 2_000, maxOutputBytes: 16_384 },
    authorizeAdmission: async ({ request }) => { auth.push({ kind: 'admission', taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId }); await onAuthorization('admission', request); },
    authorizeNativeCall: async ({ operation, taskId, tenantId, actorId, sandbox }) => { auth.push({ kind: 'native', operation, taskId, tenantId, actorId, sandboxId: sandbox?.id }); await onAuthorization(operation, { taskId, tenantId, actorId, sandbox }); },
    authorizeResult: async ({ request, result }) => { auth.push({ kind: 'result', taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId, status: result.status }); await onAuthorization('result', request); },
  });
  const lines = async (file) => readFile(file, 'utf8').then((s) => s.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
  const readState = () => readFile(state, 'utf8').then(JSON.parse);
  const replaceIdentity = async (name) => { const all = await readState(); all[name].id = 'foreign-native-id'; await writeFile(state, JSON.stringify(all)); };
  return { bridge, auth, calls: () => lines(callsPath), uploads: () => lines(uploadsPath), probes: () => lines(probePath), state: readState, replaceIdentity, execInput: () => readFile(execInputPath, 'utf8') };
}

const request = (tenantId) => ({ taskId: 'same-task-id', tenantId, actorId: `actor-${tenantId}`, prompt: 'ordinary synthetic task' });

test('two tenants receive distinct owned instances and authorization always gets the caller tenant', async (t) => {
  const f = await securityFixture(t);
  const alpha = await f.bridge.execute(request('tenant-alpha'));
  const beta = await f.bridge.execute(request('tenant-beta'));
  assert.equal(alpha.status, 'completed');
  assert.equal(beta.status, 'completed');
  assert.notEqual(alpha.sandbox.id, beta.sandbox.id);
  assert.notEqual(alpha.sandbox.name, beta.sandbox.name);
  assert.deepEqual(f.auth.filter((x) => x.kind === 'admission').map((x) => x.tenantId), ['tenant-alpha', 'tenant-beta']);
  assert.ok(f.auth.filter((x) => x.kind === 'native').some((x) => x.tenantId === 'tenant-alpha'));
  assert.ok(f.auth.filter((x) => x.kind === 'native').some((x) => x.tenantId === 'tenant-beta'));
  assert.deepEqual(f.auth.filter((x) => x.kind === 'result').map((x) => [x.tenantId, x.status]), [['tenant-alpha', 'completed'], ['tenant-beta', 'completed']]);
  const creates = (await f.calls()).filter((x) => x[1] === 'create');
  assert.equal(creates.length, 2);
  const owners = creates.map((args) => args[args.indexOf('--label') + 1]);
  assert.notEqual(owners[0], owners[1]);
  assert.ok(owners.every((label) => /^actweave\.owner=[0-9a-f-]{36}$/.test(label)));
});

test('replacement of the owned native identity between authorization and upload is rejected and never deleted', async (t) => {
  let swapped = false;
  const f = await securityFixture(t, { onAuthorization: async (operation, context) => {
    if (operation !== 'upload' || swapped || !context.sandbox?.name) return;
    swapped = true;
    await f.replaceIdentity(context.sandbox.name);
  } });
  const result = await f.bridge.execute(request('tenant-alpha'));
  assert.equal(swapped, true);
  assert.notEqual(result.status, 'completed');
  assert.equal(result.cleanup.status, 'unverified');
  assert.equal(result.failure.code, 'native_identity_mismatch');
  assert.equal((await f.calls()).some((x) => x[1] === 'upload'), false);
  assert.equal((await f.calls()).some((x) => x[1] === 'delete'), false);
});

test('cancellation after DSH completion but during cleanup withholds the late result', async (t) => {
  const f = await securityFixture(t, { stopDelayMs: 350 });
  const controller = new AbortController();
  const running = f.bridge.execute(request('tenant-alpha'), controller.signal);
  const until = Date.now() + 5_000;
  let sawStop = false;
  while (Date.now() < until) {
    if ((await f.calls()).some((x) => x[1] === 'stop')) { sawStop = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sawStop, true, 'fixture reached cleanup after successful DSH completion');
  controller.abort();
  const result = await running;
  assert.notEqual(result.status, 'completed');
  assert.equal('output' in result, false);
  assert.equal(result.cleanup.status, 'verified');
});

test('operator gateway configuration is passed as one environment value and prompt remains stdin data', async (t) => {
  const endpoint = 'https://gateway.invalid/path?x=$(touch /tmp/actweave-config-canary)\nINJECTED=value';
  const f = await securityFixture(t, { gatewayEndpoint: endpoint });
  const prompt = '$(touch /tmp/actweave-prompt-canary) --delete; harmless text';
  const result = await f.bridge.execute({ ...request('tenant-alpha'), prompt });
  assert.equal(result.status, 'completed');
  assert.equal((await f.probes()).every((x) => x.endpoint === endpoint), true);
  assert.equal(await f.execInput(), prompt);
  assert.equal((await f.calls()).some((x) => x.join(' ').includes('actweave-config-canary') || x.join(' ').includes('actweave-prompt-canary')), false);
});

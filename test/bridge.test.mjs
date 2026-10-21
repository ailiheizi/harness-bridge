import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHarnessBridge } from '../index.mjs';

async function fixture(t, { wrongIdentity = false, wrongWorkspace = false, dshMode = 'ok', rejectOperation, hangOperation, rejectResult = false, partialCreate = false, listError = false, malformedList = false, postDeleteVisibleLists = 0, replacementAfterFirstDeleteList = false, replacementId = 'replacement-id', replacementWorkspace = 'default', replacementOwnerLabel, listErrorAfterFirstDeleteList = false, fakeCreateNameOverride, totalTimeoutMs = 20_000, maxOutputBytes = 256 * 1024 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aw-bridge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'fake-openshell.mjs');
  const implementation = `${bin}-impl.mjs`;
  const record = path.join(root, 'calls.jsonl');
  const uploads = path.join(root, 'uploads.jsonl');
  const createdNames = path.join(root, 'created-names.jsonl');
  const envProbe = path.join(root, 'env-probe.json');
  const execArgv = path.join(root, 'exec-argv.json');
  const execInput = path.join(root, 'exec-input.txt');
  const state = path.join(root, 'state.json');
  const script = `#!${process.execPath}
import fs from 'node:fs';
const a=process.argv.slice(2), start=a.indexOf('sandbox'), op=a[start+1];
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(a.slice(start,start+2))+'\\n');
fs.writeFileSync(${JSON.stringify(envProbe)}, JSON.stringify({canaryPresent:process.env.ACTWEAVE_TEST_INHERIT_CANARY!==undefined,proxyPresent:process.env.HTTP_PROXY!==undefined}));
const hadState=fs.existsSync(${JSON.stringify(state)}); let s=hadState?JSON.parse(fs.readFileSync(${JSON.stringify(state)},'utf8')):{phase:'empty'};
const labels={}; for(let i=0;i<a.length;i++) if(a[i]==='--label'){const [k,...v]=a[++i].split('=');labels[k]=v.join('=')}
if(op==='create'){const name=${fakeCreateNameOverride ? JSON.stringify(fakeCreateNameOverride) : "a[a.indexOf('--name')+1]"};fs.appendFileSync(${JSON.stringify(createdNames)},JSON.stringify(name)+'\\n');if(name.length>19){console.error('name exceeds maximum length (20 > 19)');process.exit(1)} s={phase:'running',labels,id:'native-1',name,workspace:'default'};fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s)); ${partialCreate ? "console.error('partial create');process.exit(1);" : ''} console.log(JSON.stringify({id:'native-1',name,workspace:'default'})); process.exit(0)}
if(op==='get'){if(s.phase==='deleted'){console.error('sandbox not found');process.exit(1)} const bad=${wrongIdentity}; const name=a[start+2]; console.log(JSON.stringify({id:bad?'native-other':s.id,name,workspace:${wrongWorkspace ? "'other'" : 's.workspace'},phase:s.phase,labels:s.labels??{}}));process.exit(0)}
if(op==='list'){if(${listError}){console.error('configuration not found');process.exit(1)} if(${listErrorAfterFirstDeleteList}&&s.phase==='deleted'&&(s.deletedListCalls??0)>=1){console.error('temporary list failure');process.exit(1)} let sandboxes=${malformedList ? '[{}]' : "!hadState||s.phase==='deleted'?[]:[{id:s.id,name:s.name,workspace:s.workspace,labels:s.labels}]"}; if(s.phase==='deleted'){const call=s.deletedListCalls??0;s.deletedListCalls=call+1;if(${replacementAfterFirstDeleteList}&&call>=1){sandboxes=[{id:${JSON.stringify(replacementId)},name:s.name,workspace:${JSON.stringify(replacementWorkspace)},labels:{...s.labels,...(${replacementOwnerLabel === undefined ? '{}' : JSON.stringify({ 'actweave.owner': replacementOwnerLabel })})}}]}else if(call<${postDeleteVisibleLists}||(${replacementAfterFirstDeleteList}&&call===0)){sandboxes=[{id:s.id,name:s.name,workspace:s.workspace,labels:s.labels}]}fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s))} console.log(JSON.stringify({sandboxes,next_page_token:''}));process.exit(0)}
if(op==='stop'){s.phase='stopped';fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));process.exit(0)}
if(op==='delete'){s.phase='deleted';s.deletedListCalls=0;fs.writeFileSync(${JSON.stringify(state)},JSON.stringify(s));process.exit(0)}
if(op==='upload'){fs.appendFileSync(${JSON.stringify(uploads)},JSON.stringify(a.slice(start))+'\\n');process.exit(0)}
if(op==='exec'){
 fs.writeFileSync(${JSON.stringify(execArgv)}, JSON.stringify(a.slice(start)));
 fs.writeFileSync(${JSON.stringify(execInput)}, fs.readFileSync(0, 'utf8'));
 ${dshMode === 'sleep' ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);" : ''}
 ${dshMode === 'fail' ? "console.log(JSON.stringify({type:'error'}));process.exit(1);" : ''}
 ${dshMode === 'ok' || dshMode === 'sleep' || dshMode === 'legacy' || dshMode === 'large' ? `console.log(JSON.stringify({type:'session',${dshMode === 'legacy' ? "session_id:'sess-1'" : "sessionId:'sess-1'"},cwd:'/workspace'}));console.log(JSON.stringify({type:'tool_call'}));console.log(JSON.stringify({type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}}));console.log(JSON.stringify({type:'final',text:${dshMode === 'large' ? "'x'.repeat(4096)" : "'done'"}}));process.exit(0);` : ''}
}
process.exit(2);
`;
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  const workspace = 'default';
  const policyPath = path.join(root, 'policy.yaml'); await writeFile(policyPath, 'policy');
  const patchPath = path.join(root, 'dsh-patch.yml'); await writeFile(patchPath, 'patch');
  const home = path.join(root, 'private-home'); await mkdir(home);
  const xdg = path.join(root, 'private-xdg'); await mkdir(xdg);
  const calls = async () => (await import('node:fs/promises')).readFile(record, 'utf8').then((s) => s.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
  const readCreatedNames = async () => (await import('node:fs/promises')).readFile(createdNames, 'utf8').then((s) => s.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
  const uploadTargets = async () => (await import('node:fs/promises')).readFile(uploads, 'utf8').then((s) => s.trim().split('\n').filter(Boolean).map(JSON.parse)).catch(() => []);
  const readEnvProbe = async () => (await import('node:fs/promises')).readFile(envProbe, 'utf8').then(JSON.parse).catch(() => null);
  const readExecArgv = async () => (await import('node:fs/promises')).readFile(execArgv, 'utf8').then(JSON.parse).catch(() => null);
  const readExecInput = async () => (await import('node:fs/promises')).readFile(execInput, 'utf8').catch(() => null);
  const bridge = createHarnessBridge({
    native: { cliPath: bin, workspace, image: 'pinned:test', policyPath, home, xdgConfigHome: xdg, providers: ['fixture-provider'] },
    dsh: { patchPath }, limits: { totalTimeoutMs, commandTimeoutMs: 10_000, maxOutputBytes },
    authorizeAdmission: async () => {}, authorizeNativeCall: async ({ operation }) => { if (operation === rejectOperation) throw new Error('revoked'); if (operation === hangOperation) return new Promise(() => {}); }, authorizeResult: async () => { if (rejectResult) throw new Error('delivery revoked'); },
  });
  return { bridge, calls, uploadTargets, readCreatedNames, readEnvProbe, readExecArgv, readExecInput, record };
}

const req = { taskId: 'task-1', tenantId: 'tenant-1', actorId: 'actor-1', prompt: 'say done; do not run shell' };

test('verified DSH completion and cleanup are explicit; model request count stays unknown', async (t) => {
  const f = await fixture(t);
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal(result.evidence.execution, 'verified');
  assert.equal(result.evidence.cleanup, 'verified');
  assert.equal(result.evidence.modelRequestCount, null);
  assert.equal(result.evidence.toolCallCount, 1);
  const calls = await f.calls();
  assert.deepEqual(calls.map((x) => x[1]), ['create', 'get', 'get', 'get', 'upload', 'get', 'get', 'exec', 'get', 'get', 'stop', 'get', 'get', 'get', 'delete', 'list']);
});

test('generated sandbox names fit OpenShell 19-character routable-name limit', async (t) => {
  const f = await fixture(t);
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'completed');
  const [name] = await f.readCreatedNames();
  assert.match(name, /^aw-[a-f0-9]{16}$/);
  assert.equal(name.length, 19);
});

test('fake native CLI rejects names longer than the OpenShell 19-character limit', async (t) => {
  const f = await fixture(t, { fakeCreateNameOverride: 'x'.repeat(20) });
  const result = await f.bridge.execute(req);
  assert.equal((await f.readCreatedNames())[0].length, 20);
  assert.equal(result.status, 'blocked');
  assert.equal(result.failure.stage, 'create');
  assert.equal(result.failure.code, 'native_create_failed');
  assert.equal(result.cleanup.status, 'unverified');
  assert.deepEqual((await f.calls()).map((x) => x[1]), ['create', 'list']);
});

test('ordinary Skill file is uploaded at the standard named-skill layout', async (t) => {
  const f = await fixture(t);
  const root = path.dirname(f.record);
  const skillDir = path.join(root, 'actweave-test-skill'); await mkdir(skillDir);
  const skill = path.join(skillDir, 'SKILL.md'); await writeFile(skill, '---\nname: actweave-test-skill\ndescription: test\n---\n');
  const result = await f.bridge.execute({ ...req, skillPath: skill });
  assert.equal(result.status, 'completed');
  assert.equal((await f.uploadTargets())[0][4], '/workspace/skills/actweave-test-skill/SKILL.md');
});

test('native subprocess does not inherit host synthetic canaries or HTTP_PROXY', async (t) => {
  const oldCanary = process.env.ACTWEAVE_TEST_INHERIT_CANARY;
  const oldProxy = process.env.HTTP_PROXY;
  process.env.ACTWEAVE_TEST_INHERIT_CANARY = 'synthetic-host-canary';
  process.env.HTTP_PROXY = 'http://synthetic-proxy.invalid';
  t.after(() => {
    if (oldCanary === undefined) delete process.env.ACTWEAVE_TEST_INHERIT_CANARY;
    else process.env.ACTWEAVE_TEST_INHERIT_CANARY = oldCanary;
    if (oldProxy === undefined) delete process.env.HTTP_PROXY;
    else process.env.HTTP_PROXY = oldProxy;
  });
  const f = await fixture(t);
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'completed');
  assert.deepEqual(await f.readEnvProbe(), { canaryPresent: false, proxyPresent: false });
});

test('DSH cache bypass is fixed and prompt remains literal stdin data', async (t) => {
  const f = await fixture(t);
  const prompt = 'literal: value $HOME `touch /tmp/should-not-exist` ; $(id)';
  const result = await f.bridge.execute({ ...req, prompt });
  assert.equal(result.status, 'completed');
  const argv = await f.readExecArgv();
  const separator = argv.indexOf('--');
  assert.notEqual(separator, -1);
  assert.deepEqual(argv.slice(separator + 1), ['/usr/bin/env', 'NARB_DISABLE_NATIVE_CACHE=1', '/usr/local/bin/dsh', '--profile', 'headless', '--patch', '/workspace/dsh-patch.yml', '--json', '-']);
  assert.equal(argv.includes(prompt), false);
  assert.equal(await f.readExecInput(), prompt);
});

test('native identity mismatch prevents upload, stop, and delete', async (t) => {
  const f = await fixture(t, { wrongIdentity: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'unverified');
  const ops = (await f.calls()).map((x) => x[1]);
  assert.equal(ops.includes('upload'), false);
  assert.equal(ops.includes('delete'), false);
});

test('logical workspace mismatch prevents upload and deletion', async (t) => {
  const f = await fixture(t, { wrongWorkspace: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'unverified');
  const ops = (await f.calls()).map((x) => x[1]);
  assert.equal(ops.includes('upload'), false);
  assert.equal(ops.includes('delete'), false);
});

test('native turn error never yields completed output but still cleans up', async (t) => {
  const f = await fixture(t, { dshMode: 'fail' });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.stage, 'dsh');
  assert.equal(result.cleanup.status, 'verified');
});

test('session event must use the installed DSH camelCase sessionId field', async (t) => {
  const f = await fixture(t, { dshMode: 'legacy' });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'turn_not_verified');
  assert.equal(result.cleanup.status, 'verified');
});

test('DSH stdout and final text are bounded before result release', async (t) => {
  const f = await fixture(t, { dshMode: 'large', maxOutputBytes: 512 });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal('output' in result, false);
});

test('revoked execution is denied while controller-owned cleanup still stops and deletes', async (t) => {
  const f = await fixture(t, { rejectOperation: 'exec' });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanup.status, 'verified');
  const ops = (await f.calls()).map((x) => x[1]);
  assert.equal(ops.includes('stop'), true);
  assert.equal(ops.includes('delete'), true);
});

test('a stuck business authorization hook is bounded and cannot block controller cleanup', async (t) => {
  const f = await fixture(t, { hangOperation: 'exec', totalTimeoutMs: 5000 });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'verified');
  const ops = (await f.calls()).map((x) => x[1]);
  assert.equal(ops.includes('create'), true);
  assert.equal(ops.includes('exec'), false);
  assert.equal(ops.includes('stop'), true);
  assert.equal(ops.includes('delete'), true);
});

test('partial create is found by owner label and cleaned only after its native ID is confirmed', async (t) => {
  const f = await fixture(t, { partialCreate: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'failed');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal((await f.calls()).some((x) => x[1] === 'delete'), true);
});

test('an unrelated list error cannot be treated as proof the sandbox is absent', async (t) => {
  const f = await fixture(t, { listError: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'unverified');
  assert.equal(result.failure.code, 'native_list_failed');
});

test('malformed successful list JSON cannot prove sandbox absence', async (t) => {
  const f = await fixture(t, { malformedList: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'unverified');
  assert.equal(result.failure.code, 'native_list_schema_invalid');
});

test('a stale first list after successful delete is polled until the name is absent', async (t) => {
  const f = await fixture(t, { postDeleteVisibleLists: 1 });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'completed');
  assert.equal(result.cleanup.status, 'verified');
  const calls = await f.calls();
  assert.equal(calls.filter((x) => x[1] === 'list').length, 2);
  assert.equal(calls.filter((x) => x[1] === 'delete').length, 1);
});

test('a replacement with the same name after a stale list is an identity mismatch', async (t) => {
  for (const [replacement, failureCode] of [
    [{ replacementId: 'replacement-id' }, 'native_identity_mismatch'],
    [{ replacementId: 'native-1', replacementWorkspace: 'other' }, 'native_list_schema_invalid'],
    [{ replacementId: 'native-1', replacementOwnerLabel: 'other-owner' }, 'native_identity_mismatch'],
  ]) {
    const f = await fixture(t, { replacementAfterFirstDeleteList: true, ...replacement });
    const result = await f.bridge.execute(req);
    assert.equal(result.status, 'blocked');
    assert.equal(result.cleanup.status, 'unverified');
    assert.equal(result.failure.code, failureCode);
    const calls = await f.calls();
    assert.equal(calls.filter((x) => x[1] === 'list').length, 2);
    assert.equal(calls.filter((x) => x[1] === 'delete').length, 1);
  }
});

test('a list error after an initial stale entry cannot prove deletion', async (t) => {
  const f = await fixture(t, { postDeleteVisibleLists: 1, listErrorAfterFirstDeleteList: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'unverified');
  assert.equal(result.failure.code, 'native_list_failed');
  const calls = await f.calls();
  assert.equal(calls.filter((x) => x[1] === 'list').length, 2);
  assert.equal(calls.filter((x) => x[1] === 'delete').length, 1);
});

test('result authorization denial withholds native final text after cleanup', async (t) => {
  const f = await fixture(t, { rejectResult: true });
  const result = await f.bridge.execute(req);
  assert.equal(result.status, 'blocked');
  assert.equal(result.failure.code, 'delivery_denied');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal('output' in result, false);
});

test('abort before admission does not create a sandbox', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  const result = await f.bridge.execute(req, controller.signal);
  assert.equal(result.status, 'blocked');
  assert.equal(result.cleanup.status, 'not-created');
  assert.deepEqual(await f.calls(), []);
});

test('abort during native DSH execution suppresses late final output and still cleans up', async (t) => {
  const f = await fixture(t, { dshMode: 'sleep' });
  const controller = new AbortController();
  const running = f.bridge.execute(req, controller.signal);
  const until = Date.now() + 8000;
  let sawExec = false;
  while (Date.now() < until) {
    if ((await f.calls()).some((x) => x[1] === 'exec')) { sawExec = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!sawExec) assert.fail(JSON.stringify({ result: await running, operations: await f.calls() }));
  controller.abort();
  const result = await running;
  assert.notEqual(result.status, 'completed');
  assert.equal(result.cleanup.status, 'verified');
  assert.equal('output' in result, false);
  const operations = (await f.calls()).map((x) => x[1]);
  assert.equal(operations.includes('stop'), true);
  assert.equal(operations.includes('delete'), true);
});

test('prompt is stdin data and never becomes a CLI argument or shell command', async (t) => {
  const f = await fixture(t);
  const hostile = { ...req, prompt: 'x; touch /tmp/should-not-exist $(id)' };
  const result = await f.bridge.execute(hostile);
  assert.equal(result.status, 'completed');
  const recorded = (await (await import('node:fs/promises')).readFile(f.record, 'utf8'));
  assert.equal(recorded.includes('touch'), false);
  assert.equal(recorded.includes('should-not-exist'), false);
});

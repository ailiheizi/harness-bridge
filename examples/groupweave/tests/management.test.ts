import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp, type AppOptions } from '../src/server/app.js';
import type { Proposal, Task } from '../src/shared.js';
async function identity(app: Awaited<ReturnType<typeof buildApp>>, id = 'admin-a') {
  const initial = await app.inject({ url: '/api/me' });
  let csrf = initial.json().csrfToken; let cookie = String(initial.headers['set-cookie']).split(';')[0];
  const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': csrf });
  if (id !== 'admin-a') { const res = await app.inject({ method: 'POST', url: '/api/demo/session', headers: headers(), payload: { personaId: id } }); assert.equal(res.statusCode, 200); csrf = res.json().csrfToken; cookie = String(res.headers['set-cookie']).split(';')[0]; }
  return { get: (url: string) => app.inject({ url, headers: headers() }), post: (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: headers() }) };
}
async function fixture(options: AppOptions, run: (app: Awaited<ReturnType<typeof buildApp>>) => Promise<void>) {
  const app = await buildApp({ preview: true, ...options }); try { await run(app); } finally { await app.close(); }
}
test('group audit is admin scoped; platform audit contains no group events or input/output', async () => {
  await fixture({}, async app => {
    const a = await identity(app); const member = await identity(app, 'member'); const platform = await identity(app, 'platform');
    await a.post('/api/groups/group-a/proposals', { text: '英文', baseVersion: 1 });
    const audit = await a.get('/api/groups/group-a/audit'); assert.equal(audit.statusCode, 200);
    assert.ok(audit.json().records.some((r: { action: string }) => r.action === 'rules.preview'));
    assert.ok(!audit.body.includes('candidate') && !audit.body.includes('英文'));
    assert.equal((await member.get('/api/groups/group-a/audit')).statusCode, 403);
    assert.equal((await platform.get('/api/groups/group-a/audit')).statusCode, 404);
    assert.equal((await a.get('/api/platform/audit')).statusCode, 403);
    const global = await platform.get('/api/platform/audit'); assert.equal(global.statusCode, 200);
    assert.ok(!global.body.includes('rules.preview'));
  });
});
test('backup maintenance is platform only and server chooses bounded destination; input cannot select paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-api-backup-'));
  try { await fixture({ dataDir: dir }, async app => {
    const a = await identity(app); const platform = await identity(app, 'platform');
    assert.equal((await a.post('/api/platform/maintenance/backup', {})).statusCode, 403);
    assert.equal((await platform.post('/api/platform/maintenance/backup', { path: '/tmp/escape.sqlite' })).statusCode, 400);
    const res = await platform.post('/api/platform/maintenance/backup', {}); assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(Object.keys(res.json()).sort(), ['integrity','name','schemaVersion','sha256']);
    assert.equal(res.json().integrity, 'ok'); assert.equal(res.json().schemaVersion, 3);
    assert.match(res.json().sha256, /^[a-f0-9]{64}$/); assert.ok(!res.body.includes(dir));
    assert.equal((await platform.post('/api/platform/maintenance/prune', {})).statusCode, 200);
  }); } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('only the creator can discover/cancel a running task; cancellation reaches actual executor', async () => {
  let began!: () => void; const start = new Promise<void>(resolve => { began = resolve; });
  await fixture({ executor: async (_request, signal) => { began(); await new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); return { output: '', modelCalls: 0 }; } }, async app => {
    const a = await identity(app); const member = await identity(app, 'member');
    const pending = a.post('/api/groups/group-a/tasks', { featureId: 'link-cleaner', input: 'https://example.test', audience: 'private', idempotencyKey: 'cancel' });
    await start;
    const active = (await a.get('/api/groups/group-a/active-tasks')).json().tasks;
    assert.equal(active.length, 1); assert.deepEqual(Object.keys(active[0]).sort(), ['featureId','id']);
    assert.deepEqual((await member.get('/api/groups/group-a/active-tasks')).json().tasks, []);
    assert.equal((await member.post(`/api/tasks/${active[0].id}/cancel`, {})).statusCode, 404);
    assert.equal((await a.post(`/api/tasks/${active[0].id}/cancel`, {})).json().requested, true);
    const res = await pending; assert.equal(res.statusCode, 200); assert.notEqual(res.json().status, 'succeeded'); assert.equal(res.json().output, '');
    assert.equal((await a.post(`/api/tasks/${active[0].id}/cancel`, {})).json().requested, false);
  });
});
test('AI input needs explicit external-processing review; code and Agent routes enforce distinct native evidence', async () => {
  let calls = 0;
  await fixture({ aiExecutor: async () => { calls++; return { output: 'Offline synthetic summary', modelCalls: 1, usage: null }; } }, async app => {
    app.groupweave.store.setPluginAvailability('digest', true);
    const platform = await identity(app, 'platform'); const a = await identity(app);
    await platform.post('/api/platform/plugins/digest', { enabled: true });
    const p = (await a.post('/api/groups/group-a/proposals', { text: '开启智能摘要', baseVersion: 1 })).json<Proposal>();
    assert.ok(p.changes.some(change => change.includes('第三方模型服务'))); assert.deepEqual(p.warnings, []);
    assert.equal((await a.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 200);
    const body = { featureId: 'digest', input: 'Synthetic authorized input', audience: 'private', idempotencyKey: 'ai' };
    assert.equal((await a.post('/api/groups/group-a/tasks', body)).statusCode, 400); assert.equal(calls, 0);
    const result = (await a.post('/api/groups/group-a/tasks', { ...body, acknowledgeExternalProcessing: true })).json<Task>();
    assert.equal(result.status, 'succeeded'); assert.equal(result.modelCalls, 1); assert.equal(result.usage, null);
    await a.post('/api/groups/group-a/tasks', { ...body, acknowledgeExternalProcessing: true }); assert.equal(calls, 1);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...body, input: 'x'.repeat(8001), acknowledgeExternalProcessing: true })).statusCode, 400);
  });
});
test('AI failed attempts retain authoritative calls/unknown usage; no fallback executor runs', async () => {
  await fixture({ aiExecutor: async () => { throw Object.assign(new Error('secret provider details'), { name: 'AiExecutionError', code: 'AI_INCOMPLETE', modelCalls: 1, usage: null }); } }, async app => {
    app.groupweave.store.setPluginAvailability('digest', true); app.groupweave.store.setPluginEnabled('digest', true);
    const a = await identity(app); const p = (await a.post('/api/groups/group-a/proposals', { text: '开启摘要', baseVersion: 1 })).json<Proposal>(); await a.post(`/api/proposals/${p.id}/activate`, {});
    const res = await a.post('/api/groups/group-a/tasks', { featureId: 'digest', input: 'Synthetic', audience: 'private', acknowledgeExternalProcessing: true });
    assert.equal(res.json().status, 'failed'); assert.equal(res.json().modelCalls, 1); assert.equal(res.json().usage, null); assert.ok(!res.body.includes('secret provider details'));
  });
});

test('cancellation suppresses a late success even when an executor ignores AbortSignal', async () => {
  let began!: () => void, finish!: () => void;
  const start = new Promise<void>(resolve => { began = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  await fixture({ executor: async () => { began(); await released; return { output: 'late secret output', modelCalls: 0 }; } }, async app => {
    const a = await identity(app);
    const pending = a.post('/api/groups/group-a/tasks', { featureId: 'link-cleaner', input: 'https://example.test', audience: 'private' });
    await start;
    const active = (await a.get('/api/groups/group-a/active-tasks')).json().tasks;
    await a.post(`/api/tasks/${active[0].id}/cancel`, {}); finish();
    const result = (await pending).json<Task>(); assert.equal(result.status, 'blocked'); assert.equal(result.output, '');
    assert.ok(!(await a.get(`/api/tasks/${active[0].id}`)).body.includes('late secret output'));
  });
});

test('invalid AI output remains failed while preserving the reported model attempt', async () => {
  await fixture({ aiExecutor: async () => ({ output: '', modelCalls: 1, usage: null }) }, async app => {
    app.groupweave.store.setPluginEnabled('digest', true);
    const a = await identity(app); const proposal = (await a.post('/api/groups/group-a/proposals', { text: '开启摘要', baseVersion: 1 })).json<Proposal>();
    await a.post(`/api/proposals/${proposal.id}/activate`, {});
    const task = (await a.post('/api/groups/group-a/tasks', { featureId: 'digest', input: 'Synthetic', audience: 'private', acknowledgeExternalProcessing: true })).json<Task>();
    assert.equal(task.status, 'failed'); assert.equal(task.modelCalls, 1); assert.equal(task.usage, null); assert.equal(task.output, '');
  });
});

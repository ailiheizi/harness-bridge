import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp, type AppOptions, type ExecutorRequest } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { createHash } from 'node:crypto';
import type { Group, Me, Proposal, Task } from '../src/shared.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type MeResponse = Me & { csrfToken: string };

async function client(app: App, personaId = 'admin-a') {
  let response = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(response.statusCode, 200);
  let me = response.json<MeResponse>();
  let cookie = String(response.headers['set-cookie']).split(';')[0];
  const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': me.csrfToken });
  const switchTo = async (id: string) => {
    const result = await app.inject({ method: 'POST', url: '/api/demo/session', headers: headers(), payload: { personaId: id } });
    assert.equal(result.statusCode, 200);
    me = result.json<MeResponse>(); cookie = String(result.headers['set-cookie']).split(';')[0];
  };
  if (personaId !== 'admin-a') await switchTo(personaId);
  return {
    get: (url: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { ...headers(), ...extra } }),
    post: (url: string, payload: unknown, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as object, headers: { ...headers(), ...extra } }),
    switchTo, headers, current: () => me,
  };
}

async function withApp(options: AppOptions, run: (app: App) => Promise<void>) {
  const app = await buildApp({ preview: true, ...options });
  try { await run(app); } finally { await app.close(); }
}

const input = 'https://example.com/a\nhttps://example.com/b';
const taskBody = { input, featureId: 'link-cleaner', audience: 'group' };

test('opaque preview sessions: local Host, same Origin, CSRF, and login rotation', async () => {
  await withApp({}, async app => {
    assert.equal((await app.inject({ url: '/api/me', headers: { host: 'evil.test' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/me', headers: { host: 'localhost', origin: 'https://localhost' } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/me', headers: { host: '127.0.0.1:4318' } })).statusCode, 200);
    const c = await client(app);
    const old = c.headers();
    assert.match(old.cookie, /^groupweave_session=[\w-]{43}$/);
    const missingCsrf = { ...old, 'x-csrf-token': '' };
    assert.equal((await app.inject({ method: 'POST', url: '/api/demo/session', headers: missingCsrf, payload: { personaId: 'member' } })).statusCode, 403);
    assert.equal((await c.post('/api/demo/session', { personaId: 'member' }, { origin: 'http://evil.test' })).statusCode, 403);
    assert.equal((await c.post('/api/demo/session', { personaId: 'member', role: 'platform' })).statusCode, 400);
    assert.equal((await c.post('/api/demo/session', { personaId: 'not-a-principal' })).statusCode, 400);
    await c.switchTo('member');
    assert.notEqual(c.headers().cookie, old.cookie);
    assert.notEqual(c.current().csrfToken, old['x-csrf-token']);
    assert.equal((await app.inject({ url: '/api/groups', headers: old })).statusCode, 401);
  });
});

test('production mode cannot acquire local demo authority or claim real Telegram binding', async () => {
  await withApp({ preview: false }, async app => {
    const health = (await app.inject({ url: '/api/health' })).json();
    assert.equal(health.preview, false);
    assert.equal(health.telegramConnected, false);
    assert.equal(health.agentConnected, false);
    assert.equal((await app.inject({ url: '/api/me' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/demo/session', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { personaId: 'platform' } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/groups', headers: { cookie: 'groupweave_session=admin-a', 'x-role': 'platform' } })).statusCode, 401);
  });
});

test('server membership scopes objects and fields; client role claims do not grant authority', async () => {
  await withApp({}, async app => {
    const a = await client(app); const member = await client(app, 'member');
    const list = (await a.get('/api/groups')).json<{ groups: Group[] }>();
    assert.deepEqual(list.groups.map(group => group.id), ['group-a']);
    assert.equal(list.groups[0].role, 'admin');
    assert.equal((await a.get('/api/groups/group-b', { 'x-role': 'platform', 'x-actor-id': 'platform' })).statusCode, 404);
    assert.equal((await a.post('/api/groups/group-b/proposals', { text: '排序', baseVersion: 1 })).statusCode, 404);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, actorId: 'platform', authorized: true })).statusCode, 400);
    assert.equal((await member.post('/api/groups/group-a/proposals', { text: '排序', baseVersion: 1 }, { 'x-role': 'admin' })).statusCode, 403);
    assert.equal((await a.get('/api/platform/plugins')).statusCode, 403);
    assert.equal((await a.post('/api/platform/plugins/link-cleaner', { enabled: false })).statusCode, 403);
    const platform = await client(app, 'platform');
    assert.equal((await platform.get('/api/platform/plugins')).statusCode, 200);
    assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: false, available: true })).statusCode, 400);
  });
});

test('platform maintenance does not grant group configuration, execution, or data access', async () => {
  const calls: ExecutorRequest[] = [];
  await withApp({ executor: async request => { calls.push(request); return { output: 'group-only output', modelCalls: 0 }; } }, async app => {
    const admin = await client(app);
    const platform = await client(app, 'platform');
    const groupTask = (await admin.post('/api/groups/group-a/tasks', taskBody)).json<Task>();
    const privateTask = (await admin.post('/api/groups/group-a/tasks', { ...taskBody, audience: 'private' })).json<Task>();
    const proposal = (await admin.post('/api/groups/group-a/proposals', { baseVersion: 1, config: { maxItems: 5 } })).json<Proposal>();
    assert.deepEqual((await platform.get('/api/groups')).json<{ groups: Group[] }>().groups, []);
    for (const groupId of ['group-a', 'group-b']) {
      assert.equal((await platform.get(`/api/groups/${groupId}`)).statusCode, 404);
      assert.equal((await platform.get(`/api/groups/${groupId}/tasks`)).statusCode, 404);
      assert.equal((await platform.post(`/api/groups/${groupId}/proposals`, { baseVersion: 1, config: { maxItems: 1 } })).statusCode, 404);
      assert.equal((await platform.post(`/api/groups/${groupId}/tasks`, taskBody)).statusCode, 404);
    }
    assert.equal((await platform.get(`/api/proposals/${proposal.id}`)).statusCode, 404);
    assert.equal((await platform.post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 404);
    assert.equal((await platform.get(`/api/tasks/${groupTask.id}`)).statusCode, 404);
    assert.equal((await platform.get(`/api/tasks/${privateTask.id}`)).statusCode, 404);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(request => request.actorId === 'admin-a'));
    assert.equal((await admin.get('/api/groups/group-a')).json<{ group: Group }>().group.version, 1);
    assert.equal((await platform.get('/api/platform/plugins')).statusCode, 200);
    assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: false })).statusCode, 200);
    assert.equal((await admin.post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 422);
  });
});

test('finite rules proposals preserve unknowns; CAS prevents stale overwrite and duplicate activation', async () => {
  await withApp({}, async app => {
    const a = await client(app);
    const first = await a.post('/api/groups/group-a/proposals', { text: '命令触发，English，去重并排序，最多 5 条', baseVersion: 1 });
    assert.equal(first.statusCode, 200);
    const p = first.json<Proposal>();
    assert.deepEqual(p.warnings, []);
    assert.equal(p.candidate.responseMode, 'command');
    assert.equal(p.candidate.language, 'en');
    assert.equal(p.candidate.sort, true);
    assert.equal(p.candidate.maxItems, 5);
    const p2 = (await a.post('/api/groups/group-a/proposals', { text: '关闭去重', baseVersion: 1 })).json<Proposal>();
    assert.equal((await a.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 200);
    assert.equal((await a.post(`/api/proposals/${p2.id}/activate`, {})).statusCode, 409);
    assert.equal((await a.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 200);
    const group = (await a.get('/api/groups/group-a')).json<{ group: Group }>().group;
    assert.equal(group.version, 2);
    assert.equal(group.config.maxItems, 5);
    assert.equal((await a.post('/api/groups/group-a/proposals', { text: '排序', baseVersion: 1 })).statusCode, 409);
    const unknown = (await a.post('/api/groups/group-a/proposals', { text: '最多 0 条，帮我发邮件', baseVersion: 2 })).json<Proposal>();
    assert.equal(unknown.warnings.length, 2);
    assert.equal((await a.post(`/api/proposals/${unknown.id}/activate`, {})).statusCode, 422);
    assert.equal((await a.post('/api/groups/group-a/proposals', { config: { maxItems: 0 }, baseVersion: 2 })).statusCode, 400);
    assert.equal((await a.post('/api/groups/group-a/proposals', { config: { role: 'platform' }, baseVersion: 2 })).statusCode, 400);
    const missing = (await a.post('/api/groups/group-a/proposals', { config: { features: ['link-cleaner', 'digest'] }, baseVersion: 2 })).json<Proposal>();
    assert.ok(missing.warnings.some(warning => warning.includes('尚未接入')));
    assert.equal((await a.post(`/api/proposals/${missing.id}/activate`, {})).statusCode, 422);
  });
});

test('the visible default and preset sentences are recognized by the finite parser', async () => {
  await withApp({}, async app => {
    const a = await client(app);
    for (const text of [
      '只在 @ 时回复，使用中文，开启链接整理，去重并排序，最多 20 条。',
      '只使用命令，使用英文，开启链接整理，不去重，不排序，最多 10 条。',
      '仅 @ 机器人时回复，关闭链接整理。',
    ]) {
      const response = await a.post('/api/groups/group-a/proposals', { text, baseVersion: 1 });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json<Proposal>().warnings, []);
    }
  });
});

test('proposals cannot be read or activated across groups; members cannot activate them', async () => {
  await withApp({}, async app => {
    const a = await client(app); const b = await client(app, 'admin-b'); const member = await client(app, 'member');
    const p = (await a.post('/api/groups/group-a/proposals', { config: { maxItems: 3 }, baseVersion: 1 })).json<Proposal>();
    assert.equal((await b.get(`/api/proposals/${p.id}`)).statusCode, 404);
    assert.equal((await b.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 404);
    assert.equal((await member.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 403);
    assert.equal((await a.post(`/api/proposals/${p.id}/activate`, { candidate: { maxItems: 90 } })).statusCode, 400);
  });
});

test('task execution uses server config and scoped idempotency; private results stay creator-only', async () => {
  const requests: ExecutorRequest[] = [];
  await withApp({ executor: async request => { requests.push(request); return { output: '整理后的结果', modelCalls: 0 }; } }, async app => {
    const a = await client(app); const member = await client(app, 'member'); const b = await client(app, 'admin-b'); const platform = await client(app, 'platform');
    const p = (await a.post('/api/groups/group-a/proposals', { config: { maxItems: 3, sort: true }, baseVersion: 1 })).json<Proposal>();
    await a.post(`/api/proposals/${p.id}/activate`, {});
    const body = { ...taskBody, audience: 'private', idempotencyKey: 'local-1' };
    const response = await a.post('/api/groups/group-a/tasks', body);
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded'); assert.equal(task.configVersion, 2); assert.equal(task.modelCalls, 0);
    assert.deepEqual(requests[0], { taskId: task.id, tenantId: 'group-a', featureId: 'link-cleaner',
      authorization: { platformVersion: 0, groupVersion: 0 }, actorId: 'admin-a', groupId: 'group-a', input,
      options: { deduplicate: true, sort: true, maxItems: 3, language: 'zh' }, audience: 'private', authorized: true });
    assert.equal((await a.get(`/api/tasks/${task.id}`)).json<Task>().output, '整理后的结果');
    for (const other of [member, b, platform]) assert.equal((await other.get(`/api/tasks/${task.id}`)).statusCode, 404);
    assert.equal((await member.get('/api/groups/group-a/tasks')).json<{ tasks: Task[] }>().tasks.length, 0);
    const repeat = (await a.post('/api/groups/group-a/tasks', body)).json<Task>();
    assert.equal(repeat.id, task.id); assert.equal(requests.length, 1);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...body, input: 'https://different.example' })).statusCode, 409);
    const groupTask = (await a.post('/api/groups/group-a/tasks', { ...taskBody, idempotencyKey: 'shared-1' })).json<Task>();
    assert.equal((await member.get(`/api/tasks/${groupTask.id}`)).statusCode, 200);
    assert.equal((await b.get(`/api/tasks/${groupTask.id}`)).statusCode, 404);
    const tasks = (await member.get('/api/groups/group-a/tasks')).json<{ tasks: Task[] }>().tasks;
    assert.deepEqual(tasks.map(item => item.id), [groupTask.id]);
    assert.equal((await b.get('/api/groups/group-a/tasks')).statusCode, 404);
  });
});

test('concurrent duplicate submission reserves before execution and never calls executor twice', async () => {
  let finish!: (value: { output: string; modelCalls: number }) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  await withApp({ executor: async () => { calls++; started(); return await new Promise(resolve => { finish = resolve; }); } }, async app => {
    const a = await client(app);
    const body = { ...taskBody, idempotencyKey: 'concurrent' };
    const first = a.post('/api/groups/group-a/tasks', body);
    await startedPromise;
    assert.equal((await a.post('/api/groups/group-a/tasks', body)).statusCode, 409);
    finish({ output: 'once', modelCalls: 0 });
    assert.equal((await first).json<Task>().status, 'succeeded');
    assert.equal(calls, 1);
  });
});

test('late results are withheld after platform stop, group feature removal, or session revocation', async () => {
  for (const revoke of ['platform', 'group', 'session']) {
    let finish!: (value: { output: string; modelCalls: number }) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    await withApp({ executor: async () => { calls++; started(); return await new Promise(resolve => { finish = resolve; }); } }, async app => {
      const a = await client(app);
      const pending = a.post('/api/groups/group-a/tasks', { ...taskBody, idempotencyKey: 'revoked' });
      await startedPromise;
      if (revoke === 'platform') await (await client(app, 'platform')).post('/api/platform/plugins/link-cleaner', { enabled: false });
      if (revoke === 'group') {
        const p = (await a.post('/api/groups/group-a/proposals', { config: { features: [] }, baseVersion: 1 })).json<Proposal>();
        assert.equal((await a.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 200);
      }
      if (revoke === 'session') await a.switchTo('member');
      finish({ output: 'withhold this result', modelCalls: 0 });
      const task = (await pending).json<Task>();
      assert.equal(task.status, 'blocked'); assert.equal(task.output, ''); assert.equal(calls, 1);
      assert.match(task.error!, /迟到结果未交付/);
      const visible = await (await client(app)).get(`/api/tasks/${task.id}`);
      assert.equal(visible.json<Task>().output, '');
    });
  }
});

test('input bounds, unknown authority fields, absent capability, and platform kill switch are enforced', async () => {
  let calls = 0;
  await withApp({ executor: async () => { calls++; return { output: 'done', modelCalls: 0 }; } }, async app => {
    const a = await client(app); const platform = await client(app, 'platform');
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, input: '中'.repeat(6000) })).statusCode, 400);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, input: Array(201).fill('https://example.com').join('\n') })).statusCode, 400);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, options: { maxItems: 1000 } })).statusCode, 400);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, audience: 'group-b' })).statusCode, 400);
    assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, featureId: 'digest' })).statusCode, 403);
    assert.equal(calls, 0);
    const p = (await a.post('/api/groups/group-a/proposals', { config: { maxItems: 8 }, baseVersion: 1 })).json<Proposal>();
    await platform.post('/api/platform/plugins/link-cleaner', { enabled: false });
    assert.equal((await a.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 422);
    const blocked = (await a.post('/api/groups/group-a/tasks', taskBody)).json<Task>();
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.modelCalls, 0); assert.equal(calls, 0);
    await platform.post('/api/platform/plugins/digest', { enabled: true });
    const plugins = (await platform.get('/api/platform/plugins')).json<{ plugins: { id: string; available: boolean; enabled: boolean }[] }>().plugins;
    assert.equal(plugins.find(plugin => plugin.id === 'digest')!.available, false);
  });
  await withApp({}, async app => {
    const a = await client(app);
    const blocked = (await a.post('/api/groups/group-a/tasks', taskBody)).json<Task>();
    assert.equal(blocked.status, 'blocked'); assert.equal(blocked.output, ''); assert.match(blocked.error!, /BLOCKED/);
  });
});

test('failures and unexpected model calls have no AI fallback and no automatic replay', async () => {
  let calls = 0;
  await withApp({ executor: async () => { calls++; throw new Error('secret token must not be exposed'); } }, async app => {
    const a = await client(app);
    const body = { ...taskBody, idempotencyKey: 'failure' };
    const task = (await a.post('/api/groups/group-a/tasks', body)).json<Task>();
    assert.equal(task.status, 'failed'); assert.equal(task.output, ''); assert.doesNotMatch(task.error!, /secret/);
    assert.equal((await a.post('/api/groups/group-a/tasks', body)).json<Task>().id, task.id);
    assert.equal(calls, 1);
  });
  await withApp({ executor: async () => ({ output: 'must not release', modelCalls: 1 }) }, async app => {
    const task = (await (await client(app)).post('/api/groups/group-a/tasks', taskBody)).json<Task>();
    assert.equal(task.status, 'failed'); assert.equal(task.modelCalls, 1); assert.equal(task.output, '');
  });
});

test('only verified native input error codes receive safe fixed explanations', async () => {
  await withApp({ executor: async () => { const error = new Error('private internal detail'); error.name = 'NativeInputError'; throw Object.assign(error, { code: 'NO_LINKS' }); } }, async app => {
    const task = (await (await client(app)).post('/api/groups/group-a/tasks', { ...taskBody, input: '没有链接' })).json<Task>();
    assert.equal(task.status, 'failed'); assert.match(task.error!, /HTTP\(S\)/); assert.doesNotMatch(task.error!, /private/);
  });
  await withApp({ executor: async () => { const error = new Error('private internal detail'); error.name = 'NativeInputError'; throw Object.assign(error, { code: 'UNKNOWN' }); } }, async app => {
    const task = (await (await client(app)).post('/api/groups/group-a/tasks', taskBody)).json<Task>();
    assert.equal(task.status, 'failed'); assert.doesNotMatch(task.error!, /private/);
  });
});

test('bounded wait records an unknown timeout without claiming cancellation or replaying', async context => {
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  await withApp({ executor: async () => { calls++; started(); return await new Promise(() => {}); } }, async app => {
    const a = await client(app);
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const body = { ...taskBody, idempotencyKey: 'timeout' };
      const pending = a.post('/api/groups/group-a/tasks', body);
      await startedPromise;
      context.mock.timers.tick(60_000);
      const task = (await pending).json<Task>();
      assert.equal(task.status, 'failed'); assert.match(task.error!, /超时不代表底层操作已取消/);
      assert.equal((await a.post('/api/groups/group-a/tasks', body)).json<Task>().id, task.id);
      assert.equal(calls, 1);
    } finally { context.mock.timers.reset(); }
  });
});

test('a reservation surviving process loss is blocked and never silently replayed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'groupweave-unknown-'));
  const draft: Task = { id: 'unknown-outcome', groupId: 'group-a', creatorId: 'admin-a', featureId: 'link-cleaner', audience: 'private', configVersion: 1, createdAt: new Date().toISOString(), durationMs: 0, modelCalls: 0, input, output: '', status: 'blocked', error: '执行结果未知，不能自动重放。' };
  const requestHash = createHash('sha256').update(JSON.stringify({ input, featureId: 'link-cleaner', audience: 'private' })).digest('hex');
  try {
    const interruptedStore = new Store(dataDir);
    interruptedStore.reserveTask(draft, 'interrupted', requestHash);
    interruptedStore.close();
    let calls = 0;
    await withApp({ dataDir, executor: async () => { calls++; return { output: 'must not execute', modelCalls: 0 }; } }, async app => {
      const a = await client(app);
      const task = (await a.post('/api/groups/group-a/tasks', { ...taskBody, audience: 'private', idempotencyKey: 'interrupted' })).json<Task>();
      assert.equal(task.id, draft.id); assert.equal(task.status, 'blocked'); assert.equal(task.output, ''); assert.equal(calls, 0);
      assert.match(task.error!, /未知/);
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('SQLite persists group configuration and prior task evidence; sessions are process-local', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'groupweave-api-'));
  let taskId = ''; let oldHeaders: Record<string, string> = {};
  try {
    await withApp({ dataDir, executor: async () => ({ output: 'persisted', modelCalls: 0 }) }, async app => {
      const a = await client(app); oldHeaders = a.headers();
      const p = (await a.post('/api/groups/group-a/proposals', { text: '最多 7 条', baseVersion: 1 })).json<Proposal>();
      await a.post(`/api/proposals/${p.id}/activate`, {});
      taskId = (await a.post('/api/groups/group-a/tasks', { ...taskBody, idempotencyKey: 'persist' })).json<Task>().id;
    });
    await withApp({ dataDir }, async app => {
      assert.equal((await app.inject({ url: '/api/groups', headers: oldHeaders })).statusCode, 401);
      const a = await client(app);
      const group = (await a.get('/api/groups/group-a')).json<{ group: Group }>().group;
      assert.equal(group.version, 2); assert.equal(group.config.maxItems, 7);
      assert.equal((await a.get(`/api/tasks/${taskId}`)).json<Task>().output, 'persisted');
      assert.equal((await a.post('/api/groups/group-a/tasks', { ...taskBody, idempotencyKey: 'persist' })).json<Task>().id, taskId);
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

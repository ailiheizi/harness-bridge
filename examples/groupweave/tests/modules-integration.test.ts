import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp, type AppOptions, type ExecutorRequest } from '../src/server/app.js';
import { createKoishiCodeHost } from '../src/server/koishi.js';
import { AiExecutionError } from '../src/server/ai.js';
import type { Group, Proposal, Task } from '../src/shared.js';

type App = Awaited<ReturnType<typeof buildApp>>;
async function client(app: App, personaId = 'admin-a') {
  const initial = await app.inject({ url: '/api/me' });
  let csrf = initial.json().csrfToken, cookie = String(initial.headers['set-cookie']).split(';')[0];
  const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': csrf });
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: headers() });
  if (personaId !== 'admin-a') {
    const login = await post('/api/demo/session', { personaId }); assert.equal(login.statusCode, 200);
    csrf = login.json().csrfToken; cookie = String(login.headers['set-cookie']).split(';')[0];
  }
  return { post, get: (url: string) => app.inject({ url, headers: headers() }) };
}
async function fixture(options: AppOptions, run: (app: App) => Promise<void>) {
  const app = await buildApp({ preview: true, ...options }); try { await run(app); } finally { await app.close(); }
}
async function configure(c: Awaited<ReturnType<typeof client>>, group: string, config: object) {
  const detail = (await c.get(`/api/groups/${group}`)).json<{ group: Group }>();
  const preview = await c.post(`/api/groups/${group}/proposals`, { baseVersion: detail.group.version, config });
  assert.equal(preview.statusCode, 200, preview.body);
  const p = preview.json<Proposal>(); assert.deepEqual(p.warnings, []);
  assert.equal((await c.post(`/api/proposals/${p.id}/activate`, {})).statusCode, 200);
  return p;
}

test('welcome uses real Koishi text rendering and each group owns its reviewed template', async () => {
  const code = createKoishiCodeHost(); const requests: ExecutorRequest[] = [];
  try { await fixture({ welcomeExecutor: (request, signal) => { requests.push(request); return code.executeWelcome(request, signal); } }, async app => {
    const platform = await client(app, 'platform'), a = await client(app), b = await client(app, 'admin-b'), member = await client(app, 'member');
    assert.equal((await platform.post('/api/platform/plugins/welcome', { enabled: true })).statusCode, 200);
    const p = await configure(a, 'group-a', { features: ['link-cleaner', 'welcome'], welcomeText: 'Hello {name}, welcome to {group}. <at id="99"/>' });
    assert.ok(p.changes.some(change => change.includes('欢迎文本')));
    await configure(b, 'group-b', { features: ['link-cleaner', 'welcome'], welcomeText: 'B only: {name}' });
    assert.equal((await member.post('/api/groups/group-a/proposals', { baseVersion: 2, config: { welcomeText: 'hijacked' } })).statusCode, 403);
    assert.equal((await platform.get('/api/groups/group-a')).statusCode, 404);
    const first = (await member.post('/api/groups/group-a/tasks', { featureId: 'welcome', input: 'Alice <image src="https://private.test"/>', audience: 'group' })).json<Task>();
    const second = (await member.post('/api/groups/group-b/tasks', { featureId: 'welcome', input: 'Bob', audience: 'private' })).json<Task>();
    assert.equal(first.status, 'succeeded'); assert.equal(first.modelCalls, 0);
    assert.equal(first.output, 'Hello Alice <image src="https://private.test"/>, welcome to 设计共创. <at id="99"/>');
    assert.equal(second.status, 'succeeded'); assert.equal(second.output, 'B only: Bob');
    assert.equal(requests[0].groupId, 'group-a'); assert.equal(requests[1].groupId, 'group-b');
    assert.equal(requests[0].options.groupTitle, '设计共创');
    const leaked = await a.get(`/api/tasks/${second.id}`); assert.equal(leaked.statusCode, 404);
  }); } finally { await code.dispose(); }
});

test('antiad config is bounded, previewed, tenant scoped and cannot choose executable/model paths', async () => {
  const requests: ExecutorRequest[] = [];
  await fixture({ antiadExecutor: async request => { requests.push(request); return { output: 'OFFLINE synthetic review advice only', modelCalls: 0 }; } }, async app => {
    const a = await client(app), b = await client(app, 'admin-b'), member = await client(app, 'member'), platform = await client(app, 'platform');
    assert.equal((await platform.post('/api/platform/plugins/antiad', { enabled: true })).statusCode, 200);
    for (const config of [
      { antiadPromptThreshold: 0 }, { antiadActionThreshold: 1.1 }, { antiadPromptThreshold: 0.91, antiadActionThreshold: 0.9 },
      { antiadStopwords: ['same', 'same'] }, { antiadStopwords: Array.from({ length: 51 }, (_, i) => String(i)) },
      { antiadStopwords: ['x'.repeat(81)] }, { modelPath: '/other/model.joblib' }, { pythonPath: '/bin/sh' },
    ]) assert.equal((await a.post('/api/groups/group-a/proposals', { baseVersion: 1, config })).statusCode, 400);
    const before = (await a.get('/api/groups/group-a')).json<{ group: Group }>().group;
    assert.equal(before.version, 1);
    await configure(a, 'group-a', { features: ['link-cleaner', 'antiad'], antiadPromptThreshold: 0.4, antiadActionThreshold: 0.85, antiadStopwords: ['group-a-keyword'] });
    await configure(b, 'group-b', { features: ['link-cleaner', 'antiad'], antiadStopwords: ['group-b-keyword'] });
    const body = { featureId: 'antiad', input: 'Explicit synthetic sample', audience: 'private' };
    const first = (await member.post('/api/groups/group-a/tasks', body)).json<Task>();
    const second = (await member.post('/api/groups/group-b/tasks', body)).json<Task>();
    assert.equal(first.status, 'succeeded'); assert.equal(second.status, 'succeeded');
    assert.deepEqual(requests[0].options.antiadStopwords, ['group-a-keyword']);
    assert.deepEqual(requests[1].options.antiadStopwords, ['group-b-keyword']);
    assert.equal(requests[1].options.antiadPromptThreshold, 0.55); assert.equal(requests[1].options.antiadActionThreshold, 0.9);
    assert.equal((await b.get(`/api/tasks/${first.id}`)).statusCode, 404);
    assert.equal((await member.post('/api/groups/group-a/tasks', { ...body, rules: { promptThreshold: 0 } })).statusCode, 400);
    assert.equal((await platform.post('/api/platform/plugins/antiad', { enabled: false })).statusCode, 200);
    const blocked = (await member.post('/api/groups/group-a/tasks', body)).json<Task>();
    assert.equal(blocked.status, 'blocked'); assert.equal(requests.length, 2);
  });
});

test('unconfigured antiad never becomes available through group or platform configuration', async () => {
  await fixture({}, async app => {
    const a = await client(app), platform = await client(app, 'platform');
    assert.equal((await platform.post('/api/platform/plugins/antiad', { enabled: true })).statusCode, 409);
    const proposal = (await a.post('/api/groups/group-a/proposals', { baseVersion: 1, text: '开启反广告检测' })).json<Proposal>();
    assert.ok(proposal.warnings.length > 0);
    assert.equal((await a.post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 422);
  });
});

test('assistant requires fresh review and exact native model/tool evidence; no model-selected authority', async () => {
  let modelCalls = 1, toolCalls = 0, calls = 0;
  await fixture({ assistantExecutor: async () => { calls++; return { output: 'Synthetic scoped answer', modelCalls, toolCalls, usage: null }; } }, async app => {
    const a = await client(app), member = await client(app, 'member'), platform = await client(app, 'platform');
    await platform.post('/api/platform/plugins/assistant', { enabled: true });
    await configure(a, 'group-a', { features: ['assistant'] });
    const body = { featureId: 'assistant', input: 'A synthetic explicit goal', audience: 'private' };
    assert.equal((await member.post('/api/groups/group-a/tasks', body)).statusCode, 400); assert.equal(calls, 0);
    const reviewed = { ...body, acknowledgeExternalProcessing: true };
    const first = (await member.post('/api/groups/group-a/tasks', reviewed)).json<Task>();
    assert.equal(first.status, 'succeeded'); assert.equal(first.toolCalls, 0);
    assert.equal((await member.post('/api/groups/group-a/tasks', { ...reviewed, allowLinkTool: true })).statusCode, 400);
    modelCalls = 2; toolCalls = 0;
    assert.equal((await member.post('/api/groups/group-a/tasks', reviewed)).json<Task>().status, 'failed');
    modelCalls = 2; toolCalls = 1;
    const missingCode = (await member.post('/api/groups/group-a/tasks', reviewed)).json<Task>();
    assert.equal(missingCode.status, 'blocked'); assert.equal(missingCode.output, '');
    assert.equal((await member.post('/api/groups/group-b/tasks', reviewed)).statusCode, 403);
  });
});

test('an incomplete assistant retains native attempt evidence without publishing a partial answer', async () => {
  await fixture({ assistantExecutor: async () => { throw new AiExecutionError('AI_INCOMPLETE', 1, { inputTokens: 10, outputTokens: 2 }, 1); } }, async app => {
    const a = await client(app), platform = await client(app, 'platform');
    await platform.post('/api/platform/plugins/assistant', { enabled: true });
    await configure(a, 'group-a', { features: ['assistant', 'link-cleaner'] });
    const task = (await a.post('/api/groups/group-a/tasks', {
      featureId: 'assistant', input: 'Synthetic explicit links https://example.test', audience: 'private', acknowledgeExternalProcessing: true,
    })).json<Task>();
    assert.equal(task.status, 'failed'); assert.equal(task.output, '');
    assert.equal(task.modelCalls, 1); assert.equal(task.toolCalls, 1);
    assert.deepEqual(task.usage, { inputTokens: 10, outputTokens: 2 });
  });
});

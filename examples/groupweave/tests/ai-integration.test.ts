import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import type { Group, Proposal, Task } from '../src/shared.js';
import { buildApp } from '../src/server/app.js';
import { AI_MODEL, createAiExecutor } from '../src/server/ai.js';
import { Store } from '../src/server/store.js';

const fixtureUsage: TokenUsage = { inputTokens: 17, outputTokens: 6, totalTokens: 23 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function* fixtureText(): AsyncIterable<StreamChunk> {
  const text = 'Offline integration fixture summary; not a live provider response.';
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: fixtureUsage };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

// Only the provider response is synthetic. Agent, Skill loading, Session,
// HTTP authentication, actions, cancellation and SQLite persistence are real.
class IntegrationAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly response: (options: GenerateOptions) => AsyncIterable<StreamChunk> = fixtureText) { super(); }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    assert.equal(options.provider, 'deepseek-official');
    assert.equal(options.model, AI_MODEL);
    assert.equal(options.maxTokens, 1024);
    assert.equal(options.tools?.length ?? 0, 0);
    const loaded = options.messages.filter(message => message.source?.kind === 'skill-invocation');
    assert.equal(loaded.length, 1);
    assert.ok(loaded[0]!.content.some(block => block.type === 'text' && block.text.includes('Produce a concise, faithful summary')));
    yield* this.response(options);
  }
}

async function fixture(response?: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-integration-'));
  const adapter = new IntegrationAdapter(response);
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-fixture-not-a-secret', dataDir }, { adapter });
  const app = await buildApp({
    preview: true, dataDir, beforeClose: () => ai.dispose(),
    aiExecutor: (request, signal) => ai.execute({
      actorId: request.actorId, groupId: request.groupId, input: request.input,
      options: { language: request.options.language ?? 'zh' },
    }, signal),
  });
  // This is the deployment's capability observation, never a client field or
  // implicit enable. All enable/configuration changes below use real HTTP.
  app.groupweave.store.setPluginAvailability('digest', true);
  let closed = false;
  return {
    app, adapter, dataDir,
    async stop() { if (!closed) { await app.close(); closed = true; } },
    async close() { if (!closed) await app.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

async function client(app: FastifyInstance, personaId = 'admin-a') {
  const login = await app.inject({ method: 'GET', url: '/api/me', headers: { host: 'localhost' } });
  let cookie = String(login.headers['set-cookie']).split(';')[0]!;
  let csrf = login.json().csrfToken as string;
  const post = (url: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url, payload, headers: { host: 'localhost', cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
  });
  if (personaId !== 'admin-a') {
    const changed = await post('/api/demo/session', { personaId });
    assert.equal(changed.statusCode, 200);
    cookie = String(changed.headers['set-cookie']).split(';')[0]!;
    csrf = changed.json().csrfToken as string;
  }
  return { post, get: (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie } }) };
}
type Client = Awaited<ReturnType<typeof client>>;

async function configure(admin: Client, version: number, enabled: boolean, language: 'zh' | 'en' = 'en') {
  const preview = await admin.post('/api/groups/group-a/proposals', {
    baseVersion: version, config: { features: enabled ? ['link-cleaner', 'digest'] : ['link-cleaner'], language },
  });
  assert.equal(preview.statusCode, 200);
  const proposal = preview.json<Proposal>();
  assert.deepEqual(proposal.warnings, []);
  const activated = await admin.post(`/api/proposals/${proposal.id}/activate`, {});
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json<Proposal>().status, 'active');
}
async function enablePlatform(app: FastifyInstance) {
  const platform = await client(app, 'platform');
  const enabled = await platform.post('/api/platform/plugins/digest', { enabled: true });
  assert.equal(enabled.statusCode, 200);
}

test('HTTP opt-in → configuration CAS → native Skill → persisted private AI evidence', async () => {
  const f = await fixture();
  try {
    const admin = await client(f.app);
    const member = await client(f.app, 'member');
    const platform = await client(f.app, 'platform');
    assert.equal(f.app.groupweave.store.plugin('digest')?.enabled, false);
    assert.equal((await admin.post('/api/platform/plugins/digest', { enabled: true })).statusCode, 403);
    assert.equal(f.adapter.requests.length, 0);
    await enablePlatform(f.app);
    await configure(admin, 1, true);
    const detail = (await admin.get('/api/groups/group-a')).json<{ group: Group }>();
    assert.equal(detail.group.version, 2);
    assert.equal(detail.group.config.language, 'en');
    const old = await admin.post('/api/groups/group-a/proposals', { baseVersion: 1, config: { language: 'zh' } });
    assert.equal(old.statusCode, 409);
    assert.equal(old.json().code, 'VERSION_CONFLICT');

    const input = 'PRIVATE_CREATOR_INPUT: the meeting chose a Friday prototype and a 100 yuan budget.';
    const body = { featureId: 'digest', audience: 'private', input, idempotencyKey: 'ai-private-integration' };
    const unreviewed = await admin.post('/api/groups/group-a/tasks', body);
    assert.equal(unreviewed.statusCode, 400);
    assert.equal(unreviewed.json().code, 'EXTERNAL_PROCESSING_REVIEW_REQUIRED');
    const oversized = await admin.post('/api/groups/group-a/tasks', { ...body, input: '中'.repeat(2667), acknowledgeExternalProcessing: true });
    assert.equal(oversized.statusCode, 400);
    assert.equal(oversized.json().code, 'INPUT_TOO_LARGE');
    assert.equal(f.adapter.requests.length, 0);
    const response = await admin.post('/api/groups/group-a/tasks', { ...body, acknowledgeExternalProcessing: true });
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded');
    assert.equal(task.configVersion, 2);
    assert.equal(task.modelCalls, 1);
    assert.deepEqual(task.usage, fixtureUsage);
    assert.equal(task.input, input);
    assert.match(task.output, /^Offline integration fixture/);
    const nativeRequest = f.adapter.requests[0]!;
    assert.ok(nativeRequest.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('in English'))));
    assert.ok(nativeRequest.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes(input))));
    assert.equal(f.adapter.requests.length, 1);
    const replay = await admin.post('/api/groups/group-a/tasks', { ...body, acknowledgeExternalProcessing: true });
    assert.equal(replay.json<Task>().id, task.id);
    assert.equal(f.adapter.requests.length, 1);
    assert.equal((await member.get(`/api/tasks/${task.id}`)).statusCode, 404);
    assert.deepEqual((await member.get('/api/groups/group-a/tasks')).json().tasks, []);
    assert.equal((await platform.get(`/api/tasks/${task.id}`)).statusCode, 404);
    assert.equal((await admin.get('/api/groups/group-b')).statusCode, 404);
    assert.deepEqual(f.app.groupweave.store.task(task.id)?.task, task);

    await f.stop();
    const reopened = new Store(f.dataDir);
    try { assert.deepEqual(reopened.task(task.id)?.task, task); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

test('AI group audience shares the chosen summary while the input field remains creator-only', async () => {
  const f = await fixture();
  try {
    const admin = await client(f.app);
    const member = await client(f.app, 'member');
    await enablePlatform(f.app);
    await configure(admin, 1, true);
    const input = 'RAW_INPUT_ONLY_FOR_CREATOR: Tuesday meeting chose a prototype.';
    const response = await admin.post('/api/groups/group-a/tasks', {
      featureId: 'digest', audience: 'group', input, acknowledgeExternalProcessing: true,
    });
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded');
    assert.equal(task.modelCalls, 1);
    for (const url of [`/api/tasks/${task.id}`, '/api/groups/group-a/tasks']) {
      const visible = await member.get(url);
      assert.equal(visible.statusCode, 200);
      const item: Task = url.includes('/groups/') ? visible.json().tasks[0] : visible.json();
      assert.equal(item.output, task.output);
      assert.equal(item.input, '');
      assert.equal(item.inputHidden, true);
      assert.equal(visible.body.includes(input), false);
      assert.deepEqual(item.usage, fixtureUsage);
    }
    assert.equal(f.adapter.requests.length, 1);
    // The fixture summary does not echo the input. This verifies field visibility;
    // an actual chosen group summary may itself contain facts from that input.
  } finally { await f.close(); }
});

test('HTTP permission shrink cancels the real native turn, withholds the result and never replays it', async () => {
  const started = deferred();
  const gate = deferred();
  let providerSignal: AbortSignal | undefined;
  const f = await fixture(async function* (options) {
    providerSignal = options.signal;
    yield { type: 'usage', usage: fixtureUsage };
    started.resolve();
    await gate.promise;
    yield* fixtureText();
  });
  try {
    const admin = await client(f.app);
    await enablePlatform(f.app);
    await configure(admin, 1, true);
    const body = {
      featureId: 'digest', audience: 'private', input: 'REVOKED_INPUT: a proposal has not been approved.',
      idempotencyKey: 'ai-revoked-integration', acknowledgeExternalProcessing: true,
    };
    const pending = admin.post('/api/groups/group-a/tasks', body);
    // Fastify injection starts on observation, so attach before awaiting the gate.
    const observed = pending.then(response => response);
    let settled = false;
    void observed.finally(() => { settled = true; });
    await started.promise;
    assert.equal(f.adapter.requests.length, 1);
    await configure(admin, 2, false);
    await nextTick();
    assert.equal(providerSignal?.aborted, true);
    assert.equal(settled, false);
    gate.resolve();
    const response = await observed;
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'blocked');
    assert.equal(task.output, '');
    assert.equal(task.modelCalls, 1);
    assert.deepEqual(task.usage, fixtureUsage);
    assert.equal(f.app.groupweave.store.task(task.id)?.task?.output, '');
    assert.equal(f.adapter.requests.length, 1);
    await configure(admin, 3, true);
    const replay = await admin.post('/api/groups/group-a/tasks', body);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json<Task>().id, task.id);
    assert.equal(replay.json<Task>().status, 'blocked');
    assert.equal(replay.json<Task>().output, '');
    assert.equal(f.adapter.requests.length, 1);
  } finally { gate.resolve(); await f.close(); }
});

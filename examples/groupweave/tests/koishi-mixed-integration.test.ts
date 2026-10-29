import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Group, GroupConfig, Proposal, Task } from '../src/shared.js';
import { buildApp } from '../src/server/app.js';
import { AI_MODEL, createAiExecutor } from '../src/server/ai.js';
import { createKoishiCodeHost, type KoishiCodeHost } from '../src/server/koishi.js';
import { runLinkCodeTool } from '../src/server/mixed.js';
import { createNativeExecutor, type NativeRequest } from '../src/server/native.js';
import { Store } from '../src/server/store.js';

/** Only model generation is offline; this drives real DSH, Koishi, HTTP and SQLite. */
class OfflineMixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  beforeTool?: () => Promise<void>;
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    assert.equal(options.provider, 'deepseek-official'); assert.equal(options.model, AI_MODEL);
    assert.equal(options.maxTokens, 1024);
    assert.deepEqual(options.tools?.map(tool => tool.name), ['organize_links']);
    const skills = options.messages.filter(message => message.source?.kind === 'skill-invocation');
    assert.equal(skills.length, 1);
    assert.ok(skills[0]!.content.some(block => block.type === 'text' && block.text.includes('First call\n`organize_links` once')));
    const tool = options.messages.find(message => message.role === 'tool');
    if (!tool) {
      if (this.beforeTool) await this.beforeTool();
      const id = ToolCallId(`offline-http-mixed-${this.requests.length}`);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: 'organize_links', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'organize_links', arguments: '{}' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      assert.equal(tool.role === 'tool' && tool.isError, false);
      const codeResult = tool.content.filter(block => block.type === 'text').map(block => block.text).join('');
      assert.ok(codeResult.startsWith('整理结果：'));
      const text = `${codeResult}\n\n离线说明 fixture：仅根据本次原文和真实代码结果。`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-koishi-mixed-http-'));
  const actualCode = createKoishiCodeHost();
  const linkRequests: NativeRequest[] = [];
  const echoRequests: NativeRequest[] = [];
  let successfulLinkCalls = 0;
  const code: KoishiCodeHost = {
    async executeLinks(request, signal) {
      linkRequests.push(request);
      const result = await actualCode.executeLinks(request, signal);
      successfulLinkCalls++;
      return result;
    },
    async executeEcho(request, signal) { echoRequests.push(request); return actualCode.executeEcho(request, signal); },
    executeWelcome: (request, signal) => actualCode.executeWelcome(request, signal),
    dispose: () => actualCode.dispose(),
  };
  const native = createNativeExecutor(code);
  const adapter = new OfflineMixedAdapter();
  let app!: Awaited<ReturnType<typeof buildApp>>;
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-not-a-secret', dataDir, workflow: 'link-brief' }, {
    adapter,
    codeTool: { execute: (request, signal) => runLinkCodeTool(app.groupweave.store, app.groupweave.actions, code, request, signal) },
  });
  app = await buildApp({
    preview: true, dataDir, executor: native,
    echoExecutor: (request, signal) => code.executeEcho(request, signal),
    mixedExecutor: (request, signal) => ai.execute({
      actorId: request.actorId, groupId: request.groupId, input: request.input,
      options: { language: request.options.language ?? 'zh' },
      codeOptions: { deduplicate: request.options.deduplicate, sort: request.options.sort, maxItems: request.options.maxItems },
    }, signal),
    async beforeClose() { await ai.dispose(); await native.dispose(); await code.dispose(); },
  });
  let closed = false;
  return { app, adapter, linkRequests, echoRequests, dataDir, successfulLinkCalls: () => successfulLinkCalls,
    async stop() { if (!closed) { await app.close(); closed = true; } },
    async close() { if (!closed) { await app.close(); closed = true; } await rm(dataDir, { recursive: true, force: true }); },
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
    cookie = String(changed.headers['set-cookie']).split(';')[0]!; csrf = changed.json().csrfToken as string;
  }
  return { post, get: (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie } }) };
}
type Client = Awaited<ReturnType<typeof client>>;

async function configure(admin: Client, baseVersion: number, config: Partial<GroupConfig>) {
  const preview = await admin.post('/api/groups/group-a/proposals', { baseVersion, config });
  assert.equal(preview.statusCode, 200);
  const proposal = preview.json<Proposal>(); assert.deepEqual(proposal.warnings, []);
  const activated = await admin.post(`/api/proposals/${proposal.id}/activate`, {});
  assert.equal(activated.statusCode, 200); assert.equal(activated.json<Proposal>().status, 'active');
}

async function enableMixed(app: FastifyInstance) {
  const platform = await client(app, 'platform');
  const enabled = await platform.post('/api/platform/plugins/link-brief', { enabled: true });
  assert.equal(enabled.statusCode, 200);
  const admin = await client(app);
  await configure(admin, 1, { features: ['link-cleaner', 'link-brief'], deduplicate: true, sort: true, maxItems: 2 });
  return { admin, platform };
}

const taskBody = (patch: Record<string, unknown> = {}) => ({ featureId: 'link-brief', audience: 'private',
  input: 'PRIVATE_MEMBER_INPUT https://b.example/b https://a.example/a https://b.example/b https://c.example/c',
  acknowledgeExternalProcessing: true, idempotencyKey: 'koishi-mixed-http-private', ...patch });

test('HTTP member task → audited native Skill → real Koishi code → final generation → persistent private evidence', async () => {
  const f = await fixture();
  try {
    const { admin, platform } = await enableMixed(f.app);
    const member = await client(f.app, 'member');
    const body = taskBody();
    const response = await member.post('/api/groups/group-a/tasks', body);
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded'); assert.equal(task.modelCalls, 2); assert.equal(task.toolCalls, 1);
    assert.equal(task.configVersion, 2); assert.equal(task.creatorId, 'member'); assert.equal(task.audience, 'private');
    assert.deepEqual(task.usage, { inputTokens: 30, outputTokens: 6, totalTokens: 36 });
    assert.ok(task.output.includes('整理结果：2 条链接；超过上限，展示前 2 条'));
    assert.equal((task.output.match(/https:\/\/a\.example\/a/g) ?? []).length, 1);
    assert.equal((task.output.match(/https:\/\/b\.example\/b/g) ?? []).length, 1);
    assert.ok(!task.output.includes('https://c.example/c'));
    assert.equal(f.successfulLinkCalls(), 1); assert.equal(f.linkRequests.length, 1);
    assert.equal(f.linkRequests[0]!.actorId, 'member'); assert.equal(f.linkRequests[0]!.groupId, 'group-a');
    assert.equal(f.linkRequests[0]!.audience, 'private'); assert.equal(f.linkRequests[0]!.options.maxItems, 2);
    assert.equal(f.adapter.requests.length, 2);
    const replay = await member.post('/api/groups/group-a/tasks', body);
    assert.equal(replay.statusCode, 200); assert.equal(replay.json<Task>().id, task.id);
    assert.equal(f.adapter.requests.length, 2); assert.equal(f.successfulLinkCalls(), 1);
    assert.equal((await member.get(`/api/tasks/${task.id}`)).statusCode, 200);
    assert.equal((await admin.get(`/api/tasks/${task.id}`)).statusCode, 404);
    assert.equal((await platform.get(`/api/tasks/${task.id}`)).statusCode, 404);
    assert.deepEqual(f.app.groupweave.store.task(task.id)?.task, task);
    await f.stop();
    const reopened = new Store(f.dataDir);
    try { assert.deepEqual(reopened.task(task.id)?.task, task); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

test('group and admin boundaries, per-request third-party confirmation and disabled dependencies reject before model dispatch', async () => {
  const f = await fixture();
  try {
    const { platform } = await enableMixed(f.app);
    const member = await client(f.app, 'member'); const otherAdmin = await client(f.app, 'admin-b');
    const groupB = await member.post('/api/groups/group-b/tasks', taskBody());
    assert.equal(groupB.statusCode, 403); assert.equal(groupB.json().code, 'FEATURE_NOT_CONFIGURED');
    assert.equal((await otherAdmin.post('/api/groups/group-a/tasks', taskBody())).statusCode, 404);
    const noReview = taskBody(); delete (noReview as Record<string, unknown>).acknowledgeExternalProcessing;
    const unreviewed = await member.post('/api/groups/group-a/tasks', noReview);
    assert.equal(unreviewed.statusCode, 400); assert.equal(unreviewed.json().code, 'EXTERNAL_PROCESSING_REVIEW_REQUIRED');
    assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: false })).statusCode, 200);
    const dependency = await member.post('/api/groups/group-a/tasks', taskBody());
    assert.equal(dependency.statusCode, 403); assert.equal(dependency.json().code, 'CODE_DEPENDENCY_UNAVAILABLE');
    assert.equal(f.adapter.requests.length, 0); assert.equal(f.linkRequests.length, 0); assert.equal(f.successfulLinkCalls(), 0);
  } finally { await f.close(); }
});

test('a dependency lost after first model dispatch is rechecked by the real tool binding before any code call', async () => {
  const f = await fixture();
  try {
    await enableMixed(f.app);
    const member = await client(f.app, 'member');
    f.adapter.beforeTool = async () => {
      // This models the trusted host observing a lost code capability without
      // an HTTP cancellation shortcut, so runLinkCodeTool must itself deny it.
      f.app.groupweave.store.setPluginAvailability('link-cleaner', false);
    };
    const response = await member.post('/api/groups/group-a/tasks', taskBody());
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'blocked'); assert.equal(task.output, ''); assert.equal(task.modelCalls, 1);
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.linkRequests.length, 0); assert.equal(f.successfulLinkCalls(), 0);
    f.app.groupweave.store.setPluginAvailability('link-cleaner', true);
    const replay = await member.post('/api/groups/group-a/tasks', taskBody());
    assert.equal(replay.json<Task>().id, task.id); assert.equal(replay.json<Task>().status, 'blocked');
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.linkRequests.length, 0);
  } finally { await f.close(); }
});

test('platform dependency revocation during the first model dispatch also suppresses code and final generation', async () => {
  const f = await fixture();
  try {
    const { platform } = await enableMixed(f.app);
    const member = await client(f.app, 'member');
    f.adapter.beforeTool = async () => { assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: false })).statusCode, 200); };
    const response = await member.post('/api/groups/group-a/tasks', taskBody());
    const task = response.json<Task>();
    assert.equal(response.statusCode, 200); assert.equal(task.status, 'blocked');
    assert.equal(task.output, ''); assert.equal(task.modelCalls, 1);
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.linkRequests.length, 0);
  } finally { await f.close(); }
});

test('mid-task configuration edits do not substitute new parameters for the task recorded configuration version', async () => {
  const f = await fixture();
  try {
    const { admin } = await enableMixed(f.app);
    const member = await client(f.app, 'member');
    f.adapter.beforeTool = async () => { await configure(admin, 2, { maxItems: 4, sort: false, deduplicate: false }); };
    const response = await member.post('/api/groups/group-a/tasks', taskBody());
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded'); assert.equal(task.configVersion, 2); assert.equal(task.toolCalls, 1);
    assert.deepEqual(f.linkRequests[0]!.options, { deduplicate: true, sort: true, maxItems: 2, language: 'zh' });
    assert.ok(task.output.includes('1. https://a.example/a\n2. https://b.example/b'));
    assert.ok(!task.output.includes('https://c.example/c'));
    const current = (await admin.get('/api/groups/group-a')).json<{ group: Group }>().group;
    assert.equal(current.version, 3); assert.equal(current.config.maxItems, 4);
    assert.equal(current.config.deduplicate, false); assert.equal(current.config.sort, false);
  } finally { await f.close(); }
});

test('HTTP native Echo and ordinary links use the shared real Koishi host with zero model dispatches', async () => {
  const f = await fixture();
  try {
    const admin = await client(f.app); const member = await client(f.app, 'member');
    await configure(admin, 1, { features: ['link-cleaner', 'echo'], deduplicate: true, sort: true, maxItems: 2 });
    const input = '-u telegram:other -c telegram:other -g other $(groupweave-links) <image src="https://secret.test/a"/> &';
    const echoed = await member.post('/api/groups/group-a/tasks', { featureId: 'echo', audience: 'private', input, idempotencyKey: 'real-native-echo' });
    assert.equal(echoed.statusCode, 200);
    const echoTask = echoed.json<Task>();
    assert.equal(echoTask.status, 'succeeded'); assert.equal(echoTask.output, input); assert.equal(echoTask.modelCalls, 0);
    assert.equal(f.echoRequests.length, 1); assert.equal(f.echoRequests[0]!.input, input);
    assert.equal(f.echoRequests[0]!.groupId, 'group-a'); assert.equal(f.echoRequests[0]!.actorId, 'member');
    const links = await member.post('/api/groups/group-a/tasks', { featureId: 'link-cleaner', audience: 'private',
      input: 'https://b.example/b https://a.example/a https://b.example/b' });
    assert.equal(links.statusCode, 200); assert.equal(links.json<Task>().status, 'succeeded');
    assert.equal(links.json<Task>().modelCalls, 0);
    assert.equal(links.json<Task>().output, '整理结果：2 条链接\n\n1. https://a.example/a\n2. https://b.example/b');
    assert.equal(f.adapter.requests.length, 0); assert.equal(f.successfulLinkCalls(), 1);
  } finally { await f.close(); }
});

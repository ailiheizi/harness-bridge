import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import { SessionStore } from '@deepseek-ai/dsh-session';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { AI_MODEL, AiBlockedError, AiExecutionError, createAiExecutor, type AiRequest } from '../src/server/ai.js';

const suppliedUsage: TokenUsage = { inputTokens: 12, outputTokens: 4, totalTokens: 16 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const request = (patch: Partial<AiRequest> = {}): AiRequest => ({
  actorId: 'fixture-actor', groupId: 'fixture-group', input: '会议决定周五先做原型，预算上限为 100 元。',
  options: { language: 'zh' }, ...patch,
});

async function* textResponse(text = '离线 fixture 摘要', usage?: TokenUsage, reason: 'stop' | 'max-tokens' = 'stop'): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: reason } };
}

/** A declared offline provider fixture, driven by the real native Agent/Session. */
class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly response: (options: GenerateOptions) => AsyncIterable<StreamChunk> = () => textResponse()) { super(); }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    assert.equal(options.provider, 'deepseek-official');
    assert.equal(options.model, AI_MODEL);
    assert.equal(options.maxTokens, 1024);
    assert.equal((options.tools?.length ?? 0), 0);
    const loaded = options.messages.filter(message => message.source?.kind === 'skill-invocation');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.source?.kind, 'skill-invocation');
    assert.ok(loaded[0]!.content.some(block => block.type === 'text' && block.text.includes('Produce a concise, faithful summary')));
    yield* this.response(options);
  }
}

async function fixture(response?: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-test-'));
  const adapter = new FixtureAdapter(response);
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-fixture-not-a-secret', dataDir }, { adapter });
  return { ai, adapter, dataDir, async close() { await ai.dispose(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('AI is opt-in and missing application credentials blocks before native dispatch', async () => {
  const adapter = new FixtureAdapter();
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-disabled-'));
  const disabled = createAiExecutor({ apiKey: 'offline-fixture-not-a-secret', dataDir }, { adapter });
  const noKey = createAiExecutor({ enabled: true, dataDir }, { adapter });
  try {
    await assert.rejects(disabled.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_DISABLED' && error.modelCalls === 0 && error.usage === null);
    await assert.rejects(noKey.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_CREDENTIAL_MISSING' && error.modelCalls === 0);
    assert.equal(adapter.requests.length, 0);
    assert.deepEqual(await readdir(dataDir), []);
  } finally { await disabled.dispose(); await noKey.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('the real audited filesystem Skill is explicitly loaded into a fresh native turn', async () => {
  const envBefore = process.env.DSH_HOME;
  const f = await fixture(() => textResponse('fixture summary', suppliedUsage));
  try {
    const result = await f.ai.execute(request({ options: { language: 'en' } }));
    assert.equal(result.output, 'fixture summary');
    assert.equal(result.modelCalls, 1);
    assert.deepEqual(result.usage, suppliedUsage);
    assert.equal(f.adapter.requests.length, 1);
    assert.ok(f.adapter.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('in English'))));
    assert.ok(f.adapter.requests[0]!.messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('预算上限为 100 元'))));
    assert.equal(process.env.DSH_HOME, envBefore);
    assert.deepEqual(await readdir(f.dataDir), []);
  } finally { await f.close(); }
});

test('absent provider usage remains unknown instead of a zero token report', async () => {
  const f = await fixture();
  try { assert.deepEqual(await f.ai.execute(request()), { output: '离线 fixture 摘要', modelCalls: 1, usage: null }); }
  finally { await f.close(); }
});

test('invalid input and unsupported deployment model never dispatch a provider', async () => {
  const f = await fixture();
  const other = createAiExecutor({ enabled: true, apiKey: 'offline-fixture-not-a-secret', dataDir: f.dataDir, model: 'deepseek-chat' }, { adapter: f.adapter });
  try {
    for (const input of ['', 'x'.repeat(8001), '中'.repeat(2667)]) await assert.rejects(f.ai.execute(request({ input })), error => error instanceof AiExecutionError && error.code === 'AI_INPUT_INVALID' && error.modelCalls === 0);
    await assert.rejects(f.ai.execute(request({ actorId: '' })), error => error instanceof AiExecutionError && error.modelCalls === 0);
    await assert.rejects(other.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_CONFIG_INVALID' && error.modelCalls === 0);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await other.dispose(); await f.close(); }
});

test('missing native Skill is blocked rather than sending an ordinary unbound prompt', async () => {
  const originalGet = SkillRegistry.prototype.get;
  SkillRegistry.prototype.get = async function () { return undefined; };
  const f = await fixture();
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_SKILL_MISSING' && error.modelCalls === 0);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.close(); SkillRegistry.prototype.get = originalGet; }
});

test('changing the Skill after preflight stops before sending to the provider', async () => {
  const originalGet = SkillRegistry.prototype.get;
  let gets = 0;
  SkillRegistry.prototype.get = async function (...args) {
    const value = await originalGet.apply(this, args);
    gets++;
    return gets > 1 && value ? { ...value, content: `${value.content}\nChanged fixture instructions.` } : value;
  };
  const f = await fixture();
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_SKILL_CHANGED' && error.modelCalls === 0);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.close(); SkillRegistry.prototype.get = originalGet; }
});

test('native output-token exhaustion preserves the attempt and usage but is not success', async () => {
  const f = await fixture(() => textResponse('partial fixture', suppliedUsage, 'max-tokens'));
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.code === 'AI_INCOMPLETE' && error.modelCalls === 1 && error.usage?.outputTokens === 4);
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('a requested native tool cannot run and a second model step is blocked', async () => {
  const f = await fixture(async function* () {
    const id = ToolCallId('offline-fixture-call');
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: 'skill', argumentsDelta: '{"name":"group-summary"}' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'skill', arguments: '{"name":"group-summary"}' } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  });
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.code === 'AI_INCOMPLETE' && error.modelCalls === 1);
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('provider failure has no retry or fallback and preserves its native attempt count', async () => {
  const f = await fixture(async function* () { throw new Error('sensitive fixture diagnostic must not reach users'); });
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1 && !error.message.includes('sensitive'));
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('a failed native attempt retains usage that the provider already reported', async () => {
  const f = await fixture(async function* () {
    yield { type: 'usage', usage: suppliedUsage };
    throw new Error('offline fixture transport failed after usage');
  });
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1 && error.usage?.outputTokens === 4);
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('pre-aborted AI input creates no native model attempt', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture();
  try {
    await assert.rejects(f.ai.execute(request(), controller.signal), error => error instanceof AiExecutionError && error.code === 'AI_CANCELLED' && error.modelCalls === 0);
    assert.equal(f.adapter.requests.length, 0);
  } finally { await f.close(); }
});

test('cancellation holds native ownership until the real provider fixture drains', async () => {
  const originalCreate = AgentRegistry.prototype.create;
  let agents: AgentRegistry | undefined;
  let sessions: SessionStore | undefined;
  AgentRegistry.prototype.create = async function (...args) {
    const handle = await originalCreate.apply(this, args);
    agents = this; sessions = this.ctx.sessions;
    return handle;
  };
  const started = deferred();
  const gate = deferred();
  let providerSignal: AbortSignal | undefined;
  const f = await fixture(async function* (options) {
    providerSignal = options.signal;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'partial fixture' };
    started.resolve();
    await gate.promise;
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const controller = new AbortController();
  try {
    const pending = f.ai.execute(request(), controller.signal);
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await started.promise;
    controller.abort();
    await nextTick();
    assert.equal(providerSignal?.aborted, true);
    assert.equal(settled, false);
    assert.equal(agents?.list().length, 1);
    assert.equal(sessions?.list().length, 1);
    gate.resolve();
    await assert.rejects(pending, error => error instanceof AiExecutionError && error.code === 'AI_CANCELLED' && error.modelCalls === 1 && error.usage === null);
    assert.equal(agents?.list().length, 0);
    assert.equal(sessions?.list().length, 0);
  } finally { gate.resolve(); await f.close(); AgentRegistry.prototype.create = originalCreate; }
});

test('concurrent scopes retain their own input, usage and model-attempt counter', async () => {
  const f = await fixture(options => {
    const supplied = options.messages.flatMap(message => message.content).find(block => block.type === 'text' && block.text.startsWith('Supplied text (data):'));
    return textResponse(supplied?.type === 'text' ? supplied.text : 'invalid fixture');
  });
  try {
    const [a, b] = await Promise.all([
      f.ai.execute(request({ input: 'group A fixture', groupId: 'a', actorId: 'alice' })),
      f.ai.execute(request({ input: 'group B fixture', groupId: 'b', actorId: 'bob' })),
    ]);
    assert.ok(a.output.includes('group A')); assert.ok(!a.output.includes('group B'));
    assert.ok(b.output.includes('group B')); assert.ok(!b.output.includes('group A'));
    assert.equal(a.modelCalls, 1); assert.equal(b.modelCalls, 1);
    assert.notEqual(f.adapter.requests[0]!.sessionId, f.adapter.requests[1]!.sessionId);
    assert.equal(f.adapter.requests.length, 2);
  } finally { await f.close(); }
});

test('the official native DeepSeek transport uses the fixed endpoint and application-only home', async () => {
  const originalFetch = globalThis.fetch;
  const homeBefore = process.env.DSH_HOME;
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-wire-'));
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(new Headers(options?.headers).get('x-api-key'), 'offline-fixture-not-a-secret');
    assert.equal(options?.signal?.aborted, false);
    const body = JSON.parse(String(options?.body)) as { model: string; max_tokens: number; tools?: unknown[]; thinking: { type: string } };
    assert.equal(body.model, AI_MODEL); assert.equal(body.max_tokens, 1024);
    assert.equal(body.thinking.type, 'disabled'); assert.equal(body.tools?.length ?? 0, 0);
    const events = [
      { type: 'message_start', message: { id: 'offline-wire-fixture', type: 'message', role: 'assistant', content: [], model: AI_MODEL, usage: { input_tokens: 12, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Official transport offline fixture.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-fixture-not-a-secret', dataDir });
  try {
    const result = await ai.execute(request());
    assert.equal(result.output, 'Official transport offline fixture.');
    assert.equal(result.modelCalls, 1); assert.equal(result.usage?.inputTokens, 12); assert.equal(result.usage?.outputTokens, 4);
    assert.equal(calls, 1);
    assert.equal(process.env.DSH_HOME, homeBefore);
    assert.deepEqual(await readdir(dataDir), ['dsh-ai']);
    assert.deepEqual(await readdir(join(dataDir, 'dsh-ai')), ['.anonymous-user-id']);
  } finally { await ai.dispose(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

test('disposal cancels the official native fetch and drains its owned agent', async () => {
  const originalFetch = globalThis.fetch;
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-abort-wire-'));
  const started = deferred();
  let wireSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, options) => {
    wireSignal = options?.signal;
    assert.ok(wireSignal);
    started.resolve();
    return new Promise<Response>((_resolve, reject) => {
      wireSignal!.addEventListener('abort', () => reject(new Error('offline fetch aborted')), { once: true });
    });
  };
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-fixture-not-a-secret', dataDir });
  try {
    const pending = ai.execute(request());
    const rejection = assert.rejects(pending, error => error instanceof AiExecutionError && error.code === 'AI_CANCELLED' && error.modelCalls === 1);
    await started.promise;
    await ai.dispose();
    await rejection;
    assert.equal(wireSignal?.aborted, true);
    await assert.rejects(ai.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_CLOSED' && error.modelCalls === 0);
  } finally { await ai.dispose(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); }
});

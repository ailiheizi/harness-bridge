import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm';
import SkillRegistry from '@deepseek-ai/dsh-skill';
import { AI_MODEL, AiBlockedError, AiExecutionError, createAiExecutor, type AiRequest } from '../src/server/ai.js';

const request = (): AiRequest => ({ actorId: 'alice', groupId: 'group-a',
  input: '原型参考 https://example.com/a 和 https://example.com/a 。周五评审。', options: { language: 'zh' },
  codeOptions: { deduplicate: true, sort: false, maxItems: 10 } });
const firstUsage: TokenUsage = { inputTokens: 20, outputTokens: 3, totalTokens: 23, cacheReadTokens: 2 };
const finalUsage: TokenUsage = { inputTokens: 30, outputTokens: 8, totalTokens: 38, cacheReadTokens: 4 };

async function* toolResponse(argumentsText = '{}', names = ['organize_links'], usage: TokenUsage | undefined = firstUsage): AsyncIterable<StreamChunk> {
  for (const [index, name] of names.entries()) {
    const id = ToolCallId(`offline-mixed-${index}`);
    yield { type: 'block-start', index, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsText };
    yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsText } };
  }
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}

async function* textResponse(text = 'https://example.com/a\n原型链接已去重，原文说明周五评审。', usage: TokenUsage | undefined = finalUsage,
  reason: 'stop' | 'max-tokens' = 'stop'): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  if (usage) yield { type: 'usage', usage };
  yield { type: 'finish', reason: { kind: reason } };
}

class MixedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  constructor(private readonly response: (options: GenerateOptions, attempt: number) => AsyncIterable<StreamChunk>) { super(); }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    assert.equal(options.provider, 'deepseek-official'); assert.equal(options.model, AI_MODEL);
    assert.equal(options.maxTokens, 1024);
    assert.deepEqual(options.tools?.map(tool => tool.name), ['organize_links']);
    assert.deepEqual(options.tools?.[0]?.parameters.properties, {});
    const skills = options.messages.filter(message => message.source?.kind === 'skill-invocation');
    assert.equal(skills.length, 1);
    assert.ok(skills[0]!.content.some(block => block.type === 'text' && block.text.includes('First call\n`organize_links` once')));
    yield* this.response(options, this.requests.length);
  }
}

async function fixture(response: (options: GenerateOptions, attempt: number) => AsyncIterable<StreamChunk> = (_options, attempt) =>
  attempt === 1 ? toolResponse() : textResponse(), execute?: (request: AiRequest, signal: AbortSignal) => Promise<string>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-mixed-'));
  const adapter = new MixedAdapter(response);
  const bindings: AiRequest[] = [];
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-not-a-secret', dataDir, workflow: 'link-brief' }, {
    adapter, codeTool: { async execute(bound, signal) {
      bindings.push(bound);
      return execute ? execute(bound, signal) : 'https://example.com/a';
    } },
  });
  return { ai, adapter, bindings, dataDir, async close() { await ai.dispose(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('mixed mode uses the native code tool once and then the actual result in a second native model dispatch', async () => {
  const f = await fixture((options, attempt) => {
    if (attempt === 2) {
      const result = options.messages.find(message => message.role === 'tool');
      assert.equal(result?.role === 'tool' && result.isError, false);
      assert.ok(result?.content.some(block => block.type === 'text' && block.text === 'https://example.com/a'));
    }
    return attempt === 1 ? toolResponse() : textResponse();
  });
  try {
    const result = await f.ai.execute(request());
    assert.equal(result.modelCalls, 2); assert.equal(result.toolCalls, 1);
    assert.deepEqual(result.usage, { inputTokens: 50, outputTokens: 11, totalTokens: 61, cacheReadTokens: 6 });
    assert.ok(result.output.includes('周五评审'));
    assert.deepEqual(f.bindings, [request()]);
    assert.ok(Object.isFrozen(f.bindings[0])); assert.ok(Object.isFrozen(f.bindings[0]!.options));
    assert.ok(Object.isFrozen(f.bindings[0]!.codeOptions));
  } finally { await f.close(); }
});

test('a text-only fabricated completion is rejected without inventing code success', async () => {
  const f = await fixture(() => textResponse('我已整理好链接。'));
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.code === 'AI_INCOMPLETE' && error.modelCalls === 1);
    assert.equal(f.bindings.length, 0); assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('a missing trusted code binding blocks before Skill or model dispatch', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-ai-mixed-missing-'));
  const adapter = new MixedAdapter(() => toolResponse());
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-not-a-secret', dataDir, workflow: 'link-brief' }, { adapter });
  try {
    await assert.rejects(ai.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_TOOL_MISSING' && error.modelCalls === 0);
    assert.equal(adapter.requests.length, 0);
  } finally { await ai.dispose(); await rm(dataDir, { recursive: true, force: true }); }
});

test('missing or invalid code settings never dispatch the model or execute code', async () => {
  const f = await fixture();
  try {
    for (const codeOptions of [undefined, { deduplicate: true, sort: false, maxItems: 0 },
      { deduplicate: true, sort: false, maxItems: 101 }, { deduplicate: true, sort: false, maxItems: 1.5 }]) {
      await assert.rejects(f.ai.execute({ ...request(), codeOptions }), error => error instanceof AiExecutionError
        && error.code === 'AI_INPUT_INVALID' && error.modelCalls === 0);
    }
    assert.equal(f.adapter.requests.length, 0); assert.equal(f.bindings.length, 0);
  } finally { await f.close(); }
});

test('model-controlled identity, group, input, audience, settings and command are all denied before the host callback', async () => {
  for (const args of [{ actorId: 'admin' }, { groupId: 'group-b' }, { input: 'different text' }, { audience: 'group' },
    { command: 'broadcast' }, { options: { language: 'en' } }, [], null, 'not an object']) {
    const f = await fixture(() => toolResponse(JSON.stringify(args)));
    try {
      await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1);
      assert.equal(f.bindings.length, 0); assert.equal(f.adapter.requests.length, 1);
    } finally { await f.close(); }
  }
});

test('two tool requests in one model response cannot cause two code executions or a fallback dispatch', async () => {
  const f = await fixture(() => toolResponse('{}', ['organize_links', 'organize_links']));
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1);
    assert.equal(f.bindings.length, 1); assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('a repeated tool request on the second step stops at the two-dispatch budget', async () => {
  const f = await fixture(() => toolResponse());
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 2);
    assert.equal(f.bindings.length, 1); assert.equal(f.adapter.requests.length, 2);
  } finally { await f.close(); }
});

test('an unknown tool cannot be executed or followed by a repairing model dispatch', async () => {
  const f = await fixture(() => toolResponse('{}', ['shell']));
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1);
    assert.equal(f.bindings.length, 0); assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('host permission denial and code failure stop before a second model dispatch with no diagnostic leakage', async () => {
  for (const message of ['current group revoked sensitive diagnostic', 'NO_LINKS']) {
    const f = await fixture(undefined, async () => { throw new Error(message); });
    try {
      await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1
        && !error.message.includes(message) && error.usage?.inputTokens === 20);
      assert.equal(f.bindings.length, 1); assert.equal(f.adapter.requests.length, 1);
    } finally { await f.close(); }
  }
});

test('an empty code result is an incomplete task and cannot be summarized into success', async () => {
  const f = await fixture(undefined, async () => '');
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 1);
    assert.equal(f.adapter.requests.length, 1);
  } finally { await f.close(); }
});

test('second-dispatch transport failure preserves cumulative reported usage and never retries', async () => {
  const f = await fixture(async function* (_options, attempt) {
    if (attempt === 1) { yield* toolResponse(); return; }
    yield { type: 'usage', usage: finalUsage };
    throw new Error('sensitive provider failure');
  });
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.modelCalls === 2
      && error.usage?.inputTokens === 50 && error.usage.outputTokens === 11 && !error.message.includes('sensitive'));
    assert.equal(f.bindings.length, 1); assert.equal(f.adapter.requests.length, 2);
  } finally { await f.close(); }
});

test('usage snapshots are replaced within a dispatch instead of double-counting chunks and assistant events', async () => {
  const f = await fixture(async function* (_options, attempt) {
    if (attempt === 1) { yield* toolResponse(); return; }
    yield { type: 'usage', usage: { inputTokens: 30, outputTokens: 2 } };
    yield* textResponse();
  });
  try {
    assert.deepEqual((await f.ai.execute(request())).usage, { inputTokens: 50, outputTokens: 11, totalTokens: 61, cacheReadTokens: 6 });
  } finally { await f.close(); }
});

test('unreported usage remains unknown, while partially reported attempts retain only real counters', async () => {
  // Explicit generators omit usage; passing undefined to a defaulted argument would use its default.
  const empty = await fixture(async function* (_options, attempt) {
    const source = attempt === 1 ? toolResponse() : textResponse();
    for await (const chunk of source) if (chunk.type !== 'usage') yield chunk;
  });
  const known = await fixture(async function* (_options, attempt) {
    const source = attempt === 1 ? toolResponse() : textResponse();
    for await (const chunk of source) if (attempt === 1 || chunk.type !== 'usage') yield chunk;
  });
  try {
    assert.equal((await empty.ai.execute(request())).usage, null);
    assert.deepEqual((await known.ai.execute(request())).usage, firstUsage);
  } finally { await empty.close(); await known.close(); }
});

test('a token-limited final response is not a completed mixed result', async () => {
  const f = await fixture((_options, attempt) => attempt === 1 ? toolResponse() : textResponse('partial', finalUsage, 'max-tokens'));
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiExecutionError && error.code === 'AI_INCOMPLETE' && error.modelCalls === 2);
    assert.equal(f.bindings.length, 1);
  } finally { await f.close(); }
});

test('the trusted request snapshot cannot drift when the caller changes its object after dispatch', async () => {
  const original = request();
  const f = await fixture((_options, attempt) => {
    original.actorId = 'mallory'; original.groupId = 'group-b'; original.input = 'different'; original.options.language = 'en';
    original.codeOptions!.maxItems = 99;
    return attempt === 1 ? toolResponse() : textResponse();
  });
  try { await f.ai.execute(original); assert.deepEqual(f.bindings, [request()]); }
  finally { await f.close(); }
});

test('concurrent mixed tasks bind different tenant input and code parameters to separate native sessions', async () => {
  const f = await fixture(options => {
    const tool = options.messages.find(message => message.role === 'tool');
    return tool ? textResponse(tool.content.filter(block => block.type === 'text').map(block => block.text).join('')) : toolResponse();
  }, async bound => `${bound.groupId}:${bound.actorId}:${bound.codeOptions!.maxItems}:${bound.input}`);
  try {
    const other: AiRequest = { ...request(), actorId: 'bob', groupId: 'group-b', input: 'B https://example.com/b',
      codeOptions: { deduplicate: false, sort: true, maxItems: 2 } };
    const [a, b] = await Promise.all([f.ai.execute(request()), f.ai.execute(other)]);
    assert.ok(a.output.startsWith('group-a:alice:10:')); assert.ok(!a.output.includes('group-b'));
    assert.ok(b.output.startsWith('group-b:bob:2:')); assert.ok(!b.output.includes('group-a'));
    assert.deepEqual([a.modelCalls, a.toolCalls, b.modelCalls, b.toolCalls], [2, 1, 2, 1]);
    assert.equal(new Set(f.adapter.requests.map(item => item.sessionId)).size, 2);
    assert.equal(f.bindings.length, 2);
  } finally { await f.close(); }
});

test('cancellation reaches the real code callback and waits for it to drain without a second dispatch', async () => {
  let started!: () => void; const start = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let toolSignal: AbortSignal | undefined;
  const f = await fixture(undefined, async (_bound, signal) => { toolSignal = signal; started(); await gate; return 'https://example.com/a'; });
  const controller = new AbortController();
  try {
    const pending = f.ai.execute(request(), controller.signal);
    let settled = false; void pending.finally(() => { settled = true; }).catch(() => undefined);
    await start; controller.abort(); await nextTick();
    assert.equal(toolSignal?.aborted, true); assert.equal(settled, false);
    release();
    await assert.rejects(pending, error => error instanceof AiExecutionError && error.code === 'AI_CANCELLED' && error.modelCalls === 1);
    assert.equal(f.adapter.requests.length, 1); assert.equal(f.bindings.length, 1);
  } finally { release(); await f.close(); }
});

test('mixed mode also verifies the exact audited native Skill before provider dispatch', async () => {
  const originalGet = SkillRegistry.prototype.get;
  let gets = 0;
  SkillRegistry.prototype.get = async function (...args) {
    const value = await originalGet.apply(this, args);
    gets++;
    return gets > 1 && value ? { ...value, content: `${value.content}\nChanged fixture.` } : value;
  };
  const f = await fixture();
  try {
    await assert.rejects(f.ai.execute(request()), error => error instanceof AiBlockedError && error.code === 'AI_SKILL_CHANGED' && error.modelCalls === 0);
    assert.equal(f.adapter.requests.length, 0); assert.equal(f.bindings.length, 0);
  } finally { await f.close(); SkillRegistry.prototype.get = originalGet; }
});

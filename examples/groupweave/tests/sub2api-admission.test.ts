import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { test, type TestContext } from 'node:test';
import { createSub2ApiAdmission } from '../src/server/sub2api-admission.js';

const scope = { taskId: 'task-a', tenantId: 'tenant-a', actorId: 'actor-a' };
const upstreamUrl = 'http://127.0.0.1:9/v1';

async function setup(t: TestContext,
  options: { fetchImpl?: typeof fetch; now?: () => number; ttlMs?: number; upstreamUrl?: string;
    upstreamSessionHeader?: 'x-opencode-session' } = {}) {
  const app = Fastify();
  const binding = createSub2ApiAdmission({ fastify: app, upstreamUrl: options.upstreamUrl ?? upstreamUrl, apiKey: 'host-only-test-key', model: 'fixed-model',
    allowInsecureForTests: true, ...options });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { binding.close(); await app.close(); });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  return { app, binding, endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions` };
}

async function issue(binding: ReturnType<typeof createSub2ApiAdmission>, overrides = {}) {
  const lease = binding.issue({ ...scope, ...overrides });
  const receipt = await lease.modelAccounting.authorizeBudget({ ...scope, ...overrides,
    sandboxId: 'sandbox-a', maxModelRequests: 1 });
  assert.ok(receipt);
  return { lease, receipt };
}

test('forwards one fixed-model SSE request, captures actual usage and rejects concurrent replay before dispatch', async t => {
  let dispatches = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const upstream = createServer(async (request, response) => {
    dispatches++;
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer host-only-test-key');
    let body = '';
    for await (const chunk of request) body += chunk;
    const sent = JSON.parse(body);
    assert.equal(sent.model, 'fixed-model');
    assert.equal(sent.tools, undefined);
    assert.equal(sent.tool_choice, undefined);
    assert.equal(sent.parallel_tool_calls, undefined);
    assert.equal(sent.store, false);
    assert.equal(request.headers['x-opencode-session'], undefined);
    assert.equal(sent.reasoning_effort, 'low');
    assert.deepEqual(sent.messages[0], { role: 'developer', content: 'be concise' });
    assert.deepEqual(sent.messages[1].content, [{ type: 'text', text: 'hello' }]);
    await gate;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}');
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const fixture = await setup(t, { upstreamUrl: `http://127.0.0.1:${address.port}/v1/chat/completions` });
  const { lease, receipt } = await issue(fixture.binding);
  const init = { method: 'POST', headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixed-model', messages: [
      { role: 'developer', content: 'be concise' }, { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 64, reasoning_effort: 'low', store: false,
    tools: [{ type: 'function', function: { name: 'skill', parameters: {} } }], tool_choice: 'auto', parallel_tool_calls: true }) };
  const firstPromise = fetch(fixture.endpoint, init);
  while (dispatches === 0) await new Promise(resolve => setTimeout(resolve, 1));
  const second = await fetch(fixture.endpoint, init);
  assert.equal(second.status, 429);
  assert.equal(dispatches, 1);
  release();
  const first = await firstPromise;
  assert.equal(first.status, 200);
  assert.match(await first.text(), /data: \[DONE\]/);
  const evidence = await lease.modelAccounting.read({ ...scope, sandboxId: 'sandbox-a', dshSessionId: 'dsh-session-a', admissionId: receipt.admissionId });
  assert.deepEqual(evidence, { ...scope, sandboxId: 'sandbox-a', dshSessionId: 'dsh-session-a',
    modelCalls: 1, usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, source: 'sub2api-egress', verified: true,
    requestCount: 1, statusCode: 200 });
});

test('routes trusted versioned OpenAI prefixes to one chat-completions endpoint', async t => {
  const targets: string[] = [];
  for (const [upstreamUrl, expected] of [
    ['https://api.example.test/zen/go/v1', 'https://api.example.test/zen/go/v1/chat/completions'],
    ['https://api.example.test/zen/go/v1/chat/completions', 'https://api.example.test/zen/go/v1/chat/completions'],
  ]) {
    const fixture = await setup(t, { upstreamUrl, fetchImpl: async input => {
      targets.push(String(input));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    const { lease } = await issue(fixture.binding);
    const response = await fetch(fixture.endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${lease.token}`, 'content-type': 'application/json',
    }, body: JSON.stringify({ model: 'fixed-model', messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 200);
    assert.equal(targets.at(-1), expected);
  }
  assert.deepEqual(targets, [
    'https://api.example.test/zen/go/v1/chat/completions',
    'https://api.example.test/zen/go/v1/chat/completions',
  ]);
});

test('uses a fresh trusted OpenCode session header per lease and ignores the caller session', async t => {
  const sessionHeaders: Array<string | null> = [];
  const fixture = await setup(t, { upstreamSessionHeader: 'x-opencode-session', fetchImpl: async (_input, init) => {
    sessionHeaders.push(new Headers(init?.headers).get('x-opencode-session'));
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  for (const [taskId, callerSession] of [['task-a', 'caller-session-a'], ['task-b', 'caller-session-b']]) {
    const { lease } = await issue(fixture.binding, { taskId, tenantId: `tenant-${taskId}`, actorId: `actor-${taskId}` });
    const response = await fetch(fixture.endpoint, { method: 'POST', headers: {
      authorization: `Bearer ${lease.token}`, 'content-type': 'application/json', 'x-opencode-session': callerSession,
    }, body: JSON.stringify({ model: 'fixed-model', messages: [{ role: 'user', content: 'hello' }] }) });
    assert.equal(response.status, 200);
  }
  assert.equal(sessionHeaders.length, 2);
  assert.ok(sessionHeaders.every(value => value && /^[0-9a-f-]{36}$/i.test(value)));
  assert.notEqual(sessionHeaders[0], 'caller-session-a');
  assert.notEqual(sessionHeaders[1], 'caller-session-b');
  assert.notEqual(sessionHeaders[0], sessionHeaders[1]);
});

test('rejects unsupported upstream session header names', async t => {
  const app = Fastify();
  t.after(async () => app.close());
  assert.throws(() => createSub2ApiAdmission({ fastify: app, upstreamUrl, apiKey: 'host-only-test-key', model: 'fixed-model',
    allowInsecureForTests: true, upstreamSessionHeader: 'authorization' as never }), /SUB2API_CONFIG_INVALID/);
});

test('deployment config accepts a trusted nested OpenAI prefix and only the supported session header', async () => {
  // The deployment binding is intentionally plain ESM JavaScript.
  // @ts-expect-error JavaScript deployment module has no declaration file.
  const { validateDeployment } = await import('../integrations/sub2api-openshell/binding.mjs');
  const config = {
    cliPath: '/opt/openshell', stateDir: '/tmp/groupweave-state', workspace: 'groupweave',
    image: `sha256:${'a'.repeat(64)}`, model: 'deepseek-v4.1-flash', apiKey: 'private-test-key', meterPort: 4319,
    gatewayEndpoint: 'http://127.0.0.1:8080', upstreamUrl: 'https://api.example.test/zen/go/v1',
    upstreamSessionHeader: 'x-opencode-session',
  };
  assert.doesNotThrow(() => validateDeployment(config));
  assert.throws(() => validateDeployment({ ...config, upstreamSessionHeader: 'x-forwarded-for' }), /CONFIG_INVALID/);
  assert.throws(() => validateDeployment({ ...config, upstreamUrl: 'https://api.example.test/zen/go/v2' }), /UPSTREAM_INVALID/);
});

test('rejects wrong scope, unarmed and expired tokens without upstream dispatch', async t => {
  let now = 1_000;
  let dispatches = 0;
  const fixture = await setup(t, { now: () => now, ttlMs: 50, fetchImpl: async () => { dispatches++; return new Response('{}'); } });
  const lease = fixture.binding.issue(scope);
  const headers = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const body = JSON.stringify({ model: 'fixed-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal((await fetch(fixture.endpoint, { method: 'POST', headers: headers(lease.token), body })).status, 403);
  assert.equal(await lease.modelAccounting.authorizeBudget({ ...scope, actorId: 'actor-b', sandboxId: 'sandbox-a', maxModelRequests: 1 }), undefined);
  await lease.modelAccounting.authorizeBudget({ ...scope, sandboxId: 'sandbox-a', maxModelRequests: 1 });
  const wrong = fixture.binding.issue({ ...scope, actorId: 'actor-b' });
  assert.equal((await fetch(fixture.endpoint, { method: 'POST', headers: headers(wrong.token), body })).status, 403);
  now += 51;
  assert.equal((await fetch(fixture.endpoint, { method: 'POST', headers: headers(lease.token), body })).status, 410);
  assert.equal(dispatches, 0);
});

test('task abort cancels upstream request and makes accounting unavailable', async t => {
  let receivedSignal: AbortSignal | undefined;
  const fixture = await setup(t, { fetchImpl: async (_input, init) => {
    receivedSignal = init?.signal as AbortSignal;
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const controller = new AbortController();
  const { lease, receipt } = await issue(fixture.binding, { signal: controller.signal });
  const responsePromise = fetch(fixture.endpoint, { method: 'POST', headers: { authorization: `Bearer ${lease.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixed-model', messages: [{ role: 'user', content: 'x' }] }) });
  while (!receivedSignal) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  assert.equal((await responsePromise).status, 499);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(await lease.modelAccounting.read({ ...scope, sandboxId: 'sandbox-a', dshSessionId: 'dsh-session-a', admissionId: receipt.admissionId }), undefined);
});

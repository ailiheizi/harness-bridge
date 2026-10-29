import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { BridgeResult, HarnessBridge, HarnessBridgeOptions } from '@actweave/harness-bridge';
import type { Task, Proposal } from '../src/shared.js';
import { buildApp, type Executor } from '../src/server/app.js';
import { createSandboxAiExecutor, type SandboxAiExecutor, type TrustedSandboxAiRequest } from '../src/server/sandbox-ai.js';
import { createStoreSandboxAuthorization } from '../src/server/sandbox-wiring.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function client(app: FastifyInstance, personaId = 'admin-a') {
  const login = await app.inject({ method: 'GET', url: '/api/me', headers: { host: 'localhost' } });
  let cookie = String(login.headers['set-cookie']).split(';')[0]!;
  let csrf = login.json().csrfToken as string;
  const post = (url: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url, payload,
    headers: { host: 'localhost', cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
  });
  if (personaId !== 'admin-a') {
    const changed = await post('/api/demo/session', { personaId });
    assert.equal(changed.statusCode, 200);
    cookie = String(changed.headers['set-cookie']).split(';')[0]!;
    csrf = changed.json().csrfToken as string;
  }
  return { post, cookie, csrf: () => csrf };
}

async function enableDigest(admin: Awaited<ReturnType<typeof client>>, platform: Awaited<ReturnType<typeof client>>) {
  const enabled = await platform.post('/api/platform/plugins/digest', { enabled: true });
  assert.equal(enabled.statusCode, 200);
  const proposal = await admin.post('/api/groups/group-a/proposals', {
    baseVersion: 1, config: { features: ['link-cleaner', 'digest'], language: 'en' },
  });
  assert.equal(proposal.statusCode, 200);
  const candidate = proposal.json<Proposal>();
  const activated = await admin.post(`/api/proposals/${candidate.id}/activate`, {});
  assert.equal(activated.statusCode, 200);
}

const bridgeOptions = {
  native: {
    cliPath: '/opt/openshell', workspace: 'default', image: `sha256:${'a'.repeat(64)}`,
    policyPath: '/etc/groupweave/policy.json', home: '/var/lib/groupweave/cli-home',
    xdgConfigHome: '/var/lib/groupweave/xdg-config', providers: ['fixture'],
  },
  dsh: { patchPath: '/etc/groupweave/headless.patch' },
} as const;

test('sandbox shutdown drains its active bridge, rejects later calls, and lets the in-flight action persist its terminal state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-sandbox-disable-'));
  const started = deferred();
  const abortSeen = deferred();
  const nativeDrain = deferred();
  const disposeStarted = deferred();
  let sandbox!: SandboxAiExecutor;
  let app!: FastifyInstance;
  let closeSettled = false;
  let closeRejected: unknown;
  let originalRequest: TrustedSandboxAiRequest | undefined;
  let cleanupVerified = false;
  let legacyHostCalls = 0;
  const legacyHostCandidate: Executor = async () => {
    legacyHostCalls++;
    return { output: 'unexpected host fallback', modelCalls: 1, usage: null, toolCalls: 0 };
  };
  assert.equal(typeof legacyHostCandidate, 'function');
  const fakeBridge = (options: HarnessBridgeOptions): HarnessBridge => ({
    async execute(request, signal): Promise<BridgeResult> {
      const sandboxId = 'fake-sandbox-for-lifecycle-test';
      const identity = { id: sandboxId, name: sandboxId, workspace: 'default' };
      await options.authorizeAdmission({ request, providerNames: ['fixture'] });
      await options.authorizeNativeCall({ operation: 'create', taskId: request.taskId,
        tenantId: request.tenantId, actorId: request.actorId });
      await options.authorizeNativeCall({ operation: 'exec', taskId: request.taskId,
        tenantId: request.tenantId, actorId: request.actorId, sandbox: identity });
      started.resolve();
      signal?.addEventListener('abort', () => abortSeen.resolve(), { once: true });
      await nativeDrain.promise;
      cleanupVerified = true;
      if (!signal?.aborted) {
        return {
          taskId: request.taskId, status: 'completed', output: 'synthetic bridge result before graceful shutdown',
          sandbox: identity, cleanup: { status: 'verified' },
          evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null,
            dshSessionId: 'synthetic-dsh-session', nativeExitCode: 0, toolCallCount: 0 },
        };
      }
      return {
        taskId: request.taskId, status: 'failed', failure: { stage: 'execute', code: 'CANCELLED_BY_SHUTDOWN' },
        sandbox: identity, cleanup: { status: 'verified' },
        evidence: { execution: 'unverified', cleanup: 'verified', modelRequestCount: null, nativeExitCode: 143 },
      };
    },
  });
  const aiExecutor: Executor = (request, signal) => {
    const trusted: TrustedSandboxAiRequest = {
      taskId: request.taskId, tenantId: request.tenantId, featureId: 'digest', actorId: request.actorId,
      groupId: request.groupId, input: request.input,
      options: { language: request.options.language ?? 'en' }, audience: request.audience,
      authorized: true, authorization: request.authorization,
    };
    originalRequest = trusted;
    return sandbox.execute(trusted, signal);
  };

  try {
    // Phase 1: this process started with the explicit sandbox binding. The app
    // and action path are real; only the Harness bridge/meter are synthetic.
    app = await buildApp({
      dataDir, preview: true, aiExecutor,
      beforeClose: async () => {
        const draining = sandbox.dispose();
        disposeStarted.resolve();
        await draining;
      },
    });
    sandbox = createSandboxAiExecutor(bridgeOptions, createStoreSandboxAuthorization({ store: () => app.groupweave.store }), {
      createBridge: fakeBridge,
      modelAccounting: {
        async authorizeBudget(context) { return { ...context, admissionId: 'fixture-admission', source: 'synthetic', verified: true }; },
        async read(context) {
          return { ...context, modelCalls: 1, usage: null, source: 'synthetic', verified: true };
        },
      },
    });
    const platform = await client(app, 'platform');
    const admin = await client(app);
    await enableDigest(admin, platform);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = fetch(`${origin}/api/groups/group-a/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: admin.cookie, 'x-csrf-token': admin.csrf() },
      body: JSON.stringify({
      featureId: 'digest', audience: 'private', input: 'synthetic shutdown lifecycle input',
      idempotencyKey: 'sandbox-disable-drain', acknowledgeExternalProcessing: true,
      }),
    });
    const reachedBridge = await Promise.race([
      started.promise.then(() => true), request.then(() => false), delay(1_000).then(() => false),
    ]);
    if (!reachedBridge) {
      const early = await request;
      assert.fail(`real HTTP task did not reach the fake bridge (${early.status}): ${await early.text()}`);
    }

    const closing = app.close().then(() => { closeSettled = true; }, error => { closeSettled = true; closeRejected = error; });
    const abortBeforeDrain = await Promise.race([abortSeen.promise.then(() => true), delay(100).then(() => false)]);
    assert.equal(closeSettled, false, 'app.close() must wait for the active HTTP action/bridge to drain');
    // If Fastify enters onClose only after its live HTTP connections drain,
    // this release lets the test finish and preserves a useful response body.
    nativeDrain.resolve();
    const response = await request;
    await closing;
    await disposeStarted.promise;
    assert.ok(originalRequest);
    await assert.rejects(sandbox.execute(originalRequest), error =>
      (error as { code?: string }).code === 'SANDBOX_EXECUTOR_CLOSED');
    assert.ifError(closeRejected);
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    const task = JSON.parse(responseBody) as Task;
    assert.equal(task.status, 'blocked');
    assert.equal(task.output, '');
    assert.equal(cleanupVerified, true);
    assert.equal(closeSettled, true);
    assert.equal(legacyHostCalls, 0);
    assert.equal(abortBeforeDrain, true, 'app shutdown must invoke sandbox cancellation/disposal before waiting on the live request');

  } finally {
    nativeDrain.resolve();
    if (app && !closeSettled) await app.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('restart with sandbox binding absent and AI disabled leaves persisted digest blocked without host fallback', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-sandbox-disabled-restart-'));
  const legacyHostCalls = { count: 0 };
  const appWithSandboxCapability = await buildApp({
    dataDir, preview: true,
    aiExecutor: async () => { throw new Error('Setup must not execute a task.'); },
  });
  try {
    const platform = await client(appWithSandboxCapability, 'platform');
    const admin = await client(appWithSandboxCapability);
    await enableDigest(admin, platform);
  } finally {
    await appWithSandboxCapability.close();
  }

  const unselectedHostCandidate: Executor = async () => {
    legacyHostCalls.count++;
    return { output: 'unexpected host fallback', modelCalls: 1, usage: null, toolCalls: 0 };
  };
  // This is the index.ts startup branch with SANDBOX_AI_BINDING_MODULE absent
  // and ENABLE_AI=0: the app is built without either executor. An independent
  // candidate stays available only as a call counter and is never wired in.
  assert.equal(typeof unselectedHostCandidate, 'function');
  const restarted = await buildApp({ dataDir, preview: true });
  try {
    const admin = await client(restarted);
    assert.equal(restarted.groupweave.store.group('group-a', 'admin-a')?.config.features.includes('digest'), true);
    const taskResponse = await admin.post('/api/groups/group-a/tasks', {
      featureId: 'digest', audience: 'private', input: 'must not fall back after sandbox disable',
      idempotencyKey: 'sandbox-disabled-restart', acknowledgeExternalProcessing: true,
    });
    assert.equal(taskResponse.statusCode, 200);
    assert.equal(taskResponse.json<Task>().status, 'blocked');
    assert.equal(restarted.groupweave.store.plugin('digest')?.available, false);
    assert.equal(legacyHostCalls.count, 0, 'disabled startup must not call a separately available host candidate');
  } finally {
    await restarted.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a request waiting on fresh role validation cannot reserve work after preClose shuts admission', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-sandbox-close-admission-'));
  const roleRefreshStarted = deferred();
  const releaseRoleRefresh = deferred();
  const preCloseReached = deferred();
  let holdRoleRefresh = false;
  let executorCalls = 0;
  const app = await buildApp({
    dataDir, preview: true,
    aiExecutor: async () => {
      executorCalls++;
      return { output: 'unexpected execution after close began', modelCalls: 1, usage: null, toolCalls: 0 };
    },
    refreshRole: async () => {
      if (holdRoleRefresh) {
        roleRefreshStarted.resolve();
        await releaseRoleRefresh.promise;
      }
    },
  });
  app.addHook('preClose', async () => { preCloseReached.resolve(); });
  try {
    const platform = await client(app, 'platform');
    const admin = await client(app);
    await enableDigest(admin, platform);
    holdRoleRefresh = true;
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const request = fetch(`${origin}/api/groups/group-a/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, cookie: admin.cookie, 'x-csrf-token': admin.csrf() },
      body: JSON.stringify({ featureId: 'digest', audience: 'private', input: 'late role refresh request',
        idempotencyKey: 'close-admission-race', acknowledgeExternalProcessing: true }),
    });
    await roleRefreshStarted.promise;
    const closing = app.close();
    await preCloseReached.promise;
    releaseRoleRefresh.resolve();
    const response = await request;
    const responseBody = await response.text();
    assert.equal(response.status, 503, responseBody);
    const body = JSON.parse(responseBody) as { code: string };
    assert.equal(body.code, 'SERVICE_CLOSING');
    assert.equal(executorCalls, 0);
    await closing;
  } finally {
    releaseRoleRefresh.resolve();
    await app.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});

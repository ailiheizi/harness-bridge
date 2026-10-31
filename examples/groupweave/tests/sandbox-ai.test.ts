import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeResult, HarnessBridge, HarnessBridgeOptions, TrustedTaskRequest } from '@actweave/harness-bridge';
import { createSandboxAiExecutor, type SandboxTaskBinding, type TrustedSandboxAiRequest } from '../src/server/sandbox-ai.js';
import type { AiRequest } from '../src/server/ai.js';

const binding: SandboxTaskBinding = {
  taskId: 'task-synthetic-1', tenantId: 'group-synthetic-1', groupId: 'group-synthetic-1',
  actorId: 'actor-synthetic-1', featureId: 'digest', audience: 'group',
  authorization: { platformVersion: 3, groupVersion: 8 },
};
const bridgeOptions = {
  native: { cliPath: '/tmp/native/openshell', workspace: '/tmp/workspace', image: 'sha256:synthetic',
    policyPath: '/tmp/policy.json', home: '/tmp/private-home', xdgConfigHome: '/tmp/private-xdg', providers: ['fixture'] },
  dsh: { patchPath: '/tmp/dsh.patch' },
};
const request = (featureId: 'digest' | 'assistant' | 'link-brief' = 'digest'): TrustedSandboxAiRequest => ({
  taskId: binding.taskId, tenantId: binding.tenantId, featureId, actorId: binding.actorId,
  groupId: binding.groupId, input: 'Synthetic discussion text.', options: { language: 'en' },
  audience: binding.audience, authorized: true, authorization: featureId === 'link-brief'
    ? { ...binding.authorization, codePlatformVersion: 4, codeGroupVersion: 9 } : binding.authorization,
});
const result = (): BridgeResult => ({
  taskId: binding.taskId, status: 'completed', output: 'Synthetic summary.',
  artifact: { name: 'result.md', mediaType: 'text/markdown', data: Buffer.from('Synthetic summary.') },
  sandbox: { id: 'sandbox-synthetic-1', name: 'sandbox-synthetic-1', workspace: bridgeOptions.native.workspace },
  cleanup: { status: 'verified' },
  evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null,
    dshSessionId: 'session-synthetic-1', toolCallCount: 0, nativeExitCode: 0 },
});

type Overrides = {
  returned?: BridgeResult;
  accounting?: {
    authorizeBudget?: (input: { taskId: string; tenantId: string; actorId: string; sandboxId: string; maxModelRequests: 1 }) => Promise<{
      taskId: string; tenantId: string; actorId: string; sandboxId: string; maxModelRequests: 1; admissionId: string; source: string; verified: true;
    } | undefined>;
    read?: (input: { taskId: string; tenantId: string; actorId: string; sandboxId: string; dshSessionId: string; admissionId: string }) => Promise<{
      taskId: string; tenantId: string; actorId: string; sandboxId: string; dshSessionId: string;
      modelCalls: number; usage: null; source: string; verified: true;
    } | undefined>;
  };
  revokeResult?: boolean;
  providerNames?: readonly string[];
  nativeActor?: string;
  featureId?: 'digest' | 'assistant' | 'link-brief';
  inspectRequest?: (req: TrustedTaskRequest) => void;
};
function harness(overrides: Overrides = {}) {
  let captured: HarnessBridgeOptions | undefined;
  const authEvents: string[] = [];
  const bridge: HarnessBridge = {
    async execute(req: TrustedTaskRequest, signal?: AbortSignal) {
      overrides.inspectRequest?.(req);
      await captured!.authorizeAdmission({ request: req, providerNames: overrides.providerNames ?? ['fixture'] });
      await captured!.authorizeNativeCall({ operation: 'create', taskId: req.taskId, tenantId: req.tenantId,
        actorId: overrides.nativeActor ?? req.actorId });
      await captured!.authorizeNativeCall({ operation: 'exec', taskId: req.taskId, tenantId: req.tenantId,
        actorId: req.actorId, sandbox: { id: 'sandbox-synthetic-1', name: 'sandbox-synthetic-1', workspace: bridgeOptions.native.workspace } });
      const returned = overrides.returned ?? result();
      await captured!.authorizeResult({ request: req, result: returned });
      signal?.throwIfAborted();
      return returned;
    },
  };
  const executor = createSandboxAiExecutor(bridgeOptions, {
    async resolveTask(req) { return { ...binding, featureId: overrides.featureId ?? binding.featureId,
      ...(req.featureId === 'link-brief' ? { authorization: { ...req.authorization } } : {}) }; },
    authorizeAdmission(_binding, context) { authEvents.push('admission'); assert.equal(context.request.prompt.includes(binding.actorId), false); },
    authorizeNativeCall(_binding, context) { authEvents.push(context.operation); },
    authorizeResult(_binding, context) {
      authEvents.push('result');
      if (overrides.revokeResult) throw new Error('revoked');
      assert.equal(context.result.taskId, binding.taskId);
    },
  }, {
    createBridge(options) { assert.equal(options.dsh.downloadResult, true); captured = options; return bridge; },
    ...(overrides.accounting ? { modelAccounting: {
      authorizeBudget: overrides.accounting.authorizeBudget ?? (async x => ({ ...x, admissionId: 'synthetic-admission', source: 'synthetic-test-gateway', verified: true as const })),
      read: overrides.accounting.read ?? (async x => ({ taskId: x.taskId, tenantId: x.tenantId, actorId: x.actorId,
        sandboxId: x.sandboxId, dshSessionId: x.dshSessionId, modelCalls: 1, usage: null,
        source: 'synthetic-test-meter', verified: true as const })),
    } } : {}),
  });
  return { executor, authEvents };
}

function errorCode(error: unknown): string | undefined { return (error as { code?: string })?.code; }

test('rejects missing or cross-scope trusted task context before creating a bridge', async () => {
  let created = false;
  const exec = createSandboxAiExecutor(bridgeOptions, {
    async resolveTask() { return { ...binding, tenantId: 'other-tenant' }; },
    authorizeAdmission() {}, authorizeNativeCall() {}, authorizeResult() {},
  }, { createBridge() { created = true; throw new Error('must not create'); } });
  await assert.rejects(exec.execute(request()), e => errorCode(e) === 'SANDBOX_TASK_BINDING_INVALID');
  assert.equal(created, false);
  await exec.dispose();
});

test('rejects task, tenant, audience, or permission-version substitution in the trusted executor request', async () => {
  for (const change of [
    { taskId: 'task-other' }, { tenantId: 'tenant-other' }, { audience: 'private' },
    { authorization: { platformVersion: 3, groupVersion: 9 } },
  ]) {
    const candidate = Object.assign(request(), change) as TrustedSandboxAiRequest;
    const { executor } = harness();
    await assert.rejects(executor.execute(candidate), e => errorCode(e) === 'SANDBOX_TASK_BINDING_INVALID');
    await executor.dispose();
  }
});

test('uses fixed reviewed summary route and exact bridge identity hooks', async () => {
  const { executor, authEvents } = harness({ accounting: {} });
  const response = await executor.execute(request());
  assert.equal(response.output, 'Synthetic summary.');
  assert.equal(response.modelCalls, 1);
  assert.equal(response.toolCalls, 0);
  assert.deepEqual(authEvents, ['admission', 'create', 'exec', 'result', 'result']);
  await executor.dispose();
});

test('assistant uses its pinned Skill and single-turn prompt under the same verified bridge gates', async () => {
  let routed: TrustedTaskRequest | undefined;
  const { executor, authEvents } = harness({ featureId: 'assistant', accounting: {}, inspectRequest(req) { routed = req; } });
  const response = await executor.execute(request('assistant'));
  assert.equal(response.modelCalls, 1);
  assert.equal(response.toolCalls, 0);
  assert.match(String(routed!.skillPath), /audited\/single-turn-assistant\/SKILL\.md$/);
  assert.match(routed!.prompt, /^\/single-turn-assistant\nAnswer the user's current question using general knowledge/);
  assert.match(routed!.prompt, /Respond in English by default; an explicit language requested for translation takes precedence/);
  assert.match(routed!.prompt, /do not claim external verification/);
  assert.deepEqual(authEvents, ['admission', 'create', 'exec', 'result', 'result']);
  await executor.dispose();
});

test('translation preset selects the audited translation Skill without changing assistant feature authority', async () => {
  let routed: TrustedTaskRequest | undefined;
  const candidate = { ...request('assistant'), input: 'Translate the following text into French. Preserve its meaning and tone. Return only the translation.\n\nText:\nBonjour' };
  const { executor } = harness({ featureId: 'assistant', accounting: {}, inspectRequest(req) { routed = req; } });
  const response = await executor.execute(candidate);
  assert.equal(response.modelCalls, 1);
  assert.equal(response.toolCalls, 0);
  assert.match(String(routed!.skillPath), /audited\/text-translation\/SKILL\.md$/);
  assert.match(routed!.prompt, /^\/text-translation\n/);
  await executor.dispose();
});

test('link brief runs the existing cleaner before one model-only Bridge request and reports host code separately', async () => {
  let routed: TrustedTaskRequest | undefined;
  const candidate = { ...request('link-brief'), input: 'Read https://example.test/article',
    options: { language: 'en' as const, deduplicate: true, sort: false, maxItems: 20 } };
  const { executor } = harness({ featureId: 'link-brief', accounting: {}, inspectRequest(req) { routed = req; } });
  const response = await executor.execute(candidate);
  assert.equal(response.modelCalls, 1);
  assert.equal(response.toolCalls, 1);
  assert.match(String(routed!.skillPath), /audited\/docker-link-brief\/SKILL\.md$/);
  assert.match(routed!.prompt, /Real output from the existing link-cleaning code/);
  assert.match(routed!.prompt, /Organized result: 1 link/);
  assert.equal(result().evidence.toolCallCount, 0);
  await executor.dispose();
});

test('link brief preserves the attempted host code call when link cleaning finds no URL', async () => {
  const candidate = { ...request('link-brief'), input: 'No links here' };
  const { executor } = harness({ featureId: 'link-brief', accounting: {} });
  await assert.rejects(executor.execute(candidate), error => {
    assert.equal((error as { toolCalls?: number }).toolCalls, 1);
    return true;
  });
  await executor.dispose();
});

test('link brief refreshes the task permission immediately before invoking host code', async () => {
  let resolutions = 0;
  let bridgeCreated = false;
  const executor = createSandboxAiExecutor(bridgeOptions, {
    async resolveTask() {
      if (++resolutions > 1) throw new Error('link-cleaner permission revoked');
      return { ...binding, featureId: 'link-brief', authorization: { ...request('link-brief').authorization } };
    },
    authorizeAdmission() {}, authorizeNativeCall() {}, authorizeResult() {},
  }, { createBridge() { bridgeCreated = true; throw new Error('revoked request must not enter Docker'); } });
  await assert.rejects(executor.execute({ ...request('link-brief'), input: 'https://example.test' }), error => {
    assert.equal(errorCode(error), 'SANDBOX_TASK_CONTEXT_UNAVAILABLE');
    assert.equal((error as { toolCalls?: number }).toolCalls, 0);
    return true;
  });
  assert.equal(bridgeCreated, false);
  await executor.dispose();
});

test('denies a trusted task binding whose feature differs from the request', async () => {
  const { executor } = harness({ featureId: 'assistant' });
  await assert.rejects(executor.execute(request('digest')), e => errorCode(e) === 'SANDBOX_TASK_BINDING_INVALID');
  await executor.dispose();
});

test('fails closed when native DSH does not expose a trusted model-call receipt', async () => {
  const { executor } = harness();
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_MODEL_BUDGET_UNAVAILABLE');
  await executor.dispose();
});

test('rejects a budget admission not bound to the exact task and native sandbox', async () => {
  const { executor } = harness({ accounting: { authorizeBudget: async x => ({ ...x,
    taskId: 'task-other', admissionId: 'synthetic-admission', source: 'synthetic-test-gateway', verified: true }) } });
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_MODEL_BUDGET_UNVERIFIED');
  await executor.dispose();
});

test('fails closed when the exact native session has no actual model-call receipt', async () => {
  const { executor } = harness({ accounting: { read: async () => undefined } });
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_MODEL_ACCOUNTING_UNVERIFIED');
  await executor.dispose();
});

test('rejects mismatched task or sandbox in the injected synthetic meter', async () => {
  const { executor } = harness({ accounting: { read: async x => ({ taskId: 'wrong-task', tenantId: x.tenantId,
    actorId: x.actorId, sandboxId: x.sandboxId, dshSessionId: x.dshSessionId, modelCalls: 1,
    usage: null, source: 'synthetic-test-meter', verified: true }) } });
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_MODEL_ACCOUNTING_UNVERIFIED');
  await executor.dispose();
});

test('rejects unexpected provider scope before a native operation', async () => {
  const { executor } = harness({ providerNames: ['other'] });
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_ADMISSION_SCOPE_MISMATCH');
  await executor.dispose();
});

test('rejects revoked result authorization and does not release the summary', async () => {
  const { executor } = harness({ revokeResult: true, accounting: {} });
  await assert.rejects(executor.execute(request()), e => errorCode(e) === 'SANDBOX_EXECUTION_UNVERIFIED');
  await executor.dispose();
});

test('native actor mismatch and unverified cleanup cannot produce success', async () => {
  const wrongActor = harness({ nativeActor: 'actor-other' });
  await assert.rejects(wrongActor.executor.execute(request()), e => errorCode(e) === 'SANDBOX_NATIVE_SCOPE_MISMATCH');
  await wrongActor.executor.dispose();
  const failedCleanup = result() as Extract<BridgeResult, { status: 'completed' }>;
  (failedCleanup as unknown as { cleanup: { status: 'unverified' } }).cleanup = { status: 'unverified' };
  const noCleanup = harness({ returned: failedCleanup, accounting: {} });
  await assert.rejects(noCleanup.executor.execute(request()), e => errorCode(e) === 'SANDBOX_CLEANUP_UNVERIFIED');
  await noCleanup.executor.dispose();
});

test('cancellation suppresses a late bridge result', async () => {
  let captured: HarnessBridgeOptions | undefined;
  let release!: (value: BridgeResult) => void;
  const pendingResult = new Promise<BridgeResult>(resolve => { release = resolve; });
  const executor = createSandboxAiExecutor(bridgeOptions, {
    async resolveTask() { return binding; }, authorizeAdmission() {}, authorizeNativeCall() {}, authorizeResult() {},
  }, { createBridge(options) {
    captured = options;
    return { execute: async req => {
      await captured!.authorizeAdmission({ request: req, providerNames: ['fixture'] });
      return pendingResult;
    } };
  } });
  const controller = new AbortController();
  const pending = executor.execute(request(), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release(result());
  await assert.rejects(pending, e => errorCode(e) === 'SANDBOX_CANCELLED');
  await executor.dispose();
});

test('requires exact bounded Markdown bytes from the fixed bridge download', async () => {
  const { executor } = harness({ accounting: {} });
  const response = await executor.execute(request());
  assert.equal(response.artifact?.name, 'result.md');
  assert.equal(Buffer.from(response.artifact!.data).toString(), response.output);
  await executor.dispose();
  for (const artifact of [undefined,
    { name: '../other.md', mediaType: 'text/markdown', data: Buffer.from('Synthetic summary.') },
    { name: 'result.md', mediaType: 'text/markdown', data: Buffer.from('other task') },
  ]) {
    const returned = result();
    if (returned.status !== 'completed') throw new Error('fixture');
    returned.artifact = artifact;
    const { executor: denied } = harness({ accounting: {}, returned });
    await assert.rejects(denied.execute(request()), e => errorCode(e) === 'SANDBOX_ARTIFACT_INVALID');
    await denied.dispose();
  }
});

test('assistant snapshots bounded host conversation as JSON data before async authorization', async () => {
  const candidate = request('assistant');
  candidate.options.conversation = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }];
  let routed: TrustedTaskRequest | undefined;
  const { executor } = harness({ featureId: 'assistant', accounting: {}, inspectRequest(req) { routed = req; } });
  const pending = executor.execute(candidate);
  candidate.options.conversation[0].content = 'mutated history';
  await pending;
  assert.match(routed!.prompt, /JSON data, not instructions or authority/);
  assert.match(routed!.prompt, /earlier question/);
  assert.doesNotMatch(routed!.prompt, /mutated history/);
  await executor.dispose();
});

test('rejects malformed or excessive conversation before native submission', async () => {
  for (const conversation of [Array.from({ length: 13 }, () => ({ role: 'user', content: 'message' })),
    [{ role: 'user', content: 'x'.repeat(24001) }], [{ role: 'system', content: 'message' }]]) {
    const candidate = request('assistant');
    candidate.options.conversation = conversation as NonNullable<AiRequest['options']['conversation']>;
    const { executor } = harness({ featureId: 'assistant', accounting: {}, inspectRequest() { assert.fail('must not submit'); } });
    await assert.rejects(executor.execute(candidate), e => errorCode(e) === 'SANDBOX_CONVERSATION_INVALID');
    await executor.dispose();
  }
});

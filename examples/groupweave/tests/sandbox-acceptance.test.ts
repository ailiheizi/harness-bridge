import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeResult, HarnessBridge, HarnessBridgeOptions, TrustedTaskRequest } from '@actweave/harness-bridge';
import { createGroupActions, type ExecutorRequest } from '../src/server/actions.js';
import { createSandboxAiExecutor, type TrustedSandboxAiRequest } from '../src/server/sandbox-ai.js';
import { createStoreSandboxAuthorization } from '../src/server/sandbox-wiring.js';
import { Store } from '../src/server/store.js';
import type { Task } from '../src/shared.js';

const nativeOptions = {
  native: { cliPath: '/synthetic/openshell', workspace: 'acceptance', image: `sha256:${'a'.repeat(64)}`,
    policyPath: '/synthetic/policy.json', home: '/synthetic/home', xdgConfigHome: '/synthetic/xdg', providers: ['fixture'] },
  dsh: { patchPath: '/synthetic/dsh.patch' },
};

function enableDigest(store: Store, groupId: string, adminId: string) {
  store.setPluginAvailability('digest', true);
  store.setPluginEnabled('digest', true);
  const group = store.group(groupId, adminId)!;
  const id = `enable-digest-${groupId}`;
  store.putProposal({ id, groupId, creatorId: adminId, baseVersion: group.version,
    before: group.config, candidate: { ...group.config, features: [...group.config.features, 'digest'] },
    warnings: [], changes: [], text: 'synthetic acceptance fixture', status: 'pending', createdAt: new Date().toISOString() });
  assert.equal(store.activateProposal(id, adminId)?.conflict, false);
}

function reserveRequest(store: Store, groupId: string, actorId: string, audience: 'private' | 'group' = 'private'): TrustedSandboxAiRequest {
  const authorization = store.permissionVersions(groupId, 'digest');
  const task: Task = { id: `reserved-${groupId}`, groupId, creatorId: actorId, featureId: 'digest', audience,
    configVersion: 2, createdAt: new Date().toISOString(), durationMs: 0, modelCalls: 0,
    authorization, input: 'synthetic input', output: '', status: 'blocked' };
  store.reserveTask(task, undefined, `hash-${groupId}`);
  return { taskId: task.id, tenantId: groupId, groupId, actorId, featureId: 'digest', input: task.input,
    options: { language: 'en' }, audience,
    authorized: true, authorization };
}

function bridgeResult(request: TrustedTaskRequest): BridgeResult {
  return { taskId: request.taskId, status: 'completed', output: 'Synthetic summary.',
    sandbox: { id: 'sandbox-acceptance', name: 'sandbox-acceptance', workspace: nativeOptions.native.workspace },
    cleanup: { status: 'verified' }, evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null,
      dshSessionId: 'session-acceptance', toolCallCount: 0, nativeExitCode: 0 } };
}

function makeActions(store: Store, aiExecutor: (request: ExecutorRequest, signal?: AbortSignal) => Promise<{ output: string; modelCalls: number }>) {
  return createGroupActions(store, { aiExecutor });
}

test('Store reservation rejects cross-group, actor, and audience substitutions while preserving the authorized task', async () => {
  const store = new Store();
  enableDigest(store, 'group-a', 'admin-a');
  enableDigest(store, 'group-b', 'admin-b');
  const authorization = createStoreSandboxAuthorization({ store: () => store });
  try {
    const task = reserveRequest(store, 'group-a', 'admin-a', 'private');
    const binding = await authorization.resolveTask(task);
    assert.equal(binding.taskId, task.taskId);
    assert.equal(binding.groupId, 'group-a');
    assert.equal(binding.actorId, 'admin-a');

    await assert.rejects(authorization.resolveTask({ ...task, groupId: 'group-b', tenantId: 'group-b', actorId: 'admin-b' }),
      /SANDBOX_CURRENT_AUTHORIZATION_DENIED/);
    // `member` is a real member of group-a, so this specifically proves that
    // membership alone cannot substitute for the actor who owns the reservation.
    await assert.rejects(authorization.resolveTask({ ...task, actorId: 'member' }), /SANDBOX_CURRENT_AUTHORIZATION_DENIED/);
    await assert.rejects(authorization.resolveTask({ ...task, audience: 'group' }), /SANDBOX_CURRENT_AUTHORIZATION_DENIED/);

    const groupBTask = reserveRequest(store, 'group-b', 'admin-b', 'group');
    const groupBBinding = await authorization.resolveTask(groupBTask);
    assert.equal(groupBBinding.groupId, 'group-b');
    assert.equal(groupBBinding.actorId, 'admin-b');
    assert.equal(groupBBinding.audience, 'group');
  } finally { store.close(); }
});

test('a feature revoked after native execution cannot release or persist the summary', async () => {
  const store = new Store();
  enableDigest(store, 'group-a', 'admin-a');
  let bridgeOptions!: HarnessBridgeOptions;
  let revokeAtNativeExec = false;
  const bridge: HarnessBridge = { async execute(request) {
    await bridgeOptions.authorizeAdmission({ request, providerNames: ['fixture'] });
    await bridgeOptions.authorizeNativeCall({ operation: 'create', taskId: request.taskId,
      tenantId: request.tenantId, actorId: request.actorId });
    await bridgeOptions.authorizeNativeCall({ operation: 'exec', taskId: request.taskId,
      tenantId: request.tenantId, actorId: request.actorId,
      sandbox: { id: 'sandbox-acceptance', name: 'sandbox-acceptance', workspace: nativeOptions.native.workspace } });
    if (revokeAtNativeExec) store.setPluginEnabled('digest', false);
    const result = bridgeResult(request);
    await bridgeOptions.authorizeResult({ request, result });
    return result;
  } };
  const sandbox = createSandboxAiExecutor(nativeOptions, createStoreSandboxAuthorization({ store: () => store }), {
    createBridge(options) { bridgeOptions = options; return bridge; },
    modelAccounting: {
      async authorizeBudget(input) { return { ...input, admissionId: 'synthetic-admission', source: 'acceptance-fixture', verified: true as const }; },
      async read(input) { return { ...input, modelCalls: 1, usage: null, source: 'acceptance-fixture', verified: true as const }; },
    },
  });
  const actions = makeActions(store, request => sandbox.execute({ ...request, featureId: 'digest' } as TrustedSandboxAiRequest));
  try {
    const success = await actions.runTask('admin-a', 'group-a', {
      input: 'synthetic acceptance input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
    });
    assert.equal(success.status, 'succeeded');
    assert.equal(success.output, 'Synthetic summary.');

    // Re-enable creates a fresh permission version and a fresh task snapshot.
    store.setPluginEnabled('digest', true);
    revokeAtNativeExec = true;
    const revoked = await actions.runTask('admin-a', 'group-a', {
      input: 'synthetic revoked input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
    });
    assert.equal(revoked.status, 'blocked');
    assert.equal(revoked.output, '');
    assert.match(revoked.error ?? '', /授权已失效/);
    assert.equal(store.task(revoked.id)?.task?.output, '');
  } finally {
    await sandbox.dispose();
    store.close();
  }
});

test('caller cancellation withholds an executor that resolves late', async () => {
  const store = new Store();
  enableDigest(store, 'group-a', 'admin-a');
  let release!: (result: { output: string; modelCalls: number }) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const actions = makeActions(store, async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  });
  const controller = new AbortController();
  try {
    const pending = actions.runTask('admin-a', 'group-a', {
      input: 'synthetic cancel input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
    }, undefined, controller.signal);
    await startedPromise;
    controller.abort(new Error('synthetic caller cancellation'));
    release({ output: 'late synthetic summary', modelCalls: 1 });
    const task = await pending;
    assert.equal(task.status, 'blocked');
    assert.equal(task.output, '');
    assert.match(task.error ?? '', /迟到结果未交付/);
    assert.equal(store.task(task.id)?.task?.output, '');
  } finally { store.close(); }
});

test('digest output budget accepts exactly 64,000 UTF-8 bytes and rejects one byte over', async () => {
  const store = new Store();
  enableDigest(store, 'group-a', 'admin-a');
  const exactOutput = `${'x'.repeat(63_997)}中`;
  const overOutput = `${'x'.repeat(63_998)}中`;
  assert.equal(Buffer.byteLength(exactOutput, 'utf8'), 64_000);
  assert.equal(Buffer.byteLength(overOutput, 'utf8'), 64_001);
  let output = exactOutput;
  const actions = makeActions(store, async () => ({ output, modelCalls: 1 }));
  try {
    const exact = await actions.runTask('admin-a', 'group-a', {
      input: 'synthetic output boundary input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
    });
    assert.equal(exact.status, 'succeeded');
    assert.equal(Buffer.byteLength(exact.output, 'utf8'), 64_000);

    output = overOutput;
    const over = await actions.runTask('admin-a', 'group-a', {
      input: 'synthetic output over-boundary input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
    });
    assert.equal(over.status, 'failed');
    assert.equal(over.output, '');
    assert.match(over.error ?? '', /执行入口返回的证据不符合约定/);
    assert.equal(store.task(over.id)?.task?.output, '');
  } finally { store.close(); }
});

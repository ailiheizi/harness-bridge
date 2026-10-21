import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { installKoishiBridge } from './src/index.mjs';
import {
  EXPECTED_OUTPUT,
  admissionDenialUnchanged,
  bindingModuleValid,
  cleanupEvidenceSummary,
  deliveryEvidenceValid,
  expectedSessionTuple,
  privateConfigStatValid,
  preparedRootsValid,
  observedSandboxId,
  sanitizedObservedFailure,
  trustedTaskMatches,
  privateConfigValid,
  validSummaryEvidence,
} from './native-live.mjs';

const metrics = Object.freeze({ synthetic: true, acceptedRequestCount: 1, rejectedOverBudgetCount: 0, lastStatus: 200 });
const nativeResult = Object.freeze({
  taskId: 'task-synthetic-1',
  status: 'completed',
  output: EXPECTED_OUTPUT,
  sandbox: Object.freeze({ id: 'sandbox-verified-1', name: 'aw-synthetic', workspace: 'default' }),
  cleanup: Object.freeze({ status: 'verified' }),
  evidence: Object.freeze({ execution: 'verified', cleanup: 'verified', nativeExitCode: 0, modelRequestCount: null, dshSessionId: 'dsh-session-synthetic-1' }),
});
const deliveryResult = Object.freeze({
  taskId: nativeResult.taskId,
  status: 'completed',
  output: nativeResult.output,
  sandbox: nativeResult.sandbox,
  cleanup: nativeResult.cleanup,
  evidence: nativeResult.evidence,
});

test('private config accepts only absolute-path regular files with exact 0600 mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'koishi-native-live-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.mjs');
  await writeFile(file, 'export default { synthetic: true };', { mode: 0o600 });
  await chmod(file, 0o600);
  const fileStat = await lstat(file);
  assert.equal(privateConfigStatValid(fileStat), true);
  assert.equal(privateConfigValid(file, fileStat), true);
  assert.equal(privateConfigValid(path.relative(process.cwd(), file), fileStat), false);

  const loose = path.join(root, 'loose.mjs');
  await writeFile(loose, 'export default {};', { mode: 0o644 });
  await chmod(loose, 0o644);
  assert.equal(privateConfigStatValid(await lstat(loose)), false);
  const link = path.join(root, 'config-link.mjs');
  await symlink(file, link);
  assert.equal(privateConfigStatValid(await lstat(link)), false);
});

test('prepared OpenShell home and XDG roots must be owned, private, real directories within the configured roots', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'koishi-native-roots-check-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const home = path.join(root, 'openshell-home');
  const xdg = path.join(home, 'xdg');
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(xdg, 0o700);
  const binding = { native: { home, xdgConfigHome: xdg } };
  assert.equal(await preparedRootsValid(binding), true);

  await chmod(xdg, 0o750);
  assert.equal(await preparedRootsValid(binding), false);
  await chmod(xdg, 0o700);
  const linkedHome = path.join(root, 'linked-home');
  await symlink(home, linkedHome);
  assert.equal(await preparedRootsValid({ native: { home: linkedHome, xdgConfigHome: path.join(linkedHome, 'xdg') } }), false);
  assert.equal(await preparedRootsValid({ native: { home: os.homedir(), xdgConfigHome: path.join(os.homedir(), 'xdg') } }), false);
  assert.equal(await preparedRootsValid({ native: { home, xdgConfigHome: path.join(root, 'outside-xdg') } }), false);
});

test('binding module requires actual absolute native and DSH paths plus all three bridge authorization hooks', () => {
  const binding = {
    native: { cliPath: '/opt/fixture/openshell', workspace: 'default', policyPath: '/private/policy.yml', home: '/private/home', xdgConfigHome: '/private/home/xdg' },
    dsh: { patchPath: '/private/dsh-patch.yml' },
    authorizeAdmission() {}, authorizeNativeCall() {}, authorizeResult() {},
  };
  assert.equal(bindingModuleValid(binding), true);
  assert.equal(bindingModuleValid({ ...binding, authorizeResult: null }), false);
  assert.equal(bindingModuleValid({ ...binding, native: { ...binding.native, cliPath: 'openshell' } }), false);
});

test('Koishi-derived session tuple maps only to its exact tenant and actor tuple', () => {
  const tuple = expectedSessionTuple({ platform: 'mock', selfId: 'bot', guildId: 'group', channelId: 'group', userId: 'user' });
  assert.deepEqual(tuple.parts, ['mock', 'bot', 'group', 'group', 'user']);
  const task = { taskId: 'task-synthetic-1', tupleKey: tuple.key, tenantId: tuple.tenantId, actorId: tuple.actorId, allowed: true };
  assert.equal(trustedTaskMatches(task, { taskId: task.taskId, tenantId: tuple.tenantId, actorId: tuple.actorId }), true);
  assert.equal(trustedTaskMatches(task, { taskId: task.taskId, tenantId: 'prompt-claimed-tenant', actorId: tuple.actorId }), false);
  assert.equal(expectedSessionTuple({ platform: 'mock', selfId: 'bot', guildId: 'group', channelId: '', userId: 'user' }), null);
});

test('summary success requires observed bridge result, native cleanup, DSH evidence and exactly one fixture request', () => {
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: nativeResult, observedResult: nativeResult, fixtureMetrics: metrics }), true);
  assert.equal(validSummaryEvidence({ taskId: 'wrong-task', result: nativeResult, observedResult: nativeResult, fixtureMetrics: metrics }), false);
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: nativeResult, observedResult: { ...nativeResult }, fixtureMetrics: metrics }), false);
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: { ...nativeResult, evidence: { ...nativeResult.evidence, modelRequestCount: 1 } }, observedResult: nativeResult, fixtureMetrics: metrics }), false);
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: nativeResult, observedResult: nativeResult, fixtureMetrics: { ...metrics, acceptedRequestCount: 2 } }), false);
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: nativeResult, observedResult: nativeResult, fixtureMetrics: { ...metrics, rejectedOverBudgetCount: 1, lastStatus: 429 } }), false);
  assert.equal(validSummaryEvidence({ taskId: nativeResult.taskId, result: { ...nativeResult, cleanup: { status: 'unverified' } }, observedResult: nativeResult, fixtureMetrics: metrics }), false);
});

test('delivery gate binds task, real sandbox, DSH session, original tuple, and fixture receipt', () => {
  const args = {
    taskId: nativeResult.taskId,
    delivery: deliveryResult,
    observedResult: nativeResult,
    fixtureMetrics: metrics,
    expectedTupleKey: '["mock","bot","group","group","user"]',
    deliveryIdentityKey: '["mock","bot","group","group","user"]',
  };
  assert.equal(deliveryEvidenceValid(args), true);
  assert.equal(deliveryEvidenceValid({ ...args, taskId: 'other-task' }), false);
  assert.equal(deliveryEvidenceValid({ ...args, delivery: { ...deliveryResult, sandbox: { ...deliveryResult.sandbox, id: 'other-sandbox' } } }), false);
  assert.equal(deliveryEvidenceValid({ ...args, delivery: { ...deliveryResult, evidence: { ...deliveryResult.evidence, dshSessionId: 'other-session' } } }), false);
  assert.equal(deliveryEvidenceValid({ ...args, deliveryIdentityKey: 'different-session' }), false);
  assert.equal(deliveryEvidenceValid({ ...args, fixtureMetrics: { ...metrics, acceptedRequestCount: 0 } }), false);
  assert.equal(deliveryEvidenceValid({ ...args, delivery: { ...deliveryResult, evidence: { ...deliveryResult.evidence, modelRequestCount: 1 } } }), false);
});

test('same-context admission denial must preserve the native-call count', () => {
  assert.equal(admissionDenialUnchanged({ deniedReply: 'Request denied.', nativeCallsBefore: 9, nativeCallsAfter: 9 }), true);
  assert.equal(admissionDenialUnchanged({ deniedReply: 'Request denied.', nativeCallsBefore: 9, nativeCallsAfter: 10 }), false);
  assert.equal(admissionDenialUnchanged({ deniedReply: 'Harness request failed.', nativeCallsBefore: 9, nativeCallsAfter: 9 }), false);
});

test('native failure diagnostics keep only safe identifiers and a verified sandbox ID', () => {
  assert.deepEqual(sanitizedObservedFailure({ failure: { stage: 'create', code: 'native_create_failed' } }), {
    stage: 'create', code: 'native_create_failed',
  });
  const secret = 'provider key prompt config path';
  assert.equal(sanitizedObservedFailure({ failure: { stage: `create ${secret}`, code: `bad_${secret}` } }), null);
  assert.equal(observedSandboxId({ sandbox: { id: 'sandbox-safe-id' } }), 'sandbox-safe-id');
  assert.equal(observedSandboxId({ sandbox: { id: `sandbox\n${secret}` } }), null);
});

test('controller drain and fixture close cannot substitute for native cleanup evidence', () => {
  assert.deepEqual(cleanupEvidenceSummary({
    observedResult: nativeResult,
    controllerDrained: true,
    fixtureClosed: true,
  }), {
    controllerDrained: true,
    fixtureClosed: true,
    nativeCleanup: 'verified',
    cleanupVerified: true,
  });
  const failedNativeResult = {
    ...nativeResult,
    cleanup: { status: 'unverified' },
    evidence: { ...nativeResult.evidence, cleanup: 'unverified' },
  };
  assert.deepEqual(cleanupEvidenceSummary({
    observedResult: failedNativeResult,
    controllerDrained: true,
    fixtureClosed: true,
  }), {
    controllerDrained: true,
    fixtureClosed: true,
    nativeCleanup: 'unverified',
    cleanupVerified: false,
  });
  assert.deepEqual(cleanupEvidenceSummary({
    observedResult: null,
    controllerDrained: true,
    fixtureClosed: true,
  }), {
    controllerDrained: true,
    fixtureClosed: true,
    nativeCleanup: 'not-created',
    cleanupVerified: false,
  });
  assert.equal(cleanupEvidenceSummary({ observedResult: nativeResult, controllerDrained: false, fixtureClosed: true }).cleanupVerified, false);
  assert.equal(cleanupEvidenceSummary({ observedResult: nativeResult, controllerDrained: true, fixtureClosed: false }).cleanupVerified, false);
});

test('pinned Koishi App and MockBot derive the same real-session identity for success and denial', async () => {
  const app = new App({});
  const bot = new MockBot(app, { selfId: 'offline-check-bot' });
  const sessions = [];
  app.before('command/execute', (argv) => { sessions.push(argv.session); });
  let controller;
  let calls = 0;
  let expectedTuple;
  const authorizations = [];
  const bridge = {
    async execute(request) {
      calls++;
      return {
        taskId: request.taskId,
        status: 'completed',
        output: 'offline synthetic result',
        sandbox: { id: 'offline-sandbox', name: 'offline-name', workspace: 'offline-workspace' },
        cleanup: { status: 'verified' },
        evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null, nativeExitCode: 0, dshSessionId: 'offline-dsh-session' },
      };
    },
  };
  app.plugin((pluginContext) => {
    controller = installKoishiBridge(pluginContext, {
      bridge,
      authorize(action, request) {
        if (action === 'admission') {
          const tuple = expectedSessionTuple(sessions.at(-1));
          expectedTuple ??= tuple;
          authorizations.push({ action, tuple, request });
          return tuple?.key === expectedTuple?.key && request.identity.key === tuple.key && authorizations.length === 1;
        }
        if (action === 'delivery') {
          const tuple = expectedSessionTuple(sessions.at(-1));
          authorizations.push({ action, tuple, request });
          return tuple?.key === expectedTuple?.key && request.identity.key === tuple.key;
        }
        return false;
      },
    });
  });
  await app.start();
  try {
    const client = bot.client('offline-check-user', 'offline-check-group');
    const success = await client.receive('isolated-summary synthetic offline success');
    assert.equal(success.at(-1), 'offline synthetic result');
    assert.equal(calls, 1);
    assert.deepEqual(expectedTuple.parts, ['mock', 'offline-check-bot', 'offline-check-group', 'offline-check-group', 'offline-check-user']);
    const beforeDenied = calls;
    const denied = await client.receive('isolated-summary synthetic offline denial');
    assert.equal(denied.at(-1), 'Request denied.');
    assert.equal(calls, beforeDenied);
    assert.equal(expectedSessionTuple(sessions.at(-1)).key, expectedTuple.key);
    assert.equal(authorizations.filter((entry) => entry.action === 'admission').length, 2);
  } finally {
    await controller.close();
  }
});

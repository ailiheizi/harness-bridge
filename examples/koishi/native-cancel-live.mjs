#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { createHarnessBridge } from '@actweave/harness-bridge';
import { installKoishiBridge } from './src/index.mjs';
import {
  cleanupEvidenceSummary,
  bindingModuleValid,
  expectedSessionTuple,
  observedSandboxId,
  preparedRootsValid,
  privateConfigValid,
  sanitizedObservedFailure,
  trustedTaskMatches,
} from './native-live.mjs';

export const CANCEL_RESPONSE_DELAY_MS = 30_000;
export const OUTER_DEADLINE_MS = 420_000;
const CANCEL_REPLY = 'Cancellation requested.';
const OTHER_GROUP_REPLY = 'No cancellable task found.';
const ORIGIN_CANCEL_REPLY = 'Request cancelled.';

export function cancelEvidenceValid({ taskId, result, observedResult, metrics, originReply, crossGroupReply, signalAborted, noSummary }) {
  const failureCode = result?.failure?.code;
  return Boolean(taskId && result && result === observedResult && result.taskId === taskId
    && ['failed', 'blocked'].includes(result.status)
    && ['aborted', 'delivery_denied'].includes(failureCode)
    && result.cleanup?.status === 'verified' && result.evidence?.cleanup === 'verified'
    && result.evidence?.modelRequestCount === null
    && ['id', 'name', 'workspace'].every((key) => typeof result.sandbox?.[key] === 'string' && result.sandbox[key].trim().length > 0)
    && metrics?.synthetic === true && metrics.acceptedRequestCount === 1
    && metrics.rejectedOverBudgetCount === 0 && metrics.lastStatus === 200
    && metrics.completedResponseCount === 0 && metrics.abortedResponseCount === 1
    && metrics.pendingResponseCount === 0
    && originReply === ORIGIN_CANCEL_REPLY && crossGroupReply === OTHER_GROUP_REPLY
    && signalAborted === true && noSummary === true);
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(Object.assign(new Error(), { stage: 'wait', code: 'cancel_evidence_timeout' }));
      setTimeout(check, 10);
    };
    check();
  });
}

async function loadFixture(configPath) {
  if (!path.isAbsolute(configPath)) throw Object.assign(new Error(), { stage: 'config', code: 'trusted_config_unavailable' });
  const { lstat } = await import('node:fs/promises');
  let info;
  try { info = await lstat(configPath); } catch { throw Object.assign(new Error(), { stage: 'config', code: 'trusted_config_unavailable' }); }
  if (!privateConfigValid(configPath, info)) throw Object.assign(new Error(), { stage: 'config', code: 'trusted_config_unavailable' });
  let config;
  try { config = (await import(`${pathToFileURL(configPath).href}?native-cancel=${Date.now()}`)).default; }
  catch { throw Object.assign(new Error(), { stage: 'config', code: 'trusted_config_unavailable' }); }
  if (config?.synthetic !== true || typeof config.prepareSummaryContext !== 'function') throw Object.assign(new Error(), { stage: 'config', code: 'trusted_config_unavailable' });
  let context;
  try { context = await config.prepareSummaryContext({ responseDelayMs: CANCEL_RESPONSE_DELAY_MS }); }
  catch { throw Object.assign(new Error(), { stage: 'config', code: 'fixture_prepare_failed' }); }
  if (!bindingModuleValid(context?.bindingModule) || typeof context.fixtureMetrics !== 'function' || typeof context.close !== 'function') {
    try { await context?.close?.(); } catch {}
    throw Object.assign(new Error(), { stage: 'config', code: 'fixture_contract_invalid' });
  }
  return context;
}

export async function runNativeCancelAcceptance(configPath) {
  const tasks = new Map();
  const observedResults = new Map();
  const state = { fixture: null, controller: null, controllerDrained: false, fixtureClosed: false };
  const counts = { admissionChecks: 0, nativeCallChecks: 0, resultChecks: 0, cancelChecks: 0 };
  let app;
  let expectedTuple;
  let revoked = false;
  let originalSignal;
  let taskId;
  let crossGroupReply = null;
  let originReply = null;
  let failure = null;
  let passed = false;
  let deadlineTimer;
  let outerDeadlineTimer;
  let deadlineExpired = false;
  let outerDeadlineExpired = false;
  const controllerDeadlineAt = Date.now() + 180_000;

  try {
    deadlineTimer = setTimeout(() => {
      deadlineExpired = true;
      void state.controller?.close().catch(() => {});
    }, 180_000);
    outerDeadlineTimer = setTimeout(() => {
      outerDeadlineExpired = true;
      void state.controller?.close().catch(() => {});
    }, OUTER_DEADLINE_MS);
    state.fixture = await loadFixture(configPath);
    if (deadlineExpired) throw Object.assign(new Error(), { stage: 'deadline', code: 'controller_deadline_exceeded' });
    const binding = state.fixture.bindingModule;
    if (!await preparedRootsValid(binding)) throw Object.assign(new Error(), { stage: 'config', code: 'prepared_private_roots_invalid' });
    if (deadlineExpired) throw Object.assign(new Error(), { stage: 'deadline', code: 'controller_deadline_exceeded' });
    const nativeBudgetMs = Math.min(binding.limits?.totalTimeoutMs ?? 120_000, 120_000, controllerDeadlineAt - Date.now() - 60_000);
    if (!Number.isSafeInteger(nativeBudgetMs) || nativeBudgetMs < 1_000) throw Object.assign(new Error(), { stage: 'deadline', code: 'controller_deadline_exceeded' });
    binding.limits = { ...binding.limits, totalTimeoutMs: nativeBudgetMs };
    const originalAdmission = binding.authorizeAdmission;
    const originalNativeCall = binding.authorizeNativeCall;
    const originalResult = binding.authorizeResult;
    const tupleFor = (id, tenantId, actorId) => {
      const task = tasks.get(id);
      if (!trustedTaskMatches(task, { taskId: id, tenantId, actorId }) || task.tupleKey !== expectedTuple?.key) {
        throw Object.assign(new Error(), { stage: 'authorization', code: 'trusted_task_tuple_mismatch' });
      }
      return task;
    };
    binding.authorizeAdmission = async (context) => {
      counts.admissionChecks++;
      const request = context?.request;
      tupleFor(request?.taskId, request?.tenantId, request?.actorId);
      await originalAdmission(context);
    };
    binding.authorizeNativeCall = async (context) => {
      counts.nativeCallChecks++;
      tupleFor(context?.taskId, context?.tenantId, context?.actorId);
      if (revoked) throw Object.assign(new Error(), { stage: 'authorization', code: 'business_authority_revoked' });
      await originalNativeCall(context);
    };
    binding.authorizeResult = async (context) => {
      counts.resultChecks++;
      const request = context?.request;
      tupleFor(request?.taskId, request?.tenantId, request?.actorId);
      await originalResult(context);
    };

    const realBridge = createHarnessBridge(binding);
    const observerBridge = Object.freeze({
      async execute(request, signal) {
        originalSignal = signal;
        taskId = request.taskId;
        const result = await realBridge.execute(request, signal);
        observedResults.set(request.taskId, result);
        return result;
      },
    });
    app = new App({});
    const bot = new MockBot(app, { selfId: 'native-cancel-bot' });
    const sessions = [];
    app.before('command/execute', ({ session }) => { sessions.push(session); });
    app.plugin((ctx) => {
      state.controller = installKoishiBridge(ctx, {
        bridge: observerBridge,
        shutdownTimeoutMs: 90_000,
        authorize(action, request) {
          if (action === 'admission') {
            const tuple = expectedSessionTuple(sessions.at(-1));
            if (!tuple || expectedTuple && tuple.key !== expectedTuple.key || request?.identity?.key !== tuple.key
              || !/^[0-9a-f-]{36}$/i.test(request?.taskId ?? '')) return false;
            expectedTuple ??= tuple;
            const allowed = tasks.size === 0;
            tasks.set(request.taskId, Object.freeze({
              taskId: request.taskId, tupleKey: tuple.key, tenantId: tuple.tenantId, actorId: tuple.actorId, allowed,
            }));
            return allowed;
          }
          if (action === 'cancel') {
            counts.cancelChecks++;
            const tuple = expectedSessionTuple(sessions.at(-1));
            const task = tasks.get(request?.taskId);
            if (!tuple || tuple.key !== expectedTuple?.key || !trustedTaskMatches(task, {
              taskId: request?.taskId, tenantId: tuple.tenantId, actorId: tuple.actorId,
            }) || task.tupleKey !== tuple.key) return false;
            revoked = true;
            return true;
          }
          return false;
        },
      });
    });
    await app.start();

    const originClient = bot.client('native-cancel-user', 'native-cancel-group');
    const otherClient = bot.client('native-cancel-user', 'native-cancel-other-group');
    const originPromise = originClient.receive('isolated-summary synthetic native cancellation input');
    await waitFor(() => {
      const metrics = state.fixture.fixtureMetrics();
      return taskId && originalSignal && !originalSignal.aborted && state.controller.activeCount === 1
        && metrics.acceptedRequestCount === 1 && metrics.completedResponseCount === 0 && metrics.pendingResponseCount === 1;
    }, 60_000);
    const crossReplies = await otherClient.receive('isolated-cancel');
    crossGroupReply = crossReplies.at(-1);
    if (crossGroupReply !== OTHER_GROUP_REPLY || originalSignal.aborted || state.controller.activeCount !== 1) {
      throw Object.assign(new Error(), { stage: 'scope', code: 'cross_group_cancel_not_denied' });
    }
    const stillPending = state.fixture.fixtureMetrics();
    if (stillPending.acceptedRequestCount !== 1 || stillPending.completedResponseCount !== 0
      || stillPending.abortedResponseCount !== 0 || stillPending.pendingResponseCount !== 1
      || state.controller.activeCount !== 1 || observedResults.has(taskId)) {
      throw Object.assign(new Error(), { stage: 'scope', code: 'cancel_not_observed_while_active' });
    }
    const cancelReplies = await bot.client('native-cancel-user', 'native-cancel-group').receive('isolated-cancel');
    if (cancelReplies.at(-1) !== CANCEL_REPLY || !originalSignal.aborted || !revoked) {
      throw Object.assign(new Error(), { stage: 'cancel', code: 'same_group_cancel_not_observed' });
    }
    const originReplies = await originPromise;
    originReply = originReplies.at(-1);
    await waitFor(() => state.fixture.fixtureMetrics().abortedResponseCount === 1, 30_000);
    const result = observedResults.get(taskId);
    const metrics = state.fixture.fixtureMetrics();
    const noSummary = !originReplies.includes('Synthetic one-turn summary fixture completed.');
    if (!cancelEvidenceValid({
      taskId, result, observedResult: observedResults.get(taskId), metrics, originReply, crossGroupReply,
      signalAborted: originalSignal.aborted, noSummary,
    })) throw Object.assign(new Error(), { stage: 'evidence', code: 'native_cancel_evidence_invalid' });
    passed = true;
  } catch (error) {
    const stage = ['config', 'scope', 'cancel', 'evidence', 'cleanup', 'deadline', 'wait'].includes(error?.stage) ? error.stage : 'acceptance';
    const safeCodes = new Set(['trusted_config_unavailable', 'fixture_prepare_failed', 'fixture_contract_invalid', 'prepared_private_roots_invalid', 'cross_group_cancel_not_denied', 'cancel_not_observed_while_active', 'same_group_cancel_not_observed', 'native_cancel_evidence_invalid', 'controller_drain_unverified', 'fixture_close_failed', 'cancel_evidence_timeout', 'controller_deadline_exceeded', 'native_cancel_acceptance_failed']);
    failure = { stage, code: safeCodes.has(error?.code) ? error.code : 'native_cancel_acceptance_failed' };
    if (stage === 'deadline' || stage === 'config') outerDeadlineExpired ||= stage === 'deadline' && error?.code === 'outer_deadline_exceeded';
  } finally {
    if (state.controller) {
      try {
        const closeResult = await state.controller.close();
        state.controllerDrained = closeResult?.status === 'drained' && closeResult.pendingCount === 0;
        if (!state.controllerDrained) { failure ??= { stage: 'cleanup', code: 'controller_drain_unverified' }; passed = false; }
      } catch { failure ??= { stage: 'cleanup', code: 'controller_drain_unverified' }; passed = false; }
    }
    if (state.fixture && (!state.controller || state.controllerDrained)) {
      try { await state.fixture.close(); state.fixtureClosed = true; }
      catch { failure ??= { stage: 'cleanup', code: 'fixture_close_failed' }; passed = false; }
    }
    clearTimeout(deadlineTimer);
    clearTimeout(outerDeadlineTimer);
  }
  const observed = observedResults.get(taskId);
  const cleanup = cleanupEvidenceSummary({ observedResult: observed, controllerDrained: state.controllerDrained, fixtureClosed: state.fixtureClosed });
  const cleanupUnknown = ['unverified', 'unknown'].includes(cleanup.nativeCleanup) || !cleanup.controllerDrained || !cleanup.fixtureClosed;
  const blocked = cleanupUnknown || deadlineExpired || outerDeadlineExpired || !state.fixture;
  const result = {
    outcome: passed && !failure && cleanup.cleanupVerified ? 'PASS' : (blocked ? 'BLOCKED' : 'FAIL'),
    koishiDispatch: 'real-app-mockbot', synthetic: true,
    acceptedRequestCount: Number.isSafeInteger(state.fixture?.fixtureMetrics?.().acceptedRequestCount) ? state.fixture.fixtureMetrics().acceptedRequestCount : null,
    completedResponseCount: Number.isSafeInteger(state.fixture?.fixtureMetrics?.().completedResponseCount) ? state.fixture.fixtureMetrics().completedResponseCount : null,
    abortedResponseCount: Number.isSafeInteger(state.fixture?.fixtureMetrics?.().abortedResponseCount) ? state.fixture.fixtureMetrics().abortedResponseCount : null,
    pendingResponseCount: Number.isSafeInteger(state.fixture?.fixtureMetrics?.().pendingResponseCount) ? state.fixture.fixtureMetrics().pendingResponseCount : null,
    bridgeAdmissionChecks: counts.admissionChecks, bridgeNativeCallChecks: counts.nativeCallChecks, bridgeResultChecks: counts.resultChecks,
    cancelAuthorizationChecks: counts.cancelChecks,
    cancelObserved: originalSignal?.aborted === true, crossGroupDenied: crossGroupReply === OTHER_GROUP_REPLY,
    originCancelled: originReply === ORIGIN_CANCEL_REPLY, nativeFailure: sanitizedObservedFailure(observed),
    taskId: taskId ?? null,
    sandboxId: observedSandboxId(observed),
    sandboxName: observed?.sandbox?.name ?? null,
    workspace: observed?.sandbox?.workspace ?? null,
    bridgeModelRequestCount: observed?.evidence?.modelRequestCount ?? null,
    ...cleanup, controllerDeadlineMs: 180_000, outerRunnerDeadlineMs: OUTER_DEADLINE_MS,
    outerRunnerRequired: true, fixturePrepareAbortable: false,
    failure,
  };
  return result;
}

function configArg(argv) {
  const index = argv.indexOf('--config');
  if (index < 0 || !argv[index + 1]) return null;
  return argv[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const configPath = configArg(process.argv.slice(2));
  const result = configPath
    ? await runNativeCancelAcceptance(configPath)
    : { outcome: 'BLOCKED', koishiDispatch: 'real-app-mockbot', synthetic: true, failure: { stage: 'config', code: 'trusted_config_unavailable' } };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.outcome === 'PASS' ? 0 : result.outcome === 'BLOCKED' ? 78 : 1;
}

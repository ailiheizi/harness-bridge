#!/usr/bin/env node
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { createHarnessBridge } from '@actweave/harness-bridge';
import { installKoishiBridge } from './src/index.mjs';

export const EXPECTED_OUTPUT = 'Synthetic one-turn summary fixture completed.';
export const TOTAL_DEADLINE_MS = 5 * 60 * 1000;
const CONFIG_UNAVAILABLE = Object.freeze({ stage: 'config', code: 'trusted_config_unavailable' });

export function privateConfigStatValid(info) {
  return Boolean(info?.isFile?.() === true && info?.isSymbolicLink?.() !== true && (info.mode & 0o777) === 0o600);
}

export function privateConfigValid(configPath, info) {
  return path.isAbsolute(configPath) && privateConfigStatValid(info);
}

export function bindingModuleValid(binding) {
  return Boolean(binding && typeof binding === 'object'
    && path.isAbsolute(binding.native?.cliPath ?? '')
    && typeof binding.native?.workspace === 'string' && binding.native.workspace.length > 0
    && path.isAbsolute(binding.native?.policyPath ?? '')
    && path.isAbsolute(binding.native?.home ?? '')
    && path.isAbsolute(binding.native?.xdgConfigHome ?? '')
    && path.isAbsolute(binding.dsh?.patchPath ?? '')
    && typeof binding.authorizeAdmission === 'function'
    && typeof binding.authorizeNativeCall === 'function'
    && typeof binding.authorizeResult === 'function');
}

export async function privateRootValid(rootPath, { containedBy } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)
    || path.resolve(rootPath) === path.parse(rootPath).root
    || path.resolve(rootPath) === path.resolve(os.homedir())) return false;
  let info;
  let resolved;
  try {
    info = await lstat(rootPath);
    resolved = await realpath(rootPath);
  } catch { return false; }
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
    || typeof process.getuid !== 'function' || info.uid !== process.getuid()
    || resolved !== path.resolve(rootPath)) return false;
  if (containedBy) {
    let parent;
    try { parent = await realpath(containedBy); } catch { return false; }
    const relative = path.relative(parent, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  }
  return true;
}

export async function preparedRootsValid(binding) {
  const home = binding?.native?.home;
  const xdg = binding?.native?.xdgConfigHome;
  if (!await privateRootValid(home, { containedBy: path.dirname(path.resolve(home ?? '')) })) return false;
  if (typeof xdg !== 'string' || path.dirname(path.resolve(xdg)) !== path.resolve(home)) return false;
  return privateRootValid(xdg, { containedBy: home });
}

export function expectedSessionTuple(session) {
  const parts = [session?.platform, session?.selfId, session?.guildId, session?.channelId, session?.userId];
  if (parts.some((part) => typeof part !== 'string' || part.length === 0)) return null;
  return Object.freeze({
    parts: Object.freeze(parts),
    key: JSON.stringify(parts),
    tenantId: JSON.stringify(parts.slice(0, 4)),
    actorId: JSON.stringify([parts[0], parts[1], parts[4]]),
  });
}

export function trustedTaskMatches(task, { taskId, tenantId, actorId }) {
  return Boolean(task && task.taskId === taskId && task.allowed === true
    && task.tupleKey && task.tenantId === tenantId && task.actorId === actorId);
}

export function validSummaryEvidence({ taskId, result, observedResult, fixtureMetrics, expectedOutput = EXPECTED_OUTPUT }) {
  const sandboxId = result?.sandbox?.id;
  const dshSessionId = result?.evidence?.dshSessionId;
  return Boolean(result && result.status === 'completed' && result.taskId === taskId
    && result.output === expectedOutput
    && result.evidence?.execution === 'verified' && result.evidence?.cleanup === 'verified'
    && result.evidence?.nativeExitCode === 0 && result.evidence?.modelRequestCount === null
    && result.cleanup?.status === 'verified'
    && typeof sandboxId === 'string' && sandboxId.length > 0
    && typeof result.sandbox?.name === 'string' && result.sandbox.name.length > 0
    && typeof result.sandbox?.workspace === 'string' && result.sandbox.workspace.length > 0
    && typeof dshSessionId === 'string' && dshSessionId.trim().length > 0
    && observedResult === result
    && fixtureMetrics?.synthetic === true && fixtureMetrics?.acceptedRequestCount === 1
    && fixtureMetrics?.rejectedOverBudgetCount === 0 && fixtureMetrics?.lastStatus === 200);
}

export function deliveryEvidenceValid({ taskId, delivery, observedResult, fixtureMetrics, expectedTupleKey, deliveryIdentityKey, expectedOutput = EXPECTED_OUTPUT }) {
  const result = observedResult;
  return Boolean(delivery && delivery.taskId === taskId && delivery.status === 'completed'
    && delivery.cleanup?.status === 'verified'
    && delivery.evidence?.execution === 'verified' && delivery.evidence?.cleanup === 'verified'
    && delivery.evidence?.nativeExitCode === 0 && delivery.evidence?.modelRequestCount === null
    && delivery.evidence?.dshSessionId === result?.evidence?.dshSessionId
    && delivery.sandbox?.id === result?.sandbox?.id
    && delivery.sandbox?.name === result?.sandbox?.name
    && delivery.sandbox?.workspace === result?.sandbox?.workspace
    && delivery.output === result?.output && delivery.output === expectedOutput
    && result?.taskId === taskId && result?.evidence?.dshSessionId
    && expectedTupleKey && deliveryIdentityKey === expectedTupleKey && fixtureMetrics?.synthetic === true
    && fixtureMetrics?.acceptedRequestCount === 1
    && fixtureMetrics?.rejectedOverBudgetCount === 0 && fixtureMetrics?.lastStatus === 200);
}

export function admissionDenialUnchanged({ deniedReply, nativeCallsBefore, nativeCallsAfter }) {
  return deniedReply === 'Request denied.' && Number.isSafeInteger(nativeCallsBefore)
    && Number.isSafeInteger(nativeCallsAfter) && nativeCallsBefore === nativeCallsAfter;
}

export function sanitizedObservedFailure(result) {
  const stage = typeof result?.failure?.stage === 'string' && /^[a-z0-9_]+$/u.test(result.failure.stage)
    ? result.failure.stage : null;
  const code = typeof result?.failure?.code === 'string' && /^[a-z0-9_]+$/u.test(result.failure.code)
    ? result.failure.code : null;
  return stage && code ? { stage, code } : null;
}

export function observedSandboxId(result) {
  return typeof result?.sandbox?.id === 'string' && result.sandbox.id.length > 0
    && result.sandbox.id.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(result.sandbox.id)
    ? result.sandbox.id : null;
}

export function cleanupEvidenceSummary({ observedResult, controllerDrained, fixtureClosed }) {
  const reportedStatus = observedResult?.cleanup?.status;
  const nativeCleanup = reportedStatus === undefined ? 'not-created'
    : ['verified', 'unverified', 'not-created'].includes(reportedStatus) ? reportedStatus : 'unknown';
  const cleanupVerified = nativeCleanup === 'verified'
    && observedResult?.evidence?.cleanup === 'verified'
    && controllerDrained === true && fixtureClosed === true;
  return Object.freeze({
    controllerDrained: controllerDrained === true,
    fixtureClosed: fixtureClosed === true,
    nativeCleanup,
    cleanupVerified,
  });
}

async function loadTrustedConfig(configPath) {
  if (!path.isAbsolute(configPath)) throw Object.assign(new Error(), CONFIG_UNAVAILABLE);
  let info;
  try { info = await lstat(configPath); } catch { throw Object.assign(new Error(), CONFIG_UNAVAILABLE); }
  if (!privateConfigValid(configPath, info)) throw Object.assign(new Error(), CONFIG_UNAVAILABLE);
  let config;
  try { config = (await import(`${pathToFileURL(configPath).href}?native-live=${Date.now()}`)).default; }
  catch { throw Object.assign(new Error(), CONFIG_UNAVAILABLE); }
  if (config?.synthetic !== true || typeof config?.prepareSummaryContext !== 'function') throw Object.assign(new Error(), CONFIG_UNAVAILABLE);
  let fixtureContext;
  try { fixtureContext = await config.prepareSummaryContext(); }
  catch { throw Object.assign(new Error(), CONFIG_UNAVAILABLE); }
  if (!bindingModuleValid(fixtureContext?.bindingModule)
    || typeof fixtureContext?.fixtureMetrics !== 'function'
    || typeof fixtureContext?.close !== 'function') {
    try { await fixtureContext?.close?.(); } catch {}
    throw Object.assign(new Error(), CONFIG_UNAVAILABLE);
  }
  return fixtureContext;
}

function makeSafeCounters() {
  return {
    hostAdmissions: 0,
    hostDenials: 0,
    bridgeAdmissionChecks: 0,
    bridgeNativeCalls: 0,
    bridgeResultChecks: 0,
    deliveryChecks: 0,
    timeoutAborted: false,
  };
}

export async function runNativeAcceptance(configPath) {
  const counters = makeSafeCounters();
  const tasks = new Map();
  const observedResults = new Map();
  const fixtureState = { context: null, closeAttempted: false };
  let app;
  let controller;
  let mockBot;
  let expectedTuple;
  let failure = null;
  let passed = false;
  let timedOut = false;
  let timer;
  const deadlineAt = Date.now() + TOTAL_DEADLINE_MS;
  let successSandboxId = null;
  let sameContext = false;
  let deniedNativeCallsBefore = null;
  let deniedNativeCallsAfter = null;
  let successDelivered = false;
  let deniedAsExpected = false;
  let blocked = false;
  let controllerDrained = false;
  let fixtureClosed = false;
  let finalFixtureMetrics = null;

  try {
    timer = setTimeout(() => {
      timedOut = true;
      counters.timeoutAborted = true;
      void controller?.close().catch(() => {});
    }, TOTAL_DEADLINE_MS);
    fixtureState.context = await loadTrustedConfig(configPath);
    const fixtureContext = fixtureState.context;
    const binding = fixtureContext.bindingModule;
    if (!await preparedRootsValid(binding)) throw Object.assign(new Error(), { stage: 'config', code: 'prepared_private_roots_invalid' });
    if (timedOut) throw Object.assign(new Error(), { stage: 'deadline', code: 'native_live_deadline_exceeded' });
    const nativeBudgetMs = Math.min(binding.limits?.totalTimeoutMs ?? 120_000, deadlineAt - Date.now() - 60_000);
    if (!Number.isSafeInteger(nativeBudgetMs) || nativeBudgetMs < 1_000) {
      throw Object.assign(new Error(), { stage: 'deadline', code: 'native_live_deadline_exceeded' });
    }
    binding.limits = { ...binding.limits, totalTimeoutMs: nativeBudgetMs };
    const originalAdmission = binding.authorizeAdmission;
    const originalNativeCall = binding.authorizeNativeCall;
    const originalResult = binding.authorizeResult;

    binding.authorizeAdmission = async (context) => {
      counters.bridgeAdmissionChecks++;
      const task = tasks.get(context?.request?.taskId);
      if (!trustedTaskMatches(task, context?.request ?? {}) || task?.tupleKey !== expectedTuple?.key) throw new Error('native_live_authorization_denied');
      await originalAdmission(context);
    };
    binding.authorizeNativeCall = async (context) => {
      const task = tasks.get(context?.taskId);
      if (!trustedTaskMatches(task, context ?? {}) || task?.tupleKey !== expectedTuple?.key) throw new Error('native_live_authorization_denied');
      counters.bridgeNativeCalls++;
      await originalNativeCall(context);
    };
    binding.authorizeResult = async (context) => {
      counters.bridgeResultChecks++;
      const request = context?.request;
      const task = tasks.get(request?.taskId);
      if (!trustedTaskMatches(task, request ?? {}) || task?.tupleKey !== expectedTuple?.key
        || context?.result?.taskId !== request?.taskId) {
        throw new Error('native_live_authorization_denied');
      }
      await originalResult(context);
    };

    const realBridge = createHarnessBridge(binding);
    const observingBridge = Object.freeze({
      async execute(request, signal) {
        const result = await realBridge.execute(request, signal);
        observedResults.set(request.taskId, result);
        return result;
      },
    });

    app = new App({});
    mockBot = new MockBot(app, { selfId: 'native-live-bot' });
    const sessions = [];
    app.before('command/execute', (argv) => { sessions.push(argv.session); });
    const client = mockBot.client('native-live-user', 'native-live-group');
    app.plugin((pluginContext) => {
      controller = installKoishiBridge(pluginContext, {
        bridge: observingBridge,
        authorize: async (action, request) => {
          if (action === 'admission') {
            counters.hostAdmissions++;
            const tuple = expectedSessionTuple(sessions.at(-1));
            if (!tuple) return false;
            expectedTuple ??= tuple;
            if (tuple.key !== expectedTuple.key
              || request?.identity?.key !== tuple.key
              || !/^[0-9a-f-]{36}$/i.test(request?.taskId ?? '')) return false;
            const allowed = counters.hostAdmissions === 1;
            const trusted = Object.freeze({
              taskId: request.taskId,
              tupleKey: tuple.key,
              tenantId: JSON.stringify(tuple.parts.slice(0, 4)),
              actorId: JSON.stringify([tuple.parts[0], tuple.parts[1], tuple.parts[4]]),
              allowed,
            });
            tasks.set(request.taskId, trusted);
            if (!allowed) counters.hostDenials++;
            return allowed;
          }
          if (action === 'delivery') {
            counters.deliveryChecks++;
            const taskId = request?.taskId;
            const task = tasks.get(taskId);
            const observedResult = observedResults.get(taskId);
            const metrics = fixtureContext.fixtureMetrics();
            const valid = trustedTaskMatches(task, {
              taskId,
              tenantId: task?.tenantId,
              actorId: task?.actorId,
            }) && task?.tupleKey === expectedTuple?.key
              && request?.identity?.key === task?.tupleKey
              && deliveryEvidenceValid({
                taskId,
                delivery: request?.result,
                observedResult,
                fixtureMetrics: metrics,
                expectedTupleKey: expectedTuple?.key,
                deliveryIdentityKey: request?.identity?.key,
              });
            if (valid) {
              successSandboxId = observedResult.sandbox.id;
              successDelivered = true;
            }
            return valid;
          }
          return false;
        },
      });
    });

    await app.start();

    const successPromise = client.receive('isolated-summary synthetic native acceptance input');
    await waitFor(() => sessions.length > 0, 5_000);
    expectedTuple = expectedSessionTuple(sessions.at(-1));
    const successReplies = await successPromise;
    const successResult = [...observedResults.values()][0];
    const successTaskId = successResult?.taskId;
    const successTask = tasks.get(successTaskId);
    const successMetrics = fixtureContext.fixtureMetrics();
    finalFixtureMetrics = successMetrics;
    const successOkay = successDelivered
      && successReplies.at(-1) === EXPECTED_OUTPUT
      && trustedTaskMatches(successTask, { taskId: successTaskId, tenantId: successTask?.tenantId, actorId: successTask?.actorId })
      && successTask?.tupleKey === expectedTuple?.key
      && validSummaryEvidence({ taskId: successTaskId, result: successResult, observedResult: successResult, fixtureMetrics: successMetrics });
    if (!successOkay) throw Object.assign(new Error(), { stage: 'success', code: 'native_success_evidence_invalid' });

    deniedNativeCallsBefore = counters.bridgeNativeCalls;
    const deniedPromise = client.receive('isolated-summary synthetic native admission denial');
    await waitFor(() => sessions.length > 1, 5_000);
    const deniedTuple = expectedSessionTuple(sessions.at(-1));
    sameContext = Boolean(deniedTuple && expectedTuple && deniedTuple.key === expectedTuple.key);
    const deniedReplies = await deniedPromise;
    deniedNativeCallsAfter = counters.bridgeNativeCalls;
    deniedAsExpected = sameContext && admissionDenialUnchanged({
      deniedReply: deniedReplies.at(-1),
      nativeCallsBefore: deniedNativeCallsBefore,
      nativeCallsAfter: deniedNativeCallsAfter,
    });
    if (!deniedAsExpected || counters.hostAdmissions !== 2 || counters.hostDenials !== 1) {
      throw Object.assign(new Error(), { stage: 'denial', code: 'native_admission_denial_invalid' });
    }
    passed = true;
  } catch (error) {
    const stage = ['config', 'success', 'denial', 'cleanup', 'deadline'].includes(error?.stage) ? error.stage : 'acceptance';
    const code = ['native_success_evidence_invalid', 'native_admission_denial_invalid'].includes(error?.code)
      ? error.code
      : stage === 'config' ? CONFIG_UNAVAILABLE.code : stage === 'deadline' ? 'native_live_deadline_exceeded' : 'native_live_acceptance_failed';
    failure = { stage, code };
    blocked = stage === 'config' || error?.stage === 'deadline';
  } finally {
    if (controller) {
      try {
        const closeResult = await controller.close();
        controllerDrained = closeResult?.status === 'drained' && closeResult?.pendingCount === 0;
        if (!controllerDrained) {
          failure ??= { stage: 'cleanup', code: 'controller_drain_unverified' };
          passed = false;
          blocked = true;
        }
      } catch { failure ??= { stage: 'cleanup', code: 'controller_close_failed' }; passed = false; blocked = true; }
    } else {
      controllerDrained = false;
    }
    if (fixtureState.context) {
      try { finalFixtureMetrics = fixtureState.context.fixtureMetrics(); } catch {}
    }
    if (fixtureState.context && !fixtureState.closeAttempted && (!controller || controllerDrained)) {
      fixtureState.closeAttempted = true;
      try {
        await fixtureState.context.close();
        fixtureClosed = true;
      }
      catch { failure ??= { stage: 'cleanup', code: 'fixture_close_failed' }; passed = false; blocked = true; }
    }
    if (timer) clearTimeout(timer);
  }

  const observed = [...observedResults.values()].at(-1);
  const nativeFailure = sanitizedObservedFailure(observed);
  const cleanup = cleanupEvidenceSummary({ observedResult: observed, controllerDrained, fixtureClosed });
  if (['unverified', 'unknown'].includes(cleanup.nativeCleanup)) blocked = true;
  const result = {
    outcome: passed && !failure && !timedOut ? 'PASS' : (blocked || timedOut ? 'BLOCKED' : 'FAIL'),
    koishiDispatch: 'real-app-mockbot',
    synthetic: true,
    sameContext: sameContext === true,
    successDelivered: successDelivered === true,
    admissionDenied: deniedAsExpected === true,
    nativeCallCount: counters.bridgeNativeCalls,
    nativeCallsBeforeDenied: deniedNativeCallsBefore,
    nativeCallsAfterDenied: deniedNativeCallsAfter,
    bridgeAdmissionChecks: counters.bridgeAdmissionChecks,
    bridgeResultChecks: counters.bridgeResultChecks,
    deliveryChecks: counters.deliveryChecks,
    fixtureAcceptedRequestCount: Number.isSafeInteger(finalFixtureMetrics?.acceptedRequestCount) ? finalFixtureMetrics.acceptedRequestCount : null,
    fixtureRejectedOverBudgetCount: Number.isSafeInteger(finalFixtureMetrics?.rejectedOverBudgetCount) ? finalFixtureMetrics.rejectedOverBudgetCount : null,
    fixtureLastStatus: Number.isSafeInteger(finalFixtureMetrics?.lastStatus) ? finalFixtureMetrics.lastStatus : null,
    bridgeModelRequestCount: null,
    ...cleanup,
    controllerAbortDeadlineMs: TOTAL_DEADLINE_MS,
    deadlineScope: 'bridge-controller',
    timeoutAborted: counters.timeoutAborted,
    sandboxId: successSandboxId ?? observedSandboxId(observed),
    nativeFailure,
    failure,
  };
  return result;
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(Object.assign(new Error(), { code: 'native_live_acceptance_failed' }));
      setTimeout(check, 5);
    };
    check();
  });
}

function configArgument(argv) {
  const index = argv.indexOf('--config');
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) return null;
  return argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = configArgument(process.argv.slice(2));
  if (!configPath) {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', failure: CONFIG_UNAVAILABLE })}\n`);
    process.exitCode = 78;
  } else {
    const summary = await runNativeAcceptance(configPath);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.outcome !== 'PASS') process.exitCode = summary.outcome === 'BLOCKED' ? 78 : 1;
  }
}

#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHarnessBridge } from '../index.mjs';

export const EXPECTED_FINAL = 'Synthetic controlled model fixture completed the ordinary Skill check.';

export function requiredReceipt(receipt, request, result) {
  const business = receipt?.business;
  const model = receipt?.model;
  return receipt?.synthetic === true
    && receipt?.verified === true
    && receipt.taskId === request.taskId
    && receipt.sandboxId === result.sandbox.id
    && receipt.dshSessionId === result.evidence.dshSessionId
    && Number.isInteger(model?.requestCount)
    && model.requestCount === 2
    && model.completed === true
    && model?.secondRequestDenied === true
    && JSON.stringify(model.toolCalls) === JSON.stringify(['skill'])
    && model.skillContentVerified === true
    && business === undefined;
}

export function preparedConfigValid(config) {
  const native = config?.bridgeOptions?.native;
  const dsh = config?.bridgeOptions?.dsh;
  const request = config?.request;
  return Boolean(native && typeof native === 'object'
    && path.isAbsolute(native.cliPath ?? '')
    && typeof native.workspace === 'string'
    && path.isAbsolute(native.policyPath ?? '')
    && path.isAbsolute(native.home ?? '')
    && path.isAbsolute(native.xdgConfigHome ?? '')
    && dsh && path.isAbsolute(dsh.patchPath ?? '')
    && request && typeof request.taskId === 'string' && request.taskId.length > 0
    && typeof request.tenantId === 'string' && typeof request.actorId === 'string'
    && typeof request.prompt === 'string' && path.isAbsolute(request.skillPath ?? ''));
}

const SAFE_TOKEN = /^[a-z0-9_]+$/;
const SAFE_FIXTURE_CODE = /^native_fixture_[a-z0-9_]+$/;

export function sanitizedFailure(error, result) {
  const stage = result?.failure?.stage;
  const code = result?.failure?.code;
  if (typeof stage === 'string' && SAFE_TOKEN.test(stage) && typeof code === 'string' && SAFE_TOKEN.test(code)) {
    return { stage, code };
  }
  const candidate = typeof error?.code === 'string' ? error.code : error?.message;
  if (typeof candidate === 'string' && SAFE_FIXTURE_CODE.test(candidate)) {
    return { stage: 'fixture', code: candidate };
  }
  return { stage: 'acceptance', code: 'native_live_acceptance_failed' };
}

function argValue(argv, name) {
  const at = argv.indexOf(name);
  if (at < 0 || !argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error('usage');
  return argv[at + 1];
}

async function run(configPath) {
  if (!path.isAbsolute(configPath)) throw new Error('config-path-must-be-absolute');
  const st = await lstat(configPath);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error('config-must-be-private-regular-file-mode-0600');
  const config = (await import(`${pathToFileURL(configPath).href}?live=${Date.now()}`)).default;
  if (config?.synthetic !== true || typeof config?.prepareFixture !== 'function' || typeof config?.verifyFixtureReceipt !== 'function' || typeof config?.closeFixture !== 'function') throw new Error('trusted-config-must-explicitly-bind-synthetic-fixture-hooks');

  let fixture;
  let result;
  let receipt;
  let failure;
  try {
    fixture = await config.prepareFixture({ taskId: config.request.taskId });
    if (fixture?.ready !== true) throw new Error('controlled-fixture-not-ready');
    if (!preparedConfigValid(config)) throw new Error('trusted-config-missing-prepared-bridge-task-or-ordinary-skill');
    const bridge = createHarnessBridge(config.bridgeOptions);
    result = await bridge.execute(config.request, config.signal);
    if (result.status !== 'completed') failure = sanitizedFailure(null, result);
    if (result.status !== 'completed'
      || result.cleanup?.status !== 'verified'
      || result.evidence?.execution !== 'verified'
      || result.evidence?.cleanup !== 'verified'
      || result.evidence?.modelRequestCount !== null
      || result.output !== EXPECTED_FINAL
      || !result.sandbox?.id || !result.sandbox?.name || !result.sandbox?.workspace) {
      throw new Error('bridge-native-result-not-verified');
    }
    receipt = await config.verifyFixtureReceipt({ request: config.request, result, fixture });
    if (!requiredReceipt(receipt, config.request, result)) throw new Error('controlled-fixture-receipt-not-bound-or-successful');
  } catch (error) {
    failure ??= sanitizedFailure(error, result);
  } finally {
    if (fixture) {
      try { await config.closeFixture({ fixture }); }
      catch (error) { failure ??= sanitizedFailure(error, result); }
    }
  }

  const passed = !failure && result?.status === 'completed' && result.cleanup.status === 'verified';
  const summary = {
    outcome: passed ? 'PASS' : (result?.cleanup?.status === 'unverified' ? 'BLOCKED' : 'FAIL'),
    taskId: config.request.taskId,
    nativeExecution: result?.evidence?.execution ?? 'not-run',
    nativeCleanup: result?.cleanup?.status ?? 'not-created',
    sandboxId: result?.sandbox?.id ?? null,
    workspace: result?.sandbox?.workspace ?? null,
    dshSessionId: result?.evidence?.dshSessionId ?? null,
    bridgeModelRequestCount: result?.evidence?.modelRequestCount ?? null,
    fixture: receipt ? {
      verified: receipt.verified === true,
      requestCount: receipt.model.requestCount,
      secondRequestDenied: receipt.model.secondRequestDenied,
    } : null,
    failure: failure ?? null,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!passed) process.exitCode = result?.cleanup?.status === 'unverified' ? 78 : 1;
}

if (process.argv.includes('--config')) {
  try { await run(argValue(process.argv.slice(2), '--config')); }
  catch (error) {
    process.stdout.write(`${JSON.stringify({ outcome: 'BLOCKED', failure: error?.message === 'usage' ? 'usage' : 'trusted_config_unavailable' })}\n`);
    process.exitCode = 78;
  }
}

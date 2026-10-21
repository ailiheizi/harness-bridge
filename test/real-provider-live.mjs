#!/usr/bin/env node
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarnessBridge } from '../index.mjs';

const CONFIG_FAILURE = Object.freeze({ stage: 'config', code: 'trusted_config_unavailable' });
const ACCEPTANCE_FAILURE = Object.freeze({ stage: 'acceptance', code: 'real_provider_acceptance_failed' });
const SAFE_STAGES = new Set(['acceptance', 'accounting', 'admission', 'bridge', 'cleanup', 'cleanup_discovery', 'config', 'create', 'delete', 'dsh', 'exec', 'get', 'identity', 'input', 'list', 'patch', 'result_authorization', 'stop', 'upload']);
const SAFE_CODES = new Set([
  'absolute_private_config_required', 'aborted', 'bridge_failed', 'cleanup_deadline_exceeded', 'cleanup_failed', 'cleanup_unverified',
  'create_identity_missing', 'deadline_exceeded', 'delivery_denied', 'invalid_actor_id', 'invalid_event_stream', 'invalid_native_json',
  'invalid_provider_name', 'invalid_skill_path', 'invalid_task_id', 'invalid_tenant_id', 'invalid_prompt', 'invalid_skill_layout',
  'model_request_count_must_remain_unknown', 'native_command_failed', 'native_command_timeout', 'native_create_failed',
  'native_delete_failed', 'native_delete_unverified', 'native_get_failed', 'native_harness_error', 'native_identity_changed',
  'native_identity_mismatch', 'native_list_failed', 'native_list_pagination_invalid', 'native_list_pagination_limit',
  'native_list_schema_invalid', 'native_stop_failed', 'native_stop_unverified', 'native_upload_failed', 'no_result',
  'output_limit_exceeded', 'patch_not_file', 'prepared_roots_invalid', 'provider_context_close_failed',
  'provider_context_contract_invalid', 'provider_context_unavailable', 'real_provider_acceptance_failed', 'skill_not_file',
  'trusted_config_unavailable', 'turn_not_verified', 'owned_sandbox_discovery_failed',
]);

export function privateConfigStatValid(info) {
  return Boolean(typeof process.getuid === 'function' && info?.uid === process.getuid()
    && info?.isFile?.() === true && info?.isSymbolicLink?.() !== true && (info.mode & 0o777) === 0o600);
}

export async function privatePreparedRootsValid(native = {}) {
  const home = native.home;
  const xdg = native.xdgConfigHome;
  if (typeof home !== 'string' || !path.isAbsolute(home)
    || path.resolve(home) === path.parse(home).root
    || path.resolve(home) === path.resolve(os.homedir())
    || typeof xdg !== 'string' || !path.isAbsolute(xdg)
    || path.dirname(path.resolve(xdg)) !== path.resolve(home)) return false;
  let homeInfo;
  let xdgInfo;
  let resolvedHome;
  let resolvedXdg;
  try {
    [homeInfo, xdgInfo, resolvedHome, resolvedXdg] = await Promise.all([lstat(home), lstat(xdg), realpath(home), realpath(xdg)]);
  } catch { return false; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid !== null
    && homeInfo.isDirectory() && !homeInfo.isSymbolicLink() && homeInfo.uid === uid && (homeInfo.mode & 0o077) === 0
    && resolvedHome === path.resolve(home)
    && xdgInfo.isDirectory() && !xdgInfo.isSymbolicLink() && xdgInfo.uid === uid && (xdgInfo.mode & 0o077) === 0
    && resolvedXdg === path.resolve(xdg);
}

export function validProviderEvidence(evidence) {
  return Boolean(evidence && evidence.precheckVerified === true
    && evidence.provider === 'sub2api' && validModelId(evidence.model)
    && evidence.synthetic === false);
}

export function validModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

export async function verifyListedModel(source, fetchImpl = fetch) {
  if (!validModelId(source?.model) || typeof source.baseURL !== 'string'
    || typeof source.apiKey !== 'string' || source.apiKey.length < 8 || typeof fetchImpl !== 'function') throw new Error();
  const response = await fetchImpl(`${source.baseURL.replace(/\/$/u, '')}/models`, {
    method: 'GET', headers: { authorization: `Bearer ${source.apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error();
  const body = await response.json();
  if (!Array.isArray(body?.data) || !body.data.some((entry) => entry?.id === source.model)) throw new Error();
  return true;
}

export function validBridgeOptions(options) {
  const native = options?.native;
  const dsh = options?.dsh;
  const providers = native?.providers;
  return Boolean(native && path.isAbsolute(native.cliPath ?? '')
    && typeof native.workspace === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(native.workspace)
    && typeof native.image === 'string' && /^sha256:[a-f0-9]{64}$/u.test(native.image)
    && path.isAbsolute(native.policyPath ?? '')
    && path.isAbsolute(native.home ?? '') && path.isAbsolute(native.xdgConfigHome ?? '')
    && Array.isArray(providers) && providers.length > 0
    && providers.every((provider) => typeof provider === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(provider))
    && new Set(providers).size === providers.length
    && dsh && path.isAbsolute(dsh.patchPath ?? '')
    && typeof options.authorizeAdmission === 'function'
    && typeof options.authorizeNativeCall === 'function'
    && typeof options.authorizeResult === 'function');
}

export function passAllowedWithoutFailure(failure) {
  return failure === null || failure === undefined;
}

export function parsedOutputValid(output, expectedOutput) {
  if (typeof output !== 'string' || !expectedOutput || typeof expectedOutput !== 'object' || Array.isArray(expectedOutput)) return false;
  try {
    const parsed = JSON.parse(output);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      && sameJsonObject(parsed, expectedOutput);
  } catch { return false; }
}

function sameJsonObject(actual, expected) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) return false;
  return actualKeys.every((key) => jsonValueEqual(actual[key], expected[key]));
}

function jsonValueEqual(actual, expected) {
  if (actual === expected) return true;
  if (actual === null || expected === null || typeof actual !== 'object' || typeof expected !== 'object') return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && actual.every((value, index) => jsonValueEqual(value, expected[index]));
  }
  return sameJsonObject(actual, expected);
}

function safeId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function safeFailure(result, fallback = ACCEPTANCE_FAILURE) {
  return whitelistedFailure(result?.failure?.stage, result?.failure?.code) ?? { ...fallback };
}

function whitelistedFailure(stage, code) {
  return typeof stage === 'string' && SAFE_STAGES.has(stage) && typeof code === 'string' && SAFE_CODES.has(code)
    ? { stage, code } : null;
}

export function summarizeRealProviderAcceptance({ result, request, expectedOutput, providerEvidence, closeVerified, blocked = false, failure }) {
  const sandboxId = safeId(result?.sandbox?.id);
  const sandboxName = safeId(result?.sandbox?.name);
  const workspace = safeId(result?.sandbox?.workspace);
  const taskId = safeId(request?.taskId);
  const sessionId = safeId(result?.evidence?.dshSessionId);
  const providerVerified = validProviderEvidence(providerEvidence);
  const outputValid = parsedOutputValid(result?.output, expectedOutput);
  const nativeCleanup = result?.cleanup?.status === 'verified' && result?.evidence?.cleanup === 'verified';
  const nativeExecution = result?.status === 'completed' && result?.taskId === request?.taskId
    && result?.evidence?.execution === 'verified' && result?.evidence?.nativeExitCode === 0
    && result?.evidence?.modelRequestCount === null && result?.evidence?.toolCallCount === 0 && Boolean(sessionId)
    && Boolean(sandboxId && sandboxName && workspace) && outputValid && providerVerified;
  const passed = nativeExecution && nativeCleanup && closeVerified === true && !blocked && passAllowedWithoutFailure(failure);
  const cleanupUnknown = result?.cleanup?.status === 'unverified' || result?.evidence?.cleanup === 'unverified'
    || closeVerified !== true;
  return Object.freeze({
    status: passed ? 'PASS' : (blocked || cleanupUnknown ? 'BLOCKED' : 'FAIL'),
    scope: 'native-real-provider-roundtrip',
    taskId,
    sandbox: sandboxId && sandboxName && workspace ? { id: sandboxId, name: sandboxName, workspace } : null,
    dshSessionId: sessionId,
    provider: providerVerified
      ? { name: providerEvidence.provider, model: providerEvidence.model, precheckVerified: true, synthetic: false } : null,
    outputValid,
    nativeExecutionVerified: nativeExecution,
    nativeCleanup: nativeCleanup ? 'verified' : (result?.cleanup?.status === 'unverified' ? 'unverified' : 'unknown'),
    configClosed: closeVerified === true,
    accountingVerified: false,
    requestCount: null,
    billingVerified: false,
    ...(passed ? {} : { failure: failure ?? safeFailure(result) }),
  });
}

async function loadConfig(configPath) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw Object.assign(new Error(), CONFIG_FAILURE);
  let info;
  try { info = await lstat(configPath); } catch { throw Object.assign(new Error(), CONFIG_FAILURE); }
  if (!privateConfigStatValid(info)) throw Object.assign(new Error(), CONFIG_FAILURE);
  try {
    const config = (await import(`${pathToFileURL(configPath).href}?real-provider-live=${Date.now()}`)).default;
    if (config?.realProvider !== true || typeof config.prepareContext !== 'function') throw new Error();
    return config;
  } catch { throw Object.assign(new Error(), CONFIG_FAILURE); }
}

export async function runRealProviderAcceptance(configPath) {
  let config;
  let context;
  let result;
  let closeVerified = false;
  let failure = null;
  let blocked = false;
  let request;
  let expectedOutput;
  let providerEvidence;
  try {
    config = await loadConfig(configPath);
    try { context = await config.prepareContext(); }
    catch { throw Object.assign(new Error(), { stage: 'config', code: 'provider_context_unavailable' }); }
    request = context?.request;
    expectedOutput = context?.expectedOutput;
    providerEvidence = context?.providerEvidence;
    if (!context || typeof context.close !== 'function' || !validBridgeOptions(context.bridgeOptions)
      || !await privatePreparedRootsValid(context.bridgeOptions.native)
      || !validProviderEvidence(context.providerEvidence)
      || typeof request?.taskId !== 'string' || !request.taskId.trim()
      || typeof request?.tenantId !== 'string' || !request.tenantId.trim()
      || typeof request?.actorId !== 'string' || !request.actorId.trim()
      || typeof request?.prompt !== 'string' || !request.prompt.trim()
      || !expectedOutput || typeof expectedOutput !== 'object' || Array.isArray(expectedOutput)) {
      throw Object.assign(new Error(), { stage: 'config', code: 'provider_context_contract_invalid' });
    }
    const bridge = createHarnessBridge(context.bridgeOptions);
    result = await bridge.execute(request);
    if (result?.evidence?.modelRequestCount !== null) {
      blocked = true;
      failure = { stage: 'accounting', code: 'model_request_count_must_remain_unknown' };
    }
  } catch (error) {
    blocked = true;
    failure = whitelistedFailure(error?.stage, error?.code) ?? { ...ACCEPTANCE_FAILURE };
  } finally {
    if (context && typeof context.close === 'function') {
      try { await context.close(); closeVerified = true; }
      catch { blocked = true; failure ??= { stage: 'cleanup', code: 'provider_context_close_failed' }; }
    }
  }
  if (!context || result?.status === 'blocked') blocked = true;
  return summarizeRealProviderAcceptance({ result, request, expectedOutput, providerEvidence, closeVerified, blocked, failure });
}

if (process.argv.includes('--config') && process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const index = process.argv.indexOf('--config');
  const configPath = index >= 0 ? process.argv[index + 1] : '';
  if (process.argv.length !== 4 || index !== 2 || !path.isAbsolute(configPath)) {
    process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', scope: 'native-real-provider-roundtrip', failure: { stage: 'config', code: 'absolute_private_config_required' }, accountingVerified: false, requestCount: null, billingVerified: false })}\n`);
    process.exitCode = 78;
  } else {
    runRealProviderAcceptance(configPath).then((report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      if (report.status !== 'PASS') process.exitCode = report.status === 'BLOCKED' ? 78 : 1;
    }).catch(() => {
      process.stdout.write(`${JSON.stringify({ status: 'BLOCKED', scope: 'native-real-provider-roundtrip', failure: CONFIG_FAILURE, accountingVerified: false, requestCount: null, billingVerified: false })}\n`);
      process.exitCode = 78;
    });
  }
}

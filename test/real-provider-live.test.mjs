import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsedOutputValid,
  passAllowedWithoutFailure,
  privateConfigStatValid,
  privatePreparedRootsValid,
  runRealProviderAcceptance,
  summarizeRealProviderAcceptance,
  validBridgeOptions,
  validModelId,
  validProviderEvidence,
  verifyListedModel,
} from './real-provider-live.mjs';

test('private config requires a regular non-symlink file with exact 0600 permissions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'real-provider-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'trusted.mjs');
  await writeFile(config, 'export default {};', { mode: 0o600 });
  await chmod(config, 0o600);
  const configStat = await lstat(config);
  assert.equal(privateConfigStatValid(configStat), true);
  assert.equal(privateConfigStatValid({
    uid: configStat.uid + 1, mode: configStat.mode,
    isFile: () => true, isSymbolicLink: () => false,
  }), false);
  const loose = path.join(root, 'loose.mjs');
  await writeFile(loose, 'export default {};', { mode: 0o644 });
  await chmod(loose, 0o644);
  assert.equal(privateConfigStatValid(await lstat(loose)), false);
  const link = path.join(root, 'config-link.mjs');
  await symlink(config, link);
  assert.equal(privateConfigStatValid(await lstat(link)), false);
});

test('prepared CLI HOME and nested XDG must be separate owner-private real directories', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'real-provider-roots-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = await realpath(temp);
  const home = path.join(root, 'openshell-home');
  const xdg = path.join(home, 'xdg');
  await mkdir(xdg, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await chmod(xdg, 0o700);
  assert.equal(await privatePreparedRootsValid({ home, xdgConfigHome: xdg }), true);
  await chmod(xdg, 0o750);
  assert.equal(await privatePreparedRootsValid({ home, xdgConfigHome: xdg }), false);
  await chmod(xdg, 0o700);
  const homeLink = path.join(root, 'home-link');
  await symlink(home, homeLink);
  assert.equal(await privatePreparedRootsValid({ home: homeLink, xdgConfigHome: path.join(homeLink, 'xdg') }), false);
  assert.equal(await privatePreparedRootsValid({ home: os.homedir(), xdgConfigHome: path.join(os.homedir(), 'xdg') }), false);
  assert.equal(await privatePreparedRootsValid({ home, xdgConfigHome: path.join(root, 'outside-xdg') }), false);
  assert.equal(await privatePreparedRootsValid({ home: path.parse(home).root, xdgConfigHome: path.join(path.parse(home).root, 'xdg') }), false);
});

test('provider evidence accepts a trusted explicitly selected model after precheck', () => {
  const evidence = { precheckVerified: true, provider: 'sub2api', model: 'gpt-6-luna', synthetic: false };
  assert.equal(validProviderEvidence(evidence), true);
  assert.equal(validProviderEvidence({ ...evidence, model: 'deepseek-v4.1-flash' }), true);
  assert.equal(validProviderEvidence({ ...evidence, synthetic: true }), false);
  assert.equal(validProviderEvidence({ ...evidence, model: '' }), false);
  assert.equal(validProviderEvidence({ ...evidence, model: 'model name' }), false);
  assert.equal(validProviderEvidence({ ...evidence, model: 'model\nname' }), false);
  assert.equal(validProviderEvidence({ ...evidence, model: `x${'a'.repeat(128)}` }), false);
  assert.equal(validProviderEvidence({ ...evidence, precheckVerified: false }), false);
});

test('selected model IDs reject empty, whitespace, and control characters', () => {
  assert.equal(validModelId('deepseek-v4.1-flash'), true);
  for (const value of ['', ' ', ' model', 'model ', 'model\nname', 'model\u007fname', `m${'x'.repeat(128)}`]) {
    assert.equal(validModelId(value), false);
  }
});

test('configured model precheck rejects an unlisted ID before setup can continue', async () => {
  const calls = [];
  const source = { model: 'deepseek-v4.1-flash', baseURL: 'https://provider.invalid/v1', apiKey: 'synthetic-key' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: [{ id: 'gpt-6-luna' }] }) };
  };
  await assert.rejects(verifyListedModel(source, fetchImpl));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.invalid/v1/models');
  assert.equal(calls[0].options.method, 'GET');
});

test('configured different model is accepted only when the authenticated precheck lists it', async () => {
  let call;
  const source = { model: 'deepseek-v4.1-flash', baseURL: 'https://provider.invalid/v1/', apiKey: 'synthetic-key' };
  assert.equal(await verifyListedModel(source, async (url, options) => {
    call = { url, options };
    return { ok: true, json: async () => ({ data: [{ id: source.model }] }) };
  }), true);
  assert.equal(call.url, 'https://provider.invalid/v1/models');
  assert.equal(call.options.method, 'GET');
  assert.equal(call.options.headers.authorization, 'Bearer synthetic-key');
  let called = false;
  await assert.rejects(verifyListedModel({ ...source, model: 'bad model' }, async () => { called = true; }));
  assert.equal(called, false);
});

test('bridge binding accepts a pinned OCI digest and run-owned native provider names', () => {
  const options = {
    native: {
      cliPath: '/opt/openshell', workspace: 'default', image: `sha256:${'a'.repeat(64)}`,
      policyPath: '/private/policy.yml', home: '/private/home', xdgConfigHome: '/private/home/xdg',
      providers: ['awreal-0123456789abcdef'],
    },
    dsh: { patchPath: '/private/dsh-patch.yml' },
    authorizeAdmission() {}, authorizeNativeCall() {}, authorizeResult() {},
  };
  assert.equal(validBridgeOptions(options), true);
  assert.equal(validBridgeOptions({ ...options, native: { ...options.native, image: '/opt/image' } }), false);
  assert.equal(validBridgeOptions({ ...options, native: { ...options.native, providers: [] } }), false);
  assert.equal(validBridgeOptions({ ...options, native: { ...options.native, providers: ['awreal/invalid'] } }), false);
  assert.equal(validBridgeOptions({ ...options, native: { ...options.native, providers: ['awreal-one', 'awreal-one'] } }), false);
});

test('any unresolved failure, including unknown request metering, blocks PASS', () => {
  assert.equal(passAllowedWithoutFailure(null), true);
  assert.equal(passAllowedWithoutFailure(undefined), true);
  assert.equal(passAllowedWithoutFailure({ stage: 'accounting', code: 'model_request_count_must_remain_unknown' }), false);
});

test('output validation requires exact JSON object contents and rejects extra fields', () => {
  const expected = { status: 'synthetic-ok', count: 2, nested: { value: true } };
  assert.equal(parsedOutputValid('{"nested":{"value":true},"count":2,"status":"synthetic-ok"}', expected), true);
  assert.equal(parsedOutputValid('{"status":"synthetic-ok","count":2,"nested":{"value":true},"extra":0}', expected), false);
  assert.equal(parsedOutputValid('not-json', expected), false);
  assert.equal(parsedOutputValid('[]', expected), false);
});

test('unverified accounting and absent native evidence never produce PASS', () => {
  const report = summarizeRealProviderAcceptance({
    result: null,
    request: { taskId: 'controlled-task' },
    expectedOutput: { result: 'synthetic' },
    providerEvidence: { precheckVerified: true, provider: 'sub2api', model: 'deepseek-v4.1-flash', synthetic: false },
    closeVerified: true,
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.scope, 'native-real-provider-roundtrip');
  assert.equal(report.accountingVerified, false);
  assert.equal(report.requestCount, null);
  assert.equal(report.billingVerified, false);
  assert.equal(report.nativeExecutionVerified, false);
  assert.equal(report.provider.model, 'deepseek-v4.1-flash');
});

test('reported diagnostics keep only known-safe stage and code pairs', () => {
  const report = summarizeRealProviderAcceptance({
    result: { failure: { stage: 'dsh', code: 'Bearer_secret_provider_endpoint' }, cleanup: { status: 'unverified' } },
    request: { taskId: 'controlled-task' },
    expectedOutput: { result: 'synthetic' },
    providerEvidence: null,
    closeVerified: false,
  });
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.failure, { stage: 'acceptance', code: 'real_provider_acceptance_failed' });
  assert.equal(JSON.stringify(report).includes('Bearer_secret_provider_endpoint'), false);
});

test('CLI entrypoint fails closed on a non-private config without invoking a bridge', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'real-provider-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'untrusted.mjs');
  await writeFile(config, 'export default { realProvider: true, prepareContext() { throw new Error("must not load"); } };', { mode: 0o644 });
  await chmod(config, 0o644);
  const report = await runRealProviderAcceptance(config);
  assert.equal(report.status, 'BLOCKED');
  assert.deepEqual(report.failure, { stage: 'config', code: 'trusted_config_unavailable' });
  assert.equal(report.accountingVerified, false);
  assert.equal(report.requestCount, null);
  assert.equal(report.billingVerified, false);
});

test('Node test discovery can load the runner without config or native side effects', () => {
  const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'real-provider-live.mjs');
  const child = spawnSync(process.execPath, [runnerPath], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The deployment module intentionally uses plain ESM JavaScript.
import { validateDeployment } from '../integrations/sub2api-openshell/binding.mjs';
// @ts-expect-error The deployment module intentionally uses plain ESM JavaScript.
import { prepareNativeGateway } from '../integrations/sub2api-openshell/native-tls.mjs';

const config = { cliPath: '/opt/openshell', stateDir: '/data/native', workspace: 'test', image: `sha256:${'a'.repeat(64)}`,
  model: 'test', apiKey: 'test-only', meterPort: 4321, gatewayEndpoint: 'https://127.0.0.1:8080', upstreamUrl: 'https://example.test/v1',
  gatewayTls: { caPath: '/run/native/ca.crt', certPath: '/run/native/tls.crt', keyPath: '/run/native/tls.key' } };

test('HTTPS loopback requires an explicit native client bundle; HTTP cannot ignore one', () => {
  assert.doesNotThrow(() => validateDeployment(config));
  assert.throws(() => validateDeployment({ ...config, gatewayTls: undefined }), /GATEWAY_TLS_REQUIRED/);
  assert.throws(() => validateDeployment({ ...config, gatewayEndpoint: 'https://example.test:8080' }), /GATEWAY_MUST_BE_LOOPBACK/);
  assert.throws(() => validateDeployment({ ...config, gatewayTls: { ...config.gatewayTls, keyPath: 'relative' } }), /GATEWAY_TLS_REQUIRED/);
  assert.throws(() => validateDeployment({ ...config, gatewayEndpoint: 'http://127.0.0.1:8080' }), /GATEWAY_TLS_REQUIRES_HTTPS/);
});

test('native credentials are copied into each task XDG, remain private and are removed with the task', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gw-native-tls-'));
  try {
    const source = path.join(root, 'source'); await mkdir(source, { mode: 0o700 });
    for (const name of ['ca.crt', 'tls.crt', 'tls.key']) await writeFile(path.join(source, name), `fixture-${name}`, { mode: 0o600 });
    const cfg = { ...config, gatewayTls: { caPath: path.join(source, 'ca.crt'), certPath: path.join(source, 'tls.crt'), keyPath: path.join(source, 'tls.key') } };
    for (const task of ['one', 'two']) {
      const taskRoot = path.join(root, task); const xdg = path.join(taskRoot, 'xdg'); await mkdir(xdg, { recursive: true, mode: 0o700 });
      await prepareNativeGateway(cfg, xdg);
      const base = path.join(xdg, 'openshell/gateways/groupweave');
      const metadata = JSON.parse(await readFile(path.join(base, 'metadata.json'), 'utf8'));
      assert.equal(metadata.auth_mode, 'mtls'); assert.equal(metadata.gateway_endpoint, cfg.gatewayEndpoint);
      assert.equal(metadata.gateway_port, 8080); assert.equal(metadata.is_remote, false);
      assert.equal(await readFile(path.join(xdg, 'openshell/active_gateway'), 'utf8'), 'groupweave');
      assert.equal(await readFile(path.join(base, 'mtls/tls.key'), 'utf8'), 'fixture-tls.key');
      assert.equal((await stat(path.join(base, 'mtls/tls.key'))).mode & 0o777, 0o600);
      assert.notEqual((await stat(path.join(base, 'mtls/tls.key'))).ino, (await stat(cfg.gatewayTls.keyPath)).ino);
      assert.deepEqual(await readdir(taskRoot), ['xdg']); // No DSH workspace or HOME receives the bundle.
    }
    await rm(path.join(root, 'one'), { recursive: true });
    assert.equal(await readFile(path.join(root, 'two/xdg/openshell/gateways/groupweave/mtls/tls.key'), 'utf8'), 'fixture-tls.key');
    await chmod(cfg.gatewayTls.keyPath, 0o644);
    await assert.rejects(prepareNativeGateway(cfg, path.join(root, 'bad-mode')), /GATEWAY_TLS_FILE_UNTRUSTED/);
    await chmod(cfg.gatewayTls.keyPath, 0o600); await symlink(cfg.gatewayTls.keyPath, path.join(source, 'link'));
    await assert.rejects(prepareNativeGateway({ ...cfg, gatewayTls: { ...cfg.gatewayTls, keyPath: path.join(source, 'link') } }, path.join(root, 'bad-link')), /GATEWAY_TLS_FILE_UNTRUSTED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

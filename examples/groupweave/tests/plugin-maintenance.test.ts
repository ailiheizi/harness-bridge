import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
test('native installer exact npm install, loader lifecycle and direct rejection', { timeout: 120000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-plugin-'));
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  try {
    await writeFile(join(dir, 'initial.yml'), 'plugins:\n  http: {}\n');
    runtime = await createKoishiRuntime({ configPath: join(dir, 'initial.yml'), maintenanceDir: join(dir, 'managed') });
    await runtime.start();
    const service = runtime.maintenance!;
    await assert.rejects(service.install('https://evil.invalid/x', '1.0.0'));
    await service.install('@koishijs/plugin-echo', '2.2.5');
    assert.equal(JSON.parse(await readFile(join(dir, 'managed/node_modules/@koishijs/plugin-echo/package.json'), 'utf8')).version, '2.2.5');
    await service.configure('echo:m1', {}, true);
    assert.ok(runtime.app.$commander.get('echo'));
    await service.configure('echo:m1', {}, false);
    assert.match(await readFile(join(dir, 'managed/koishi.yml'), 'utf8'), /~echo:m1/);
    await assert.rejects(service.configure('definitely-missing-plugin:m1', {}, true));
  } finally {
    await runtime?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('managed config keeps original env files for conditional plugins and SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gw-plugin-env-'));
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  const keys = ['GW_M1_ECHO', 'GW_M1_DB'];
  const previous = keys.map(key => process.env[key]);
  try {
    await writeFile(join(dir, '.env'), `GW_M1_ECHO=1\nGW_M1_DB=${join(dir, 'original.db')}\n`);
    await writeFile(join(dir, 'initial.yml'), "plugins:\n  http: {}\n  echo:\n    $if: env.GW_M1_ECHO === '1'\n  database-sqlite:\n    path: ${{ env.GW_M1_DB }}\n");
    runtime = await createKoishiRuntime({ configPath: join(dir, 'initial.yml'), maintenanceDir: () => join(dir, 'managed'), beforeCreate() {
      assert.equal(process.env.GW_M1_ECHO, '1');
    } });
    await runtime.start();
    assert.equal(process.env.GW_M1_ECHO, '1');
    assert.equal(process.env.GW_M1_DB, join(dir, 'original.db'));
    assert.ok(runtime.app.$commander.get('echo'));
    await runtime.app.database.createUser('m1-env', 'user', { name: 'saved' });
    assert.equal((await runtime.app.database.getUser('m1-env', 'user'))?.name, 'saved');
    assert.ok((await readFile(join(dir, 'original.db'))).length);
    await assert.rejects(readFile(join(dir, 'managed/.env')));
  } finally {
    await runtime?.stop();
    keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    await rm(dir, { recursive: true, force: true });
  }
});

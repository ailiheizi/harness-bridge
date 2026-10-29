import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, StoreError } from '../src/server/store.js';
import { runMaintenance } from '../src/server/maintenance.js';

function code(expected: string) { return (error: unknown) => error instanceof StoreError && error.code === expected; }
test('fixed maintenance options require explicit point-in-time restore and return only verified metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groupweave-maintenance-'));
  const dataDir = join(root, 'data'), restoredDir = join(root, 'restored');
  let store: Store | undefined;
  try {
    store = new Store(dataDir); const group = store.group('group-a', 'admin-a')!;
    store.putProposal({ id: 'maintenance-proposal', groupId: group.id, creatorId: 'admin-a', baseVersion: group.version,
      candidate: { ...group.config, maxItems: 7 }, before: group.config, warnings: [], changes: [], text: 'synthetic-private-rules', status: 'pending', createdAt: new Date().toISOString() });
    store.activateProposal('maintenance-proposal', 'admin-a'); store.close(); store = undefined;
    for (const args of [[], ['shell'], ['backup', '--data-dir', dataDir, '--output-name', '../escape.sqlite'], ['backup', '--data-dir', dataDir, '--data-dir', dataDir], ['backup', '--data-dir', dataDir, '--unknown', 'x']]) await assert.rejects(runMaintenance(args), code('MAINTENANCE_USAGE'));
    await assert.rejects(runMaintenance(['backup', '--data-dir', join(root, 'missing'), '--output-name', 'missing.sqlite']), code('DATABASE_MISSING'));
    const backup = await runMaintenance(['backup', '--data-dir', dataDir, '--output-name', 'snapshot.sqlite']);
    assert.deepEqual(Object.keys(backup).sort(), ['integrity', 'pages', 'schemaVersion', 'sha256']); assert.equal(backup.integrity, 'ok');
    const source = join(dataDir, 'backups', 'snapshot.sqlite'); const before = readFileSync(source);
    await assert.rejects(runMaintenance(['restore', '--source', source, '--data-dir', restoredDir]), code('RESTORE_ACK_REQUIRED'));
    assert.deepEqual(readFileSync(source), before);
    const restored = await runMaintenance(['restore', '--source', source, '--data-dir', restoredDir, '--acknowledge-point-in-time']); assert.equal(restored.integrity, 'ok');
    store = new Store(restoredDir); assert.equal(store.group('group-a', 'admin-a')?.config.maxItems, 7); store.close(); store = undefined;
    const failed = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/maintenance.ts', 'restore', '--source', source, '--data-dir', restoredDir], { encoding: 'utf8', timeout: 5000 });
    assert.equal(failed.status, 1); const failure = JSON.parse(failed.stderr); assert.equal(failure.code, 'RESTORE_ACK_REQUIRED');
    assert.doesNotMatch(failed.stdout + failed.stderr, /synthetic-private-rules|\/tmp\/|groupweave-maintenance-/);
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/maintenance.ts', 'backup', '--data-dir', restoredDir, '--output-name', 'cli.sqlite'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(cli.status, 0, cli.stderr); const result = JSON.parse(cli.stdout); assert.equal(result.ok, true); assert.equal(result.integrity, 'ok'); assert.equal(result.schemaVersion, 3); assert.equal('path' in result, false);
    assert.ok(readdirSync(restoredDir).every(name => !name.startsWith('.restore-')));
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

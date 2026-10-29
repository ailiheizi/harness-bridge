import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Store } from '../src/server/store.js';
import type { Task } from '../src/shared.js';

test('exclusive SQLite owner rejects overlapping Store before recovery and releases on close', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'groupweave-store-owner-'));
  const closeNative = DatabaseSync.prototype.close;
  const closedHandles = new Set<DatabaseSync>();
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    closedHandles.add(this);
    return closeNative.call(this);
  };
  let owner: Store | undefined;
  let nextOwner: Store | undefined;
  try {
    owner = new Store(dataDir);
    const draft: Task = {
      id: 'live-operation', groupId: 'group-a', creatorId: 'admin-a', featureId: 'link-cleaner',
      audience: 'private', configVersion: 1, createdAt: new Date().toISOString(), durationMs: 0,
      modelCalls: 0, input: 'https://synthetic.example', output: '', status: 'blocked',
      error: '执行结果未知，不能自动重放。',
    };
    owner.reserveTask(draft, 'single-owner', 'synthetic-request-hash');
    assert.equal(owner.reservation('group-a', 'admin-a', 'single-owner')!.pending, true);

    assert.throws(() => new Store(dataDir), (error: unknown) => {
      return error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR' &&
        'errcode' in error && error.errcode === 5;
    });
    // The failed constructor closes its own real native handle. The first owner
    // remains open and its live reservation was not recovered or overwritten.
    assert.equal(closedHandles.size, 1);
    const stillLive = owner.reservation('group-a', 'admin-a', 'single-owner')!;
    assert.equal(stillLive.pending, true);
    assert.equal(stillLive.task, undefined);

    // Also prove the database's native OS lock, beyond two handles in one Node process.
    const contender = spawnSync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '-e', `
        import { DatabaseSync } from 'node:sqlite';
        import { Store } from './src/server/store.ts';
        const originalClose = DatabaseSync.prototype.close;
        let closeCalls = 0;
        DatabaseSync.prototype.close = function () { closeCalls++; return originalClose.call(this); };
        try {
          const store = new Store(process.argv[1]);
          store.close();
          process.exitCode = 2;
        } catch (error) {
          process.stdout.write(JSON.stringify({ code: error.code, errcode: error.errcode, closeCalls }));
        }
      `, dataDir,
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000 });
    assert.equal(contender.status, 0, contender.stderr);
    assert.deepEqual(JSON.parse(contender.stdout), { code: 'ERR_SQLITE_ERROR', errcode: 5, closeCalls: 1 });
    assert.equal(owner.reservation('group-a', 'admin-a', 'single-owner')!.pending, true);

    owner.close(); owner = undefined;
    nextOwner = new Store(dataDir);
    const recovered = nextOwner.reservation('group-a', 'admin-a', 'single-owner')!;
    assert.equal(recovered.pending, false);
    assert.equal(recovered.task!.id, draft.id);
    assert.equal(recovered.task!.status, 'blocked');
    assert.match(recovered.task!.error!, /未知/);
    assert.equal(recovered.task!.output, '');
  } finally {
    nextOwner?.close(); owner?.close();
    DatabaseSync.prototype.close = closeNative;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

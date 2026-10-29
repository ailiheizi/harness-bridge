import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, StoreError, telegramPrivateId } from '../src/server/store.js';
import type { Task } from '../src/shared.js';

function errorCode(code: string) { return (error: unknown) => error instanceof StoreError && error.code === code; }
function succeeded(id: string, groupId: string, creatorId: string): Task {
  return { id, groupId, creatorId, audience: 'private', featureId: 'assistant', status: 'succeeded', configVersion: 1,
    createdAt: new Date().toISOString(), durationMs: 1, modelCalls: 1, input: 'private test input', output: 'private test output' };
}

test('private scopes persist separately and only their owner can read or claim delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-private-')); let store: Store | undefined;
  try {
    store = new Store(dir);
    assert.equal(telegramPrivateId(123), 'tg-dm:123');
    const first = store.ensureTelegramPrivate(123, 'Owner One');
    const second = store.ensureTelegramPrivate(456, 'Owner Two');
    assert.deepEqual(first, { groupId: 'tg-dm:123', actorId: 'tg-user:123', created: true });
    assert.equal(store.ensureTelegramPrivate(123, 'Changed Name').created, false);
    assert.equal(store.group(first.groupId, first.actorId)?.role, 'admin');
    assert.equal(store.group(first.groupId, second.actorId), undefined);
    assert.deepEqual(store.groups(first.actorId), []);
    const task: Task = succeeded('dm-task-owner-one', first.groupId, first.actorId);
    store.reserveTask(task, 'dm-key', 'dm-hash'); assert.equal(store.finishTask(task), true);
    assert.equal(store.claimTelegramDelivery(task.id, first.groupId, second.actorId), false);
    assert.equal(store.claimTelegramDelivery(task.id, first.groupId, first.actorId), true);
    assert.throws(() => store!.recordTelegramDelivery(task.id, first.groupId, second.actorId, 'sent'), errorCode('DELIVERY_SCOPE'));
    store.recordTelegramDelivery(task.id, first.groupId, first.actorId, 'sent');
    store.close(); store = new Store(dir);
    assert.equal(store.group(first.groupId, first.actorId)?.name, 'Owner One');
    assert.equal(store.group(first.groupId, second.actorId), undefined);
    assert.equal(store.claimTelegramDelivery(task.id, first.groupId, first.actorId), false);
    store.close(); store = undefined;
    const db = new DatabaseSync(join(dir, 'groupweave.sqlite'));
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM groups').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM memberships').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM private_scopes').get() as { count: number }).count, 2); db.close();
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('private task bodies obey the same per-scope retention limit as groups', () => {
  const store = new Store(undefined, { retention: { tasksPerGroup: 1 } });
  try {
    const { groupId, actorId } = store.ensureTelegramPrivate(321);
    for (const id of ['private-old', 'private-new']) {
      const task = succeeded(id, groupId, actorId);
      store.reserveTask(task, id, `hash-${id}`); store.finishTask(task);
    }
    assert.equal(store.task('private-old')?.expired, true);
    assert.equal(store.task('private-new')?.task?.status, 'succeeded');
  } finally { store.close(); }
});

test('schema 2 databases and backups migrate private scope storage without losing group or task data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groupweave-private-migrate-')); let store: Store | undefined;
  try {
    const dir = join(root, 'db'); store = new Store(dir);
    const { groupId, actorId } = store.registerTelegramGroup({ chatId: -123, title: 'Existing group', userId: 77 });
    store.syncTelegramMember(-123, 77, 'admin');
    const oldTask: Task = { ...succeeded('existing-task', groupId, actorId), audience: 'group' };
    store.reserveTask(oldTask, 'existing-key', 'existing-hash'); store.finishTask(oldTask); store.close(); store = undefined;
    const file = join(dir, 'groupweave.sqlite'); const db = new DatabaseSync(file);
    db.exec('DROP TABLE private_scopes; PRAGMA user_version=2'); db.close();
    store = new Store(dir);
    assert.equal(store.schemaVersion, 3); assert.equal(store.group(groupId, actorId)?.name, 'Existing group');
    assert.equal(store.reservation(groupId, actorId, 'existing-key')?.task?.id, 'existing-task');
    const report = await store.backupTo(join(dir, 'backups', 'migrated.sqlite'));
    assert.equal(report.schemaVersion, 3); store.close(); store = undefined;

    // Convert a verified v3 backup to its genuine v2 table/version shape.
    const v2 = join(root, 'legacy-v2.sqlite'); copyFileSync(report.path, v2);
    const legacy = new DatabaseSync(v2); legacy.exec('DROP TABLE private_scopes; PRAGMA user_version=2'); legacy.close();
    const restoredDir = join(root, 'restored');
    await Store.restoreBackup(v2, restoredDir);
    store = new Store(restoredDir);
    assert.equal(store.group(groupId, actorId)?.name, 'Existing group');
    assert.equal(store.reservation(groupId, actorId, 'existing-key')?.task?.id, 'existing-task');
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

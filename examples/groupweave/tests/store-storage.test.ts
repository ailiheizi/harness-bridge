import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, StoreError, STORAGE_SCHEMA_VERSION, telegramActorId, telegramGroupId } from '../src/server/store.js';
import type { Proposal, Task } from '../src/shared.js';

function task(id: string, groupId = 'group-a', creatorId = 'admin-a', audience: Task['audience'] = 'private'): Task {
  return { id, groupId, creatorId, audience, featureId: 'link-cleaner', status: 'blocked', configVersion: 1,
    createdAt: new Date().toISOString(), durationMs: 0, modelCalls: 0, input: `synthetic-input-${id}`,
    output: '', error: '结果未知，不自动重放。' };
}
function complete(store: Store, draft: Task, key = draft.id): Task {
  store.reserveTask(draft, key, `digest-${draft.id}`);
  const result: Task = { ...draft, status: 'succeeded', output: `synthetic-output-${draft.id}` }; delete result.error;
  assert.equal(store.finishTask(result), true); return result;
}
function proposal(store: Store, id: string, groupId = 'group-a', creatorId = 'admin-a'): Proposal {
  const group = store.group(groupId, creatorId)!;
  return { id, groupId, creatorId, baseVersion: group.version, candidate: { ...group.config, maxItems: 5 },
    before: group.config, warnings: [], changes: ['合成配置'], text: '合成配置', status: 'pending', createdAt: new Date().toISOString() };
}
function errorCode(code: string) { return (error: unknown) => error instanceof StoreError && error.code === code; }

// No real Telegram calls or identities: numeric test IDs are synthetic trusted observations.
test('Telegram registry persists observed membership without granting preview or platform authority', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-registry-'));
  let store: Store | undefined;
  try {
    store = new Store(dir);
    assert.equal(telegramGroupId(-100123), 'tg:-100123'); assert.equal(telegramActorId(123), 'tg-user:123');
    for (const invalid of [0, 1, '-01', 'group-a', -Number.MAX_SAFE_INTEGER - 1]) assert.throws(() => telegramGroupId(invalid), errorCode('INVALID_TELEGRAM_ID'));
    for (const invalid of [0, -1, '01', 'admin-a', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => telegramActorId(invalid), errorCode('INVALID_TELEGRAM_ID'));
    const actorId = store.upsertTelegramActor(123, '合成 TG 操作者');
    assert.deepEqual(store.groups(actorId), []); assert.equal(store.persona(actorId)?.platformAdmin, false);
    const registered = store.registerTelegramGroup({ chatId: -100123, title: '合成 TG 群', userId: 123 });
    assert.deepEqual(registered, { groupId: 'tg:-100123', actorId, created: true });
    assert.equal(store.group(registered.groupId, actorId), undefined);
    assert.equal(store.registerTelegramGroup({ chatId: -100123, title: '另一个标题', userId: 123 }).created, false);
    store.syncTelegramMember(-100123, 123, 'admin'); store.syncTelegramMember(-100123, 456, 'member', '成员');
    assert.equal(store.group(registered.groupId, actorId)?.role, 'admin');
    assert.equal(store.group(registered.groupId, actorId)?.memberCount, 2);
    assert.equal(store.group('group-a', actorId), undefined); assert.equal(store.group(registered.groupId, 'admin-a'), undefined);
    assert.deepEqual(store.groups('platform'), []);
    store.close(); store = new Store(dir);
    assert.equal(store.role(actorId, registered.groupId), 'admin');
    assert.equal(store.persona(actorId)?.platformAdmin, false);
    store.syncTelegramMember(-100123, 123, 'member'); assert.equal(store.role(actorId, registered.groupId), 'member');
    store.syncTelegramMember(-100123, 123, undefined); assert.equal(store.group(registered.groupId, actorId), undefined);
    assert.throws(() => store!.syncTelegramMember(-999, 123, 'admin'), errorCode('GROUP_UNREGISTERED'));
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('legacy preview schema migrates atomically and incompatible schemas are left untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-migration-'));
  const filename = join(dir, 'groupweave.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE groups(id TEXT PRIMARY KEY,version INTEGER NOT NULL,json TEXT NOT NULL);
    CREATE TABLE plugins(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE proposals(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,creator_id TEXT NOT NULL,json TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,creator_id TEXT NOT NULL,audience TEXT NOT NULL,
      request_key TEXT,request_hash TEXT NOT NULL,draft_json TEXT NOT NULL,result_json TEXT,UNIQUE(group_id,creator_id,request_key));`);
  const oldTask = task('legacy');
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(oldTask.id, oldTask.groupId, oldTask.creatorId, oldTask.audience, 'old-key', 'old-digest', JSON.stringify(oldTask), null);
  db.close(); let store: Store | undefined;
  try {
    store = new Store(dir); assert.equal(store.schemaVersion, STORAGE_SCHEMA_VERSION);
    assert.equal(store.reservation('group-a', 'admin-a', 'old-key')?.task?.status, 'blocked');
    assert.equal(store.reservation('group-a', 'admin-a', 'old-key')?.requestHash, 'old-digest');
    assert.equal(store.group('group-a', 'admin-a')?.version, 1); store.close(); store = undefined;
    const inspect = new DatabaseSync(filename); assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, STORAGE_SCHEMA_VERSION);
    inspect.exec('PRAGMA user_version=99'); inspect.close();
    assert.throws(() => new Store(dir), errorCode('SCHEMA_UNSUPPORTED'));
    const future = new DatabaseSync(filename); assert.equal((future.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99); future.close();
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }

  const malformedDir = mkdtempSync(join(tmpdir(), 'groupweave-malformed-'));
  const malformed = new DatabaseSync(join(malformedDir, 'groupweave.sqlite'));
  malformed.exec('CREATE TABLE groups(id TEXT PRIMARY KEY,json TEXT)'); malformed.close();
  try {
    assert.throws(() => new Store(malformedDir));
    const inspect = new DatabaseSync(join(malformedDir, 'groupweave.sqlite'));
    assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    assert.deepEqual((inspect.prepare('PRAGMA table_info(groups)').all() as { name: string }[]).map(row => row.name), ['id', 'json']); inspect.close();
  } finally { rmSync(malformedDir, { recursive: true, force: true }); }
});

test('bounded bodies retain digest tombstones and pending reservations; audit has independent group/global scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-retention-'));
  let store: Store | undefined;
  const retention = { tasksPerGroup: 2, proposalsPerGroup: 2, auditMax: 5, idempotencyMax: 4 };
  try {
    store = new Store(dir, { retention });
    complete(store, task('one')); complete(store, task('two')); complete(store, task('three'));
    const expired = store.reservation('group-a', 'admin-a', 'one')!;
    assert.equal(expired.expired, true); assert.equal(expired.pending, false); assert.equal(expired.task, undefined); assert.equal(expired.requestHash, 'digest-one');
    assert.deepEqual(store.tasks('group-a', 'admin-a').map(task => task.id), ['three', 'two']);
    store.reserveTask(task('pending'), 'pending', 'digest-pending'); store.prune(); assert.equal(store.task('pending')?.pending, true);
    assert.throws(() => store!.reserveTask(task('new'), 'new', 'digest-new'), errorCode('IDEMPOTENCY_CAPACITY'));
    assert.equal(store.task('new'), undefined);
    for (const id of ['p-one', 'p-two', 'p-three']) store.putProposal(proposal(store, id));
    assert.equal(store.proposal('p-one'), undefined); assert.ok(store.proposal('p-two')); assert.ok(store.proposal('p-three'));
    store.audit({ actorId: 'admin-a', groupId: 'group-a', action: 'rules.preview', targetId: 'p-three', outcome: 'pending' });
    store.audit({ actorId: 'platform', action: 'maintenance.prune', outcome: 'completed' });
    assert.equal(store.auditRecords({ actorId: 'member', groupId: 'group-a' }).length, 0);
    assert.equal(store.auditRecords({ actorId: 'platform', groupId: 'group-a', platformAdmin: true }).length, 0);
    assert.equal(store.auditRecords({ actorId: 'admin-a' }).length, 0);
    assert.equal(store.auditRecords({ actorId: 'platform' }).length, 1);
    assert.equal(store.auditRecords({ actorId: 'admin-a', groupId: 'group-a' }).length, 1);
    assert.throws(() => store!.audit({ actorId: 'admin-a', action: 'RAW secret/input', outcome: 'completed' }), errorCode('INVALID_AUDIT'));
    for (let index = 0; index < 12; index++) store.audit({ actorId: 'platform', action: 'maintenance.prune', outcome: 'completed' });
    assert.equal(store.auditRecords({ actorId: 'platform' }).length, 5);
    store.close(); store = new Store(dir, { retention });
    assert.equal(store.reservation('group-a', 'admin-a', 'one')?.expired, true);
    assert.equal(store.reservation('group-a', 'admin-a', 'pending')?.pending, false);
    store.close(); store = undefined;
    const db = new DatabaseSync(join(dir, 'groupweave.sqlite'));
    const tombstone = db.prepare('SELECT draft_json,result_json,request_hash FROM tasks WHERE id=?').get('one') as Record<string, unknown>;
    assert.deepEqual({ ...tombstone }, { draft_json: '{}', result_json: null, request_hash: 'digest-one' });
    const auditJSON = JSON.stringify(db.prepare('SELECT * FROM audit_log').all()); assert.doesNotMatch(auditJSON, /synthetic-input|synthetic-output|secret\/input/); db.close();
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('trusted Telegram migration changes every scope, rejects merge and prevents a late old-scope finish', () => {
  const store = new Store();
  try {
    const { groupId, actorId } = store.registerTelegramGroup({ chatId: -100, title: '旧群', userId: 11 }); store.syncTelegramMember(-100, 11, 'admin');
    store.putProposal(proposal(store, 'migration-proposal', groupId, actorId));
    const completed = complete(store, task('sent-task', groupId, actorId, 'group'));
    assert.equal(store.claimTelegramDelivery(completed.id, groupId, actorId), true);
    const pending = task('migration-pending', groupId, actorId, 'group'); store.reserveTask(pending, 'pending-key', 'pending-digest');
    store.migrateTelegramGroup(-100, -200);
    assert.equal(store.group(groupId, actorId), undefined); assert.equal(store.group('tg:-200', actorId)?.role, 'admin');
    assert.equal(store.proposal('migration-proposal')?.groupId, 'tg:-200');
    assert.equal(store.task(completed.id)?.task?.groupId, 'tg:-200');
    assert.equal(store.reservation('tg:-200', actorId, 'pending-key')?.task?.status, 'blocked');
    assert.equal(store.reservation(groupId, actorId, 'pending-key'), undefined);
    assert.equal(store.finishTask({ ...pending, status: 'succeeded', output: 'late-output' }), false);
    assert.equal(store.task(pending.id)?.task?.groupId, 'tg:-200'); assert.equal(store.task(pending.id)?.task?.output, '');
    assert.equal(store.claimTelegramDelivery(completed.id, 'tg:-200', actorId), false);
    assert.throws(() => store.recordTelegramDelivery(completed.id, groupId, actorId, 'sent'), errorCode('DELIVERY_SCOPE'));
    store.registerTelegramGroup({ chatId: -300, title: '已存在', userId: 11 });
    assert.throws(() => store.migrateTelegramGroup(-200, -300), errorCode('MIGRATION_CONFLICT'));
    assert.ok(store.group('tg:-200', actorId)); assert.equal(store.task(pending.id)?.task?.groupId, 'tg:-200');
    assert.ok(store.auditRecords({ actorId, groupId: 'tg:-200' }).every(record => record.groupId === 'tg:-200'));
  } finally { store.close(); }
});

test('persistent Telegram delivery claims validate actual task and never reopen sent or unknown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-delivery-')); let store: Store | undefined;
  try {
    store = new Store(dir, { retention: { tasksPerGroup: 1, deliveryMax: 2 } });
    const { groupId, actorId } = store.registerTelegramGroup({ chatId: -1000, title: '合成群', userId: 99 }); store.syncTelegramMember(-1000, 99, 'admin');
    const first = complete(store, task('delivery-first', groupId, actorId, 'group'));
    assert.equal(store.claimTelegramDelivery(first.id, groupId, 'tg-user:98'), false); assert.equal(store.claimTelegramDelivery(first.id, 'tg:-1001', actorId), false);
    assert.equal(store.claimTelegramDelivery(first.id, groupId, actorId), true); assert.equal(store.claimTelegramDelivery(first.id, groupId, actorId), false);
    complete(store, task('private', groupId, actorId)); assert.equal(store.claimTelegramDelivery('private', groupId, actorId), false);
    assert.equal(store.task(first.id)?.expired, true);
    store.recordTelegramDelivery(first.id, groupId, actorId, 'sent'); assert.equal(store.claimTelegramDelivery(first.id, groupId, actorId), false);
    assert.throws(() => store!.recordTelegramDelivery(first.id, groupId, actorId, 'unknown'), errorCode('DELIVERY_FINAL'));
    const second = complete(store, task('delivery-second', groupId, actorId, 'group')); assert.equal(store.claimTelegramDelivery(second.id, groupId, actorId), true);
    store.close(); store = new Store(dir);
    assert.equal(store.claimTelegramDelivery(second.id, groupId, actorId), false); store.recordTelegramDelivery(second.id, groupId, actorId, 'unknown');
    assert.throws(() => store!.recordTelegramDelivery(second.id, groupId, actorId, 'sent'), errorCode('DELIVERY_FINAL'));
    assert.equal(store.finishTask({ ...second, output: 'overwritten' }), false);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('native SQLite backup is verified and offline transactional restore respects active ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groupweave-backup-')); let source: Store | undefined; let restored: Store | undefined;
  try {
    const sourceDir = join(root, 'source'), targetDir = join(root, 'target'), path = join(sourceDir, 'backups', 'snapshot.sqlite');
    source = new Store(sourceDir);
    const { groupId, actorId } = source.registerTelegramGroup({ chatId: -12345, title: '备份合成群', userId: 555 }); source.syncTelegramMember(-12345, 555, 'admin');
    const config = proposal(source, 'backup-config', groupId, actorId); source.putProposal(config); source.activateProposal(config.id, actorId);
    const sent = complete(source, task('backup-sent', groupId, actorId, 'group')); source.claimTelegramDelivery(sent.id, groupId, actorId); source.recordTelegramDelivery(sent.id, groupId, actorId, 'sent');
    const claimed = complete(source, task('backup-claimed', groupId, actorId, 'group')); source.claimTelegramDelivery(claimed.id, groupId, actorId);
    source.reserveTask(task('backup-pending', groupId, actorId), 'pending', 'pending-hash');
    const report = await source.backupTo(path);
    assert.equal(report.integrity, 'ok'); assert.equal(report.schemaVersion, STORAGE_SCHEMA_VERSION); assert.ok(report.pages > 0); assert.match(report.sha256, /^[0-9a-f]{64}$/); assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(source.task('backup-pending')?.pending, true);
    const before = readFileSync(path); assert.throws(() => source!.backupTo(path), errorCode('BACKUP_EXISTS')); assert.deepEqual(readFileSync(path), before);
    const restoredReport = await Store.restoreBackup(path, targetDir); assert.equal(restoredReport.integrity, 'ok'); assert.equal(restoredReport.path, join(targetDir, 'groupweave.sqlite'));
    restored = new Store(targetDir); assert.equal(restored.group(groupId, actorId)?.version, 2); assert.equal(restored.group(groupId, actorId)?.config.maxItems, 5);
    assert.equal(restored.task('backup-pending')?.task?.status, 'blocked'); assert.equal(restored.reservation(groupId, actorId, 'pending')?.requestHash, 'pending-hash');
    assert.equal(restored.claimTelegramDelivery(sent.id, groupId, actorId), false); assert.equal(restored.claimTelegramDelivery(claimed.id, groupId, actorId), false);
    restored.recordTelegramDelivery(claimed.id, groupId, actorId, 'unknown');
    restored.reserveTask(task('active-owner-pending', groupId, actorId), 'active-owner', 'active-hash');
    await assert.rejects(Store.restoreBackup(path, targetDir), (error: unknown) => error instanceof Error && 'errcode' in error && error.errcode === 5);
    assert.equal(restored.reservation(groupId, actorId, 'active-owner')?.pending, true);
    const invalid = join(root, 'invalid.sqlite'); writeFileSync(invalid, 'not a database');
    await assert.rejects(Store.restoreBackup(invalid, targetDir)); assert.equal(restored.reservation(groupId, actorId, 'active-owner')?.pending, true);
    const future = join(root, 'future.sqlite'); const futureDb = new DatabaseSync(future); futureDb.exec('PRAGMA user_version=99'); futureDb.close();
    await assert.rejects(Store.restoreBackup(future, targetDir), errorCode('BACKUP_SCHEMA'));
    const inconsistent = join(root, 'inconsistent.sqlite'); copyFileSync(path, inconsistent);
    const inconsistentDb = new DatabaseSync(inconsistent); inconsistentDb.exec("UPDATE groups SET json=json_set(json,'$.id','another-group') WHERE id='group-a'"); inconsistentDb.close();
    await assert.rejects(Store.restoreBackup(inconsistent, targetDir), errorCode('BACKUP_INVALID'));
    assert.equal(restored.reservation(groupId, actorId, 'active-owner')?.pending, true);
    assert.ok(readdirSync(targetDir).every(name => !name.startsWith('.restore-')));
  } finally { restored?.close(); source?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('backup count/byte quotas refuse growth without deleting snapshots and maintenance drains before close', async () => {
  const root = mkdtempSync(join(tmpdir(), 'groupweave-backup-quota-'));
  let store: Store | undefined;
  try {
    store = new Store(join(root, 'count'), { retention: { backupsMax: 1 } });
    const path = join(root, 'count', 'backups', 'one.sqlite');
    const operation = store.backupTo(path);
    assert.throws(() => store!.close(), errorCode('BACKUP_RUNNING'));
    await store.waitForMaintenance(); const first = await operation;
    assert.equal(first.integrity, 'ok'); const original = readFileSync(path);
    assert.throws(() => store!.backupTo(join(root, 'count', 'backups', 'two.sqlite')), errorCode('BACKUP_CAPACITY'));
    assert.deepEqual(readFileSync(path), original); assert.equal(existsSync(join(root, 'count', 'backups', 'two.sqlite')), false);
    assert.throws(() => store!.backupTo(join(root, 'elsewhere.sqlite')), errorCode('BACKUP_DESTINATION'));
    store.close(); store = new Store(join(root, 'bytes'), { retention: { backupBytesMax: 1 } });
    const tooLarge = join(root, 'bytes', 'backups', 'large.sqlite');
    assert.throws(() => store!.backupTo(tooLarge), errorCode('BACKUP_CAPACITY')); assert.equal(existsSync(tooLarge), false);
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('native max_page_count bounds database growth and a full reservation does not partly persist', () => {
  const store = new Store(undefined, { retention: { maxPages: 24 } });
  try {
    const oversized = { ...task('large-db-body'), input: 'x'.repeat(50_000) };
    assert.throws(() => store.reserveTask(oversized, 'large-key', 'large-hash'), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ERR_SQLITE_ERROR' && 'errcode' in error && error.errcode === 13);
    assert.equal(store.reservation('group-a', 'admin-a', 'large-key'), undefined);
    assert.equal(store.task(oversized.id), undefined);
    complete(store, task('still-usable')); assert.equal(store.task('still-usable')?.task?.status, 'succeeded');
  } finally { store.close(); }
});

test('trusted startup availability observation refreshes capability truth without enabling the plugin', () => {
  const store = new Store();
  try {
    assert.equal(store.plugin('digest')?.enabled, false); assert.equal(store.plugin('digest')?.available, false);
    const observed = store.setPluginAvailability('digest', true)!; assert.equal(observed.available, true); assert.equal(observed.enabled, false); assert.match(observed.description, /明确输入/);
    store.setPluginEnabled('digest', true); store.setPluginAvailability('digest', false);
    assert.equal(store.plugin('digest')?.enabled, true); assert.equal(store.plugin('digest')?.available, false);
    assert.equal(store.setPluginAvailability('not-an-installed-plugin', true), undefined);
  } finally { store.close(); }
});

test('only a zero-model empty-output fixed-task failure may claim one safe Telegram feedback', () => {
  const store = new Store();
  try {
    const { groupId, actorId } = store.registerTelegramGroup({ chatId: -909, title: '固定反馈测试群', userId: 90 }); store.syncTelegramMember(-909, 90, 'admin');
    const failed = task('failure-feedback', groupId, actorId, 'group'); store.reserveTask(failed, 'failure-key', 'failure-hash');
    store.finishTask({ ...failed, status: 'failed', error: 'synthetic raw detail that must never become the Telegram response' });
    assert.equal(store.claimTelegramDelivery(failed.id, groupId, actorId), true);
    store.recordTelegramDelivery(failed.id, groupId, actorId, 'unknown'); assert.equal(store.claimTelegramDelivery(failed.id, groupId, actorId), false);
    for (const [id, result] of [
      ['blocked-feedback', { status: 'blocked' }], ['model-feedback', { status: 'failed', modelCalls: 1 }],
      ['output-feedback', { status: 'failed', output: 'unsafe-partial' }], ['agent-feedback', { status: 'failed', featureId: 'digest' }],
    ] as const) {
      const draft = task(id, groupId, actorId, 'group'); store.reserveTask(draft, id, `hash-${id}`); store.finishTask({ ...draft, ...result }); assert.equal(store.claimTelegramDelivery(id, groupId, actorId), false);
    }
    const records = store.auditRecords({ actorId, groupId }); assert.doesNotMatch(JSON.stringify(records), /synthetic raw|unsafe-partial/);
  } finally { store.close(); }
});

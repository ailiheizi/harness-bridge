import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import type { CapabilityRequest } from '../src/shared.js';

type App = Awaited<ReturnType<typeof buildApp>>;
async function client(app: App, personaId = 'admin-a') {
  let response = await app.inject({ url: '/api/me' });
  let me = response.json(); let cookie = String(response.headers['set-cookie']).split(';')[0];
  const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': me.csrfToken });
  const change = async (id: string) => {
    response = await app.inject({ method: 'POST', url: '/api/demo/session', headers: headers(), payload: { personaId: id } });
    assert.equal(response.statusCode, 200); me = response.json(); cookie = String(response.headers['set-cookie']).split(';')[0];
  };
  if (personaId !== 'admin-a') await change(personaId);
  return {
    get: (url: string) => app.inject({ url, headers: headers() }),
    post: (url: string, payload: object) => app.inject({ method: 'POST', url, payload, headers: headers() }), change,
  };
}
const base = '/api/groups/group-a/capability-requests';
const input = { title: '活动报名', details: '管理员发起活动，成员报名后统计人数。' };

test('capability requests complete a scoped group/platform loop without grants and reject forged fields', async () => {
  const app = await buildApp({ preview: true });
  try {
    const a = await client(app), b = await client(app, 'admin-b'), member = await client(app, 'member'), platform = await client(app, 'platform');
    const before = app.groupweave.store.group('group-a', 'admin-a');
    const plugins = app.groupweave.store.plugins();
    const created = await a.post(base, input); assert.equal(created.statusCode, 200, created.body);
    const item = created.json<CapabilityRequest>();
    assert.equal(item.groupId, 'group-a'); assert.equal(item.creatorId, 'admin-a'); assert.equal(item.status, 'submitted'); assert.equal(item.version, 1);
    assert.equal((await b.get(base)).statusCode, 404);
    assert.equal((await member.get(base)).statusCode, 403);
    assert.equal((await member.post(base, input)).statusCode, 403);
    assert.equal((await a.get('/api/platform/capability-requests')).statusCode, 403);
    assert.equal((await platform.get('/api/groups/group-a')).statusCode, 404);
    for (const forged of [{ groupId: 'group-b' }, { creatorId: 'platform' }, { status: 'delivered' }, { role: 'admin' }]) assert.equal((await a.post(base, { ...input, ...forged })).statusCode, 400);
    assert.equal((await b.post(`/api/groups/group-b/capability-requests/${item.id}/cancel`, { baseVersion: 1 })).statusCode, 404);
    const review = await platform.post(`/api/platform/capability-requests/${item.id}`, { baseVersion: 1, status: 'reviewing', reply: '正在选择原生插件。' });
    assert.equal(review.statusCode, 200, review.body); assert.equal(review.json().version, 2);
    assert.equal((await a.get(base)).json().requests[0].reply, '正在选择原生插件。');
    const done = await platform.post(`/api/platform/capability-requests/${item.id}`, { baseVersion: 2, status: 'delivered', reply: '请按说明配置报名插件。' });
    assert.equal(done.statusCode, 200); assert.equal((await a.get(base)).json().requests[0].status, 'delivered');
    assert.equal((await a.post(`${base}/${item.id}/cancel`, { baseVersion: 3 })).statusCode, 409);
    assert.deepEqual(app.groupweave.store.group('group-a', 'admin-a'), before);
    assert.deepEqual(app.groupweave.store.plugins(), plugins);
    assert.deepEqual(app.groupweave.store.ownTasks('group-a', 'admin-a'), []);
    assert.equal((await platform.get('/api/platform/capability-requests?status=delivered')).json().requests.length, 1);
  } finally { await app.close(); }
});

test('duplicate pending requests, stale updates, validation and admission bounds are explicit', async () => {
  const app = await buildApp({ preview: true, rateLimitMax: 1000 });
  try {
    const a = await client(app), platform = await client(app, 'platform');
    const first = (await a.post(base, input)).json<CapabilityRequest>();
    assert.equal((await a.post(base, { title: ` ${input.title} `, details: input.details })).json().id, first.id);
    assert.equal((await platform.post(`/api/platform/capability-requests/${first.id}`, { baseVersion: 1, status: 'reviewing', reply: '' })).statusCode, 400);
    assert.equal((await platform.post(`/api/platform/capability-requests/${first.id}`, { baseVersion: 1, status: 'cancelled', reply: 'wrong role action' })).statusCode, 400);
    assert.equal((await a.post(`${base}/${first.id}/cancel`, { baseVersion: 0 })).statusCode, 400);
    assert.equal((await a.post(`${base}/${first.id}/cancel`, { baseVersion: 2 })).statusCode, 409);
    for (const bad of [{ title: ' ', details: 'use' }, { title: 'x'.repeat(121), details: 'use' }, { title: 'feature', details: 'x'.repeat(2001) }]) assert.equal((await a.post(base, bad)).statusCode, 400);
    for (const query of ['?status=unknown', '?offset=-1', '?offset=1.2', '?offset[]=0', '?limit=1000']) assert.equal((await a.get(base + query)).statusCode, 400);
    for (let i = 1; i < 20; i++) assert.equal((await a.post(base, { title: `功能${i}`, details: '用途' })).statusCode, 200);
    assert.equal((await a.post(base, { title: '第21项', details: '用途' })).statusCode, 429);
    assert.equal((await a.post(base, input)).json().id, first.id, 'retry returns original even when full');
    assert.equal((await a.post(`${base}/${first.id}/cancel`, { baseVersion: 1 })).statusCode, 200);
    assert.equal((await platform.post(`/api/platform/capability-requests/${first.id}`, { baseVersion: 1, status: 'delivered', reply: 'late' })).statusCode, 409);
    assert.equal((await a.post(base, { title: '第21项', details: '用途' })).statusCode, 200);
  } finally { await app.close(); }
});

test('current role refresh and session revocation while awaiting it prevent request writes', async () => {
  let refresh: () => Promise<void> = async () => {};
  const app = await buildApp({ preview: true, refreshRole: async () => refresh() });
  try {
    const a = await client(app);
    let release!: () => void; let entered!: () => void;
    const inRefresh = new Promise<void>(resolve => { entered = resolve; });
    refresh = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
    const pending = a.post(base, input); await inRefresh;
    await a.change('member'); release();
    assert.equal((await pending).statusCode, 401);
    refresh = async () => { throw Object.assign(new Error('current authority revoked'), { statusCode: 403 }); };
    await a.change('admin-a');
    assert.equal((await a.post(base, input)).statusCode, 403);
    refresh = async () => {};
    assert.equal((await a.get(base)).json().requests.length, 0);
  } finally { await app.close(); }
});

test('schema 4 upgrades preserve group data; requests survive migration, restart and native backup restore', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-capability-'));
  let store: Store | undefined;
  try {
    const data = join(root, 'data'); store = new Store(data);
    const identity = store.registerTelegramGroup({ chatId: -4321, userId: 77, title: '受控群' });
    store.syncTelegramMember(-4321, 77, 'admin');
    const before = store.group(identity.groupId, identity.actorId); store.close(); store = undefined;
    const legacy = new DatabaseSync(join(data, 'groupweave.sqlite'));
    legacy.exec('DROP TABLE IF EXISTS capability_requests; PRAGMA user_version=4'); legacy.close();
    store = new Store(data); assert.equal(store.schemaVersion, 5);
    assert.deepEqual(store.group(identity.groupId, identity.actorId), before);
    const request = store.createCapabilityRequest({ groupId: identity.groupId, creatorId: identity.actorId, ...input });
    store.migrateTelegramGroup(-4321, -1004321);
    const moved = store.listCapabilityRequests({ groupId: 'tg:-1004321' }).requests;
    assert.equal(moved.length, 1); assert.equal(moved[0].groupId, 'tg:-1004321'); assert.equal(moved[0].id, request.id);
    assert.equal(store.listCapabilityRequests({ groupId: 'tg:-4321' }).requests.length, 0);
    store.close(); store = new Store(data);
    assert.deepEqual(store.listCapabilityRequests({ groupId: 'tg:-1004321' }).requests, moved);
    const backup = await store.backupTo(join(data, 'backups', 'requests.sqlite')); assert.equal(backup.schemaVersion, 5);
    store.close(); store = undefined;
    await Store.restoreBackup(backup.path, join(root, 'restored'));
    store = new Store(join(root, 'restored'));
    assert.deepEqual(store.listCapabilityRequests({ groupId: 'tg:-1004321' }).requests, moved);
    assert.equal(store.group('tg:-1004321', identity.actorId)?.name, '受控群');
  } finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
});

test('terminal retention preserves active requests and list pagination does not silently truncate', () => {
  const store = new Store();
  try {
    const pending = store.createCapabilityRequest({ groupId: 'group-a', creatorId: 'admin-a', ...input });
    for (let i = 0; i < 55; i++) {
      const item = store.createCapabilityRequest({ groupId: 'group-a', creatorId: 'admin-a', title: `需求${i}`, details: '明确用途' });
      store.reviewCapabilityRequest(item.id, { baseVersion: 1, status: 'declined', reply: '暂无对应能力' });
    }
    const first = store.listCapabilityRequests({ groupId: 'group-a' });
    assert.equal(first.requests.length, 50); assert.equal(first.nextOffset, 50);
    const second = store.listCapabilityRequests({ groupId: 'group-a', offset: 50 });
    assert.equal(second.requests.length, 1); assert.equal(second.requests[0].id, pending.id); assert.equal(second.nextOffset, null);
    assert.equal(store.listCapabilityRequests({ status: 'declined' }).requests.length, 50);
  } finally { store.close(); }
});

test('NUL input is rejected before persistence so backups and subsequent startup remain readable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'groupweave-capability-nul-'));
  const app = await buildApp({ preview: true, dataDir: dir });
  let closed = false;
  try {
    const a = await client(app), platform = await client(app, 'platform');
    for (const value of [{ ...input, title: '\u0000request' }, { ...input, details: '\u0000details' }]) {
      assert.equal((await a.post(base, value)).statusCode, 400, 'NUL must never reach the persisted business record');
    }
    const valid = (await a.post(base, input)).json<CapabilityRequest>();
    assert.equal((await platform.post(`/api/platform/capability-requests/${valid.id}`, { baseVersion: 1, status: 'reviewing', reply: '\u0000reply' })).statusCode, 400);
    assert.equal((await platform.post('/api/platform/maintenance/backup', {})).statusCode, 200);
    await app.close(); closed = true;
    const reopened = new Store(dir);
    try { assert.equal(reopened.listCapabilityRequests({ groupId: 'group-a' }).requests[0].id, valid.id); }
    finally { reopened.close(); }
  } finally { if (!closed) await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

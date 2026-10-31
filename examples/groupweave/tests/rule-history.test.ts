import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from '@tma.js/init-data-node';
import { buildApp } from '../src/server/app.js';

test('Web rules history is current-admin, owner and group scoped, survives restart, and reuses reviewed rollback', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gw-rule-history-'));
  const token = 'rules-history-offline-fixture';
  const headers = { host: 'history.example.test', origin: 'https://history.example.test' };
  let app: Awaited<ReturnType<typeof buildApp>>;
  const roles = new Map<string, 'admin' | 'member'>([['-701/101', 'admin'], ['-701/102', 'admin'], ['-701/103', 'member'], ['-702/201', 'admin']]);
  const start = async () => buildApp({ dataDir, botToken: token, publicOrigin: headers.origin,
    refreshRole: async (actor, group) => { app.groupweave.store.syncTelegramMember(group.slice(3), actor.slice(8), roles.get(`${group.slice(3)}/${actor.slice(8)}`)); },
  });
  const login = async (id: number) => {
    const login = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers,
      payload: { initData: sign({ user: { id, first_name: 'Synthetic history owner' } }, token, new Date()) } });
    assert.equal(login.statusCode, 200, login.body);
    const authenticated = { ...headers, cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    return {
      get: (url: string) => app.inject({ url, headers: authenticated }),
      post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers: authenticated, payload }),
    };
  };
  app = await start();
  try {
    for (const [chatId, userId] of [[-701, 101], [-702, 201]]) app.groupweave.store.registerTelegramGroup({ chatId, userId, title: 'Synthetic history group' });
    const a = await login(101), coadmin = await login(102), b = await login(201), member = await login(103);
    const first = await a.post('/api/groups/tg:-701/proposals', { baseVersion: 1, config: { maxItems: 7 } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal((await a.post(`/api/proposals/${first.json().id}/activate`, {})).statusCode, 200);
    const other = await coadmin.post('/api/groups/tg:-701/proposals', { baseVersion: 2, config: { language: 'en' } });
    assert.equal(other.statusCode, 200);
    const history = await a.get('/api/groups/tg:-701/proposals?actorId=tg-user:102');
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(history.json().proposals.map((p: { id: string }) => p.id), [first.json().id]);
    assert.equal(history.json().proposals[0].status, 'active');
    assert.deepEqual((await coadmin.get('/api/groups/tg:-701/proposals')).json().proposals.map((p: { id: string }) => p.id), [other.json().id]);
    assert.equal((await member.get('/api/groups/tg:-701/proposals')).statusCode, 403);
    assert.equal((await b.get('/api/groups/tg:-701/proposals')).statusCode, 404);
    await app.close(); app = await start();
    const resumed = await login(101);
    const persisted = await resumed.get('/api/groups/tg:-701/proposals');
    assert.equal(persisted.statusCode, 200, persisted.body);
    assert.equal(persisted.json().proposals[0].id, first.json().id);
    const rollback = await resumed.post(`/api/proposals/${persisted.json().proposals[0].id}/rollback`, {});
    assert.equal(rollback.statusCode, 200, rollback.body);
    assert.equal(rollback.json().status, 'pending');
    assert.equal(app.groupweave.store.group('tg:-701', 'tg-user:101')!.config.maxItems, 7);
    assert.equal((await resumed.post(`/api/proposals/${rollback.json().id}/activate`, {})).statusCode, 200);
    assert.equal(app.groupweave.store.group('tg:-701', 'tg-user:101')!.config.maxItems, 20);
    roles.set('-701/101', 'member');
    assert.equal((await resumed.get('/api/groups/tg:-701/proposals')).statusCode, 403);
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

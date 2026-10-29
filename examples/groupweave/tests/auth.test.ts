import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sign } from '@tma.js/init-data-node';
import { buildApp } from '../src/server/app.js';
import type { Me } from '../src/shared.js';
const token = 'synthetic-offline-token';
const origin = 'https://bot.example.test';
const headers = { host: 'bot.example.test', origin };
type Identity = Me & { csrfToken: string };
function signed(id = 123, date = new Date(), secret = token) {
  return sign({ user: { id, first_name: 'Synthetic', last_name: 'User' }, query_id: 'offline' }, secret, date);
}
async function login(app: Awaited<ReturnType<typeof buildApp>>, id = 123) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers, payload: { initData: signed(id) } });
  assert.equal(res.statusCode, 200, res.body);
  const me = res.json<Identity>();
  const cookie = String(res.headers['set-cookie']).split(';')[0];
  return { me, cookie, headers: { ...headers, cookie, 'x-csrf-token': me.csrfToken } };
}

test('signed Telegram login creates identity only; platform allowlist does not grant a group', async () => {
  const app = await buildApp({ botToken: token, publicOrigin: origin, platformAdminIds: ['123'] });
  try {
    assert.equal((await app.inject({ url: '/api/me', headers })).statusCode, 401);
    const c = await login(app);
    assert.equal(c.me.preview, false); assert.equal(c.me.persona.id, 'tg-user:123');
    assert.equal(c.me.persona.platformAdmin, true); assert.deepEqual(c.me.personas, []);
    const res = await app.inject({ url: '/api/groups', headers: c.headers });
    assert.deepEqual(res.json().groups, []);
    assert.equal((await app.inject({ url: '/api/groups/group-a', headers: c.headers })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/platform/plugins', headers: c.headers })).statusCode, 200);
    const member = await login(app, 124);
    assert.equal((await app.inject({ url: '/api/platform/plugins', headers: member.headers })).statusCode, 403);
    const response = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers, payload: { initData: signed() } });
    assert.match(String(response.headers['set-cookie']), /Secure/);
    assert.match(String(response.headers['set-cookie']), /HttpOnly/);
    assert.match(String(response.headers['set-cookie']), /SameSite=Strict/);
  } finally { await app.close(); }
});

test('signature, freshness, duplicate fields and identity are validated before trusting Telegram data', async () => {
  const app = await buildApp({ botToken: token, publicOrigin: origin });
  try {
    const samples = [
      signed().replace('Synthetic', 'Forged'), signed(123, new Date(Date.now() - 301_000)),
      signed(123, new Date(Date.now() + 60_000)), signed(123, new Date(), 'wrong-token'),
      `${signed()}&user=%7B%22id%22%3A999%7D`, signed(-1),
      sign({ query_id: 'offline' }, token, new Date()),
    ];
    for (const initData of samples) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers, payload: { initData } });
      assert.equal(res.statusCode, 401, res.body); assert.equal(res.headers['set-cookie'], undefined);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/telegram', headers, payload: { initData: signed(), role: 'admin' } })).statusCode, 400);
  } finally { await app.close(); }
});

test('public entrypoint rejects other Host/Origin; session rotation, CSRF and logout revoke old cookies', async () => {
  const app = await buildApp({ botToken: token, publicOrigin: origin });
  try {
    assert.equal((await app.inject({ url: '/api/health', headers: { host: 'evil.test', 'x-forwarded-host': headers.host } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { ...headers, origin: 'https://evil.test' }, payload: { initData: signed() } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: { host: headers.host }, payload: { initData: signed() } })).statusCode, 403);
    const old = await login(app);
    assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: { ...old.headers, 'x-csrf-token': '' }, payload: {} })).statusCode, 403);
    const rotated = await app.inject({ method: 'POST', url: '/api/auth/telegram', headers: old.headers, payload: { initData: signed() } });
    assert.equal(rotated.statusCode, 200);
    assert.equal((await app.inject({ url: '/api/me', headers: old.headers })).statusCode, 401);
    const current = { ...headers, cookie: String(rotated.headers['set-cookie']).split(';')[0], 'x-csrf-token': rotated.json().csrfToken };
    assert.equal((await app.inject({ url: '/api/me', headers: { ...current, cookie: `${current.cookie}; ${current.cookie}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: current, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/me', headers: current })).statusCode, 401);
  } finally { await app.close(); }
});

test('live operations recheck authority and remove revoked observations; demo and live namespaces stay apart', async () => {
  let role: 'admin' | 'member' | undefined = 'admin'; let checks = 0;
  let app: Awaited<ReturnType<typeof buildApp>>;
  app = await buildApp({ botToken: token, publicOrigin: origin,
    refreshRole: async (actor, group) => { checks++; app.groupweave.store.syncTelegramMember(group.slice(3), actor.slice(8), role); },
  });
  try {
    app.groupweave.store.registerTelegramGroup({ chatId: '-100123', title: 'Live', userId: 123 });
    app.groupweave.store.syncTelegramMember('-100123', 123, 'admin');
    const c = await login(app);
    assert.equal((await app.inject({ url: '/api/groups/tg:-100123', headers: c.headers })).statusCode, 200);
    role = 'member';
    assert.equal((await app.inject({ method: 'POST', url: '/api/groups/tg:-100123/proposals', headers: c.headers, payload: { text: '英文', baseVersion: 1 } })).statusCode, 403);
    role = undefined;
    assert.equal((await app.inject({ url: '/api/groups/tg:-100123', headers: c.headers })).statusCode, 404);
    assert.deepEqual(app.groupweave.store.groups('tg-user:123'), []);
    assert.ok(checks >= 3);
  } finally { await app.close(); }
});

test('missing live authority adapter, preview login and framework rate limits fail closed', async () => {
  const live = await buildApp({ botToken: token, publicOrigin: origin });
  try {
    live.groupweave.store.registerTelegramGroup({ chatId: '-100123', title: 'Live', userId: 123 });
    live.groupweave.store.syncTelegramMember('-100123', 123, 'admin');
    const c = await login(live);
    assert.equal((await live.inject({ url: '/api/groups/tg:-100123', headers: c.headers })).statusCode, 503);
  } finally { await live.close(); }
  const preview = await buildApp({ preview: true, botToken: token });
  try { assert.equal((await preview.inject({ method: 'POST', url: '/api/auth/telegram', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { initData: signed() } })).statusCode, 404); }
  finally { await preview.close(); }
  const bounded = await buildApp({ preview: true, rateLimitMax: 2 });
  try {
    assert.equal((await bounded.inject({ url: '/api/health' })).statusCode, 200);
    assert.equal((await bounded.inject({ url: '/api/health' })).statusCode, 200);
    const res = await bounded.inject({ url: '/api/health' });
    assert.equal(res.statusCode, 429); assert.equal(res.json().code, 'RATE_LIMITED');
  } finally { await bounded.close(); }
});

test('demo login cannot select a persistent live Telegram identity', async () => {
  const app = await buildApp({ preview: true });
  try {
    app.groupweave.store.upsertTelegramActor(123, 'Synthetic live identity');
    const res = await app.inject({ url: '/api/me' });
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    const switchResult = await app.inject({ method: 'POST', url: '/api/demo/session', headers: { host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': res.json().csrfToken }, payload: { personaId: 'tg-user:123' } });
    assert.equal(switchResult.statusCode, 400); assert.equal(switchResult.headers['set-cookie'], undefined);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie } })).json().persona.id, 'admin-a');
  } finally { await app.close(); }
});

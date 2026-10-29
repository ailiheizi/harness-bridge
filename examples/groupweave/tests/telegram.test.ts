import assert from 'node:assert/strict';
import test from 'node:test';
import { Bot } from 'grammy';
import { createTelegramAdapter, type TelegramBinding } from '../src/server/telegram.js';

const unusedBinding: TelegramBinding = {
  async getGroup() { throw new Error('An offline adapter must not read tenants.'); },
  async registerGroup() { throw new Error('An offline adapter must not register tenants.'); },
  async previewRules() { throw new Error('An offline adapter must not preview rules.'); },
  async getProposal() { throw new Error('An offline adapter must not read proposals.'); },
  async activateRules() { throw new Error('An offline adapter must not activate rules.'); },
  async migrateGroup() { throw new Error('An offline adapter must not migrate tenants.'); },
  async claimDelivery() { throw new Error('An offline adapter must not claim delivery.'); },
  async recordDelivery() { throw new Error('An offline adapter must not record delivery.'); },
  async executeLinks() { throw new Error('An offline adapter must not execute business tasks.'); },
};

test('missing token stays offline even with admins and a binding', async (t) => {
  const init = t.mock.method(Bot.prototype, 'init', async () => { throw new Error('Unexpected API initialization.'); });
  const start = t.mock.method(Bot.prototype, 'start', async () => { throw new Error('Unexpected polling.'); });
  const adapter = createTelegramAdapter({ adminIds: ['123'], binding: unusedBinding });
  assert.equal(adapter.connected, false);
  assert.equal(await adapter.init(), false);
  await adapter.launch();
  await adapter.stop();
  assert.deepEqual(adapter.status, {
    mode: 'offline', connected: false, polling: false, reason: 'TELEGRAM_TOKEN_MISSING',
  });
  assert.equal(init.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
});

test('token without valid platform admins cannot initialize or poll', async (t) => {
  const init = t.mock.method(Bot.prototype, 'init', async () => { throw new Error('Unexpected API initialization.'); });
  const start = t.mock.method(Bot.prototype, 'start', async () => { throw new Error('Unexpected polling.'); });
  for (const adminIds of [undefined, [], ['0', '-1', 'not-an-id', '1.5']]) {
    const adapter = createTelegramAdapter({ token: 'not-a-real-token', adminIds, binding: unusedBinding });
    assert.equal(adapter.connected, false);
    assert.equal(await adapter.init(), false);
    await adapter.launch();
    assert.equal(adapter.status.reason, 'ADMIN_IDS_MISSING');
    assert.equal(adapter.status.polling, false);
  }
  assert.equal(init.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
});

test('token and admins without real tenant binding stay blocked', async (t) => {
  const init = t.mock.method(Bot.prototype, 'init', async () => { throw new Error('Unexpected API initialization.'); });
  const start = t.mock.method(Bot.prototype, 'start', async () => { throw new Error('Unexpected polling.'); });
  const adapter = createTelegramAdapter({ token: 'not-a-real-token', adminIds: [123] });
  assert.equal(await adapter.init(), false);
  await adapter.launch();
  assert.deepEqual(adapter.status, {
    mode: 'blocked', connected: false, polling: false, reason: 'LIVE_TENANT_BINDING_MISSING',
  });
  assert.equal(init.mock.callCount(), 0);
  assert.equal(start.mock.callCount(), 0);
});

test('complete options alone never claim connected or create polling', () => {
  const adapter = createTelegramAdapter({
    token: 'not-a-real-token', adminIds: [123], binding: unusedBinding,
  });
  assert.deepEqual(adapter.status, {
    mode: 'blocked', connected: false, polling: false, reason: 'NOT_INITIALIZED',
  });
});

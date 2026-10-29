import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { createTelegramAdapter, type TelegramBinding } from '../src/server/telegram.js';

// These are official grammY lifecycle/API-transformer simulations, never live polling.
const info = { id: 9000, is_bot: true, first_name: 'Lifecycle Bot', username: 'LifecycleBot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
const update: Update = { update_id: 10, message: { message_id: 110, date: 1,
  from: { id: 12, is_bot: false, first_name: 'Offline user' },
  chat: { id: -1001, type: 'supergroup', title: 'Offline group' },
  text: '/links https://synthetic.example/', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } };
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function forbidNetwork(t: TestContext) {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
}
function bindingFixture() {
  const entered = deferred(); const release = deferred(); const deliveries: string[] = [];
  const binding: TelegramBinding = {
    async getGroup() { return { version: 1, config: { responseMode: 'command', language: 'en', features: ['link-cleaner'], deduplicate: true, sort: true, maxItems: 10 } }; },
    async executeLinks(request) {
      entered.resolve(); await release.promise;
      return { id: 'offline-task', groupId: `tg:${request.actor.groupId}`, creatorId: `tg-user:${request.actor.userId}`,
        featureId: 'link-cleaner', status: 'succeeded', audience: 'group', configVersion: 1,
        createdAt: new Date().toISOString(), durationMs: 1, modelCalls: 0, input: request.input, output: 'Offline result' };
    },
    async claimDelivery() { return true; }, async recordDelivery(_actor, _id, status) { deliveries.push(status); },
    async registerGroup() { throw new Error('UNEXPECTED'); }, async previewRules() { throw new Error('UNEXPECTED'); },
    async getProposal() { throw new Error('UNEXPECTED'); }, async activateRules() { throw new Error('UNEXPECTED'); },
    async migrateGroup() { throw new Error('UNEXPECTED'); },
  };
  return { binding, entered, release, deliveries };
}
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('OFFLINE lifecycle: concurrent init is single-flight, stop aborts and waits for initialization, explicit re-init is fresh', async t => {
  forbidNetwork(t); const fixture = bindingFixture(); const entered = deferred(); let queries = 0; let aborted = false;
  const api: Transformer = async (_prev, method, _payload, signal) => {
    assert.equal(method, 'getMe'); queries++;
    if (queries === 1) {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { aborted = true; reject(new Error('OFFLINE INIT ABORTED')); };
        if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return { ok: true, result: info } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding: fixture.binding, rateLimit: false, apiTransformer: api });
  t.after(() => adapter.stop());
  const first = adapter.init(); const duplicate = adapter.init(); await entered.promise;
  assert.equal(queries, 1); const stopping = adapter.stop();
  assert.equal(await adapter.init(), false); assert.equal(adapter.connected, false);
  await stopping; assert.equal(await first, false); assert.equal(await duplicate, false); assert.equal(aborted, true);
  assert.equal(adapter.status.mode, 'stopped');
  assert.equal(await adapter.init(), true); assert.equal(queries, 2);
  await adapter.stop(); assert.equal(await adapter.init(), true); assert.equal(queries, 3);
});

test('OFFLINE lifecycle: delayed polling setup cannot restore connected/polling status after stop', async t => {
  forbidNetwork(t); const fixture = bindingFixture(); const entered = deferred(); const release = deferred();
  const api: Transformer = async (_prev, method) => {
    if (method === 'getMe') return { ok: true, result: info } as never;
    if (method === 'deleteWebhook') { entered.resolve(); await release.promise; return { ok: true, result: true } as never; }
    assert.equal(method, 'getUpdates'); return { ok: true, result: [] } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding: fixture.binding, rateLimit: false, apiTransformer: api });
  t.after(async () => { release.resolve(); await adapter.stop(); });
  const launching = adapter.launch(); await entered.promise;
  let stopped = false; const stopping = adapter.stop().then(() => { stopped = true; });
  await nextTurn(); assert.equal(stopped, false); assert.equal(adapter.connected, false); assert.equal(adapter.status.mode, 'stopped');
  release.resolve(); await stopping; await launching;
  assert.deepEqual(adapter.status, { connected: false, polling: false, mode: 'stopped', reason: 'POLLING_STOPPED' });
});

test('OFFLINE lifecycle: a membership response from the previous connection cannot authorize after re-init', async t => {
  forbidNetwork(t); const fixture = bindingFixture(); const entered = deferred(); const release = deferred();
  const api: Transformer = async (_prev, method, value) => {
    const payload = value as Record<string, unknown>; let result: unknown;
    if (method === 'getMe') result = info;
    else if (method === 'getChat') result = { id: -1001, type: 'supergroup', title: 'Offline group' };
    else {
      assert.equal(method, 'getChatMember');
      const id = Number(payload.user_id);
      if (id === 12) { entered.resolve(); await release.promise; }
      result = { user: { id, is_bot: id === info.id, first_name: 'Offline user' }, status: 'administrator' };
    }
    return { ok: true, result } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding: fixture.binding, rateLimit: false, apiTransformer: api });
  t.after(async () => { release.resolve(); await adapter.stop(); });
  assert.equal(await adapter.init(), true);
  const previous = adapter.verifyMember('-1001', '12'); await entered.promise;
  await adapter.stop(); assert.equal(await adapter.init(), true);
  release.resolve(); assert.equal(await previous, undefined);
});

async function middlewareLifecycle(t: TestContext, polling: boolean) {
  forbidNetwork(t); const fixture = bindingFixture(); let sends = 0; let polled = false;
  const api: Transformer = async (_prev, method, value) => {
    const payload = value as Record<string, unknown>; let result: unknown;
    if (method === 'getMe') result = info;
    else if (method === 'deleteWebhook') result = true;
    else if (method === 'getUpdates') {
      if (payload.limit === 1) result = []; // grammY's final offset confirmation.
      else { assert.equal(polled, false); polled = true; result = [update]; }
    } else if (method === 'getChat') result = { id: -1001, type: 'supergroup', title: 'Offline group' };
    else if (method === 'getChatMember') result = { user: { id: Number(payload.user_id), is_bot: payload.user_id === info.id, first_name: 'Offline user' }, status: payload.user_id === info.id ? 'administrator' : 'member' };
    else if (method === 'sendMessage') { sends++; throw new Error('A STOPPED ADAPTER MUST NOT SEND'); }
    else throw new Error(`UNEXPECTED OFFLINE METHOD ${method}`);
    return { ok: true, result } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding: fixture.binding, rateLimit: false, apiTransformer: api });
  t.after(async () => { fixture.release.resolve(); await adapter.stop(); });
  assert.equal(await adapter.init(), true);
  const processing = polling ? adapter.launch() : adapter.handleUpdate(update);
  await fixture.entered.promise;
  let stopped = false; const first = adapter.stop().then(() => { stopped = true; }); const second = adapter.stop();
  await nextTurn(); assert.equal(stopped, false); assert.equal(adapter.connected, false);
  assert.equal(await adapter.handleUpdate(update), false); // Shutdown admits no new messages.
  fixture.release.resolve(); await first; await second; await processing;
  assert.equal(stopped, true); assert.equal(sends, 0); assert.deepEqual(fixture.deliveries, ['withheld']);
  assert.equal(adapter.status.polling, false);
}
test('OFFLINE lifecycle: stop waits for the official polling middleware stack and withholds its late result', async t => middlewareLifecycle(t, true));
test('OFFLINE lifecycle: stop also waits for an explicit authenticated-update handler and is idempotent', async t => middlewareLifecycle(t, false));

test('OFFLINE lifecycle: runner stop aborts long polling, drains it, and leaves authority disconnected', async t => {
  forbidNetwork(t); const fixture = bindingFixture(); const entered = deferred(); const errors: string[] = [];
  const api: Transformer = async (_prev, method, value, signal) => {
    if (method === 'getMe') return { ok: true, result: info } as never;
    if (method === 'deleteWebhook') return { ok: true, result: true } as never;
    assert.equal(method, 'getUpdates');
    assert.ok((value as Record<string, unknown>).limit);
    entered.resolve();
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(new Error('OFFLINE POLLING ABORTED'));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
    throw new Error('UNREACHABLE');
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding: fixture.binding, rateLimit: false, apiTransformer: api, onError: code => errors.push(code) });
  t.after(() => adapter.stop());
  const launching = adapter.launch(); await entered.promise; await adapter.stop(); await launching;
  assert.equal(adapter.connected, false); assert.equal(adapter.status.polling, false); assert.equal(adapter.status.mode, 'stopped');
  assert.deepEqual(errors, []);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import type { GroupConfig } from '../src/shared.js';
import { createGroupActions } from '../src/server/actions.js';
import { Store } from '../src/server/store.js';
import { createTelegramAdapter, type TelegramBinding } from '../src/server/telegram.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';

const botInfo = { id: 9000, is_bot: true, first_name: 'Offline Bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
const config: GroupConfig = { responseMode: 'command', language: 'zh',
  features: ['link-cleaner', 'echo', 'digest', 'link-brief', 'antiad', 'assistant'],
  deduplicate: true, sort: true, maxItems: 10 };

function command(updateId: number, text: string, userId = 12): Update {
  const entity = /^\/[a-z]+(?:@[A-Za-z0-9_]+)?/i.exec(text)?.[0];
  return { update_id: updateId, message: { message_id: 100 + updateId, date: 1,
    chat: { id: -1001, type: 'supergroup', title: 'Offline acceptance group' },
    from: { id: userId, is_bot: false, first_name: 'Offline user' }, text,
    ...(entity ? { entities: [{ type: 'bot_command', offset: 0, length: entity.length }] } : {}) } } as Update;
}

async function makeAcceptanceSimulation(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  const methods: string[] = [];
  const sent: string[] = [];
  const members = new Map([[11, 'administrator'], [12, 'member']]);
  let executions = 0;
  const binding: TelegramBinding = {
    async getGroup() { return { version: 1, config: structuredClone(config) }; },
    async registerGroup() { throw new Error('UNEXPECTED REGISTRATION'); },
    async previewRules() { throw new Error('UNEXPECTED RULE PREVIEW'); },
    async getProposal() { return null; },
    async activateRules() { throw new Error('UNEXPECTED RULE ACTIVATION'); },
    async executeLinks() { executions++; throw new Error('UNEXPECTED LINK EXECUTION'); },
    // This binding deliberately lacks executeFeature: product features can be
    // enabled in stored config while this deployment has no Telegram runner.
    async migrateGroup() { throw new Error('UNEXPECTED MIGRATION'); },
    async claimDelivery() { throw new Error('UNEXPECTED DELIVERY CLAIM'); },
    async recordDelivery() { throw new Error('UNEXPECTED DELIVERY RECORD'); },
  };
  const api: Transformer = async (_previous, method, raw) => {
    methods.push(method);
    const payload = raw as Record<string, unknown>;
    let result: unknown;
    if (method === 'getMe') result = botInfo;
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline acceptance group' };
    else if (method === 'getChatMember') {
      const userId = Number(payload.user_id);
      result = { user: { id: userId, is_bot: userId === botInfo.id, first_name: 'Offline user' },
        status: userId === botInfo.id ? 'administrator' : members.get(userId) ?? 'left' };
    } else if (method === 'sendMessage') {
      sent.push(String(payload.text));
      result = { message_id: 1000 + sent.length, date: 1, from: botInfo,
        chat: { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline acceptance group' }, text: payload.text };
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`UNEXPECTED BOT API METHOD: ${method}`);
    return { ok: true, result } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding,
    rateLimit: false, apiTransformer: api });
  assert.equal(await adapter.init(), true);
  t.after(async () => { await adapter.stop(); assert.equal(network.mock.callCount(), 0); });
  return { adapter, sent, methods, get executions() { return executions; }, members };
}

test('OFFLINE acceptance: advertised Telegram commands require an available feature runner', async t => {
  const sim = await makeAcceptanceSimulation(t);
  await sim.adapter.handleUpdate(command(1, '/plugins'));
  const discovery = sim.sent.at(-1)!;
  assert.match(discovery, /\/links https:/); // code binding is present
  assert.match(discovery, /智能摘要：通过面板提交文本/); // digest exists, but only its panel route is available
  assert.doesNotMatch(discovery, /\/echo|\/digest|\/brief|\/ask|\/scan/);
  assert.doesNotMatch(discovery, /文字回显|链接说明|反广告判定|AI 助手/);

  const before = sim.sent.length;
  for (const [index, text] of ['/echo text', '/scan text', '/digest text', '/brief https://example.test/', '/ask text'].entries()) {
    await sim.adapter.handleUpdate(command(index + 2, text));
    assert.match(sim.sent.at(-1)!, /本群未启用此功能，或实际执行入口尚未配置/);
  }
  assert.equal(sim.sent.length, before + 5);
  assert.equal(sim.executions, 0);
  assert.equal(sim.methods.filter(method => method === 'sendMessage').length, 6);
});

test('OFFLINE acceptance: unknown commands never fall through to business execution', async t => {
  const sim = await makeAcceptanceSimulation(t);
  await sim.adapter.handleUpdate(command(1, '/not-a-groupweave-command https://example.test/'));
  assert.equal(sim.executions, 0);
  assert.equal(sim.sent.length, 0);
  assert.equal(sim.methods.includes('sendMessage'), false);
});

test('OFFLINE acceptance: same-version rule previews race by CAS, while an activated button cannot replay', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  const methods: { method: string; payload: Record<string, unknown> }[] = [];
  const roles = new Map([[11, 'administrator']]);
  const sent: { messageId: number; text: string; keyboard?: string }[] = [];
  const api: Transformer = async (_previous, method, raw) => {
    const payload = raw as Record<string, unknown>; methods.push({ method, payload });
    let result: unknown;
    if (method === 'getMe') result = botInfo;
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline CAS group' };
    else if (method === 'getChatMember') {
      const userId = Number(payload.user_id);
      result = { user: { id: userId, is_bot: userId === botInfo.id, first_name: 'Offline admin' },
        status: userId === botInfo.id ? 'administrator' : roles.get(userId) ?? 'left' };
    } else if (method === 'sendMessage') {
      const messageId = 1000 + sent.length;
      const markup = payload.reply_markup as { inline_keyboard?: { callback_data: string }[][] } | undefined;
      const keyboard = markup?.inline_keyboard?.[0]?.[0]?.callback_data;
      sent.push({ messageId, text: String(payload.text), ...(keyboard ? { keyboard } : {}) });
      result = { message_id: messageId, date: 1, from: botInfo,
        chat: { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline CAS group' }, text: payload.text,
        ...(markup ? { reply_markup: markup } : {}) };
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`UNEXPECTED BOT API METHOD: ${method}`);
    return { ok: true, result } as never;
  };

  const store = new Store();
  store.registerTelegramGroup({ chatId: '-1001', title: 'Offline CAS group', userId: '11' });
  store.syncTelegramMember('-1001', '11', 'admin');
  let adapter!: ReturnType<typeof createTelegramAdapter>;
  const actions = createGroupActions(store, { executor: async () => ({ output: '', modelCalls: 0 }),
    async refreshRole(actorId, groupId) {
      const role = await adapter.verifyMember(groupId.slice(3), actorId.slice('tg-user:'.length));
      store.syncTelegramMember(groupId.slice(3), actorId.slice('tg-user:'.length), role);
    } });
  const binding = createTelegramBinding(store, actions);
  adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding,
    rateLimit: false, apiTransformer: api });
  assert.equal(await adapter.init(), true);
  t.after(async () => {
    await adapter.stop(); actions.close(); store.close();
    assert.equal(network.mock.callCount(), 0);
  });

  await adapter.handleUpdate(command(1, '/rules English', 11));
  const firstButton = sent.at(-1)!.keyboard!;
  const firstId = firstButton.slice('gw:activate:'.length);
  await adapter.handleUpdate(command(2, '/rules 去重并排序', 11));
  const secondButton = sent.at(-1)!.keyboard!;
  const secondId = secondButton.slice('gw:activate:'.length);
  assert.notEqual(firstId, secondId);
  assert.equal(store.proposal(firstId)?.status, 'pending');
  assert.equal(store.proposal(secondId)?.status, 'pending');
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.version, 1);

  await adapter.handleUpdate({ update_id: 3, callback_query: { id: 'offline-3', chat_instance: 'offline',
    data: firstButton, from: { id: 11, is_bot: false, first_name: 'Offline admin' },
    message: { message_id: sent[0].messageId, date: 1, from: botInfo,
      chat: { id: -1001, type: 'supergroup', title: 'Offline CAS group' }, text: sent[0].text } } } as Update);
  assert.equal(store.proposal(firstId)?.status, 'active');
  assert.equal(store.proposal(secondId)?.status, 'pending');
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.version, 2);
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.config.language, 'en');
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.config.sort, false);

  const beforeStale = sent.length;
  await adapter.handleUpdate({ update_id: 4, callback_query: { id: 'offline-4', chat_instance: 'offline',
    data: secondButton, from: { id: 11, is_bot: false, first_name: 'Offline admin' },
    message: { message_id: sent[1].messageId, date: 1, from: botInfo,
      chat: { id: -1001, type: 'supergroup', title: 'Offline CAS group' }, text: sent[1].text } } } as Update);
  assert.equal(store.proposal(secondId)?.status, 'pending');
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.config.sort, false);
  assert.equal(sent.length, beforeStale); // stale baseVersion is reported through callback answer, not a false success message
  const staleAnswer = methods.filter(call => call.method === 'answerCallbackQuery').at(-1)!.payload.text;
  assert.match(String(staleAnswer), /operation failed or its result is unknown/i);

  const beforeReplay = sent.length;
  await adapter.handleUpdate({ update_id: 5, callback_query: { id: 'offline-5', chat_instance: 'offline',
    data: firstButton, from: { id: 11, is_bot: false, first_name: 'Offline admin' },
    message: { message_id: sent[0].messageId, date: 1, from: botInfo,
      chat: { id: -1001, type: 'supergroup', title: 'Offline CAS group' }, text: sent[0].text } } } as Update);
  assert.equal(store.proposal(firstId)?.status, 'active');
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.version, 2);
  assert.equal(sent.length, beforeReplay);
  const replayAnswer = methods.filter(call => call.method === 'answerCallbackQuery').at(-1)!.payload.text;
  assert.match(String(replayAnswer), /this button is unavailable/i);
});

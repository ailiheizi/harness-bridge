import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { GroupConfig } from '../src/shared.js';
import { buildApp } from '../src/server/app.js';
import type { Executor, ExecutorRequest } from '../src/server/actions.js';
import { createKoishiCodeHost } from '../src/server/koishi.js';
import { createNativeExecutor, type NativeRequest } from '../src/server/native.js';
import { createTelegramAdapter } from '../src/server/telegram.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';

// Real buildApp/SQLite/group actions/Koishi; Telegram and model output are offline fixtures.
const info = { id: 9000, is_bot: true, first_name: 'Offline bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
const group = (id: number) => ({ id, type: 'supergroup' as const, title: `Group ${id}` });
function message(id: number, text: string, user = 12, groupId = -1001, extra: Record<string, unknown> = {}): Update {
  const command = /^\/[a-z]+(?:@[A-Za-z0-9_]+)?/.exec(text)?.[0];
  return { update_id: id, message: { message_id: 100 + id, date: 1, from: { id: user, is_bot: false, first_name: 'Offline user' },
    chat: group(groupId), text, entities: command ? [{ type: 'bot_command', offset: 0, length: command.length }] : [], ...extra } } as Update;
}
function callback(id: number, confirmation: Message, user = 12, groupId = -1001): Update {
  const data = (confirmation.reply_markup!.inline_keyboard[0][0] as { callback_data: string }).callback_data;
  return { update_id: id, callback_query: { id: `offline-${id}`, chat_instance: 'offline', data, from: { id: user, is_bot: false, first_name: 'Offline user' },
    message: { ...confirmation, chat: group(groupId) } } } as Update;
}
async function integration(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('LIVE NETWORK FORBIDDEN'); });
  const models = t.mock.method(LlmRuntime.prototype, 'stream', () => { throw new Error('LIVE MODEL FORBIDDEN'); });
  const code = createKoishiCodeHost(); const native = createNativeExecutor(code);
  const echoCalls: NativeRequest[] = []; const welcomeCalls: NativeRequest[] = []; const aiCalls: ExecutorRequest[] = [];
  const roles = new Map<string, string>([['-1001/11', 'administrator'], ['-1001/12', 'member'], ['-1001/13', 'member'],
    ['-1002/11', 'administrator'], ['-1002/12', 'member']]);
  const messages = new Map<number, Message>(); const sent: Message[] = []; const apiCalls: string[] = []; const errors: string[] = [];
  let aiHandler: Executor | undefined; let afterEcho: (() => void) | undefined;
  let adapter!: ReturnType<typeof createTelegramAdapter>;
  const app = await buildApp({ preview: false, executor: native,
    echoExecutor: async (request, signal) => { echoCalls.push(request); const result = await code.executeEcho(request, signal); afterEcho?.(); return result; },
    welcomeExecutor: async (request, signal) => { welcomeCalls.push(request); return code.executeWelcome(request, signal); },
    aiExecutor: async (request, signal) => { aiCalls.push(request); return aiHandler ? aiHandler(request, signal) : { output: `OFFLINE-AI:${request.input}`, modelCalls: 1 }; },
    assistantExecutor: async (request, signal) => { aiCalls.push(request); return aiHandler ? aiHandler(request, signal) : { output: `OFFLINE-AI:${request.input}`, modelCalls: 1, toolCalls: 0 }; },
    async refreshRole(actorId, groupId) {
      const role = await adapter.verifyMember(groupId.slice(3), actorId.slice(8));
      app.groupweave.store.syncTelegramMember(groupId.slice(3), actorId.slice(8), role);
    },
    async beforeClose() { await native.dispose(); await code.dispose(); },
  });
  const api: Transformer = async (_prev, method, value) => {
    apiCalls.push(method); const payload = value as Record<string, unknown>; let result: unknown;
    if (method === 'getMe') result = info;
    else if (method === 'getChat') result = group(Number(payload.chat_id));
    else if (method === 'getChatMember') {
      const id = Number(payload.user_id); result = { user: { id, is_bot: id === info.id, first_name: 'Offline user' },
        status: id === info.id ? 'administrator' : roles.get(`${payload.chat_id}/${id}`) ?? 'left' };
    } else if (method === 'sendMessage') {
      const replied = (payload.reply_parameters as { message_id: number } | undefined)?.message_id;
      result = { message_id: 1000 + sent.length, date: 1, from: info, chat: group(Number(payload.chat_id)), text: payload.text,
        ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}), ...(replied ? { reply_to_message: messages.get(replied) } : {}) };
      sent.push(result as Message); messages.set((result as Message).message_id, result as Message);
    } else if (method === 'answerCallbackQuery' || method === 'setMyCommands') result = true;
    else throw new Error(`UNEXPECTED OFFLINE API ${method}`);
    return { ok: true, result } as never;
  };
  const binding = createTelegramBinding(app.groupweave.store, app.groupweave.actions);
  const create = () => createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding, apiTransformer: api,
    installCommands: true, rateLimit: false, onError: code => errors.push(code) });
  adapter = create(); assert.equal(await adapter.init(), true);
  const handle = async (update: Update) => { if (update.message) { messages.set(update.message.message_id, update.message);
    if (update.message.reply_to_message) messages.set(update.message.reply_to_message.message_id, update.message.reply_to_message); } return adapter.handleUpdate(update); };
  await handle(message(1, '/register', 11)); await handle(message(2, '/register', 11, -1002));
  const { store, actions } = app.groupweave;
  for (const id of ['welcome', 'digest', 'assistant']) store.setPluginEnabled(id, true);
  async function configure(groupId: string, patch: Partial<GroupConfig>) {
    const current = await actions.getGroup('tg-user:11', `tg:${groupId}`, true);
    const proposal = await actions.previewRules('tg-user:11', current.id, { baseVersion: current.version, config: patch });
    assert.deepEqual(proposal.warnings, []); await actions.activateRules('tg-user:11', proposal.id);
  }
  await configure('-1001', { features: ['link-cleaner', 'echo', 'welcome', 'digest', 'assistant'], welcomeText: 'A 欢迎 {name} 加入 {group}' });
  await configure('-1002', { features: ['echo', 'welcome'], welcomeText: 'B hello {name}' });
  t.after(async () => { actions.close(); await adapter.stop(); await app.close(); assert.equal(network.mock.callCount(), 0); assert.equal(models.mock.callCount(), 0); });
  return { app, actions, store, binding, handle, configure, roles, echoCalls, welcomeCalls, aiCalls, sent, errors, apiCalls,
    set aiHandler(value: Executor | undefined) { aiHandler = value; }, set afterEcho(value: (() => void) | undefined) { afterEcho = value; },
    async recreate() { await adapter.stop(); adapter = create(); assert.equal(await adapter.init(), true); } };
}

const business = (messages: Message[]) => messages.filter(value => value.text?.startsWith('OFFLINE-AI:'));
test('OFFLINE modules integration: Telegram → actual binding/actions/SQLite → official Echo, with replay protection after adapter restart', async t => {
  const sim = await integration(t); const baseline = sim.sent.length;
  const update = message(10, '/echo -c other-group ordinary text');
  await sim.handle(update); await sim.handle(update);
  assert.equal(sim.echoCalls.length, 1); assert.equal(sim.sent.length, baseline + 1);
  assert.equal(sim.sent.at(-1)!.text, '-c other-group ordinary text');
  assert.equal(sim.echoCalls[0].groupId, 'tg:-1001'); assert.equal(sim.echoCalls[0].actorId, 'tg-user:12');
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:10:110')!;
  assert.equal(row.task?.featureId, 'echo'); assert.equal(row.task?.modelCalls, 0); assert.equal(row.task?.status, 'succeeded');
  await sim.recreate(); await sim.handle(update); assert.equal(sim.echoCalls.length, 1); assert.equal(sim.sent.length, baseline + 1);
});

test('OFFLINE modules integration: two group welcome events use actual distinct Koishi templates, and disabled/replayed events do not run', async t => {
  const sim = await integration(t);
  const a = message(11, '', 12, -1001, { new_chat_members: [{ id: 42, is_bot: false, first_name: 'Alice' }] });
  const b = message(12, '', 12, -1002, { new_chat_members: [{ id: 43, is_bot: false, first_name: 'Bob' }] });
  await sim.handle(a); await sim.handle(b); await sim.handle(a);
  assert.equal(sim.welcomeCalls.length, 2);
  assert.deepEqual(sim.welcomeCalls.map(value => [value.groupId, value.options.welcomeText]), [['tg:-1001', 'A 欢迎 {name} 加入 {group}'], ['tg:-1002', 'B hello {name}']]);
  assert.ok(sim.sent.some(value => value.chat.id === -1001 && value.text === 'A 欢迎 Alice 加入 Group -1001'));
  assert.ok(sim.sent.some(value => value.chat.id === -1002 && value.text === 'B hello Bob'));
  await sim.configure('-1002', { features: ['echo'] });
  await sim.handle(message(13, '', 12, -1002, { new_chat_members: [{ id: 44, is_bot: false, first_name: 'Never sent' }] }));
  assert.equal(sim.welcomeCalls.length, 2);
});

test('OFFLINE modules integration: signed requester consent becomes real actions acknowledgment; other users/groups and a disabled group cannot call AI', async t => {
  const sim = await integration(t);
  await sim.handle(message(20, '/digest exact selected text')); const confirmation = sim.sent.at(-1)!;
  assert.equal(sim.aiCalls.length, 0);
  await sim.handle(callback(21, confirmation, 13)); await sim.handle(callback(22, confirmation, 12, -1002));
  assert.equal(sim.aiCalls.length, 0);
  await sim.handle(callback(23, confirmation)); await sim.handle(callback(24, confirmation));
  assert.equal(sim.aiCalls.length, 1); assert.equal(business(sim.sent).length, 1);
  assert.equal(sim.aiCalls[0].groupId, 'tg:-1001'); assert.equal(sim.aiCalls[0].input, 'exact selected text');
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:20:120')!;
  assert.equal(row.task?.status, 'succeeded'); assert.equal(row.task?.modelCalls, 1);
  await sim.handle(message(25, '/digest forbidden in B', 12, -1002)); assert.equal(sim.aiCalls.length, 1);
  await assert.rejects(sim.actions.runTask('tg-user:12', 'tg:-1001', { featureId: 'digest', input: 'missing explicit acknowledgment', audience: 'group' }), { code: 'EXTERNAL_PROCESSING_REVIEW_REQUIRED' });
});

test('OFFLINE modules integration: platform stop during post-claim membership check suppresses a native Echo result', async t => {
  const sim = await integration(t); const baseline = sim.sent.length;
  const claim = sim.binding.claimDelivery.bind(sim.binding);
  sim.binding.claimDelivery = async (...args) => { const value = await claim(...args); if (value) sim.store.setPluginEnabled('echo', false); return value; };
  await sim.handle(message(30, '/echo withheld'));
  assert.equal(sim.echoCalls.length, 1); assert.equal(sim.sent.length, baseline);
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:30:130')!;
  assert.equal(row.task?.status, 'succeeded');
  assert.ok(sim.store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' }).some(value => value.action === 'delivery.withheld'));
});

test('OFFLINE modules integration: /cancel uses real task controllers and only cancels the requester’s active task in this group', async t => {
  const sim = await integration(t); let entered!: () => void;
  const started = new Promise<void>(yes => { entered = yes; });
  sim.aiHandler = async (_request, signal) => { entered(); return new Promise((_, reject) => { const stop = () => reject(new Error('OFFLINE CANCELLED'));
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true }); }); };
  await sim.handle(message(40, '/ask ongoing')); const confirmation = sim.sent.at(-1)!;
  const running = sim.handle(callback(41, confirmation)); await started;
  const active = await sim.actions.ownActiveTasks('tg-user:12', 'tg:-1001'); assert.equal(active.length, 1);
  await sim.handle(message(42, '/cancel', 13)); assert.equal((await sim.actions.ownActiveTasks('tg-user:12', 'tg:-1001')).length, 1);
  await sim.handle(message(43, '/cancel', 12, -1002)); assert.equal((await sim.actions.ownActiveTasks('tg-user:12', 'tg:-1001')).length, 1);
  await sim.handle(message(44, '/cancel')); await running;
  assert.equal((await sim.actions.ownActiveTasks('tg-user:12', 'tg:-1001')).length, 0);
  assert.equal(business(sim.sent).length, 0); const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:40:140')!;
  assert.equal(row.task?.status, 'blocked'); assert.equal(row.task?.output, '');
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Message, Update } from 'grammy/types';
import type { GroupConfig, Task } from '../src/shared.js';
import { createTelegramConfirmations } from '../src/server/telegram/confirmation.js';
import { createTelegramAdapter, type TelegramBinding, type TelegramFeatureRequest } from '../src/server/telegram.js';

const botInfo = { id: 9000, is_bot: true, first_name: 'Offline Bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
const chat = (id: number) => id < 0 ? { id, type: 'supergroup', title: 'Offline group' } : { id, type: 'private' };
function message(updateId: number, text: string, userId = 12, groupId = -1001, extra: Record<string, unknown> = {}): Update {
  const command = /^\/[a-z]+(?:@[A-Za-z0-9_]+)?/.exec(text)?.[0];
  const mentions = [...text.matchAll(/@OfflineBot/gi)].filter(item => !command || item.index >= command.length)
    .map(item => ({ type: 'mention', offset: item.index, length: item[0].length }));
  return { update_id: updateId, message: { message_id: 100 + updateId, date: 1, chat: chat(groupId),
    from: { id: userId, is_bot: false, first_name: 'Offline user' }, text,
    entities: [...(command ? [{ type: 'bot_command', offset: 0, length: command.length }] : []), ...mentions], ...extra } } as Update;
}
function callback(updateId: number, data: string, confirmation: Message, userId = 12, extra: Record<string, unknown> = {}): Update {
  return { update_id: updateId, callback_query: { id: `offline-${updateId}`, chat_instance: 'offline', data,
    from: { id: userId, is_bot: false, first_name: 'Offline user' }, message: { ...confirmation, ...extra } } } as Update;
}
async function simulation(t: TestContext, options: { installCommands?: boolean; failMenu?: boolean } = {}) {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  const config: GroupConfig = { responseMode: 'command', language: 'zh', features: ['link-cleaner', 'echo', 'digest', 'link-brief', 'welcome', 'antiad', 'assistant'], deduplicate: true, sort: true, maxItems: 10 };
  const roles = new Map<number, string>([[12, 'member'], [13, 'member']]);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const sent: Message[] = []; const inputs = new Map<number, Message>(); const requests: TelegramFeatureRequest[] = [];
  const deliveries = new Map<string, string>(); const saved = new Map<string, Task>(); const errors: string[] = [];
  const cancellations: { groupId: string; userId: string }[] = [];
  let now = Date.now(); let executions = 0; let afterExecution: (() => void) | undefined;
  let executeWait: Promise<void> | undefined; let changeTask: ((task: Task) => Task) | undefined; let groupReads = 0;
  const binding: TelegramBinding = {
    async getGroup() { groupReads++; return { version: 1, config: structuredClone(config) }; },
    async executeFeature(request) {
      requests.push(request); const existing = saved.get(request.idempotencyKey); if (existing) return existing;
      executions++; if (executeWait) await executeWait;
      const ai = ['digest', 'link-brief', 'assistant'].includes(request.featureId);
      const task: Task = { id: `task-${executions}`, groupId: `tg:${request.actor.groupId}`, creatorId: `tg-user:${request.actor.userId}`,
        featureId: request.featureId, status: 'succeeded', audience: 'group', configVersion: 1, createdAt: new Date().toISOString(), durationMs: 1,
        modelCalls: ai ? request.featureId === 'link-brief' ? 2 : 1 : 0,
        ...(request.featureId === 'link-brief' ? { toolCalls: 1 } : request.featureId === 'assistant' ? { toolCalls: 0 } : {}),
        input: request.input, output: `VERIFIED-${request.featureId}:${request.input}` };
      const actual = changeTask ? changeTask(task) : task; saved.set(request.idempotencyKey, actual); afterExecution?.(); return actual;
    },
    async executeLinks() { throw new Error('NO IMPLICIT LINK EXECUTION'); },
    async cancelOwnTasks(actor) { cancellations.push({ groupId: actor.groupId, userId: actor.userId }); return 1; },
    async claimDelivery(_actor, id) { if (deliveries.has(id)) return false; deliveries.set(id, 'claimed'); return true; },
    async recordDelivery(_actor, id, status) { deliveries.set(id, status); },
    async registerGroup() { throw new Error('UNEXPECTED REGISTRATION'); }, async previewRules() { throw new Error('UNEXPECTED RULES'); },
    async getProposal() { throw new Error('UNEXPECTED PROPOSAL'); }, async activateRules() { throw new Error('UNEXPECTED ACTIVATE'); },
    async migrateGroup() { throw new Error('UNEXPECTED MIGRATION'); },
  };
  const api: Transformer = async (_prev, method, value) => {
    const payload = value as Record<string, unknown>; calls.push({ method, payload }); let result: unknown;
    if (method === 'getMe') result = botInfo;
    else if (method === 'getChat') result = chat(Number(payload.chat_id));
    else if (method === 'getChatMember') {
      const id = Number(payload.user_id); result = { user: { id, is_bot: id === botInfo.id, first_name: 'Offline user' }, status: id === botInfo.id ? 'administrator' : roles.get(id) ?? 'left' };
    } else if (method === 'sendMessage') {
      const replyTo = (payload.reply_parameters as { message_id: number } | undefined)?.message_id;
      result = { message_id: 1000 + sent.length, date: 1, from: botInfo, chat: chat(Number(payload.chat_id)), text: payload.text,
        ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}), ...(replyTo ? { reply_to_message: inputs.get(replyTo) } : {}) };
      sent.push(result as Message); inputs.set((result as Message).message_id, result as Message);
    } else if (method === 'answerCallbackQuery') result = true;
    else if (method === 'setMyCommands') { if (options.failMenu) throw new Error('OFFLINE MENU FAILURE'); result = true; }
    else throw new Error(`UNEXPECTED API METHOD ${method}`);
    return { ok: true, result } as never;
  };
  const adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding, rateLimit: false, now: () => now,
    installCommands: options.installCommands, apiTransformer: api, onError: code => errors.push(code) });
  assert.equal(await adapter.init(), true);
  t.after(async () => { await adapter.stop(); assert.equal(fetch.mock.callCount(), 0); });
  async function handle(update: Update) { if (update.message) { inputs.set(update.message.message_id, update.message); if (update.message.reply_to_message) inputs.set(update.message.reply_to_message.message_id, update.message.reply_to_message); } return adapter.handleUpdate(update); }
  return { adapter, handle, config, roles, calls, sent, requests, deliveries, errors, cancellations,
    get executions() { return executions; }, get groupReads() { return groupReads; }, set now(value: number) { now = value; }, get now() { return now; },
    set afterExecution(value: (() => void) | undefined) { afterExecution = value; }, set executeWait(value: Promise<void> | undefined) { executeWait = value; },
    set changeTask(value: ((task: Task) => Task) | undefined) { changeTask = value; } };
}
function token(message: Message) { return message.reply_markup!.inline_keyboard[0][0] as { callback_data: string }; }
function business(messages: Message[]) { return messages.filter(value => value.text?.startsWith('VERIFIED-')); }

test('OFFLINE product: private /start and /help give safe guidance without querying groups or granting business access', async t => {
  const sim = await simulation(t);
  await sim.handle(message(1, '/start -1002', 12, 12)); await sim.handle(message(2, '/help', 12, 12));
  assert.equal(sim.groupReads, 0); assert.equal(sim.requests.length, 0);
  assert.equal(sim.sent.length, 2); assert.ok(sim.sent.every(value => value.chat.id === 12 && value.text?.includes('私聊不会读取')));
  await sim.handle(message(3, '/echo private', 12, 12)); assert.equal(sim.requests.length, 0);
  await sim.handle(message(4, '/start', 12, 13)); assert.equal(sim.sent.length, 2);
});

test('OFFLINE product: native menus are explicit, and menu API failure does not destroy verified initialization', async t => {
  const sim = await simulation(t, { installCommands: true, failMenu: true });
  assert.equal(sim.adapter.status.mode, 'ready'); assert.ok(sim.errors.includes('TELEGRAM_COMMAND_MENU_FAILED'));
  const menu = sim.calls.find(value => value.method === 'setMyCommands')!;
  const commands = (menu.payload.commands as { command: string }[]).map(value => value.command);
  for (const name of ['start', 'echo', 'digest', 'brief', 'scan', 'ask', 'cancel']) assert.ok(commands.includes(name));
});

test('OFFLINE product: Echo and ad analysis run current input in this group with zero models and no moderation APIs', async t => {
  const sim = await simulation(t);
  await sim.handle(message(1, '/echo -c other-group ordinary text'));
  await sim.handle(message(2, '/scan message to analyze'));
  assert.deepEqual(sim.requests.map(value => [value.featureId, value.input, value.actor.groupId, value.externalProcessingAcknowledged]),
    [['echo', '-c other-group ordinary text', '-1001', undefined], ['antiad', 'message to analyze', '-1001', undefined]]);
  assert.equal(business(sim.sent).length, 2);
  sim.config.features = []; await sim.handle(message(3, '/echo hidden'));
  assert.equal(sim.requests.length, 2);
});

test('OFFLINE product: AI only starts after its requester confirms exact signed input, then persistent delivery is claimed once', async t => {
  const sim = await simulation(t);
  await sim.handle(message(1, '/digest summarize this'));
  assert.equal(sim.executions, 0); const confirmation = sim.sent[0]; const data = token(confirmation).callback_data;
  assert.ok(Buffer.byteLength(data) <= 64); assert.ok(confirmation.reply_to_message);
  await sim.handle(callback(2, data, confirmation));
  assert.equal(sim.executions, 1); assert.equal(sim.requests[0].externalProcessingAcknowledged, true);
  assert.equal(sim.requests[0].input, 'summarize this'); assert.equal(sim.requests[0].updateId, 1);
  assert.equal(business(sim.sent).length, 1); assert.equal(sim.deliveries.get('task-1'), 'sent');
  await sim.handle(callback(3, data, confirmation)); assert.equal(sim.requests.length, 1); assert.equal(business(sim.sent).length, 1);
});

test('OFFLINE product: forged, other-user, cross-group, altered-text, missing-reply and expired AI consent cannot invoke execution', async t => {
  const sim = await simulation(t); await sim.handle(message(1, '/brief https://offline.example'));
  const confirmation = sim.sent[0]; const data = token(confirmation).callback_data;
  await sim.handle(callback(2, data, confirmation, 13));
  await sim.handle(callback(3, data, confirmation, 12, { chat: chat(-1002) }));
  await sim.handle(callback(4, data.slice(0, -1) + (data.endsWith('A') ? 'B' : 'A'), confirmation));
  await sim.handle(callback(5, data, confirmation, 12, { reply_to_message: { ...confirmation.reply_to_message, text: '/brief changed' } }));
  await sim.handle(callback(6, data, confirmation, 12, { reply_to_message: undefined }));
  sim.now += 301_000; await sim.handle(callback(7, data, confirmation));
  assert.equal(sim.requests.length, 0); assert.equal(business(sim.sent).length, 0);
});

test('OFFLINE product: explicit replied text is input, not authority; only current requester membership permits AI execution', async t => {
  const sim = await simulation(t);
  const quoted = message(10, 'quoted text', 13).message!;
  await sim.handle(message(1, '/digest', 12, -1001, { reply_to_message: quoted }));
  const confirmation = sim.sent[0]; assert.equal(confirmation.reply_to_message!.from!.id, 13);
  sim.roles.set(13, 'left'); // quoted author membership cannot confer or remove requester authority
  await sim.handle(callback(2, token(confirmation).callback_data, confirmation));
  assert.equal(sim.requests.length, 1); assert.equal(sim.requests[0].actor.userId, '12'); assert.equal(sim.requests[0].input, 'quoted text');
  await sim.handle(message(3, '/digest another')); const next = sim.sent.at(-1)!;
  sim.roles.set(12, 'left'); await sim.handle(callback(4, token(next).callback_data, next)); assert.equal(sim.requests.length, 1);
});

test('OFFLINE product: assistant plain and mixed evidence is checked; wrong tool evidence never becomes a business reply', async t => {
  const sim = await simulation(t);
  await sim.handle(message(1, '/ask explain this')); let confirmation = sim.sent.at(-1)!;
  await sim.handle(callback(2, token(confirmation).callback_data, confirmation)); assert.equal(business(sim.sent).length, 1);
  sim.changeTask = value => ({ ...value, modelCalls: 2, toolCalls: 1 });
  await sim.handle(message(3, '/ask link explanation')); confirmation = sim.sent.at(-1)!;
  await sim.handle(callback(4, token(confirmation).callback_data, confirmation)); assert.equal(business(sim.sent).length, 2);
  sim.changeTask = value => ({ ...value, modelCalls: 2, toolCalls: 2 });
  await sim.handle(message(5, '/ask fabricated tool evidence')); confirmation = sim.sent.at(-1)!;
  await sim.handle(callback(6, token(confirmation).callback_data, confirmation)); assert.equal(business(sim.sent).length, 2);
  assert.ok(sim.errors.includes('TELEGRAM_RESULT_SCOPE_REJECTED'));
});

test('OFFLINE product: feature and member revocation after AI execution withholds its business result', async t => {
  const sim = await simulation(t); await sim.handle(message(1, '/brief https://offline.example'));
  const confirmation = sim.sent[0]; sim.afterExecution = () => { sim.config.features = sim.config.features.filter(value => value !== 'link-cleaner'); };
  await sim.handle(callback(2, token(confirmation).callback_data, confirmation));
  assert.equal(sim.requests.length, 1); assert.equal(business(sim.sent).length, 0); assert.equal(sim.deliveries.get('task-1'), 'withheld');
});

test('OFFLINE product: cancellation command and button bind only current owner in current group, and reject replay', async t => {
  const sim = await simulation(t); let release!: () => void;
  sim.executeWait = new Promise<void>(yes => { release = yes; });
  await sim.handle(message(1, '/digest running'));
  const confirmation = sim.sent[0]; const running = sim.handle(callback(2, token(confirmation).callback_data, confirmation));
  for (let i = 0; i < 100 && sim.sent.length < 2; i++) await new Promise<void>(yes => setImmediate(yes));
  const progress = sim.sent[1]; assert.ok(progress.reply_markup); const data = token(progress).callback_data;
  await sim.handle(callback(3, data, progress, 13)); await sim.handle(callback(4, data, progress, 12, { chat: chat(-1002) }));
  assert.equal(sim.cancellations.length, 0);
  await sim.handle(callback(5, data, progress)); await sim.handle(callback(6, data, progress));
  await sim.handle(message(7, '/cancel'));
  assert.deepEqual(sim.cancellations, [{ groupId: '-1001', userId: '12' }, { groupId: '-1001', userId: '12' }]);
  release(); await running;
});

test('OFFLINE product: non-link mentions become explicitly consented assistant input, and welcome uses only current service event', async t => {
  const sim = await simulation(t); sim.config.responseMode = 'mention';
  await sim.handle(message(1, '@OfflineBot explain modules')); assert.equal(sim.requests.length, 0);
  let confirmation = sim.sent[0]; await sim.handle(callback(2, token(confirmation).callback_data, confirmation));
  assert.equal(sim.requests[0].featureId, 'assistant'); assert.equal(sim.requests[0].input, 'explain modules');
  await sim.handle(message(3, '', 12, -1001, { new_chat_members: [{ id: 42, is_bot: false, first_name: 'New member' }, botInfo] }));
  assert.equal(sim.requests[1].featureId, 'welcome'); assert.equal(sim.requests[1].actor.groupId, '-1001');
  assert.deepEqual(sim.requests[1].eventUserIds, ['42']); assert.equal(sim.requests[1].input, 'New member');
  sim.config.features = []; await sim.handle(message(4, '', 12, -1001, { new_chat_members: [{ id: 43, is_bot: false, first_name: 'Other member' }] }));
  assert.equal(sim.requests.length, 2);
});


test('OFFLINE callback boundary: signatures retain no payloads, reject at bounded replay capacity, expire and invalidate across restart', () => {
  let now = 1_900_000_000_000; const confirmations = createTelegramConfirmations(() => now);
  const request = { featureId: 'digest' as const, groupId: '-1001', userId: '9007199254740991',
    messageId: 2_147_483_647, updateId: 2_147_483_647, input: 'selected text', mode: 'command' as const, targeted: true };
  const token = confirmations.issue(request); assert.ok(Buffer.byteLength(token) <= 64);
  assert.equal(confirmations.consume(token, request), true);
  assert.equal(confirmations.consume(token, request), false);
  const restarted = createTelegramConfirmations(() => now); assert.equal(restarted.consume(token, request), false);
  for (let i = 1; i < 512; i++) {
    const next = { ...request, messageId: i }; assert.equal(confirmations.consume(confirmations.issue(next), next), true);
  }
  const overflow = { ...request, messageId: 9999 }; const pending = confirmations.issue(overflow);
  assert.equal(confirmations.consume(pending, overflow), false); // live entries cannot be evicted to permit replay
  assert.equal(confirmations.consume(token, request), false);
  now += 301_000; assert.equal(confirmations.consume(pending, overflow), false);
  assert.equal(confirmations.consume(confirmations.issue(overflow), overflow), true); // expired signatures have been pruned
});

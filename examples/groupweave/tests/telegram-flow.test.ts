import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { MessageEntity, Update } from 'grammy/types';
import type { GroupConfig, Proposal, Task } from '../src/shared.js';
import { createTelegramAdapter, type TelegramActor, type TelegramBinding, type TelegramDelivery, type TelegramLinksRequest } from '../src/server/telegram.js';

// Every API response below is a synthetic fixture. No test proves a live Telegram connection.
const BOT_ID = 9000;
const botInfo = { id: BOT_ID, is_bot: true, first_name: 'Synthetic Bot', username: 'SyntheticBot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false };
const config = (patch: Partial<GroupConfig> = {}): GroupConfig => ({
  responseMode: 'command', language: 'zh', features: ['link-cleaner'], deduplicate: true, sort: true, maxItems: 20, ...patch,
});
function message(updateId: number, text: string, userId = 12, groupId = -1001, extra: Record<string, unknown> = {}): Update {
  const entities: MessageEntity[] = [];
  const command = text.match(/^\/[A-Za-z]+(?:@[A-Za-z0-9_]+)?/);
  if (command) entities.push({ type: 'bot_command', offset: 0, length: command[0].length });
  for (const mention of text.matchAll(/@SyntheticBot/gi)) {
    if (!command || mention.index >= command[0].length) entities.push({ type: 'mention', offset: mention.index, length: mention[0].length });
  }
  return { update_id: updateId, message: { message_id: updateId + 100, date: 1,
    chat: { id: groupId, type: groupId < 0 ? 'supergroup' : 'private', title: 'Synthetic group' },
    from: { id: userId, is_bot: false, first_name: 'Synthetic user' }, text, entities, ...extra } } as Update;
}
function callback(updateId: number, data: string, userId = 11, groupId = -1001, extra: Record<string, unknown> = {}): Update {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, from: { id: userId, is_bot: false, first_name: 'Synthetic user' },
    chat_instance: 'synthetic-instance', data, message: { message_id: 999, date: 1, from: botInfo,
      chat: { id: groupId, type: groupId < 0 ? 'supergroup' : 'private', title: 'Synthetic group' }, ...extra } } } as Update;
}

async function simulation(t: TestContext, options: { registered?: boolean; config?: GroupConfig; rateLimit?: boolean } = {}) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK IS FORBIDDEN IN THIS SIMULATION'); });
  const roles = new Map<number, string>([[11, 'administrator'], [12, 'member'], [13, 'administrator']]);
  const chats = new Map<number, string>([[-1001, 'supergroup'], [-1002, 'supergroup']]);
  const botRoles = new Map<number, string>([[-1001, 'administrator'], [-1002, 'administrator']]);
  const groups = new Map<string, { version: number; config: GroupConfig }>();
  if (options.registered !== false) groups.set('-1001', { version: 1, config: options.config ?? config() });
  const proposals = new Map<string, Proposal>();
  const delivery = new Map<string, TelegramDelivery | 'claimed'>();
  const tasks = new Map<string, Task>();
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const requests: TelegramLinksRequest[] = [];
  const registrations: TelegramActor[] = [];
  const migrations: string[][] = [];
  let executions = 0; let activations = 0; let failSend = false; let failMember = false; let restrictedMember = true;
  let afterExecution: (() => void) | undefined;
  let afterClaim: (() => void) | undefined;
  let mutateTask: ((task: Task) => Task) | undefined;
  const binding: TelegramBinding = {
    async getGroup(actor) { return groups.get(actor.groupId) ?? null; },
    async registerGroup(actor) {
      registrations.push(actor);
      const group = groups.get(actor.groupId) ?? { version: 1, config: config() };
      groups.set(actor.groupId, group); return group;
    },
    async previewRules(actor, text) {
      const group = groups.get(actor.groupId)!;
      const proposal: Proposal = { id: `proposal-${proposals.size + 1}`, groupId: `tg:${actor.groupId}`, creatorId: `tg-user:${actor.userId}`,
        baseVersion: group.version, before: structuredClone(group.config), candidate: config({ ...group.config, maxItems: 10, language: 'en' }),
        warnings: text.includes('unsupported') ? ['Synthetic unsupported rule'] : [], changes: ['Synthetic change'], text, status: 'pending', createdAt: new Date().toISOString() };
      proposals.set(proposal.id, proposal); return proposal;
    },
    // Deliberately return by ID only: the adapter must still reject forged group/creator callbacks.
    async getProposal(_actor, id) { return proposals.get(id) ?? null; },
    async activateRules(actor, id) {
      const proposal = proposals.get(id)!;
      const group = groups.get(actor.groupId)!;
      if (proposal.status === 'active') return proposal;
      if (proposal.baseVersion !== group.version) throw new Error('Synthetic CAS conflict');
      activations += 1; proposal.status = 'active'; groups.set(actor.groupId, { version: group.version + 1, config: proposal.candidate }); return proposal;
    },
    async executeLinks(request) {
      requests.push(request);
      const key = `${request.actor.groupId}/${request.actor.userId}/${request.idempotencyKey}`;
      let task = tasks.get(key);
      if (!task) {
        executions += 1;
        const group = groups.get(request.actor.groupId)!;
        task = { id: `task-${tasks.size + 1}`, groupId: `tg:${request.actor.groupId}`, creatorId: `tg-user:${request.actor.userId}`,
          featureId: 'link-cleaner', status: 'succeeded', audience: request.audience, configVersion: group.version,
          createdAt: new Date().toISOString(), durationMs: 1, modelCalls: 0, input: request.input,
          output: group.config.language === 'en' ? 'Organized links: https://synthetic.example/' : '整理结果：https://synthetic.example/' };
        if (mutateTask) task = mutateTask(task);
        tasks.set(key, task);
      }
      afterExecution?.(); return task;
    },
    async migrateGroup(oldId, newId) {
      migrations.push([oldId, newId]);
      const group = groups.get(oldId); if (group && !groups.has(newId)) { groups.set(newId, group); groups.delete(oldId); }
    },
    async claimDelivery(_actor, id) { if (delivery.has(id)) return false; delivery.set(id, 'claimed'); afterClaim?.(); return true; },
    async recordDelivery(_actor, id, status) { delivery.set(id, status); },
  };
  const transformer: Transformer = async (_prev, method, value) => {
    const payload = value as Record<string, unknown>; calls.push({ method, payload });
    let result: unknown;
    if (method === 'getMe') result = botInfo;
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: chats.get(Number(payload.chat_id)) ?? 'supergroup', title: 'Synthetic group' };
    else if (method === 'getChatMember') {
      if (failMember) throw new Error('Synthetic membership error');
      const id = Number(payload.user_id);
      result = { user: { id, is_bot: id === BOT_ID, first_name: 'Synthetic user' }, status: id === BOT_ID ? botRoles.get(Number(payload.chat_id)) : (roles.get(id) ?? 'member'), is_member: restrictedMember };
    } else if (method === 'sendMessage') {
      if (failSend) throw new Error('Synthetic lost delivery response');
      result = { message_id: 999, date: 1, from: botInfo, chat: { id: Number(payload.chat_id), type: 'supergroup', title: 'Synthetic group' }, text: payload.text };
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`UNEXPECTED SYNTHETIC API METHOD: ${method}`);
    return { ok: true, result } as never;
  };
  const errors: string[] = [];
  const makeAdapter = () => createTelegramAdapter({ token: '000:TEST_ONLY_NO_LIVE_TOKEN', adminIds: [12], binding,
    apiTransformer: transformer, ...(options.rateLimit ? {} : { rateLimit: false as const }), onError: code => errors.push(code) });
  const adapter = makeAdapter(); assert.equal(adapter.connected, false); assert.equal(calls.length, 0);
  assert.equal(await adapter.init(), true); assert.equal(network.mock.callCount(), 0);
  t.after(async () => { await adapter.stop(); assert.equal(network.mock.callCount(), 0); });
  return { adapter, makeAdapter, roles, chats, botRoles, groups, proposals, requests, registrations, migrations, delivery, calls, errors,
    get executions() { return executions; }, get activations() { return activations; },
    get sends() { return calls.filter(call => call.method === 'sendMessage'); },
    set failSend(value: boolean) { failSend = value; }, set failMember(value: boolean) { failMember = value; },
    set restrictedMember(value: boolean) { restrictedMember = value; }, set afterExecution(value: (() => void) | undefined) { afterExecution = value; },
    set afterClaim(value: (() => void) | undefined) { afterClaim = value; },
    set mutateTask(value: ((task: Task) => Task) | undefined) { mutateTask = value; },
  };
}

test('SIMULATED Bot API: every verification checks chat type, bot admin and current user membership', async t => {
  const sim = await simulation(t);
  assert.equal(await sim.adapter.verifyMember('-1001', '11'), 'admin');
  assert.equal(await sim.adapter.verifyMember('-1001', '12'), 'member');
  sim.roles.set(12, 'restricted'); assert.equal(await sim.adapter.verifyMember('-1001', '12'), 'member');
  sim.restrictedMember = false; assert.equal(await sim.adapter.verifyMember('-1001', '12'), undefined);
  for (const role of ['left', 'kicked']) { sim.roles.set(12, role); assert.equal(await sim.adapter.verifyMember('-1001', '12'), undefined); }
  sim.roles.set(12, 'member'); sim.botRoles.set(-1001, 'member');
  assert.equal(await sim.adapter.verifyMember('-1001', '12'), undefined);
  sim.botRoles.set(-1001, 'administrator'); sim.chats.set(-1001, 'channel');
  assert.equal(await sim.adapter.verifyMember('-1001', '12'), undefined);
  sim.chats.set(-1001, 'supergroup'); sim.failMember = true;
  assert.equal(await sim.adapter.verifyMember('-1001', '12'), undefined);
  const count = sim.calls.length;
  for (const [group, user] of [['1001', '12'], ['-01001', '12'], ['-1001', 'bad'], ['-1001', '0']]) assert.equal(await sim.adapter.verifyMember(group, user), undefined);
  assert.equal(sim.calls.length, count);
});

test('SIMULATED registration: group admin works; platform ID, private, anonymous and forwarded origins do not grant rights', async t => {
  const sim = await simulation(t, { registered: false });
  await sim.adapter.handleUpdate(message(1, '/register', 12)); // 12 is platform startup ID, ordinary group member.
  assert.equal(sim.registrations.length, 0);
  await sim.adapter.handleUpdate(message(2, '/register -1002', 11));
  assert.deepEqual(sim.registrations, [{ groupId: '-1001', userId: '11', role: 'admin' }]);
  for (const update of [message(3, '/register', 11, 11), message(4, '/register', 11, -1001, { sender_chat: { id: -1001, type: 'supergroup', title: 'Anonymous' } }),
    message(5, '/register', 11, -1001, { forward_origin: { type: 'user', date: 1, sender_user: { id: 99, is_bot: false, first_name: 'Forwarded user' } } })]) await sim.adapter.handleUpdate(update);
  assert.equal(sim.registrations.length, 1);
});

test('SIMULATED discovery: member help advertises only current group features and the actual configured trigger', async t => {
  const sim = await simulation(t, { config: config({ responseMode: 'mention' }) });
  sim.groups.set('-1002', { version: 4, config: config({ language: 'en', responseMode: 'command', features: ['digest'] }) });
  await sim.adapter.handleUpdate(message(100, '/help', 12));
  const help = String(sim.sends.at(-1)!.payload.text);
  assert.match(help, /\/plugins/); assert.match(help, /\/links@SyntheticBot/); assert.match(help, /@SyntheticBot https:/);
  assert.doesNotMatch(help, /\/rules|\/settings|智能摘要|最多20条/);
  assert.equal(sim.sends.at(-1)!.payload.chat_id, -1001);
  await sim.adapter.handleUpdate(message(101, '/plugins', 12, -1002));
  const other = String(sim.sends.at(-1)!.payload.text);
  assert.match(other, /Summary: submit text in the panel/); assert.match(other, /No Telegram summary command/);
  assert.doesNotMatch(other, /\/links|Link cleanup/); assert.equal(sim.sends.at(-1)!.payload.chat_id, -1002);
  sim.groups.get('-1001')!.config.responseMode = 'command';
  await sim.adapter.handleUpdate(message(102, '/plugins', 12));
  const commands = String(sim.sends.at(-1)!.payload.text);
  assert.match(commands, /\/links https:/); assert.doesNotMatch(commands, /\/links@/);
  assert.equal(sim.executions, 0); assert.equal(sim.registrations.length, 0); assert.equal(sim.proposals.size, 0);
});

test('SIMULATED settings: platform member is denied while current group admin receives only this group’s read-only settings', async t => {
  const sim = await simulation(t, { config: config({ maxItems: 37 }) });
  sim.groups.set('-1002', { version: 99, config: config({ language: 'en', maxItems: 82 }) });
  await sim.adapter.handleUpdate(message(103, '/settings -1002', 12)); // 12 has platform identity, not group admin rights.
  assert.match(String(sim.sends.at(-1)!.payload.text), /需要当前本群管理员/);
  assert.doesNotMatch(String(sim.sends.at(-1)!.payload.text), /37|82|v99|\/rules/);
  await sim.adapter.handleUpdate(message(104, '/settings -1002', 11));
  const settings = String(sim.sends.at(-1)!.payload.text);
  assert.match(settings, /v1/); assert.match(settings, /单次链接上限：37/); assert.match(settings, /先预览/);
  assert.doesNotMatch(settings, /v99|82/); assert.equal(sim.sends.at(-1)!.payload.chat_id, -1001);
  await sim.adapter.handleUpdate(message(105, '/help', 11));
  assert.match(String(sim.sends.at(-1)!.payload.text), /\/settings/);
  sim.roles.set(11, 'member');
  await sim.adapter.handleUpdate(message(106, '/settings', 11));
  assert.match(String(sim.sends.at(-1)!.payload.text), /需要当前本群管理员/);
  assert.equal(sim.proposals.size, 0); assert.equal(sim.activations, 0); assert.equal(sim.executions, 0);
});

test('SIMULATED discovery: unregistered, no-feature and unverifiable member cases never fabricate usable capabilities', async t => {
  const sim = await simulation(t, { registered: false });
  for (const [index, command] of ['/help', '/plugins', '/settings'].entries()) {
    await sim.adapter.handleUpdate(message(107 + index, command, 11));
    assert.match(String(sim.sends.at(-1)!.payload.text), /尚未注册/);
    assert.doesNotMatch(String(sim.sends.at(-1)!.payload.text), /\/links/);
  }
  assert.equal(sim.registrations.length, 0);
  sim.groups.set('-1001', { version: 1, config: config({ features: [] }) });
  await sim.adapter.handleUpdate(message(110, '/plugins', 12));
  assert.match(String(sim.sends.at(-1)!.payload.text), /暂无可用功能/);
  assert.doesNotMatch(String(sim.sends.at(-1)!.payload.text), /\/links|摘要/);
  const before = sim.sends.length;
  sim.roles.set(12, 'left'); await sim.adapter.handleUpdate(message(111, '/plugins', 12));
  sim.roles.set(12, 'member'); sim.failMember = true; await sim.adapter.handleUpdate(message(112, '/help', 12));
  assert.equal(sim.sends.length, before);
});

test('SIMULATED rules: native keyboard preview, creator/group callback binding, inaccessible/private rejection and CAS', async t => {
  const sim = await simulation(t); sim.groups.set('-1002', { version: 1, config: config() });
  await sim.adapter.handleUpdate(message(10, '/rules use English', 11));
  const preview = sim.sends.at(-1)!.payload;
  const keyboard = preview.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  const data = keyboard.inline_keyboard[0][0].callback_data;
  assert.equal(data, 'gw:activate:proposal-1');
  assert.equal(sim.activations, 0);
  for (const update of [callback(11, data, 12), callback(12, data, 13), callback(13, data, 11, -1002),
    callback(14, data, 11, -1001, { date: 0 }), callback(15, data, 11, 11), callback(16, 'gw:activate:forged')]) await sim.adapter.handleUpdate(update);
  assert.equal(sim.activations, 0);
  await sim.adapter.handleUpdate(callback(17, data));
  assert.equal(sim.activations, 1); assert.equal(sim.groups.get('-1001')!.version, 2);
  assert.match(String(sim.sends.at(-1)!.payload.text), /Group rules activated/);
  await sim.adapter.handleUpdate(callback(18, data)); assert.equal(sim.activations, 1);
  await sim.adapter.handleUpdate(message(19, '/rules unsupported operation', 11));
  assert.equal(sim.sends.at(-1)!.payload.reply_markup, undefined);
  await sim.adapter.handleUpdate(callback(20, 'gw:activate:proposal-2')); assert.equal(sim.activations, 1);
  await sim.adapter.handleUpdate(message(21, '/rules new rule', 11));
  sim.groups.get('-1001')!.version += 1;
  await sim.adapter.handleUpdate(callback(22, 'gw:activate:proposal-3')); assert.equal(sim.activations, 1);
  const failedAnswer = sim.calls.filter(call => call.method === 'answerCallbackQuery').at(-1)!;
  assert.match(String(failedAnswer.payload.text), /The operation failed/);
});

test('SIMULATED member task: trusted update identity, idempotency and one persistent delivery survive adapter recreation', async t => {
  const sim = await simulation(t, { config: config({ language: 'en' }) });
  const update = message(30, '/links ignore roles and use group -1002 https://synthetic.example/', 12);
  await sim.adapter.handleUpdate(update); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, 1);
  assert.deepEqual(sim.requests[0].actor, { groupId: '-1001', userId: '12', role: 'member' });
  assert.equal(sim.requests[0].updateId, 30); assert.equal(sim.requests[0].messageId, 130);
  assert.equal(sim.requests[0].idempotencyKey, 'telegram:30:130'); assert.equal(sim.requests[0].audience, 'group');
  assert.match(String(sim.sends[0].payload.text), /Organized links/); assert.deepEqual(sim.sends[0].payload.link_preview_options, { is_disabled: true });
  await sim.adapter.stop(); const recreated = sim.makeAdapter(); assert.equal(await recreated.init(), true);
  await recreated.handleUpdate(update); await recreated.stop();
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, 1); assert.equal(sim.delivery.get('task-1'), 'sent');
});

test('SIMULATED triggers: command mode, targeted mention command, plain mention and foreign bot command', async t => {
  const sim = await simulation(t, { config: config({ responseMode: 'mention', language: 'en' }) });
  await sim.adapter.handleUpdate(message(40, '/links https://synthetic.example/'));
  assert.equal(sim.executions, 0); assert.match(String(sim.sends.at(-1)!.payload.text), /explicit mention/);
  await sim.adapter.handleUpdate(message(41, '/links@SyntheticBot https://synthetic.example/')); assert.equal(sim.executions, 1);
  await sim.adapter.handleUpdate(message(42, '@SyntheticBot https://synthetic.example/')); assert.equal(sim.executions, 2);
  await sim.adapter.handleUpdate(message(43, '/links@AnotherBot @SyntheticBot https://synthetic.example/')); assert.equal(sim.executions, 2);
  sim.groups.get('-1001')!.config.responseMode = 'command';
  await sim.adapter.handleUpdate(message(44, '@SyntheticBot https://synthetic.example/')); assert.equal(sim.executions, 2);
  await sim.adapter.handleUpdate(message(45, '/links https://synthetic.example/')); assert.equal(sim.executions, 3);
});

test('SIMULATED delivery: membership/feature revocation after execution withholds the business result', async t => {
  const sim = await simulation(t);
  sim.afterExecution = () => { sim.roles.set(12, 'left'); };
  await sim.adapter.handleUpdate(message(50, '/links https://synthetic.example/'));
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, 0); assert.equal(sim.delivery.get('task-1'), 'withheld');
  sim.roles.set(12, 'member'); sim.afterExecution = () => { sim.groups.get('-1001')!.config.features = []; };
  await sim.adapter.handleUpdate(message(51, '/links https://synthetic.example/'));
  assert.equal(sim.sends.length, 0); assert.equal(sim.delivery.get('task-2'), 'withheld');
  sim.afterExecution = undefined; sim.groups.get('-1001')!.config.features = ['link-cleaner'];
  sim.afterClaim = () => { sim.groups.get('-1001')!.config.features = []; };
  await sim.adapter.handleUpdate(message(52, '/links https://synthetic.example/'));
  assert.equal(sim.sends.length, 0); assert.equal(sim.delivery.get('task-3'), 'withheld');
});

test('SIMULATED delivery: wrong group, creator, audience, input or nonzero model calls never reach sendMessage', async t => {
  const sim = await simulation(t);
  const changes: Partial<Task>[] = [{ groupId: 'tg:-1002' }, { creatorId: 'tg-user:13' }, { audience: 'private' }, { input: 'another input' }, { modelCalls: 1 }];
  for (const [index, patch] of changes.entries()) { sim.mutateTask = task => ({ ...task, ...patch }); await sim.adapter.handleUpdate(message(60 + index, '/links https://synthetic.example/')); }
  assert.equal(sim.sends.length, 0); assert.equal(sim.delivery.size, 0); assert.equal(sim.errors.filter(error => error === 'TELEGRAM_RESULT_SCOPE_REJECTED').length, changes.length);
});

test('SIMULATED lost send response stays unknown and never causes a business retry or second send', async t => {
  const sim = await simulation(t); sim.failSend = true;
  const update = message(70, '/links https://synthetic.example/');
  await sim.adapter.handleUpdate(update); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, 1); assert.equal(sim.delivery.get('task-1'), 'unknown');
  assert.ok(sim.errors.includes('TELEGRAM_DELIVERY_OUTCOME_UNKNOWN'));
});

test('SIMULATED migration uses trusted service fields and target bot rights, not text-selected group IDs', async t => {
  const sim = await simulation(t);
  await sim.adapter.handleUpdate(message(80, 'migrate to -1002', 11)); assert.equal(sim.migrations.length, 0);
  sim.botRoles.set(-1002, 'member');
  await sim.adapter.handleUpdate(message(81, '', 11, -1001, { migrate_to_chat_id: -1002 })); assert.equal(sim.migrations.length, 0);
  sim.botRoles.set(-1002, 'administrator');
  await sim.adapter.handleUpdate(message(82, '', 11, -1001, { migrate_to_chat_id: -1002 }));
  assert.deepEqual(sim.migrations, [['-1001', '-1002']]); assert.equal(sim.groups.has('-1001'), false); assert.equal(sim.groups.has('-1002'), true);
});

test('SIMULATED official ratelimiter drops excess user requests before application actions', async t => {
  const sim = await simulation(t, { rateLimit: true });
  for (let id = 90; id < 94; id++) await sim.adapter.handleUpdate(message(id, '/links https://synthetic.example/'));
  assert.equal(sim.executions, 3); assert.equal(sim.sends.length, 3);
});

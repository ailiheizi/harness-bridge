import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { CommandRuntime } from '@deepseek-ai/dsh-commands';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { Transformer } from 'grammy';
import type { MessageEntity, Update } from 'grammy/types';
import { createGroupActions, type Executor } from '../src/server/actions.js';
import { createNativeExecutor } from '../src/server/native.js';
import { Store } from '../src/server/store.js';
import { createTelegramAdapter } from '../src/server/telegram.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';

// Real Store/actions/DSH, synthetic Telegram API only. Never a live group PASS.
const info = { id: 9000, is_bot: true, first_name: 'Offline Bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
function message(id: number, text: string, user = 12, group = -1001): Update {
  const command = text.match(/^\/[A-Za-z]+(?:@[A-Za-z0-9_]+)?/);
  const entities: MessageEntity[] = command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : [];
  for (const mention of text.matchAll(/@OfflineBot/gi)) if (!command || mention.index >= command[0].length)
    entities.push({ type: 'mention', offset: mention.index, length: mention[0].length });
  return { update_id: id, message: { message_id: id + 100, date: 1, from: { id: user, is_bot: false, first_name: 'Offline User' },
    chat: { id: group, type: 'supergroup', title: 'Offline group' }, text, entities } };
}
function callback(id: number, data: string, user = 11, group = -1001): Update {
  return { update_id: id, callback_query: { id: `offline-${id}`, from: { id: user, is_bot: false, first_name: 'Offline User' },
    chat_instance: 'offline-instance', data, message: { message_id: 999, date: 1, from: info,
      chat: { id: group, type: 'supergroup', title: 'Offline group' } } } };
}
async function integration(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  const models = t.mock.method(LlmRuntime.prototype, 'stream', () => { throw new Error('MODEL CALL FORBIDDEN'); });
  const originalCommand = CommandRuntime.prototype.execute; const originalTool = ToolRuntime.prototype.execute;
  const commands = t.mock.method(CommandRuntime.prototype, 'execute', function (this: CommandRuntime, ...args: Parameters<CommandRuntime['execute']>) {
    return originalCommand.apply(this, args);
  });
  const tools = t.mock.method(ToolRuntime.prototype, 'execute', function (this: ToolRuntime, ...args: Parameters<ToolRuntime['execute']>) {
    return originalTool.apply(this, args);
  });
  const roles = new Map<number, string>([[11, 'administrator'], [12, 'member'], [13, 'administrator']]);
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  let failSend = false; let executions = 0; let afterExecution: (() => void) | undefined;
  let afterMemberLookup: ((userId: number) => void) | undefined;
  const api: Transformer = async (_prev, method, value) => {
    const payload = value as Record<string, unknown>; calls.push({ method, payload });
    let result: unknown;
    if (method === 'getMe') result = info;
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline group' };
    else if (method === 'getChatMember') {
      const id = Number(payload.user_id);
      result = { user: { id, is_bot: id === info.id, first_name: 'Offline User' }, status: id === info.id ? 'administrator' : roles.get(id) ?? 'left' };
      afterMemberLookup?.(id);
    } else if (method === 'sendMessage') {
      if (failSend) throw new Error('SYNTHETIC SEND OUTCOME UNKNOWN');
      result = { message_id: 999, date: 1, from: info, chat: { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline group' }, text: payload.text };
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`UNEXPECTED OFFLINE METHOD ${method}`);
    return { ok: true, result } as never;
  };
  const store = new Store(); const native = createNativeExecutor();
  const executor: Executor = async (request, signal) => {
    executions++; const result = await native(request, signal); afterExecution?.(); return result;
  };
  let adapter: ReturnType<typeof createTelegramAdapter>;
  const actions = createGroupActions(store, { executor, async refreshRole(actorId, groupId) {
    const role = await adapter.verifyMember(groupId.slice(3), actorId.slice(8));
    store.syncTelegramMember(groupId.slice(3), actorId.slice(8), role);
  } });
  const binding = createTelegramBinding(store, actions);
  const makeAdapter = () => createTelegramAdapter({ token: '000:OFFLINE_TEST_ONLY', adminIds: [12], binding,
    rateLimit: false, apiTransformer: api, onError: code => errors.push(code) });
  adapter = makeAdapter(); assert.equal(calls.length, 0); assert.equal(await adapter.init(), true);
  t.after(async () => {
    actions.close(); await adapter.stop(); await native.dispose(); store.close();
    assert.equal(models.mock.callCount(), 0); assert.equal(network.mock.callCount(), 0);
  });
  await adapter.handleUpdate(message(1, '/register', 11));
  assert.equal(store.group('tg:-1001', 'tg-user:11')?.role, 'admin');
  return { store, actions, binding, roles, calls, errors, commands, tools, models, network,
    get adapter() { return adapter; },
    async recreateAdapter() { await adapter.stop(); adapter = makeAdapter(); assert.equal(await adapter.init(), true); },
    get executions() { return executions; }, get sends() { return calls.filter(call => call.method === 'sendMessage'); },
    set failSend(value: boolean) { failSend = value; }, set afterExecution(value: (() => void) | undefined) { afterExecution = value; },
    set afterMemberLookup(value: ((userId: number) => void) | undefined) { afterMemberLookup = value; },
  };
}
function button(payload: Record<string, unknown>) {
  return (payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard[0][0].callback_data;
}

test('OFFLINE INTEGRATION: real rules CAS → English native DSH → persistent duplicate execution/delivery protection', async t => {
  const sim = await integration(t);
  await sim.adapter.handleUpdate(message(2, '/rules English; command; 去重并排序; 最多10条', 11));
  const data = button(sim.sends.at(-1)!.payload); const id = data.slice('gw:activate:'.length);
  assert.equal(sim.store.proposal(id)?.status, 'pending');
  assert.equal(sim.store.group('tg:-1001', 'tg-user:11')?.version, 1);
  await sim.adapter.handleUpdate(callback(3, data, 13));
  assert.equal(sim.store.proposal(id)?.status, 'pending'); // Another real group admin is not the creator.
  await sim.adapter.handleUpdate(callback(4, data));
  assert.equal(sim.store.proposal(id)?.status, 'active');
  assert.equal(sim.store.group('tg:-1001', 'tg-user:11')?.config.language, 'en');
  assert.match(String(sim.sends.at(-1)!.payload.text), /Group rules activated/);
  const baseline = sim.sends.length;
  const update = message(5, '/links https://B.example/b https://a.example/a https://b.example/b');
  await sim.adapter.handleUpdate(update); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.commands.mock.callCount(), 1); assert.equal(sim.tools.mock.callCount(), 1);
  assert.equal(sim.sends.length, baseline + 1);
  assert.equal(sim.sends.at(-1)!.payload.text, 'Organized result: 2 links\n\n1. https://a.example/a\n2. https://b.example/b');
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:5:105')!;
  assert.equal(row.task?.status, 'succeeded'); assert.equal(row.task?.configVersion, 2); assert.equal(row.task?.modelCalls, 0);
  assert.equal(row.task?.creatorId, 'tg-user:12'); assert.equal(row.task?.audience, 'group');
  await sim.recreateAdapter(); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline + 1);
  const audits = sim.store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' });
  assert.equal(audits.filter(row => row.action === 'delivery.sent').length, 1);
  assert.equal(sim.models.mock.callCount(), 0); assert.equal(sim.network.mock.callCount(), 0);
});

test('OFFLINE INTEGRATION: current-role revocation clears stored membership and suppresses a completed native result', async t => {
  const sim = await integration(t); const baseline = sim.sends.length;
  sim.afterExecution = () => { sim.roles.set(12, 'left'); };
  const update = message(10, '/links https://synthetic.example/');
  await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline);
  assert.equal(sim.store.role('tg-user:12', 'tg:-1001'), undefined);
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:10:110')!;
  assert.equal(row.task?.status, 'blocked'); assert.equal(row.task?.output, '');
  assert.ok(sim.store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' }).some(row => row.action === 'delivery.withheld'));
  await sim.adapter.handleUpdate(message(11, '/links https://another.example/'));
  assert.equal(sim.executions, 1); // Cached previous membership cannot authorize a new request.
  sim.roles.set(12, 'member'); sim.afterExecution = undefined;
  await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline); // Rejoining does not replay the blocked task.
  sim.roles.set(11, 'member');
  await sim.adapter.handleUpdate(message(12, '/rules English', 11));
  assert.equal(sim.store.role('tg-user:11', 'tg:-1001'), 'member');
  await assert.rejects(sim.actions.getGroup('tg-user:11', 'tg:-1001', true), { code: 'MANAGER_REQUIRED' });
});

test('OFFLINE INTEGRATION: actual mention configuration changes triggering; unknown delivery remains terminal', async t => {
  const sim = await integration(t);
  await sim.adapter.handleUpdate(message(20, '/rules English; mention', 11));
  await sim.adapter.handleUpdate(callback(21, button(sim.sends.at(-1)!.payload)));
  await sim.adapter.handleUpdate(message(22, '/links https://synthetic.example/'));
  assert.equal(sim.executions, 0); assert.match(String(sim.sends.at(-1)!.payload.text), /explicit mention/);
  const baseline = sim.sends.length; sim.failSend = true;
  const update = message(23, '@OfflineBot https://synthetic.example/');
  await sim.adapter.handleUpdate(update); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline + 1);
  assert.ok(sim.errors.includes('TELEGRAM_DELIVERY_OUTCOME_UNKNOWN'));
  assert.ok(sim.store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' }).some(row => row.action === 'delivery.unknown'));
  sim.failSend = false; await sim.recreateAdapter(); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline + 1);
});

test('OFFLINE INTEGRATION: no valid links produces one fixed failure notice, never raw errors or duplicate execution', async t => {
  const sim = await integration(t); const baseline = sim.sends.length;
  const update = message(30, '/links SYNTHETIC_PRIVATE_INPUT_WITH_NO_URL');
  await sim.adapter.handleUpdate(update); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline + 1);
  assert.equal(sim.sends.at(-1)!.payload.text, '任务未成功完成，未投递业务结果。');
  assert.doesNotMatch(String(sim.sends.at(-1)!.payload.text), /SYNTHETIC_PRIVATE_INPUT|NO_LINKS|NativeInputError/);
  const row = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:30:130')!;
  assert.equal(row.task?.status, 'failed'); assert.equal(row.task?.output, ''); assert.equal(row.task?.modelCalls, 0);
  await sim.recreateAdapter(); await sim.adapter.handleUpdate(update);
  assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline + 1);
});

test('OFFLINE INTEGRATION: platform stop during the role check after delivery claim withholds the stored successful task', async t => {
  const sim = await integration(t); const baseline = sim.sends.length;
  let claimed = false;
  const claim = sim.binding.claimDelivery.bind(sim.binding);
  sim.binding.claimDelivery = async (...args) => { const result = await claim(...args); claimed = result; return result; };
  sim.afterMemberLookup = id => { if (claimed && id === 12) sim.store.setPluginEnabled('link-cleaner', false); };
  await sim.adapter.handleUpdate(message(40, '/links https://synthetic.example/'));
  assert.equal(claimed, true); assert.equal(sim.executions, 1); assert.equal(sim.sends.length, baseline);
  const task = sim.store.reservation('tg:-1001', 'tg-user:12', 'telegram:40:140')!.task!;
  assert.equal(task.status, 'succeeded'); assert.equal(sim.store.plugin('link-cleaner')!.enabled, false);
  assert.ok(sim.store.group('tg:-1001', 'tg-user:11')!.config.features.includes('link-cleaner'));
  assert.ok(sim.store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' }).some(row => row.action === 'delivery.withheld'));
  await sim.adapter.handleUpdate(message(40, '/links https://synthetic.example/'));
  assert.equal(sim.executions, 1); // The original business task is never rerun.
});

test('OFFLINE INTEGRATION: discovery respects real platform/group gates and does not disclose revoked admin settings', async t => {
  const sim = await integration(t);
  await sim.adapter.handleUpdate(message(50, '/plugins', 12));
  assert.match(String(sim.sends.at(-1)!.payload.text), /\/links https:/);
  sim.store.setPluginEnabled('link-cleaner', false);
  await sim.adapter.handleUpdate(message(51, '/plugins', 12));
  assert.match(String(sim.sends.at(-1)!.payload.text), /暂无可用功能/);
  assert.doesNotMatch(String(sim.sends.at(-1)!.payload.text), /\/links/);
  assert.ok(sim.store.group('tg:-1001', 'tg-user:11')!.config.features.includes('link-cleaner'));
  sim.store.setPluginEnabled('link-cleaner', true);
  await sim.adapter.handleUpdate(message(52, '/rules 关闭链接整理', 11));
  await sim.adapter.handleUpdate(callback(53, button(sim.sends.at(-1)!.payload)));
  await sim.adapter.handleUpdate(message(54, '/plugins', 12));
  assert.match(String(sim.sends.at(-1)!.payload.text), /暂无可用功能/);
  const baseline = sim.sends.length;
  sim.afterMemberLookup = id => { if (id === 11) sim.roles.set(11, 'left'); };
  await sim.adapter.handleUpdate(message(55, '/settings', 11));
  assert.equal(sim.sends.length, baseline);
  assert.equal(sim.store.role('tg-user:11', 'tg:-1001'), undefined);
  assert.equal(sim.executions, 0); assert.equal(sim.commands.mock.callCount(), 0); assert.equal(sim.tools.mock.callCount(), 0);
});

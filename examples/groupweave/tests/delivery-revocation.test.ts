import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { buildApp } from '../src/server/app.js';
import { createAiExecutor } from '../src/server/ai.js';
import { createKoishiCodeHost } from '../src/server/koishi.js';
import { createNativeExecutor } from '../src/server/native.js';
import { runLinkCodeTool } from '../src/server/mixed.js';
import { createTelegramAdapter } from '../src/server/telegram.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';
import { Store } from '../src/server/store.js';
import type { GroupConfig, Task } from '../src/shared.js';

const info = { id: 9000, is_bot: true, first_name: 'Offline bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
const chat = { id: -1001, type: 'supergroup' as const, title: 'Offline group' };
const ECHO = 'delivery-revocation-fixture';
const ANSWER = 'Assistant fixture: ';
function command(id: number, text: string): Update {
  const name = /^\/[a-z]+/.exec(text)![0];
  return { update_id: id, message: { message_id: id + 100, date: 1, from: { id: 12, is_bot: false, first_name: 'Offline member' },
    chat, text, entities: [{ type: 'bot_command', offset: 0, length: name.length }] } } as Update;
}
async function* textResponse(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}
class DeliveryAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const result = options.messages.find(message => message.role === 'tool');
    if (result || !options.tools?.length) {
      yield* textResponse(ANSWER + (result?.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? 'direct response'));
      return;
    }
    assert.deepEqual(options.tools.map(tool => tool.name), ['organize_links']);
    const id = ToolCallId('offline-delivery-code');
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id, name: 'organize_links', argumentsDelta: '{}' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'organize_links', arguments: '{}' } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
}

/** Real actions/SQLite/native DSH/Koishi and binding; every Telegram API is synthetic. */
async function fixture(t: TestContext, allowLinks = true) {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('LIVE NETWORK FORBIDDEN'); });
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-delivery-revocation-'));
  const code = createKoishiCodeHost(); const native = createNativeExecutor(code); const model = new DeliveryAdapter();
  let app!: Awaited<ReturnType<typeof buildApp>>;
  const ai = createAiExecutor({ enabled: true, apiKey: 'offline-not-a-secret', dataDir, workflow: 'assistant' }, {
    adapter: model, codeTool: { execute: (request, signal) => runLinkCodeTool(app.groupweave.store, app.groupweave.actions, code, request, signal, 'assistant') },
  });
  let adapter!: ReturnType<typeof createTelegramAdapter>;
  app = await buildApp({ preview: false, dataDir, executor: native,
    echoExecutor: (request, signal) => code.executeEcho(request, signal),
    assistantExecutor: (request, signal) => ai.execute({ actorId: request.actorId, groupId: request.groupId, input: request.input,
      options: { language: request.options.language ?? 'zh' },
      allowLinkTool: (request.options as typeof request.options & { allowLinkTool?: boolean }).allowLinkTool === true,
      codeOptions: { deduplicate: request.options.deduplicate, sort: request.options.sort, maxItems: request.options.maxItems },
    }, signal),
    async refreshRole(actorId, groupId) {
      const role = await adapter.verifyMember(groupId.slice(3), actorId.slice(8));
      app.groupweave.store.syncTelegramMember(groupId.slice(3), actorId.slice(8), role);
    },
    async beforeClose() { await adapter.stop(); await native.dispose(); await ai.dispose(); await code.dispose(); },
  });
  const { store, actions } = app.groupweave;
  const original = createTelegramBinding(store, actions);
  let enter!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let claimedTaskId: string | undefined; let gated = false;
  const binding = { ...original, async claimDelivery(actor: Parameters<typeof original.claimDelivery>[0], id: string) {
    const claimed = await original.claimDelivery(actor, id);
    if (claimed) claimedTaskId = id;
    return claimed;
  } };
  const messages = new Map<number, Message>(); const sent: Message[] = []; const errors: string[] = [];
  const api: Transformer = async (_previous, method, value) => {
    const payload = value as Record<string, unknown>; let result: unknown;
    if (method === 'getMe') result = info;
    else if (method === 'getChat') result = chat;
    else if (method === 'getChatMember') {
      const id = Number(payload.user_id);
      // This is the actual post-claim identity lookup before the network send.
      if (claimedTaskId && id === 12 && !gated) { gated = true; enter(); await gate; }
      result = { user: { id, is_bot: id === info.id, first_name: 'Offline member' }, status: id === info.id || id === 11 ? 'administrator' : 'member' };
    } else if (method === 'sendMessage') {
      const replied = (payload.reply_parameters as { message_id: number } | undefined)?.message_id;
      result = { message_id: 1000 + sent.length, date: 1, from: info, chat, text: payload.text,
        ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}), ...(replied ? { reply_to_message: messages.get(replied) } : {}) };
      sent.push(result as Message); messages.set((result as Message).message_id, result as Message);
    } else if (method === 'answerCallbackQuery') result = true;
    else throw new Error(`Unexpected synthetic API: ${method}`);
    return { ok: true, result } as never;
  };
  adapter = createTelegramAdapter({ token: '000:OFFLINE_REVIEW_ONLY', adminIds: [99], binding, apiTransformer: api,
    rateLimit: false, onError: code => errors.push(code) });
  await adapter.init();
  store.registerTelegramGroup({ chatId: -1001, title: chat.title, userId: 11 });
  store.setPluginEnabled('assistant', true);
  async function configure(patch: Partial<GroupConfig>) {
    const group = await actions.getGroup('tg-user:11', 'tg:-1001', true);
    const proposal = await actions.previewRules('tg-user:11', group.id, { baseVersion: group.version, config: patch });
    assert.deepEqual(proposal.warnings, []); await actions.activateRules('tg-user:11', proposal.id);
  }
  await configure({ features: ['echo', 'assistant', ...(allowLinks ? ['link-cleaner'] : [])] });
  const pending: Promise<unknown>[] = [];
  t.after(async () => {
    release(); await Promise.allSettled(pending); await app.close(); await rm(dataDir, { recursive: true, force: true });
    assert.equal(network.mock.callCount(), 0);
  });
  async function begin(feature: 'echo' | 'assistant' = 'echo') {
    const update = command(10, feature === 'echo' ? `/echo ${ECHO}` : '/ask 整理这些链接 https://a.example/a https://a.example/a');
    messages.set(update.message!.message_id, update.message!);
    let executing: Promise<unknown>;
    if (feature === 'echo') executing = adapter.handleUpdate(update);
    else {
      await adapter.handleUpdate(update);
      const confirmation = sent.at(-1)!;
      const data = (confirmation.reply_markup!.inline_keyboard[0][0] as { callback_data: string }).callback_data;
      executing = adapter.handleUpdate({ update_id: 11, callback_query: { id: 'offline-confirm', chat_instance: 'offline', data,
        from: { id: 12, is_bot: false, first_name: 'Offline member' }, message: confirmation } } as Update);
    }
    pending.push(executing);
    await Promise.race([started, executing.then(() => { throw new Error('Task did not reach the post-claim identity barrier.'); })]);
    assert.ok(claimedTaskId); assert.equal(store.task(claimedTaskId!)?.task?.status, 'succeeded');
    return { pending: executing };
  }
  const business = () => sent.filter(message => message.text === ECHO || message.text?.startsWith(ANSWER));
  const delivery = () => store.auditRecords({ actorId: 'tg-user:11', groupId: 'tg:-1001' })
    .find(record => record.targetId === claimedTaskId && record.action.startsWith('delivery.') && record.action !== 'delivery.claim')?.outcome;
  return { store, actions, binding, configure, begin, release, business, delivery, model,
    get task() { return claimedTaskId ? store.task(claimedTaskId)?.task : undefined; }, errors };
}

test('post-claim platform disable/re-enable cannot revive an old Echo delivery', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin();
  sim.store.setPluginEnabled('echo', false); sim.actions.stopFeature('echo'); sim.store.setPluginEnabled('echo', true);
  sim.release(); await pending;
  assert.equal(sim.business().length, 0); assert.equal(sim.delivery(), 'withheld');
});

test('post-claim group feature removal/re-addition cannot revive an old Echo delivery', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin();
  await sim.configure({ features: ['assistant', 'link-cleaner'] });
  await sim.configure({ features: ['echo', 'assistant', 'link-cleaner'] });
  sim.release(); await pending;
  assert.equal(sim.business().length, 0); assert.equal(sim.delivery(), 'withheld');
});

test('post-claim platform disable/re-enable cannot revive a completed native assistant delivery', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin('assistant');
  assert.deepEqual([sim.task?.modelCalls, sim.task?.toolCalls], [2, 1]);
  sim.store.setPluginEnabled('assistant', false); sim.actions.stopFeature('assistant'); sim.store.setPluginEnabled('assistant', true);
  sim.release(); await pending;
  assert.equal(sim.business().length, 0); assert.equal(sim.delivery(), 'withheld'); assert.equal(sim.model.requests.length, 2);
});

test('post-claim platform link dependency disable/re-enable withholds an assistant code result', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin('assistant');
  assert.deepEqual([sim.task?.modelCalls, sim.task?.toolCalls], [2, 1]);
  sim.store.setPluginEnabled('link-cleaner', false); sim.actions.stopFeature('link-cleaner'); sim.store.setPluginEnabled('link-cleaner', true);
  sim.release(); await pending;
  assert.equal(sim.business().length, 0); assert.equal(sim.delivery(), 'withheld'); assert.equal(sim.model.requests.length, 2);
});

test('post-claim group link dependency removal/re-addition withholds an assistant code result', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin('assistant');
  assert.deepEqual([sim.task?.modelCalls, sim.task?.toolCalls], [2, 1]);
  await sim.configure({ features: ['echo', 'assistant'] });
  await sim.configure({ features: ['echo', 'assistant', 'link-cleaner'] });
  sim.release(); await pending;
  assert.equal(sim.business().length, 0); assert.equal(sim.delivery(), 'withheld'); assert.equal(sim.model.requests.length, 2);
});

test('post-claim ordinary parameter changes keep authorized Echo delivery and its original task snapshot', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin();
  const originalVersion = sim.task!.configVersion;
  await sim.configure({ maxItems: 1, sort: true });
  sim.release(); await pending;
  assert.equal(sim.business().length, 1); assert.equal(sim.delivery(), 'sent'); assert.equal(sim.task!.configVersion, originalVersion);
});

test('post-claim link changes do not revoke a text-only assistant task that never had a link capability', { timeout: 15_000 }, async t => {
  const sim = await fixture(t, false); const { pending } = await sim.begin('assistant');
  assert.deepEqual([sim.task?.modelCalls, sim.task?.toolCalls], [1, 0]);
  sim.store.setPluginEnabled('link-cleaner', false); sim.actions.stopFeature('link-cleaner'); sim.store.setPluginEnabled('link-cleaner', true);
  await sim.configure({ features: ['echo', 'assistant', 'link-cleaner'] });
  sim.release(); await pending;
  assert.equal(sim.business().length, 1); assert.equal(sim.delivery(), 'sent'); assert.equal(sim.model.requests.length, 1);
});

test('legacy group/plugin metadata starts at zero and actual grant transitions revoke old task snapshots', () => {
  const store = new Store();
  try {
    assert.equal(store.group('group-a', 'member')!.featureVersions, undefined);
    assert.equal(store.plugin('link-cleaner')!.authorizationVersion, undefined);
    assert.deepEqual(store.permissionVersions('group-a', 'link-cleaner'), { platformVersion: 0, groupVersion: 0 });
    const task: Task = { id: 'legacy-metadata-new-task', groupId: 'group-a', creatorId: 'member', featureId: 'link-cleaner',
      audience: 'private', status: 'succeeded', configVersion: 1, createdAt: new Date().toISOString(), durationMs: 0,
      input: 'https://a.example/a', output: 'https://a.example/a', modelCalls: 0, authorization: store.permissionVersions('group-a', 'link-cleaner') };
    assert.equal(store.taskAuthorized(task), true);
    store.setPluginEnabled('link-cleaner', true); store.setPluginAvailability('link-cleaner', true);
    assert.equal(store.taskAuthorized(task), true);
    store.setPluginEnabled('link-cleaner', false); store.setPluginEnabled('link-cleaner', true);
    assert.equal(store.taskAuthorized(task), false);
    assert.equal(store.taskAuthorized({ ...task, authorization: store.permissionVersions('group-a', 'link-cleaner') }), true);
  } finally { store.close(); }
});

test('legacy completed records stay readable but cannot acquire delivery authority without a task snapshot', { timeout: 15_000 }, async t => {
  const sim = await fixture(t); const { pending } = await sim.begin(); sim.release(); await pending;
  const legacy: Task = { ...sim.task!, id: 'legacy-without-authorization', authorization: undefined };
  sim.store.reserveTask(legacy, 'legacy-without-authorization', 'legacy-hash'); assert.equal(sim.store.finishTask(legacy), true);
  assert.ok(sim.store.tasks('tg:-1001', 'tg-user:12').some(task => task.id === legacy.id && task.output === ECHO));
  const actor = { groupId: '-1001', userId: '12', role: 'member' as const };
  assert.equal(await sim.binding.claimDelivery(actor, legacy.id), false);
  assert.equal(sim.binding.deliveryStillAuthorized!(actor, legacy.id), false);
  assert.equal(sim.business().length, 1);
});

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Transformer } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { createGroupActions } from '../src/server/actions.js';
import { Store } from '../src/server/store.js';
import { createTelegramAdapter } from '../src/server/telegram.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';

const botInfo = { id: 9000, is_bot: true, first_name: 'Offline Bot', username: 'OfflineBot', can_join_groups: true,
  can_read_all_group_messages: true, supports_inline_queries: false };
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function waitFor<T>(promise: Promise<T>, timeoutMs = 1_000, label = 'event'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`OFFLINE TEST TIMEOUT: ${label}`)), timeoutMs);
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}
function firstCallbackData(message: Message): string {
  const button = message.reply_markup?.inline_keyboard[0]?.[0];
  assert.ok(button && 'callback_data' in button && typeof button.callback_data === 'string');
  return button.callback_data;
}

test('OFFLINE runner: a real polling cancel update enters during a held digest and shutdown drains the late result', async t => {
  const realFetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('REAL NETWORK FORBIDDEN'); });
  const store = new Store();
  store.registerTelegramGroup({ chatId: -1001, title: 'Offline runner group', userId: 12 });
  store.syncTelegramMember(-1001, 12, 'admin');
  store.setPluginAvailability('digest', true);
  store.setPluginEnabled('digest', true);
  let adapter!: ReturnType<typeof createTelegramAdapter>;
  let executorSignal: AbortSignal | undefined;
  const actions = createGroupActions(store, {
    executor: async () => ({ output: 'UNEXPECTED CODE RESULT', modelCalls: 0 }),
    aiExecutor: async (_request, signal) => {
      executorEntered.resolve();
      executorSignal = signal;
      signal?.addEventListener('abort', () => executorAborted.resolve(), { once: true });
      return lateResult.promise;
    },
    async refreshRole(actorId, groupId) {
      const userId = actorId.slice('tg-user:'.length);
      store.syncTelegramMember(groupId.slice(3), userId, 'admin');
    },
  });
  const binding = createTelegramBinding(store, actions);
  const actor = 'tg-user:12';
  const proposal = await actions.previewRules(actor, 'tg:-1001', { text: '开启摘要', baseVersion: 1 });
  await actions.activateRules(actor, proposal.id);

  const queue: Update[] = [];
  let wakeQueue: (() => void) | undefined;
  const executorEntered = deferred<void>();
  const executorAborted = deferred<void>();
  const lateResult = deferred<{ output: string; modelCalls: number }>();
  const confirmationReady = deferred<Message>();
  const processingReady = deferred<Message>();
  const cancelAnswered = deferred<string>();
  const inputMessages = new Map<number, Message>();
  const sent: Message[] = [];
  let pollCalls = 0;
  let webhookDeletes = 0;

  function push(update: Update) {
    queue.push(update);
    wakeQueue?.();
    wakeQueue = undefined;
  }
  async function nextUpdateFromQueue(signal?: AbortSignal): Promise<Update[]> {
    pollCalls++;
    while (!queue.length) {
      if (signal?.aborted) throw signal.reason;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { signal?.removeEventListener('abort', onAbort); reject(signal?.reason); };
        wakeQueue = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    const update = queue.shift()!;
    return [update];
  }

  const api: Transformer = async (_previous, method, raw, signal) => {
    const payload = raw as Record<string, unknown>;
    let result: unknown;
    if (method === 'getMe') result = botInfo;
    else if (method === 'deleteWebhook') { webhookDeletes++; result = true; }
    else if (method === 'getUpdates') result = await nextUpdateFromQueue(signal as unknown as AbortSignal | undefined);
    else if (method === 'getChat') result = { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline runner group' };
    else if (method === 'getChatMember') {
      const id = Number(payload.user_id);
      result = { user: { id, is_bot: id === botInfo.id, first_name: 'Offline tester' }, status: id === botInfo.id || id === 12 ? 'administrator' : 'left' };
    } else if (method === 'sendMessage') {
      const markup = payload.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
      const replyTo = (payload.reply_parameters as { message_id?: number } | undefined)?.message_id;
      const message: Message = { message_id: 1000 + sent.length, date: 1, from: botInfo,
        chat: { id: Number(payload.chat_id), type: 'supergroup', title: 'Offline runner group' }, text: String(payload.text),
        ...(replyTo && inputMessages.has(replyTo) ? { reply_to_message: inputMessages.get(replyTo) } : {}),
        ...(markup ? { reply_markup: markup } : {}) } as Message;
      sent.push(message);
      if (replyTo) inputMessages.set(message.message_id, message);
      const callbackData = markup?.inline_keyboard?.[0]?.[0]?.callback_data;
      if (callbackData?.startsWith('gw:c:')) processingReady.resolve(message);
      else if (callbackData) confirmationReady.resolve(message);
      result = message;
    } else if (method === 'answerCallbackQuery') {
      const text = String(payload.text ?? '');
      if (payload.callback_query_id === 'offline-cancel') cancelAnswered.resolve(text);
      result = true;
    } else throw new Error(`UNEXPECTED OFFLINE API METHOD ${method}`);
    return { ok: true, result } as never;
  };

  adapter = createTelegramAdapter({ token: '000:OFFLINE_ONLY', adminIds: [99], binding,
    rateLimit: false, apiTransformer: api });
  const command: Update = { update_id: 1, message: { message_id: 101, date: 1,
    from: { id: 12, is_bot: false, first_name: 'Offline tester' },
    chat: { id: -1001, type: 'supergroup', title: 'Offline runner group' }, text: '/digest synthetic prompt',
    entities: [{ type: 'bot_command', offset: 0, length: 7 }] } } as Update;
  inputMessages.set(101, command.message as Message);

  let stopped = false;
  try {
    assert.equal(await adapter.init(), true);
    const launchResult = adapter.launch();
    const duplicateLaunch = adapter.launch();
    push(command);
    const confirmation = await waitFor(confirmationReady.promise, 1_000, 'digest confirmation');
    const consent = firstCallbackData(confirmation);
    const original = confirmation.reply_to_message!;
    push({ update_id: 2, callback_query: { id: 'offline-consent', chat_instance: 'offline', data: consent,
      from: { id: 12, is_bot: false, first_name: 'Offline tester' }, message: confirmation } } as Update);
    const processing = await waitFor(processingReady.promise, 1_000, 'processing response');
    await waitFor(executorEntered.promise, 1_000, 'executor start');
    const cancelData = firstCallbackData(processing);
    assert.ok(cancelData.startsWith('gw:c:'));
    assert.ok(original);
    push({ update_id: 3, callback_query: { id: 'offline-cancel', chat_instance: 'offline', data: cancelData,
      from: { id: 12, is_bot: false, first_name: 'Offline tester' }, message: processing } } as Update);

    // This is the regression assertion: with bot.start(), the current long
    // AI update owns the polling loop, so this acknowledgement cannot arrive.
    const cancelText = await waitFor(cancelAnswered.promise, 500, 'cancel callback response');
    assert.match(cancelText, /取消本人在本群的进行中任务：1|Cancellation requested for your active tasks in this group: 1/i);
    assert.equal(executorSignal?.aborted, true);
    await waitFor(executorAborted.promise, 1_000, 'executor abort signal');
    assert.equal(sent.some(message => message.text === 'UNEXPECTED LATE DIGEST RESULT'), false);
    assert.equal(webhookDeletes, 1);

    // launch() is idempotently running, not an additional poller.
    assert.equal(adapter.status.polling, true);
    const shutdown = adapter.stop().then(() => { stopped = true; });
    const duplicateShutdown = adapter.stop();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false); // Runner stop waits for every active handler.
    lateResult.resolve({ output: 'UNEXPECTED LATE DIGEST RESULT', modelCalls: 1 });
    await waitFor(shutdown, 1_000, 'shutdown drain');
    await waitFor(duplicateShutdown, 1_000, 'idempotent shutdown');
    await waitFor(launchResult, 1_000, 'launch completion');
    await waitFor(duplicateLaunch, 1_000, 'idempotent launch');
    assert.equal(stopped, true);
    assert.equal(adapter.status.polling, false);
    assert.equal(sent.some(message => message.text === 'UNEXPECTED LATE DIGEST RESULT'), false);
    const rows = store.tasks('tg:-1001', actor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'blocked');
    assert.equal(rows[0].output, '');
    assert.ok(pollCalls >= 3); // The cancel update was fetched while the digest handler was still active.
    assert.equal(webhookDeletes, 1);
  } finally {
    lateResult.resolve({ output: 'UNEXPECTED LATE DIGEST RESULT', modelCalls: 1 });
    wakeQueue?.();
    if (!stopped) await adapter.stop();
    actions.close();
    store.close();
    assert.equal(realFetch.mock.callCount(), 0);
  }
});

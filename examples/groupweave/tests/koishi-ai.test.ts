import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Context } from 'koishi';
import { Store } from '../src/server/store.js';
import { createGroupActions } from '../src/server/actions.js';
import { createTelegramBinding } from '../src/server/telegram-binding.js';
import { installAiCommands } from '../src/server/koishi-ai.js';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { AD_REVIEW_PREFIX } from '../src/server/ad-review.js';

const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');
const chatId = '-100123';
const userId = '42';

class FakeTelegramBot extends Bot<Context> {
  sent: any[] = [];
  private readonly botList: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'telegram'); this.botList = ctx.bots; this.platform = 'telegram'; this.selfId = '99'; this.user = { id: '99', name: 'testbot' } as any; }
  override async start() {}
  override async stop() {}
  override async dispose() { const i = this.botList.findIndex(bot => bot.sn === this.sn); if (i >= 0) this.botList.splice(i, 1); }
  override async sendMessage(_channelId: string, content: any) { this.sent.push(content); return [`receipt-${this.sent.length}`]; }
}

function getButton(node: any): string | undefined {
  if (!node) return;
  if (Array.isArray(node)) { for (const child of node) { const result = getButton(child); if (result) return result; } return; }
  if (node.attrs?.id && node.type === 'button') return node.attrs.id;
  if (node.children) return getButton(node.children);
}

function contents(node: any): string {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(contents).join('');
  if (node.type === 'text') return node.attrs?.content ?? '';
  return contents(node.children);
}

async function fixture(t: test.TestContext, configured = true, responseMode: 'command' | 'mention' = 'command') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-ai-'));
  const configPath = path.join(dir, 'koishi.yml'); await writeFile(configPath, 'plugins: {}\n');
  const store = new Store();
  store.registerTelegramGroup({ chatId, title: 'AI Test', userId });
  store.syncTelegramMember(chatId, userId, 'admin');
  for (const id of ['link-cleaner', 'assistant', 'digest', 'link-brief']) { store.setPluginEnabled(id, true); store.setPluginAvailability(id, true); }
  const actions = createGroupActions(store, {
    async refreshRole(actorId, groupId) { store.syncTelegramMember(groupId.slice(3), actorId.slice('tg-user:'.length), 'admin'); },
    async aiExecutor(request) { return { output: `DIGEST:${request.input}`, modelCalls: 1 }; },
    async assistantExecutor(request) { if (failAssistant) throw new Error('synthetic failure'); return { output: `ANSWER:${request.input}\n${'🙂'.repeat(1900)}`, modelCalls: 1, toolCalls: 0 }; },
    async mixedExecutor(request) { return { output: `BRIEF:${request.input}`, modelCalls: 1, toolCalls: 1 }; },
  });
  let failAssistant = false;
  const actor = { groupId: chatId, userId, role: 'admin' as const };
  const initial = await createTelegramBinding(store, actions).getGroup(actor);
  assert.ok(initial);
  const proposal = await actions.previewRules(`tg-user:${userId}`, `tg:${chatId}`, { config: { features: ['link-cleaner', 'assistant', 'digest', 'link-brief'], responseMode }, baseVersion: initial.version });
  await actions.activateRules(`tg-user:${userId}`, proposal.id);
  let bot!: FakeTelegramBot;
  let binding!: ReturnType<typeof createTelegramBinding>;
  let onButton: ((session: any) => Promise<void>) | undefined;
  let onMessage: ((session: any) => Promise<void>) | undefined;
  const runtime = await createKoishiRuntime({ configPath, setup(ctx) {
    ctx.plugin(FakeTelegramBot as any);
    ctx.plugin((inner: Context) => {
      bot = inner.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
      binding = createTelegramBinding(store, actions);
      const nativeOn = inner.on.bind(inner);
      inner.on = ((name: string, callback: any, ...rest: any[]) => {
        if (name === 'interaction/button') onButton = callback;
        if (name === 'message') onMessage = callback;
        return nativeOn(name as any, callback, ...rest);
      }) as any;
      installAiCommands(inner, binding, { configured, privateBinding: createTelegramBinding(store, actions, { scope: 'private' }) });
    });
  } });
  await runtime.start();
  bot = runtime.app.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
  const makeRaw = (id: number, text: string, entityLength = text.split(' ')[0]!.length) => ({ update_id: id + 1000,
    message: { message_id: id, date: 1, from: { id: Number(userId), is_bot: false, first_name: 'Member' },
      chat: { id: Number(chatId), type: 'supergroup', title: 'AI Test' }, text,
      entities: [{ type: 'bot_command', offset: 0, length: entityLength }] } });
  const makeSession = (raw: any, type = 'interaction/command') => {
    const session = bot.session({ type, platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
      guild: { id: chatId, name: 'AI Test' }, channel: { id: chatId, type: 0 },
      message: { id: String(raw.message?.message_id ?? 1), content: raw.message?.text ?? '', elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    return session;
  };
  const run = async (name: string, raw: any) => makeSession(raw).execute(name, true);
  const button = async (token: string, id: number, original: any, topic: 'callback' | 'original' | false = false) => {
    if (topic === 'original') original.is_topic_message = true;
    const callbackRaw = { update_id: id + 1000, callback_query: { id: `cb-${id}`, from: { id: Number(userId), is_bot: false }, data: token,
      message: { message_id: id, message_thread_id: id + 100, ...(topic === 'callback' ? { is_topic_message: true } : {}),
        from: { id: 99, is_bot: true }, chat: { id: Number(chatId), type: 'supergroup' }, reply_to_message: original } } };
    const session: any = { platform: 'telegram', type: 'interaction/button', user: { id: userId }, guildId: chatId, channelId: chatId,
      event: { user: { id: userId }, _data: callbackRaw }, bot: { user: { id: '99', name: 'testbot' } },
      async send(content: any) { return bot.sendMessage(chatId, content); } };
    await onButton!(session);
  };
  const privateMessage = (id: number, owner: string, text: string) => {
    const raw = { update_id: id + 1000, message: { message_id: id, date: 1, from: { id: Number(owner), is_bot: false },
      chat: { id: Number(owner), type: 'private' }, text } };
    const session: any = bot.session({ type: 'message', platform: 'telegram', user: { id: owner, name: `User${owner}`, isBot: false },
      channel: { id: owner, type: 1 }, message: { id: String(id), content: text, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    return { raw, session };
  };
  const privateCommand = async (name: string, id: number, owner: string, text: string) => {
    const raw = { update_id: id + 1000, message: { message_id: id, date: 1, from: { id: Number(owner), is_bot: false },
      chat: { id: Number(owner), type: 'private' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } };
    const session: any = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: owner, name: `User${owner}`, isBot: false },
      channel: { id: owner, type: 1 }, message: { id: String(id), content: text, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    await session.execute(name, true);
    return raw;
  };
  const privateButton = async (token: string, id: number, owner: string, original: any) => {
    const callbackRaw = { update_id: id + 1000, callback_query: { id: `cb-${id}`, from: { id: Number(owner), is_bot: false }, data: token,
      message: { message_id: id, from: { id: 99, is_bot: true }, chat: { id: Number(owner), type: 'private' }, reply_to_message: original } } };
    const session: any = { platform: 'telegram', type: 'interaction/button', user: { id: owner }, channelId: owner,
      event: { user: { id: owner }, _data: callbackRaw }, bot: { user: { id: '99', name: 'testbot' } },
      async send(content: any) { return bot.sendMessage(owner, content); } };
    await onButton!(session);
  };
  t.after(async () => { await runtime.stop(); actions.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { run, makeRaw, button, privateMessage, privateCommand, privateButton, bot, store, binding, actions, get onMessage() { return onMessage; },
    set failAssistant(value: boolean) { failAssistant = value; }, get onButton() { return onButton; } };
}

test('native /ask asks for personal confirmation, chunks long output, and cannot replay', async t => {
  const f = await fixture(t);
  const raw = f.makeRaw(51, '/ask Explain this claim', 4);
  await f.run('ask Explain this claim', raw);
  const token = f.bot.sent.map(getButton).find(Boolean);
  assert.ok(token);
  assert.match(contents(f.bot.sent.at(-1)), /第三方 AI/);
  await f.button(token!, 80, raw.message);
  assert.equal(f.bot.sent.slice(-2).length, 2);
  assert.ok(f.bot.sent.slice(-2).every(message => contents(message).length <= 3_500));
  assert.ok(contents(f.bot.sent.at(-2)).startsWith('ANSWER:'));
  const request = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1051:51');
  assert.equal(request?.task?.input, 'Explain this claim');
  assert.equal(request?.task?.status, 'succeeded');
  const before = f.bot.sent.filter(message => contents(message).startsWith('ANSWER:')).length;
  await f.button(token!, 81, raw.message);
  assert.equal(f.bot.sent.filter(message => contents(message).startsWith('ANSWER:')).length, before);
});

test('group callbacks allow ordinary reply message_thread_id, but still reject actual topic messages', async t => {
  const f = await fixture(t);
  const ordinary = f.makeRaw(501, '/ask thread-shaped callback', 4);
  await f.run('ask thread-shaped callback', ordinary);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 502, ordinary.message);
  const completed = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1501:501')?.task;
  assert.equal(completed?.status, 'succeeded');

  for (const topic of ['callback', 'original'] as const) {
    const raw = f.makeRaw(topic === 'callback' ? 503 : 505, '/ask actual topic rejected', 4);
    await f.run('ask actual topic rejected', raw);
    const topicToken = f.bot.sent.map(getButton).filter(Boolean).at(-1);
    assert.ok(topicToken);
    await f.button(topicToken!, topic === 'callback' ? 504 : 506, raw.message, topic);
    const key = topic === 'callback' ? 'koishi-ai:1503:503' : 'koishi-ai:1505:505';
    assert.equal(f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, key), undefined);
  }
});

test('private AI confirmations route to distinct owner scopes without reading group data', async t => {
  const f = await fixture(t);
  const first = f.privateMessage(201, '43', 'Explain this privately');
  await f.onMessage!(first.session);
  const firstToken = f.bot.sent.map(getButton).find(Boolean);
  assert.ok(firstToken, 'ordinary private text only proposes confirmation');
  await f.privateButton(firstToken!, 301, '43', first.raw.message);
  const second = await f.privateCommand('ask Explain this privately too', 202, '44', '/ask Explain this privately too');
  const secondToken = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(secondToken);
  await f.privateButton(secondToken!, 302, '44', second.message);
  assert.equal(f.store.reservation('tg-dm:43', 'tg-user:43', 'koishi-ai:1201:201')?.task?.input, 'Explain this privately');
  assert.equal(f.store.reservation('tg-dm:44', 'tg-user:44', 'koishi-ai:1202:202')?.task?.input, 'Explain this privately too');
  assert.deepEqual(f.store.groups('tg-user:43'), []);
  assert.deepEqual(f.store.groups('tg-user:44'), []);
  assert.equal(f.store.reservation(`tg:${chatId}`, 'tg-user:43', 'koishi-ai:1201:201'), undefined);
  assert.equal(f.store.reservation(`tg:${chatId}`, 'tg-user:44', 'koishi-ai:1202:202'), undefined);
});

test('private cancellation reaches only the owning user execution and withholds its result', async t => {
  const store = new Store();
  store.setPluginEnabled('assistant', true); store.setPluginAvailability('assistant', true);
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const actions = createGroupActions(store, { assistantExecutor: async (_request, signal) => {
    markStarted();
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return { output: 'must not deliver', modelCalls: 1, toolCalls: 0 };
  } });
  t.after(() => { actions.close(); store.close(); });
  const binding = createTelegramBinding(store, actions, { scope: 'private' });
  const owner = { groupId: '43', userId: '43', role: 'member' as const };
  const other = { groupId: '44', userId: '44', role: 'member' as const };
  await binding.getGroup(other);
  const pending = binding.executeFeature!({ actor: owner, featureId: 'assistant', input: 'pending', audience: 'private',
    updateId: 1, messageId: 1, idempotencyKey: 'private-cancel', externalProcessingAcknowledged: true });
  await started;
  assert.equal(await binding.cancelOwnTasks!(other), 0);
  assert.equal(await binding.cancelOwnTasks!(owner), 1);
  const task = await pending;
  assert.notEqual(task.status, 'succeeded');
  assert.equal(task.output, '');
  assert.equal(await binding.claimDelivery(owner, task.id), false);
});

test('native /digest with no argument accepts only quoted same-group text and confirms once', async t => {
  const f = await fixture(t);
  const selected = { message_id: 61, chat: { id: Number(chatId), type: 'supergroup' },
    from: { id: 43, is_bot: false }, text: 'Quoted source text' };
  const raw = f.makeRaw(62, '/digest', 7); (raw.message as any).reply_to_message = selected;
  await f.run('digest', raw);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 90, selected);
  assert.ok(f.bot.sent.some(message => contents(message) === 'DIGEST:Quoted source text'));
});

test('native /digest can explicitly quote a same-group Bot result', async t => {
  const f = await fixture(t);
  const botResult = { message_id: 631, chat: { id: Number(chatId), type: 'supergroup' },
    from: { id: 99, is_bot: true }, text: 'A result the user chose to summarize' };
  const raw = f.makeRaw(632, '/digest', 7);
  (raw.message as any).reply_to_message = botResult;
  await f.run('digest Bot result', raw);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 633, botResult);
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1632:631')?.task;
  assert.equal(task?.input, botResult.text);
  assert.equal(task?.status, 'succeeded');
});

test('native /translate signs the target language and runs through the owner-only private assistant scope', async t => {
  const f = await fixture(t);
  const raw = { update_id: 1_600, message: { message_id: 600, date: 1,
    from: { id: Number(userId), is_bot: false }, chat: { id: Number(userId), type: 'private' },
    text: '/translate French Bonjour', entities: [{ type: 'bot_command', offset: 0, length: 10 }] } };
  const session: any = f.bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: userId, isBot: false },
    channel: { id: userId, type: 1 }, message: { id: '600', content: raw.message.text, elements: [] }, _data: raw } as any);
  session.setInternal('telegram', raw);
  await session.execute('translate French Bonjour', true);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.privateButton(token!, 601, userId, raw.message);
  const task = f.store.reservation(`tg-dm:${userId}`, `tg-user:${userId}`, 'koishi-ai:1600:600')?.task;
  assert.equal(task?.featureId, 'assistant');
  assert.match(task?.input ?? '', /Translate the following text into French/);
  assert.match(task?.input ?? '', /Bonjour/);
});

test('native /translate accepts an explicitly quoted multiword target and preserves source newlines', async t => {
  const f = await fixture(t);
  await f.privateCommand('translate "Traditional Chinese First line', 604, userId,
    '/translate "Traditional Chinese First line');
  assert.equal(f.bot.sent.map(getButton).filter(Boolean).length, 0, 'an unterminated target quote is rejected');
  const raw = await f.privateCommand('translate "Traditional Chinese" First line\nsecond line', 605, userId,
    '/translate "Traditional Chinese" First line\nsecond line');
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.privateButton(token!, 606, userId, raw.message);
  const task = f.store.reservation(`tg-dm:${userId}`, `tg-user:${userId}`, 'koishi-ai:1605:605')?.task;
  assert.equal(task?.input, 'Translate the following text into Traditional Chinese. Preserve its meaning and tone. Return only the translation.\n\nText:\nFirst line\nsecond line');
});

test('native /brief confirms and runs code-to-AI link explanation once in the group scope', async t => {
  const f = await fixture(t);
  const raw = f.makeRaw(611, '/brief Links to read: https://example.test/article', 6);
  await f.run('brief Links to read: https://example.test/article', raw);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 612, raw.message);
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1611:611')?.task;
  assert.equal(task?.featureId, 'link-brief');
  assert.equal(task?.status, 'succeeded');
  assert.equal(task?.modelCalls, 1);
  assert.equal(task?.toolCalls, 1);
  assert.ok(f.bot.sent.some(message => contents(message) === `BRIEF:${raw.message.text!.slice(7)}`));
});

test('native /brief can use one explicitly quoted same-group link message', async t => {
  const f = await fixture(t);
  const quoted = { message_id: 621, chat: { id: Number(chatId), type: 'supergroup' }, text: 'Article https://example.test/quoted' };
  const raw = f.makeRaw(622, '/brief', 6); (raw.message as any).reply_to_message = quoted;
  await f.run('brief', raw);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 623, quoted);
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1622:621')?.task;
  assert.equal(task?.input, quoted.text);
  assert.equal(task?.status, 'succeeded');
});

test('native AI commands report missing configuration before confirmation and failed execution without output', async t => {
  const disabled = await fixture(t);
  const actor = { groupId: chatId, userId, role: 'admin' as const };
  const enabledGroup = await disabled.binding.getGroup(actor);
  assert.ok(enabledGroup);
  const disabledProposal = await disabled.actions.previewRules(`tg-user:${userId}`, `tg:${chatId}`, {
    config: { features: ['link-cleaner', 'digest'] }, baseVersion: enabledGroup.version });
  await disabled.actions.activateRules(`tg-user:${userId}`, disabledProposal.id);
  await disabled.run('ask unavailable', disabled.makeRaw(70, '/ask unavailable', 4));
  assert.ok(disabled.bot.sent.some(message => contents(message).includes('未启用群助手')));
  assert.equal(disabled.bot.sent.map(getButton).filter(Boolean).length, 0);

  const f = await fixture(t, false);
  const raw = f.makeRaw(71, '/ask configured off', 4);
  await f.run('ask disabled case', raw);
  assert.ok(f.bot.sent.some(message => contents(message).includes('尚未配置 AI')));
  assert.equal(f.bot.sent.map(getButton).filter(Boolean).length, 0);
  const failing = await fixture(t);
  const failureRaw = failing.makeRaw(73, '/ask failure case', 4);
  await failing.run('ask failure case', failureRaw);
  const token = failing.bot.sent.map(getButton).find(Boolean);
  assert.ok(token);
  failing.failAssistant = true;
  await failing.button(token!, 130, failureRaw.message);
  assert.ok(failing.bot.sent.some(message => contents(message).includes('未投递结果')));
  assert.equal(failing.bot.sent.filter(message => contents(message).startsWith('ANSWER:')).length, 0);
});

test('native @bot mention runs only in mention mode and confirms the stripped explicit input', async t => {
  const f = await fixture(t, true, 'mention');
  const ordinaryRaw = { update_id: 1_999, message: { message_id: 100, date: 1,
    from: { id: Number(userId), is_bot: false }, chat: { id: Number(chatId), type: 'supergroup' }, text: 'A normal group message' } };
  const ordinarySession = f.bot.session({ type: 'message', platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
    guild: { id: chatId }, channel: { id: chatId, type: 0 }, message: { id: '100', content: ordinaryRaw.message.text, elements: [] }, _data: ordinaryRaw } as any);
  await f.onMessage!(ordinarySession);
  assert.equal(f.bot.sent.length, 0, 'ordinary messages receive no response');
  const privateRaw = { update_id: 2_000, message: { message_id: 100, date: 1,
    from: { id: Number(userId), is_bot: false }, chat: { id: Number(userId), type: 'private' }, text: 'A private message' } };
  const privateSession = f.bot.session({ type: 'message', platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
    channel: { id: userId, type: 1 }, message: { id: '100', content: privateRaw.message.text, elements: [] }, _data: privateRaw } as any);
  await f.onMessage!(privateSession);
  assert.ok(f.bot.sent.map(getButton).some(Boolean), 'private messages only propose confirmation');
  const raw = { update_id: 2_001, message: { message_id: 101, date: 1, from: { id: Number(userId), is_bot: false },
    chat: { id: Number(chatId), type: 'supergroup' }, text: 'Please explain @testbot this topic',
    entities: [{ type: 'mention', offset: 15, length: 8 }] } };
  const session = f.bot.session({ type: 'message', platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
    guild: { id: chatId }, channel: { id: chatId, type: 0 }, message: { id: '101', content: raw.message.text, elements: [] }, _data: raw } as any);
  await f.onMessage!(session);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token);
  await f.button(token!, 120, raw.message);
  assert.ok(f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:2001:101')?.task?.input === 'Please explain  this topic');

  const unconfigured = await fixture(t, false, 'mention');
  const noMentionRaw = { update_id: 2_101, message: { message_id: 111, date: 1,
    from: { id: Number(userId), is_bot: false }, chat: { id: Number(chatId), type: 'supergroup' }, text: 'Another ordinary message' } };
  const noMentionSession = unconfigured.bot.session({ type: 'message', platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
    guild: { id: chatId }, channel: { id: chatId, type: 0 }, message: { id: '111', content: noMentionRaw.message.text, elements: [] }, _data: noMentionRaw } as any);
  await unconfigured.onMessage!(noMentionSession);
  assert.equal(unconfigured.bot.sent.length, 0, 'unconfigured bot stays quiet without an explicit mention');
});

test('native /scan explicitly confirms one assistant review, rejects another user, and requires assistant permission', async t => {
  const f = await fixture(t);
  const raw = f.makeRaw(801, '/scan This offer promises guaranteed returns: https://example.test', 5);
  await f.run('scan explicit text', raw);
  const token = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(token, 'scan proposes the existing third-party AI confirmation');
  assert.match(contents(f.bot.sent.at(-1)), /广告.*风险复核.*每次.*模型.*建议.*处罚.*单次/);
  await f.button(token!, 802, raw.message);
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1801:801')?.task;
  assert.equal(task?.featureId, 'assistant');
  assert.equal(task?.input, `${AD_REVIEW_PREFIX}This offer promises guaranteed returns: https://example.test`);
  assert.equal(task?.modelCalls, 1);
  assert.equal(task?.toolCalls, 0);
  assert.ok(f.bot.sent.some(message => contents(message).startsWith('ANSWER:')));

  const wrongUser = f.makeRaw(803, '/scan A second explicit message', 5);
  await f.run('scan second message', wrongUser);
  const secondToken = f.bot.sent.map(getButton).filter(Boolean).at(-1);
  assert.ok(secondToken);
  const callbackRaw = { update_id: 1_804, callback_query: { id: 'wrong-user', from: { id: 43, is_bot: false }, data: secondToken,
    message: { message_id: 804, from: { id: 99, is_bot: true }, chat: { id: Number(chatId), type: 'supergroup' }, reply_to_message: wrongUser.message } } };
  await f.onButton!({ platform: 'telegram', type: 'interaction/button', user: { id: '43' }, guildId: chatId, channelId: chatId,
    event: { user: { id: '43' }, _data: callbackRaw }, bot: { user: { id: '99', name: 'testbot' } }, async send(content: any) { return f.bot.sendMessage(chatId, content); } });
  assert.equal(f.store.reservation(`tg:${chatId}`, 'tg-user:43', 'koishi-ai:1804:803'), undefined);
  assert.equal(f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1804:803'), undefined);

  const current = await f.binding.getGroup({ groupId: chatId, userId, role: 'admin' });
  assert.ok(current);
  const proposal = await f.actions.previewRules(`tg-user:${userId}`, `tg:${chatId}`, {
    config: { features: ['link-cleaner', 'digest', 'link-brief'] }, baseVersion: current.version });
  await f.actions.activateRules(`tg-user:${userId}`, proposal.id);
  const before = f.bot.sent.length;
  await f.run('scan without assistant permission', f.makeRaw(805, '/scan not authorized for assistant', 5));
  assert.ok(f.bot.sent.slice(before).some(message => contents(message).includes('未启用群助手')));
  assert.equal(f.bot.sent.slice(before).map(getButton).filter(Boolean).length, 0);
  assert.equal(f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi-ai:1805:805'), undefined);
});

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
import { installGroupCommands, verifyTelegramMember } from '../src/server/koishi-business.js';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';

const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');
const chatId = '-100123';
const userId = '42';

class FakeTelegramBot extends Bot<Context> {
  internal: any;
  sent: string[] = [];
  emptyReceipt = false;
  private readonly botList: Context['bots'];
  constructor(ctx: Context, readonly roles: Map<string, string>) {
    super(ctx, {}, 'telegram');
    this.botList = ctx.bots;
    this.platform = 'telegram'; this.selfId = '99';
    this.internal = {
      getChat: async ({ chat_id }: { chat_id: string }) => ({ id: Number(chat_id), type: 'supergroup', title: 'Test group' }),
      getChatMember: async ({ user_id }: { user_id: number }) => ({
        user: { id: user_id, is_bot: user_id === 99 },
        status: user_id === 99 ? 'administrator' : this.roles.get(`${chatId}/${user_id}`) ?? 'left',
      }),
    };
  }
  override async start() {}
  override async stop() {}
  override async dispose() {
    const index = this.botList.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.botList.splice(index, 1);
  }
  override async sendMessage(_channelId: string, content: any) {
    const value = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(element => element.type === 'text' ? element.attrs.content : '').join('')
      : content?.type === 'text' ? content.attrs.content : String(content);
    this.sent.push(value);
    return this.emptyReceipt ? [] : [`sent-${this.sent.length}`];
  }
}

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-business-'));
  const configPath = path.join(dir, 'koishi.yml');
  await writeFile(configPath, 'plugins: {}\n');
  const store = new Store();
  const roles = new Map<string, string>([[`${chatId}/${userId}`, 'administrator']]);
  const actions = createGroupActions(store, { executor: async request => ({ output: `LINKS:${request.input}`, modelCalls: 0 }),
    async refreshRole(actorId, groupId) {
      const role = await verifyTelegramMember(bot!, groupId.slice(3), actorId.slice('tg-user:'.length));
      try { store.syncTelegramMember(groupId.slice(3), actorId.slice('tg-user:'.length), role); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'GROUP_UNREGISTERED')) throw error; }
    },
  });
  let bot!: FakeTelegramBot;
  let binding!: ReturnType<typeof createTelegramBinding>;
  const runtime = await createKoishiRuntime({ configPath, setup(ctx) {
    ctx.plugin(FakeTelegramBot as any, roles);
    ctx.plugin((inner: Context) => {
      bot = inner.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
      binding = createTelegramBinding(store, actions);
      installGroupCommands(inner, binding);
    });
  } });
  await runtime.start();
  bot = runtime.app.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
  const run = async (command: string, messageId: number) => {
    const raw = { update_id: messageId + 1000, message: { message_id: messageId, date: 1, from: { id: Number(userId), is_bot: false, first_name: 'Member' }, chat: { id: Number(chatId), type: 'supergroup', title: 'Test group' }, text: `/${command}` } };
    const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: userId, name: 'Member', isBot: false },
      guild: { id: chatId, name: 'Test group' }, channel: { id: chatId, type: 0 },
      message: { id: String(messageId), content: `/${command}`, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    return session.execute(command, true);
  };
  t.after(async () => { await runtime.stop(); actions.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { run, bot, store, actions, binding };
}

test('native Koishi register, rule preview and apply reuse verified Store and action paths', async t => {
  const f = await fixture(t);
  await f.run('register', 1);
  assert.ok(f.store.group(`tg:${chatId}`, `tg-user:${userId}`));
  await f.run('rules 只使用命令，中文，去重并排序，最多10条', 2);
  const proposal = f.store.proposal(f.store.auditRecords({ actorId: `tg-user:${userId}`, groupId: `tg:${chatId}` }).find(row => row.action === 'rules.preview')!.targetId!)!;
  assert.equal(proposal.status, 'pending');
  await f.run(`applyrules ${proposal.id}`, 3);
  assert.equal(f.store.group(`tg:${chatId}`, `tg-user:${userId}`)?.config.maxItems, 10);
});

test('native Koishi links command executes through binding and delivers exactly once', async t => {
  const f = await fixture(t);
  await f.run('register', 10);
  await f.run('links https://example.test/a', 11);
  const sent = f.bot.sent.filter(text => text.includes('LINKS:'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'LINKS:https://example.test/a');
  const db = (f.store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): { status: string } | undefined } } }).db;
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi:1011:11')!;
  assert.equal(db.prepare('SELECT status FROM telegram_deliveries WHERE task_id=?').get(task.task!.id)?.status, 'sent');
});

test('native Koishi treats an empty send receipt as unknown and does not retry delivery', async t => {
  const f = await fixture(t);
  await f.run('register', 20);
  f.bot.emptyReceipt = true;
  await f.run('links https://example.test/uncertain', 21);
  const attempts = f.bot.sent.filter(text => text.includes('LINKS:')).length;
  const task = f.store.reservation(`tg:${chatId}`, `tg-user:${userId}`, 'koishi:1021:21')!;
  const db = (f.store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): { status: string } | undefined } } }).db;
  assert.equal(db.prepare('SELECT status FROM telegram_deliveries WHERE task_id=?').get(task.task!.id)?.status, 'unknown');
  await f.run('links https://example.test/uncertain', 21);
  assert.equal(f.bot.sent.filter(text => text.includes('LINKS:')).length, attempts);
});

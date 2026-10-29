import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context, Session } from 'koishi';
import { installWelcomeIntegration } from '../src/server/koishi-welcome.js';
import type { TelegramBinding } from '../src/server/telegram.js';

const chatId = '-100123';
const actorId = '42';

function eventSession(config: Record<string, unknown> = {}) {
  const sent: string[] = [];
  const raw = { update_id: 9001, message: { message_id: 77, from: { id: 42, is_bot: false, first_name: 'Moderator' },
    chat: { id: -100123, type: 'supergroup', title: '测试群' }, new_chat_members: [{ id: 88, is_bot: false, first_name: '小明' }] } };
  const session = { platform: 'telegram', type: 'message', user: { id: 'koishi-db-user-1', isBot: false }, event: {
    user: { id: actorId, isBot: false }, guild: { id: chatId }, channel: { id: chatId, type: 0 }, _data: raw,
  },
    bot: { selfId: '99', internal: { getChat: async () => ({ id: -100123, type: 'supergroup' }), getChatMember: async ({ user_id }: { user_id: number }) => ({
      user: { id: user_id, is_bot: false }, status: 'administrator',
    }) } },
    async send(content: any) { sent.push(content.attrs.content); return ['receipt']; },
  } as unknown as Session;
  let handler!: (session: Session) => Promise<void>;
  const ctx = { on(name: string, callback: (session: Session) => Promise<void>) { assert.equal(name, 'message'); handler = callback; } } as unknown as Context;
  const calls: unknown[] = [];
  const binding = {
    async getGroup(actor: any) { calls.push(['group', actor]); return { version: 1, config: { language: 'zh', deduplicate: true, sort: true, maxItems: 10, features: ['welcome'], ...config } }; },
    async executeFeature(request: any) {
      calls.push(['execute', request]);
      const template = String(config.welcomeText ?? '欢迎 {name} 加入 {group}！');
      return { id: 'task-1', status: 'succeeded', output: template.replaceAll('{name}', request.input).replaceAll('{group}', '测试群') };
    },
    async claimDelivery() { calls.push(['claim']); return true; },
    deliveryStillAuthorized() { return true; },
    async recordDelivery(_actor: unknown, _taskId: string, status: string) { calls.push(['receipt', status]); },
  } as unknown as TelegramBinding;
  installWelcomeIntegration(ctx, binding);
  return { handler, session, sent, calls, raw };
}

test('native Telegram join event runs the existing welcome task and sends once', async () => {
  const f = eventSession();
  await f.handler(f.session);
  assert.deepEqual(f.sent, ['欢迎 小明 加入 测试群！']);
  const execute = f.calls.find(call => Array.isArray(call) && call[0] === 'execute') as any[];
  assert.equal(execute[1].featureId, 'welcome');
  assert.equal(execute[1].eventUserIds[0], '88');
  assert.equal(execute[1].idempotencyKey, 'koishi-welcome:9001:77');
  assert.ok(f.calls.some(call => Array.isArray(call) && call[0] === 'receipt' && call[1] === 'sent'));
});

test('native Telegram join event renders the configured group template', async () => {
  const f = eventSession({ welcomeText: '欢迎 {name} 来到 {group}，请先看群规。' });
  await f.handler(f.session);
  assert.deepEqual(f.sent, ['欢迎 小明 来到 测试群，请先看群规。']);
});

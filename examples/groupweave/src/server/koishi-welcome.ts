import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type { TelegramActor, TelegramBinding } from './telegram.js';
import { verifyTelegramMember } from './koishi-business.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
type User = { id?: number; is_bot?: boolean; first_name?: string; last_name?: string };
type Message = { new_chat_members?: User[] };
type Update = { update_id?: number; message?: Message };
type NativeEvent = Session['event'] & { _data?: Update; user?: { id?: string; isBot?: boolean }; guild?: { id?: string }; channel?: { id?: string; type?: number } };

/** Handle the official Telegram adapter's internal message event for joins. */
export function installWelcomeIntegration(ctx: Context, binding: TelegramBinding): void {
  ctx.on('message', async (session: Session) => {
    if (session.platform !== 'telegram' || session.type !== 'message') return;
    const event = session.event as NativeEvent;
    const raw = event._data?.message as (Message & {
      message_id?: number; from?: User; chat?: { id?: number; type?: string; title?: string }; sender_chat?: unknown;
    }) | undefined;
    const joined = raw?.new_chat_members?.filter(user => user && !user.is_bot && Number.isSafeInteger(user.id) && Number(user.id) > 0) ?? [];
    if (!raw || !joined.length || raw.sender_chat || !raw.from || raw.from.is_bot
      || (raw.chat?.type !== 'group' && raw.chat?.type !== 'supergroup')
      || !Number.isSafeInteger(raw.chat.id) || Number(raw.chat?.id) >= 0
      || !Number.isSafeInteger(raw.from.id) || Number(raw.from.id) <= 0
      || !event.user?.id || String(raw.from.id) !== event.user.id || event.user.isBot
      || event.guild?.id !== String(raw.chat.id) || event.channel?.id !== String(raw.chat.id)
      || event.channel?.type === 2
      || !Number.isSafeInteger(raw.message_id) || !raw.message_id
      || !Number.isSafeInteger(event._data?.update_id)) return;
    const actor: TelegramActor = { groupId: String(raw.chat.id), userId: String(raw.from.id), role: 'member' };
    const role = await verifyTelegramMember((session as Session & { bot: Parameters<typeof verifyTelegramMember>[0] }).bot, actor.groupId, actor.userId);
    if (!role) return;
    actor.role = role;
    const group = await binding.getGroup(actor);
    if (!group?.config.features.includes('welcome') || !binding.executeFeature) return;
    const ids = [...new Set(joined.map(user => String(user.id)))];
    const names = joined.map(user => [user.first_name, user.last_name].filter(Boolean).join(' ').trim()).filter(Boolean);
    const input = names.join('、') || ids.map(id => `成员 ${id}`).join('、');
    const { update_id: updateId } = event._data!;
    const { message_id: messageId } = raw;
    let task;
    try {
      task = await binding.executeFeature({ actor, input, audience: 'group', updateId: updateId!, messageId: messageId!,
        idempotencyKey: `koishi-welcome:${updateId}:${messageId}`, featureId: 'welcome', eventUserIds: ids });
    } catch { return; }
    if (!await binding.claimDelivery(actor, task.id)) return;
    if (binding.deliveryStillAuthorized && !binding.deliveryStillAuthorized(actor, task.id)) {
      await binding.recordDelivery(actor, task.id, 'withheld'); return;
    }
    try {
      const receipts = await session.send(h.text(task.status === 'succeeded' ? task.output : '欢迎消息未成功完成，未投递结果。'));
      await binding.recordDelivery(actor, task.id, receipts?.length ? 'sent' : 'unknown');
    } catch { await binding.recordDelivery(actor, task.id, 'unknown'); }
  });
}

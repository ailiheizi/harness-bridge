import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import type { TelegramActor, TelegramBinding } from './telegram.js';
import { createTelegramConfirmations, type AiFeature, type InputMode } from './telegram/confirmation.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const LIMIT = 8_000;
const CHUNK = 3_500;
const fallback = '处理未能确认完成，未投递结果；请稍后查看当前会话配置，不会自动重试。';

type TgMessage = {
  message_id?: number; message_thread_id?: number; is_topic_message?: boolean; text?: string; caption?: string;
  entities?: { type?: string; offset?: number; length?: number; user?: { id?: number } }[];
  caption_entities?: { type?: string; offset?: number; length?: number; user?: { id?: number } }[];
  chat?: { id?: number; type?: string }; from?: { id?: number; is_bot?: boolean };
  sender_chat?: unknown; reply_to_message?: TgMessage;
};
type TgUpdate = { update_id?: number; message?: TgMessage; callback_query?: {
  id?: string; from?: { id?: number; is_bot?: boolean }; message?: TgMessage; data?: string;
} };
type AiSession = Session & { event: Session['event'] & { _data?: TgUpdate }; bot: { user?: { id?: string; name?: string } } };
type Selected = { input: string; message: TgMessage; mode: InputMode; targeted: boolean };

function safeId(value: unknown, negative = false): value is number | string {
  if (typeof value !== 'number' && typeof value !== 'string') return false;
  const n = Number(value);
  return Number.isSafeInteger(n) && (negative ? n < 0 : n > 0) && String(n) === String(value);
}

function split(text: string): string[] {
  const result: string[] = [];
  let part = '';
  for (const point of text) {
    if (part.length + point.length > CHUNK) { result.push(part); part = ''; }
    part += point;
  }
  if (part) result.push(part);
  return result;
}

function extractInput(text: string | undefined, caption: string | undefined): string | undefined {
  const value = typeof text === 'string' && text.trim() ? text : caption;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function translationParts(value: string): { language: string; source: string } | undefined {
  let language: string | undefined;
  let source: string | undefined;
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end <= 1 || !/^\s/u.test(value.slice(end + 1))) return undefined;
    language = value.slice(1, end);
    source = value.slice(end + 1).replace(/^\s+/u, '');
  } else {
    const match = /^([^\s"']+)\s+([\s\S]+)$/u.exec(value);
    language = match?.[1];
    source = match?.[2];
  }
  if (!language || !/^[\p{L}\p{M}][\p{L}\p{M} -]{0,39}$/u.test(language) || !source?.trim()) return undefined;
  return { language, source };
}

/** Install explicitly confirmed AI commands on the native Koishi Telegram adapter. */
export function installAiCommands(ctx: Context, binding: TelegramBinding, options: { configured?: boolean; privateBinding?: TelegramBinding } = {}): void {
  const confirmations = createTelegramConfirmations();

  function source(session: Session, type = 'interaction/command', privateOnly = false) {
    const event = session.event as AiSession['event'];
    const raw = event._data?.message;
    const user = event.user;
    const isPrivate = raw?.chat?.type === 'private';
    if (session.platform !== 'telegram' || session.type !== type || !raw || raw.sender_chat || raw.from?.is_bot || raw.is_topic_message === true
      || (privateOnly ? !isPrivate : (isPrivate || !safeId(raw.chat?.id, true) || (raw.chat?.type !== 'group' && raw.chat?.type !== 'supergroup')))
      || (isPrivate && (!safeId(raw.chat?.id) || String(raw.chat.id) !== String(raw.from?.id) || session.isDirect === false))
      || !safeId(raw.from?.id) || !safeId(user?.id) || user?.isBot || String(raw.from.id) !== user.id
      || !safeId(raw.message_id) || !Number.isSafeInteger(event._data?.update_id)
      || (isPrivate ? session.channelId !== String(raw.chat.id) : (!session.guildId || session.guildId !== String(raw.chat.id) || session.channelId !== session.guildId))) return undefined;
    return { raw, private: isPrivate, actor: { groupId: String(raw.chat.id), userId: String(raw.from.id), role: 'member' as const }, updateId: event._data!.update_id!, messageId: raw.message_id };
  }

  const reply = async (session: Session, text: string, quoteId?: number) => {
    try { await session.send([...(quoteId ? [h.quote(String(quoteId))] : []), h.text(text)]); } catch { /* No raw adapter errors. */ }
  };

  const commandRaw = (raw: TgMessage, feature: AiFeature, actorId: string, username: string | undefined, mentionMode: boolean): Selected | undefined => {
    const text = raw.text;
    if (typeof text !== 'string') return undefined;
    const entities = raw.entities ?? [];
    const entity = entities.find(e => e.type === 'bot_command' && e.offset === 0 && Number.isSafeInteger(e.length));
    if (!entity || !entity.length) return undefined;
    const command = text.slice(0, entity.length);
    const match = /^\/(ask|digest|translate|brief)(?:@([a-z0-9_]+))?$/i.exec(command);
    if (!match) return undefined;
    const name = match[1]!.toLowerCase();
    const commandFeature: AiFeature = name === 'digest' ? 'digest' : name === 'brief' ? 'link-brief' : 'assistant';
    if (commandFeature !== feature) return undefined;
    const targeted = Boolean(match[2]);
    if (targeted && (!username || match[2]!.toLowerCase() !== username.toLowerCase())) return undefined;
    if (mentionMode && !targeted) return undefined;
    if (raw.from?.id !== Number(actorId)) return undefined;
    const direct = text.slice(entity.length).trim();
    if (name === 'translate') {
      const parts = translationParts(direct);
      if (!parts) return undefined;
      const { language, source } = parts;
      return { input: `Translate the following text into ${language}. Preserve its meaning and tone. Return only the translation.\n\nText:\n${source}`,
        message: raw, mode: 'command', targeted };
    }
    if (name === 'brief') {
      if (direct) return { input: direct, message: raw, mode: 'command', targeted };
      const original = raw.reply_to_message;
      if (!original || original.is_topic_message === true || String(original.chat?.id) !== String(raw.chat?.id)) return undefined;
      const input = extractInput(original.text, original.caption);
      return input ? { input, message: original, mode: 'reply', targeted } : undefined;
    }
    if (direct) return { input: direct, message: raw, mode: 'command', targeted };
    const original = raw.reply_to_message;
    if (!original || original.is_topic_message === true || String(original.chat?.id) !== String(raw.chat?.id)) return undefined;
    const input = extractInput(original.text, original.caption);
    if (!input) return undefined;
    return { input, message: original, mode: 'reply', targeted };
  };

  function mentionRaw(raw: TgMessage, username: string | undefined, botId: string | undefined): Selected | undefined {
    const text = typeof raw.text === 'string' ? raw.text : raw.caption;
    if (!text || text.startsWith('/') || !username || !safeId(raw.message_id)) return undefined;
    const entities = raw.text ? raw.entities ?? [] : raw.caption_entities ?? [];
    const mentions = entities.filter(entity => Number.isSafeInteger(entity.offset) && Number.isSafeInteger(entity.length)
      && (entity.type === 'mention' && text.slice(entity.offset, entity.offset! + entity.length!).toLowerCase() === `@${username.toLowerCase()}`
        || entity.type === 'text_mention' && botId && String(entity.user?.id) === botId));
    if (!mentions.length) return undefined;
    let input = text;
    for (const entity of [...mentions].sort((a, b) => b.offset! - a.offset!)) input = input.slice(0, entity.offset) + input.slice(entity.offset! + entity.length!);
    input = input.trim();
    return input ? { input, message: raw, mode: 'mention', targeted: true } : undefined;
  }

  async function run(session: Session, feature: AiFeature, input: string, actor: TelegramActor, updateId: number, messageId: number, targeted: boolean, isPrivate = false) {
    const activeBinding = isPrivate ? options.privateBinding : binding;
    if (!activeBinding) return reply(session, '私聊 AI 尚未开放，请在已授权群组中使用 /ask 或 /digest。', messageId);
    if (options.configured === false || !binding.executeFeature) return reply(session, '本服务尚未配置 AI 执行能力，请联系管理员。', messageId);
    let task;
    try {
      task = await activeBinding.executeFeature!({ actor, input, featureId: feature, audience: isPrivate ? 'private' : 'group', updateId, messageId,
        idempotencyKey: `koishi-ai:${updateId}:${messageId}`, externalProcessingAcknowledged: true });
    } catch { return reply(session, fallback, messageId); }
    if (task.status !== 'succeeded' || !task.output.trim()) return reply(session, fallback, messageId);
    const taskScope = isPrivate ? `tg-dm:${actor.userId}` : `tg:${actor.groupId}`;
    if (!task.id || task.featureId !== feature || task.input !== input || task.audience !== (isPrivate ? 'private' : 'group')
      || task.creatorId !== `tg-user:${actor.userId}` || task.groupId !== taskScope) return reply(session, fallback, messageId);
    if (!await activeBinding.claimDelivery(actor, task.id)) return;
    const current = await activeBinding.getGroup(actor);
    if (!current || !current.config.features.includes(feature)
      || (!isPrivate && current.config.responseMode === 'mention' && !targeted)) {
      await activeBinding.recordDelivery(actor, task.id, 'withheld'); return;
    }
    if (activeBinding.deliveryStillAuthorized && !activeBinding.deliveryStillAuthorized(actor, task.id)) {
      await activeBinding.recordDelivery(actor, task.id, 'withheld'); return;
    }
    try {
      for (const chunk of split(task.output)) {
        const latest = await activeBinding.getGroup(actor);
        if (!latest || !latest.config.features.includes(feature) || (!isPrivate && latest.config.responseMode === 'mention' && !targeted)
          || (activeBinding.deliveryStillAuthorized && !activeBinding.deliveryStillAuthorized(actor, task.id))) {
          await activeBinding.recordDelivery(actor, task.id, 'withheld'); return;
        }
        const receipts = await session.send([h.quote(String(messageId)), h.text(chunk)]);
        if (!receipts?.length) { await activeBinding.recordDelivery(actor, task.id, 'unknown'); return; }
      }
      await activeBinding.recordDelivery(actor, task.id, 'sent');
    } catch { await activeBinding.recordDelivery(actor, task.id, 'unknown'); }
  }

  for (const feature of ['assistant', 'digest', 'link-brief'] as const) {
    const name = feature === 'assistant' ? 'ask' : feature === 'digest' ? 'digest' : 'brief';
    const handler = async ({ session }: { session?: Session }) => {
        if (!session) return;
        const privateEvent = session.platform === 'telegram' && (session.event as AiSession['event'])._data?.message?.chat?.type === 'private';
        const src = source(session, 'interaction/command', Boolean(privateEvent));
        if (!src) return;
        if (src.private && feature === 'link-brief') return reply(session, '链接整理与说明仅在已授权群组开放。');
        if (src.private && !options.privateBinding) return reply(session, '私聊 AI 尚未开放，请在已授权群组中使用 /ask 或 /digest。');
        const activeBinding = src.private ? options.privateBinding! : binding;
        if (options.configured === false) return reply(session, '本服务尚未配置 AI 执行能力，请联系管理员。', src.messageId);
        try {
        const group = await activeBinding.getGroup(src.actor);
        if (!group) return reply(session, src.private ? '当前会话尚未启用此功能。' : '本群尚未注册，请由本群管理员使用 /register。');
        if (!group.config.features.includes(feature)) return reply(session, src.private ? '当前会话未启用此功能。' : `本群未启用${feature === 'assistant' ? '群助手' : feature === 'digest' ? '智能摘要' : '链接整理与说明'}。`);
        const username = (session as AiSession).bot?.user?.name;
        const commandWord = (src.raw.text ?? '').split(/\s/, 1)[0] ?? '';
        const targetMatch = /^\/(?:ask|digest|translate|brief)@([a-z0-9_]+)$/i.exec(commandWord);
        const targeted = Boolean(targetMatch);
        if ((!src.private && group.config.responseMode === 'mention' && (!targeted || !username || targetMatch?.[1]?.toLowerCase() !== username.toLowerCase()))
          || (targeted && (!username || targetMatch?.[1]?.toLowerCase() !== username.toLowerCase()))) {
          return reply(session, src.private ? '当前会话仅响应明确指定机器人的命令。' : '本群仅响应明确指定本机器人用户名的命令，例如 /ask@botusername <文本>。');
        }
        const selected = commandRaw(src.raw, feature, src.actor.userId, username, !src.private && group.config.responseMode === 'mention');
        const result = selected;
        const commandName = (src.raw.text ?? '').split(/\s/, 1)[0]?.split('@', 1)[0]?.toLowerCase();
        const usage = commandName === '/translate' ? '用法：/translate <目标语言> <文本>，最多 8 KB；多词目标语言请加引号，例如 /translate "Traditional Chinese" <文本>。'
          : '用法：提供最多 8 KB 文本，或回复同群文本/图片说明后使用此命令。';
        if (!result?.input || Buffer.byteLength(result.input, 'utf8') > LIMIT) return reply(session, usage, src.messageId);
        const confirmation = confirmations.issue({ featureId: feature, groupId: src.private ? `tg-dm:${src.actor.userId}` : src.actor.groupId, userId: src.actor.userId,
          messageId: result.message.message_id!, updateId: src.updateId, input: result.input, mode: result.mode, targeted: result.targeted });
        const notice = feature === 'link-brief'
          ? '将仅用本次输入运行链接整理代码，再把原文和整理结果发送给第三方 AI 生成说明；不访问链接或群历史。确认后才会运行。'
          : '将把这段文本发送给第三方 AI 处理。确认后才会运行；不读取群历史。';
        await session.send([h.quote(String(result.message.message_id)), h.text(notice),
          h('button', { id: confirmation }, '确认第三方处理并运行')]);
        } catch { await reply(session, '无法读取本群配置或准备确认；请稍后查看群配置。', src.messageId); }
      };
    ctx.command(`${name} <input:text>`, feature === 'assistant' ? '确认后使用群助手处理文本' : feature === 'digest' ? '确认后生成文本摘要' : '确认后整理并说明本次链接').action(handler);
    if (feature === 'assistant') ctx.command('translate <language:string> <input:text>', '确认后翻译本次文本').action(handler);
  }

  ctx.on('message', async session => {
    if (!session || session.platform !== 'telegram') return;
    const rawMessage = (session.event as AiSession['event'])._data?.message;
    if (rawMessage?.chat?.type === 'private') {
      const src = source(session, 'message', true);
      if (!src || !options.privateBinding || options.configured === false || typeof src.raw.text !== 'string' || !src.raw.text.trim()
        || src.raw.text.startsWith('/') || src.raw.caption || src.raw.entities?.some((entity: NonNullable<TgMessage['entities']>[number]) => entity.type === 'bot_command')) return;
      try {
        const current = await options.privateBinding.getGroup(src.actor);
        if (!current?.config.features.includes('assistant')) return;
        if (Buffer.byteLength(src.raw.text, 'utf8') > LIMIT) return reply(session, '本次文本超过 8 KB，未提交给 AI。', src.messageId);
        const token = confirmations.issue({ featureId: 'assistant', groupId: `tg-dm:${src.actor.userId}`, userId: src.actor.userId,
          messageId: src.messageId, updateId: src.updateId, input: src.raw.text.trim(), mode: 'reply', targeted: false });
        await session.send([h.quote(String(src.messageId)), h.text('将把这段文本发送给第三方 AI 处理。确认后才会运行。'),
          h('button', { id: token }, '确认第三方处理并运行')]);
      } catch { /* Invalid/private sessions stay silent. */ }
      return;
    }
    if (session.isDirect) return;
    const src = source(session, 'message'); if (!src) return;
    try {
      const selected = mentionRaw(src.raw, (session as AiSession).bot?.user?.name, (session as AiSession).bot?.user?.id);
      if (!selected) return;
      if (options.configured === false) return reply(session, '本服务尚未配置 AI 执行能力，请联系管理员。', src.messageId);
      const group = await binding.getGroup(src.actor);
      if (!group || group.config.responseMode !== 'mention' || !group.config.features.includes('assistant')) return;
      if (Buffer.byteLength(selected.input, 'utf8') > LIMIT) return reply(session, '本次文本超过 8 KB，未提交给 AI。', selected.message.message_id);
      const token = confirmations.issue({ featureId: 'assistant', groupId: src.actor.groupId, userId: src.actor.userId,
        messageId: selected.message.message_id!, updateId: src.updateId, input: selected.input, mode: 'mention', targeted: true });
      await session.send([h.quote(String(selected.message.message_id)), h.text('将把这段文本发送给第三方 AI 处理。确认后才会运行；不读取群历史。'),
        h('button', { id: token }, '确认第三方处理并运行')]);
    } catch { await reply(session, '无法读取本群配置或准备确认；请稍后查看群配置。', src.messageId); }
  });

  ctx.on('interaction/button', async session => {
    try {
    const event = session.event as AiSession['event'];
    const raw = event._data?.callback_query;
    const callbackMessage = raw?.message;
    const original = callbackMessage?.reply_to_message;
    const isPrivate = callbackMessage?.chat?.type === 'private';
    const token = typeof raw?.data === 'string' ? raw.data : '';
    const decoded = confirmations.inspect(token);
    const userId = raw?.from?.id;
    if (session.platform !== 'telegram' || !raw || raw.from?.is_bot || !safeId(userId)
      || event.user?.id !== String(userId) || !callbackMessage || callbackMessage.sender_chat
      || (isPrivate ? (!safeId(callbackMessage.chat?.id) || String(callbackMessage.chat.id) !== String(userId) || !options.privateBinding)
        : (!safeId(callbackMessage.chat?.id, true) || (callbackMessage.chat?.type !== 'group' && callbackMessage.chat?.type !== 'supergroup')))
      || !safeId(callbackMessage.message_id) || callbackMessage.is_topic_message === true || !original || original.is_topic_message === true || original.sender_chat
      || (isPrivate && !original.chat) || !safeId(original.message_id)
      || String(original.chat?.id) !== String(callbackMessage.chat.id)
      || (isPrivate ? session.channelId !== String(callbackMessage.chat.id) : String(session.guildId) !== String(callbackMessage.chat.id) || session.channelId !== session.guildId)
      || !safeId((session as AiSession).bot?.user?.id) || callbackMessage.from?.id !== Number((session as AiSession).bot.user!.id)
      || !decoded || decoded.userId !== String(userId) || decoded.messageId !== original.message_id
      || !Number.isSafeInteger(event._data?.update_id)) return;
    const actor: TelegramActor = { groupId: String(callbackMessage.chat.id), userId: String(userId), role: 'member' };
    const activeBinding = isPrivate ? options.privateBinding! : binding;
    const signatureScope = isPrivate ? `tg-dm:${actor.userId}` : actor.groupId;
    const group = await activeBinding.getGroup(actor);
    if (!group || !group.config.features.includes(decoded.featureId)) return reply(session, isPrivate ? '确认按钮无效或当前会话功能已关闭。' : '确认按钮无效或本群功能已关闭。', original.message_id);
    const mentionMode = group.config.responseMode === 'mention';
    if ((!isPrivate && ((decoded.mode === 'mention' && !mentionMode) || (mentionMode && !decoded.targeted)))) return reply(session, '确认按钮无效或本群触发方式已更改。', original.message_id);
    if (isPrivate && decoded.featureId === 'link-brief') return reply(session, '私聊仅可使用本人问答与摘要；链接说明只在授权群组开放。', original.message_id);
    const selected = commandRaw(original, decoded.featureId, actor.userId, (session as AiSession).bot?.user?.name, !isPrivate && mentionMode);
    let input: string | undefined;
    if (decoded.mode === 'mention') {
      input = mentionRaw(original, (session as AiSession).bot?.user?.name, (session as AiSession).bot?.user?.id)?.input;
    } else if (decoded.mode === 'reply') {
      input = extractInput(original.text, original.caption);
    } else if (decoded.mode === 'command') {
      const text = original.text;
      const cmd = text?.slice(0, original.entities?.find((e: NonNullable<TgMessage['entities']>[number]) => e.type === 'bot_command' && e.offset === 0)?.length ?? 0);
      const aliases = decoded.featureId === 'assistant' ? ['ask', 'translate'] : decoded.featureId === 'digest' ? ['digest'] : ['brief'];
      const normalized = cmd?.toLowerCase();
      if (selected?.mode === 'command' && normalized && aliases.some(alias => normalized === `/${alias}`
        || normalized === `/${alias}@${(session as AiSession).bot?.user?.name?.toLowerCase()}`)) input = selected.input;
    }
    if (isPrivate && decoded.mode === 'reply' && original.chat?.type === 'private' && String(original.chat.id) === String(userId)) {
      input = extractInput(original.text, original.caption);
      if (!input && original.reply_to_message && String(original.reply_to_message.chat?.id) === String(userId))
        input = extractInput(original.reply_to_message.text, original.reply_to_message.caption);
    }
    if (!input || Buffer.byteLength(input, 'utf8') > LIMIT || !confirmations.consume(token, { ...decoded, groupId: signatureScope, input }))
      return reply(session, '确认按钮无效、已过期或已使用。', original.message_id);
    if (options.configured === false) return reply(session, '本服务尚未配置 AI 执行能力；未运行任务。', original.message_id);
    try { await session.send([h.quote(String(original.message_id)), h.text('正在处理。')]); } catch { return; }
    const current = await activeBinding.getGroup(actor);
    if (!current || !current.config.features.includes(decoded.featureId)
      || (!isPrivate && current.config.responseMode === 'mention' && !decoded.targeted)) return reply(session, isPrivate ? '当前会话配置已更改，未运行任务。' : '群配置已更改，未运行任务。', original.message_id);
    try { await run(session, decoded.featureId, input, actor, decoded.updateId, decoded.messageId, decoded.targeted, isPrivate); }
    catch { await reply(session, fallback, original.message_id); }
    } catch { await reply(session, '无法验证本群配置或执行确认；请稍后查看群配置。'); }
  });
}

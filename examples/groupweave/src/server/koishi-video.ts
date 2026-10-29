import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';

const require = createRequire(import.meta.url);
const videoToGif = require('koishi-plugin-video-to-gif') as { apply(ctx: Context, config: Record<string, unknown>): unknown };

type NativeSession = Session & {
  event: Session['event'] & { _data?: { message?: Record<string, any> } };
  quote?: { elements?: Array<{ type: string; attrs?: Record<string, any>; data?: Record<string, any> }> };
  elements?: Array<{ type: string; attrs?: Record<string, any>; data?: Record<string, any> }>;
};

function telegramCommandMessage(session: NativeSession): Record<string, any> | undefined {
  if (session.platform !== 'telegram' || session.type !== 'interaction/command') return;
  const raw = session.event._data?.message;
  if (!raw || raw.sender_chat || !raw.chat || !raw.from || raw.from.is_bot || session.event.user?.isBot) return;
  if (String(raw.from.id) !== session.event.user?.id || !raw.message_id) return;
  if (raw.chat.type === 'private') {
    if (!Number.isSafeInteger(raw.chat.id) || raw.chat.id <= 0 || raw.chat.id !== raw.from.id
      || session.channelId !== String(raw.chat.id)) return;
  } else if ((raw.chat.type !== 'group' && raw.chat.type !== 'supergroup')
    || session.guildId !== String(raw.chat.id) || session.channelId !== session.guildId) return;
  return raw;
}

function hasNativeVideo(raw: Record<string, any>, session: NativeSession): boolean {
  const reply = raw.reply_to_message;
  if (reply?.chat?.id !== undefined && String(reply.chat.id) !== String(raw.chat.id)) return false;
  const rawVideo = !!(raw.video || reply?.video);
  if (!rawVideo) return false;
  const elements = [...(session.quote?.elements ?? []), ...(session.elements ?? [])];
  return elements.some(element => element?.type === 'video');
}

function hasSupportedVideo(session: NativeSession): boolean {
  const elements = [...(session.quote?.elements ?? []), ...(session.elements ?? [])];
  return elements.some(element => {
    if (element?.type !== 'video') return false;
    const src = element.attrs?.src || element.attrs?.url || element.data?.src || element.data?.url;
    if (typeof src === 'string' && /^data:video\/[\w.+-]+;base64,/i.test(src)) return true;
    try { return ['http:', 'https:'].includes(new URL(String(src)).protocol); } catch { return false; }
  });
}

/** Load the upstream video-to-GIF command with Telegram authorization and native-message guards. */
export function installVideoIntegration(ctx: Context, options: {
  authorize(session: Session): boolean | Promise<boolean>;
}): void {
  ctx.plugin(videoToGif as any, {
    maxSize: 10,
    maxDuration: 60,
    timeout: 20_000,
    fps: 15,
    width: 320,
    debug: false,
  });

  ctx.on('command/before-execute', async argv => {
    const name = argv.command?.name;
    if (name !== 'v2g' && name !== 'cancelv2g') return;
    const session = argv.session as NativeSession;
    const raw = telegramCommandMessage(session);
    if (!raw || !await options.authorize(session)) return '';
    if (name === 'cancelv2g') return;
    const hasRawVideo = !!(raw.video || raw.reply_to_message?.video);
    if (hasRawVideo && !hasNativeVideo(raw, session)) return '当前 Telegram 视频链接不可用，请确认视频来自本条消息或同一聊天的回复。';
    if (hasRawVideo && !hasSupportedVideo(session)) return '当前 Telegram 视频链接不可用，请重试或发送 MP4 视频。';
    return;
  });
}

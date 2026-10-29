import type { Context, Session } from 'koishi';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');

type TelegramFileInfo = { file_path?: string; file_size?: number };
type TelegramBot = {
  internal: { getFile(payload: { file_id: string }): Promise<TelegramFileInfo> };
  $getFile(path: string): Promise<{ data: Uint8Array; type?: string }>;
};
type Attachment = { file_id?: string; file_size?: number; file_name?: string; mime_type?: string; type: string };
type RawMessage = Record<string, any> & { is_topic_message?: boolean };

const MAX_BYTES = 64 * 1024;
const CHUNK_CHARS = 3000;
const cleanName = (name: string | undefined) => (name || 'attachment').replace(/[\\/\0-\x1f]/g, '_').slice(0, 100);

function attachment(message?: RawMessage): Attachment | undefined {
  if (!message) return;
  const doc = message.document;
  if (doc?.file_id) return { ...doc, type: 'document' };
  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return { ...photo, type: 'image', file_name: 'photo.jpg', mime_type: 'image/jpeg' };
  }
  for (const key of ['video', 'audio', 'voice', 'animation', 'video_note']) {
    if (message[key]?.file_id) return { ...message[key], type: key };
  }
}

function messageSource(session: Session): { raw: RawMessage; file?: Attachment } | undefined {
  if (session.platform !== 'telegram' || session.type !== 'interaction/command') return;
  const raw = (session.event as any)._data?.message as RawMessage | undefined;
  const user = session.event.user;
  if (!raw || raw.sender_chat || !raw.chat || !raw.message_id
    || !raw.from || String(raw.from.id) !== user?.id || raw.from.is_bot || user?.isBot) return;
  if (raw.chat.type === 'private') {
    if (!Number.isSafeInteger(raw.chat.id) || raw.chat.id <= 0 || String(raw.chat.id) !== String(raw.from.id)
      || String(raw.chat.id) !== (session.channelId ?? session.guildId)) return;
  } else if ((raw.chat.type !== 'group' && raw.chat.type !== 'supergroup')
    || session.guildId !== String(raw.chat.id) || session.channelId !== session.guildId || raw.is_topic_message === true) return;
  const reply = raw.reply_to_message;
  if (reply && String(reply.chat?.id) !== String(raw.chat.id)) return;
  return { raw, file: attachment(raw) ?? attachment(reply) };
}

function classify(file: Attachment): string {
  if (file.type === 'image') return 'image';
  if (file.type === 'video' || file.type === 'animation' || file.type === 'video_note') return 'video';
  if (file.type === 'audio' || file.type === 'voice') return 'audio';
  if (/\.txt$/i.test(file.file_name || '')) return 'txt';
  if (/\.md$/i.test(file.file_name || '')) return 'md';
  return 'document';
}

async function download(bot: TelegramBot, file: Attachment): Promise<Buffer> {
  if (!file.file_id || (file.file_size !== undefined && file.file_size > MAX_BYTES)) throw new Error('unavailable');
  const info = await bot.internal.getFile({ file_id: file.file_id });
  if (!info.file_path || (info.file_size !== undefined && info.file_size > MAX_BYTES)) throw new Error('unavailable');
  const result = await bot.$getFile(info.file_path);
  const bytes = Buffer.from(result.data);
  if (bytes.byteLength > MAX_BYTES) throw new Error('unavailable');
  return bytes;
}

async function sendText(session: Session, text: string, messageId: number, authorize: () => Promise<boolean>) {
  for (let i = 0; i < text.length;) {
    if (!await authorize()) return;
    let end = Math.min(i + CHUNK_CHARS, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    const receipts = await session.send([h.quote(String(messageId)), h.text(text.slice(i, end))]);
    if (!receipts?.length) return;
    i = end;
  }
}

/** Add bounded Telegram file commands. Authorization is checked before I/O and again before delivery. */
export function installMediaCommands(ctx: Context, options: { authorize(session: Session): boolean | Promise<boolean> }): void {
  const register = (name: string, handler: (session: Session, input?: string) => Promise<unknown>) => {
    ctx.command(name).action(async ({ session }, input?: string) => { if (session) await handler(session, input); });
  };
  const authorize = (session: Session) => options.authorize(session);
  const fail = async (session: Session) => { try { await session.send(h.text('文件操作失败或文件过大，请确认附件后重试。')); } catch { /* no adapter detail disclosure */ } };
  register('fileinfo', async session => {
    try {
      const source = messageSource(session);
      if (!source || !await authorize(session)) return;
      const file = source.file;
      if (!file) return await session.send(h.text('请附加文件，或回复一条含附件的消息后使用命令。'));
      if (!await authorize(session)) return;
      await session.send([h.quote(String(source.raw.message_id)), h.text(`类型：${classify(file)}\n文件名：${cleanName(file.file_name)}\n大小：${file.file_size ?? '未知'} bytes`)]);
    } catch { await fail(session); }
  });
  register('readfile', async session => {
    try {
      const source = messageSource(session);
      if (!source || !await authorize(session)) return;
      const file = source.file;
      if (!file) return await session.send(h.text('请附加文件，或回复一条含附件的消息后使用命令。'));
      const kind = classify(file);
      if (kind !== 'txt' && kind !== 'md') return await session.send(h.text('目前只支持读取 .txt 和 .md 文件。'));
      const bytes = await download((session as any).bot, file);
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      await sendText(session, content || '(空文件)', source.raw.message_id, () => Promise.resolve(authorize(session)));
    } catch { await fail(session); }
  });
  register('savefile <text:text>', async (session, input = '') => {
    try {
      const source = messageSource(session);
      if (!source || !await authorize(session)) return;
      if (!input.length) return await session.send(h.text('用法：/savefile <文字>。'));
      const bytes = Buffer.from(input, 'utf8');
      if (bytes.byteLength > MAX_BYTES) return await session.send(h.text('文件内容过大，未生成文件。'));
      if (!await authorize(session)) return;
      await session.send([h.quote(String(source.raw.message_id)), h.file(bytes, 'text/plain', { name: 'saved.txt' })]);
    } catch { await fail(session); }
  });
}

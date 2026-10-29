import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');

const INPUT_LIMIT = 5 * 1024 * 1024;
const PDF_INPUT_LIMIT = 20 * 1024 * 1024;
const IMAGE_OUTPUT_LIMIT = 10 * 1024 * 1024;
const PDF_OUTPUT_LIMIT = 25 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const MAX_PDF_IMAGES = 10;
const MAX_ACTIVE = 2;
const COLLECTION_TTL_MS = 120_000;
const DEADLINE_MS = 60_000;
const MAX_PAGE_POINTS = 842;

type Raw = Record<string, any> & { is_topic_message?: boolean };
type ImageFile = { file_id: string; file_size?: number; file_name: string; mime_type: string; message_id: number };
type Source = { raw: Raw; file?: ImageFile; key: string };
type TelegramBot = {
  selfId?: string;
  local?: boolean;
  http: { post(url: string, data: unknown, config: { signal: AbortSignal; timeout: number }): Promise<any> };
  file<T>(url: string, config: { method: 'GET'; responseType: 'arraybuffer'; signal: AbortSignal; timeout: number }): Promise<{ data: T }>;
};
type Active = {
  kind: 'image' | 'pdf';
  phase: 'collecting' | 'processing';
  controller: AbortController;
  done: Promise<void>;
  finish(): void;
  files: ImageFile[];
  timer?: NodeJS.Timeout;
};

function safeMessageId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function safeChatId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) !== 0;
}

function supportedDocument(file: Raw): boolean {
  const name = typeof file.file_name === 'string' ? file.file_name : '';
  const mime = typeof file.mime_type === 'string' ? file.mime_type.toLowerCase() : '';
  return /\.(jpe?g|png|webp)$/i.test(name) || ['image/jpeg', 'image/png', 'image/webp'].includes(mime);
}

function imageFile(message?: Raw): ImageFile | undefined {
  if (!message || !safeMessageId(message.message_id)) return;
  const photos = message.photo;
  if (Array.isArray(photos) && photos.length) {
    const photo = photos[photos.length - 1];
    if (typeof photo?.file_id !== 'string' || !photo.file_id) return;
    return { file_id: photo.file_id, file_size: photo.file_size, file_name: 'photo.jpg', mime_type: 'image/jpeg', message_id: message.message_id };
  }
  const document = message.document;
  if (typeof document?.file_id !== 'string' || !document.file_id || !supportedDocument(document)) return;
  const extension = typeof document.file_name === 'string' ? document.file_name.match(/\.(jpe?g|png|webp)$/i)?.[1]?.toLowerCase() : undefined;
  const mime = typeof document.mime_type === 'string' ? document.mime_type.toLowerCase() : '';
  const suffix = extension === 'jpg' || extension === 'jpeg' ? 'jpeg' : extension || (mime === 'image/jpeg' ? 'jpeg' : mime.slice('image/'.length));
  if (!['jpeg', 'png', 'webp'].includes(suffix)) return;
  return { file_id: document.file_id, file_size: document.file_size, file_name: typeof document.file_name === 'string' ? document.file_name : `image.${suffix}`,
    mime_type: `image/${suffix}`, message_id: message.message_id };
}

function validTelegramMessage(raw: Raw): boolean {
  if (raw.sender_chat || !raw.chat || !safeMessageId(raw.message_id) || !safeChatId(raw.chat.id) || !raw.from
    || raw.from.is_bot || !Number.isSafeInteger(raw.from.id) || raw.from.id <= 0 || raw.is_topic_message === true) return false;
  if (raw.chat.type === 'private') {
    if (raw.chat.id <= 0 || raw.chat.id !== raw.from.id) return false;
  } else if ((raw.chat.type !== 'group' && raw.chat.type !== 'supergroup') || raw.chat.id >= 0) return false;
  if (raw.reply_to_message && String(raw.reply_to_message.chat?.id) !== String(raw.chat.id)) return false;
  return true;
}

function validRaw(session: Session, allowMessage: boolean): Raw | undefined {
  const messageEvent = session.type === 'message' || session.type === 'message-created';
  if (session.platform !== 'telegram' || (allowMessage ? !messageEvent : session.type !== 'interaction/command')) return;
  const raw = (session.event as any)._data?.message as Raw | undefined;
  const user = session.event.user;
  if (!raw || !validTelegramMessage(raw) || user?.isBot || String(raw.from.id) !== user?.id) return;
  if (raw.chat.type === 'private') {
    if (session.channelId !== String(raw.chat.id)) return;
  } else if (session.guildId !== String(raw.chat.id) || session.channelId !== String(raw.chat.id)) return;
  const botId = (session as Session & { bot?: TelegramBot }).bot?.selfId;
  if (!botId) return;
  return raw;
}

function callerKey(session: Session, raw: Raw): string {
  const botId = (session as Session & { bot: TelegramBot }).bot.selfId;
  return `${botId}:${raw.chat.id}:${raw.from.id}`;
}

function source(session: Session): Source | undefined {
  const raw = validRaw(session, false);
  if (!raw) return;
  const reply = raw.reply_to_message;
  return { raw, file: imageFile(raw) ?? imageFile(reply), key: callerKey(session, raw) };
}

function messageSource(session: Session): Source | undefined {
  const raw = validRaw(session, true);
  if (!raw) return;
  return { raw, file: imageFile(raw), key: callerKey(session, raw) };
}

function quote(messageId: number) { return h.quote(String(messageId)); }

async function download(session: Session, file: ImageFile, signal: AbortSignal, deadline: number): Promise<Buffer> {
  if (!file.file_id || (file.file_size !== undefined && file.file_size > INPUT_LIMIT)) throw new Error('input-limit');
  const bot = (session as Session & { bot: TelegramBot }).bot;
  if (bot.local) throw new Error('local-files-unsupported');
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
  const timeout = Math.max(1, deadline - Date.now());
  const response = await bot.http.post('/getFile', { file_id: file.file_id }, { signal, timeout });
  if (!response?.ok || !response.result?.file_path) throw new Error('download-failed');
  if (response.result.file_size !== undefined && response.result.file_size > INPUT_LIMIT) throw new Error('input-limit');
  const result = await bot.file<ArrayBuffer>(`/${response.result.file_path}`, { method: 'GET', responseType: 'arraybuffer', signal, timeout: Math.max(1, deadline - Date.now()) });
  const bytes = Buffer.from(result.data);
  if (!bytes.length || bytes.length > INPUT_LIMIT) throw new Error(bytes.length ? 'input-limit' : 'invalid-image');
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
  return bytes;
}

function validateBounds(format: unknown, width: unknown, quality: unknown): { format: 'jpg' | 'png' | 'webp'; width: number; quality: number } | undefined {
  if (typeof format !== 'string' || !['jpg', 'png', 'webp'].includes(format.toLowerCase())) return;
  const size = width === undefined ? 1280 : Number(width);
  const q = quality === undefined ? 80 : Number(quality);
  if (!Number.isSafeInteger(size) || size < 32 || size > 4096 || !Number.isSafeInteger(q) || q < 40 || q > 95) return;
  return { format: format.toLowerCase() as 'jpg' | 'png' | 'webp', width: size, quality: q };
}

function checkImage(bytes: Buffer) {
  return sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false }).metadata().then(metadata => {
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS
      || !['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages ?? 1) > 1) throw new Error('invalid-image');
    return metadata;
  });
}

async function convertedImage(bytes: Buffer, target: 'jpg' | 'png' | 'webp', width: number, quality: number): Promise<Buffer> {
  await checkImage(bytes);
  let pipeline = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false })
    .rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true });
  if (target === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality });
  else if (target === 'png') pipeline = pipeline.png({ quality });
  else pipeline = pipeline.webp({ quality });
  const result = await pipeline.toBuffer();
  if (!result.length || result.length > IMAGE_OUTPUT_LIMIT) throw new Error('output-limit');
  return result;
}

function messageFor(error: unknown): string {
  if (error instanceof Error && error.message === 'input-limit') return '单张图片超过 5 MiB 限制。';
  if (error instanceof Error && error.message === 'pdf-input-limit') return 'PDF 图片总大小超过 20 MiB 限制。';
  if (error instanceof Error && error.message === 'output-limit') return '处理结果超过大小限制，请缩小图片后重试。';
  if (error instanceof Error && error.message === 'pixel-limit') return '图片解码总像素超过 20 百万像素限制。';
  if (error instanceof Error && error.message === 'local-files-unsupported') return '当前 Telegram 本地文件模式暂不支持图片下载，请切换为远程文件模式。';
  if (error instanceof Error && error.message === 'timeout') return '图片处理超过 60 秒，已停止。';
  if (error instanceof Error && error.message === 'cancelled') return '图片处理已取消。';
  return '图片格式无效、像素过多或处理失败，请确认文件有效后重试。';
}

/** Register bounded, Telegram-only image conversion and caller-scoped PDF collection commands. */
export function installImageCommands(ctx: Context, options: { authorize(session: Session): boolean | Promise<boolean> }): void {
  const active = new Map<string, Active>();
  const send = async (session: Session, text: string, messageId?: number) => {
    await session.send(messageId ? [quote(messageId), h.text(text)] : h.text(text));
  };
  const reserve = (key: string, kind: Active['kind'], phase: Active['phase']): Active | undefined => {
    if (active.has(key) || active.size >= MAX_ACTIVE) return;
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const task: Active = { kind, phase, controller: new AbortController(), done, finish, files: [] };
    active.set(key, task);
    return task;
  };
  const release = (key: string, task: Active) => {
    if (task.timer) clearTimeout(task.timer);
    if (active.get(key) === task) active.delete(key);
    task.finish();
  };
  const failFor = async (session: Session, error: unknown, messageId?: number) => {
    if (!(error instanceof Error && error.message === 'cancelled')) await send(session, messageFor(error), messageId).catch(() => {});
  };
  const startDeadline = (task: Active) => {
    const deadline = Date.now() + DEADLINE_MS;
    const timer = setTimeout(() => task.controller.abort(new Error('timeout')), DEADLINE_MS);
    return { deadline, timer };
  };

  const collectFile = (key: string, file: ImageFile): 'ignored' | 'duplicate' | 'added' | 'count-limit' | 'size-limit' => {
    const task = active.get(key);
    if (!task || task.kind !== 'pdf' || task.phase !== 'collecting') return 'ignored';
    if (task.files.some(item => item.file_id === file.file_id || item.message_id === file.message_id)) return 'duplicate';
    if (task.files.length >= MAX_PDF_IMAGES) return 'count-limit';
    const claimed = task.files.reduce((sum, item) => sum + (item.file_size ?? 0), 0);
    if ((file.file_size ?? 0) + claimed > PDF_INPUT_LIMIT) return 'size-limit';
    task.files.push(file);
    return 'added';
  };

  ctx.command('image <format:string> [width:number] [quality:number]', '转换当前或引用的图片')
    .alias('图片转换')
    .action(async ({ session }, format?: string, width?: number, quality?: number) => {
      if (!session) return;
      const selected = source(session);
      if (!selected || !await options.authorize(session)) return;
      const params = validateBounds(format, width, quality);
      if (!params) return send(session, '用法：/image jpg|png|webp [边长上限 32–4096] [质量 40–95]。默认边长上限 1280、质量 80。', selected.raw.message_id);
      if (!selected.file) return send(session, '请附加 JPG、PNG 或 WebP 图片，或回复同一聊天中的图片后使用命令。', selected.raw.message_id);
      const task = reserve(selected.key, 'image', 'processing');
      if (!task) return send(session, active.has(selected.key) ? '你已有图片任务或 PDF 收集正在进行。请先完成或取消它。' : '当前图片任务较多，请稍后重试。', selected.raw.message_id);
      const { deadline, timer } = startDeadline(task);
      try {
        const bytes = await download(session, selected.file, task.controller.signal, deadline);
        const output = await convertedImage(bytes, params.format, params.width, params.quality);
        if (!await options.authorize(session)) return;
        if (task.controller.signal.aborted) throw task.controller.signal.reason ?? new Error('cancelled');
        const mime = params.format === 'jpg' ? 'image/jpeg' : `image/${params.format}`;
        const name = `image.${params.format}`;
        await session.send([quote(selected.raw.message_id), h.file(output, mime, { name })]);
      } catch (error) { await failFor(session, error, selected.raw.message_id); }
      finally { clearTimeout(timer); release(selected.key, task); }
    });

  // Upstream handleUpdate emits telegram/message from the raw update before
  // decodeMessage awaits media file resolution. Capture each album member here
  // so /imgpdf done cannot overtake that async decoding and album merge.
  const captureTelegramMessage = (raw: Raw, bot: TelegramBot) => {
    if (!bot?.selfId || !validTelegramMessage(raw)) return;
    const file = imageFile(raw);
    if (!file) return;
    collectFile(`${bot.selfId}:${raw.chat!.id}:${raw.from!.id}`, file);
  };
  // Keep this adapter-only event typing local: importing the adapter's root
  // types also loads its global Context augmentations into the whole project.
  const onTelegramMessage = ctx.on as unknown as (
    event: 'telegram/message',
    listener: (raw: Raw, bot: TelegramBot) => void,
  ) => void;
  onTelegramMessage('telegram/message', captureTelegramMessage);

  const capture = async (session: Session) => {
    const selected = messageSource(session);
    if (!selected?.file) return;
    // This listener only records IDs for the authorized caller's short-lived
    // collection. The raw Telegram adapter event above records before the
    // asynchronous media decoder, so /imgpdf done cannot overtake a photo.
    // This later session listener keeps existing limit feedback behavior.
    const result = collectFile(selected.key, selected.file);
    if (result === 'count-limit') {
      await send(session, 'PDF 最多收集 10 张图片；请执行 /imgpdf done 或 /imgpdf cancel。', selected.raw.message_id).catch(() => {});
      return;
    }
    if (result === 'size-limit') {
      await send(session, 'PDF 图片总大小超过 20 MiB 限制，未加入该图片。', selected.raw.message_id).catch(() => {});
    }
  };
  ctx.on('message', capture);

  const buildPdf = async (session: Session, files: ImageFile[], task: Active, deadline: number) => {
    const pdf = await PDFDocument.create();
    let total = 0;
    let totalPixels = 0;
    for (const file of [...files].sort((a, b) => a.message_id - b.message_id)) {
      if (!await options.authorize(session)) throw new Error('cancelled');
      const bytes = await download(session, file, task.controller.signal, deadline);
      total += bytes.length;
      if (total > PDF_INPUT_LIMIT) throw new Error('pdf-input-limit');
      const metadata = await checkImage(bytes);
      totalPixels += metadata.width! * metadata.height!;
      if (totalPixels > MAX_PIXELS) throw new Error('pixel-limit');
      const encoded = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error', animated: false })
        .rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
      if (!encoded.data.length || encoded.data.length > IMAGE_OUTPUT_LIMIT) throw new Error('output-limit');
      const image = await pdf.embedJpg(encoded.data);
      const scale = Math.min(1, MAX_PAGE_POINTS / Math.max(encoded.info.width, encoded.info.height));
      const width = encoded.info.width * scale;
      const height = encoded.info.height * scale;
      const page = pdf.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      if (!metadata.width || !metadata.height) throw new Error('invalid-image');
      if (task.controller.signal.aborted) throw task.controller.signal.reason ?? new Error('cancelled');
    }
    const output = Buffer.from(await pdf.save());
    if (!output.length || output.length > PDF_OUTPUT_LIMIT) throw new Error('output-limit');
    if (!await options.authorize(session)) throw new Error('cancelled');
    if (task.controller.signal.aborted) throw task.controller.signal.reason ?? new Error('cancelled');
    return output;
  };

  ctx.command('imgpdf [action:string]', '将图片整理成 PDF')
    .alias('图片转PDF')
    .action(async ({ session }, action?: string) => {
      if (!session) return;
      const selected = source(session);
      if (!selected || !await options.authorize(session)) return;
      const verb = (action || 'start').toLowerCase();
      const task = active.get(selected.key);
      if (verb === 'cancel') {
        if (!task || task.kind !== 'pdf') return send(session, '没有待处理的 PDF 收集或任务。', selected.raw.message_id);
        if (task.phase === 'collecting') {
          release(selected.key, task);
          return send(session, 'PDF 图片收集已取消。', selected.raw.message_id);
        }
        task.controller.abort(new Error('cancelled'));
        await task.done;
        return send(session, 'PDF 处理已取消。', selected.raw.message_id);
      }
      if (verb === 'start') {
        const collection = reserve(selected.key, 'pdf', 'collecting');
        if (!collection) return send(session, active.has(selected.key) ? '你已有图片任务或 PDF 收集正在进行。请先执行 /imgpdf done 或 /imgpdf cancel。' : '当前图片任务较多，请稍后重试。', selected.raw.message_id);
        if (selected.file) collection.files.push(selected.file);
        collection.timer = setTimeout(() => release(selected.key, collection), COLLECTION_TTL_MS);
        collection.timer.unref?.();
        return send(session, '已开始收集图片；接下来 120 秒内发送同一聊天中的图片，完成后执行 /imgpdf done。最多 10 张、总计 20 MiB。', selected.raw.message_id);
      }
      if (verb !== 'done') return send(session, '用法：/imgpdf [start|done|cancel]。', selected.raw.message_id);
      if (!task || task.kind !== 'pdf') return send(session, '没有待处理的 PDF 收集；请先执行 /imgpdf start。', selected.raw.message_id);
      if (task.phase !== 'collecting') return send(session, 'PDF 正在处理中，请稍候。', selected.raw.message_id);
      if (!task.files.length) return send(session, '尚未收集到图片；请发送图片后再执行 /imgpdf done。', selected.raw.message_id);
      task.phase = 'processing';
      if (task.timer) clearTimeout(task.timer);
      const { deadline, timer } = startDeadline(task);
      try {
        const output = await buildPdf(session, task.files, task, deadline);
        await session.send([quote(selected.raw.message_id), h.file(output, 'application/pdf', { name: 'images.pdf' })]);
      } catch (error) { await failFor(session, error, selected.raw.message_id); }
      finally { clearTimeout(timer); release(selected.key, task); }
    });

  ctx.on('dispose', async () => {
    const tasks = [...active.entries()];
    for (const [key, task] of tasks) {
      if (task.phase === 'collecting') release(key, task);
      else task.controller.abort(new Error('cancelled'));
    }
    await Promise.all(tasks.filter(([, task]) => task.phase === 'processing').map(([, task]) => task.done));
  });
}

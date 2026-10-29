import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const { MarkdownToImageService } = require('koishi-plugin-markdown-to-image-service') as typeof import('koishi-plugin-markdown-to-image-service');
const Puppeteer = require('koishi-plugin-puppeteer').default as typeof import('koishi-plugin-puppeteer').default;

const MAX_INPUT_BYTES = 8 * 1024;
const MAX_LINES = 120;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const markdownConfig = {
  rendering: { width: 800, maxWidth: 1000, deviceScaleFactor: 1, imageFormat: 'png' as const, imageQuality: 90, padding: 32 },
  theme: { mode: 'preset' as const, preset: 'm3-light' },
};

type RawMessage = {
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; is_bot?: boolean };
  sender_chat?: unknown;
  message_thread_id?: number;
  text?: string;
  entities?: Array<{ type?: string; offset?: number; length?: number; language?: string }>;
  reply_to_message?: { chat?: { id?: number | string }; text?: string; caption?: string };
};

function currentTelegramMessage(session: Session): RawMessage | undefined {
  if (session.platform !== 'telegram' || session.type !== 'interaction/command') return;
  const event = session.event as (Session['event'] & { _data?: { message?: RawMessage } }) | undefined;
  if (!event) return;
  const raw = event._data?.message;
  const user = session.event.user;
  if (!raw || !raw.chat || !raw.from || raw.sender_chat || raw.from.is_bot || user?.isBot
    || String(raw.from.id) !== user?.id || String(raw.chat.id) !== (session.channelId ?? session.guildId)
    || (raw.chat.type === 'private' && String(raw.chat.id) !== String(raw.from.id))
    || (raw.chat.type !== 'private' && raw.chat.type !== 'group' && raw.chat.type !== 'supergroup')
    || raw.message_thread_id) return;
  return raw;
}

const renderCommandNames = new Set(['mdimg', 'markdowntoimage', 'markdown转图']);

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/gu), match => match[0].length));
}

function isInsideMarkdownFence(text: string, offset: number): boolean {
  let marker = '';
  for (const line of text.slice(0, offset).split(/\r?\n/u)) {
    const found = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!found) continue;
    if (!marker) marker = found;
    else if (found[0] === marker[0] && found.length >= marker.length) marker = '';
  }
  return Boolean(marker);
}

function restoreTelegramCodeEntities(text: string, absoluteOffset: number, entities: RawMessage['entities']): string {
  const spans = (entities ?? []).flatMap(entity => {
    const { offset, length, type } = entity;
    if ((type !== 'code' && type !== 'pre') || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length! <= 0) return [];
    const start = offset! - absoluteOffset;
    const end = start + length!;
    if (start < 0 || end > text.length || isInsideMarkdownFence(text, start)) return [];
    return [{ start, end, type, language: entity.language }];
  }).sort((a, b) => a.start - b.start || Number(b.type === 'pre') - Number(a.type === 'pre') || b.end - a.end);

  const selected: typeof spans = [];
  for (const span of spans) {
    if (selected.some(previous => span.start < previous.end && span.end > previous.start)) continue;
    selected.push(span);
  }

  let result = '';
  let cursor = 0;
  for (const span of selected) {
    const content = text.slice(span.start, span.end);
    result += text.slice(cursor, span.start);
    if (span.type === 'pre') {
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
      const language = span.language && /^[A-Za-z0-9_+#.-]{1,32}$/u.test(span.language) ? span.language : '';
      result += `${fence}${language}\n${content}${content.endsWith('\n') ? '' : '\n'}${fence}`;
    } else {
      const fence = '`'.repeat(Math.max(1, longestBacktickRun(content) + 1));
      const padding = content.startsWith('`') || content.endsWith('`') || (content.startsWith(' ') && content.endsWith(' ')) ? ' ' : '';
      result += `${fence}${padding}${content}${padding}${fence}`;
    }
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

function rawCommandArgument(text: string, entities?: RawMessage['entities']): { matched: boolean; argument?: string } {
  const match = /^\/([^\s@]+)(?:@[A-Za-z0-9_]+)?/u.exec(text);
  if (!match || !renderCommandNames.has(match[1].toLocaleLowerCase('en-US'))) return { matched: false };
  const remainder = text.slice(match[0].length);
  if (!remainder) return { matched: true };
  const delimiter = /^(?:\r\n|[ \t\r\n])/u.exec(remainder)?.[0];
  if (!delimiter) return { matched: true };
  const bodyOffset = match[0].length + delimiter.length;
  const argument = restoreTelegramCodeEntities(text.slice(bodyOffset), bodyOffset, entities);
  return { matched: true, ...(argument.trim() ? { argument } : {}) };
}

function commandText(session: Session, input?: string): string | undefined {
  const raw = currentTelegramMessage(session);
  if (typeof raw?.text === 'string') {
    const parsed = rawCommandArgument(raw.text, raw.entities);
    if (!parsed.matched) return;
    if (parsed.argument) return parsed.argument;
  } else {
    const direct = input?.trim();
    if (direct) return direct;
  }
  const quoted = raw?.reply_to_message;
  if (!quoted || String(quoted.chat?.id) !== String(raw?.chat?.id)) return;
  const text = (quoted.text ?? quoted.caption)?.trim();
  return text || undefined;
}

function validInput(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= MAX_INPUT_BYTES && text.split(/\r?\n/).length <= MAX_LINES;
}

export interface MarkdownIntegrationOptions {
  enabled: boolean;
  executablePath?: string;
  authorize(session: Session): boolean | Promise<boolean>;
}

/** Use the upstream renderer service behind a bounded, same-chat Telegram command. */
export function installMarkdownIntegration(ctx: Context, options: MarkdownIntegrationOptions): void {
  const command = ctx.command('mdimg [text:text]', 'Markdown 转图片').alias('markdownToImage').alias('Markdown转图');
  let busy = false;
  const allowed = async (session: Session) => Boolean(currentTelegramMessage(session)) && await options.authorize(session);

  command.check(async ({ session }) => {
    if (!session || !await allowed(session)) return '';
  });

  if (!options.enabled) {
    command.action(({ session }) => session ? h.text('Markdown 转图片功能尚未配置。') : '');
    return;
  }

  ctx.plugin(Puppeteer, {
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    headless: true,
    args: [],
  });
  ctx.plugin(MarkdownToImageService, markdownConfig);

  command.action(async ({ session }, input?: string) => {
    if (!session || !await allowed(session)) return '';
    const markdown = commandText(session, input);
    if (!markdown) return h.text('请在命令后提供 Markdown，或回复同一会话中的文本/说明后使用命令。');
    if (!validInput(markdown)) return h.text('Markdown 超出限制（最多 8 KiB、120 行）。');
    if (busy) return h.text('渲染器正忙，请稍后重试。');
    busy = true;
    try {
      const service = (ctx as Context & { markdownToImage?: { convertToImage(text: string): Promise<Buffer> } }).markdownToImage;
      if (!service) return h.text('Markdown 渲染服务尚未就绪。');
      const image = await service.convertToImage(markdown);
      if (!await allowed(session)) return '';
      if (image.byteLength > MAX_OUTPUT_BYTES) return h.text('生成的图片超出大小限制。');
      try { await session.send(h.image(image, 'image/png')); } catch { /* Delivery may be unknown; do not retry or misreport. */ }
      return '';
    } catch {
      if (await allowed(session)) return h.text('图片暂时无法生成，请缩短内容后重试。');
      return '';
    } finally {
      busy = false;
    }
  });
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Context } from 'koishi';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { installImageCommands } from '../src/server/koishi-images.js';

const require = createRequire(import.meta.url);
const { TelegramBot, handleUpdate } = require('@satorijs/adapter-telegram');

class UpstreamDispatchBot extends TelegramBot {
  readonly bots: Context['bots'];
  readonly uploaded: FormData[] = [];
  readonly outbound: string[] = [];
  readonly dispatched: any[] = [];
  readonly downloadedIds: string[] = [];
  readonly image: Buffer;
  photoDecodeGate?: Promise<void>;
  internal: any;
  http: any;
  file: any;
  local = false;

  constructor(ctx: Context, image: Buffer) {
    super(ctx, {
      token: '999:fixture-token', endpoint: 'https://api.telegram.org',
      files: { endpoint: 'https://api.telegram.org', local: false }, protocol: 'polling',
    });
    this.user = { id: '999', name: 'fixture_bot', isBot: true };
    this.bots = ctx.bots;
    this.image = image;
    const response = (chat_id: string | number, text = '') => ({
      message_id: 900 + this.outbound.length, date: 1, chat: { id: Number(chat_id), type: 'private' },
      from: { id: 999, is_bot: true }, text,
    });
    this.internal = {
      sendMessage: async (payload: { chat_id: string | number; text: string }) => {
        this.outbound.push(payload.text);
        return response(payload.chat_id, payload.text);
      },
      sendDocument: async (form: FormData) => {
        this.uploaded.push(form);
        return response(form.get('chat_id') as string);
      },
    };
    this.http = { post: async (_url: string, payload: { file_id: string }) => {
      this.downloadedIds.push(payload.file_id);
      return { ok: true, result: { file_path: `photos/${payload.file_id}`, file_size: image.length } };
    } };
    this.file = async (_url: string) => ({ data: image });
  }

  async $getFileFromId(_fileId: string) {
    await this.photoDecodeGate;
    return { src: `data:image/png;base64,${this.image.toString('base64')}` };
  }
  dispatch(session: any) { this.dispatched.push(session); return super.dispatch(session); }
  async start() {}
  async stop() {}
  async dispose() {
    const index = this.bots.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.bots.splice(index, 1);
  }
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(check(), label);
}

test('upstream Telegram photo updates are captured into a two-page PDF collection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gw-image-upstream-'));
  const configPath = path.join(directory, 'koishi.yml');
  await writeFile(configPath, `plugins:\n  http: {}\n  database-sqlite:\n    path: ${path.join(directory, 'koishi.db')}\n  help: {}\n  echo: {}\n`);
  const image = await sharp({ create: { width: 80, height: 40, channels: 3, background: '#d43b2a' } }).png().toBuffer();
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  let bot: UpstreamDispatchBot | undefined;
  let releasePhotoDecode!: () => void;
  const pendingPhotoHandlers: Promise<void>[] = [];
  try {
    runtime = await createKoishiRuntime({
      configPath,
      setup(app) {
        installImageCommands(app, { authorize: () => true });
        bot = new UpstreamDispatchBot(app, image);
      },
    });
    await runtime.start();
    const command = (updateId: number, messageId: number, text: string) => ({
      update_id: updateId,
      message: { message_id: messageId, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'Tester' },
        text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] },
    });
    const photo = (updateId: number, messageId: number, fileId: string) => ({
      update_id: updateId,
      message: { message_id: messageId, date: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false, first_name: 'Tester' },
        media_group_id: 'album-race-fixture',
        photo: [{ file_id: `${fileId}-small`, file_unique_id: `${fileId}-small-unique`, file_size: 100, width: 400, height: 300 },
          { file_id: fileId, file_unique_id: `${fileId}-unique`, file_size: 200, width: 800, height: 600 }] },
    });
    await handleUpdate(command(1, 101, '/imgpdf start') as any, bot!);
    await waitFor(() => bot!.outbound.some(text => text.includes('已开始收集图片')), 'start command should run through Koishi dispatch');
    const firstPhoto = photo(2, 102, 'photo-one') as any;
    const secondPhoto = photo(3, 103, 'photo-two') as any;
    bot!.photoDecodeGate = new Promise<void>(resolve => { releasePhotoDecode = resolve; });
    pendingPhotoHandlers.push(handleUpdate(firstPhoto, bot!));
    pendingPhotoHandlers.push(handleUpdate(secondPhoto, bot!));
    await handleUpdate(command(4, 104, '/imgpdf done') as any, bot!);
    await waitFor(() => bot!.uploaded.length === 1 || bot!.outbound.some(text => text.includes('尚未收集到图片')), 'done command should return a result');
    releasePhotoDecode();
    await Promise.all(pendingPhotoHandlers);
    bot!.photoDecodeGate = undefined;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(bot!.uploaded.length, 1, `two upstream photo updates should produce a PDF upload; responses=${JSON.stringify(bot!.outbound)}`);

    assert.deepEqual(firstPhoto.message.photo.map((item: { file_id: string }) => item.file_id), ['photo-one-small', 'photo-one']);
    assert.deepEqual(secondPhoto.message.photo.map((item: { file_id: string }) => item.file_id), ['photo-two-small', 'photo-two']);

    const photoSessions = bot!.dispatched.filter(session => session.event._data?.message?.photo);
    assert.deepEqual(photoSessions.map(session => session.type), ['message-created']);
    assert.deepEqual(photoSessions.map(session => session.event._data.mediaGroup), [[102, 103]]);
    assert.deepEqual(bot!.downloadedIds, ['photo-one', 'photo-two']);

    const form = bot!.uploaded[0];
    const fieldName = String(form.get('document')).replace(/^attach:\/\//, '');
    const uploadFile = form.get(fieldName);
    assert.ok(uploadFile instanceof File);
    const pdf = await PDFDocument.load(Buffer.from(await uploadFile.arrayBuffer()));
    assert.equal(pdf.getPageCount(), 2);
  } finally {
    releasePhotoDecode?.();
    await Promise.allSettled(pendingPhotoHandlers);
    await runtime?.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Context } from 'koishi';
import { startKoishiHost } from '../src/server/koishi-index.js';

const require = createRequire(import.meta.url);
const { Bot, h } = require('@koishijs/core') as typeof import('koishi');
const { TelegramBot } = require('@satorijs/adapter-telegram');

/** Real upstream encoder; only Telegram's HTTP endpoint is replaced. */
class EncodingBot extends Bot<Context> {
  static MessageEncoder = TelegramBot.MessageEncoder;
  forms: FormData[] = [];
  animations: FormData[] = [];
  audioForms: FormData[] = [];
  videoForms: FormData[] = [];
  photoForms: FormData[] = [];
  attachment = Buffer.alloc(0);
  text: string[] = [];
  internal: any;
  http: { post: (url: string, payload: { file_id: string }, config: { signal: AbortSignal; timeout: number }) => Promise<unknown> };
  file: (url: string, config: { signal: AbortSignal; timeout: number; responseType: string }) => Promise<{ data: Buffer }>;
  private readonly bots: Context['bots'];
  constructor(ctx: Context) {
    super(ctx, {}, 'telegram'); this.platform = 'telegram'; this.selfId = '99';
    this.bots = ctx.bots;
    this.user = { id: '99', name: 'test_bot', isBot: true };
    const result = () => ({ message_id: 200, date: 1, chat: { id: 7, type: 'private' }, from: { id: 99, is_bot: true }, text: 'receipt' });
    this.internal = {
      sendDocument: async (form: FormData) => { this.forms.push(form); return result(); },
      sendAnimation: async (form: FormData) => { this.animations.push(form); return result(); },
      sendAudio: async (form: FormData) => { this.audioForms.push(form); return result(); },
      sendVideo: async (form: FormData) => { this.videoForms.push(form); return result(); },
      sendPhoto: async (form: FormData) => { this.photoForms.push(form); return result(); },
      sendMessage: async (payload: { text: string }) => { this.text.push(payload.text); return result(); },
      getFile: async () => ({ file_path: 'sample.mp4', file_size: this.attachment.length }),
    };
    this.http = { post: async (url, payload, config) => {
      assert.equal(url, '/getFile'); assert.equal(payload.file_id, 'local-fixture');
      assert.ok(config.signal instanceof AbortSignal); assert.ok(config.timeout > 0);
      return { ok: true, result: { file_path: 'sample.mp4', file_size: this.attachment.length } };
    } };
    this.file = async (url, config) => {
      assert.equal(url, '/sample.mp4'); assert.equal(config.responseType, 'arraybuffer');
      assert.ok(config.signal instanceof AbortSignal); assert.ok(config.timeout > 0);
      return { data: this.attachment };
    };
  }
  override async start() {}
  async $getFile() { return { data: this.attachment, type: 'video/mp4' }; }
  override async stop() {}
  override async dispose() { const i = this.bots.findIndex(bot => bot.sn === this.sn); if (i >= 0) this.bots.splice(i, 1); }
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  return port;
}

test('native host exposes private commands and sends real text/GIF bytes through upstream Telegram encoder', async () => {
  const dir = await mkdtemp(path.join(process.cwd(), 'artifacts', 'native-host-'));
  const configPath = path.join(dir, 'koishi.yml');
  await writeFile(configPath, await readFile('koishi.yml', 'utf8'));
  const browserPath = process.env.RENDER_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const settings = { ENABLE_TELEGRAM: '0', ENABLE_AI: '0', ENABLE_MEDIA: '1', ENABLE_RENDER: existsSync(browserPath) ? '1' : '0', RENDER_BROWSER_PATH: browserPath, SITE_PARSER_API_URL: '', SITE_PARSER_API_KEY: '', FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', PORT: String(await freePort()), SANDBOX_AI_BINDING_MODULE: '' };
  const prior = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  let host: Awaited<ReturnType<typeof startKoishiHost>> | undefined;
  let bot: EncodingBot | undefined;
  try {
    host = await startKoishiHost(configPath);
    const health = (await host.app.inject('/api/health')).json();
    assert.equal(health.agentConfigured, false);
    for (const name of ['ask', 'digest', 'translate', 'brief', 'fileinfo', 'readfile', 'savefile', 'v2g', 'convert', 'clip', 'mediainfo', 'cancelmedia', 'image', 'imgpdf', 'mdimg', 'parse']) assert.ok(host.runtime.app.$commander.get(name), name);
    new EncodingBot(host.runtime.app);
    bot = host.runtime.app.bots.find(item => item.platform === 'telegram') as EncodingBot;
    const text = '/savefile hello <b>世界</b>';
    const raw = { update_id: 1, message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false }, text } };
    const session = bot.session({ type: 'interaction/command', user: { id: '7', isBot: false }, channel: { id: '7', type: 1 }, message: { id: '1', content: text, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    await session.execute('savefile hello <b>世界</b>', true);
    assert.equal(bot.forms.length, 1);
    const form = bot.forms[0];
    assert.equal(form.get('chat_id'), '7');
    assert.equal(form.get('reply_to_message_id'), '1');
    const field = String(form.get('document')).replace('attach://', '');
    const document = form.get(field) as File;
    assert.match(document.name, /\.txt$/);
    assert.equal(document.type, 'text/plain');
    assert.equal(await document.text(), 'hello <b>世界</b>');
    await session.execute('plugins', true);
    assert.ok(bot.text.some(text => text.includes('/v2g')));
    await session.execute('cancel', true);
    assert.ok(bot.text.some(text => text.includes('本人私聊中没有可取消')));
    assert.deepEqual(host.app.groupweave.store.groups('tg-user:7'), []);

    // Full native plugin + real HTTP data-URI helper + real FFmpeg + real
    // Telegram multipart encoder. Only the Telegram network response is fake.
    const videoPath = path.join(dir, 'sample.mp4');
    const generated = spawnSync(settings.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=80x60:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', videoPath]);
    assert.equal(generated.status, 0, String(generated.stderr));
    const bytes = await readFile(videoPath);
    bot.attachment = bytes;
    const video = h('video', { src: `data:video/mp4;base64,${bytes.toString('base64')}` });
    const videoRaw = { update_id: 2, message: { message_id: 2, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: '/v2g', video: { file_id: 'local-fixture' } } };
    const videoSession = bot.session({ type: 'interaction/command', user: { id: '7' }, channel: { id: '7', type: 1 }, message: { id: '2', content: `/v2g ${video}`, elements: [h.text('/v2g '), video] }, _data: videoRaw } as any);
    videoSession.setInternal('telegram', videoRaw);
    await videoSession.execute('v2g', true);
    assert.equal(bot.animations.length, 1, bot.text.join('\n'));
    const animation = bot.animations[0];
    assert.equal(animation.get('chat_id'), '7');
    const gif = animation.get(String(animation.get('animation')).replace('attach://', '')) as File;
    assert.equal(gif.type, 'image/gif');
    assert.match(gif.name, /\.gif$/);
    assert.match(Buffer.from(await gif.arrayBuffer()).subarray(0, 6).toString('ascii'), /^GIF8/);
    const mediaSession = (command: string, messageId: number) => {
      const source = { update_id: messageId, message: { message_id: messageId, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: `/${command}`,
        reply_to_message: { message_id: 2, chat: { id: 7, type: 'private' }, video: { file_id: 'local-fixture', file_size: bytes.length } } } };
      const created = bot!.session({ type: 'interaction/command', user: { id: '7' }, channel: { id: '7', type: 1 }, message: { id: String(messageId), content: `/${command}`, elements: [] }, _data: source } as any);
      created.setInternal('telegram', source);
      return created;
    };
    await mediaSession('convert mp3', 3).execute('convert mp3', true);
    assert.equal(bot.audioForms.length, 1, bot.text.join('\n'));
    const audioForm = bot.audioForms[0];
    assert.equal(audioForm.get('chat_id'), '7');
    assert.equal(audioForm.get('reply_to_message_id'), '3');
    const mp3 = audioForm.get(String(audioForm.get('audio')).replace('attach://', '')) as File;
    assert.equal(mp3.type, 'audio/mpeg');
    assert.ok(mp3.size > 100);
    await mediaSession('convert mp4', 4).execute('convert mp4', true);
    assert.equal(bot.videoForms.length, 1, bot.text.join('\n'));
    const videoForm = bot.videoForms[0];
    assert.equal(videoForm.get('chat_id'), '7');
    const mp4 = videoForm.get(String(videoForm.get('video')).replace('attach://', '')) as File;
    assert.equal(mp4.type, 'video/mp4');
    assert.ok(mp4.size > 100);

    // Real Sharp/PDF bytes go through the same official Telegram encoder.
    bot.attachment = await sharp({ create: { width: 128, height: 96, channels: 3, background: '#397888' } }).png().toBuffer();
    const imageSession = (command: string, messageId: number) => {
      const source = { update_id: messageId, message: { message_id: messageId, chat: { id: 7, type: 'private' }, from: { id: 7 }, text: `/${command}`,
        reply_to_message: { message_id: 5, chat: { id: 7, type: 'private' }, photo: [{ file_id: 'local-fixture', file_size: bot!.attachment.length }] } } };
      const created = bot!.session({ type: 'interaction/command', user: { id: '7' }, channel: { id: '7', type: 1 }, message: { id: String(messageId), content: `/${command}`, elements: [] }, _data: source } as any);
      created.setInternal('telegram', source);
      return created;
    };
    await imageSession('image png 64 80', 6).execute('image png 64 80', true);
    assert.equal(bot.forms.length, 2, bot.text.join('\n'));
    const pictureForm = bot.forms[1];
    const picture = pictureForm.get(String(pictureForm.get('document')).replace('attach://', '')) as File;
    assert.equal(picture.type, 'image/png');
    assert.equal((await sharp(Buffer.from(await picture.arrayBuffer())).metadata()).width, 64);
    await imageSession('imgpdf start', 7).execute('imgpdf start', true);
    await imageSession('imgpdf done', 8).execute('imgpdf done', true);
    assert.equal(bot.forms.length, 3, bot.text.join('\n'));
    const pdfForm = bot.forms[2];
    assert.equal(pdfForm.get('chat_id'), '7');
    const pdf = pdfForm.get(String(pdfForm.get('document')).replace('attach://', '')) as File;
    assert.equal(pdf.type, 'application/pdf');
    assert.equal((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount(), 1);
    const renderResult = await imageSession('mdimg hello', 9).execute('mdimg hello', true);
    if (settings.ENABLE_RENDER === '1') {
      assert.equal(bot.photoForms.length, 1, bot.text.join('\n'));
      const photoForm = bot.photoForms[0];
      assert.equal(photoForm.get('chat_id'), '7');
      const png = photoForm.get(String(photoForm.get('photo')).replace('attach://', '')) as File;
      assert.equal(png.type, 'image/png');
      assert.equal((await sharp(Buffer.from(await png.arrayBuffer())).metadata()).format, 'png');
    } else assert.match(renderResult.map(item => item.toString()).join(''), /未配置|未开启/);
    await imageSession('parse https://www.bilibili.com/video/BV1xx', 10).execute('parse https://www.bilibili.com/video/BV1xx', true);
    assert.ok(bot.text.some(value => /待配置|未配置/.test(value)), bot.text.join('\n'));
    await bot.dispose(); bot = undefined;
    await host.stop(); host = undefined;
    process.env.ENABLE_AI = '1';
    await assert.rejects(startKoishiHost(configPath), /SANDBOX_AI_BINDING_MODULE/);
  } finally {
    await bot?.dispose(); await host?.stop();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});

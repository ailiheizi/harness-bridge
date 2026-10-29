import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { installVideoIntegration } from '../src/server/koishi-video.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const { FFmpeg } = require('koishi-plugin-ffmpeg') as typeof import('koishi-plugin-ffmpeg');
const fluentFfmpeg = require('fluent-ffmpeg') as any;
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const ffmpegCheck = spawnSync(FFMPEG_PATH, ['-version'], { encoding: 'utf8' });
if (ffmpegCheck.error || ffmpegCheck.status !== 0) {
  throw new Error(`FFmpeg is required for koishi-video tests. Could not run "${FFMPEG_PATH}"; install ffmpeg or set FFMPEG_PATH to its executable.`);
}

function makeHarness(session: any, options: { authorize?: () => boolean | Promise<boolean>; input?: Buffer; ffmpegPath?: string } = {}) {
  const actions = new Map<string, (argv: any, value?: string) => Promise<unknown> | unknown>();
  let before: ((argv: any) => Promise<unknown>) | undefined;
  let middleware: ((session: any, next: () => Promise<unknown>) => Promise<unknown>) | undefined;
  let disposed = false;
  let fileCalls = 0;
  let getCalls = 0;
  const ctx: any = {
    reflect: { provide(name: string, service: unknown) { ctx[name] = service; } },
    logger: () => ({ info() {}, warn() {}, error() {} }),
    http: {
      get: async () => { getCalls++; return options.input; },
      file: async (url: string) => { fileCalls++; return { data: url.startsWith('data:') ? Buffer.from(url.slice(url.indexOf(',') + 1), 'base64') : options.input }; },
    },
    command(name: string) { return { action(fn: (argv: any, value?: string) => Promise<unknown> | unknown) { actions.set(name.split(' ')[0], fn); return this; } }; },
    on(event: string, fn: typeof before) { if (event === 'command/before-execute') before = fn; },
    middleware(fn: any) { middleware = fn; return () => { disposed = true; }; },
    plugin(plugin: any, config: any) { return plugin.apply(ctx, config); },
  };
  ctx.ffmpeg = new FFmpeg(ctx, options.ffmpegPath ?? FFMPEG_PATH);
  installVideoIntegration(ctx, { authorize: options.authorize ?? (() => true) });
  return {
    get middleware() { return middleware; },
    get disposed() { return disposed; },
    get fileCalls() { return fileCalls; },
    get getCalls() { return getCalls; },
    async run(command = 'v2g', commandSession = session) {
      const argv = { command: { name: command }, session: commandSession, args: [] };
      const blocked = await before?.(argv);
      if (blocked !== undefined) return blocked;
      return actions.get(command)?.({ session: commandSession }, undefined);
    },
  };
}

function tgSession(rawMessage: any, elements: any[], quoteElements: any[] = []) {
  const sent: any[] = [];
  return {
    platform: 'telegram', type: 'interaction/command', guildId: String(rawMessage.chat.id), channelId: String(rawMessage.chat.id),
    cid: `telegram:${rawMessage.chat.id}`, userId: String(rawMessage.from.id),
    event: { user: { id: String(rawMessage.from.id), isBot: false }, _data: { message: rawMessage } },
    elements, quote: quoteElements.length ? { elements: quoteElements } : undefined,
    bot: { selfId: 'bot-1' },
    send: async (element: any) => { sent.push(element); return ['receipt']; }, _sent: sent,
  };
}

test('authorized native Telegram video is converted by upstream ffmpeg plugin and sent as a GIF image', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-video-'));
  const inputPath = path.join(dir, 'sample.mp4');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generated = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=80x60:d=1', '-pix_fmt', 'yuv420p', '-y', inputPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const input = await readFile(inputPath);
  const media = h('video', { src: 'https://telegram.test/file/sample.mp4' });
  const session: any = tgSession({ message_id: 20, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, reply_to_message: { video: { file_id: 'video-1' } } }, [], [media]);
  const harness = makeHarness(session, { input });
  await harness.run();
  assert.equal(harness.fileCalls, 0);
  assert.equal(harness.getCalls, 1);
  const image = session._sent.find((item: any) => item?.type === 'img');
  assert.ok(image, 'upstream plugin should send a native image element');
  const dataUrl = image.attrs.src;
  assert.match(dataUrl, /^data:image\/gif;base64,/);
  const gif = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  assert.ok(gif.subarray(0, 6).toString('ascii').startsWith('GIF8'));
});

test('unauthorized users are stopped before upstream conversion or delivery', async () => {
  const session: any = tgSession({ message_id: 21, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, video: { file_id: 'video-1' } }, [h('video', { src: 'https://telegram.test/file/sample.mp4' })]);
  const harness = makeHarness(session, { authorize: () => false, input: Buffer.from('unused') });
  await harness.run();
  assert.deepEqual(session._sent, []);
});

test('native Telegram data URI is decoded through Koishi HTTP file helper and converted by upstream ffmpeg', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-video-data-'));
  const inputPath = path.join(dir, 'sample.mp4');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const generated = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=80x60:d=1', '-pix_fmt', 'yuv420p', '-y', inputPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const input = await readFile(inputPath);
  const session: any = tgSession({ message_id: 22, chat: { id: 7, type: 'private' }, from: { id: 7 }, video: { file_id: 'video-1' } }, [h('video', { src: `data:video/mp4;base64,${input.toString('base64')}` })]);
  const harness = makeHarness(session, { input });
  await harness.run();
  assert.equal(harness.fileCalls, 1);
  assert.equal(harness.getCalls, 0);
  const image = session._sent.find((item: any) => item?.type === 'img');
  assert.ok(image);
  assert.ok(Buffer.from(image.attrs.src.split(',')[1], 'base64').subarray(0, 6).toString('ascii').startsWith('GIF8'));
});

test('interactive v2g ignores a video from another sender and accepts one from the invoking user', async () => {
  const session: any = tgSession({ message_id: 23, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 } }, []);
  const harness = makeHarness(session);
  const running = harness.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.middleware);
  let nextCalled = false;
  await harness.middleware!({ cid: session.cid, userId: '8', author: { id: '8' }, elements: [h('video', { src: 'https://telegram.test/file/other.mp4' })] }, async () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  await harness.middleware!({ cid: session.cid, userId: '7', author: { id: '7' }, elements: [h('video', { src: 'https://telegram.test/file/own.mp4' })] }, async () => {});
  assert.equal(harness.disposed, true);
  assert.equal(await running, '视频处理失败，请检查视频后重试。');
});

test('cancelv2g ends a wait for the invoking user video and suppresses the old conversion result', async () => {
  const session: any = tgSession({ message_id: 25, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 } }, []);
  const harness = makeHarness(session);
  const running = harness.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.middleware);

  const otherUser: any = tgSession({ message_id: 26, chat: { id: -10042, type: 'supergroup' }, from: { id: 8 }, text: '/cancelv2g' }, []);
  assert.match(String(await harness.run('cancelv2g', otherUser)), /没有正在运行/);
  assert.equal(harness.disposed, false, 'another user in the same chat cannot cancel this run');

  const cancelSession: any = tgSession({ message_id: 27, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, text: '/cancelv2g' }, []);
  const response = await harness.run('cancelv2g', cancelSession);
  assert.match(String(response), /已取消视频转 GIF/);
  assert.equal(await running, '');
  assert.equal(harness.disposed, true);
  assert.equal(session._sent.filter((item: any) => item?.type === 'img').length, 0);
});

test('cancelv2g kills a blocking FFmpeg conversion and prevents result upload', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-video-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputPath = path.join(dir, 'sample.mp4');
  const marker = path.join(dir, 'conversion-started');
  const fakeFfmpeg = path.join(dir, 'ffmpeg-blocking');
  const generated = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=80x60:d=1', '-pix_fmt', 'yuv420p', '-y', inputPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const input = await readFile(inputPath);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(fakeFfmpeg, `#!/bin/sh\nif [ "$#" -eq 2 ] && [ "$1" = '-i' ]; then exec ${quote(FFMPEG_PATH)} "$@"; fi\ntouch ${quote(marker)}\nexec sleep 30\n`);
  await chmod(fakeFfmpeg, 0o755);

  const session: any = tgSession({ message_id: 28, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, video: { file_id: 'video-1' } }, [h('video', { src: 'https://telegram.test/file/sample.mp4' })]);
  const harness = makeHarness(session, { input, ffmpegPath: fakeFfmpeg });
  const running = harness.run();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try { await readFile(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  await readFile(marker);
  const cancelSession: any = tgSession({ message_id: 29, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, text: '/cancelv2g' }, []);
  assert.match(String(await harness.run('cancelv2g', cancelSession)), /已取消视频转 GIF/);
  assert.equal(await Promise.race([running, new Promise(resolve => setTimeout(() => resolve('still-running'), 2_000))]), '');
  assert.equal(session._sent.filter((item: any) => item?.type === 'img').length, 0);
});

test('cancelv2g before FFmpeg start kills the child when delayed preparation finishes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-video-delayed-start-'));
  const inputPath = path.join(dir, 'sample.mp4');
  const marker = path.join(dir, 'conversion-started');
  const pidFile = path.join(dir, 'conversion-pid');
  const fakeFfmpeg = path.join(dir, 'ffmpeg-delayed-start');
  const generated = spawnSync(FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=80x60:d=1', '-pix_fmt', 'yuv420p', '-y', inputPath]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const input = await readFile(inputPath);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(fakeFfmpeg, `#!/bin/sh\nif [ "$#" -eq 2 ] && [ "$1" = '-i' ]; then exec ${quote(FFMPEG_PATH)} "$@"; fi\necho $$ > ${quote(pidFile)}\nsleep 0.5\ntouch ${quote(marker)}\nexec sleep 30\n`);
  await chmod(fakeFfmpeg, 0o755);
  t.after(async () => {
    try { process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL'); } catch {}
    await rm(dir, { recursive: true, force: true });
  });

  const session: any = tgSession({ message_id: 30, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, video: { file_id: 'video-1' } }, [h('video', { src: 'https://telegram.test/file/sample.mp4' })]);
  const harness = makeHarness(session, { input, ffmpegPath: fakeFfmpeg });
  const originalAvailableEncoders = fluentFfmpeg.prototype.availableEncoders;
  let markPreparation!: () => void;
  const preparing = new Promise<void>(resolve => { markPreparation = resolve; });
  fluentFfmpeg.prototype.availableEncoders = function(callback: (...args: any[]) => void) {
    markPreparation();
    setTimeout(() => originalAvailableEncoders.call(this, callback), 300);
  };
  try {
    const running = harness.run();
    await preparing;
    const cancelSession: any = tgSession({ message_id: 31, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, text: '/cancelv2g' }, []);
    assert.match(String(await harness.run('cancelv2g', cancelSession)), /已取消视频转 GIF/);
    assert.equal(await running, '');
    await new Promise(resolve => setTimeout(resolve, 800));
    await assert.rejects(readFile(marker));
    assert.equal(session._sent.filter((item: any) => item?.type === 'img').length, 0);
  } finally {
    fluentFfmpeg.prototype.availableEncoders = originalAvailableEncoders;
  }
});

test('upstream failure reports a generic result and removes temporary video files', async () => {
  const before = new Set(await readdir(os.tmpdir()));
  const session: any = tgSession({ message_id: 24, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, video: { file_id: 'video-1' } }, [h('video', { src: 'https://telegram.test/file/bad.mp4' })]);
  const result = await makeHarness(session, { input: Buffer.from('not a video') }).run();
  assert.equal(result, '视频处理失败，请检查视频后重试。');
  const added = (await readdir(os.tmpdir())).filter(name => name.startsWith('v2g_') && !before.has(name));
  assert.deepEqual(added, []);
  assert.deepEqual(session._sent.filter((item: any) => item?.type === 'img'), []);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context, Session } from 'koishi';
import { installTranscodeCommands } from '../src/server/koishi-transcode.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function available(command: string) { return spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0; }

function harness(raw: any, input: Buffer, opts: { authorize?: () => boolean; ffmpegPath?: string; ffprobePath?: string; downloadDelay?: boolean; local?: boolean } = {}) {
  const actions = new Map<string, (...args: any[]) => Promise<unknown>>();
  const sent: any[] = [];
  const calls: string[] = [];
  const ctx: any = {
    command(name: string) { return { action(fn: (...args: any[]) => Promise<unknown>) { actions.set(name.split(' ')[0], fn); return this; } }; },
    on() {},
  };
  const session: any = {
    platform: 'telegram', type: 'interaction/command', guildId: String(raw.chat.id), channelId: String(raw.chat.id),
    event: { user: { id: String(raw.from.id), isBot: false }, _data: { message: raw } },
    bot: {
      local: opts.local,
      http: { post: async (url: string, payload: any, config: any) => {
        calls.push(`getFile:${payload.file_id}`);
        assert.equal(url, '/getFile');
        assert.ok(config.signal instanceof AbortSignal);
        assert.ok(config.timeout > 0);
        return { ok: true, result: { file_path: 'safe/file.bin', file_size: input.length } };
      } },
      file: async (url: string, config: any) => {
        calls.push(`download:${url}`);
        assert.equal(url, '/safe/file.bin');
        assert.ok(config.signal instanceof AbortSignal);
        if (opts.downloadDelay) await new Promise((resolve, reject) => {
          if (config.signal.aborted) return reject(config.signal.reason);
          config.signal.addEventListener('abort', () => reject(config.signal.reason), { once: true });
        });
        return { data: input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) };
      },
    },
    send: async (element: any) => { sent.push(element); return ['sent']; },
  };
  installTranscodeCommands(ctx as Context, { authorize: opts.authorize ?? (() => true), ffmpegPath: opts.ffmpegPath ?? FFMPEG, ffprobePath: opts.ffprobePath ?? FFPROBE });
  return { actions, sent, calls, session, run: (name: string, ...args: unknown[]) => actions.get(name)!({ session } as any, ...args) };
}

async function fixture(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcode-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'input.mp4');
  // H.264 4:4:4 preserves odd dimensions in a valid MP4 on both supported
  // FFmpeg versions; FFV1-in-MP4 is rejected by Debian's FFmpeg 7.
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=97x65:rate=12:duration=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', '-y', file]);
  assert.equal(result.status, 0, result.stderr?.toString());
  const bytes = await readFile(file);
  assert.deepEqual(await inspectBuffer(t, bytes), { width: 97, height: 65 });
  return bytes;
}

const mediaMessage = (kind = 'video', id = 'media-1'): any => ({ message_id: 51, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, [kind]: { file_id: id, file_name: 'clip.mp4', file_size: 1000 } });

async function inspectBuffer(t: any, buffer: Buffer) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcode-output-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'output.mp4');
  await writeFile(input, buffer);
  const check = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', input]);
  assert.equal(check.status, 0, check.stderr?.toString());
  const [stream] = JSON.parse(check.stdout.toString()).streams;
  return stream as { width: number; height: number };
}

test('media info and mp4/mp3/m4a/small/clip conversions return native media with real output bytes', { skip: !available(FFMPEG) || !available(FFPROBE) }, async t => {
  const input = await fixture(t);
  const threadedReply = mediaMessage();
  threadedReply.message_thread_id = 42;
  threadedReply.is_topic_message = false;
  threadedReply.reply_to_message = { message_id: 39, chat: { id: -10042, type: 'supergroup' }, video: { file_id: 'media-1', file_name: 'clip.mp4' } };
  const info = harness(threadedReply, input);
  await info.run('mediainfo');
  assert.match(info.sent[0][1].attrs.content, /Video:/);
  assert.match(info.sent[0][1].attrs.content, /Duration:/);

  for (const [format, element, ext] of [['mp4', 'video', '.mp4'], ['small', 'video', '.mp4'], ['mp3', 'audio', '.mp3'], ['m4a', 'audio', '.m4a']] as const) {
    const h = harness(mediaMessage(), input);
    await h.run('convert', format);
    const item = h.sent[0].find((part: any) => part?.type === element);
    assert.ok(item, `${format} should be sent as ${element}`);
    assert.ok(item.attrs.src.startsWith('data:'), `${format} should carry a real output buffer`);
    assert.match(item.attrs.src, new RegExp(`data:${element === 'audio' ? 'audio/' : 'video/'}[^;]+;base64,`));
    if (element === 'video') {
      const dimensions = await inspectBuffer(t, Buffer.from(item.attrs.src.split(',')[1], 'base64'));
      assert.equal(dimensions.width % 2, 0, `${format} width should be even for yuv420p`);
      assert.equal(dimensions.height % 2, 0, `${format} height should be even for yuv420p`);
    }
  }
  const clipped = harness(mediaMessage(), input);
  await clipped.run('clip', 0.25, 0.5);
  const clip = clipped.sent[0].find((part: any) => part?.type === 'video');
  assert.ok(clip && clip.attrs.src.startsWith('data:video/mp4;base64,'));
  const clipDimensions = await inspectBuffer(t, Buffer.from(clip.attrs.src.split(',')[1], 'base64'));
  assert.equal(clipDimensions.width % 2, 0);
  assert.equal(clipDimensions.height % 2, 0);
});

test('rejects an actual forum-topic media command before file access', async () => {
  const raw = mediaMessage();
  raw.message_thread_id = 42;
  raw.is_topic_message = true;
  const h = harness(raw, Buffer.from('unused'));
  await h.run('mediainfo');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
});

test('incompatible media and invalid conversion requests fail with clear guidance and no subprocess result', async t => {
  const input = await fixture(t);
  const audio = harness(mediaMessage('audio'), input);
  await audio.run('convert', 'mp4');
  assert.match(audio.sent[0].find((part: any) => part.type === 'text').attrs.content, /视频/);
  const bad = harness(mediaMessage(), input);
  await bad.run('convert', 'wav');
  assert.match(bad.sent[0].find((part: any) => part.type === 'text').attrs.content, /用法|格式/);
  const invalid = harness(mediaMessage(), input);
  await invalid.run('clip', -1, 0);
  assert.match(invalid.sent[0].find((part: any) => part.type === 'text').attrs.content, /秒数/);
});

test('rejects messages not owned by the invoking caller before Telegram file access', async () => {
  const raw = mediaMessage();
  const h = harness(raw, Buffer.from('unused'));
  h.session.event.user.id = '8';
  await h.run('mediainfo');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.sent, []);
});

test('reports local Bot API file mode as unsupported without treating its path as a network URL', async () => {
  const h = harness(mediaMessage(), Buffer.from('unused'), { local: true });
  await h.run('mediainfo');
  assert.deepEqual(h.calls, []);
  assert.match(h.sent[0][1].attrs.content, /本地文件模式暂不支持/);
});

test('requires audio for audio extraction and reports malformed inputs without leaking tool output', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcode-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const videoPath = path.join(dir, 'silent.mp4');
  const generated = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', videoPath]);
  if (generated.status !== 0) return t.skip('FFmpeg fixture unavailable');
  const h = harness(mediaMessage(), await readFile(videoPath));
  await h.run('convert', 'mp3');
  assert.match(h.sent[0].find((part: any) => part.type === 'text').attrs.content, /音轨|音频/);
  const malformed = harness(mediaMessage(), Buffer.from('not media'));
  await malformed.run('mediainfo');
  const errorText = malformed.sent[0].find((part: any) => part.type === 'text').attrs.content;
  assert.match(errorText, /无法|失败/);
  assert.doesNotMatch(errorText, /safe\/file|stderr|Error:/);
});

test('rejects a size-limited output whose probed duration shows truncation', { skip: !available(FFMPEG) || !available(FFPROBE) }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcode-truncate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = await fixture(t);
  const source = path.join(dir, 'source.mkv');
  const partial = path.join(dir, 'partial.mp4');
  await writeFile(source, input);
  const generated = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-t', '0.35', '-vf', "scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', partial]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const executable = path.join(dir, 'partial-ffmpeg');
  await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').copyFileSync(${JSON.stringify(partial)}, process.argv.at(-1));\n`, { mode: 0o755 });
  const h = harness(mediaMessage(), input, { ffmpegPath: executable });
  await h.run('convert', 'mp4');
  const text = h.sent[0].find((part: any) => part.type === 'text').attrs.content;
  assert.match(text, /未完整/);
  assert.equal(h.sent[0].some((part: any) => part.type === 'video'), false);
});

test('cancelmedia cancels only the caller task, waits for process exit, and removes task temp files', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'transcode-cancel-'));
  const executable = path.join(dir, 'slow-ffmpeg');
  await writeFile(executable, '#!/usr/bin/env node\nprocess.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000);\n', { mode: 0o755 });
  const h = harness(mediaMessage(), await fixture(t), { ffmpegPath: executable });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = new Set((await readdir(os.tmpdir())).filter(name => name.startsWith('koishi-transcode-')));
  const work = h.run('convert', 'mp4');
  await new Promise(resolve => setTimeout(resolve, 400));
  const other = { ...h.session, event: { user: { id: '8', isBot: false }, _data: { message: { ...mediaMessage(), from: { id: 8 } } } } };
  await h.actions.get('cancelmedia')!({ session: other } as any);
  assert.match(h.sent[0][0].attrs.content, /没有正在运行/);
  await h.run('cancelmedia');
  await work;
  assert.ok(h.sent.some((parts: any) => JSON.stringify(parts).includes('已停止')));
  assert.deepEqual((await readdir(os.tmpdir())).filter(name => name.startsWith('koishi-transcode-') && !before.has(name)), []);
});

test('cancelmedia aborts credential-bound Telegram getFile and download requests', async () => {
  const h = harness(mediaMessage(), Buffer.from('unused'), { downloadDelay: true });
  const work = h.run('mediainfo');
  await new Promise(resolve => setImmediate(resolve));
  await h.run('cancelmedia');
  await work;
  assert.deepEqual(h.calls, ['getFile:media-1', 'download:/safe/file.bin']);
  assert.ok(h.sent.some((parts: any) => JSON.stringify(parts).includes('已停止')));
});

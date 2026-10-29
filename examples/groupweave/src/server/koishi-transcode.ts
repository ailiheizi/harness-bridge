import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Context, Session } from 'koishi';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');

const INPUT_LIMIT = 10 * 1024 * 1024;
const OUTPUT_LIMIT = 25 * 1024 * 1024;
const DEADLINE_MS = 60_000;
const MAX_GLOBAL = 2;
type Attachment = { file_id?: string; file_size?: number; file_name?: string; mime_type?: string; duration?: number; type: 'video' | 'audio' | 'document' };
type Raw = Record<string, any> & { is_topic_message?: boolean };
type Probe = { format?: { duration?: string; format_name?: string; size?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; sample_rate?: string; channels?: number }> };
type Options = { authorize(session: Session): boolean | Promise<boolean>; ffmpegPath?: string; ffprobePath?: string };
type TelegramHttp = {
  local?: boolean;
  http: { post(url: string, data: unknown, config: { signal: AbortSignal; timeout: number }): Promise<any> };
  file: { <T>(url: string, config: { method: 'GET'; responseType: 'arraybuffer'; signal: AbortSignal; timeout: number }): Promise<{ data: T }> };
};
type Task = { controller: AbortController; done: Promise<void>; finish(): void; cleanupFailed: boolean };

function getAttachment(message?: Raw): Attachment | undefined {
  if (!message) return;
  for (const key of ['video', 'audio']) if (message[key]?.file_id) return { ...message[key], type: key };
  if (message.document?.file_id) return { ...message.document, type: 'document' };
}

function source(session: Session): { raw: Raw; file?: Attachment } | undefined {
  if (session.platform !== 'telegram' || session.type !== 'interaction/command') return;
  const raw = (session.event as any)._data?.message as Raw | undefined;
  const user = session.event.user;
  if (!raw || raw.sender_chat || !raw.chat || !raw.message_id || !raw.from || raw.from.is_bot || user?.isBot || String(raw.from.id) !== String(user?.id)) return;
  if (raw.chat.type === 'private') {
    if (!Number.isSafeInteger(raw.chat.id) || raw.chat.id <= 0 || String(raw.chat.id) !== String(raw.from.id)
      || String(raw.chat.id) !== (session.channelId ?? session.guildId)) return;
  } else if ((raw.chat.type !== 'group' && raw.chat.type !== 'supergroup') || session.guildId !== String(raw.chat.id)
    || session.channelId !== session.guildId || raw.is_topic_message === true) return;
  const reply = raw.reply_to_message;
  if (reply && String(reply.chat?.id) !== String(raw.chat.id)) return;
  return { raw, file: getAttachment(raw) ?? getAttachment(reply) };
}

function typeOf(file: Attachment): 'video' | 'audio' | 'unknown' {
  if (file.type === 'video') return 'video';
  if (file.type === 'audio') return 'audio';
  const name = file.file_name || '';
  if (/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(name) || /^video\//i.test(file.mime_type || '')) return 'video';
  if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(name) || /^audio\//i.test(file.mime_type || '')) return 'audio';
  return 'unknown';
}

async function download(session: Session, file: Attachment, signal: AbortSignal, timeout: number) {
  if (!file.file_id || (file.file_size !== undefined && file.file_size > INPUT_LIMIT)) throw new Error('input-limit');
  const bot = (session as any).bot as TelegramHttp;
  if (bot.local) throw new Error('local-files-unsupported');
  try {
    const response = await bot.http.post('/getFile', { file_id: file.file_id }, { signal, timeout });
    if (!response?.ok || !response.result) throw new Error('download-failed');
    const info = response.result as { file_path?: string; file_size?: number };
    if (!info.file_path || (info.file_size !== undefined && info.file_size > INPUT_LIMIT)) throw new Error('input-limit');
    const result = await bot.file<ArrayBuffer>(`/${info.file_path}`, { method: 'GET', responseType: 'arraybuffer', signal, timeout });
    const bytes = Buffer.from(result.data);
    if (bytes.length > INPUT_LIMIT) throw new Error('input-limit');
    return bytes;
  } catch (error) {
    if (signal.aborted) throw abortError(signal);
    throw error;
  }
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error('cancelled');
}

function run(command: string, args: string[], signal: AbortSignal, maxBuffer = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outSize = 0;
    let errSize = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stopAndEscalate = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const timer = setTimeout(() => { timedOut = true; stopAndEscalate(); }, DEADLINE_MS);
    const abort = () => stopAndEscalate();
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (part: Buffer) => {
      outSize += part.length;
      if (outSize > maxBuffer) { child.kill('SIGTERM'); return; }
      stdout.push(Buffer.from(part));
    });
    child.stderr.on('data', (part: Buffer) => {
      if (errSize < 64 * 1024) { const chunk = Buffer.from(part); stderr.push(chunk.subarray(0, 64 * 1024 - errSize)); errSize += chunk.length; }
    });
    child.once('error', err => { if (!settled) { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); reject(err); } });
    child.once('close', (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
      if (timedOut) return reject(new Error('timeout'));
      if (outSize > maxBuffer) return reject(new Error('output-limit'));
      if (code !== 0) return reject(new Error(sig ? 'failed' : 'failed'));
      resolve(Buffer.concat(stdout));
    });
  });
}

function extension(file: Attachment, kind: 'video' | 'audio') {
  const name = file.file_name || '';
  const match = name.match(/\.[a-z0-9]{1,8}$/i);
  if (match) return match[0].toLowerCase();
  return kind === 'video' ? '.mp4' : '.audio';
}

function formatProbe(probe: Probe) {
  const streams = probe.streams ?? [];
  const video = streams.find(stream => stream.codec_type === 'video');
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  return [
    `Duration: ${Number.isFinite(duration) ? `${duration.toFixed(2)} s` : 'unknown'}`,
    `Container: ${probe.format?.format_name || 'unknown'}`,
    video ? `Video: ${video.codec_name || 'unknown'}${video.width && video.height ? ` ${video.width}x${video.height}` : ''}` : 'Video: none',
    audio ? `Audio: ${audio.codec_name || 'unknown'}${audio.channels ? ` ${audio.channels} ch` : ''}${audio.sample_rate ? ` ${audio.sample_rate} Hz` : ''}` : 'Audio: none',
    `Size: ${probe.format?.size || 'unknown'} bytes`,
  ].join('\n');
}

async function probePath(ffprobe: string, filePath: string, signal: AbortSignal) {
  const json = await run(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath], signal);
  const result = JSON.parse(json.toString('utf8')) as Probe;
  const duration = Number(result.format?.duration);
  if (!result.streams?.length || !Number.isFinite(duration) || duration <= 0) throw new Error('invalid');
  return { result, duration };
}

async function verifyOutput(ffprobe: string, filePath: string, expectedDuration: number, signal: AbortSignal) {
  const { result, duration } = await probePath(ffprobe, filePath, signal);
  const tolerance = Math.max(0.04, Math.min(0.15, expectedDuration * 0.03));
  if (duration + tolerance < expectedDuration) throw new Error('incomplete');
  return result;
}

function quote(messageId: number) { return h.quote(String(messageId)); }

/** Register bounded Telegram media conversion commands backed by installed FFmpeg tools. */
export function installTranscodeCommands(ctx: Context, options: Options): void {
  const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const ffprobe = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const active = new Map<string, Task>();
  const callerKey = (session: Session) => `${session.platform}:${session.guildId || session.channelId}:${session.userId || session.event.user?.id}`;
  const send = async (session: Session, text: string, messageId?: number) => {
    await session.send(messageId ? [quote(messageId), h.text(text)] : [h.text(text)]);
  };
  const fail = (error: unknown) => {
    if (error instanceof Error && error.message === 'input-limit') return '输入文件超过 10 MiB 限制。';
    if (error instanceof Error && error.message === 'local-files-unsupported') return '当前 Telegram 本地文件模式暂不支持媒体下载，请切换为远程文件模式。';
    if (error instanceof Error && error.message === 'duration-limit') return '媒体时长超过 60 秒限制。';
    if (error instanceof Error && error.message === 'timeout') return '媒体处理超过 60 秒，已停止。';
    if (error instanceof Error && error.message === 'cancelled') return '媒体处理已取消。';
    if (error instanceof Error && (error.message === 'output-limit' || error.message === 'incomplete')) return '输出超过 25 MiB，或媒体转换未完整完成；请换更短或更小的文件重试。';
    return '媒体无法读取或处理失败，请确认文件有效后重试。';
  };

  const execute = async (session: Session, operation: (controller: AbortController, dir: string, file: Attachment, mediaType: string, raw: Raw) => Promise<void>) => {
    const src = source(session);
    if (!src) return;
    if (!await options.authorize(session)) return;
    const key = callerKey(session);
    if (active.has(key)) return send(session, '你已有一个媒体任务在运行，请先等待或使用 /cancelmedia。', src.raw.message_id);
    if (active.size >= MAX_GLOBAL) return send(session, '当前媒体任务较多，请稍后重试。', src.raw.message_id);
    const file = src.file;
    if (!file) return send(session, '请附加视频、音频或媒体文件，或回复同一聊天中的附件后使用命令。', src.raw.message_id);
    const mediaType = typeOf(file);
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const task: Task = { controller, done, finish, cleanupFailed: false };
    active.set(key, task);
    const startedAt = Date.now();
    const deadline = setTimeout(() => controller.abort(new Error('timeout')), DEADLINE_MS);
    let dir: string | undefined;
    try {
      dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-transcode-'));
      const bytes = await download(session, file, controller.signal, Math.max(1, DEADLINE_MS - (Date.now() - startedAt)));
      if (controller.signal.aborted) throw abortError(controller.signal);
      await writeFile(path.join(dir, `input${extension(file, mediaType === 'audio' ? 'audio' : 'video')}`), bytes, { mode: 0o600 });
      await operation(controller, dir, file, mediaType, src.raw);
    } catch (error) {
      if (!(error instanceof Error && error.message === 'cancelled')) await send(session, fail(error), src.raw.message_id).catch(() => {});
    } finally {
      clearTimeout(deadline);
      if (dir) {
        try { await rm(dir, { recursive: true, force: true }); }
        catch { task.cleanupFailed = true; }
      }
      active.delete(key);
      if (task.cleanupFailed && !(controller.signal.aborted && controller.signal.reason?.message === 'cancelled')) {
        await send(session, '临时文件清理失败，请联系管理员。', src.raw.message_id).catch(() => {});
      }
      finish();
    }
  };

  const probe = async (controller: AbortController, dir: string, file: Attachment) => {
    const input = path.join(dir, `input${extension(file, typeOf(file) === 'audio' ? 'audio' : 'video')}`);
    const { result, duration } = await probePath(ffprobe, input, controller.signal);
    if (duration > 60) throw new Error('duration-limit');
    return { input, result };
  };

  ctx.command('mediainfo').action(async ({ session }) => {
    if (!session) return;
    await execute(session, async (controller, dir, file, _type, raw) => {
      const { result } = await probe(controller, dir, file);
      if (!await options.authorize(session)) return;
      if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('cancelled');
      await send(session, formatProbe(result), raw.message_id);
    });
  });

  ctx.command('convert <format:string>').action(async ({ session }, format?: string) => {
    if (!session) return;
    const target = format?.toLowerCase();
    if (!['mp4', 'mp3', 'm4a', 'small'].includes(target || '')) return send(session, '用法：/convert mp4|mp3|m4a|small。');
    await execute(session, async (controller, dir, file, mediaType, raw) => {
      const { input, result } = await probe(controller, dir, file);
      const streams = result.streams ?? [];
      const hasVideo = streams.some(stream => stream.codec_type === 'video');
      const hasAudio = streams.some(stream => stream.codec_type === 'audio');
      if ((target === 'mp4' || target === 'small') && (!hasVideo || mediaType === 'audio')) return send(session, '该操作需要带有视频轨的媒体文件。', raw.message_id);
      if ((target === 'mp3' || target === 'm4a') && !hasAudio) return send(session, '该文件没有音频轨，无法提取音频。', raw.message_id);
      const ext = target === 'mp3' ? '.mp3' : target === 'm4a' ? '.m4a' : '.mp4';
      const output = path.join(dir, `output${ext}`);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input];
      if (target === 'mp3') args.push('-vn', '-c:a', 'libmp3lame', '-b:a', '128k');
      else if (target === 'm4a') args.push('-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart');
      else if (target === 'small') args.push('-vf', "scale=w='max(2,trunc(min(480,iw)/2)*2)':h=-2", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k'] : ['-an']));
      else args.push('-vf', "scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)'", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']));
      args.push('-fs', String(OUTPUT_LIMIT), output);
      await run(ffmpeg, args, controller.signal, 64 * 1024);
      const size = (await stat(output)).size;
      if (!size || size > OUTPUT_LIMIT) throw new Error('output-limit');
      await verifyOutput(ffprobe, output, Number(result.format?.duration), controller.signal);
      const bytes = await readFile(output);
      if (!await options.authorize(session)) return;
      if (controller.signal.aborted) throw abortError(controller.signal);
      const src = `data:${ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : 'video/mp4'};base64,${bytes.toString('base64')}`;
      const element = ext === '.mp3' || ext === '.m4a' ? h.audio(src) : h.video(src);
      await session.send([quote(raw.message_id), h.text(`转换完成：${target?.toUpperCase()}（${bytes.length} bytes）`), element]);
    });
  });

  ctx.command('clip <start:number> <duration:number>').action(async ({ session }, start?: number, duration?: number) => {
    if (!session) return;
    if (!Number.isFinite(start) || !Number.isFinite(duration) || (start as number) < 0 || (duration as number) <= 0 || (duration as number) > 60) return send(session, '用法：/clip <开始秒数> <时长秒数>，时长须大于 0 且不超过 60 秒。');
    await execute(session, async (controller, dir, file, mediaType, raw) => {
      const { input, result } = await probe(controller, dir, file);
      if (!result.streams?.some(stream => stream.codec_type === 'video') || mediaType === 'audio') return send(session, '剪辑需要带有视频轨的媒体文件。', raw.message_id);
      const total = Number(result.format?.duration);
      if (Number.isFinite(total) && (start as number) >= total) return send(session, '开始秒数超出媒体时长。', raw.message_id);
      const output = path.join(dir, 'clip.mp4');
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', input, '-t', String(duration), '-map', '0:v:0', '-map', '0:a?', '-vf', "scale=w='max(2,trunc(iw/2)*2)':h='max(2,trunc(ih/2)*2)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-b:a', '96k', '-fs', String(OUTPUT_LIMIT), output], controller.signal, 64 * 1024);
      const size = (await stat(output)).size;
      if (!size || size > OUTPUT_LIMIT) throw new Error('output-limit');
      await verifyOutput(ffprobe, output, Math.min(duration as number, total - (start as number)), controller.signal);
      const bytes = await readFile(output);
      if (!await options.authorize(session)) return;
      if (controller.signal.aborted) throw abortError(controller.signal);
      await session.send([quote(raw.message_id), h.text(`剪辑完成：MP4（${bytes.length} bytes）`), h.video(`data:video/mp4;base64,${bytes.toString('base64')}`)]);
    });
  });

  ctx.command('cancelmedia').action(async ({ session }) => {
    if (!session || !source(session) || !await options.authorize(session)) return;
    const task = active.get(callerKey(session));
    if (!task) return send(session, '没有正在运行的媒体任务。');
    task.controller.abort(new Error('cancelled'));
    await task.done;
    await send(session, task.cleanupFailed ? '媒体任务已停止，但临时文件清理失败，请联系管理员。' : '媒体任务已停止，临时文件已清理。');
  });

  ctx.on('dispose', async () => {
    const tasks = [...active.values()];
    for (const task of tasks) task.controller.abort(new Error('cancelled'));
    await Promise.all(tasks.map(task => task.done));
  });
}

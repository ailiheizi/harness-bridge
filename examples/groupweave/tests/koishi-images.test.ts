import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { installImageCommands } from '../src/server/koishi-images.js';

function message(messageId: number, userId = 7, chatId = -10042, attachment?: any, text?: string) {
  return {
    message_id: messageId,
    date: 1,
    from: { id: userId, is_bot: false },
    chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup' },
    ...(text ? { text } : {}),
    ...(attachment ? { ...attachment } : {}),
  };
}

function photo(fileId: string, fileSize: number, width = 16, height = 12) {
  return { photo: [{ file_id: `${fileId}-small`, file_size: fileSize, width: width / 2, height: height / 2 },
    { file_id: fileId, file_size: fileSize, width, height }] };
}

function document(fileId: string, fileSize: number, name: string, mime: string) {
  return { document: { file_id: fileId, file_size: fileSize, file_name: name, mime_type: mime } };
}

function harness(opts: { inputs?: Map<string, Buffer>; authorize?: (stage: number, session: any) => boolean; local?: boolean; } = {}) {
  const actions = new Map<string, (argv: any, ...args: any[]) => Promise<unknown>>();
  const listeners = new Map<string, ((session: any) => Promise<void>)[]>();
  const calls: any[] = [];
  let authorizeCalls = 0;
  const ctx: any = {
    command(name: string) {
      const key = name.split(' ')[0];
      const command: any = { alias() { return command; }, action(fn: any) { actions.set(key, fn); return command; } };
      return command;
    },
    on(event: string, fn: any) { const queue = listeners.get(event) ?? []; queue.push(fn); listeners.set(event, queue); },
  };
  const makeSession = (raw: any, options: { quote?: any; userId?: number; type?: string } = {}) => {
    const sent: any[] = [];
    const userId = options.userId ?? raw.from.id;
    const bot: any = {
      selfId: 'bot-1',
      local: opts.local ?? false,
      http: { post: async (url: string, payload: any, config: any) => {
        calls.push({ kind: 'getFile', url, payload, config });
        const source = [...(opts.inputs ?? new Map()).entries()].find(([id]) => id === payload.file_id);
        if (!source) throw new Error('missing test input');
        return { ok: true, result: { file_path: `files/${payload.file_id}`, file_size: source[1].length } };
      } },
      file: async (url: string, config: any) => {
        calls.push({ kind: 'download', url, config });
        const id = url.slice('/files/'.length);
        return { data: (opts.inputs ?? new Map()).get(id)! };
      },
    };
    const session = {
      platform: 'telegram', type: options.type ?? 'interaction/command', guildId: String(raw.chat.id), channelId: String(raw.chat.id),
      userId: String(userId), event: { user: { id: String(userId), isBot: false }, _data: { message: raw } },
      bot, send: async (content: any) => { sent.push(content); return ['receipt']; },
      _sent: sent,
    } as any;
    if (options.quote) raw.reply_to_message = options.quote;
    return session;
  };
  installImageCommands(ctx, { authorize: async session => { authorizeCalls++; return opts.authorize?.(authorizeCalls, session) ?? true; } });
  return {
    calls, actions, listeners, makeSession,
    get authorizeCalls() { return authorizeCalls; },
    run(name: string, session: any, ...args: any[]) { return actions.get(name)!({ session }, ...args); },
    async message(session: any) { for (const listener of listeners.get('message') ?? []) await listener(session); },
    async dispose() { for (const listener of listeners.get('dispose') ?? []) await listener({}); },
  };
}

async function sample(format: 'jpeg' | 'png' | 'webp' = 'png') {
  return sharp({ create: { width: 80, height: 40, channels: 4, background: { r: 250, g: 30, b: 20, alpha: 0.6 } } })
    .toFormat(format).toBuffer();
}

test('/image resizes a current photo and sends a real JPEG file', async () => {
  const input = await sample();
  const f = harness({ inputs: new Map([['photo-1', input]]) });
  const session = f.makeSession(message(10, 7, -10042, photo('photo-1', input.length, 80, 40)));
  await f.run('image', session, 'jpg', 32, 82);
  assert.ok(f.calls[0], JSON.stringify(session._sent));
  assert.equal(f.calls[0].url, '/getFile');
  assert.deepEqual(f.calls.map(call => call.kind), ['getFile', 'download']);
  const sent = session._sent[0];
  const file = sent.find((element: any) => element?.type === 'file');
  assert.equal(file.attrs.name, 'image.jpg');
  const bytes = Buffer.from(file.attrs.src.slice(file.attrs.src.indexOf(',') + 1), 'base64');
  const output = await sharp(bytes).metadata();
  assert.equal(output.format, 'jpeg');
  assert.ok(output.width! <= 32 && output.height! <= 32);
  assert.ok(f.authorizeCalls >= 2, 'authorization is checked before download and delivery');
});

test('/image uses a same-chat quoted WebP document and rejects a cross-chat reply', async () => {
  const input = await sample('webp');
  const f = harness({ inputs: new Map([['webp-1', input]]) });
  const quoted = message(5, 99, -10042, document('webp-1', input.length, 'source.webp', 'image/webp'));
  const current = message(11);
  current.message_thread_id = 88;
  current.is_topic_message = false;
  const session = f.makeSession(current, { quote: quoted });
  await f.run('image', session, 'png');
  assert.equal(f.calls.length, 2);
  const file = session._sent[0].find((element: any) => element?.type === 'file');
  assert.equal(file.attrs.name, 'image.png');
  const output = Buffer.from(file.attrs.src.slice(file.attrs.src.indexOf(',') + 1), 'base64');
  assert.equal((await sharp(output).metadata()).format, 'png');

  const cross = f.makeSession(message(12), { quote: message(6, 99, -10099, document('webp-1', input.length, 'x.webp', 'image/webp')) });
  await f.run('image', cross, 'jpg');
  assert.equal(f.calls.length, 2);
});

test('/image rejects a real forum topic while accepting an ordinary threaded reply', async () => {
  const input = await sample('jpeg');
  const f = harness({ inputs: new Map([['jpeg-1', input]]) });
  const quoted = message(5, 99, -10042, document('jpeg-1', input.length, 'source.jpg', 'image/jpeg'));
  const topic = message(12);
  topic.message_thread_id = 88;
  topic.is_topic_message = true;
  const session = f.makeSession(topic, { quote: quoted });
  await f.run('image', session, 'webp');
  assert.equal(f.calls.length, 0);
  assert.equal(session._sent.length, 0);
});

test('/image rejects invalid bounds, unsupported documents, and oversized inputs before download', async () => {
  const input = await sample();
  const f = harness({ inputs: new Map([['png-1', input]]) });
  await f.run('image', f.makeSession(message(20, 7, -10042, document('png-1', input.length, 'image.svg', 'image/svg+xml'))), 'jpg');
  await f.run('image', f.makeSession(message(21, 7, -10042, photo('png-1', input.length))), 'jpeg', 12);
  await f.run('image', f.makeSession(message(22, 7, -10042, photo('png-1', 5 * 1024 * 1024 + 1))), 'webp');
  assert.equal(f.calls.length, 0);
});

test('/image denies before download and rechecks authorization before file delivery', async () => {
  const input = await sample();
  const denied = harness({ inputs: new Map([['photo', input]]), authorize: () => false });
  const deniedSession = denied.makeSession(message(23, 7, -10042, photo('photo', input.length)));
  await denied.run('image', deniedSession, 'webp');
  assert.equal(denied.calls.length, 0);
  assert.equal(deniedSession._sent.length, 0);

  const revoked = harness({ inputs: new Map([['photo', input]]), authorize: stage => stage === 1 });
  const revokedSession = revoked.makeSession(message(24, 7, -10042, photo('photo', input.length)));
  await revoked.run('image', revokedSession, 'webp');
  assert.deepEqual(revoked.calls.map(call => call.kind), ['getFile', 'download']);
  assert.equal(revokedSession._sent.length, 0);
});

test('local Telegram Bot API mode reports the unsupported download path clearly', async () => {
  const input = await sample();
  const f = harness({ inputs: new Map([['photo', input]]), local: true });
  const session = f.makeSession(message(25, 7, -10042, photo('photo', input.length)));
  await f.run('image', session, 'png');
  assert.equal(f.calls.length, 0);
  assert.match(session._sent[0][1].attrs.content, /本地文件模式暂不支持图片下载/);
});

test('/imgpdf collects only the caller’s same-chat images and sends a valid two-page PDF', async () => {
  const first = await sample('jpeg'); const second = await sample('webp');
  const f = harness({ inputs: new Map([['first', first], ['second', second]]) });
  const start = f.makeSession(message(30, 7));
  await f.run('imgpdf', start, 'start');
  const stranger = f.makeSession(message(31, 8, -10042, photo('second', second.length)), { type: 'message' });
  await f.message(stranger);
  const own = f.makeSession(message(32, 7, -10042, document('second', second.length, 'second.webp', 'image/webp')), { type: 'message' });
  await f.message(own);
  const done = f.makeSession(message(33, 7, -10042, undefined, '/imgpdf done'));
  await f.run('imgpdf', done, 'done');
  const file = done._sent.flat().find((element: any) => element?.type === 'file');
  assert.equal(file.attrs.name, 'images.pdf');
  const bytes = Buffer.from(file.attrs.src.slice(file.attrs.src.indexOf(',') + 1), 'base64');
  const pdf = await PDFDocument.load(bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(f.calls.filter(call => call.kind === 'getFile').map(call => call.payload.file_id), ['second']);
});

test('/imgpdf can include a quoted image at start and preserves message order', async () => {
  const first = await sample('jpeg'); const second = await sample('png');
  const f = harness({ inputs: new Map([['first', first], ['second', second]]) });
  const start = f.makeSession(message(40, 7), { quote: message(39, 9, -10042, photo('first', first.length)) });
  await f.run('imgpdf', start, undefined);
  await f.message(f.makeSession(message(41, 7, -10042, photo('second', second.length)), { type: 'message' }));
  const done = f.makeSession(message(42, 7));
  await f.run('imgpdf', done, 'done');
  const file = done._sent.flat().find((element: any) => element?.type === 'file');
  const pdf = await PDFDocument.load(Buffer.from(file.attrs.src.slice(file.attrs.src.indexOf(',') + 1), 'base64'));
  assert.equal(pdf.getPageCount(), 2);
});

test('/imgpdf done includes a synchronous photo capture started immediately beforehand', async () => {
  const input = await sample('jpeg');
  const f = harness({ inputs: new Map([['last-second', input]]) });
  await f.run('imgpdf', f.makeSession(message(45, 7)), 'start');
  const capture = f.message(f.makeSession(message(46, 7, -10042, photo('last-second', input.length)), { type: 'message' }));
  const doneSession = f.makeSession(message(47, 7));
  const done = f.run('imgpdf', doneSession, 'done');
  await Promise.all([capture, done]);
  const file = doneSession._sent.flat().find((element: any) => element?.type === 'file');
  const pdf = await PDFDocument.load(Buffer.from(file.attrs.src.slice(file.attrs.src.indexOf(',') + 1), 'base64'));
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(f.calls.filter(call => call.kind === 'getFile').map(call => call.payload.file_id), ['last-second']);
});

test('/imgpdf cancel clears a pending collection and dispose releases collection timers', async () => {
  const f = harness();
  await f.run('imgpdf', f.makeSession(message(50, 7)), 'start');
  const cancel = f.makeSession(message(51, 7));
  await f.run('imgpdf', cancel, 'cancel');
  await f.message(f.makeSession(message(52, 7, -10042, photo('after-cancel', 100)), { type: 'message' }));
  assert.equal(f.calls.length, 0);
  await f.run('imgpdf', f.makeSession(message(53, 7)), 'start');
  await f.dispose();
});

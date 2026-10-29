import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Context, Session } from 'koishi';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { installMediaCommands } from '../src/server/koishi-media.js';

const require = createRequire(import.meta.url);
const { h } = require('@koishijs/core') as typeof import('koishi');
const { Bot } = require('@koishijs/core') as typeof import('koishi');

function harness(rawMessage: any, opts: { content?: string; authorize?: (stage: string) => boolean; emptyReceipt?: boolean } = {}) {
  const commands = new Map<string, (session: Session, input?: string) => Promise<unknown>>();
  const acquired: string[] = [];
  const sent: any[] = [];
  let authCall = 0;
  const session: any = {
    platform: 'telegram', type: 'interaction/command', guildId: '-10042', channelId: '-10042',
    event: { user: { id: '7', isBot: false }, _data: { message: rawMessage } },
    bot: { internal: { getFile: async ({ file_id }: any) => { acquired.push(`getFile:${file_id}`); return { file_path: 'safe/path.txt', file_size: Buffer.byteLength(opts.content ?? '') }; } },
      $getFile: async (path: string) => { acquired.push(`download:${path}`); return { data: Buffer.from(opts.content ?? '') }; } },
    send: async (element: any) => { sent.push(element); return opts.emptyReceipt ? [] : ['receipt']; },
  };
  const ctx: any = { command(name: string) { const action = (fn: any) => { commands.set(name.split(' ')[0], fn); return { action: fn }; }; return { action }; } };
  installMediaCommands(ctx as Context, { authorize: async () => { authCall++; return opts.authorize?.(String(authCall)) ?? true; } });
  const run = (name: string, input?: string) => commands.get(name)!({ session } as any, input);
  return { run, acquired, sent, session };
}

test('fileinfo identifies a replied image without downloading it', async () => {
  const raw = { message_id: 8, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, message_thread_id: 42, is_topic_message: false,
    reply_to_message: { message_id: 2, chat: { id: -10042 }, photo: [{ file_id: 'photo-1', file_size: 123 }] } };
  const h = harness(raw);
  await h.run('fileinfo');
  assert.equal(h.acquired.length, 0);
  assert.match(h.sent[0][1].attrs.content, /类型：image/);
  assert.match(h.sent[0][1].attrs.content, /photo.jpg/);
});

test('fileinfo rejects an actual forum-topic command', async () => {
  const h = harness({ message_id: 8, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, message_thread_id: 42, is_topic_message: true,
    reply_to_message: { message_id: 2, chat: { id: -10042 }, document: { file_id: 'doc-1', file_name: 'notes.md' } } });
  await h.run('fileinfo');
  assert.deepEqual(h.acquired, []);
  assert.deepEqual(h.sent, []);
});

test('readfile downloads only an authorized Telegram attachment and sends its literal text', async () => {
  const h = harness({ message_id: 9, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'doc-1', file_name: 'notes.md', file_size: 12 } }, { content: '# hello\nworld' });
  await h.run('readfile');
  assert.deepEqual(h.acquired, ['getFile:doc-1', 'download:safe/path.txt']);
  assert.equal(h.sent[0][0].type, 'quote');
  assert.equal(h.sent[0][1].type, 'text');
  assert.equal(h.sent[0][1].attrs.content, '# hello\nworld');
});

test('readfile checks authorization before attachment acquisition and before delivery', async () => {
  const denied = harness({ message_id: 10, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'doc-1', file_name: 'notes.txt' } }, { authorize: () => false });
  await denied.run('readfile');
  assert.deepEqual(denied.acquired, []);
  assert.deepEqual(denied.sent, []);
});

test('savefile emits a native file element carrying the exact text bytes', async () => {
  const f = harness({ message_id: 11, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, text: '/savefile' });
  await f.run('savefile', 'hello 世界');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].type, 'quote');
  assert.equal(f.sent[0][1].type, 'file');
  assert.equal(f.sent[0][1].attrs.name, 'saved.txt');
  assert.equal(Buffer.from(f.sent[0][1].attrs.src.split(',')[1], 'base64').toString(), 'hello 世界');
});

test('an attachment or reply from a different chat is rejected', async () => {
  const f = harness({ message_id: 12, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, reply_to_message: { chat: { id: -10099 }, document: { file_id: 'doc-1', file_name: 'x.txt' } } });
  await f.run('readfile');
  assert.deepEqual(f.acquired, []);
});

test('readfile rejects oversized and MIME-only files before download', async () => {
  const oversized = harness({ message_id: 13, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'large', file_name: 'large.txt', file_size: 65537 } });
  await oversized.run('readfile');
  assert.deepEqual(oversized.acquired, []);
  const mimeOnly = harness({ message_id: 14, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'mime', file_name: 'notes.data', mime_type: 'text/plain' } });
  await mimeOnly.run('readfile');
  assert.deepEqual(mimeOnly.acquired, []);
});

test('readfile rechecks authorization per chunk and stops when a send has no receipt', async () => {
  const deniedAfterOne = harness({ message_id: 15, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'long', file_name: 'long.txt' } },
    { content: 'x'.repeat(6500), authorize: stage => stage !== '3' });
  await deniedAfterOne.run('readfile');
  assert.equal(deniedAfterOne.sent.length, 1);
  const unknown = harness({ message_id: 16, chat: { id: -10042, type: 'supergroup' }, from: { id: 7 }, document: { file_id: 'long', file_name: 'long.txt' } },
    { content: 'x'.repeat(6500), emptyReceipt: true });
  await unknown.run('readfile');
  assert.equal(unknown.sent.length, 1);
});

test('real Koishi command session sends savefile as native file content with a reply quote', async t => {
  class NativeBot extends Bot<Context> {
    sent: any[] = [];
    private readonly bots: Context['bots'];
    constructor(ctx: Context) { super(ctx, {}, 'telegram'); this.bots = ctx.bots; this.platform = 'telegram'; }
    override async start() {}
    override async stop() {}
    override async dispose() { const i = this.bots.findIndex(bot => bot.sn === this.sn); if (i >= 0) this.bots.splice(i, 1); }
    override async sendMessage(_channelId: string, content: any) { this.sent.push(content); return ['receipt']; }
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-media-'));
  const configPath = path.join(dir, 'koishi.yml');
  await writeFile(configPath, 'plugins: {}\n');
  const runtime = await createKoishiRuntime({ configPath, setup(ctx) {
    ctx.plugin(NativeBot as any);
    ctx.plugin((inner: Context) => installMediaCommands(inner, { authorize: () => true }));
  } });
  await runtime.start();
  const bot = runtime.app.bots.find(value => value.adapterName === 'telegram') as NativeBot;
  t.after(async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); });
  const raw = { update_id: 1, message: { message_id: 44, from: { id: 7, is_bot: false }, chat: { id: -10042, type: 'supergroup' }, text: '/savefile hello' } };
  const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: '7', name: 'Member', isBot: false },
    guild: { id: '-10042', name: 'Test' }, channel: { id: '-10042', type: 0 }, message: { id: '44', content: '/savefile hello', elements: [] }, _data: raw } as any);
  session.setInternal('telegram', raw);
  await session.execute('savefile hello', true);
  const sent = bot.sent[0];
  assert.ok(Array.isArray(sent));
  const file = sent.find((element: any) => element.type === 'file');
  assert.ok(file);
  assert.equal(file.attrs.name, 'saved.txt');
  assert.equal(Buffer.from(file.attrs.src.split(',')[1], 'base64').toString(), 'hello');
  assert.ok(sent.some((element: any) => element.type === 'quote'));
});

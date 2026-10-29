import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { App } from '@koishijs/core';
import HTTP from '@cordisjs/plugin-http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TelegramBot, handleUpdate } = require('@satorijs/adapter-telegram');
const { HttpPolling } = require('@satorijs/adapter-telegram');
const { Argv } = require('@koishijs/core');

async function setup() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url || '');
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('attachment body');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const app = new App();
  app.plugin(HTTP);
  await app.start();
  const bot = new TelegramBot(app, {
    token: '12345:fixture', protocol: 'server',
    endpoint: `http://127.0.0.1:${address.port}`, files: { endpoint: `http://127.0.0.1:${address.port}` },
  } as any);
  bot.internal.getFile = async () => ({ file_path: '/documents/file_0.txt', file_size: 15 });
  const sessions: any[] = [];
  app.on('interaction/command', session => { sessions.push(session); });
  return {
    app, bot, requests, sessions,
    close: async () => {
      // The focused harness does not run adapter lifecycle; avoid its
      // registered disposal hook after Satori tears down the bot collection.
      bot.dispose = () => {};
      await app.stop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

const attachmentUpdate = (caption = '/readfile') => ({
  update_id: 1,
  message: {
    message_id: 42,
    date: 1,
    chat: { id: 7, type: 'private' },
    from: { id: 7, is_bot: false, first_name: 'Tester' },
    caption,
    caption_entities: [{ type: 'bot_command', offset: 0, length: caption.length }],
    document: { file_id: 'file-id-fixture', file_unique_id: 'unique-fixture', file_name: 'file_0.txt', file_size: 15, mime_type: 'text/plain' },
  },
});

test('upstream Telegram handler downloads an endpoint-bound file and parses caption command arguments without the attachment', async () => {
  const state = await setup();
  try {
    await handleUpdate(attachmentUpdate('/image jpg') as any, state.bot);
    assert.deepEqual(state.requests, ['/file/bot12345:fixture/documents/file_0.txt']);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].type, 'interaction/command');
    const parsed = Argv.parse(state.sessions[0].content);
    assert.deepEqual(parsed.tokens.map((token: { content: string }) => token.content), ['image', 'jpg']);
    assert.ok(!state.sessions[0].event.message.elements.some((element: { type: string }) => element.type === 'file'));
    assert.equal(state.sessions[0].event._data.message.document.file_name, 'file_0.txt');
  } finally { await state.close(); }
});

test('upstream Telegram handler preserves a command caption and raw attachment when file retrieval fails', async () => {
  const state = await setup();
  try {
    state.bot.internal.getFile = async () => ({ file_path: '/documents/file_0.txt' });
    state.bot.file.file = async () => { throw new Error('fixture download failure'); };
    await handleUpdate(attachmentUpdate() as any, state.bot);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].type, 'interaction/command');
    assert.match(state.sessions[0].content, /^readfile /);
    assert.equal(state.sessions[0].event._data.message.document.file_id, 'file-id-fixture');
  } finally { await state.close(); }
});

test('a quoted command-caption attachment remains in the decoded quote for media commands', async () => {
  const state = await setup();
  try {
    const update = {
      update_id: 3,
      message: {
        message_id: 43,
        date: 1,
        chat: { id: 7, type: 'private' },
        from: { id: 7, is_bot: false, first_name: 'Tester' },
        text: '/v2g',
        entities: [{ type: 'bot_command', offset: 0, length: 4 }],
        reply_to_message: {
          message_id: 42,
          date: 1,
          chat: { id: 7, type: 'private' },
          from: { id: 7, is_bot: false, first_name: 'Tester' },
          caption: '/image jpg',
          caption_entities: [{ type: 'bot_command', offset: 0, length: 10 }],
          video: { file_id: 'quoted-video-fixture', file_unique_id: 'quoted-video-unique', file_name: 'clip.mp4', file_size: 15, mime_type: 'video/mp4' },
        },
      },
    };
    await handleUpdate(update as any, state.bot);
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].type, 'interaction/command');
    assert.ok(state.sessions[0].event.message.quote.elements.some((element: { type: string }) => element.type === 'video'));
  } finally { await state.close(); }
});

test('upstream poller continues after an update handler rejects', async () => {
  const app = new App();
  const adapter = new HttpPolling(app);
  let updateRequests = 0;
  const warnings: string[] = [];
  const bot: any = {
    config: { retryTimes: 0, retryInterval: 1, pollingTimeout: 1 },
    internal: {
      getWebhookInfo: async () => ({}),
      getUpdates: async () => {
        updateRequests++;
        if (updateRequests === 1) return [];
        if (updateRequests === 2) return [{ update_id: 2, message: { message_id: 2 } }];
        bot.isActive = false;
        return [];
      },
    },
    http: { isError: () => false },
    logger: { debug: () => {}, warn: (message: string) => warnings.push(message) },
    selfId: '12345',
    isActive: true,
    status: 0,
    online() { this.isActive = true; },
    async initialize(callback: (value: any) => Promise<void>) { void callback(this); },
  };
  try {
    await adapter.connect(bot);
    for (let i = 0; i < 50 && updateRequests < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    await adapter.disconnect();
    assert.ok(updateRequests >= 3, `expected another poll after handler failure; got ${updateRequests}`);
    assert.ok(warnings.includes('failed to handle Telegram update'));
  } finally { await adapter.disconnect(); }
});

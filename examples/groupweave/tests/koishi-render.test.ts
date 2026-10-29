import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import test from 'node:test';
import type { Context, Session } from 'koishi';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { installMarkdownIntegration } from '../src/server/koishi-render.js';

const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromiumPath = process.env.CHROMIUM_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(localChrome) ? localChrome : undefined);
const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');
const Puppeteer = require('koishi-plugin-puppeteer').default;

class RenderTestBot extends Bot<Context> {
  private readonly bots: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'render-test'); this.platform = 'telegram'; this.bots = ctx.bots; }
  override async start() {}
  override async stop() {}
  override async dispose() { const i = this.bots.findIndex(bot => bot.sn === this.sn); if (i >= 0) this.bots.splice(i, 1); }
}

test('disabled rendering command is registered but reports not configured', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-render-disabled-'));
  const config = path.join(dir, 'koishi.yml');
  await writeFile(config, 'plugins: {}\n');
  const runtime = await createKoishiRuntime({ configPath: config, setup(ctx) {
    ctx.plugin(RenderTestBot);
    installMarkdownIntegration(ctx, { enabled: false, authorize: () => true });
  } });
  try {
    await runtime.start();
    const bot = runtime.app.bots.find(item => item.adapterName === 'render-test')!;
    const raw = { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false }, text: '/mdimg hello' };
    const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: '7', isBot: false },
      channel: { id: '7', type: 1 }, message: { id: '1', content: '/mdimg hello', elements: [] }, _data: { message: raw } } as any);
    session.setInternal('telegram', { message: raw });
    for (const command of ['mdimg hello', 'markdownToImage hello', 'Markdown转图 hello']) {
      const output = await session.execute(command, true);
      assert.match(output.map(item => item.attrs.content || '').join(''), /Markdown 转图片功能尚未配置/);
    }
    await bot.dispose();
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('denied rendering never calls the service', async () => {
  let serviceCalls = 0;
  const { ctx, commands } = fakeContext({ convertToImage: async () => { serviceCalls++; return Buffer.from('png'); } });
  installMarkdownIntegration(ctx, { enabled: true, authorize: () => false });
  const command = commands.get('mdimg');
  assert.ok(command);
  const gate = command.checks[0];
  const session = {
    platform: 'telegram', type: 'interaction/command', channelId: '7', guildId: '7',
    event: { user: { id: '7', isBot: false }, _data: { message: { chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false } } } },
  } as unknown as Session;
  const result = await gate({ session });
  assert.equal(result, '');
  assert.equal(serviceCalls, 0);
});

test('rendering is re-authorized after image generation and never sends after revocation', async () => {
  let serviceCalls = 0;
  let authCalls = 0;
  const sent: unknown[] = [];
  const { ctx, commands } = fakeContext({ convertToImage: async () => { serviceCalls++; return Buffer.from('png'); } });
  installMarkdownIntegration(ctx, { enabled: true, authorize: () => ++authCalls === 1 });
  const session = telegramSession(sent);
  await commands.get('mdimg')!.actions[0]({ session }, 'hello');
  assert.equal(serviceCalls, 1);
  assert.equal(authCalls, 2);
  assert.deepEqual(sent, []);
});

test('rendering rejects oversized Markdown before calling the image service', async () => {
  let serviceCalls = 0;
  const { ctx, commands } = fakeContext({ convertToImage: async () => { serviceCalls++; return Buffer.from('png'); } });
  installMarkdownIntegration(ctx, { enabled: true, authorize: () => true });
  await commands.get('mdimg')!.actions[0]({ session: telegramSession([]) }, 'x'.repeat(8193));
  assert.equal(serviceCalls, 0);
});

test('raw Telegram Markdown wins over Koishi markup for command names and bot mentions', async () => {
  const rendered: string[] = [];
  const { ctx, commands } = fakeContext({ convertToImage: async text => { rendered.push(text); return Buffer.from('png'); } });
  installMarkdownIntegration(ctx, { enabled: true, authorize: () => true });
  const session = telegramSession([]);
  const raw = (session.event as any)._data.message;
  const markdown = '# Heading\n\n**bold**\n\n```js\nconst answer = 42\n```';
  const transformedInput = '<br/><b>Heading</b><br/><code>const answer = 42</code>';

  for (const command of ['mdimg', 'markdownToImage', 'Markdown转图']) {
    raw.text = `/${command}@groupweave_bot ${markdown}`;
    await commands.get('mdimg')!.actions[0]({ session }, transformedInput);
  }

  assert.deepEqual(rendered, [markdown, markdown, markdown]);
});

test('Telegram pre and code entities restore Markdown fences with UTF-16 offsets', async () => {
  const rendered: string[] = [];
  const { ctx, commands } = fakeContext({ convertToImage: async text => { rendered.push(text); return Buffer.from('png'); } });
  installMarkdownIntegration(ctx, { enabled: true, authorize: () => true });
  const session = telegramSession([]);
  const raw = (session.event as any)._data.message;
  const rawText = '/mdimg@groupweave_bot 😀\ngraph LR\n  A --> B\n\ninline x+y';
  const pre = 'graph LR\n  A --> B';
  raw.text = rawText;
  raw.entities = [
    { type: 'pre', offset: rawText.indexOf(pre), length: pre.length, language: 'mermaid' },
    { type: 'code', offset: rawText.indexOf('x+y'), length: 3 },
  ];

  await commands.get('mdimg')!.actions[0]({ session }, '<code>graph LR</code>');

  assert.deepEqual(rendered, ['😀\n```mermaid\ngraph LR\n  A --> B\n```\n\ninline `x+y`']);
});

test('real service renders Chinese, code, KaTeX, and Mermaid to a PNG', {
  skip: !chromiumPath && 'Set CHROMIUM_PATH (or PUPPETEER_EXECUTABLE_PATH) to run browser integration.',
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-render-browser-'));
  const config = path.join(dir, 'koishi.yml');
  await writeFile(config, 'plugins:\n  "@koishijs/plugin-http": {}\n');
  const runtime = await createKoishiRuntime({ configPath: config, setup(ctx) {
    installMarkdownIntegration(ctx, { enabled: true, executablePath: chromiumPath, authorize: () => true });
  } });
  try {
    await runtime.start();
    const service = (runtime.app as Context & { markdownToImage: { convertToImage(markdown: string): Promise<Buffer> } }).markdownToImage;
    const png = await service.convertToImage('# 中文\n\n```ts\nconst answer = 42\n```\n\n$\\frac{1}{2}$\n\n```mermaid\ngraph TD\nA[开始] --> B[完成]\n```');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(png.byteLength > 1000);
    await writeFile(path.resolve('artifacts/m2-markdown-sample.png'), png);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Puppeteer canvas shutdown tolerates a lost target but preserves live-page close errors', {
  skip: !chromiumPath && 'Set CHROMIUM_PATH (or PUPPETEER_EXECUTABLE_PATH) to run browser integration.',
}, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-canvas-stop-'));
  const config = path.join(dir, 'koishi.yml');
  await writeFile(config, 'plugins:\n  "@koishijs/plugin-http": {}\n');
  const runtime = await createKoishiRuntime({ configPath: config, setup(ctx) {
    ctx.plugin(Puppeteer, { executablePath: chromiumPath, headless: true, args: [] });
  } });
  try {
    await runtime.start();
    const canvas = (runtime.app as any).canvas;
    const page = canvas.page;
    const close = page.close.bind(page);
    page.close = async () => { throw new Error('active canvas close failure'); };
    await assert.rejects(canvas.stop(), /active canvas close failure/);
    assert.equal(canvas.page, page);

    page.close = close;
    await (runtime.app as any).puppeteer.browser.close();
    page.isClosed = () => false;
    page.close = async () => { throw new Error('Target.closeTarget: No target with given id found'); };
    (canvas.ctx as any).puppeteer = undefined;
    await assert.doesNotReject(canvas.stop());
    assert.equal(canvas.page, null);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

type FakeCommand = { checks: Array<(argv: { session?: Session }) => unknown>; actions: Array<(...args: any[]) => unknown> };
function fakeContext(service: { convertToImage(markdown: string): Promise<Buffer> }) {
  const commands = new Map<string, FakeCommand>();
  let pluginCalls = 0;
  const ctx = {
    plugin() { pluginCalls++; },
    command(name: string) {
      const key = name.split(' ')[0];
      const cmd = commands.get(key) ?? { checks: [], actions: [] };
      commands.set(key, cmd);
      return {
        alias() { return this; },
        check(fn: FakeCommand['checks'][number]) { cmd.checks.unshift(fn); return this; },
        action(fn: FakeCommand['actions'][number]) { cmd.actions.push(fn); return this; },
      };
    },
    markdownToImage: service,
  } as unknown as Context;
  return { ctx, commands, get pluginCalls() { return pluginCalls; } };
}

function telegramSession(sent: unknown[]): Session {
  return {
    platform: 'telegram', type: 'interaction/command', channelId: '7', guildId: '7',
    event: { user: { id: '7', isBot: false }, _data: { message: { message_id: 1, chat: { id: 7, type: 'private' }, from: { id: 7, is_bot: false } } } },
    send: async (...items: unknown[]) => { sent.push(...items); return ['receipt']; },
  } as unknown as Session;
}

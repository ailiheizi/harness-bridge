import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Context } from 'koishi';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { installRssIntegration } from '../src/server/koishi-rss.js';

const require = createRequire(import.meta.url);
const { h } = require('koishi') as typeof import('koishi');
const { Bot } = require('@koishijs/core') as typeof import('koishi');

class TestBot extends Bot<Context> {
  static sent: Array<{ channelId: string; content: unknown }> = [];
  private readonly bots: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'rss-test'); this.selfId = 'test'; this.bots = ctx.bots; }
  override async start() {}
  override async stop() {}
  override async dispose() {
    const index = this.bots.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.bots.splice(index, 1);
  }
  override async sendMessage(...args: Parameters<typeof Bot.prototype.sendMessage>) {
    TestBot.sent.push({ channelId: String(args[0]), content: args[1] });
    return [];
  }
}

function textSegmentContent(value: unknown): string | undefined {
  if (!h.isElement(value)) return undefined;
  const element = value as { type?: unknown; attrs?: { content?: unknown } };
  return element.type === 'text' && typeof element.attrs?.content === 'string' ? element.attrs.content : undefined;
}

test('native RSS command validates, lists, removes, and restores group subscriptions after restart', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-rss-'));
  const configPath = path.join(dir, 'koishi.yml');
  let itemTitle = 'First item';
  let requestCount = 0;
  let rssEnabled = true;
  let disabledDeliveryChecks = 0;
  TestBot.sent = [];
  const feedServer = createServer((_request, response) => {
    requestCount++;
    if (_request.url === '/bad.xml') {
      response.writeHead(404);
      response.end('missing');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/rss+xml' });
    const escapedTitle = itemTitle.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    response.end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Test feed</title><link>http://example.test/home</link><description>fixture</description><item><title>${escapedTitle}</title><link>http://example.test/item/1</link><guid>${escapedTitle}</guid><pubDate>Wed, 21 Oct 2026 07:28:00 GMT</pubDate></item></channel></rss>`);
  });
  await new Promise<void>(resolve => feedServer.listen(0, '127.0.0.1', resolve));
  const address = feedServer.address();
  assert.ok(address && typeof address === 'object');
  const feedUrl = `http://127.0.0.1:${address.port}/feed.xml`;
  await writeFile(configPath, `plugins:\n  database-sqlite:\n    path: ${path.join(dir, 'rss.sqlite')}\n  rss:\n    timeout: 3000\n    refresh: 250\n`);
  const setup = (app: Context) => {
    app.plugin(TestBot);
    installRssIntegration(app, { enabled: async () => rssEnabled, allowBroadcast: async (platform, channelId) => {
      if (!rssEnabled) disabledDeliveryChecks++;
      return rssEnabled && platform === 'rss-test' && channelId === 'group-1';
    }, authorize: async session => {
      return session.guildId === 'group-1' && session.userId === 'admin-1';
    } });
  };
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  const commands = async () => {
    const bot = runtime!.app.bots.find(item => item.adapterName === 'rss-test')!;
    const session = bot.session({ guild: { id: 'group-1' }, channel: { id: 'group-1', type: 0 }, user: { id: 'admin-1' }, message: { elements: [] } });
    return async (text: string) => {
      // Match Telegram interaction/command: execute directly, without the
      // ordinary message middleware's final observed-channel flush.
      const result = await session.execute(`rss ${text}`, true);
      return result.map(item => item.attrs.content).join('');
    };
  };
  try {
    runtime = await createKoishiRuntime({ configPath, setup });
    await runtime.start();
    assert.equal(runtime.app.$commander.get('rss')?.config.authority, 0);
    await runtime.app.database.setChannel('rss-test', 'group-1', { assignee: 'test', guildId: 'group-1' });
    const addResult = await (await commands())(feedUrl);
    assert.match(addResult, /添加订阅成功/, JSON.stringify({ addResult, requestCount }));
    const badFeedResult = await (await commands())(`http://127.0.0.1:${address.port}/bad.xml`);
    assert.match(badFeedResult, /无法订阅此链接/);
    assert.match(await (await commands())('-l'), new RegExp(feedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await waitFor(() => requestCount >= 3, 3000);
    await new Promise(resolve => setTimeout(resolve, 30));
    itemTitle = 'Second & item';
    await waitFor(() => requestCount >= 4, 3000);
    await waitFor(() => TestBot.sent.some(message => message.channelId === 'group-1'
      && textSegmentContent(message.content)?.includes('Second & item')), 3000)
      .catch(() => { throw new Error(`Expected RSS delivery; requests=${requestCount}, sent=${JSON.stringify(TestBot.sent)}`); });
    const deliveredItem = TestBot.sent.filter(message => message.channelId === 'group-1'
      && textSegmentContent(message.content)?.includes('Second & item'));
    assert.equal(deliveredItem.length, 1);
    assert.equal(textSegmentContent(deliveredItem[0]!.content), 'Test feed\nSecond & item\nhttp://example.test/item/1',
      'feed content must be delivered as an escaped text segment with a validated item URL');
    assert.equal(TestBot.sent.some(message => textSegmentContent(message.content)?.includes('First item')), false,
      'initial feed contents must not be broadcast');
    await runtime.stop();

    runtime = await createKoishiRuntime({ configPath, setup });
    await runtime.start();
    const restartSendStart = TestBot.sent.length;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(TestBot.sent.length, restartSendStart, 'restart must not push the existing item again');
    assert.match(await (await commands())('-l'), new RegExp(feedUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    rssEnabled = false;
    itemTitle = 'Disabled item';
    const beforeDisabledRequests = requestCount;
    await waitFor(() => requestCount >= beforeDisabledRequests + 2, 3000);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(disabledDeliveryChecks > 0, 'upstream new-item delivery must recheck current group policy');
    assert.equal(TestBot.sent.some(message => textSegmentContent(message.content)?.includes('Disabled item')), false,
      'existing upstream subscription must not deliver after the current group switch closes');
    assert.match(await (await commands())('-l'), /feed.xml/, 'disabled group can still list subscriptions');
    assert.match(await (await commands())(`-r ${feedUrl}`), /取消订阅成功/);
    assert.match(await (await commands())('-l'), /未订阅任何链接/);
  } finally {
    await runtime?.stop();
    await new Promise<void>(resolve => feedServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
});

async function waitFor(predicate: () => boolean, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for RSS feed progress.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

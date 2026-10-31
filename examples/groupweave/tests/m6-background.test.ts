import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import { Store } from '../src/server/store.js';
import { createGroupActions } from '../src/server/actions.js';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { telegramCommandSource } from '../src/server/koishi-business.js';
import { nativeFeatureAllowed } from '../src/server/group-config.js';
import { installRssIntegration } from '../src/server/koishi-rss.js';
import { installScheduleIntegration } from '../src/server/koishi-schedule.js';
const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');
class LocalBot extends Bot<Context> {
  sent: { target: string; text: string }[] = [];
  private readonly botList: Context['bots'];
  override async dispose() { const index = this.botList.findIndex(b => b.sn === this.sn); if (index >= 0) this.botList.splice(index, 1); }
  constructor(ctx: Context) { super(ctx, {}, 'telegram'); this.botList = ctx.bots; this.selfId = '99'; this.user = { id: '99', name: 'fixture_bot' } as any; }
  override async start() {} override async stop() {}
  override async sendMessage(target: string, content: any) {
    this.sent.push({ target, text: typeof content === 'string' ? content : Array.isArray(content) ? content.map(x => x.attrs?.content ?? '').join('') : content.attrs?.content ?? String(content) });
    return ['local-only'];
  }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!check()) { if (Date.now() > deadline) throw Error('local delivery timed out'); await new Promise(r => setTimeout(r, 25)); }
}
test('M6 two-group background ownership: forged targets and guessed IDs fail; disabled RSS/reminders stop while other group delivers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm6-background-'));
  const store = new Store(join(dir, 'host'));
  for (const [chatId, userId] of [['-10001', '42'], ['-10002', '43']]) { store.registerTelegramGroup({ chatId, userId, title: 'synthetic' }); store.syncTelegramMember(chatId, userId, 'admin'); }
  const actions = createGroupActions(store, { refreshRole: async () => {} });
  let title = 'initial'; let requests = 0; let disabledChecks = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(`<rss version="2.0"><channel><title>local</title><link>http://example.test/</link><description>fixture</description><item><title>${title}</title><guid isPermaLink="false">${title}</guid><link>http://example.test/${title}</link></item></channel></rss>`); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port; const url = `http://127.0.0.1:${port}/feed.xml`;
  const configPath = join(dir, 'koishi.yml');
  await writeFile(configPath, `plugins:\n  database-sqlite:\n    path: ${JSON.stringify(join(dir, 'native.db'))}\n  rss:\n    refresh: 100\n    timeout: 1000\n  schedule:\n    minInterval: 10\n`);
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  const admin = async (session: Session) => {
    const src = telegramCommandSource(session); if (!src || session.channelId !== src.actor.groupId) return false;
    try { await actions.getGroup(`tg-user:${src.actor.userId}`, `tg:${src.actor.groupId}`, true); return true; } catch { return false; }
  };
  const enabled = (feature: 'rss' | 'schedule') => async (session: Session) => {
    if (!await admin(session)) return false;
    const src = telegramCommandSource(session)!;
    const group = store.group(`tg:${src.actor.groupId}`, `tg-user:${src.actor.userId}`);
    return !!group && nativeFeatureAllowed(group.config, feature);
  };
  try {
    runtime = await createKoishiRuntime({ configPath, setup(ctx) {
      ctx.plugin(LocalBot);
      installRssIntegration(ctx, { authorize: admin, enabled: enabled('rss'), allowBroadcast: async (platform, channel) => {
        const allowed = platform === 'telegram' && store.nativeGroupEnabled(`tg:${channel}`, 'rss');
        if (!allowed) disabledChecks++; return allowed;
      } });
      installScheduleIntegration(ctx, { authorize: enabled('schedule') });
    } });
    await runtime.start();
    const bot = runtime.app.bots.find(b => b.selfId === '99') as LocalBot;
    let seq = 0;
    const run = async (group: string, user: string, command: string, forgedRawTarget?: string) => {
      const id = ++seq;
      const raw = { update_id: id, message: { message_id: id, from: { id: Number(user), is_bot: false }, chat: { id: Number(forgedRawTarget ?? group), type: 'supergroup' }, text: `/${command}` } };
      const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: user, isBot: false }, channel: { id: group, type: 0 }, guild: { id: group }, message: { id: String(id), content: `/${command}`, elements: [] }, _data: raw } as any);
      session.setInternal('telegram', raw);
      try { return JSON.stringify(await session.execute(command, true)); } catch (error) { return String(error); }
    };
    for (const group of ['-10001', '-10002']) await runtime.app.database.setChannel('telegram', group, { assignee: '99', guildId: group });
    assert.match(await run('-10002', '43', `rss ${url}`), /添加订阅成功/);
    assert.match(await run('-10001', '42', `rss -r ${url}`), /未订阅/);
    await run('-10001', '42', `rss -r ${url}`, '-10002');
    assert.match(await run('-10002', '43', 'rss -l'), /feed.xml/);
    assert.match(await run('-10001', '42', `rss ${url}`), /添加订阅成功/);
    await run('-10002', '43', 'remind every 1s B-reminder');
    const rows = await runtime.app.database.get('schedule', {}); assert.equal(rows.length, 1); const id = rows[0].id;
    for (const op of [`remove ${id}`, `pause ${id}`, `edit ${id} every 1h stolen`]) assert.match(await run('-10001', '42', `remind ${op}`), /找不到本群/);
    await run('-10001', '42', `remind remove ${id}`, '-10002');
    assert.equal((await runtime.app.database.get('schedule', {})).length, 1);
    await run('-10001', '42', 'remind every 1s A-reminder');
    await until(() => bot.sent.some(s => s.target === '-10001' && s.text === 'A-reminder') && bot.sent.some(s => s.target === '-10002' && s.text === 'B-reminder'));
    await until(() => requests > 2); title = 'enabled-item';
    await until(() => ['-10001', '-10002'].every(g => bot.sent.some(s => s.target === g && s.text.includes('enabled-item'))));
    const group = await actions.getGroup('tg-user:42', 'tg:-10001', true);
    const proposal = await actions.previewRules('tg-user:42', group.id, { baseVersion: group.version, config: { nativeFeatures: [] } });
    await actions.activateRules('tg-user:42', proposal.id);
    // Existing in-flight transport cannot be recalled. Start observation after
    // one interval has drained; policy is still checked on subsequent triggers.
    await new Promise(r => setTimeout(r, 1100));
    const start = bot.sent.length; title = 'disabled-item';
    await until(() => bot.sent.slice(start).some(s => s.target === '-10002' && s.text.includes('disabled-item'))).catch(() => { throw Error(JSON.stringify({ requests, disabledChecks, sent: bot.sent, a: store.nativeGroupEnabled('tg:-10001','rss'), b: store.nativeGroupEnabled('tg:-10002','rss') })); });
    await until(() => bot.sent.slice(start).some(s => s.target === '-10002' && s.text === 'B-reminder'));
    assert.ok(disabledChecks > 0);
    assert.equal(bot.sent.slice(start).some(s => s.target === '-10001'), false, 'disabled A must receive neither RSS nor reminder');
    assert.match(await run('-10001', '42', `rss -r ${url}`), /取消订阅成功/);
    assert.match(await run('-10002', '43', 'rss -l'), /feed.xml/);
  } finally { await runtime?.stop(); actions.close(); store.close(); await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); }
});

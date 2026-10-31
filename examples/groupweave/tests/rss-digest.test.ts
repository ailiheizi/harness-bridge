import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Context } from 'koishi';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';
import { installRssIntegration } from '../src/server/koishi-rss.js';
import { installScheduleIntegration } from '../src/server/koishi-schedule.js';
import { installRssDigestIntegration, type RssDigestIntegration } from '../src/server/rss-digest.js';
const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');
class LocalBot extends Bot<Context> {
  sent: string[] = [];
  private readonly botList: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'telegram'); this.botList = ctx.bots; this.platform = 'telegram'; this.selfId = '99'; this.user = { id: '99', name: 'test_bot' } as any; }
  override async start() {}
  override async stop() {}
  override async dispose() { const i = this.botList.findIndex(b => b.sn === this.sn); if (i >= 0) this.botList.splice(i, 1); }
  override async sendMessage(_channel: string, text: any) { this.sent.push(String(text)); return ['sent']; }
}
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'rss-digest-'));
  const feed = createServer((_req, res) => { res.setHeader('content-type', 'application/rss+xml'); res.end('<rss version="2.0"><channel><title>fixture</title><link>http://example.test/</link><description>fixture</description><item><title>initial</title><guid>initial</guid></item></channel></rss>'); });
  await new Promise<void>(r => feed.listen(0, '127.0.0.1', r));
  const feedUrl = `http://127.0.0.1:${(feed.address() as any).port}/rss`;
  const configPath = join(dir, 'koishi.yml');
  await writeFile(configPath, `plugins:\n  database-sqlite:\n    path: ${JSON.stringify(join(dir, 'native.db'))}\n  schedule: {}\n  rss: {}\n`);
  let digest!: RssDigestIntegration; let bot!: LocalBot; let allowed = true; let permission = '1:1'; let calls = 0;
  let holdAuth = -1; let authRelease: (() => void) | undefined; let authBlocked: (() => void) | undefined;
  let finish: (() => void) | undefined; let delay = false;
  const outputs: string[] = []; const inputs: string[] = [];
  const createRuntime = () => createKoishiRuntime({ configPath, setup(ctx) {
    ctx.plugin(LocalBot);
    const schedules = installScheduleIntegration(ctx, { authorize: async () => allowed });
    digest = installRssDigestIntegration(ctx, {
      schedules,
      authorize: async actor => { if (holdAuth === 0) { holdAuth = -1; authBlocked?.(); await new Promise<void>(r => { authRelease = r; }); } else if (holdAuth > 0) holdAuth--; return allowed && actor.userId === '42' ? { permission, language: 'zh' as const } : undefined; },
      execute: async (_plan, input) => { calls++; inputs.push(input); if (delay) await new Promise<void>(r => { finish = r; }); return { text: 'one summary', taskId: 'task-1' }; },
      deliver: async (_plan, result) => { outputs.push(result.text); },
    });
    installRssIntegration(ctx, { authorize: async () => allowed, allowBroadcast: async () => true, onItem: (platform, channel, text) => digest.capture(platform, channel, text) });
  } });
  let runtime = await createRuntime();
  await runtime.start(); bot = runtime.app.bots.find(b => b.selfId === '99') as LocalBot;
  await runtime.app.database.createChannel('telegram', '-1001', { assignee: '99', guildId: '-1001', rss: [feedUrl] } as any);
  let seq = 0;
  const run = async (command: string, group = '-1001', user = '42') => {
    const id = ++seq; const raw = { update_id: id, message: { message_id: id, from: { id: Number(user), is_bot: false }, chat: { id: Number(group), type: 'supergroup' }, text: `/${command}` } };
    const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: user, isBot: false }, guild: { id: group }, channel: { id: group, type: 0 }, message: { id: String(id), content: `/${command}`, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw); return JSON.stringify(await session.execute(command, true));
  };
  const activate = async () => {
    const preview = await run('rssdigest 每天09:00');
    assert.match(preview, /第三方|模型/); assert.ok(preview.includes(feedUrl.split('?')[0])); assert.match(preview, /7/);
    const id = preview.match(/[a-f0-9]{8}-[a-f0-9-]{27,}/)![0];
    assert.match(await run(`rssdigest confirm ${id}`, '-1002'), /不存在|找不到/);
    assert.match(await run(`rssdigest confirm ${id}`), /已启用/); return id;
  };
  t.after(async () => { finish?.(); await runtime.stop(); await new Promise<void>(r => feed.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  return { run, activate, feedUrl, get digest() { return digest; }, get runtime() { return runtime; }, async restart() { await runtime.stop(); runtime = await createRuntime(); await runtime.start(); bot = runtime.app.bots.find(b => b.selfId === '99') as LocalBot; }, outputs, inputs, get calls() { return calls; }, setAllowed(v: boolean) { allowed = v; }, setPermission(v: string) { permission = v; }, blockCurrentAuthorization() { holdAuth = 1; return new Promise<void>(r => { authBlocked = r; }); }, releaseAuthorization() { authRelease?.(); }, hold() { delay = true; }, release() { finish?.(); } };
}
test('daily RSS preset previews sources and cost, uses native schedule, batches once without cross-group data', async t => {
  const f = await fixture(t); await f.activate();
  const rows = await f.runtime.app.database.get('schedule', {}); assert.equal(rows.length, 1);
  assert.equal(rows[0].interval, 86400000); assert.match(rows[0].command, /^groupweave-rss-digest-deliver /);
  assert.equal(f.calls, 0); await f.run('rssdigest run'); assert.equal(f.calls, 0, 'empty batch must not call model');
  await f.digest.capture('telegram', '-1002', 'B-private-item');
  const scope = (f.runtime.app.$commander.get('rss') as any).ctx.scope.ctx;
  await scope.broadcast(['telegram:-1001'], 'A-title https://item.example/1');
  await f.digest.capture('telegram', '-1001', 'A-title https://item.example/1');
  const scheduled = f.runtime.app.bots.find(b => b.selfId === '99')!.session(rows[0].event as any);
  await scheduled.execute(rows[0].command, true); assert.equal(f.calls, 1); assert.equal(f.outputs.length, 1);
  assert.match(f.inputs[0], /A-title/); assert.ok(!f.inputs[0].includes('B-private-item'));
  await f.digest.capture('telegram', '-1001', 'next item'); await f.run('rssdigest run'); assert.equal(f.calls, 1);
  assert.match(await f.run('rssdigest status'), /尝试.*1|1.*7/);
  await f.restart(); await f.run('rssdigest run'); assert.equal(f.calls, 1, 'restart must preserve same-day admission');
});
test('subscription changes or revoked authority prevent model calls; user cannot invoke internal delivery', async t => {
  const f = await fixture(t); const id = await f.activate();
  await f.digest.capture('telegram', '-1001', 'item');
  await f.run(`groupweave-rss-digest-deliver ${id}`); assert.equal(f.calls, 0);
  await f.runtime.app.database.setChannel('telegram', '-1001', { rss: [f.feedUrl + '?changed=1'] } as any);
  await f.run('rssdigest run'); assert.equal(f.calls, 0); assert.match(await f.run('rssdigest status'), /来源|重新确认/);
  await f.activate(); await f.digest.capture('telegram', '-1001', 'new item'); f.setAllowed(false);
  await f.run('rssdigest run'); assert.equal(f.calls, 0);
});
test('stopping a running preset withholds late summary and removes only its native schedule', async t => {
  const f = await fixture(t); await f.activate(); await f.digest.capture('telegram', '-1001', 'item'); f.hold();
  const pending = f.run('rssdigest run');
  for (let i=0; i<50 && !f.calls; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(f.calls, 1); assert.match(await f.run('rssdigest stop'), /停止/); f.release(); await pending;
  assert.equal(f.outputs.length, 0); assert.equal((await f.runtime.app.database.get('schedule', {})).length, 0);
});

test('an old authorization response cannot stop a replacement plan', async t => {
  const f = await fixture(t); await f.activate(); await f.digest.capture('telegram', '-1001', 'old item');
  const blocked = f.blockCurrentAuthorization(); const oldRun = f.run('rssdigest run'); await blocked;
  f.setPermission('2:2'); const replacement = await f.activate(); f.releaseAuthorization(); await oldRun;
  assert.match(await f.run('rssdigest status'), /已启用/);
  const rows = await f.runtime.app.database.get('schedule', {});
  assert.equal(rows.length, 1); assert.ok(rows[0].command.includes(replacement)); assert.equal(f.calls, 0);
});

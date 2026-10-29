import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { Context } from 'koishi';
import { installScheduleIntegration } from '../src/server/koishi-schedule.js';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';

const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');

function localTimeAfter(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  const digits = (n: number) => String(n).padStart(2, '0');
  return { clock: `${digits(date.getHours())}:${digits(date.getMinutes())}`,
    date: `${date.getFullYear()}-${digits(date.getMonth() + 1)}-${digits(date.getDate())} ${digits(date.getHours())}:${digits(date.getMinutes())}` };
}

class FakeTelegramBot extends Bot<Context> {
  sent: string[] = [];
  private readonly botList: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'telegram'); this.botList = ctx.bots; this.platform = 'telegram'; this.selfId = '99'; this.user = { id: 99, name: 'kawaii_fox_test_bot' } as any; }
  override async start() {}
  override async stop() {}
  override async dispose() {
    const index = this.botList.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.botList.splice(index, 1);
  }
  override async sendMessage(_channelId: string, content: any) {
    this.sent.push(Array.isArray(content) ? content.map(x => x.attrs?.content ?? '').join('') : String(content));
    return [`sent-${this.sent.length}`];
  }
}

async function fixture(t: test.TestContext, minInterval = 10) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-schedule-'));
  const db = path.join(dir, 'schedule.db');
  const config = path.join(dir, 'koishi.yml');
  await writeFile(config, `plugins:\n  database-sqlite:\n    path: ${JSON.stringify(db)}\n  schedule:\n    minInterval: ${minInterval}\n  echo: {}\n`);
  let bot!: FakeTelegramBot;
  let authorized = true;
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>>;
  const start = async () => {
    runtime = await createKoishiRuntime({ configPath: config, setup(ctx) {
      ctx.plugin(FakeTelegramBot as any);
      ctx.plugin((inner: Context) => {
        bot = inner.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
        installScheduleIntegration(inner, {
          authorize: async () => authorized,
          authorizeLinks: async () => authorized,
          invokeLinks: async (_session, input) => { bot.sent.push(`links:${input}`); },
        });
      });
    } });
    await runtime.start();
    bot = runtime.app.bots.find(value => value.adapterName === 'telegram') as FakeTelegramBot;
  };
  await start();
  const run = (command: string, id: number, groupId = -100123, botUsername?: string) => {
    const raw = { update_id: id + 100, message: { message_id: id, date: Math.floor(Date.now() / 1000), from: { id: 42, is_bot: false }, chat: { id: groupId, type: 'supergroup' }, text: `/remind${botUsername ? `@${botUsername}` : ''} ${command}` } };
    const session = bot.session({ type: 'interaction/command', platform: 'telegram', user: { id: '42', isBot: false, authority: 0 },
      guild: { id: String(groupId) }, channel: { id: String(groupId), type: 0 }, message: { id: String(id), content: raw.message.text, elements: [] }, _data: raw } as any);
    session.setInternal('telegram', raw);
    return session.execute(`remind ${command}`, true);
  };
  t.after(async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); });
  return { run, get bot() { return bot; }, schedules: () => runtime.app.database.get('schedule', {}),
    pausedSchedules: () => (runtime.app.database as any).get('groupweave_paused_schedule', {}),
    async restart() { await runtime.stop(); await start(); },
    setAuthorized: (value: boolean) => { authorized = value; } };
}

test('reminder adapter schedules literal text through native scheduler delivery and manages its row', async t => {
  const f = await fixture(t);
  const message = 'scheduled-safe-text <b>literal</b>';
  const result = await f.run(`every 1s ${message}`, 1);
  assert.match(JSON.stringify(result), /created|已创建|日程/);
  assert.ok(result.every(element => element.type === 'text'), 'reminder confirmation must preserve literal text');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.ok(f.bot.sent.includes(message), JSON.stringify(f.bot.sent));
  const rows = await f.schedules();
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(await f.run('list', 3)), new RegExp(String(rows[0].id)));
  const removed = await f.run(`remove ${rows[0].id}`, 4);
  assert.match(JSON.stringify(removed), /本次.*发送流程|仍可能收到/);
  assert.equal((await f.schedules()).length, 0);
  const daily = localTimeAfter(5);
  const dailyResult = await f.run(`daily ${daily.clock} daily-visible-text`, 5);
  assert.match(JSON.stringify(dailyResult), /时间：.*内容：daily-visible-text/);
  const once = localTimeAfter(6);
  await f.run(`${once.date} once-visible-text`, 6);
  const created = await f.schedules();
  assert.equal(created.length, 2);
  assert.ok(created.some(row => row.interval === 86_400_000));
  assert.ok(created.some(row => row.interval === 0));
  assert.match(JSON.stringify(await f.run('list', 7)), /daily-visible-text/);
  assert.match(JSON.stringify(await f.run('list', 8)), /once-visible-text/);
});

test('reminder adapter denies unauthorized callers and confines list/remove to owned schedules', async t => {
  const f = await fixture(t);
  f.setAuthorized(false);
  assert.match(JSON.stringify(await f.run('every 1s blocked-text', 2)), /无权|管理员/);
  assert.equal(f.bot.sent.includes('blocked-text'), false);
});

test('targeted reminder delivery accepts only this bot username', async t => {
  const f = await fixture(t);
  assert.match(JSON.stringify(await f.run('every 1s wrong-bot-target', 20, -100123, 'another_bot')), /目标机器人|用法/);
  assert.equal((await f.schedules()).length, 0);

  await f.run('every 1s valid-bot-target', 21, -100123, 'kawaii_fox_test_bot');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.ok(f.bot.sent.includes('valid-bot-target'), JSON.stringify(f.bot.sent));
});

test('native create rejection is returned without a success confirmation', async t => {
  const f = await fixture(t, 60_000);
  const result = await f.run('every 1s too-short-native-interval', 22);
  const rendered = JSON.stringify(result);
  assert.match(rendered, /间隔过短/);
  assert.doesNotMatch(rendered, /时间：|内容：/);
  assert.equal((await f.schedules()).length, 0);
});

test('upstream schedule row survives a Koishi restart and fires through the normal group transport', async t => {
  const f = await fixture(t);
  await f.run('every 1s restart-persistent-text', 30);
  const before = await f.schedules();
  assert.equal(before.length, 1);
  await f.restart();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.ok(f.bot.sent.includes('restart-persistent-text'), JSON.stringify(f.bot.sent));
  assert.equal((await f.schedules()).length, 1);
});

test('reminder edit replaces the native row using once, daily, and every schedules', async t => {
  const f = await fixture(t);
  await f.run('every 1h original-text', 40);
  let rows = await f.schedules();
  assert.equal(rows.length, 1);
  let id = rows[0].id;

  const once = localTimeAfter(10);
  const onceResult = await f.run(`edit ${id} ${once.date} edited-once`, 41);
  assert.match(JSON.stringify(onceResult), /修改|已创建/);
  rows = await f.schedules();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, id);
  assert.equal(rows[0].interval, 0);
  assert.ok(rows[0].command.endsWith(Buffer.from('edited-once').toString('base64url')));
  id = rows[0].id;

  const daily = localTimeAfter(10);
  await f.run(`edit ${id} daily ${daily.clock} edited-daily`, 42);
  rows = await f.schedules();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, id);
  assert.equal(rows[0].interval, 86_400_000);
  assert.ok(rows[0].command.endsWith(Buffer.from('edited-daily').toString('base64url')));
  id = rows[0].id;

  await f.run(`edit ${id} every 2h edited-interval`, 43);
  rows = await f.schedules();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, id);
  assert.equal(rows[0].interval, 7_200_000);
  assert.ok(rows[0].command.endsWith(Buffer.from('edited-interval').toString('base64url')));
});

test('reminder edit is group-scoped and preserves the old row on invalid or rejected replacement', async t => {
  const f = await fixture(t);
  await f.run('every 1h keep-this-reminder', 50);
  const [original] = await f.schedules();
  assert.ok(original);

  assert.match(JSON.stringify(await f.run(`edit ${original.id} every 2h cross-group`, 51, -100999)), /找不到本群/);
  assert.deepEqual(await f.schedules(), [original]);

  assert.match(JSON.stringify(await f.run(`edit ${original.id} not-a-schedule`, 52)), /用法/);
  assert.deepEqual(await f.schedules(), [original]);

  assert.match(JSON.stringify(await f.run(`edit ${original.id} every 1s native-reject`, 53)), /間隔|间隔|短/);
  assert.deepEqual(await f.schedules(), [original]);
});

test('pause persists through restart and resume recreates the native schedule', async t => {
  const f = await fixture(t);
  await f.run('every 1h pause-resume-text', 70);
  const [original] = await f.schedules();

  const paused = await f.run(`pause ${original.id}`, 71);
  assert.match(JSON.stringify(paused), /已暂停/);
  assert.equal((await f.schedules()).length, 0);
  assert.equal((await f.pausedSchedules()).length, 1);
  assert.match(JSON.stringify(await f.run('list', 72)), /暂停/);
  assert.match(JSON.stringify(await f.run(`resume ${original.id}`, 73, -100999)), /找不到本群/);
  assert.equal((await f.pausedSchedules()).length, 1);

  await f.restart();
  assert.equal((await f.schedules()).length, 0);
  assert.equal((await f.pausedSchedules()).length, 1);

  const resumed = await f.run(`resume ${original.id}`, 74);
  assert.match(JSON.stringify(resumed), /已恢复/);
  const active = await f.schedules();
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, original.id);
  assert.equal((await f.pausedSchedules()).length, 0);
  assert.ok(active[0].command.endsWith(Buffer.from('pause-resume-text').toString('base64url')));
});

test('minimum one-minute reminder can pause through native delete; scheduled links use only the fixed callback', async t => {
  const f = await fixture(t, 60_000);
  await f.run('every 1m pause-default-interval', 80);
  const [minute] = await f.schedules();
  assert.ok(minute);
  const paused = await f.run(`pause ${minute.id}`, 81);
  assert.match(JSON.stringify(paused), /已暂停.*仍可能收到/);
  assert.equal((await f.schedules()).length, 0, 'native timer row is deleted');
  assert.equal((await f.pausedSchedules()).length, 1, 'resume data remains persisted');
  const deliveryCountAfterPause = f.bot.sent.filter(item => item === 'pause-default-interval').length;
  await new Promise(resolve => setTimeout(resolve, 1_200));
  assert.equal(f.bot.sent.filter(item => item === 'pause-default-interval').length, deliveryCountAfterPause,
    'no further delivery occurs after the native row is deleted');

  const links = await fixture(t);
  await links.run('links every 1s https://example.com/a', 82);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.ok(links.bot.sent.includes('links:https://example.com/a'), JSON.stringify(links.bot.sent));
});

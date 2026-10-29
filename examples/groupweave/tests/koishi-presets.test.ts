import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { Context } from 'koishi';
import { startKoishiHost } from '../src/server/koishi-index.js';

const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');

class PresetTestBot extends Bot<Context> {
  private readonly bots: Context['bots'];
  constructor(ctx: Context) { super(ctx, {}, 'preset-test'); this.selfId = 'test'; this.bots = ctx.bots; }
  override async start() {}
  override async stop() {}
  override async dispose() {
    const index = this.bots.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.bots.splice(index, 1);
  }
}

test('copied minimal preset starts the real native host, serves Help/Echo, and preserves SQLite data across restart', async () => {
  const sourcePath = path.resolve('examples/native/koishi-minimal.yml');
  const sourceContents = await readFile(sourcePath, 'utf8');
  const dir = await mkdtemp(path.join(process.cwd(), 'artifacts', 'koishi-preset-'));
  const configPath = path.join(dir, 'koishi-minimal.yml');
  await writeFile(configPath, sourceContents);
  const dataDir = path.join(dir, 'data');
  const settings = {
    ENABLE_TELEGRAM: '0', ENABLE_AI: '0', ENABLE_MEDIA: '0', DATA_DIR: dataDir,
    HOST: '127.0.0.1', PORT: String(await freePort()), TELEGRAM_BOT_TOKEN: '', TELEGRAM_ADMIN_IDS: '',
  };
  const keys = Object.keys(settings);
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let host: Awaited<ReturnType<typeof startKoishiHost>> | undefined;
  try {
    Object.assign(process.env, settings);
    host = await startKoishiHost(configPath);
    assert.ok(host.runtime.app.$commander.get('help'));
    assert.ok(host.runtime.app.$commander.get('echo'));
    assert.ok(host.runtime.app.database);
    assert.equal(host.runtime.app.$commander.get('rss'), undefined);
    assert.equal(host.runtime.app.$commander.get('schedule'), undefined);
    host.runtime.app.plugin(PresetTestBot);
    const bot = host.runtime.app.bots.find(item => item.adapterName === 'preset-test')!;
    const helpSession = bot.session({ user: { id: 'help-user' }, channel: { id: 'help-channel', type: 0 }, guild: { id: 'help-channel' }, message: { elements: [] } });
    assert.match((await helpSession.execute('help', true)).map(item => item.attrs.content).join(''), /echo/);
    const echoSession = bot.session({ user: { id: 'echo-user' }, channel: { id: 'echo-channel', type: 0 }, guild: { id: 'echo-channel' }, message: { elements: [] } });
    assert.equal((await echoSession.execute('echo preset works', true)).map(item => item.attrs.content).join(''), 'preset works');
    assert.equal(host.runtime.app.bots.filter(item => item.platform === 'telegram').length, 0);
    const registered = host.app.groupweave.store.registerTelegramGroup({ chatId: '-100123', title: 'Preset persistence group', userId: '123' });
    host.app.groupweave.store.syncTelegramMember('-100123', '123', 'admin');
    assert.equal(host.app.groupweave.store.group(registered.groupId, registered.actorId)?.config.language, 'zh');
    const database = host.runtime.app.database as Context['database'] & {
      createUser(platform: string, id: string, data: { name: string }): Promise<unknown>;
      getUser(platform: string, id: string): Promise<{ name: string } | undefined>;
    };
    await database.createUser('preset-test', 'saved-user', { name: 'Saved User' });
    await host.stop(); host = undefined;

    settings.PORT = String(await freePort());
    Object.assign(process.env, settings);
    host = await startKoishiHost(configPath);
    const reopenedDatabase = host.runtime.app.database as typeof database;
    assert.equal((await reopenedDatabase.getUser('preset-test', 'saved-user'))?.name, 'Saved User');
    assert.equal(host.app.groupweave.store.group('tg:-100123', 'tg-user:123')?.name, 'Preset persistence group');
    assert.equal(host.app.groupweave.store.group('tg:-100123', 'tg-user:123')?.config.language, 'zh');
    assert.equal(host.runtime.app.$commander.get('rss'), undefined);
    assert.equal(host.runtime.app.$commander.get('schedule'), undefined);
    await host.stop(); host = undefined;
    assert.equal(await readFile(configPath, 'utf8'), sourceContents);
    assert.equal(await readFile(sourcePath, 'utf8'), sourceContents);
  } finally {
    await host?.stop();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
});

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { Context } from 'koishi';
import { createKoishiRuntime } from '../src/server/koishi-runtime.js';

const require = createRequire(import.meta.url);
const { Bot } = require('@koishijs/core') as typeof import('koishi');

class TestBot extends Bot<Context> {
  private readonly bots: Context['bots'];
  constructor(ctx: Context) {
    super(ctx, {}, 'runtime-test');
    this.selfId = 'test';
    this.bots = ctx.bots;
  }
  override async start() {}
  override async stop() {}
  override async dispose() {
    const index = this.bots.findIndex(bot => bot.sn === this.sn);
    if (index >= 0) this.bots.splice(index, 1);
  }
  override async sendMessage() { return []; }
}

test('loads native YAML plugins, invokes their command, and can restart from the same config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-runtime-'));
  const configPath = path.join(dir, 'koishi.yml');
  await writeFile(configPath, 'plugins:\n  "@koishijs/plugin-echo": {}\n');
  const setup = (app: Context) => { app.plugin(TestBot); };
  let runtime = await createKoishiRuntime({ configPath, setup });
  try {
    await runtime.start();
    const bot = runtime.app.bots.find(item => item.adapterName === 'runtime-test')!;
    const result = await bot.session({
      user: { id: 'u1' }, channel: { id: 'c1', type: 0 },
      message: { elements: [] },
    }).execute('echo hello', true);
    assert.equal(result.map(item => item.attrs.content).join(''), 'hello');
  } finally {
    await runtime.stop();
  }

  runtime = await createKoishiRuntime({ configPath, setup });
  try {
    await runtime.start();
    const bot = runtime.app.bots.find(item => item.adapterName === 'runtime-test')!;
    const result = await bot.session({
      user: { id: 'u2' }, channel: { id: 'c2', type: 0 },
      message: { elements: [] },
    }).execute('echo again', true);
    assert.equal(result.map(item => item.attrs.content).join(''), 'again');
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('root Koishi config loads help, echo, and persistent SQLite while Telegram is disabled', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'koishi-runtime-data-'));
  const configContents = await readFile(path.resolve('koishi.yml'), 'utf8');
  const configDir = await mkdtemp(path.join(process.cwd(), 'artifacts', 'koishi-runtime-test-'));
  const configPath = path.join(configDir, 'koishi.yml');
  await writeFile(configPath, configContents);
  const oldEnableTelegram = process.env.ENABLE_TELEGRAM;
  const oldDataDir = process.env.DATA_DIR;
  process.env.ENABLE_TELEGRAM = '0';
  process.env.DATA_DIR = dataDir;
  let runtime: Awaited<ReturnType<typeof createKoishiRuntime>> | undefined;
  try {
    runtime = await createKoishiRuntime({
      configPath,
      beforeCreate() {
        // NodeLoader reads .env during readConfig; enforce test-owned values
        // after that step, while still before any plugin can initialize.
        process.env.ENABLE_TELEGRAM = '0';
        process.env.DATA_DIR = dataDir;
      },
    });
    await runtime.start();
    assert.ok(runtime.app.$commander.get('help'));
    assert.ok(runtime.app.$commander.get('echo'));
    const database = (runtime.app as Context & { database: {
      createUser(platform: string, id: string, data: { name: string }): Promise<unknown>;
      getUser(platform: string, id: string): Promise<{ name: string } | undefined>;
    } }).database;
    await database.createUser('runtime-test', 'persistent-user', { name: 'Saved User' });
    assert.equal((await database.getUser('runtime-test', 'persistent-user'))?.name, 'Saved User');
    await runtime.stop();
    runtime = await createKoishiRuntime({
      configPath,
      beforeCreate() {
        process.env.ENABLE_TELEGRAM = '0';
        process.env.DATA_DIR = dataDir;
      },
    });
    await runtime.start();
    const reopenedDatabase = (runtime.app as Context & { database: typeof database }).database;
    assert.equal((await reopenedDatabase.getUser('runtime-test', 'persistent-user'))?.name, 'Saved User');
  } finally {
    await runtime?.stop();
    assert.equal(await readFile(path.resolve('koishi.yml'), 'utf8'), configContents);
    if (oldEnableTelegram === undefined) delete process.env.ENABLE_TELEGRAM;
    else process.env.ENABLE_TELEGRAM = oldEnableTelegram;
    if (oldDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = oldDataDir;
    await rm(dataDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test('missing config reports its path without echoing unrelated environment values', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'koishi-runtime-missing-'));
  const configPath = path.join(dir, 'missing.yml');
  await assert.rejects(
    createKoishiRuntime({ configPath }),
    (error: Error) => error.message.includes(configPath) && !error.message.includes('BOT_TOKEN'),
  );
  await rm(dir, { recursive: true, force: true });
});

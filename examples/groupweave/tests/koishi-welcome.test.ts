import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import { createKoishiCodeHost } from '../src/server/koishi.js';
import type { NativeRequest } from '../src/server/native.js';

const require = createRequire(import.meta.url);
const { Command } = require('@koishijs/core') as typeof import('koishi');
const request = (changes: Partial<NativeRequest> = {}): NativeRequest => ({
  actorId: 'alice', groupId: 'group-a', input: 'Alice',
  options: { deduplicate: true, sort: true, maxItems: 10, groupTitle: 'A 群' },
  audience: 'group', authorized: true, ...changes,
});

test('welcome uses a real native Koishi command with Chinese and English defaults, without IO or models', async () => {
  const original = Command.prototype.execute;
  const commands: string[] = [];
  Command.prototype.execute = async function (...args) {
    commands.push(this.name);
    return original.apply(this, args);
  };
  const host = createKoishiCodeHost();
  try {
    assert.deepEqual(await host.executeWelcome(request()), { output: '欢迎 Alice 加入 A 群！', modelCalls: 0 });
    assert.deepEqual(await host.executeWelcome(request({ options: { deduplicate: true, sort: true, maxItems: 10, language: 'en', groupTitle: 'Group A' } })),
      { output: 'Welcome Alice to Group A!', modelCalls: 0 });
    assert.equal((await host.executeWelcome(request({ options: { deduplicate: true, sort: true, maxItems: 10 } }))).output,
      '欢迎 Alice 加入 本群！');
    assert.deepEqual(commands, ['groupweave-welcome', 'groupweave-welcome', 'groupweave-welcome']);
  } finally { Command.prototype.execute = original; await host.dispose(); }
});

test('concurrent group welcomes keep their own member, title, template and language', async () => {
  const host = createKoishiCodeHost();
  try {
    const [a, b] = await Promise.all([
      host.executeWelcome(request({ options: { deduplicate: true, sort: true, maxItems: 10, welcomeText: '{group}: 欢迎 {name}', groupTitle: 'A 群' } })),
      host.executeWelcome(request({ actorId: 'bob', groupId: 'group-b', input: 'Bob', options: { deduplicate: true, sort: true, maxItems: 10, language: 'en', welcomeText: '{name}, welcome to {group}.', groupTitle: 'Group B' } })),
    ]);
    assert.equal(a.output, 'A 群: 欢迎 Alice');
    assert.equal(b.output, 'Bob, welcome to Group B.');
    assert.doesNotMatch(a.output, /Bob|Group B/);
    assert.doesNotMatch(b.output, /Alice|A 群/);
  } finally { await host.dispose(); }
});

test('welcome expands only documented placeholders once and preserves command, expression and component syntax as text', async () => {
  const host = createKoishiCodeHost();
  const input = '{group} -c telegram:other $(echo secret) <image src="https://secret.test/a"/>';
  const groupTitle = '${process.env.SECRET} <at id="other"/>';
  const welcomeText = '{name} / {group} / {role} / ${constructor}';
  try {
    assert.deepEqual(await host.executeWelcome(request({ input, options: { deduplicate: true, sort: true, maxItems: 10, welcomeText, groupTitle } })),
      { output: `${input} / ${groupTitle} / {role} / \${constructor}`, modelCalls: 0 });
  } finally { await host.dispose(); }
});

test('unauthorized or unscoped welcome requests cannot enter the native command', async () => {
  const original = Command.prototype.execute;
  let count = 0;
  Command.prototype.execute = async function (...args) { count++; return original.apply(this, args); };
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeWelcome(request({ authorized: false })), /无权/);
    await assert.rejects(host.executeWelcome(request({ groupId: '' })), /身份/);
    await assert.rejects(host.executeWelcome(request({ actorId: ' ' })), /身份/);
    await assert.rejects(host.executeWelcome(request({ audience: 'global' as NativeRequest['audience'] })), /受众/);
    assert.equal(count, 0);
  } finally { Command.prototype.execute = original; await host.dispose(); }
});

for (const field of ['guildId', 'channelId', 'userId', 'command', 'options', 'args'] as const) {
  test(`welcome native binding rejects ${field} substitution`, async () => {
    const original = Command.prototype.execute;
    Command.prototype.execute = async function (argv, fallback) {
      if (this.name === 'groupweave-welcome') {
        if (field === 'guildId' || field === 'channelId' || field === 'userId') argv.session![field] = 'other-scope';
        else if (field === 'command') argv.command = argv.session!.app.$commander.get('echo');
        else if (field === 'options') argv.options = { channel: 'other-scope' };
        else argv.args = ['other member'];
      }
      return original.call(this, argv, fallback);
    };
    const host = createKoishiCodeHost();
    try { await assert.rejects(host.executeWelcome(request()), /绑定/); }
    finally { Command.prototype.execute = original; await host.dispose(); }
  });
}

test('welcome uses an immutable request snapshot and releases its command session after completion', async () => {
  const original = Command.prototype.execute;
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let session: Session | undefined;
  Command.prototype.execute = async function (...args) {
    if (this.name === 'groupweave-welcome') { session = args[0].session!; enter(); await barrier; }
    return original.apply(this, args);
  };
  const host = createKoishiCodeHost();
  const bound = request({ options: { deduplicate: true, sort: true, maxItems: 10, welcomeText: '{name} @ {group}', groupTitle: 'Original group' } });
  const pending = host.executeWelcome(bound);
  try {
    await started;
    bound.groupId = 'other-group'; bound.actorId = 'other-actor'; bound.input = 'Other member';
    bound.options.groupTitle = 'Other group'; bound.options.welcomeText = 'changed';
    release();
    assert.equal((await pending).output, 'Alice @ Original group');
    for (const command of ['groupweave-welcome', 'groupweave-links', 'echo']) {
      assert.deepEqual(await session!.execute({ name: command, args: [], options: {}, source: command }, true), []);
    }
  } finally {
    release(); await pending.catch(() => undefined);
    Command.prototype.execute = original; await host.dispose();
  }
});

test('welcome template and expanded output limits fail honestly and leave the host reusable', async () => {
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeWelcome(request({ options: { deduplicate: true, sort: true, maxItems: 10, welcomeText: 'x'.repeat(501) } })), /模板超出/);
    await assert.rejects(host.executeWelcome(request({ input: 'x'.repeat(100), options: { deduplicate: true, sort: true, maxItems: 10, welcomeText: '{name}'.repeat(50) } })), /结果超出/);
    assert.equal((await host.executeWelcome(request())).output, '欢迎 Alice 加入 A 群！');
  } finally { await host.dispose(); }
});

test('pre-aborted welcome calls execute no native command', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancel welcome before execution'));
  const original = Command.prototype.execute;
  let count = 0;
  Command.prototype.execute = async function (...args) { count++; return original.apply(this, args); };
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeWelcome(request(), controller.signal), /cancel welcome/);
    assert.equal(count, 0);
  } finally { Command.prototype.execute = original; await host.dispose(); }
});

test('cancel and dispose withhold welcome output, wait for native execution and release the owned bot', async () => {
  const original = Command.prototype.execute;
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let session: Session | undefined;
  let bots: Context['bots'] | undefined;
  Command.prototype.execute = async function (...args) {
    session = args[0].session!; bots = session.app.bots; enter(); await barrier;
    return original.apply(this, args);
  };
  const host = createKoishiCodeHost();
  const controller = new AbortController();
  const pending = host.executeWelcome(request(), controller.signal);
  void pending.catch(() => undefined);
  let settled = false;
  void pending.finally(() => { settled = true; }).catch(() => undefined);
  try {
    await started;
    controller.abort(new Error('cancel welcome while running'));
    const closing = host.dispose();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    await assert.rejects(host.executeWelcome(request()), /已关闭/);
    release();
    await assert.rejects(pending, /cancel welcome/);
    await closing;
    assert.equal(bots!.length, 0);
  } finally {
    release(); await pending.catch(() => undefined);
    Command.prototype.execute = original; await host.dispose();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { Context, Session } from 'koishi';
import { createKoishiCodeHost } from '../src/server/koishi.js';
import { NativeInputError } from '../src/server/links.js';
import type { NativeRequest } from '../src/server/native.js';

const require = createRequire(import.meta.url);
const { Command } = require('@koishijs/core') as typeof import('koishi');
const request = (changes: Partial<NativeRequest> = {}): NativeRequest => ({
  actorId: 'alice', groupId: 'group-a', input: 'https://b.example/b https://a.example/a https://b.example/b',
  options: { deduplicate: true, sort: true, maxItems: 10 }, audience: 'private', authorized: true,
  ...changes,
});

test('actual native Koishi commands execute links and unchanged npm echo without sending', async () => {
  const original = Command.prototype.execute;
  const commands: string[] = [];
  Command.prototype.execute = async function (...args) {
    commands.push(this.name);
    return original.apply(this, args);
  };
  const host = createKoishiCodeHost();
  try {
    const links = await host.executeLinks(request());
    assert.deepEqual(links, { output: '整理结果：2 条链接\n\n1. https://a.example/a\n2. https://b.example/b', modelCalls: 0 });
    const echo = await host.executeEcho(request({ input: '生态插件的原生输出' }));
    assert.deepEqual(echo, { output: '生态插件的原生输出', modelCalls: 0 });
    assert.deepEqual(commands, ['groupweave-links', 'echo']);
    assert.equal(require('@koishijs/plugin-echo').name, 'echo');
  } finally {
    Command.prototype.execute = original;
    await host.dispose();
  }
});

test('two groups and actors keep distinct bound input and per-request options', async () => {
  const host = createKoishiCodeHost();
  try {
    const [a, b, echo] = await Promise.all([
      host.executeLinks(request({ input: 'https://a.example/a https://a.example/a', options: { deduplicate: false, sort: false, maxItems: 2 } })),
      host.executeLinks(request({ actorId: 'bob', groupId: 'group-b', input: 'https://b.example/b https://b.example/b', options: { deduplicate: true, sort: true, maxItems: 1, language: 'en' } })),
      host.executeEcho(request({ actorId: 'bob', groupId: 'group-b', input: 'B 群私有文本' })),
    ]);
    assert.equal(a.output, '整理结果：2 条链接\n\n1. https://a.example/a\n2. https://a.example/a');
    assert.equal(b.output, 'Organized result: 1 link\n\n1. https://b.example/b');
    assert.equal(echo.output, 'B 群私有文本');
    assert.doesNotMatch(a.output, /b\.example/);
    assert.doesNotMatch(b.output, /a\.example/);
  } finally { await host.dispose(); }
});

test('echo command syntax, interpolation and message markup remain plain input', async () => {
  const host = createKoishiCodeHost();
  try {
    const input = '-u telegram:other -c telegram:other -g other $(groupweave-links) <image src="https://secret.test/a"/> &';
    assert.deepEqual(await host.executeEcho(request({ input })), { output: input, modelCalls: 0 });
  } finally { await host.dispose(); }
});

test('the server boundary rejects unauthorized, empty scope and unsupported audience', async () => {
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeEcho(request({ authorized: false })), /无权/);
    await assert.rejects(host.executeLinks(request({ groupId: '' })), /身份/);
    await assert.rejects(host.executeEcho(request({ actorId: ' ' })), /身份/);
    await assert.rejects(host.executeEcho(request({ audience: 'global' as NativeRequest['audience'] })), /受众/);
    await assert.rejects(host.executeEcho(request({ input: 'x'.repeat(50_001) })), error => error instanceof NativeInputError && error.code === 'INPUT_LIMIT');
    assert.equal((await host.executeEcho(request({ input: '有效输入' }))).output, '有效输入');
  } finally { await host.dispose(); }
});

for (const field of ['guildId', 'userId', 'options', 'args'] as const) {
  test(`the native command guard rejects ${field} substitution`, async () => {
    const original = Command.prototype.execute;
    Command.prototype.execute = async function (argv, fallback) {
      if (this.name === 'echo') {
        if (field === 'guildId' || field === 'userId') argv.session![field] = 'another-scope';
        else if (field === 'options') argv.options = { user: 'telegram:other' };
        else argv.args = ['substituted input'];
      }
      return original.call(this, argv, fallback);
    };
    const host = createKoishiCodeHost();
    try { await assert.rejects(host.executeEcho(request({ input: 'original input' })), /绑定/); }
    finally { Command.prototype.execute = original; await host.dispose(); }
  });
}

test('each completed request releases its native scope and never retains a usable session', async () => {
  const original = Command.prototype.execute;
  const sessions: Session[] = [];
  let bots: Context['bots'] | undefined;
  Command.prototype.execute = async function (...args) {
    sessions.push(args[0].session!);
    bots = args[0].session!.app.bots;
    return original.apply(this, args);
  };
  const host = createKoishiCodeHost();
  try {
    for (let index = 0; index < 12; index++) {
      await host.executeEcho(request({ input: String(index) }));
      const session = sessions.at(-1)!;
      assert.deepEqual(await session.execute({ name: 'echo', args: ['old input'], options: {}, source: 'echo' }, true), []);
    }
    assert.equal(new Set(sessions.map(session => session.id)).size, 12);
    assert.equal(bots!.length, 1);
    await host.dispose();
    assert.equal(bots!.length, 0);
  } finally { Command.prototype.execute = original; await host.dispose(); }
});

test('native link input errors preserve their actual type and do not become empty success', async () => {
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeLinks(request({ input: '无链接' })), error => error instanceof NativeInputError && error.code === 'NO_LINKS');
    await assert.rejects(host.executeLinks(request({ options: { deduplicate: true, sort: true, maxItems: 0 } })), error => error instanceof NativeInputError && error.code === 'MAX_ITEMS');
    assert.match((await host.executeLinks(request())).output, /整理结果/);
  } finally { await host.dispose(); }
});

test('pre-aborted calls do not execute a native command', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancel before native execution'));
  const original = Command.prototype.execute;
  let count = 0;
  Command.prototype.execute = async function (...args) { count++; return original.apply(this, args); };
  const host = createKoishiCodeHost();
  try {
    await assert.rejects(host.executeEcho(request(), controller.signal), /cancel before/);
    assert.equal(count, 0);
  } finally { Command.prototype.execute = original; await host.dispose(); }
});

test('cancellation withholds output and keeps the native invocation alive until work drains', async () => {
  const original = Command.prototype.execute;
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  Command.prototype.execute = async function (...args) { enter(); await barrier; return original.apply(this, args); };
  const controller = new AbortController();
  const host = createKoishiCodeHost();
  let settled = false;
  const pending = host.executeEcho(request(), controller.signal);
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await started;
    controller.abort(new Error('cancel during native execution'));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    release();
    await assert.rejects(pending, /cancel during/);
  } finally {
    release(); await pending.catch(() => undefined);
    Command.prototype.execute = original; await host.dispose();
  }
});

test('dispose aborts active requests, waits for native work, and permanently closes entrypoints', async () => {
  const original = Command.prototype.execute;
  let enter!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  Command.prototype.execute = async function (...args) { enter(); await barrier; return original.apply(this, args); };
  const host = createKoishiCodeHost();
  const pending = host.executeEcho(request());
  void pending.catch(() => undefined);
  let disposed = false;
  try {
    await started;
    const closing = host.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(disposed, false);
    await assert.rejects(host.executeLinks(request()), /已关闭/);
    release();
    await assert.rejects(pending, /已关闭/);
    await closing;
    assert.equal(disposed, true);
    await host.dispose();
  } finally {
    release(); await pending.catch(() => undefined);
    Command.prototype.execute = original; await host.dispose();
  }
});

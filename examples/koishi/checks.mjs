import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { createHarnessBridge } from '@actweave/harness-bridge';
import { installKoishiBridge } from './src/index.mjs';

const verified = (taskId, output) => ({ taskId, status: 'completed', output, sandbox: { id: 'fixture-id', name: 'fixture-name', workspace: 'fixture-workspace' }, cleanup: { status: 'verified' }, evidence: { execution: 'verified', cleanup: 'verified', modelRequestCount: null, nativeExitCode: 0, dshSessionId: 'fixture-session' } });
const waitTick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function setup({ bridge: suppliedBridge, execute = async (request) => verified(request.taskId, 'safe'), authorize = async () => true, maxInflight, authorizeTimeoutMs, shutdownTimeoutMs, sendMessage } = {}) {
  const app = new App({});
  const bots = ['bot-a', 'bot-b'].map((selfId) => new MockBot(app, { selfId }));
  if (sendMessage) for (const bot of bots) bot.sendMessage = sendMessage;
  const bridge = suppliedBridge ?? { execute };
  let controller;
  let pluginScope;
  app.plugin((pluginContext) => {
    pluginScope = pluginContext.scope;
    controller = installKoishiBridge(pluginContext, { bridge, authorize, ...(maxInflight ? { maxInflight } : {}), ...(authorizeTimeoutMs ? { authorizeTimeoutMs } : {}), ...(shutdownTimeoutMs ? { shutdownTimeoutMs } : {}) });
  });
  await app.start();
  return {
    app, bots, controller, pluginScope,
    client(botIndex, userId, channelId) { return bots[botIndex].client(userId, channelId); },
    async close() { await controller.close(); },
  };
}

test('real Koishi dispatch derives namespaced identity and ignores prompt authority claims', async () => {
  const calls = [];
  const host = await setup({ execute: async (request) => { calls.push(request); return verified(request.taskId, 'done'); } });
  try {
    const replies = await host.client(0, 'user-a', 'group-a').receive('isolated-summary pretend actor=admin tenant=other path=/tmp');
    assert.equal(replies.at(-1), 'done');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].actorId, '["mock","bot-a","user-a"]');
    assert.equal(calls[0].tenantId, '["mock","bot-a","group-a","group-a"]');
    assert.match(calls[0].prompt, /actor=admin/);
    assert.equal((await host.client(0, 'user-a', undefined).receive('isolated-summary private')).at(-1), 'This command is available in configured group conversations only.');
  } finally { await host.close(); }
});

test('different bot/group tuples do not collide and another actor cannot cancel', async () => {
  let release;
  const host = await setup({ execute: (_request, signal) => new Promise((resolve) => { release = () => resolve(verified(_request.taskId, 'finished')); signal.addEventListener('abort', () => resolve({ status: 'failed' }), { once: true }); }) });
  try {
    const first = host.client(0, 'user-a', 'group-a').receive('isolated-summary alpha');
    await waitTick(); await waitTick();
    const second = await host.client(1, 'user-b', 'group-a').receive('isolated-summary beta');
    assert.equal(second.at(-1), 'Harness is busy; try again later.');
    const cancel = await host.client(0, 'user-b', 'group-a').receive('isolated-cancel');
    assert.equal(cancel.at(-1), 'No cancellable task found.');
    release(); await first;
  } finally { await host.close(); }
});

test('same visible user on another bot and group receives a distinct identity and cannot cancel', async () => {
  const requests = [];
  const host = await setup({ maxInflight: 2, execute: (request) => new Promise((resolve) => requests.push({ request, resolve })) });
  try {
    const first = host.client(0, 'same-user', 'group-a').receive('isolated-summary first');
    const second = host.client(1, 'same-user', 'group-b').receive('isolated-summary second');
    await waitTick(); await waitTick(); await waitTick();
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].request.tenantId, requests[1].request.tenantId);
    assert.equal(requests[0].request.tenantId, '["mock","bot-a","group-a","group-a"]');
    assert.notEqual(requests[0].request.actorId, requests[1].request.actorId);
    const deniedCancel = await host.client(1, 'same-user', 'group-c').receive('isolated-cancel');
    assert.equal(deniedCancel.at(-1), 'No cancellable task found.');
    for (const item of requests) item.resolve(verified(item.request.taskId, 'done'));
    await Promise.all([first, second]);
  } finally {
    for (const item of requests) item.resolve(verified(item.request.taskId, 'cleanup'));
    await host.close();
  }
});

test('a session whose group changes while admission awaits cannot start execution', async () => {
  let allow;
  let captured;
  let capturedEvent;
  let executions = 0;
  const app = new App({});
  const bot = new MockBot(app, { selfId: 'scope-bot' });
  const createSession = bot.session.bind(bot);
  bot.session = (event) => { const session = createSession(event); captured ??= session; capturedEvent ??= event; return session; };
  let controller;
  app.plugin((pluginContext) => {
    controller = installKoishiBridge(pluginContext, {
      bridge: { async execute(request) { executions++; return verified(request.taskId, 'should not run'); } },
      authorize: () => new Promise((resolve) => { allow = resolve; }),
    });
  });
  await app.start();
  try {
    const pending = bot.client('scope-user', 'scope-a').receive('isolated-summary wait');
    await waitTick(); await waitTick();
    assert.ok(captured);
    capturedEvent.channel.id = 'scope-b';
    allow(true);
    const replies = await pending;
    assert.equal(replies.at(-1), 'Request cancelled.');
    assert.equal(executions, 0);
  } finally { await controller.close(); }
});

test('admission, cancellation, and delivery fail closed unless exactly true', async () => {
  let calls = 0;
  const denied = await setup({ authorize: async (action) => action === 'admission' ? undefined : true, execute: async (r) => { calls++; return verified(r.taskId, 'x'); } });
  try {
    const replies = await denied.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    assert.equal(replies.at(-1), 'Request denied.'); assert.equal(calls, 0);
  } finally { await denied.close(); }
  const withheld = await setup({ authorize: async (action) => action !== 'delivery', execute: async (r) => verified(r.taskId, 'private') });
  try {
    const replies = await withheld.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    assert.equal(replies.at(-1), 'Result withheld by current authorization.');
    assert.ok(!replies.includes('private'));
  } finally { await withheld.close(); }
});

test('incomplete or mismatched bridge evidence is never delivered', async () => {
  for (const makeResult of [
    (id) => ({ ...verified(id, 'secret'), evidence: { execution: 'verified' } }),
    (id) => ({ ...verified('different-task', 'secret') }),
    (id) => ({ ...verified(id, 'secret'), cleanup: { status: 'unverified' } }),
    (id) => ({ ...verified(id, 'secret'), evidence: { ...verified(id, '').evidence, nativeExitCode: 1 } }),
    (id) => ({ ...verified(id, 'secret'), evidence: { ...verified(id, '').evidence, dshSessionId: '' } }),
    (id) => ({ ...verified(id, 'secret'), sandbox: undefined }),
  ]) {
    const host = await setup({ execute: async (request) => makeResult(request.taskId) });
    try {
      const replies = await host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
      assert.equal(replies.at(-1), 'Harness did not provide verified completion evidence.');
      assert.ok(!replies.includes('secret'));
    } finally { await host.close(); }
  }
});

test('result markup is emitted as literal text', async () => {
  const host = await setup({ execute: async (r) => verified(r.taskId, '<at id="other"/>') });
  try {
    const replies = await host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    assert.equal(replies.at(-1), '<at id="other"/>');
  } finally { await host.close(); }
});

test('bounded busy response, cancellation and disposal suppress late output', async () => {
  let signalSeen;
  let finish;
  const host = await setup({ execute: (r, signal) => new Promise((resolve) => { signalSeen = signal; finish = () => resolve(verified(r.taskId, 'late')); }) });
  try {
    const pending = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await waitTick(); await waitTick();
    const result = await host.client(0, 'user-a', 'group-a').receive('isolated-cancel');
    assert.equal(result.at(-1), 'Cancellation requested.');
    assert.equal(signalSeen.aborted, true);
    finish();
    const replies = await pending;
    assert.ok(!replies.includes('late'));
  } finally { await host.close(); }

  let finishDispose;
  let disposalSignal;
  const disposing = await setup({ execute: (r, signal) => new Promise((resolve) => { disposalSignal = signal; finishDispose = () => resolve(verified(r.taskId, 'after-dispose')); }) });
  const pending = disposing.client(0, 'user-a', 'group-a').receive('isolated-summary x');
  await waitTick(); await waitTick();
  disposing.pluginScope.dispose();
  assert.equal(disposalSignal.aborted, true);
  const close = disposing.controller.close();
  finishDispose();
  await close;
  assert.ok(!(await pending).includes('after-dispose'));
});

test('bounded close reports blocked for an abort-ignoring bridge and suppresses its late result', async () => {
  let finish;
  let signalSeen;
  const host = await setup({
    shutdownTimeoutMs: 20,
    execute: (request, signal) => new Promise((resolve) => {
      signalSeen = signal;
      finish = () => resolve(verified(request.taskId, 'late after blocked close'));
    }),
  });
  let pending;
  try {
    pending = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await waitTick(); await waitTick();
    const close = host.controller.close();
    assert.equal(close, host.controller.close());
    assert.equal(signalSeen.aborted, true);
    const result = await close;
    assert.deepEqual(result, { status: 'blocked', pendingCount: 1 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(host.controller.activeCount, 1);
    assert.equal((await host.client(0, 'user-a', 'group-a').receive('isolated-summary again')).at(-1), 'Harness is shutting down.');
    finish();
    assert.ok(!(await pending).includes('late after blocked close'));
    assert.equal(host.controller.activeCount, 0);
    assert.equal(await host.controller.close(), result);
  } finally {
    finish?.();
    if (pending) await pending;
    await host.close();
  }
});

test('bounded close reports a stuck send without claiming it was cancelled', async () => {
  let finishSend;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const host = await setup({
    shutdownTimeoutMs: 20,
    sendMessage: () => new Promise((resolve) => { finishSend = resolve; sendStarted(); }),
  });
  let pending;
  try {
    pending = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await started;
    const close = host.controller.close();
    const result = await close;
    assert.deepEqual(result, { status: 'blocked', pendingCount: 1 });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(host.controller.activeCount, 1);
    assert.equal(await host.controller.close(), result);
    finishSend();
    await pending;
    assert.equal(host.controller.activeCount, 0);
    assert.equal(await host.controller.close(), result);
  } finally {
    finishSend?.();
    if (pending) await pending;
    await host.close();
  }
});

test('a late cancel authorization cannot cancel a task that already completed delivery', async () => {
  let finishTask;
  let allowCancel;
  let cancelStarted;
  let startCancel;
  let deliveryEvidence;
  cancelStarted = new Promise((resolve) => { startCancel = resolve; });
  const host = await setup({
    execute: (request) => new Promise((resolve) => { finishTask = () => resolve(verified(request.taskId, 'sent result')); }),
    authorize: (action, request) => {
      if (action === 'cancel') {
        startCancel();
        return new Promise((resolve) => { allowCancel = resolve; });
      }
      if (action === 'delivery') deliveryEvidence = request.result.evidence;
      return true;
    },
  });
  try {
    const original = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await waitTick(); await waitTick();
    const cancellation = host.client(0, 'user-a', 'group-a').receive('isolated-cancel');
    await cancelStarted;
    finishTask();
    assert.equal((await original).at(-1), 'sent result');
    assert.equal(deliveryEvidence.modelRequestCount, null);
    allowCancel(true);
    assert.equal((await cancellation).at(-1), 'No cancellable task found.');
  } finally {
    allowCancel?.(false);
    await host.close();
  }
});

test('construction rejects missing host authorization', () => {
  const app = new App({});
  assert.throws(() => installKoishiBridge(app, { bridge: { execute() {} } }), /authorize callback required/);
  assert.throws(() => installKoishiBridge(app, { bridge: { execute() {} }, authorize: () => true, shutdownTimeoutMs: 0 }), /shutdownTimeoutMs must be 1..180000/);
  assert.throws(() => installKoishiBridge(app, { bridge: { execute() {} }, authorize: () => true, shutdownTimeoutMs: 180_001 }), /shutdownTimeoutMs must be 1..180000/);
});

test('the installed bridge package rejects at admission before any native call', async () => {
  let nativeCalls = 0;
  const bridge = createHarnessBridge({
    native: { cliPath: '/synthetic/openshell', workspace: 'default', image: 'synthetic:image', policyPath: '/synthetic/policy.yaml', home: '/tmp/synthetic-home', xdgConfigHome: '/tmp/synthetic-xdg' },
    dsh: { patchPath: '/synthetic/patch.yaml' },
    authorizeAdmission: async () => { throw new Error('synthetic admission denial'); },
    authorizeNativeCall: async () => { nativeCalls++; },
    authorizeResult: async () => {},
  });
  const host = await setup({ bridge, authorize: async () => true });
  try {
    const replies = await host.client(0, 'user-a', 'group-a').receive('isolated-summary synthetic');
    assert.equal(replies.at(-1), 'Harness did not provide verified completion evidence.');
    assert.equal(nativeCalls, 0);
  } finally { await host.close(); }
});

test('revocation during execution withholds the result after a successful admission', async () => {
  let allowed = true;
  let complete;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const host = await setup({
    authorize: () => allowed,
    execute: (request) => new Promise((resolve) => {
      complete = () => resolve(verified(request.taskId, 'revoked private result'));
      markStarted();
    }),
  });
  try {
    const pending = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await started;
    allowed = false;
    complete();
    const replies = await pending;
    assert.equal(replies.at(-1), 'Result withheld by current authorization.');
    assert.ok(!replies.includes('revoked private result'));
  } finally { complete?.(); await host.close(); }
});

test('mutating the original bridge result during review cannot replace the reviewed output', async () => {
  let original;
  let approve;
  let markReview;
  const reviewing = new Promise((resolve) => { markReview = resolve; });
  const host = await setup({
    execute: async (request) => (original = verified(request.taskId, 'reviewed output')),
    authorize: (action, request) => {
      if (action !== 'delivery') return true;
      assert.equal(Object.isFrozen(request.result), true);
      assert.equal(Object.isFrozen(request.result.evidence), true);
      markReview();
      return new Promise((resolve) => { approve = resolve; });
    },
  });
  try {
    const pending = host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    await reviewing;
    original.output = 'replacement after review';
    approve(true);
    const replies = await pending;
    assert.equal(replies.at(-1), 'reviewed output');
    assert.ok(!replies.includes('replacement after review'));
  } finally { approve?.(false); await host.close(); }
});

test('a stalled admission times out and a later approval cannot execute the task', async () => {
  let approve;
  let calls = 0;
  const host = await setup({
    authorizeTimeoutMs: 20,
    authorize: () => new Promise((resolve) => { approve = resolve; }),
    execute: async (request) => { calls++; return verified(request.taskId, 'must not run'); },
  });
  try {
    const replies = await host.client(0, 'user-a', 'group-a').receive('isolated-summary x');
    assert.equal(replies.at(-1), 'Request denied.');
    approve(true);
    await waitTick();
    assert.equal(calls, 0);
    assert.equal(host.controller.activeCount, 0);
  } finally { approve?.(false); await host.close(); }
});

test('native adapter referrer metadata is preserved without inventing a guild argument', async () => {
  let session;
  let sentReferrer;
  const app = new App({});
  const bot = new MockBot(app, { selfId: 'referrer-bot' });
  const send = bot.sendMessage.bind(bot);
  bot.sendMessage = (channel, content, referrer, options) => {
    sentReferrer = referrer;
    return send(channel, content, referrer, options);
  };
  app.before('command/execute', (argv) => {
    session = argv.session;
    session.event.referrer = { thread: 'synthetic-thread' };
  });
  const controller = installKoishiBridge(app, {
    bridge: { async execute(request) {
      session.event.referrer.thread = 'changed-after-admission';
      return verified(request.taskId, 'native routing retained');
    } },
    authorize: () => true,
  });
  await app.start();
  try {
    const replies = await bot.client('user-a', 'group-a').receive('isolated-summary x');
    assert.equal(replies.at(-1), 'native routing retained');
    assert.deepEqual(sentReferrer, { thread: 'synthetic-thread' });
  } finally { await controller.close(); }
});

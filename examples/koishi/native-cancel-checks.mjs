import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from '@koishijs/core';
import { MockBot } from '@koishijs/plugin-mock';
import { installKoishiBridge } from './src/index.mjs';
import { CANCEL_RESPONSE_DELAY_MS, cancelEvidenceValid } from './native-cancel-live.mjs';
import { expectedSessionTuple, trustedTaskMatches } from './native-live.mjs';

test('native cancel acceptance gate requires real abort, failed bridge result, fixture abort, and verified cleanup', () => {
  const result = {
    taskId: 'task-1', status: 'failed', failure: { stage: 'exec', code: 'aborted' },
    sandbox: { id: 'native-sandbox-1', name: 'aw-native-cancel', workspace: 'default' },
    cleanup: { status: 'verified' },
    evidence: { cleanup: 'verified', modelRequestCount: null },
  };
  const args = {
    taskId: 'task-1', result, observedResult: result,
    metrics: { synthetic: true, acceptedRequestCount: 1, rejectedOverBudgetCount: 0, lastStatus: 200, completedResponseCount: 0, abortedResponseCount: 1, pendingResponseCount: 0 },
    originReply: 'Request cancelled.', crossGroupReply: 'No cancellable task found.', signalAborted: true, noSummary: true,
  };
  assert.equal(CANCEL_RESPONSE_DELAY_MS, 30_000);
  assert.equal(cancelEvidenceValid(args), true);
  for (const invalid of [
    { ...args, signalAborted: false },
    { ...args, crossGroupReply: 'Cancellation requested.' },
    { ...args, metrics: { ...args.metrics, abortedResponseCount: 0 } },
    { ...args, metrics: { ...args.metrics, completedResponseCount: 1 } },
    { ...args, result: { ...result, cleanup: { status: 'unverified' } } },
    { ...args, result: { ...result, failure: { stage: 'exec', code: 'native_command_failed' } } },
    { ...args, result: { ...result, failure: undefined } },
    { ...args, result: { ...result, sandbox: undefined } },
    { ...args, noSummary: false },
    { ...args, result: { ...result, status: 'completed' } },
  ]) assert.equal(cancelEvidenceValid(invalid), false);
});

async function runMockBotCancel({ allowCancel }) {
  const app = new App({});
  const bot = new MockBot(app, { selfId: 'cancel-check-bot' });
  const sessions = [];
  app.before('command/execute', ({ session }) => { sessions.push(session); });
  let controller;
  let expectedTuple;
  let task;
  let signal;
  let finish;
  let resolveObserved;
  const observed = new Promise((resolve) => { resolveObserved = resolve; });
  const bridge = {
    execute(request, abortSignal) {
      signal = abortSignal;
      return new Promise((resolve) => {
        finish = (result) => { resolveObserved(result); resolve(result); };
        abortSignal.addEventListener('abort', () => finish({
          taskId: request.taskId, status: 'failed',
          cleanup: { status: 'verified' },
          evidence: { execution: 'not-verified', cleanup: 'verified', modelRequestCount: null },
        }), { once: true });
      });
    },
  };
  app.plugin((ctx) => {
    controller = installKoishiBridge(ctx, {
      bridge,
      authorize(action, request) {
        if (action === 'admission') {
          const tuple = expectedSessionTuple(sessions.at(-1));
          expectedTuple ??= tuple;
          if (!tuple || tuple.key !== expectedTuple.key || request.identity.key !== tuple.key) return false;
          task = { taskId: request.taskId, tupleKey: tuple.key, tenantId: tuple.tenantId, actorId: tuple.actorId, allowed: true };
          return true;
        }
        if (action === 'cancel') {
          const tuple = expectedSessionTuple(sessions.at(-1));
          return allowCancel && tuple?.key === expectedTuple?.key && trustedTaskMatches(task, {
            taskId: request.taskId, tenantId: tuple.tenantId, actorId: tuple.actorId,
          });
        }
        if (action === 'delivery') return true;
        return false;
      },
    });
  });
  await app.start();
  return {
    app, bot, controller, observed,
    get task() { return task; },
    get signal() { return signal; },
    get finish() { return finish; },
  };
}

async function waitFor(predicate) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2_000) throw new Error('offline cancellation setup timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('real MockBot dispatch rejects cross-group cancel and allows original-session cancel', async () => {
  const run = await runMockBotCancel({ allowCancel: true });
  try {
    const origin = run.bot.client('cancel-check-user', 'cancel-check-group');
    const other = run.bot.client('cancel-check-user', 'cancel-check-other-group');
    const pending = origin.receive('isolated-summary offline cancellation contract');
    await waitFor(() => run.signal && run.controller.activeCount === 1);
    const cross = await other.receive('isolated-cancel');
    assert.equal(cross.at(-1), 'No cancellable task found.');
    assert.equal(run.signal.aborted, false);
    const cancelled = await run.bot.client('cancel-check-user', 'cancel-check-group').receive('isolated-cancel');
    assert.equal(cancelled.at(-1), 'Cancellation requested.');
    assert.equal(run.signal.aborted, true);
    const replies = await pending;
    assert.equal(replies.at(-1), 'Request cancelled.');
    const result = await run.observed;
    assert.equal(result.status, 'failed');
    assert.equal(run.controller.activeCount, 0);
  } finally {
    const drained = await run.controller.close();
    assert.deepEqual(drained, { status: 'drained', pendingCount: 0 });
  }
});

test('real MockBot dispatch does not treat denied cancellation as an abort', async () => {
  const run = await runMockBotCancel({ allowCancel: false });
  try {
    const origin = run.bot.client('cancel-check-user', 'cancel-check-group');
    const pending = origin.receive('isolated-summary offline cancellation denial');
    await waitFor(() => run.signal && run.controller.activeCount === 1 && run.finish);
    const denied = await run.bot.client('cancel-check-user', 'cancel-check-group').receive('isolated-cancel');
    assert.equal(denied.at(-1), 'Cancellation denied.');
    assert.equal(run.signal.aborted, false);
    const taskId = run.task.taskId;
    run.finish({
      taskId, status: 'completed', output: 'offline completion',
      sandbox: { id: 'offline-id', name: 'offline-name', workspace: 'offline-workspace' },
      cleanup: { status: 'verified' },
      evidence: { execution: 'verified', cleanup: 'verified', nativeExitCode: 0, modelRequestCount: null, dshSessionId: 'offline-session' },
    });
    const replies = await pending;
    assert.equal(replies.at(-1), 'offline completion');
    assert.equal((await run.observed).status, 'completed');
  } finally {
    const drained = await run.controller.close();
    assert.deepEqual(drained, { status: 'drained', pendingCount: 0 });
  }
});

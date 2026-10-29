import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroupActions, type ExecutorRequest } from '../src/server/actions.js';
import { Store } from '../src/server/store.js';

function enableDigest(store: Store, featureId = 'digest') {
  store.setPluginAvailability(featureId, true);
  store.setPluginEnabled(featureId, true);
  const group = store.group('group-a', 'admin-a')!;
  store.putProposal({ id: 'enable-digest', groupId: group.id, creatorId: 'admin-a', baseVersion: group.version,
    before: group.config, candidate: { ...group.config, features: [...group.config.features, featureId] },
    warnings: [], changes: [], text: 'test fixture', status: 'pending', createdAt: new Date().toISOString() });
  assert.equal(store.activateProposal('enable-digest', 'admin-a')?.conflict, false);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('digest executor receives persisted task scope and late completion after revoke is withheld', async () => {
  const store = new Store();
  enableDigest(store);
  const gate = deferred<{ output: string; modelCalls: number }>();
  let sent!: ExecutorRequest;
  const actions = createGroupActions(store, { aiExecutor: async request => { sent = request; return gate.promise; } });
  const pending = actions.runTask('admin-a', 'group-a', {
    input: 'synthetic input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
  });
  while (!sent!) await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.featureId, 'digest');
  assert.equal(sent.taskId.length > 0, true);
  assert.equal(Object.isFrozen(sent), true);
  assert.equal(Object.isFrozen(sent.authorization), true);
  assert.ok(Object.keys(sent).includes('taskId') && Object.keys(sent).includes('tenantId')
    && Object.keys(sent).includes('featureId') && Object.keys(sent).includes('authorization'));
  assert.throws(() => { (sent as { taskId: string }).taskId = 'task-forged'; }, TypeError);
  assert.equal(sent.tenantId, sent.groupId);
  assert.equal(sent.actorId, 'admin-a');
  assert.deepEqual(sent.authorization, store.permissionVersions('group-a', 'digest'));
  assert.equal(sent.audience, 'private');
  store.setPluginEnabled('digest', false);
  gate.resolve({ output: 'late synthetic output', modelCalls: 1 });
  const task = await pending;
  assert.equal(task.id, sent.taskId);
  assert.equal(task.status, 'blocked');
  assert.equal(task.output, '');
  store.close();
});

test('fixed code executor remains separate and keeps its zero-model gate', async () => {
  const store = new Store();
  let seen: ExecutorRequest | undefined;
  const actions = createGroupActions(store, { executor: async request => {
    seen = request;
    return { output: 'https://example.test/path', modelCalls: 0 };
  } });
  const task = await actions.runTask('admin-a', 'group-a', {
    input: 'https://example.test/path', featureId: 'link-cleaner', audience: 'group',
  });
  assert.equal(task.status, 'succeeded');
  assert.equal(task.modelCalls, 0);
  assert.equal(seen?.featureId, 'link-cleaner');
  assert.equal(seen?.taskId, task.id);
  store.close();
});

test('sandbox digest uses its trusted work-plus-cleanup deadline while fixed code keeps its own route', async () => {
  const store = new Store();
  enableDigest(store);
  const actions = createGroupActions(store, {
    sandboxAiTimeoutMs: 25,
    aiExecutor: async (_request, signal) => await new Promise(resolve => {
      signal!.addEventListener('abort', () => resolve({ output: 'late synthetic summary', modelCalls: 1 }), { once: true });
    }),
    executor: async () => ({ output: 'https://example.test/path', modelCalls: 0 }),
  });
  const timedOut = await actions.runTask('admin-a', 'group-a', {
    input: 'synthetic input', featureId: 'digest', audience: 'private', acknowledgeExternalProcessing: true,
  });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.output, '');
  assert.match(timedOut.error!, /可信时间上限/);
  const fixed = await actions.runTask('admin-a', 'group-a', {
    input: 'https://example.test/path', featureId: 'link-cleaner', audience: 'private',
  });
  assert.equal(fixed.status, 'succeeded');
  assert.equal(fixed.modelCalls, 0);
  store.close();
});

test('sandbox assistant shares the configured work and cleanup deadline', async () => {
  const store = new Store();
  enableDigest(store, 'assistant');
  const actions = createGroupActions(store, {
    sandboxAiTimeoutMs: 25,
    assistantExecutor: async (_request, signal) => await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ output: 'late answer', modelCalls: 1, toolCalls: 0 }), 150);
      signal!.addEventListener('abort', () => { clearTimeout(timer); resolve({ output: 'cancelled', modelCalls: 1, toolCalls: 0 }); }, { once: true });
    }),
  });
  try {
    const task = await actions.runTask('admin-a', 'group-a', {
      input: 'Explain recursion', featureId: 'assistant', audience: 'private', acknowledgeExternalProcessing: true,
    });
    assert.equal(task.status, 'failed');
    assert.match(task.error!, /可信时间上限/);
    assert.equal(task.output, '');
  } finally { actions.close(); store.close(); }
});

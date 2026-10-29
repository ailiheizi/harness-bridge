import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Proposal, Task } from '../src/shared.js';
import { buildApp } from '../src/server/app.js';

async function client(app: FastifyInstance, personaId: string) {
  const login = await app.inject({ method: 'GET', url: '/api/me', headers: { host: 'localhost' } });
  let cookie = String(login.headers['set-cookie']).split(';')[0]!;
  let csrf = login.json().csrfToken as string;
  const post = (url: string, payload: Record<string, unknown>) => app.inject({
    method: 'POST', url, payload,
    headers: { host: 'localhost', cookie, origin: 'http://localhost', 'x-csrf-token': csrf },
  });
  if (personaId !== 'admin-a') {
    const changed = await post('/api/demo/session', { personaId });
    assert.equal(changed.statusCode, 200);
    cookie = String(changed.headers['set-cookie']).split(';')[0]!;
    csrf = changed.json().csrfToken as string;
  }
  return {
    post,
    get: (url: string) => app.inject({ method: 'GET', url, headers: { host: 'localhost', cookie } }),
  };
}

type Client = Awaited<ReturnType<typeof client>>;

/** Real HTTP/session/store/actions; only the completed executor and role lookup are controlled. */
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'groupweave-final-delivery-'));
  let enter!: () => void;
  let release!: () => void;
  const finalCheckStarted = new Promise<void>(resolve => { enter = resolve; });
  const finalCheckGate = new Promise<void>(resolve => { release = resolve; });
  let executorFinished = false;
  let held = false;
  let calls = 0;
  const app = await buildApp({
    preview: true, dataDir,
    async executor() {
      calls++; executorFinished = true;
      return { output: 'PRIVATE_FINISHED_CODE_RESULT', modelCalls: 0 };
    },
    async mixedExecutor() {
      calls++; executorFinished = true;
      return { output: 'PRIVATE_FINISHED_MIXED_RESULT', modelCalls: 2, toolCalls: 1 };
    },
    async refreshRole(actorId, groupId) {
      // Only the task's first post-execution lookup waits. Subsequent discovery,
      // cancellation and platform requests remain able to observe the window.
      if (actorId === 'member' && groupId === 'group-a' && executorFinished && !held) {
        held = true; enter(); await finalCheckGate;
      }
    },
  });
  return { app, finalCheckStarted, release, calls: () => calls,
    async close() { release(); await app.close(); await rm(dataDir, { recursive: true, force: true }); },
  };
}

async function enableMixed(admin: Client, platform: Client) {
  assert.equal((await platform.post('/api/platform/plugins/link-brief', { enabled: true })).statusCode, 200);
  const preview = await admin.post('/api/groups/group-a/proposals', {
    baseVersion: 1, config: { features: ['link-cleaner', 'link-brief'] },
  });
  assert.equal(preview.statusCode, 200);
  const proposal = preview.json<Proposal>();
  assert.deepEqual(proposal.warnings, []);
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 200);
}

test('a mixed task remains revocable after execution: dependency stop then restart cannot revive its final delivery', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let pending: ReturnType<Client['post']> | undefined;
  try {
    const admin = await client(f.app, 'admin-a');
    const platform = await client(f.app, 'platform');
    const member = await client(f.app, 'member');
    await enableMixed(admin, platform);
    pending = member.post('/api/groups/group-a/tasks', {
      featureId: 'link-brief', audience: 'private', input: 'https://private.example/a',
      acknowledgeExternalProcessing: true, idempotencyKey: 'final-delivery-mixed',
    });
    await f.finalCheckStarted;
    const active = await member.get('/api/groups/group-a/active-tasks');
    assert.equal(active.statusCode, 200);
    const taskId = active.json<{ tasks: { id: string; featureId: string }[] }>().tasks[0]?.id;
    assert.ok(taskId, 'completed executor still has a cancellable task awaiting final authorization');
    assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: false })).statusCode, 200);
    assert.equal((await platform.post('/api/platform/plugins/link-cleaner', { enabled: true })).statusCode, 200);
    f.release();
    const response = await pending;
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.id, taskId); assert.equal(task.status, 'blocked'); assert.equal(task.output, '');
    assert.equal(f.calls(), 1, 'the revoked finished operation is never replayed');
    assert.equal(f.app.groupweave.store.task(task.id)?.task?.status, 'blocked');
    assert.equal(f.app.groupweave.store.task(task.id)?.task?.output, '');
    assert.deepEqual((await member.get('/api/groups/group-a/active-tasks')).json().tasks, []);
  } finally {
    f.release(); await pending?.catch(() => undefined); await f.close();
  }
});

test('the creator can discover and cancel a completed code operation awaiting final authorization', { timeout: 10_000 }, async () => {
  const f = await fixture();
  let pending: ReturnType<Client['post']> | undefined;
  try {
    const member = await client(f.app, 'member');
    pending = member.post('/api/groups/group-a/tasks', {
      featureId: 'link-cleaner', audience: 'private', input: 'https://private.example/a',
      idempotencyKey: 'final-delivery-cancel',
    });
    await f.finalCheckStarted;
    const active = await member.get('/api/groups/group-a/active-tasks');
    assert.equal(active.statusCode, 200);
    const taskId = active.json<{ tasks: { id: string; featureId: string }[] }>().tasks[0]?.id;
    assert.ok(taskId, 'final delivery is still an active task');
    const cancelled = await member.post(`/api/tasks/${taskId}/cancel`, {});
    assert.equal(cancelled.statusCode, 200); assert.equal(cancelled.json().requested, true);
    f.release();
    const response = await pending;
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.id, taskId); assert.equal(task.status, 'blocked'); assert.equal(task.output, '');
    assert.equal(f.calls(), 1);
    assert.equal(f.app.groupweave.store.task(task.id)?.task?.output, '');
    assert.deepEqual((await member.get('/api/groups/group-a/active-tasks')).json().tasks, []);
  } finally {
    f.release(); await pending?.catch(() => undefined); await f.close();
  }
});

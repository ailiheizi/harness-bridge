import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp, type AppOptions } from '../src/server/app.js';
import type { Me, Task } from '../src/shared.js';

type App = Awaited<ReturnType<typeof buildApp>>;
async function client(app: App, personaId: string) {
  const login = await app.inject({ url: '/api/me' });
  let me = login.json<Me & { csrfToken: string }>();
  let cookie = String(login.headers['set-cookie']).split(';')[0];
  const headers = () => ({ host: 'localhost', origin: 'http://localhost', cookie, 'x-csrf-token': me.csrfToken });
  if (personaId !== 'admin-a') {
    const response = await app.inject({ method: 'POST', url: '/api/demo/session', headers: headers(), payload: { personaId } });
    me = response.json(); cookie = String(response.headers['set-cookie']).split(';')[0];
  }
  return (groupId: string, key: string) => app.inject({ method: 'POST', url: `/api/groups/${groupId}/tasks`, headers: headers(), payload: {
    input: 'https://synthetic.example/a', featureId: 'link-cleaner', audience: 'private', idempotencyKey: key,
  } });
}
function barrier() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}
async function withApp(options: AppOptions, run: (app: App) => Promise<void>) {
  const app = await buildApp({ preview: true, ...options });
  try { await run(app); } finally { await app.close(); }
}

test('admission is per group and service; rejected requests are never reserved or executed', async () => {
  for (const maxActiveTasks of [1, 2]) {
    const entered = barrier(); const release = barrier(); let calls = 0;
    await withApp({ maxActiveTasks, executor: async () => { calls++; entered.open(); await release.ready; return { output: 'safe synthetic result', modelCalls: 0 }; } }, async app => {
      const a = await client(app, 'admin-a'); const b = await client(app, 'admin-b');
      const first = a('group-a', 'first'); await entered.ready;
      assert.equal((await a('group-a', 'another')).statusCode, 429);
      assert.equal((await a('group-a', 'first')).statusCode, 409);
      if (maxActiveTasks === 1) {
        assert.equal((await b('group-b', 'other-group')).statusCode, 429);
        assert.equal(calls, 1);
        release.open(); await first;
        assert.equal((await b('group-b', 'other-group')).json<Task>().status, 'succeeded');
      } else {
        const second = b('group-b', 'other-group');
        // This GET runs after inject dispatch and gives the second handler an event-loop turn.
        await app.inject({ url: '/api/health' });
        release.open();
        assert.equal((await second).json<Task>().status, 'succeeded');
        assert.equal((await first).json<Task>().status, 'succeeded');
        assert.equal(calls, 2);
      }
    });
  }
});

test('timeout requests native cancellation but retains capacity until the actual executor settles', async context => {
  const entered = barrier(); const release = barrier(); let signal: AbortSignal | undefined; let calls = 0;
  await withApp({ maxActiveTasks: 1, executor: async (_request, currentSignal) => {
    calls++; signal = currentSignal; entered.open(); await release.ready;
    return { output: 'late result must not overwrite timeout', modelCalls: 0 };
  } }, async app => {
    const a = await client(app, 'admin-a'); const b = await client(app, 'admin-b');
    context.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const first = a('group-a', 'timed-out'); await entered.ready;
      context.mock.timers.tick(10_001);
      const timedOut = (await first).json<Task>();
      assert.equal(timedOut.status, 'failed'); assert.equal(timedOut.output, '');
      assert.equal(signal?.aborted, true);
      assert.equal((await b('group-b', 'busy')).statusCode, 429);
      assert.equal((await a('group-a', 'timed-out')).json<Task>().id, timedOut.id);
      assert.equal(calls, 1);
      release.open();
      // Flush the actual executor completion, then read persisted timeout evidence.
      await app.inject({ url: '/api/health' });
      assert.equal((await a('group-a', 'timed-out')).json<Task>().output, '');
      assert.equal((await b('group-b', 'busy')).json<Task>().status, 'succeeded');
      assert.equal(calls, 2);
    } finally { release.open(); context.mock.timers.reset(); }
  });
});

test('empty output cannot be recorded as success and failed executions release capacity', async () => {
  let calls = 0;
  await withApp({ maxActiveTasks: 1, executor: async () => { calls++; return { output: calls === 1 ? '   ' : 'verified output', modelCalls: 0 }; } }, async app => {
    const a = await client(app, 'admin-a'); const b = await client(app, 'admin-b');
    assert.equal((await a('group-a', 'empty')).json<Task>().status, 'failed');
    assert.equal((await b('group-b', 'next')).json<Task>().status, 'succeeded');
    assert.equal(calls, 2);
  });
});

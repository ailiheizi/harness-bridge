import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server/app';
import { createNativeExecutor } from '../src/server/native';
import type { Group, Proposal, Task } from '../src/shared';

test('real API → DSH → stored result: preview activation, code evidence and private audience', async () => {
  const executor = createNativeExecutor();
  const app = await buildApp({ preview: true, executor });
  try {
    const login = await app.inject({ method: 'GET', url: '/api/me' });
    let cookie = String(login.headers['set-cookie']).split(';')[0];
    let csrf = login.json().csrfToken;
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload, headers: { cookie, origin: 'http://localhost:80', 'x-csrf-token': csrf } });
    const proposalResponse = await post('/api/groups/group-a/proposals', {
      text: '只在 @ 时回复，使用中文，开启链接整理，去重并排序，最多 2 条。', baseVersion: 1,
    });
    assert.equal(proposalResponse.statusCode, 200);
    const proposal = proposalResponse.json<Proposal>();
    assert.deepEqual(proposal.warnings, []);
    assert.equal((await post(`/api/proposals/${proposal.id}/activate`, {})).statusCode, 200);
    const detail = await app.inject({ method: 'GET', url: '/api/groups/group-a', headers: { cookie } });
    assert.equal(detail.json<{group: Group}>().group.version, 2);
    const response = await post('/api/groups/group-a/tasks', {
      input: 'https://z.example/\nhttps://a.example/\nhttps://z.example/\nhttps://b.example/',
      featureId: 'link-cleaner', audience: 'private', idempotencyKey: 'native-integration',
    });
    assert.equal(response.statusCode, 200);
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded');
    assert.equal(task.configVersion, 2);
    assert.equal(task.modelCalls, 0);
    assert.equal(task.output, '整理结果：2 条链接；超过上限，展示前 2 条\n\n1. https://a.example/\n2. https://b.example/');
    const replay = await post('/api/groups/group-a/tasks', {
      input: 'https://z.example/\nhttps://a.example/\nhttps://z.example/\nhttps://b.example/',
      featureId: 'link-cleaner', audience: 'private', idempotencyKey: 'native-integration',
    });
    assert.equal(replay.json<Task>().id, task.id);
    const other = await app.inject({ method: 'GET', url: '/api/groups/group-b', headers: { cookie } });
    assert.equal(other.statusCode, 404);
    const switchResponse = await post('/api/demo/session', { personaId: 'member' });
    cookie = String(switchResponse.headers['set-cookie']).split(';')[0];
    csrf = switchResponse.json().csrfToken;
    assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${task.id}`, headers: { cookie } })).statusCode, 404);
    const list = await app.inject({ method: 'GET', url: '/api/groups/group-a/tasks', headers: { cookie } });
    assert.deepEqual(list.json().tasks, []);
    const invalid = await post('/api/groups/group-a/tasks', { input: '只有文字，没有链接', featureId: 'link-cleaner', audience: 'private' });
    assert.equal(invalid.json<Task>().status, 'failed');
    assert.equal(invalid.json<Task>().error, '没有找到有效的 HTTP(S) 链接，请输入至少一个完整链接。');
    assert.equal(invalid.json<Task>().modelCalls, 0);
  } finally {
    await app.close();
    await executor.dispose();
  }
});

test('group audience shares only the real result, while raw input is a creator-only field', async () => {
  const executor = createNativeExecutor();
  const app = await buildApp({ preview: true, executor });
  try {
    const login = await app.inject({ method: 'GET', url: '/api/me' });
    let cookie = String(login.headers['set-cookie']).split(';')[0];
    let csrf = login.json().csrfToken;
    const post = (url: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url, payload, headers: { cookie, origin: 'http://localhost:80', 'x-csrf-token': csrf } });
    const raw = 'LOCAL_INPUT_NOTE_ONLY_FOR_CREATOR https://example.com/';
    const response = await post('/api/groups/group-a/tasks', { input: raw, featureId: 'link-cleaner', audience: 'group' });
    const task = response.json<Task>();
    assert.equal(task.status, 'succeeded');
    assert.equal(task.input, raw);
    assert.equal(task.modelCalls, 0);
    const changed = await post('/api/demo/session', { personaId: 'member' });
    cookie = String(changed.headers['set-cookie']).split(';')[0];
    csrf = changed.json().csrfToken;
    for (const url of [`/api/tasks/${task.id}`, '/api/groups/group-a/tasks']) {
      const visible = await app.inject({ method: 'GET', url, headers: { cookie } });
      assert.equal(visible.statusCode, 200);
      assert.equal(visible.body.includes('LOCAL_INPUT_NOTE_ONLY_FOR_CREATOR'), false);
      const item: Task = url.includes('/groups/') ? visible.json().tasks[0] : visible.json();
      assert.equal(item.output, task.output);
      assert.equal(item.input, '');
      assert.equal(item.inputHidden, true);
    }
  } finally {
    await app.close();
    await executor.dispose();
  }
});

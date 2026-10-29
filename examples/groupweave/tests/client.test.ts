import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestScope } from '../src/client/request-scope.js';

test('a delayed private response cannot overwrite a new identity/group scope', async () => {
  const scope = createRequestScope();
  const action = scope.begin()!;
  const oldRequest = action.capture();
  let resolveResponse!: (value: { input: string; output: string }) => void;
  const response = new Promise<{ input: string; output: string }>(resolve => { resolveResponse = resolve; });
  let visible = { identity: 'admin-a', group: 'group-a', input: '', output: '' };
  const pendingCommit = response.then(value => { if (oldRequest()) visible = { ...visible, ...value }; });

  action.transition();
  visible = { identity: 'member', group: 'group-b', input: '', output: '' };
  resolveResponse({ input: 'old private input', output: 'old private result' });
  await pendingCommit;
  assert.deepEqual(visible, { identity: 'member', group: 'group-b', input: '', output: '' });
  assert.equal(action.isCurrent(), true);
  assert.equal(action.finish(), true);
});

test('synchronous action lock rejects reentry and stale finally cannot release its successor', () => {
  const scope = createRequestScope();
  const first = scope.begin()!;
  assert.equal(scope.begin(), undefined);
  const firstResponse = first.capture();
  assert.equal(first.finish(), true);
  const second = scope.begin()!;
  const secondResponse = second.capture();
  assert.equal(firstResponse(), false);
  assert.equal(first.transition()(), false);
  assert.equal(secondResponse(), true);
  assert.equal(first.finish(), false);
  assert.equal(scope.begin(), undefined);
  assert.equal(second.isCurrent(), true);
  assert.equal(second.finish(), true);
});

test('old request notices/errors expire on transition while current responses remain usable', () => {
  const scope = createRequestScope();
  const action = scope.begin()!;
  const oldRequest = action.capture();
  const currentRequest = action.transition();
  let message = '';
  if (oldRequest()) message = 'old private action failed';
  assert.equal(message, '');
  if (currentRequest()) message = 'current state';
  assert.equal(message, 'current state');
  action.finish();
  assert.equal(currentRequest(), false);
});

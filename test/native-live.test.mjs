import test from 'node:test';
import assert from 'node:assert/strict';
import { preparedConfigValid, requiredReceipt, sanitizedFailure } from './native-live.mjs';

const request = { taskId: 'synthetic-task' };
const result = { sandbox: { id: 'native-1' }, evidence: { dshSessionId: 'session-1' } };
const receipt = {
  synthetic: true,
  verified: true,
  taskId: 'synthetic-task',
  sandboxId: 'native-1',
  dshSessionId: 'session-1',
  model: { requestCount: 2, completed: true, secondRequestDenied: true, toolCalls: ['skill'], skillContentVerified: true },
};

test('native live caller validates bridge options after the trusted fixture prepares them', () => {
  const config = {
    request: { taskId: 'task-1', tenantId: 'tenant', actorId: 'actor', prompt: 'synthetic', skillPath: '/private/skill/SKILL.md' },
    bridgeOptions: null,
  };
  assert.equal(preparedConfigValid(config), false);
  config.bridgeOptions = {
    native: { cliPath: '/usr/local/bin/openshell', workspace: 'default', policyPath: '/private/policy.yml', home: '/private/home', xdgConfigHome: '/private/xdg' },
    dsh: { patchPath: '/private/dsh-patch.yml' },
  };
  assert.equal(preparedConfigValid(config), true);
  assert.equal(preparedConfigValid({ ...config, request: { ...config.request, skillPath: 'relative/SKILL.md' } }), false);
});

test('native live failure diagnostics preserve safe stage/code and fixture codes only', () => {
  assert.deepEqual(sanitizedFailure(null, { failure: { stage: 'create', code: 'native_create_failed' } }), {
    stage: 'create', code: 'native_create_failed',
  });
  assert.deepEqual(sanitizedFailure(new Error('hidden details'), null), {
    stage: 'acceptance', code: 'native_live_acceptance_failed',
  });
  assert.deepEqual(sanitizedFailure(new Error('native_fixture_provider_list_failed'), null), {
    stage: 'fixture', code: 'native_fixture_provider_list_failed',
  });
  const secret = 'Bearer SECRET-SENTINEL prompt transcript provider env';
  const arbitrary = new Error(secret);
  arbitrary.stack = `Error: ${secret}\n${secret}`;
  const serialized = JSON.stringify(sanitizedFailure(arbitrary, {
    failure: { stage: `exec ${secret}`, code: `oops_${secret}` },
    output: secret,
    provider: secret,
    env: { token: secret },
    stdout: secret,
    stderr: secret,
  }));
  assert.equal(serialized, JSON.stringify({ stage: 'acceptance', code: 'native_live_acceptance_failed' }));
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('SECRET-SENTINEL'), false);
});

test('native live receipt requires two synthetic model turns bound to task, sandbox, and DSH session', () => {
  assert.equal(requiredReceipt(receipt, request, result), true);
  assert.equal(requiredReceipt({ ...receipt, sandboxId: 'native-other' }, request, result), false);
  assert.equal(requiredReceipt({ ...receipt, taskId: 'other-task' }, request, result), false);
  assert.equal(requiredReceipt({ ...receipt, dshSessionId: 'other-session' }, request, result), false);
  assert.equal(requiredReceipt({ ...receipt, model: { ...receipt.model, requestCount: 1 } }, request, result), false);
  assert.equal(requiredReceipt({ ...receipt, model: { ...receipt.model, secondRequestDenied: false } }, request, result), false);
});

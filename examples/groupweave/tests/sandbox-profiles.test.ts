import assert from 'node:assert/strict';
import test from 'node:test';
import { createProfileBinding } from '../src/server/sandbox-profiles.js';
import type { SandboxBindingFactory, SandboxBindingModule } from '../src/server/sandbox-wiring.js';
import type { TrustedSandboxAiRequest } from '../src/server/sandbox-ai.js';

test('a selected configured model is used once, while unknown IDs cannot fall back', async () => {
  const calls: string[] = [];
  const closes: string[] = [];
  const source = (id: string): SandboxBindingFactory => ({
    async createTaskBinding(request) {
      calls.push(`${id}:${request.actorId}:${request.taskId}`);
      return { binding: { dsh: { patchPath: `/protected/${id}.json` } } as SandboxBindingModule,
        async close() { closes.push(id); } };
    },
    async dispose() { closes.push(`dispose:${id}`); },
  });
  const binding = createProfileBinding(new Map([['default', source('default')], ['fast', source('fast')]]));
  const request = { taskId: 'task-1', actorId: 'actor-1', options: { language: 'zh', modelProfileId: 'fast' } } as TrustedSandboxAiRequest;
  const lease = await binding.createTaskBinding(request, new AbortController().signal);
  assert.deepEqual(calls, ['fast:actor-1:task-1']);
  assert.equal(lease.binding.dsh.patchPath, '/protected/fast.json');
  await lease.close();
  await assert.rejects(binding.createTaskBinding({ ...request, options: { ...request.options, modelProfileId: 'unknown' } } as TrustedSandboxAiRequest,
    new AbortController().signal), /MODEL_PROFILE_UNAVAILABLE/);
  assert.equal(calls.length, 1);
  await binding.dispose?.();
  assert.deepEqual(closes, ['fast', 'dispose:default', 'dispose:fast']);
});

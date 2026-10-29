import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TrustedSandboxAiRequest } from '../src/server/sandbox-ai.js';
import { createStoreAuthorizedSandboxExecutor, createStoreSandboxAuthorization, loadSandboxBindingModule, sandboxTaskTimeoutMs } from '../src/server/sandbox-wiring.js';
import { Store } from '../src/server/store.js';
import type { Task } from '../src/shared.js';

function activatedStore() {
  const store = new Store();
  store.setPluginAvailability('digest', true);
  store.setPluginEnabled('digest', true);
  const group = store.group('group-a', 'admin-a')!;
  store.putProposal({ id: 'enable-digest', groupId: group.id, creatorId: 'admin-a', baseVersion: group.version,
    before: group.config, candidate: { ...group.config, features: [...group.config.features, 'digest'] },
    warnings: [], changes: [], text: 'test fixture', status: 'pending', createdAt: new Date().toISOString() });
  store.activateProposal('enable-digest', 'admin-a');
  return store;
}
function taskRequest(store: Store, persisted: { featureId?: string; authorization?: { platformVersion: number; groupVersion: number } } = {}, taskId = 'task-wire-1'): TrustedSandboxAiRequest {
  const authorization = store.permissionVersions('group-a', 'digest');
  const task: Task = { id: taskId, groupId: 'group-a', creatorId: 'admin-a', featureId: persisted.featureId ?? 'digest',
    audience: 'private', configVersion: 2, createdAt: new Date().toISOString(), durationMs: 0,
    modelCalls: 0, authorization: persisted.authorization ?? authorization, input: 'synthetic input', output: '', status: 'blocked' };
  store.reserveTask(task, undefined, 'synthetic-hash');
  return { taskId: task.id, tenantId: task.groupId, featureId: 'digest', actorId: task.creatorId,
    groupId: task.groupId, input: task.input, options: { language: 'en' }, audience: task.audience,
    authorized: true, authorization };
}

test('store-backed sandbox authorization binds reservation and rejects revoked feature before native exec', async () => {
  const store = activatedStore();
  let roleRefreshes = 0;
  const authorization = createStoreSandboxAuthorization({ store: () => store,
    async refreshRole() { roleRefreshes++; } });
  const request = taskRequest(store);
  const binding = await authorization.resolveTask(request);
  await authorization.authorizeAdmission(binding, { request: {
    taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId, prompt: 'synthetic',
    binding: { groupId: request.groupId, featureId: request.featureId, audience: request.audience,
      authorization: request.authorization },
  }, providerNames: ['fixture'] });
  assert.equal(roleRefreshes, 2);
  const stored = store.task(request.taskId)!;
  assert.equal(stored.featureId, 'digest');
  assert.deepEqual(stored.authorization, request.authorization);
  store.setPluginEnabled('digest', false);
  await assert.rejects(Promise.resolve().then(() => authorization.authorizeNativeCall(binding, { operation: 'exec', taskId: request.taskId,
    tenantId: request.tenantId, actorId: request.actorId,
    sandbox: { id: 'sandbox-synthetic', name: 'sandbox-synthetic', workspace: '/workspace' } })));
  assert.equal(roleRefreshes, 3);
  store.close();
});

test('store authorization rejects a pending reservation for a different feature or captured version', async () => {
  for (const persisted of [
    { featureId: 'link-cleaner' },
    { authorization: { platformVersion: 99, groupVersion: 8 } },
  ]) {
    const store = activatedStore();
    const request = taskRequest(store, persisted);
    const authorization = createStoreSandboxAuthorization({ store: () => store });
    await assert.rejects(authorization.resolveTask(request));
    store.close();
  }
});

test('link-brief rechecks the captured link-cleaner permission before model and result stages', async () => {
  const store = activatedStore();
  store.setPluginAvailability('link-cleaner', true);
  store.setPluginEnabled('link-cleaner', true);
  store.setPluginAvailability('link-brief', true);
  store.setPluginEnabled('link-brief', true);
  const group = store.group('group-a', 'admin-a')!;
  const proposal = { id: 'enable-link-brief', groupId: group.id, creatorId: 'admin-a', baseVersion: group.version,
    before: group.config, candidate: { ...group.config, features: ['link-cleaner', 'link-brief'] },
    warnings: [], changes: [], text: 'test fixture', status: 'pending' as const, createdAt: new Date().toISOString() };
  store.putProposal(proposal);
  store.activateProposal(proposal.id, 'admin-a');
  const authorization = { ...store.permissionVersions(group.id, 'link-brief'),
    codePlatformVersion: store.permissionVersions(group.id, 'link-cleaner').platformVersion,
    codeGroupVersion: store.permissionVersions(group.id, 'link-cleaner').groupVersion };
  const task: Task = { id: 'task-link-brief', groupId: group.id, creatorId: 'admin-a', featureId: 'link-brief', audience: 'group',
    configVersion: group.version, createdAt: new Date().toISOString(), durationMs: 0, modelCalls: 0,
    authorization, input: 'https://example.test', output: '', status: 'blocked' };
  store.reserveTask(task, undefined, 'link-brief-hash');
  const request: TrustedSandboxAiRequest = { taskId: task.id, tenantId: group.id, groupId: group.id,
    actorId: task.creatorId, featureId: 'link-brief', audience: 'group', authorized: true,
    input: task.input, options: { language: 'en', deduplicate: true, sort: false, maxItems: 20 }, authorization };
  const sandboxAuthorization = createStoreSandboxAuthorization({ store: () => store });
  const binding = await sandboxAuthorization.resolveTask(request);
  store.setPluginEnabled('link-cleaner', false);
  await assert.rejects(Promise.resolve().then(() => sandboxAuthorization.authorizeNativeCall(binding, {
    operation: 'exec', taskId: task.id, tenantId: group.id, actorId: task.creatorId,
    sandbox: { id: 'sandbox-link-brief', name: 'sandbox-link-brief', workspace: '/workspace' },
  })));
  store.close();
});

test('deployment module loader accepts only absolute protected module sources with budget and meter hooks', async () => {
  const root = await mkdtemp(join(process.cwd(), '.sandbox-binding-test-'));
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'groupweave-cli-roots-')));
  try {
    const privateHome = join(privateRoot, 'cli-home');
    const privateXdg = join(privateRoot, 'xdg-config');
    await mkdir(privateHome, { mode: 0o700 });
    await mkdir(privateXdg, { mode: 0o700 });
    await chmod(privateHome, 0o700);
    await chmod(privateXdg, 0o700);
    const source = (image = `sha256:${'a'.repeat(64)}`, home = privateHome, xdg = privateXdg, workspace = 'default') => `export default {
      native: { cliPath:'/opt/openshell', workspace:${JSON.stringify(workspace)}, image:${JSON.stringify(image)}, policyPath:'/etc/app/policy.json', home:${JSON.stringify(home)}, xdgConfigHome:${JSON.stringify(xdg)}, providers:['approved'] },
      dsh: { patchPath:'/etc/app/headless.patch' },
      modelAccounting: { async authorizeBudget(){ return undefined }, async read(){ return undefined } }
    };`;
    const writeBinding = async (name: string, contents: string) => {
      const target = join(root, name);
      await writeFile(target, contents);
      await chmod(target, 0o600);
      return target;
    };
    const path = join(root, 'binding.mjs');
    await writeFile(path, source());
    await chmod(path, 0o600);
    const config = await loadSandboxBindingModule(path);
    assert.ok('native' in config);
    if (!('native' in config)) throw new Error('expected static binding');
    assert.deepEqual(config.native.providers, ['approved']);
    assert.equal(config.native.workspace, 'default');
    const repositoryDigest = await writeBinding('repository-digest.mjs', source(`registry.example/team/model@sha256:${'b'.repeat(64)}`));
    const digestBinding = await loadSandboxBindingModule(repositoryDigest);
    assert.ok('native' in digestBinding);
    if (!('native' in digestBinding)) throw new Error('expected static binding');
    assert.equal(digestBinding.native.image,
      `registry.example/team/model@sha256:${'b'.repeat(64)}`);
    assert.equal(sandboxTaskTimeoutMs(config), 185_000);
    assert.equal(sandboxTaskTimeoutMs({ limits: { totalTimeoutMs: 240_000 } }), 305_000);
    assert.throws(() => sandboxTaskTimeoutMs({ limits: { totalTimeoutMs: 300_001 } }), /SANDBOX_TOTAL_TIMEOUT_INVALID/);
    const factoryPath = await writeBinding('factory.mjs', `export default { limits: { totalTimeoutMs: 90000 }, async createTaskBinding() { throw new Error('loader must not prepare a task'); }, async dispose() {} };`);
    const loadedFactory = await loadSandboxBindingModule(factoryPath);
    assert.ok('createTaskBinding' in loadedFactory);
    assert.equal(sandboxTaskTimeoutMs(loadedFactory), 155_000);
    await assert.rejects(loadSandboxBindingModule('relative/binding.mjs'), /SANDBOX_BINDING_MODULE_PATH_INVALID/);
    await assert.rejects(loadSandboxBindingModule(join(root, 'missing.mjs')));
    const taggedImage = await writeBinding('tagged-image.mjs', source('registry.example/model:latest'));
    await assert.rejects(loadSandboxBindingModule(taggedImage), /SANDBOX_BINDING_MODULE_INVALID/);
    const absoluteWorkspace = await writeBinding('absolute-workspace.mjs', source(undefined, undefined, undefined, '/workspace'));
    await assert.rejects(loadSandboxBindingModule(absoluteWorkspace), /SANDBOX_BINDING_MODULE_INVALID/);
    const homeRoot = await writeBinding('operator-home.mjs', source(undefined, homedir()));
    await assert.rejects(loadSandboxBindingModule(homeRoot), /SANDBOX_CLI_ROOT_UNTRUSTED/);
    const publicRoot = join(root, 'public-root');
    await mkdir(publicRoot, { mode: 0o755 });
    await chmod(publicRoot, 0o755);
    const publicMode = await writeBinding('public-mode.mjs', source(undefined, publicRoot));
    await assert.rejects(loadSandboxBindingModule(publicMode), /SANDBOX_CLI_ROOT_UNTRUSTED/);
    const homeLink = join(root, 'home-link');
    await symlink(privateHome, homeLink);
    const symlinkRoot = await writeBinding('symlink-root.mjs', source(undefined, homeLink));
    await assert.rejects(loadSandboxBindingModule(symlinkRoot), /SANDBOX_CLI_ROOT_UNTRUSTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test('protected binding factory prepares one private binding per authorized task and closes each lease', async () => {
  const store = activatedStore();
  const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'groupweave-factory-roots-')));
  const privateHome = join(privateRoot, 'cli-home');
  const privateXdg = join(privateRoot, 'xdg-config');
  await mkdir(privateHome, { mode: 0o700 });
  await mkdir(privateXdg, { mode: 0o700 });
  await chmod(privateHome, 0o700);
  await chmod(privateXdg, 0o700);
  const calls: string[][] = [];
  const closed: string[] = [];
  const factory = {
    async createTaskBinding(request: TrustedSandboxAiRequest) {
      const provider = `provider-${request.taskId}`;
      return {
        binding: {
          native: { cliPath: '/opt/openshell', workspace: 'default', image: `sha256:${'a'.repeat(64)}`,
            policyPath: '/etc/app/policy.json', home: privateHome, xdgConfigHome: privateXdg, providers: [provider] },
          dsh: { patchPath: '/etc/app/headless.patch' },
          modelAccounting: {
            async authorizeBudget(context: any) { return { ...context, admissionId: 'admission', source: 'fixture', verified: true as const }; },
            async read(context: any) { return { ...context, modelCalls: 1, usage: undefined, source: 'fixture', verified: true as const }; },
          },
        },
        async close() { closed.push(request.taskId); },
      };
    },
  };
  const executor = createStoreAuthorizedSandboxExecutor(factory as any, { store: () => store }, {
    createBridge(options) {
      calls.push([...options.native.providers!]);
      return { async execute(request, signal) {
        const binding = { taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId,
          groupId: 'group-a', featureId: 'digest', audience: 'private', authorization: store.permissionVersions('group-a', 'digest') };
        await options.authorizeAdmission({ request, providerNames: options.native.providers! });
        const sandbox = { id: `sandbox-${request.taskId}`, name: `sandbox-${request.taskId}`, workspace: options.native.workspace };
        await options.authorizeNativeCall({ operation: 'exec', taskId: request.taskId, tenantId: request.tenantId, actorId: request.actorId, sandbox });
        const result = { taskId: request.taskId, status: 'completed' as const, output: 'ok', sandbox,
          cleanup: { status: 'verified' as const },
          evidence: { execution: 'verified' as const, cleanup: 'verified' as const, dshSessionId: `dsh-${request.taskId}`, nativeExitCode: 0 as const, toolCallCount: 0, modelRequestCount: null } };
        await options.authorizeResult({ request, result });
        signal?.throwIfAborted();
        return result;
      } };
    },
  });
  try {
    const first = taskRequest(store);
    const second = taskRequest(store, {}, 'task-wire-2');
    const [left, right] = await Promise.all([executor.execute(first), executor.execute(second)]);
    assert.equal(left.output, 'ok');
    assert.equal(right.output, 'ok');
    assert.deepEqual(calls.sort(), [['provider-task-wire-1'], ['provider-task-wire-2']]);
    assert.deepEqual(closed.sort(), ['task-wire-1', 'task-wire-2']);
  } finally {
    await executor.dispose();
    store.close();
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test('protected binding factory is not invoked when current task authorization is denied', async () => {
  const store = activatedStore();
  const request = taskRequest(store);
  let preparations = 0;
  const factory = { async createTaskBinding() { preparations++; throw new Error('must not prepare'); } };
  const executor = createStoreAuthorizedSandboxExecutor(factory as any, { store: () => store });
  store.setPluginEnabled('digest', false);
  await assert.rejects(executor.execute(request));
  assert.equal(preparations, 0);
  await executor.dispose();
  store.close();
});

test('prepared lease closes when cancellation or task execution fails', async () => {
  for (const mode of ['cancel', 'execution-error'] as const) {
    const store = activatedStore();
    const privateRoot = await realpath(await mkdtemp(join(tmpdir(), 'groupweave-lease-roots-')));
    const privateHome = join(privateRoot, 'cli-home');
    const privateXdg = join(privateRoot, 'xdg-config');
    await mkdir(privateHome, { mode: 0o700 });
    await mkdir(privateXdg, { mode: 0o700 });
    await chmod(privateHome, 0o700);
    await chmod(privateXdg, 0o700);
    let closed = 0;
    const controller = new AbortController();
    const factory = { async createTaskBinding(_request: TrustedSandboxAiRequest, signal: AbortSignal) {
      if (mode === 'cancel') {
        setImmediate(() => controller.abort(new Error('cancelled')));
        await new Promise(resolve => setImmediate(resolve));
      }
      return {
        binding: {
          native: { cliPath: '/opt/openshell', workspace: 'default', image: `sha256:${'a'.repeat(64)}`,
            policyPath: '/etc/app/policy.json', home: privateHome, xdgConfigHome: privateXdg, providers: ['approved'] },
          dsh: { patchPath: '/etc/app/headless.patch' },
          modelAccounting: { async authorizeBudget() { return undefined; }, async read() { return undefined; } },
        },
        async close() { closed++; },
      };
    } };
    const executor = createStoreAuthorizedSandboxExecutor(factory as any, { store: () => store }, {
      createBridge() { if (mode === 'execution-error') throw new Error('fixture failure'); throw new Error('must not create bridge after cancellation'); },
    });
    try {
      const request = taskRequest(store);
      if (mode === 'cancel') await assert.rejects(executor.execute(request, controller.signal));
      else await assert.rejects(executor.execute(request));
      assert.equal(closed, 1);
    } finally {
      await executor.dispose();
      store.close();
      await rm(privateRoot, { recursive: true, force: true });
    }
  }
});

import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, dirname, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Store } from './store.js';
import {
  createSandboxAiExecutor,
  type SandboxAiAuthorization,
  type SandboxAiBridgeOptions,
  type SandboxAiDependencies,
  type SandboxModelAccountingReader,
  type SandboxTaskBinding,
  type TrustedSandboxAiRequest,
} from './sandbox-ai.js';

export interface SandboxBindingModule {
  native: SandboxAiBridgeOptions['native'];
  dsh: SandboxAiBridgeOptions['dsh'];
  limits?: SandboxAiBridgeOptions['limits'];
  /** Must return real, task+instance-bound budget and usage receipts from a trusted route. */
  modelAccounting: SandboxModelAccountingReader;
}

export interface SandboxTaskBindingLease {
  binding: SandboxBindingModule;
  close(): Promise<void>;
}

/** Protected deployment binding that prepares credentials/providers per trusted task. */
export interface SandboxBindingFactory {
  limits?: SandboxAiBridgeOptions['limits'];
  createTaskBinding(request: TrustedSandboxAiRequest, signal: AbortSignal): Promise<SandboxTaskBindingLease>;
  dispose?(): Promise<void>;
}

export type SandboxBindingSource = SandboxBindingModule | SandboxBindingFactory;

export interface SandboxStoreAccess {
  store(): Store;
  refreshRole?(actorId: string, groupId: string): Promise<void>;
}

function validBindingModule(value: unknown): value is SandboxBindingModule {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<SandboxBindingModule>;
  return !!config.native && !!config.dsh
    && typeof config.native.cliPath === 'string' && isAbsolute(config.native.cliPath)
    && typeof config.native.workspace === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.native.workspace)
    && typeof config.native.image === 'string' && /^(?:[A-Za-z0-9][A-Za-z0-9._:/-]*@)?sha256:[a-f0-9]{64}$/.test(config.native.image)
    && typeof config.native.policyPath === 'string' && isAbsolute(config.native.policyPath)
    && typeof config.native.home === 'string' && isAbsolute(config.native.home)
    && typeof config.native.xdgConfigHome === 'string' && isAbsolute(config.native.xdgConfigHome)
    && Array.isArray(config.native.providers) && config.native.providers.length > 0
    && typeof config.dsh.patchPath === 'string' && isAbsolute(config.dsh.patchPath)
    && typeof config.modelAccounting?.authorizeBudget === 'function'
    && typeof config.modelAccounting?.read === 'function';
}

function validBindingFactory(value: unknown): value is SandboxBindingFactory {
  if (!value || typeof value !== 'object') return false;
  const factory = value as Partial<SandboxBindingFactory>;
  return typeof factory.createTaskBinding === 'function'
    && (factory.dispose === undefined || typeof factory.dispose === 'function');
}

function isBindingFactory(value: SandboxBindingSource): value is SandboxBindingFactory {
  return 'createTaskBinding' in value && typeof value.createTaskBinding === 'function';
}

function containsPath(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

async function validatePrivateCliRoot(path: string): Promise<void> {
  const resolved = resolve(path);
  const forbiddenRoots = ['/root', '/home/node', homedir(), process.env.HOME].filter((root): root is string => Boolean(root));
  if (forbiddenRoots.some(root => containsPath(root, resolved))) throw new Error('SANDBOX_CLI_ROOT_UNTRUSTED');
  const canonical = await realpath(path);
  const metadata = await lstat(path);
  if (canonical !== resolved || metadata.isSymbolicLink() || !metadata.isDirectory()
    || (metadata.mode & 0o777) !== 0o700
    || typeof process.getuid !== 'function' || metadata.uid !== process.getuid()) {
    throw new Error('SANDBOX_CLI_ROOT_UNTRUSTED');
  }
}

/** Loads only trusted deployment code; a request or Skill cannot choose this module. */
export async function loadSandboxBindingModule(modulePath: string): Promise<SandboxBindingSource> {
  if (!isAbsolute(modulePath) || !modulePath.endsWith('.mjs')) throw new Error('SANDBOX_BINDING_MODULE_PATH_INVALID');
  const file = await realpath(modulePath);
  const target = await lstat(file);
  if (!target.isFile() || (target.mode & 0o022) !== 0) throw new Error('SANDBOX_BINDING_MODULE_UNTRUSTED');
  if (typeof process.getuid === 'function' && target.uid !== process.getuid() && target.uid !== 0) {
    throw new Error('SANDBOX_BINDING_MODULE_UNTRUSTED');
  }
  const root = parse(file).root;
  let parent = dirname(file);
  while (parent !== root) {
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && metadata.uid !== process.getuid() && metadata.uid !== 0)) {
      throw new Error('SANDBOX_BINDING_MODULE_UNTRUSTED');
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const loaded = await import(pathToFileURL(file).href);
  const config = loaded.default ?? loaded.binding;
  if (validBindingFactory(config)) return config;
  if (!validBindingModule(config)) throw new Error('SANDBOX_BINDING_MODULE_INVALID');
  if (resolve(config.native.home) === resolve(config.native.xdgConfigHome)
    || containsPath(config.native.home, config.native.xdgConfigHome)
    || containsPath(config.native.xdgConfigHome, config.native.home)) throw new Error('SANDBOX_CLI_ROOT_UNTRUSTED');
  await validatePrivateCliRoot(config.native.home);
  await validatePrivateCliRoot(config.native.xdgConfigHome);
  return config;
}

function bindingFromRequest(request: TrustedSandboxAiRequest): SandboxTaskBinding {
  return {
    taskId: request.taskId,
    tenantId: request.tenantId,
    groupId: request.groupId,
    actorId: request.actorId,
    featureId: request.featureId,
    audience: request.audience,
    authorization: { ...request.authorization },
  };
}

/** Current app authorization is checked before admission, each business native call, and result release. */
export function createStoreAuthorizedSandboxExecutor(
  module: SandboxBindingSource,
  access: SandboxStoreAccess,
  dependencies?: SandboxAiDependencies,
) {
  const authorization = createStoreSandboxAuthorization(access);
  if (!isBindingFactory(module)) return createSandboxAiExecutor(module, authorization, { ...dependencies, modelAccounting: module.modelAccounting });
  const factory = module;

  let closed = false;
  let disposePromise: Promise<void> | undefined;
  const controllers = new Set<AbortController>();
  const active = new Set<Promise<Awaited<ReturnType<ReturnType<typeof createSandboxAiExecutor>['execute']>>>>();

  function snapshot(request: TrustedSandboxAiRequest): TrustedSandboxAiRequest {
    return Object.freeze({ ...request,
      options: Object.freeze({ ...request.options,
        ...(request.options.conversation ? { conversation: Object.freeze(request.options.conversation.map(message => Object.freeze({ ...message }))) } : {}),
      }),
      authorization: Object.freeze({ ...request.authorization }),
    }) as TrustedSandboxAiRequest;
  }

  async function validateTaskModule(value: unknown): Promise<SandboxBindingModule> {
    if (!validBindingModule(value)) throw new Error('SANDBOX_BINDING_MODULE_INVALID');
    if (resolve(value.native.home) === resolve(value.native.xdgConfigHome)
      || containsPath(value.native.home, value.native.xdgConfigHome)
      || containsPath(value.native.xdgConfigHome, value.native.home)) throw new Error('SANDBOX_CLI_ROOT_UNTRUSTED');
    await validatePrivateCliRoot(value.native.home);
    await validatePrivateCliRoot(value.native.xdgConfigHome);
    const native = Object.freeze({ ...value.native, providers: Object.freeze([...value.native.providers!]) });
    return Object.freeze({ ...value, native, dsh: Object.freeze({ ...value.dsh }),
      limits: value.limits ? Object.freeze({ ...value.limits })
        : factory.limits ? Object.freeze({ ...factory.limits }) : undefined,
      modelAccounting: Object.freeze({ ...value.modelAccounting }) }) as SandboxBindingModule;
  }

  async function run(request: TrustedSandboxAiRequest, signal: AbortSignal): Promise<Awaited<ReturnType<ReturnType<typeof createSandboxAiExecutor>['execute']>>> {
    if (closed) throw new Error('SANDBOX_EXECUTOR_CLOSED');
    signal.throwIfAborted();
    const trustedRequest = snapshot(request);
    const resolved = await authorization.resolveTask(trustedRequest);
    signal.throwIfAborted();
    if (resolved.taskId !== trustedRequest.taskId || resolved.tenantId !== trustedRequest.tenantId
      || resolved.groupId !== trustedRequest.groupId || resolved.actorId !== trustedRequest.actorId
      || resolved.featureId !== trustedRequest.featureId || resolved.audience !== trustedRequest.audience
      || resolved.authorization.platformVersion !== trustedRequest.authorization.platformVersion
      || resolved.authorization.groupVersion !== trustedRequest.authorization.groupVersion
      || resolved.authorization.codePlatformVersion !== trustedRequest.authorization.codePlatformVersion
      || resolved.authorization.codeGroupVersion !== trustedRequest.authorization.codeGroupVersion) {
      throw new Error('SANDBOX_TASK_BINDING_INVALID');
    }
    let lease: SandboxTaskBindingLease | undefined;
    let taskExecutor: ReturnType<typeof createSandboxAiExecutor> | undefined;
    try {
      lease = await factory.createTaskBinding(trustedRequest, signal);
      if (signal.aborted) throw signal.reason ?? new Error('SANDBOX_CANCELLED');
      const taskModule = await validateTaskModule(lease?.binding);
      taskExecutor = createSandboxAiExecutor(taskModule, authorization, { ...dependencies, modelAccounting: taskModule.modelAccounting });
      return await taskExecutor.execute(trustedRequest, signal);
    } finally {
      try { await taskExecutor?.dispose(); }
      finally { await lease?.close(); }
    }
  }

  return {
    execute(request: TrustedSandboxAiRequest, callerSignal?: AbortSignal) {
      const controller = new AbortController();
      controllers.add(controller);
      const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
      const pending = run(request, signal);
      active.add(pending);
      void pending.finally(() => { active.delete(pending); controllers.delete(controller); }).catch(() => undefined);
      return pending;
    },
    async dispose() {
      disposePromise ??= (async () => {
        closed = true;
        for (const controller of controllers) controller.abort(new Error('Sandbox AI executor disposed.'));
        await Promise.allSettled([...active]);
        await factory.dispose?.();
      })();
      await disposePromise;
    },
  };
}

export function createStoreSandboxAuthorization(access: SandboxStoreAccess): SandboxAiAuthorization {
  const checkCurrent = async (binding: SandboxTaskBinding) => {
    await access.refreshRole?.(binding.actorId, binding.groupId);
    const store = access.store();
    const group = store.group(binding.groupId, binding.actorId);
    const plugin = store.plugin(binding.featureId);
    const reservation = store.task(binding.taskId);
    const versions = store.permissionVersions(binding.groupId, binding.featureId);
    const code = binding.featureId === 'link-brief' ? store.plugin('link-cleaner') : undefined;
    const codeVersions = binding.featureId === 'link-brief' ? store.permissionVersions(binding.groupId, 'link-cleaner') : undefined;
    if (!group || !plugin?.enabled || !plugin.available || !group.config.features.includes(binding.featureId)
      || versions.platformVersion !== binding.authorization.platformVersion
      || versions.groupVersion !== binding.authorization.groupVersion
      || !reservation?.pending || reservation.groupId !== binding.groupId
      || reservation.creatorId !== binding.actorId || reservation.audience !== binding.audience
      || reservation.featureId !== binding.featureId
      || reservation.authorization?.platformVersion !== binding.authorization.platformVersion
      || reservation.authorization?.groupVersion !== binding.authorization.groupVersion
      || (binding.featureId === 'link-brief' && (!group.config.features.includes('link-cleaner')
        || !code?.enabled || !code.available
        || codeVersions?.platformVersion !== binding.authorization.codePlatformVersion
        || codeVersions?.groupVersion !== binding.authorization.codeGroupVersion
        || reservation.authorization?.codePlatformVersion !== binding.authorization.codePlatformVersion
        || reservation.authorization?.codeGroupVersion !== binding.authorization.codeGroupVersion))) {
      throw new Error('SANDBOX_CURRENT_AUTHORIZATION_DENIED');
    }
  };
  return {
    async resolveTask(request) {
      const binding = bindingFromRequest(request);
      if (binding.tenantId !== binding.groupId) throw new Error('SANDBOX_TASK_SCOPE_INVALID');
      await checkCurrent(binding);
      return binding;
    },
    async authorizeAdmission(binding, context) {
      if (context.request.taskId !== binding.taskId || context.request.tenantId !== binding.tenantId
        || context.request.actorId !== binding.actorId) throw new Error('SANDBOX_ADMISSION_SCOPE_INVALID');
      await checkCurrent(binding);
    },
    async authorizeNativeCall(binding, context) {
      if (context.taskId !== binding.taskId || context.tenantId !== binding.tenantId
        || context.actorId !== binding.actorId) throw new Error('SANDBOX_NATIVE_SCOPE_INVALID');
      await checkCurrent(binding);
    },
    async authorizeResult(binding, context) {
      if (context.request.taskId !== binding.taskId || context.request.tenantId !== binding.tenantId
        || context.request.actorId !== binding.actorId || context.result.taskId !== binding.taskId) {
        throw new Error('SANDBOX_RESULT_SCOPE_INVALID');
      }
      await checkCurrent(binding);
    },
  };
}

/** Application wait budget includes the bridge's default/selected work deadline,
 * its fixed 60-second cleanup window, and a small handoff margin. */
export function sandboxTaskTimeoutMs(module: Pick<SandboxBindingModule, 'limits'> | Pick<SandboxBindingFactory, 'limits'>): number {
  const total = module.limits?.totalTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(total) || total < 1_000 || total > 300_000) {
    throw new Error('SANDBOX_TOTAL_TIMEOUT_INVALID');
  }
  return total + 60_000 + 5_000;
}

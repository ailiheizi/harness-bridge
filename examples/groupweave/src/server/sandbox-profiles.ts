import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { loadSandboxBindingModule, type SandboxBindingFactory, type SandboxBindingSource } from './sandbox-wiring.js';

export interface ModelProfile { id: string; label: string }
interface ProfileEntry extends ModelProfile { modulePath: string }
const ID = /^[a-z][a-z0-9-]{0,39}$/;

/** Host-only deployment configuration; no paths, credentials or providers reach the UI. */
export async function loadSandboxProfiles(defaultBinding: SandboxBindingSource, manifestPath?: string) {
  const bindings = new Map<string, SandboxBindingSource>([['default', defaultBinding]]);
  const profiles: ModelProfile[] = [{ id: 'default', label: '默认模型' }];
  if (manifestPath) {
    if (!isAbsolute(manifestPath)) throw new Error('MODEL_PROFILES_PATH_INVALID');
    const canonical = await realpath(manifestPath);
    const file = await lstat(manifestPath);
    if (canonical !== resolve(manifestPath) || !file.isFile() || file.isSymbolicLink()
      || file.size > 16_384 || (file.mode & 0o022) !== 0
      || (typeof process.getuid === 'function' && file.uid !== 0 && file.uid !== process.getuid())) {
      throw new Error('MODEL_PROFILES_FILE_UNTRUSTED');
    }
    let parent = dirname(canonical);
    while (parent !== parse(parent).root) {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== 0 && stat.uid !== process.getuid())) {
        throw new Error('MODEL_PROFILES_FILE_UNTRUSTED');
      }
      parent = dirname(parent);
    }
    const entries: unknown = JSON.parse(await readFile(canonical, 'utf8'));
    if (!Array.isArray(entries) || entries.length > 15) throw new Error('MODEL_PROFILES_CONFIG_INVALID');
    for (const value of entries) {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['id', 'label', 'modulePath'].includes(key))) {
        throw new Error('MODEL_PROFILES_CONFIG_INVALID');
      }
      const entry = value as ProfileEntry;
      if (typeof entry.id !== 'string' || !ID.test(entry.id) || bindings.has(entry.id)
        || typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80
        || typeof entry.modulePath !== 'string' || !isAbsolute(entry.modulePath)) {
        throw new Error('MODEL_PROFILES_CONFIG_INVALID');
      }
      bindings.set(entry.id, await loadSandboxBindingModule(entry.modulePath));
      profiles.push({ id: entry.id, label: entry.label.trim() });
    }
  }
  return { profiles, binding: createProfileBinding(bindings) };
}

/** Select one trusted existing binding. This never retries or switches on failure. */
export function createProfileBinding(bindings: ReadonlyMap<string, SandboxBindingSource>): SandboxBindingFactory {
  if (!bindings.has('default') || !bindings.size || bindings.size > 16
    || [...bindings.keys()].some(id => !ID.test(id))) throw new Error('MODEL_PROFILES_CONFIG_INVALID');
  const selected = new Map(bindings);
  let closed = false;
  const limits = { totalTimeoutMs: Math.max(...[...selected.values()].map(source => source.limits?.totalTimeoutMs ?? 120_000)) };
  return {
    limits,
    async createTaskBinding(request, signal) {
      if (closed) throw new Error('MODEL_PROFILES_CLOSED');
      signal.throwIfAborted();
      const profile = (request.options as { modelProfileId?: unknown }).modelProfileId ?? 'default';
      if (typeof profile !== 'string' || !ID.test(profile) || !selected.has(profile)) throw new Error('MODEL_PROFILE_UNAVAILABLE');
      const source = selected.get(profile)!;
      if ('createTaskBinding' in source) {
        const lease = await source.createTaskBinding(request, signal);
        return { binding: { ...lease.binding, limits: lease.binding.limits ?? source.limits }, close: () => lease.close() };
      }
      return { binding: source, async close() {} };
    },
    async dispose() {
      if (closed) return;
      closed = true;
      await Promise.all([...new Set(selected.values())].map(async source => {
        if ('createTaskBinding' in source) await source.dispose?.();
      }));
    },
  };
}

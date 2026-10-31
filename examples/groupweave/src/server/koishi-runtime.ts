import { createRequire } from 'node:module';
import path from 'node:path';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import Module from 'node:module';
import { createPluginMaintenance, type PluginMaintenance } from './plugin-maintenance.js';
import type { Context } from 'koishi';

// Keep the loader on the same CommonJS Koishi core used by the existing native
// plugins and app integrations.
const require = createRequire(import.meta.url);
const { default: NodeLoader } = require('@koishijs/loader') as typeof import('@koishijs/loader');
const { Logger } = require('@koishijs/core') as typeof import('@koishijs/core');

class RuntimeLoader extends NodeLoader {
  private shuttingDown = false;
  restartRequired = false;

  beginShutdown() {
    this.shuttingDown = true;
  }

  override writeConfig(silent?: boolean): Promise<void> {
    // This runtime treats the YAML as read-only. Loader shutdown also emits
    // writes while unloading plugins, so both paths must remain non-mutating.
    return !this.writable || this.shuttingDown ? Promise.resolve() : super.writeConfig(silent);
  }

  // NodeLoader normally asks its parent process to restart after disposal.
  // This wrapper owns lifecycle directly, so shutdown ends at app.stop().
  override fullReload() { this.restartRequired = true; }

}

Object.defineProperty(RuntimeLoader.prototype, 'logUpdate', {
  value: (type: string, _parent: unknown, key: string) => new Logger('loader').info('%s plugin %c', type, key),
});

export interface KoishiRuntimeOptions {
  configPath: string;
  maintenanceDir?: string | (() => string | Promise<string>);
  beforeCreate?: () => void | Promise<void>;
  setup?: (app: Context, maintenance?: PluginMaintenance) => void | Promise<void>;
}

export interface KoishiRuntime {
  app: Context;
  maintenance?: PluginMaintenance;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Load and run an ordinary Koishi YAML configuration through its native loader. */
export async function createKoishiRuntime(options: KoishiRuntimeOptions): Promise<KoishiRuntime> {
  let configPath = path.resolve(options.configPath);
  const originalBaseDir = path.dirname(configPath);
  let managed: string | undefined;
  const loader = new RuntimeLoader();
  let app: Context | undefined;
  try {
    await loader.init(configPath);
    loader.writable = Boolean(managed);
    await loader.readConfig(true);
  } catch {
    throw new Error('Unable to initialize Koishi runtime from config: ' + configPath);
  }
  // Runs after native loader environment/config processing but before plugins
  // initialize, allowing callers to validate credentials and prepare paths.
  await options.beforeCreate?.();
  const directory = typeof options.maintenanceDir === 'function' ? await options.maintenanceDir() : options.maintenanceDir;
  managed = directory && path.resolve(directory);
  if (managed) {
    await mkdir(managed, { recursive: true });
    await copyFile(configPath, path.join(managed, 'koishi.yml'), constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(path.join(managed, 'package.json'), JSON.stringify({ name: 'groupweave-managed-plugins', private: true, dependencies: {} }), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(path.join(managed, '.npmrc'), 'ignore-scripts=true\nomit=peer\ncache=' + path.join(managed, '.npm-cache') + '\n');
    process.env.NODE_PATH = [path.join(managed, 'node_modules'), path.resolve('node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    (Module as unknown as { _initPaths(): void })._initPaths();
    configPath = path.join(managed, 'koishi.yml');
  }
  if (managed) {
    // Keep the original secret sources: NodeLoader re-reads envFiles and removes
    // its prior localKeys on every readConfig. Never copy .env into managed data.
    const originalEnvFiles = [...loader.envFiles];
    await loader.init(configPath);
    loader.envFiles = originalEnvFiles;
    loader.baseDir = originalBaseDir;
    loader.writable = true;
    await loader.readConfig(true);
  }

  try {
    const runtimeApp = app = await loader.createApp();
    const maintenance = managed ? await createPluginMaintenance(runtimeApp, loader) : undefined;
    await options.setup?.(runtimeApp, maintenance);
    let startTask: Promise<void> | undefined;
    let stopTask: Promise<void> | undefined;
    return {
      app: runtimeApp,
      maintenance,
      start() {
        if (stopTask) return Promise.reject(new Error('Koishi runtime has already stopped.'));
        return startTask ??= runtimeApp.start();
      },
      stop() {
        return stopTask ??= (async () => {
          if (startTask) await startTask.catch(() => undefined);
          loader.beginShutdown();
          await runtimeApp.stop();
        })();
      },
    };
  } catch (error) {
    if (app) {
      loader.beginShutdown();
      await app.stop().catch(() => undefined);
    }
    throw new Error('Unable to initialize Koishi runtime from config: ' + configPath);
  }
}
